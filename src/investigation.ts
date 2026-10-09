import * as vscode from 'vscode';
import {spawn, ChildProcess} from 'node:child_process';
import {promises as fs, createReadStream} from 'node:fs';
import * as path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {createHash, randomUUID} from 'node:crypto';
import {registerAdvisorSetup} from './advisorSetup';
import {registerCodexConnections} from './codexIntegration';
import {registerMcpStdioConnections} from './mcpStdioIntegration';
import {AdvisorChat, ChatEvidence} from './advisorChat';
import {SuiteChatEvidence} from './suiteChatEvidence';
import {currentWorkspaceFolder, resolveControllerProject} from './workspace-root';
import {cancellableJulia, controllerCancellation} from './controllerCancellation';
import {InvestigationReport, Proposal, Scenario, draftCase, parseInvestigation,
  reportSummary, scenarioKey, scenarioToml, selectedScenarios, workspacePath, scenarioOutcome, selectedTestItems} from './investigationModel';

type Action = 'discover' | 'run' | 'diagnose' | 'advise' | 'compare' | 'tools' | 'sync' | 'narrate' | 'investigate';
const actions: Action[] = ['discover', 'run', 'diagnose', 'advise', 'compare', 'tools', 'sync', 'narrate', 'investigate'];
interface History {id: string; action: Action; directory: string; report?: string; status: string; created: string; summary: string}
interface Node {kind: 'group' | 'scenario' | 'proposal' | 'advice'; label: string; value?: any}
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));

