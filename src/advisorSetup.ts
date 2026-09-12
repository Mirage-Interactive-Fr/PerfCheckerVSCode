import * as vscode from 'vscode';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {spawn, ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const mapping: Record<string, [string, unknown]> = {
  endpoint: ['advisorEndpoint', 'http://127.0.0.1:8081/v1/chat/completions'], model: ['advisorModel', 'local'],
  protocol: ['advisorProtocol', 'chat_completions'], allow_remote: ['advisorAllowRemote', false],
  api_key_env: ['advisorKeyEnvironment', ''], instructions: ['advisorInstructions', ''], timeout: ['advisorTimeout', 120],
  mcp_tool: ['advisorMcpTool', ''], mcp_prompt_argument: ['advisorMcpPromptArgument', 'prompt'],
  mcp_arguments: ['advisorMcpArguments', {}], mcp_version: ['advisorMcpVersion', '2026-07-28'], mcp_response: ['advisorMcpResponse', 'text']
};

export class AdvisorSetup implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private child?: ChildProcess;
  private cancelled = false;
  private busy = false;
  constructor(private context: vscode.ExtensionContext) {}
  private settings() {return vscode.workspace.getConfiguration('perfchecker', vscode.workspace.workspaceFolders?.[0]?.uri);}
  private root() {const folder = vscode.workspace.workspaceFolders?.[0]; if (!folder) throw new Error('Open a package workspace first.'); return folder.uri.fsPath;}
  private async initial() {
    const settings = this.settings(), file = settings.get<string>('advisorConfig', '');
    let config: Record<string, unknown>;
    if (file) {
      const location = path.resolve(this.root(), file);
      if ((await fs.stat(location)).size > 32000) throw new Error('Advisor configuration exceeds 32 KB.');
      config = JSON.parse(await fs.readFile(location, 'utf8'));
    } else config = Object.fromEntries(Object.entries(mapping).map(([key, [setting, fallback]]) => [key, settings.get(setting, fallback)]));
    return {config, config_location: path.resolve(this.root(), file || 'perf/advisor.json'), enabled: settings.get('advisorEnabled', true), investigates: settings.get('advisorInvestigates', false),
      max_experiments: settings.get('investigationMaxExperiments', 4), budget_seconds: settings.get('investigationBudgetSeconds', 300)};
  }
  async open() {
    if (this.panel) {this.panel.reveal(); return;}
    const initial = await this.initial();
    this.panel = vscode.window.createWebviewPanel('perfchecker.advisorSetup', 'PerfChecker · Conseiller et modèles', vscode.ViewColumn.One,
      {enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]});
    const webview = this.panel.webview, nonce = randomUUID();
    const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    const data = JSON.stringify(initial).replace(/</g, '\\u003c');
    webview.html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource('investigation.css')}"><link rel="stylesheet" href="${resource('advisor-panel.css')}"><title>Conseiller et modèles</title></head><body><main id="advisor-root"></main><script nonce="${nonce}" src="${resource('advisor-panel.js')}"></script><script nonce="${nonce}">const api=acquireVsCodeApi();const panel=mountAdvisorPanel(document.getElementById('advisor-root'),m=>api.postMessage(m),${data});window.addEventListener('message',e=>panel.receive(e.data));</script></body></html>`;
    this.panel.onDidDispose(() => {this.cancel(); this.panel = undefined;});
    webview.onDidReceiveMessage(async message => {
      try {
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
        await this.settings().update('advisorEnabled', false, vscode.ConfigurationTarget.Workspace);
        await this.settings().update('advisorInvestigates', false, vscode.ConfigurationTarget.Workspace);
        return {status: 'complete', message: 'Conseils déterministes uniquement. Les fichiers de modèles restent installés.'};
      }
      const result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
        title: 'PerfChecker · Conseiller et modèles', cancellable: true}, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => this.cancel());
        try {return await this.invoke({...input, action: input.action === 'save' ? 'validate' : input.action});}
        finally {subscription.dispose();}
      });
      if (input.action === 'save' && result.status === 'complete') {
        const settings = this.settings();
        const file = path.resolve(this.root(), settings.get<string>('advisorConfig', '') || 'perf/advisor.json');
        await fs.mkdir(path.dirname(file), {recursive: true});
        // Keep optional/custom provider fields validated by the common Julia contract.
        await fs.writeFile(file, JSON.stringify(result.config, null, 2) + '\n', 'utf8');
        await settings.update('advisorConfig', path.relative(this.root(), file).replaceAll('\\', '/'), vscode.ConfigurationTarget.Workspace);
        await settings.update('advisorEnabled', true, vscode.ConfigurationTarget.Workspace);
        await settings.update('advisorInvestigates', Boolean(input.investigates), vscode.ConfigurationTarget.Workspace);
        await settings.update('investigationMaxExperiments', max, vscode.ConfigurationTarget.Workspace);
        await settings.update('investigationBudgetSeconds', budget, vscode.ConfigurationTarget.Workspace);
        return {status: 'complete', message: `Configuration enregistrée : ${file}. Aucun appel de génération effectué.`};
      }
      return result;
    } finally {this.busy = false; this.child = undefined;}
  }
  private async invoke(input: any): Promise<any> {
    const temporaryRoot = path.resolve(os.tmpdir());
    const directory = await fs.mkdtemp(path.join(temporaryRoot, 'perfchecker-setup-'));
    try {
      const file = path.join(directory, 'request.json');
      await fs.writeFile(file, JSON.stringify(input), {flag: 'wx'});
      const settings = this.settings(), project = path.resolve(this.root(), settings.get('runnerProject', 'perf'));
      return await new Promise((resolve, reject) => {
        const child = spawn(settings.get('juliaExecutable', 'julia'), ['--startup-file=no', `--project=${project}`,
          '-e', 'using PerfChecker; exit(perfchecker_main(ARGS))', '--', 'advisor-setup', `--source=${file}`, `--project=${project}`],
        {cwd: this.root(), windowsHide: true, detached: process.platform !== 'win32'});
        this.child = child;
        let output = '', error = '';
        const timeout = setTimeout(() => this.cancel(), (Math.min(Number(input.config?.timeout) || 120, 3600) + 60) * 1000);
        child.stdout?.on('data', data => {output += data.toString(); if (output.length > 2_000_000) this.cancel();});
        child.stderr?.on('data', data => {error = (error + data.toString()).slice(-4000);});
        child.on('error', e => {clearTimeout(timeout); reject(e);});
        child.on('close', code => {
          clearTimeout(timeout);
          if (this.cancelled) return resolve({status: 'cancelled', message: 'Opération interrompue. Le serveur peut conserver des fichiers partiels ; actualise son inventaire.'});
          try {resolve(JSON.parse(output));} catch {reject(new Error(code ? error || 'Julia setup worker failed.' : 'Invalid setup response.'));}
        });
      });
    } finally {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) === temporaryRoot && path.basename(resolved).startsWith('perfchecker-setup-')) await fs.rm(resolved, {recursive: true, force: true});
    }
  }
  cancel() {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    this.cancelled = true;
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true}).on('error', () => child.kill());
    else {try {process.kill(-child.pid, 'SIGKILL');} catch {child.kill('SIGKILL');}}
  }
  dispose() {this.cancel(); this.panel?.dispose();}
}

export function registerAdvisorSetup(context: vscode.ExtensionContext) {
  const setup = new AdvisorSetup(context);
  context.subscriptions.push(setup,
    vscode.commands.registerCommand('perfchecker.configureAdvisor', () => setup.open()),
    vscode.commands.registerCommand('perfchecker.advisorSetupAction', input => setup.action(input)),
    vscode.commands.registerCommand('perfchecker.cancelAdvisorSetup', () => setup.cancel()));
}
