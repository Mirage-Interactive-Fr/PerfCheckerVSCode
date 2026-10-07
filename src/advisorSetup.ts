import * as vscode from 'vscode';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {spawn, ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {currentWorkspaceFolder, resolveControllerProject} from './workspace-root';
import {assertSavedAdvisorConfiguration, localAdvisorConnection, onLocalAdvisorConnectionChanged} from './advisorConnection';
import {cancellableJulia,controllerCancellation} from './controllerCancellation';

const mapping: Record<string, [string, unknown]> = {
  endpoint: ['advisorEndpoint', 'http://127.0.0.1:8081/v1/chat/completions'], model: ['advisorModel', 'local'],
  protocol: ['advisorProtocol', 'chat_completions'], allow_remote: ['advisorAllowRemote', false],
  api_key_env: ['advisorKeyEnvironment', ''], instructions: ['advisorInstructions', ''], timeout: ['advisorTimeout', 120],
  mcp_tool: ['advisorMcpTool', ''], mcp_prompt_argument: ['advisorMcpPromptArgument', 'prompt'],
  mcp_arguments: ['advisorMcpArguments', {}], mcp_version: ['advisorMcpVersion', '2026-07-28'], mcp_response: ['advisorMcpResponse', 'text']
};

export async function readAdvisorConfiguration(folder: vscode.WorkspaceFolder): Promise<Record<string, unknown>> {
  const local = localAdvisorConnection(folder.uri.toString());
  if (local) return {...local.config};
  const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
  const file = settings.get<string>('advisorConfig', '');
  if (!file) return Object.fromEntries(Object.entries(mapping).map(([key, [setting, fallback]]) => [key, settings.get(setting, fallback)]));
  const location = path.resolve(folder.uri.fsPath, file);
  if ((await fs.stat(location)).size > 32000) throw new Error('Advisor configuration exceeds 32 KB.');
  const config = JSON.parse(await fs.readFile(location, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid advisor configuration.');
  return config;
}

export class AdvisorSetup implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private child?: ChildProcess;
  private stopController?: ReturnType<typeof controllerCancellation>;
  private cancelled = false;
  private busy = false;
  private panelWorkspace?: string;
  private connectionGenerations = new Map<string, number>();
  private unsubscribeConnection: () => void;
  constructor(private context: vscode.ExtensionContext) {
    this.unsubscribeConnection = onLocalAdvisorConnectionChanged(workspace => {
      this.connectionGenerations.set(workspace, this.connectionGeneration(workspace) + 1);
      if (this.panelWorkspace === workspace) this.panel?.dispose();
    });
  }
  private folder() {return currentWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders);}
  private settings() {return vscode.workspace.getConfiguration('perfchecker', this.folder().uri);}
  private root() {return this.folder().uri.fsPath;}
  private connectionGeneration(workspace: string) {return this.connectionGenerations.get(workspace) ?? 0;}
  private assertWorkspace(workspace: string) {
    let current: string | undefined;
    try {current = this.folder().uri.toString();} catch {/* removed workspace */}
    if (!vscode.workspace.isTrusted || current !== workspace)
      throw new Error('PerfChecker folder or trust changed. Reopen Advisor settings before continuing.');
  }
  private async initial() {
    const settings = this.settings(), file = settings.get<string>('advisorConfig', '');
    const config = await readAdvisorConfiguration(this.folder());
    const local = localAdvisorConnection(this.folder().uri.toString());
    return {config, config_location: local ? 'Temporary local Codex connection; disconnect before editing saved settings' : path.resolve(this.root(), file || 'perf/advisor.json'), enabled: local ? true : settings.get('advisorEnabled', true), investigates: local ? false : settings.get('advisorInvestigates', false),
      max_experiments: settings.get('investigationMaxExperiments', 4), budget_seconds: settings.get('investigationBudgetSeconds', 300)};
  }
  async open() {
    const workspace = this.folder().uri.toString();
    if (this.panel && this.panelWorkspace !== workspace) this.panel.dispose();
    if (this.panel) {this.panel.reveal(); return;}
    const generation = this.connectionGeneration(workspace);
    const initial = await this.initial();
    this.assertWorkspace(workspace);
    if (generation !== this.connectionGeneration(workspace)) throw new Error('Advisor connection changed. Reopen settings to load your provider.');
    this.panelWorkspace = workspace;
    this.panel = vscode.window.createWebviewPanel('perfchecker.advisorSetup', 'PerfChecker · Advisor and models', vscode.ViewColumn.One,
      {enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]});
    const panel = this.panel, webview = panel.webview, nonce = randomUUID();
    const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    const data = JSON.stringify(initial).replace(/</g, '\\u003c');
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'perfchecker.svg');
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource('investigation.css')}"><link rel="stylesheet" href="${resource('advisor-panel.css')}"><title>Advisor and models</title></head><body><header class="advisor-brand"><img src="${resource('perfchecker.png')}" alt="PerfChecker"><span>PerfChecker · Connections and models</span></header><main id="advisor-root"></main><script nonce="${nonce}" src="${resource('advisor-panel.js')}"></script><script nonce="${nonce}">const api=acquireVsCodeApi();const panel=mountAdvisorPanel(document.getElementById('advisor-root'),m=>api.postMessage(m),${data});window.addEventListener('message',e=>panel.receive(e.data));</script></body></html>`;
    this.panel.onDidDispose(() => {this.cancel(); this.panel = undefined;});
    webview.onDidReceiveMessage(async message => {
      try {
        if (this.panel !== panel) throw new Error('Advisor connection changed. Reopen settings to load your saved provider.');
        if (this.folder().uri.toString() !== workspace) throw new Error('PerfChecker folder changed. Reopen advisor settings.');
        if (message.type === 'advisorCancel') this.cancel();
        else if (message.type === 'advisorHelp') await vscode.env.openExternal(vscode.Uri.parse('https://docs.ollama.com/quickstart'));
        else if (message.type === 'advisorAction') {
          const result = await this.action(message);
          await webview.postMessage({type: 'advisorResult', result});
        }
      } catch (error) {await webview.postMessage({type: 'advisorResult', result: {status: 'error', message: String(error)}});}
    }, undefined, this.context.subscriptions);
  }
  async action(input: any): Promise<any> {
    const folder = this.folder(), workspace = folder.uri.toString(), root = folder.uri.fsPath;
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri), generation = this.connectionGeneration(workspace);
    const file = path.resolve(root, settings.get<string>('advisorConfig', '') || 'perf/advisor.json');
    if (localAdvisorConnection(workspace)) throw new Error('Disconnect the local Codex connector before editing or testing saved provider settings. Its temporary endpoint must not be saved.');
    assertSavedAdvisorConfiguration(input?.config);
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before connecting an advisor.');
    if (this.busy) throw new Error('A setup operation is already running.');
    if (!['save', 'probe', 'models', 'pull', 'delete', 'unload'].includes(input?.action)) throw new Error('Unknown advisor action.');
    if (JSON.stringify(input).length > 32000) throw new Error('Setup request exceeds 32 KB.');
    const max = input.max_experiments ?? 4, budget = input.budget_seconds ?? 300;
    if (!Number.isInteger(max) || max < 1 || max > 100 || !Number.isFinite(budget) || budget < 1 || budget > 86400) throw new Error('Invalid investigation limits.');
    if (input.investigates && input.config?.protocol === 'mcp_http' && input.config?.mcp_response !== 'structured') throw new Error('MCP investigation requires structured responses.');
    this.busy = true; this.cancelled = false;
    try {
      if (input.action === 'save' && input.config === null) {
        await settings.update('advisorEnabled', false, vscode.ConfigurationTarget.WorkspaceFolder);
        await settings.update('advisorInvestigates', false, vscode.ConfigurationTarget.WorkspaceFolder);
        return {status: 'complete', message: 'Rule-based advice only. Model files remain installed.'};
      }
      const project = resolveControllerProject(root, settings).project;
      const julia = settings.get<string>('juliaExecutable', 'julia');
      const result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
        title: 'PerfChecker · Advisor and models', cancellable: true}, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => this.cancel());
        if (token.isCancellationRequested) this.cancel();
        try {return await this.invoke({...input, action: input.action === 'save' ? 'validate' : input.action}, root, project, julia);}
        finally {subscription.dispose();}
      });
      if (input.action === 'save' && result.status === 'complete') {
        this.assertWorkspace(workspace);
        if (this.cancelled || generation !== this.connectionGeneration(workspace) || localAdvisorConnection(workspace)) throw new Error('Advisor connection changed or setup was cancelled. Reopen settings before saving your provider.');
        assertSavedAdvisorConfiguration(result.config);
        await fs.mkdir(path.dirname(file), {recursive: true});
        this.assertWorkspace(workspace);
        if (this.cancelled || generation !== this.connectionGeneration(workspace)) throw new Error('Setup changed or was cancelled before saving. Reopen Advisor settings.');
        // Keep optional/custom provider fields validated by the common Julia contract.
        await fs.writeFile(file, JSON.stringify(result.config, null, 2) + '\n', 'utf8');
        await settings.update('advisorConfig', path.relative(root, file).replaceAll('\\', '/'), vscode.ConfigurationTarget.WorkspaceFolder);
        await settings.update('advisorEnabled', true, vscode.ConfigurationTarget.WorkspaceFolder);
        await settings.update('advisorInvestigates', Boolean(input.investigates), vscode.ConfigurationTarget.WorkspaceFolder);
        await settings.update('investigationMaxExperiments', max, vscode.ConfigurationTarget.WorkspaceFolder);
        await settings.update('investigationBudgetSeconds', budget, vscode.ConfigurationTarget.WorkspaceFolder);
        return {status: 'complete', message: `Configuration saved: ${file}. No generation request was made.`};
      }
      return result;
    } finally {this.busy = false; this.child = undefined;}
  }
  private async invoke(input: any, root: string, project: string, julia: string): Promise<any> {
    const temporaryRoot = path.resolve(os.tmpdir());
    const directory = await fs.mkdtemp(path.join(temporaryRoot, 'perfchecker-setup-'));
    try {
      if (this.cancelled) return {status: 'cancelled', message: 'Setup operation cancelled before starting a worker.'};
      const file = path.join(directory, 'request.json');
      await fs.writeFile(file, JSON.stringify(input), {flag: 'wx', mode: 0o600});
      if (this.cancelled) return {status: 'cancelled', message: 'Setup operation cancelled before starting a worker.'};
      return await new Promise((resolve, reject) => {
        const child = spawn(julia, ['--startup-file=no', `--project=${project}`,
          '-e', cancellableJulia('using PerfChecker; exit(perfchecker_main(ARGS))'), '--', 'advisor-setup', `--source=${file}`, `--project=${project}`],
        {cwd: root, windowsHide: true, detached: process.platform !== 'win32',env:{...process.env,JULIA_LOAD_PATH:['@','@stdlib'].join(path.delimiter)}});
        this.child = child;
        const stop=controllerCancellation(child,(message,forced)=>{if(forced)void vscode.window.showWarningMessage(message);});this.stopController=stop;
        let output = '', error = '';
        const timeout = setTimeout(() => this.cancel(), (Math.min(Number(input.config?.timeout) || 120, 3600) + 60) * 1000);
        child.stdout?.on('data', data => {output += data.toString(); if (output.length > 2_000_000) this.cancel();});
        child.stderr?.on('data', data => {error = (error + data.toString()).slice(-4000);});
        child.on('error', e => {clearTimeout(timeout);stop.dispose();if(this.stopController===stop)this.stopController=undefined;reject(e);});
        child.on('close', code => {
          clearTimeout(timeout);
          stop.dispose();if(this.stopController===stop)this.stopController=undefined;
          if (this.cancelled) return resolve({status: 'cancelled', message: 'Operation cancelled. The server may retain partial files; refresh its inventory.'});
          try {resolve(JSON.parse(output));} catch {reject(new Error(code ? error || 'Julia setup worker failed.' : 'Invalid setup response.'));}
        });
      });
    } finally {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) === temporaryRoot && path.basename(resolved).startsWith('perfchecker-setup-')) await fs.rm(resolved, {recursive: true, force: true});
    }
  }
  cancel() {
    if (this.busy) this.cancelled = true;
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    this.cancelled = true;
    this.stopController?.request();
  }
  dispose() {this.unsubscribeConnection(); this.cancel(); this.panel?.dispose();}
}

export function registerAdvisorSetup(context: vscode.ExtensionContext) {
  const setup = new AdvisorSetup(context);
  context.subscriptions.push(setup,
    vscode.commands.registerCommand('perfchecker.configureAdvisor', () => setup.open()),
    vscode.commands.registerCommand('perfchecker.advisorSetupAction', input => setup.action(input)),
    vscode.commands.registerCommand('perfchecker.cancelAdvisorSetup', () => setup.cancel()));
}