export class InvestigationController implements vscode.TreeDataProvider<Node>, vscode.CodeLensProvider, vscode.CodeActionProvider, vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private child?: ChildProcess;
  private stopController?: ReturnType<typeof controllerCancellation>;
  private cancelled = false;
  private busy = false;
  private discovery?: InvestigationReport;
  private report?: InvestigationReport;
  private displayedHistoryId?: string;
  private advice?: InvestigationReport;
  private history: History[];
  private change = new vscode.EventEmitter<Node | undefined>();
  private lenses = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;
  readonly onDidChangeCodeLenses = this.lenses.event;
  private diagnostics = vscode.languages.createDiagnosticCollection('perfchecker');
  private tests = vscode.tests.createTestController('perfchecker.scenarios', 'PerfChecker scenarios');
  private output = vscode.window.createOutputChannel('PerfChecker investigations');
  private lastMessage = 'Discover existing tests or open saved evidence.';
  private activeWorkspace?: string;

  constructor(private context: vscode.ExtensionContext) {
    this.history = [];
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (!event.contentChanges.length || event.document.uri.scheme !== 'file') return;
      let folder: vscode.WorkspaceFolder;
      try {folder = this.folder();} catch {return;}
      const discovery = this.discovery;
      if (!discovery || vscode.workspace.getWorkspaceFolder(event.document.uri)?.uri.toString() !== folder.uri.toString()) return;
      const relative = path.relative(folder.uri.fsPath, event.document.uri.fsPath).replaceAll('\\', '/');
      if (!Object.hasOwn(discovery.fingerprints ?? {}, relative)) return;
      this.diagnostics.delete(event.document.uri);
      this.lastMessage = 'A scenario input changed. Rediscover and remeasure before applying earlier conclusions.'; this.refresh();
    }));
    this.tests.createRunProfile('Measure and verify', vscode.TestRunProfileKind.Run, async (request, token) => {
      const test = this.tests.createTestRun(request);
      const selected = selectedTestItems([...this.testItems()], request.include, request.exclude);
      const keys = selected.map(item => item.id);
      if (!selected.length || token.isCancellationRequested) {test.end(); return;}
      const cancellation = token.onCancellationRequested(() => this.cancel());
      selected.forEach(item => test.enqueued(item));
      try {
        selected.forEach(item => test.started(item));
        const report = await this.execute('run', keys);
        for (const item of selected) {
          const scenario = this.declared().find(s => scenarioKey(s) === item.id);
          const outcome = scenario ? scenarioOutcome(scenario, report) : 'errored';
          if (this.cancelled) test.skipped(item);
          else if (outcome === 'passed') test.passed(item);
          else if (outcome === 'failed') test.failed(item, new vscode.TestMessage('The correctness oracle failed. Open the investigation evidence.'));
          else test.errored(item, new vscode.TestMessage('Missing, duplicated or unavailable collector evidence. Open the investigation evidence.'));
        }
        test.appendOutput('Performance budgets were not automatically adopted.\r\n');
      } catch (error) {
        selected.forEach(item => test.errored(item, new vscode.TestMessage(String(error))));
      } finally { cancellation.dispose(); test.end(); }
    }, false);
  }

  private *testItems(): IterableIterator<vscode.TestItem> {
    const items: vscode.TestItem[] = []; this.tests.items.forEach(item => items.push(item)); yield* items;
  }
  private folder(): vscode.WorkspaceFolder {
    const folder = currentWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders);
    const key = folder.uri.toString();
    if (this.activeWorkspace !== key) {
      if (this.activeWorkspace) {
        if (this.busy) throw new Error('Wait for the active PerfChecker investigation before changing folders.');
        this.discovery = undefined;
        this.report = undefined;
        this.advice = undefined;
        this.displayedHistoryId = undefined;
        this.tests.items.replace([]);
        this.diagnostics.clear();
        this.panel?.dispose();
        this.panel = undefined;
      }
      const previous = vscode.workspace.workspaceFolders?.length === 1 ?
        this.context.workspaceState.get<History[]>('investigationHistory', []) : [];
      this.history = this.context.workspaceState.get<History[]>(`investigationHistory:${key}`, previous);
    }
    this.activeWorkspace = key;
    return folder;
  }
  private root(): string {
    return this.folder().uri.fsPath;
  }
  private setting<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('perfchecker', this.folder().uri).get<T>(key, fallback);
  }
  private absolute(key: string, fallback: string): string {return path.resolve(this.root(), this.setting(key, fallback));}
  private project(key: 'runnerProject' | 'scenarioProject' = 'runnerProject'): string {
    return resolveControllerProject(this.root(),
      vscode.workspace.getConfiguration('perfchecker', this.folder().uri), key).project;
  }
  private declared(): Scenario[] {return this.discovery?.declared ?? [];}
  private analyzers() {
    return this.discovery?.analyzers ?? this.report?.analyzers ??
      ['jet', 'aqua', 'alloccheck', 'snoopcompile', 'latency'].map(tool => ({tool, scope: tool}));
  }
  private refresh(): void {
    this.change.fire(undefined); this.lenses.fire();
    const items = this.declared().map(scenario => {
      const item = this.tests.createTestItem(scenarioKey(scenario), `${scenario.id} · ${scenario.implementation}`, vscode.Uri.file(scenario.source));
      item.description = scenario.collectors.join(', '); return item;
    });
    this.tests.items.replace(items);
    void this.panel?.webview.postMessage({type: 'state', discovery: this.discovery, report: this.report, advice: this.advice,
      history: this.history, busy: this.busy, message: this.lastMessage,
      tools: this.setting('analysisTools', ['jet', 'alloccheck', 'latency']), analyzers: this.analyzers(),
      catalog: this.absolute('scenarioCatalog', 'perf/scenarios.toml')});
  }

  async open(): Promise<void> {
    const workspace = this.folder().uri.toString();
    if (this.panel) {this.panel.reveal(); this.refresh(); return;}
    this.panel = vscode.window.createWebviewPanel('perfchecker.investigation', 'PerfChecker · Investigate', vscode.ViewColumn.One,
      {enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]});
    this.panel.iconPath = {light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'perfchecker-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'perfchecker-dark.svg')};
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'investigation.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'investigation.css'));
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'perfchecker.png'));
    const nonce = randomUUID();
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"><title>PerfChecker investigations</title></head><body><header class="brand-heading"><img src="${logo}" alt="PerfChecker"><div><p class="eyebrow">PerfChecker</p><h1>Understand. Improve. Verify.</h1><p>Shared scenarios connect tests, measurements and evidence-based advice.</p></div></header><div id="app" aria-live="polite"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.panel.onDidDispose(() => {this.cancel(); this.panel = undefined;});
    webview.onDidReceiveMessage(async message => {
      try {
        if (this.folder().uri.toString() !== workspace) throw new Error('PerfChecker folder changed. Reopen investigations.');
        if (message.type === 'ready') this.refresh();
        else if (message.type === 'execute' && actions.includes(message.action)) {
          await this.execute(message.action, Array.isArray(message.keys) ? message.keys.map(String) : undefined,
            Array.isArray(message.tools) ? message.tools.map(String) : undefined);
        } else if (message.type === 'artifact') await this.openArtifact(String(message.file));
        else if (message.type === 'cancel') this.cancel();
        else if (message.type === 'source') await this.openSource(String(message.file), Number(message.line));
        else if (message.type === 'draft') await this.prepare(String(message.id));
        else if (message.type === 'adopt') await this.adopt(message.scenario);
        else if (message.type === 'history') await this.loadHistory(String(message.id));
        else if (message.type === 'export') await this.openReport(String(message.id), message.format === 'md' ? 'md' : 'json');
        else if (message.type === 'log') this.output.show();
        else if (message.type === 'advisorSettings') await vscode.commands.executeCommand('perfchecker.configureAdvisor');
      } catch (error) {this.error(error);}
    }, undefined, this.context.subscriptions);
    if (!this.discovery) {
      const previous = this.history.find(item => item.action === 'discover' && item.report);
      if (previous) {try {this.discovery = await this.readReport(previous.report!);} catch {/* report was moved */}}
    }
    this.refresh();
  }

  async execute(action: Action, keys?: string[], tools?: string[], owner?: string): Promise<InvestigationReport | undefined> {
    const workspace = this.folder().uri.toString();
    if (owner && owner !== workspace) throw new Error('This editor action belongs to another workspace. Rediscover the selected folder.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before running PerfChecker.');
    if (this.busy) throw new Error('An investigation is already running; cancel it or wait for completion.');
    if (!actions.includes(action)) throw new Error('Unknown action.');
    const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
    const directory = workspacePath(this.root(), path.join(this.absolute('investigationReports', 'perf/results/investigations'), id));
    const args: string[] = [];
    let command: string = action;
    const filenames: Record<Action, string> = {run: 'run', compare: 'comparison', discover: 'discovery', diagnose: 'diagnosis', advise: 'advice', tools: 'tools', sync: 'sync', narrate: 'narrative', investigate: 'investigation'};
    const filename = `${filenames[action]}.json`;
    if (action === 'discover' || action === 'sync') {
      args.push(`--root=${this.root()}`);
      const previous = this.history.find(item => item.action === 'discover' && item.report);
      if (previous && await fs.stat(previous.report!).catch(() => undefined)) args.push(`--previous=${previous.report}`);
    } else if (action === 'tools') {
      // Read the installed controller inventory without executing project code.
    } else if (action === 'run' || action === 'diagnose' || action === 'investigate') {
      if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' &&
        document.uri.fsPath.endsWith('.jl') && !path.relative(this.root(), document.uri.fsPath).startsWith('..'))) {
        throw new Error('Save the Julia files before measuring so the editor and isolated workers use the same code.');
      }
      const chosen = selectedScenarios(this.declared(), keys ?? this.declared().map(scenarioKey));
      if (!chosen.length) throw new Error('Select an explicitly declared scenario first.');
      const catalogs = new Set(chosen.map(s => s.catalog ?? this.setting('scenarioCatalog', 'perf/scenarios.toml')));
      if (catalogs.size !== 1) throw new Error('Select scenarios from one catalogue per run.');
      const catalog = workspacePath(this.root(), [...catalogs][0]);
      await fs.mkdir(directory, {recursive: true});
      const selection = path.join(directory, 'selection.json');
      await fs.writeFile(selection, JSON.stringify(chosen.map(({id, implementation}) => ({id, implementation}))), {flag: 'wx'});
      args.push(`--catalog=${catalog}`, `--selection=${selection}`,
        `--project=${this.project('scenarioProject')}`,
        `--timeout=${this.setting('analysisTimeout', 120)}`, `--threads=${this.setting('scenarioThreads', 1)}`);
      if (action === 'run') args.push(`--samples=${this.setting('scenarioSamples', 10)}`);
      else {
        const selected = tools ?? this.setting<string[]>('analysisTools', ['jet', 'alloccheck', 'latency']);
        const available = new Set(this.analyzers().map(item => item.tool));
        if (!selected.length || selected.some(tool => !available.has(tool))) throw new Error('Select analyzers reported by the controller; discover again to refresh capabilities.');
        args.push(`--tools=${selected.join(',')}`);
      }
      if (action === 'investigate') {
        args.push(`--samples=${this.setting('scenarioSamples', 10)}`, `--max-experiments=${this.setting('investigationMaxExperiments', 4)}`,
          `--budget-seconds=${this.setting('investigationBudgetSeconds', 300)}`);
        if (this.setting('advisorInvestigates', false)) args.push(`--advisor-config=${await this.advisorConfig(directory)}`);
      }
    } else if (action === 'narrate') {
      const evidence = await this.pickHistory(['advise', 'diagnose', 'run', 'investigate'], 'Explain saved evidence with the configured model', this.displayedHistoryId);
      if (!evidence) return;
      let source = evidence.action === 'advise' ? evidence.report! : path.join(evidence.directory, 'advice', 'advice.json');
      if (evidence.action === 'investigate') {
        const report = await this.readReport(evidence.report!);
        if (!report.advice) throw new Error('This investigation has no deterministic advice.');
        await fs.mkdir(directory, {recursive: true}); source = path.join(directory, 'evidence.json');
        await fs.writeFile(source, JSON.stringify(report.advice), {flag: 'wx'});
      }
      args.push(`--source=${source}`, `--project=${this.project('scenarioProject')}`,
        `--advisor-config=${await this.advisorConfig(directory)}`);
    } else if (action === 'advise') {
      const evidence = await this.pickHistory(['diagnose', 'run'], 'Choose saved evidence — the program will not run again');
      if (!evidence) return;
      args.push(`--source=${evidence.action === 'run' ? evidence.directory : evidence.report}`);
    } else {
      const baseline = await this.pickHistory(['run'], 'Choose the baseline measurement');
      if (!baseline) return;
      const candidate = await this.pickHistory(['run'], 'Choose the candidate measurement');
      if (!candidate) return;
      args.push('--scenarios', `--baseline=${baseline.directory}`, `--candidate=${candidate.directory}`);
    }
    args.push(`--reports=${directory}`);
    await fs.mkdir(directory, {recursive: true});
    this.busy = true; this.cancelled = false; this.lastMessage = `${action} in progress…`; this.refresh();
    const history: History = {id, action, directory, created: new Date().toISOString(), status: 'running', summary: ''};
    try {
      const {code, stdout} = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
        title: `PerfChecker · ${action}`, cancellable: true}, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => this.cancel());
        try {return await this.invoke(command, args, directory);} finally {subscription.dispose();}
      });
      if (this.cancelled) {
        if (code !== 0 && code !== 130) throw new Error('Cancellation did not finish cleanly. Inspect the PerfChecker output for cleanup failures and retained inventories.');
        history.status = 'cancelled'; history.summary = 'Stopped after controller cleanup — remaining configurations are not qualified.'; return;
      }
      const reportPath = path.join(directory, filename);
      if (action === 'run') await fs.writeFile(reportPath, stdout, 'utf8');
      const report = await this.readReport(reportPath);
      history.report = reportPath; history.status = code === 0 ? 'complete' : 'incomplete'; history.summary = reportSummary(report);
      this.report = report;
      this.displayedHistoryId = history.id;
      this.advice = undefined;
      this.diagnostics.clear();
      if (action === 'discover') this.discovery = report;
      if (action === 'sync') this.discovery = report.discovery;
      if (action === 'advise') this.advice = report;
      if (action === 'narrate') this.advice = report.fallback;
      if (action === 'investigate') {this.advice = report.advice; this.publishDiagnostics(report);}
      if (action === 'diagnose' || action === 'run') {
        if (action === 'diagnose') this.publishDiagnostics(report);
        const adviceDir = path.join(directory, 'advice');
        const advised = await this.invoke('advise', [`--source=${action === 'run' ? directory : reportPath}`, `--reports=${adviceDir}`], directory);
        if (!this.cancelled && advised.code === 0) this.advice = await this.readReport(path.join(adviceDir, 'advice.json'));
      }
      this.lastMessage = `${history.summary}${code ? ' · Some requests did not complete; inspect their availability.' : ''}`;
      return report;
    } catch (error) {
      history.status = 'error'; history.summary = String(error); this.lastMessage = String(error); throw error;
    } finally {
      this.busy = false; this.child = undefined;
      if (this.cancelled && history.status === 'cancelled') this.lastMessage = 'Cancelled after controller cleanup. Completed artifacts are retained; remaining configurations are not qualified.';
      this.history = [history, ...this.history].slice(0, 50);
      await this.context.workspaceState.update(`investigationHistory:${workspace}`, this.history); this.refresh();
    }
  }

  private async advisorConfig(directory: string): Promise<string> {
    if (!this.setting('advisorEnabled', true)) throw new Error('Optional advisor is disabled. Open Advisor and models to configure it.');
    const configured = this.setting('advisorConfig', '');
    if (configured) return this.absolute('advisorConfig', '');
    await fs.mkdir(directory, {recursive: true});
    const file = path.join(directory, 'advisor-config.json');
    await fs.writeFile(file, JSON.stringify({endpoint: this.setting('advisorEndpoint', 'http://127.0.0.1:8081/v1/chat/completions'),
      model: this.setting('advisorModel', 'local'), protocol: this.setting('advisorProtocol', 'chat_completions'),
      allow_remote: this.setting('advisorAllowRemote', false), api_key_env: this.setting('advisorKeyEnvironment', ''),
      timeout: this.setting('advisorTimeout', 90), instructions: this.setting('advisorInstructions', ''),
      mcp_tool: this.setting('advisorMcpTool', ''),
      mcp_prompt_argument: this.setting('advisorMcpPromptArgument', 'prompt'),
      mcp_arguments: this.setting('advisorMcpArguments', {}),
      mcp_version: this.setting('advisorMcpVersion', '2026-07-28'),
      mcp_response: this.setting('advisorMcpResponse', 'text')}), {flag: 'wx'});
    return file;
  }

  private async invoke(command: string, args: string[], directory: string): Promise<{code: number; stdout: string}> {
    if (this.cancelled) return {code: 130, stdout: ''};
    const executable = this.setting('juliaExecutable', 'julia');
    const controller = resolveControllerProject(this.root(),
      vscode.workspace.getConfiguration('perfchecker', this.folder().uri));
    this.output.appendLine(`Controller project: ${controller.project} (${controller.reason})`);
    const juliaArgs = ['--startup-file=no', `--project=${controller.project}`,
      '-e', cancellableJulia('using PerfChecker; exit(perfchecker_main(ARGS))'), '--', command, ...args];
    this.output.appendLine(`PerfChecker ${command}`);
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, juliaArgs, {cwd: this.root(), windowsHide: true, detached: process.platform !== 'win32',
        env:{...process.env,JULIA_LOAD_PATH:['@','@stdlib'].join(path.delimiter)}});
      this.child = child;
      const stop = controllerCancellation(child, (message, forced) => {
        this.output.appendLine(message); this.lastMessage = message; this.refresh();
        if (forced) void vscode.window.showWarningMessage(message);
      });
      this.stopController = stop;
      const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
      let stdout = ''; let log = ''; let size = 0; let exceeded = false; let finalErrors = '';
      const append = (text: string, output: boolean) => {
        if (exceeded) return;
        this.output.append(text); log = (log + text).slice(-2_000_000);
        if (output && !exceeded) stdout += text;
      };
      const consume = (chunk: Buffer, output: boolean) => {
        if (exceeded) {
          if (!output) finalErrors = (finalErrors + stderrDecoder.write(chunk)).slice(-65_536);
          return;
        }
        if (output) {
          size += chunk.length;
          if (size > 32_000_000) {
            exceeded = true;
            this.output.appendLine('Controller output truncated at 32 MB; cancelling and waiting for cleanup.');
            this.cancel(); return;
          }
        }
        append((output ? stdoutDecoder : stderrDecoder).write(chunk), output);
      };
      child.stdout?.on('data', chunk => consume(chunk, true)); child.stderr?.on('data', chunk => consume(chunk, false));
      child.on('error', reject);
      child.on('close', code => {
        stop.dispose(); if (this.stopController === stop) this.stopController = undefined;
        if (exceeded) {
          stdoutDecoder.end(); finalErrors = (finalErrors + stderrDecoder.end()).slice(-65_536);
          if (finalErrors) {this.output.append(finalErrors); log = (log + finalErrors).slice(-2_000_000);}
        } else {append(stdoutDecoder.end(), true); append(stderrDecoder.end(), false);}
        void fs.appendFile(path.join(directory, 'worker.log'), log).then(() => {
          if (exceeded) reject(new Error('Controller output exceeded 32 MB; inspect the worker log.'));
          else resolve({code: code ?? 2, stdout});
        }, reject);
      });
    });
  }

  cancel(): void {
    if (!this.busy) return;
    this.cancelled = true;
    this.stopController?.request();
  }

  private async readReport(file: string): Promise<InvestigationReport> {
    const stat = await fs.stat(file);
    if (stat.size > 32_000_000) throw new Error('Report is larger than 32 MB; open the raw artifact.');
    return parseInvestigation(JSON.parse(await fs.readFile(file, 'utf8')));
  }
  chatEvidence(): ChatEvidence[] {
    this.folder();
    return this.history.filter(item => ['advise', 'diagnose', 'run', 'investigate'].includes(item.action) && item.report && item.status === 'complete')
      .map(item => ({id: item.id, label: `${item.action} · ${item.created} · ${item.summary}`}));
  }
  async readChatEvidence(id: string): Promise<InvestigationReport> {
    this.folder();
    if (!this.chatEvidence().some(item => item.id === id)) throw new Error('Saved evidence is no longer available.');
    const item = this.history.find(item => item.id === id)!;
    const file = item.action === 'advise' || item.action === 'investigate' ? item.report! : path.join(item.directory, 'advice', 'advice.json');
    workspacePath(await fs.realpath(this.root()), await fs.realpath(file));
    const report = await this.readReport(file);
    const advice = item.action === 'investigate' ? report.advice : report;
    if (advice?.schema_version !== 'perfchecker-advice/1') throw new Error('This report has no saved advice.');
    return advice;
  }
  private async pickHistory(actions: Action[], title: string, preferred?: string): Promise<History | undefined> {
    const displayed = this.history.find(item => item.id === preferred && actions.includes(item.action) && item.report);
    if (displayed) return displayed;
    const choices = this.history.filter(item => actions.includes(item.action) && item.report).map(item => ({
      label: `${item.action} · ${item.created}`, description: item.status, detail: item.summary, item}));
    if (!choices.length) throw new Error('No saved evidence is available yet.');
    return (await vscode.window.showQuickPick(choices, {title}))?.item;
  }
  async loadHistory(id: string): Promise<void> {
    const item = this.history.find(item => item.id === id);
    if (!item?.report) throw new Error('This attempt has no complete report; open its log.');
    this.report = await this.readReport(item.report);
    this.displayedHistoryId = item.id;
    this.advice = undefined;
    this.diagnostics.clear();
    if (item.action === 'discover') this.discovery = this.report;
    if (item.action === 'sync') this.discovery = this.report.discovery;
    if (item.action === 'advise') this.advice = this.report;
    if (item.action === 'narrate') this.advice = this.report.fallback;
    if (item.action === 'investigate') {this.advice = this.report.advice; this.publishDiagnostics(this.report);}
    if (item.action === 'diagnose' || item.action === 'run') {
      if (item.action === 'diagnose') this.publishDiagnostics(this.report);
      try {this.advice = await this.readReport(path.join(item.directory, 'advice', 'advice.json'));} catch {this.advice = undefined;}
    }
    this.lastMessage = `Saved evidence · ${item.created}`; await this.open(); this.refresh();
  }
  private async openReport(id: string, format: string): Promise<void> {
    const item = this.history.find(item => item.id === id);
    if (!item?.report) throw new Error('No report available for this attempt.');
    const filename = format === 'md' ? item.report.replace(/\.json$/, '.md') : item.report;
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(filename)), {preview: true});
  }
  async openArtifact(file: string): Promise<void> {
    const artifact = this.report?.records?.flatMap(record => record.artifacts ?? []).find(item => item.path === file);
    if (!artifact) throw new Error('Artifact is absent from the current evidence.');
    workspacePath(await fs.realpath(this.root()), await fs.realpath(file));
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    if (digest.digest('hex') !== artifact.sha256) throw new Error('Artifact changed since its diagnosis.');
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
  }
  async openSource(file: string, line = 1): Promise<void> {
    const resolved = path.resolve(this.root(), file);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
    const row = Math.max(0, Math.min(document.lineCount - 1, Number.isFinite(line) ? Math.trunc(line) - 1 : 0));
    await vscode.window.showTextDocument(document, {preview: true, selection: new vscode.Range(row, 0, row, 0)});
  }
  async prepare(id: string, owner?: string): Promise<void> {
    const workspace = this.folder().uri.toString();
    if (owner && owner !== workspace) throw new Error('This editor action belongs to another workspace. Rediscover the selected folder.');
    const proposal = this.discovery?.candidates?.find(item => item.id === id);
    if (!proposal) throw new Error('Proposal is stale; discover again.');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language: 'julia', content: draftCase(proposal)}));
  }
  async adopt(input: Partial<Scenario>): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before editing the PerfChecker catalogue.');
    if (this.busy) throw new Error('Wait for the current investigation before editing the catalogue.');
    const folder=this.folder(), root=folder.uri.fsPath;
    if (!this.discovery) throw new Error('Discover the package first.');
    const discovery=this.discovery;
    const catalogSetting=this.setting('scenarioCatalog','perf/scenarios.toml');
    const current=()=>{
      if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before editing the PerfChecker catalogue.');
      const selected=currentWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders);
      if(selected.uri.toString()!==folder.uri.toString() || this.discovery!==discovery ||
          vscode.workspace.getConfiguration('perfchecker',folder.uri).get('scenarioCatalog','perf/scenarios.toml')!==catalogSetting)
        throw new Error('The workspace or catalogue changed. Discover again before adding a declaration.');
    };
    const source = workspacePath(root, String(input.source ?? ''));
    if (!(await fs.stat(source)).isFile()) throw new Error('Choose an existing Julia source file.');
    workspacePath(await fs.realpath(root), await fs.realpath(source));
    const scenario: Scenario = {id: String(input.id ?? '').trim(), implementation: String(input.implementation ?? 'default').trim(),
      factory: String(input.factory ?? '').trim(), source, collectors: input.collectors ?? ['benchmark'],
      parameters: input.parameters ?? {}, fixtures: input.fixtures ?? [], requirements: input.requirements ?? []};
    if (!Array.isArray(scenario.requirements) || scenario.requirements.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name))) throw new Error('Requirements must be Julia package names.');
    if (!scenario.parameters || Array.isArray(scenario.parameters) || typeof scenario.parameters !== 'object') throw new Error('Parameters must be a JSON object.');
    if (!Array.isArray(scenario.fixtures) || scenario.fixtures.length > 128) throw new Error('Provide an array of at most 128 fixture paths.');
    scenario.fixtures = await Promise.all(scenario.fixtures.map(async file => {
      const resolved = workspacePath(root, file);
      workspacePath(await fs.realpath(root), await fs.realpath(resolved));
      if (!(await fs.stat(resolved)).isFile()) throw new Error('Fixture paths must refer to files.'); return resolved;
    }));
    if (this.declared().some(item => scenarioKey(item) === scenarioKey(scenario))) throw new Error('This scenario/implementation is already declared.');
    const catalog = workspacePath(root, path.resolve(root,catalogSetting));
    current();
    await fs.mkdir(path.dirname(catalog), {recursive: true});
    workspacePath(await fs.realpath(root), await fs.realpath(path.dirname(catalog)));
    const previous = await fs.readFile(catalog, 'utf8').catch((error: NodeJS.ErrnoException) => {if (error.code === 'ENOENT') return undefined; throw error;});
    const relative = path.relative(root, catalog).replaceAll('\\', '/');
    if (previous !== undefined && createHash('sha256').update(previous).digest('hex') !== discovery.fingerprints?.[relative]) {
      throw new Error('The catalogue changed since discovery. Refresh before adoption.');
    }
    const entry = scenarioToml(scenario, path.dirname(catalog));
    current();
    if (previous === undefined) {
      const relativeRoot = JSON.stringify(path.relative(path.dirname(catalog), root).replaceAll('\\', '/') || '.');
      await fs.writeFile(catalog, `schema_version = "perfchecker-scenario-catalog/1"\nroot = ${relativeRoot}\n${entry}`, {flag: 'wx'});
    } else await fs.appendFile(catalog, entry, 'utf8');
    current();
    await this.openSource(catalog); await this.execute('discover');
  }

  private publishDiagnostics(report: InvestigationReport): void {
    const owner = this.activeWorkspace, folder = this.folder();
    if (folder.uri.toString() !== owner) return;
    const root = folder.uri.fsPath;
    this.diagnostics.clear(); const grouped = new Map<string, vscode.Diagnostic[]>();
    for (const record of report.records ?? []) for (const finding of record.findings ?? []) {
      const location = finding.location;
      if (!location?.file || !Number.isInteger(location.line) || location.line < 1) continue;
      const file = path.resolve(root, String(location.file));
      const diagnostic = new vscode.Diagnostic(new vscode.Range(location.line - 1, 0, location.line - 1, 1),
        `${record.tool} · ${record.scenario}/${record.implementation}: ${finding.message}\nStatic evidence is not a measured performance regression.`,
        vscode.DiagnosticSeverity.Warning);
      diagnostic.source = 'PerfChecker'; diagnostic.code = String(finding.rule_id);
      grouped.set(file, [...(grouped.get(file) ?? []), diagnostic]);
    }
    for (const [file, diagnostics] of grouped) this.diagnostics.set(vscode.Uri.file(file), diagnostics);
  }
  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.kind === 'group' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.contextValue = `perfchecker.${node.kind}`;
    item.iconPath = new vscode.ThemeIcon(node.kind === 'scenario' ? 'beaker' : node.kind === 'proposal' ? 'lightbulb' : node.kind === 'advice' ? 'comment-discussion' : 'folder');
    if (node.kind === 'scenario') {item.description = node.value.implementation; item.command = {command: 'perfchecker.openInvestigationSource', title: 'Open scenario', arguments: [node.value.source, 1]};}
    else if (node.kind === 'proposal') item.command = {command: 'perfchecker.openInvestigationSource', title: 'Open test', arguments: [node.value.origin.file, node.value.origin.line]};
    else if (node.kind === 'advice') item.command = {command: 'perfchecker.openInvestigations', title: 'Read advice'};
    return item;
  }
  getChildren(node?: Node): Node[] {
    if (!node) return [{kind: 'group', label: 'Declared scenarios'}, {kind: 'group', label: 'Test proposals'}, {kind: 'group', label: 'Advice'}];
    if (node.label === 'Declared scenarios') return this.declared().map(value => ({kind: 'scenario', label: value.id, value}));
    if (node.label === 'Test proposals') return (this.discovery?.candidates ?? []).map(value => ({kind: 'proposal', label: value.id, value}));
    if (node.label === 'Advice') return (this.advice?.recommendations ?? []).map(value => ({kind: 'advice', label: `${value.scenario}: ${value.action}`, value}));
    return [];
  }
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    let folder: vscode.WorkspaceFolder;
    try {folder = this.folder();} catch {return [];}
    if (vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() !== folder.uri.toString()) return [];
    const discovery = this.discovery;
    const matches = (file: string) => path.resolve(folder.uri.fsPath, file) === document.uri.fsPath;
    const lenses = (discovery?.declared ?? []).filter(s => matches(s.source)).map(s => new vscode.CodeLens(new vscode.Range(0, 0, 0, 0),
      {title: `Diagnose ${s.id} · ${s.implementation}`, command: 'perfchecker.diagnoseScenarios', arguments: [[scenarioKey(s)], folder.uri.toString()]}));
    for (const p of discovery?.candidates ?? []) if (matches(p.origin.file) && p.origin.line <= document.lineCount) {
      const row = Math.max(0, p.origin.line - 1);
      lenses.push(new vscode.CodeLens(new vscode.Range(row, 0, row, 0), {title: 'Prepare shared performance case', command: 'perfchecker.prepareScenario', arguments: [p.id, folder.uri.toString()]}));
    }
    return lenses;
  }
  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    let folder: vscode.WorkspaceFolder;
    try {folder = this.folder();} catch {return [];}
    if (vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() !== folder.uri.toString()) return [];
    if (!context.diagnostics.some(item => item.source === 'PerfChecker')) return [];
    const action = new vscode.CodeAction('Read evidence and verification steps', vscode.CodeActionKind.QuickFix);
    action.command = {command: 'perfchecker.openInvestigations', title: 'Open PerfChecker advice'};
    return [action];
  }
  error(error: unknown): void {this.lastMessage = String(error); this.output.appendLine(String(error)); try {this.refresh();} catch {/* no selected multi-root folder */} void vscode.window.showErrorMessage(`PerfChecker: ${error}`);}
  dispose(): void {this.cancel(); this.panel?.dispose(); this.diagnostics.dispose(); this.tests.dispose(); this.output.dispose(); this.change.dispose(); this.lenses.dispose();}
}

