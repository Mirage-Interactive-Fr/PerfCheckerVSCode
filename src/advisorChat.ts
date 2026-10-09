import * as vscode from 'vscode';
import {spawn, ChildProcess} from 'node:child_process';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {StringDecoder} from 'node:string_decoder';
import {randomUUID} from 'node:crypto';
import {currentWorkspaceFolder, resolveControllerProject} from './workspace-root';
import {readAdvisorConfiguration} from './advisorSetup';
import {localAdvisorConnection} from './advisorConnection';
import {ChatMessage, prepareChatMessages, completeChatMessages, chatReply} from './advisorChatModel';
import {InvestigationReport} from './investigationModel';
import {createImplementationCheckout, applyImplementation, recoverImplementationProposal, recoverActiveImplementationProposal, saveActiveImplementationProposal, ImplementationProposal} from './implementation';
import {cancellableJulia, controllerCancellation} from './controllerCancellation';

export interface ChatEvidence {id: string; label: string}
export class AdvisorChat implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private workspace?: string;
  private messages: ChatMessage[] = [];
  private evidenceId = '';
  private displayedEvidence: ChatEvidence[] = [];
  private child?: ChildProcess;
  private cancellation?: ReturnType<typeof controllerCancellation>;
  private busy = false;
  private cancelled = false;
  private status = 'Configure an MCP advice tool, then send a question.';
  private pending = '';
  private disposed = false;
  private proposal?: ImplementationProposal;
  private implementationSummary = '';
  private backupRef = '';
  private recoveredWorkspace?: string;
  constructor(private context: vscode.ExtensionContext,
    private evidenceOptions: () => ChatEvidence[],
    private readEvidence: (id: string) => Promise<InvestigationReport>) {}

  private folder() {
    const folder = currentWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders);
    const key = folder.uri.toString();
    if (key !== this.workspace) {
      if (this.busy) throw new Error('Wait for the active conversation before changing PerfChecker folders.');
      this.panel?.dispose(); this.panel = undefined;
      this.messages = []; this.evidenceId = ''; this.pending = '';
      this.displayedEvidence = [];
      this.proposal = undefined; this.implementationSummary = ''; this.backupRef = '';
      this.recoveredWorkspace = undefined;
      this.workspace = key;
    }
    return folder;
  }
  state() {
    // A displayed conversation retains its folder even when another Studio
    // changes the window's selected workspace. Its owned Cancel stays usable.
    const folder = this.panel ? vscode.workspace.workspaceFolders?.find(folder=>folder.uri.toString()===this.workspace) : this.folder();
    if (!folder) throw new Error('The conversation workspace was closed.');
    let selectedHere=false;
    try{selectedHere=currentWorkspaceFolder(vscode.workspace.workspaceFolders).uri.toString()===folder.uri.toString();}
    catch{/* A different selected folder may have closed while this request finishes. */}
    // The evidence provider is selected-folder scoped. Retain A's last inventory
    // while B is selected instead of invoking B's history provider for A's panel.
    if(selectedHere)this.displayedEvidence=this.evidenceOptions().map(item=>({...item}));
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    return {type: 'chatState', workspace: folder.name, messages: this.messages, evidenceId: this.evidenceId,
      evidence: this.displayedEvidence, busy: this.busy, status: this.status, pending: this.pending,
      connection: localAdvisorConnection(folder.uri.toString())?.label,
      implementation: localAdvisorConnection(folder.uri.toString())?.implementation ?? {tool: settings.get('advisorImplementationMcpTool', ''),
        promptArgument: settings.get('advisorImplementationMcpPromptArgument', 'prompt'),
        workspaceArgument: settings.get('advisorImplementationMcpWorkspaceArgument', 'workspace')},
      proposal: this.proposal ? {patch: this.proposal.patch, lossyPreview: this.proposal.lossyPreview, files: this.proposal.files, applied: this.proposal.applied} : undefined,
      implementationSummary: this.implementationSummary, backupRef: this.proposal?.backupRef ?? this.backupRef};
  }
  isBusy() {return this.busy;}
  connectionChanged() {this.status = localAdvisorConnection(this.folder().uri.toString()) ? 'Codex connected for this editor session. Advice is read-only; implementation requires review.' : 'Local Codex disconnected. Saved provider configuration is active again. Reconnect after an editor restart.'; this.publish();}
  private publish() {
    if (this.disposed) return;
    try {void this.panel?.webview.postMessage(this.state());} catch {/* selected folder was closed */}
  }
  async open() {
    const workspace = this.folder().uri.toString();
    await this.recoverProposal();
    if (this.panel) {this.panel.reveal(); this.publish(); return;}
    this.panel = vscode.window.createWebviewPanel('perfchecker.advisorChat', 'PerfChecker · Chat', vscode.ViewColumn.One,
      {enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]});
    const panel = this.panel, webview = panel.webview, nonce = randomUUID();
    const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    this.panel.iconPath = {light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'perfchecker-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'perfchecker-dark.svg')};
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource('advisor-chat.css')}"><title>PerfChecker chat</title></head><body><main id="chat-root"></main><script nonce="${nonce}" src="${resource('advisor-chat.js')}"></script><script nonce="${nonce}">const api=acquireVsCodeApi();const panel=mountAdvisorChat(document.getElementById('chat-root'),m=>api.postMessage(m),${JSON.stringify(String(resource('perfchecker.png')))});window.addEventListener('message',e=>panel.receive(e.data));api.postMessage({type:'chatReady'});</script></body></html>`;
    panel.onDidDispose(() => {if (this.panel===panel) {this.cancel();this.panel=undefined;}});
    webview.onDidReceiveMessage(async message => {
      try {
        if (this.panel!==panel || this.workspace!==workspace) return;
        if (message?.type==='chatCancel') {this.cancel();return;}
        if (this.folder().uri.toString() !== workspace) throw new Error('PerfChecker folder changed. Reopen the conversation.');
        if (message?.type === 'chatReady') this.publish();
        else if (message?.type === 'chatSend') await this.send(message.question, message.evidenceId);
        else if (message?.type === 'chatClear') this.clear(message.evidenceId);
        else if (message?.type === 'chatSettings') await vscode.commands.executeCommand('perfchecker.configureAdvisor');
        else if (message?.type === 'chatConnectCodex') await vscode.commands.executeCommand('perfchecker.connectCodex');
        else if (message?.type === 'chatDisconnectCodex') await vscode.commands.executeCommand('perfchecker.disconnectCodex');
        else if (message?.type === 'implementationSettings') await this.saveImplementationSettings(message);
        else if (message?.type === 'chatImplement') await this.implement(true);
        else if (message?.type === 'chatApply') await this.apply();
        else if (message?.type === 'chatRestore') await this.apply(true);
        else if (message?.type === 'chatDiff') {
          if (!this.proposal) throw new Error('No implementation diff is available.');
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language: 'diff', content: this.proposal.patch}), {preview: true});
        }
        else if (message?.type === 'chatVerify') await vscode.commands.executeCommand('perfchecker.openInvestigations');
        else if (message?.type === 'chatDiscard') {if (this.busy) throw new Error('Wait for the current request.'); this.proposal = undefined; this.implementationSummary = ''; await this.persistProposal(); this.publish();}
      } catch (error) {if (this.panel===panel && this.workspace===workspace) {this.status=String(error);this.publish();}}
    }, undefined, this.context.subscriptions);
  }
  clear(evidenceId: unknown = '') {
    this.folder();
    if (this.busy) throw new Error('Cancel or finish the current request before starting a new conversation.');
    if (typeof evidenceId !== 'string' || (evidenceId && !this.evidenceOptions().some(item => item.id === evidenceId))) throw new Error('Saved evidence is no longer available.');
    this.messages = []; this.pending = ''; this.evidenceId = evidenceId;
    this.status = 'New conversation. Only the selected saved evidence and your messages will be sent.';
    this.publish();
  }
  async send(question: unknown, evidenceId: unknown = this.evidenceId) {
    const folder = this.folder();
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before connecting an advisor.');
    if (this.busy) throw new Error('An advisor request is already running.');
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    if (!settings.get('advisorEnabled', true) && !localAdvisorConnection(folder.uri.toString())) throw new Error('Optional advisor is disabled. Open Advisor settings to configure it.');
    if (typeof evidenceId !== 'string' || (evidenceId && !this.evidenceOptions().some(item => item.id === evidenceId))) throw new Error('Saved evidence is no longer available.');
    const prepared = prepareChatMessages(evidenceId === this.evidenceId ? this.messages : [], question);
    // Lock before any asynchronous read so double submissions cannot overlap.
    this.busy = true; this.cancelled = false;
    this.pending = prepared.messages.at(-1)!.content;
    this.status = 'Connecting to the configured MCP advice tool…'; this.publish();
    try {
      await this.recoverProposal();
      const config = await readAdvisorConfiguration(folder);
      if (config.protocol !== 'mcp_http' || (config.mcp_response ?? 'text') !== 'text' || !config.mcp_tool) {
        throw new Error('Chat requires an MCP advice tool in text mode. Open Advisor settings, select mcp_http, discover a tool and save.');
      }
      const advice = evidenceId ? await this.readEvidence(evidenceId) : undefined;
      if (this.cancelled) throw new Error('Request cancelled.');
      const result = await this.invoke(folder, config, {messages: prepared.messages, ...(advice ? {advice} : {})});
      if (this.cancelled) throw new Error('Request cancelled. The remote server may still finish its work.');
      const reply = chatReply(result);
      const completed = completeChatMessages(prepared.messages, reply);
      this.messages = completed.messages;
      this.evidenceId = evidenceId;
      this.pending = '';
      const omitted = prepared.omitted + completed.omitted;
      this.status = `Reply received · advice is unverified.${omitted ? ` ${omitted / 2} older exchanges were omitted to fit the context limit.` : ''}`;
      return result;
    } catch (error) {this.status = String(error); throw error;}
    finally {this.busy = false; this.child = undefined; this.publish();}
  }
  private async saveImplementationSettings(input: any) {
    const folder = this.folder();
    if (this.busy) throw new Error('Wait for the current request.');
    if (localAdvisorConnection(folder.uri.toString())) throw new Error('The local Codex connector supplies its implementation tool. Disconnect it to configure your saved provider.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before configuring implementation.');
    if (typeof input.tool !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.tool) ||
      ![input.promptArgument, input.workspaceArgument].every(value => typeof value === 'string' && /^[A-Za-z_][A-Za-z_0-9.-]{0,127}$/.test(value)) ||
      input.promptArgument === input.workspaceArgument) throw new Error('Enter an implementation tool and two different argument names.');
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    await settings.update('advisorImplementationMcpTool', input.tool, vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('advisorImplementationMcpPromptArgument', input.promptArgument, vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('advisorImplementationMcpWorkspaceArgument', input.workspaceArgument, vscode.ConfigurationTarget.WorkspaceFolder);
    this.status = 'Implementation tool saved. Review advice before preparing changes.'; this.publish();
  }
  async implement(warningShown = false) {
    const folder = this.folder();
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before requesting implementation.');
    if (this.busy) throw new Error('An advisor request is already running.');
    if (!this.messages.length) throw new Error('Get and review advice before requesting implementation.');
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' &&
      this.containsFile(folder.uri.fsPath, document.uri.fsPath))) throw new Error('Save your files before preparing a Git checkpoint.');
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    const local = localAdvisorConnection(folder.uri.toString());
    if (!settings.get('advisorEnabled', true) && !local) throw new Error('Optional advisor is disabled.');
    const tool = local?.implementation.tool ?? settings.get<string>('advisorImplementationMcpTool', '');
    if (!tool) throw new Error('Configure an explicit MCP implementation tool first.');
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool)) throw new Error('Invalid MCP implementation tool name.');
    const promptArgument = local?.implementation.promptArgument ?? settings.get<string>('advisorImplementationMcpPromptArgument', 'prompt');
    const workspaceArgument = local?.implementation.workspaceArgument ?? settings.get<string>('advisorImplementationMcpWorkspaceArgument', 'workspace');
    if (![promptArgument, workspaceArgument].every(value => /^[A-Za-z_][A-Za-z_0-9.-]{0,127}$/.test(value)) || promptArgument === workspaceArgument) throw new Error('Configure two distinct MCP prompt and workspace argument names.');
    if (!warningShown) void vscode.window.showWarningMessage('Agent edits may be incorrect. PerfChecker saves a Git checkpoint and prepares an isolated copy. Review the diff before applying, then rerun checks.');
    this.busy = true; this.cancelled = false;
    this.status = 'Creating Git checkpoint and isolated checkout…'; this.publish();
    let checkout: Awaited<ReturnType<typeof createImplementationCheckout>> | undefined;
    try {
      await this.recoverProposal();
      const config = await readAdvisorConfiguration(folder);
      if (config.protocol !== 'mcp_http') throw new Error('Implementation requires an MCP endpoint.');
      config.mcp_tool = tool; config.mcp_response = 'text';
      config.mcp_prompt_argument = promptArgument;
      checkout = await createImplementationCheckout(folder.uri.fsPath);
      this.backupRef = checkout.backupRef;
      await this.persistProposal();
      if (this.cancelled) throw new Error('Implementation cancelled; checkpoint retained.');
      this.status = 'Agent is implementing in an isolated checkout. Your project awaits diff review.'; this.publish();
      const advice = this.evidenceId ? await this.readEvidence(this.evidenceId) : undefined;
      const prepared = prepareChatMessages(this.messages, 'Implement the recommendations in the latest assistant reply. Inspect the code and verify the changes.');
      const result = await this.invoke(folder, config, {messages: prepared.messages, ...(advice ? {advice} : {}),
        workspace: checkout.workspace, workspace_argument: workspaceArgument}, 'implement');
      if (this.cancelled) throw new Error('Implementation cancelled; checkpoint retained. The remote agent may still be running.');
      this.folder();
      const summary = chatReply(result);
      this.proposal = await checkout.collect();
      this.implementationSummary = summary;
      await this.persistProposal();
      this.status = this.proposal.files.length ? 'Review the proposed diff, then apply it. Rerun correctness and performance checks after applying.' : 'The agent returned no code changes. Its summary is unverified.';
      return this.proposal;
    } catch (error) {this.status = String(error); throw error;}
    finally {try {await checkout?.dispose();} finally {this.busy = false; this.child = undefined; this.publish();}}
  }
  async apply(restore = false) {
    this.folder();
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before applying changes.');
    if (this.busy) throw new Error('An advisor request is already running.');
    this.busy = true; this.publish();
    try {
      await this.recoverProposal();
      if (!this.proposal) throw new Error('Prepare and review an implementation first.');
      if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' &&
        this.containsFile(this.proposal!.repository, document.uri.fsPath))) throw new Error('Save or discard editor changes before applying or restoring.');
      await applyImplementation(this.proposal, restore);
      await this.persistProposal();
      this.status = restore ? 'Previous code restored. Git staging is preserved.' : 'Reviewed changes applied. Run correctness tests and compare performance before accepting the result.';
      return this.state();
    } catch (error) {this.status = String(error); throw error;}
    finally {this.busy = false; this.publish();}
  }
  private containsFile(root: string, file: string) {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
  private recoveryKey() {return `perfchecker.implementation.${this.folder().uri.toString()}`;}
  private async persistProposal() {
    const proposal = this.proposal;
    await saveActiveImplementationProposal(this.folder().uri.fsPath, proposal);
    await this.context.workspaceState.update(this.recoveryKey(), {backupRef: this.backupRef,
      ...(proposal ? {proposal: {backupRef: proposal.backupRef, candidateRef: proposal.candidateRef, applied: proposal.applied}} : {})});
  }
  private async recoverProposal() {
    const folder = this.folder(), key = folder.uri.toString();
    if (this.recoveredWorkspace === key) return;
    this.recoveredWorkspace = key;
    const saved = this.context.workspaceState.get<{backupRef?: string; proposal?: {backupRef: string; candidateRef: string; applied: boolean}}>(this.recoveryKey());
    this.backupRef = saved?.backupRef ?? '';
    try {
      this.proposal = saved?.proposal ? await recoverImplementationProposal(folder.uri.fsPath, saved.proposal.backupRef, saved.proposal.candidateRef, saved.proposal.applied) : await recoverActiveImplementationProposal(folder.uri.fsPath);
      if (this.proposal) {this.backupRef = this.proposal.backupRef; this.status = 'Previous implementation recovered from Git. Review the diff or restore previous code.';}
    } catch (error) {this.status = `Git recovery needs attention: ${String(error)}. Checkpoint references are retained.`;}
  }
  private async invoke(folder: vscode.WorkspaceFolder, config: Record<string, unknown>, request: unknown, command = 'chat'): Promise<unknown> {
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    const project = resolveControllerProject(folder.uri.fsPath, settings).project;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'perfchecker-chat-'));
    try {
      const source = path.join(directory, 'request.json'), configuration = path.join(directory, 'advisor.json');
      await fs.writeFile(source, JSON.stringify(request), {flag: 'wx', mode: 0o600});
      await fs.writeFile(configuration, JSON.stringify(config), {flag: 'wx', mode: 0o600});
      if (this.cancelled) throw new Error('Request cancelled.');
      return await new Promise((resolve, reject) => {
        const child = spawn(settings.get('juliaExecutable', 'julia'), ['--startup-file=no', `--project=${project}`,
          '-e', cancellableJulia('using PerfChecker; exit(perfchecker_main(ARGS))'), '--', command, `--source=${source}`,
          `--advisor-config=${configuration}`, `--project=${project}`],
        {cwd: folder.uri.fsPath, windowsHide: true, detached: process.platform !== 'win32',
          env: {...process.env, JULIA_LOAD_PATH: process.env.PERFCHECKER_LOAD_PATH || `@${path.delimiter}@stdlib`}});
        this.child = child;
        const cancellation = controllerCancellation(child, message => {this.status = message; this.publish();});
        this.cancellation = cancellation;
        const output: Buffer[] = [], errorDecoder = new StringDecoder('utf8');
        let error = '', size = 0, exceeded = false, timedOut = false;
        const duration = Number(config.timeout ?? 90);
        const timeout = setTimeout(() => {timedOut = true; this.cancel();},
          (Math.min(Number.isFinite(duration) && duration > 0 ? duration : 90, 3600) + 60) * 1000);
        child.stdout?.on('data', data => {
          size += data.length;
          if (size > 2_000_000) {exceeded = true; this.cancel();} else output.push(Buffer.from(data));
        });
        child.stderr?.on('data', data => {error = (error + errorDecoder.write(data)).slice(-4000);});
        const release = () => {
          clearTimeout(timeout); cancellation.dispose();
          if (this.child === child) {this.child = undefined; this.cancellation = undefined;}
        };
        child.on('error', value => {release(); reject(value);});
        child.on('close', code => {
          release();
          error = (error + errorDecoder.end()).slice(-4000);
          if (cancellation.forced) return reject(new Error(`${exceeded?'Advisor output exceeded 2 MB. ':''}Forced stop: advisor controller cleanup did not finish. Allocation traces or private inventories may remain; inspect the PerfChecker output.`));
          if (exceeded) return reject(new Error('Advisor output exceeded 2 MB.'));
          if (timedOut) return reject(new Error(`Advisor request timed out.${code && code !== 130 && error ? ` ${error}` : ''}`));
          if (this.cancelled) return reject(new Error(code && code !== 130 && error ? error :
            'Request cancelled after local worker cleanup. The remote server may still finish its work.'));
          try {resolve(JSON.parse(Buffer.concat(output).toString('utf8')));} catch {reject(new Error(code ? error || 'Julia chat worker failed. Update the PerfChecker controller if chat is unavailable.' : 'Invalid advisor response.'));}
        });
      });
    } finally {await fs.rm(directory, {recursive: true, force: true});}
  }
  cancel() {
    if (!this.busy) return;
    this.cancelled = true; this.status = 'Cancelling advisor request…';
    this.cancellation?.request();
    this.publish();
  }
  dispose() {this.disposed = true; this.cancel(); this.panel?.dispose();}
}