export function registerInvestigations(context: vscode.ExtensionContext): void {
  registerAdvisorSetup(context);
  const controller = new InvestigationController(context);
  const suiteEvidence = new SuiteChatEvidence();
  const selected = () => currentWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders);
  const chat = new AdvisorChat(context, () => [...controller.chatEvidence(), ...suiteEvidence.options(selected().uri.toString())],
    id => id.startsWith('suite:') ? suiteEvidence.read(id, selected().uri.toString()) : controller.readChatEvidence(id),
    folder => suiteEvidence.refresh(folder.uri.toString(), folder.uri.fsPath,
      vscode.workspace.getConfiguration('perfchecker', folder.uri).get('reports', 'perf/results/vscode')));
  registerCodexConnections(context, () => chat.isBusy(), () => chat.connectionChanged());
  registerMcpStdioConnections(context, () => chat.isBusy(), () => chat.connectionChanged());
  const command = (name: string, callback: (...args: any[]) => unknown) => vscode.commands.registerCommand(name, async (...args) => {
    try {return await callback(...args);} catch (error) {controller.error(error); throw error;}
  });
  context.subscriptions.push(controller, chat,
    command('perfchecker.openChat', () => chat.open()),
    command('perfchecker.chatSend', input => chat.send(input?.question, input?.evidenceId)),
    command('perfchecker.chatState', () => chat.state()),
    command('perfchecker.chatClear', evidenceId => chat.clear(evidenceId)),
    command('perfchecker.chatCancel', () => chat.cancel()),
    command('perfchecker.prepareImplementation', () => chat.implement()),
    command('perfchecker.applyImplementation', () => chat.apply()),
    command('perfchecker.restoreImplementation', () => chat.apply(true)),
    vscode.window.createTreeView('perfchecker.scenarios', {treeDataProvider: controller, showCollapseAll: true}),
    vscode.languages.registerCodeLensProvider({language: 'julia', scheme: 'file'}, controller),
    vscode.languages.registerCodeActionsProvider({language: 'julia', scheme: 'file'}, controller, {providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]}),
    command('perfchecker.openInvestigations', () => controller.open()),
    command('perfchecker.discoverScenarios', async () => {await controller.open(); return controller.execute('discover');}),
    command('perfchecker.measureScenarios', keys => controller.execute('run', keys)),
    command('perfchecker.diagnoseScenarios', (keys, owner) => controller.execute('diagnose', keys, undefined, owner)),
    command('perfchecker.adviseScenarios', () => controller.execute('advise')),
    command('perfchecker.compareScenarios', () => controller.execute('compare')),
    command('perfchecker.catalogTools', async () => {await controller.open(); return controller.execute('tools');}),
    command('perfchecker.syncScenarios', () => controller.execute('sync')),
    command('perfchecker.narrateAdvice', () => controller.execute('narrate')),
    command('perfchecker.investigateScenarios', keys => controller.execute('investigate', keys)),
    command('perfchecker.cancelInvestigation', () => controller.cancel()),
    command('perfchecker.openEvidenceArtifact', file => controller.openArtifact(file)),
    command('perfchecker.prepareScenario', (id, owner) => controller.prepare(id, owner)),
    command('perfchecker.openInvestigationSource', (file, line) => controller.openSource(file, line)));
}
