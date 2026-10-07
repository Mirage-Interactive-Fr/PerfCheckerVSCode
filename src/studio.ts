import * as vscode from 'vscode';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import {PlutoNotebooks} from './plutoNotebook';
import {randomUUID} from 'node:crypto';
import {currentWorkspaceFolder, resolveControllerProject, selectWorkspaceFolder} from './workspace-root';

const actions: Record<string, string> = {
  initialize:'perfchecker.initialize',
  suite: 'perfchecker.openDesigner', results: 'perfchecker.openOutput', investigations: 'perfchecker.openInvestigations',
  items: 'perfchecker.discoverTestItems', chat: 'perfchecker.openChat', advisor: 'perfchecker.configureAdvisor',
  terminal: 'perfchecker.openTerminal', notebook: 'perfchecker.newNotebook', openNotebook: 'perfchecker.openNotebook',
  debug: 'perfchecker.debugFile', tasks: 'workbench.action.tasks.runTask', julia: 'language-julia.startREPL',
  tools: 'perfchecker.catalogTools', testing: 'workbench.view.testing'
};

class Studio implements vscode.Disposable {
  private pluto: PlutoNotebooks;
  private panel?: vscode.WebviewPanel;
  private panelWorkspace?: string;
  private terminals = new Map<string, vscode.Terminal>();
  private lastJuliaSource = new Map<string, vscode.Uri>();
  constructor(private context: vscode.ExtensionContext) {
    this.pluto = new PlutoNotebooks(context);
    const remember = (editor?: vscode.TextEditor) => {
      if (editor?.document.languageId !== 'julia' || editor.document.uri.scheme !== 'file') return;
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (folder) this.lastJuliaSource.set(folder.uri.toString(), editor.document.uri);
    };
    remember(vscode.window.activeTextEditor);
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(remember));
    context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
      for (const [key, existing] of this.terminals) if (terminal === existing) this.terminals.delete(key);
    }));
  }
  private folder(requested?: vscode.Uri | vscode.WorkspaceFolder) {
    return requested === undefined ? currentWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders) :
      selectWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders, requested);
  }
  async open(requested?: vscode.Uri | vscode.WorkspaceFolder) {
    let folder: vscode.WorkspaceFolder;
    if (requested === undefined && (vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
      const picked = await vscode.window.showQuickPick(vscode.workspace.workspaceFolders!.map(item => ({label: item.name, description: item.uri.fsPath, folder: item})), {title: 'PerfChecker · Choose workspace'});
      if (!picked) return;
      folder = selectWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders, picked.folder);
    } else folder = selectWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders, requested);
    const workspace = folder.uri.toString();
    if (this.panel && this.panelWorkspace !== workspace) this.panel.dispose();
    if (this.panel) {this.panel.reveal(); await this.publish(); return;}
    this.panelWorkspace = workspace;
    this.panel = vscode.window.createWebviewPanel('perfchecker.studio', `PerfChecker · ${folder.name}`, vscode.ViewColumn.One,
      {enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]});
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'perfchecker.svg');
    const panel = this.panel, webview = panel.webview, nonce = randomUUID();
    const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource('studio.css')}"><title>PerfChecker Studio</title></head><body><main id="studio-root"></main><script nonce="${nonce}" src="${resource('studio.js')}"></script><script nonce="${nonce}">const api=acquireVsCodeApi();const studio=mountPerfCheckerStudio(document.getElementById('studio-root'),m=>api.postMessage(m),${JSON.stringify(String(resource('perfchecker.png')))});window.addEventListener('message',e=>studio.receive(e.data));api.postMessage({type:'studioReady'});</script></body></html>`;
    panel.onDidDispose(() => {if (this.panel === panel) {this.panel = undefined; this.panelWorkspace = undefined;}});
    webview.onDidReceiveMessage(async message => {
      try {
        if (this.folder().uri.toString() !== workspace) throw new Error('PerfChecker folder changed. Reopen Studio for the selected folder.');
        if (message?.type === 'studioReady') await this.publish();
        else if (message?.type === 'studioAction' && typeof message.action === 'string' && Object.hasOwn(actions, message.action)) {
          if (message.action === 'julia' && !vscode.workspace.isTrusted) throw new Error('Trust the workspace before starting Julia.');
          if (message.action === 'julia' && !vscode.extensions.getExtension('julialang.language-julia')) throw new Error('Install the Julia VS Code extension to use its REPL and debugger.');
          await vscode.commands.executeCommand(actions[message.action], ...(['initialize','suite', 'items', 'terminal', 'notebook', 'openNotebook', 'debug'].includes(message.action) ? [folder.uri] : []));
        }
      } catch (error) {await webview.postMessage({type: 'studioError', message: String(error)});}
    }, undefined, this.context.subscriptions);
  }
  private async publish() {
    const folder = this.folder(), settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    let project = '', problem = '';
    try {project = resolveControllerProject(folder.uri.fsPath, settings).project;} catch (error) {problem = String(error);}
    const suite = path.resolve(folder.uri.fsPath, settings.get('suite', 'perf/suite.jl'));
    await this.panel?.webview.postMessage({type: 'studioState', workspace: folder.name, project, problem,
      suiteAvailable: await fs.stat(suite).then(stat => stat.isFile()).catch(() => false),
      juliaAvailable: Boolean(vscode.extensions.getExtension('julialang.language-julia')), trusted: vscode.workspace.isTrusted});
  }
  async terminal(requested?: vscode.Uri | vscode.WorkspaceFolder) {
    const folder = this.folder(requested);
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before starting Julia.');
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    const project = resolveControllerProject(folder.uri.fsPath, settings).project;
    const key = `${folder.uri.toString()}\n${project}\n${settings.get('juliaExecutable', 'julia')}`;
    let terminal = this.terminals.get(key);
    if (!terminal) {
      terminal = vscode.window.createTerminal({name: `PerfChecker · ${folder.name}`, cwd: folder.uri,
        shellPath: settings.get('juliaExecutable', 'julia'), shellArgs: ['--startup-file=no', `--project=${project}`, '-i'],
        iconPath: new vscode.ThemeIcon('beaker')});
      this.terminals.set(key, terminal);
    }
    terminal.show(); return terminal;
  }
  async newNotebook(requested?: vscode.Uri | vscode.WorkspaceFolder, options?: {kind: 'suite' | 'investigation'}) {return await this.pluto.create(requested,options);}
  async openNotebook(requested?: vscode.Uri | vscode.WorkspaceFolder) {return await this.pluto.open(requested);}
  async stopNotebook(requested?: vscode.Uri | vscode.WorkspaceFolder) {return await this.pluto.stopWorkspace(requested);}
  async debugFile(requested?: vscode.Uri | vscode.WorkspaceFolder) {
    const folder = this.folder(requested);
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before debugging.');
    const extension = vscode.extensions.getExtension('julialang.language-julia');
    if (!extension) throw new Error('Install the Julia VS Code extension to use its debugger.');
    let document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== 'julia') {
      const previous = this.lastJuliaSource.get(folder.uri.toString());
      if (previous) document = await vscode.workspace.openTextDocument(previous);
      else {
        const chosen = await vscode.window.showOpenDialog({defaultUri: folder.uri, canSelectMany: false,
          filters: {'Julia source': ['jl']}, title: 'PerfChecker · Choose a Julia file to debug'});
        if (!chosen?.length) return;
        document = await vscode.workspace.openTextDocument(chosen[0]);
      }
    }
    if (document.languageId !== 'julia' || document.uri.scheme !== 'file') throw new Error('Choose a saved Julia source file to debug.');
    if (document.isDirty) throw new Error('Save the Julia source before debugging.');
    const relative = path.relative(folder.uri.fsPath, document.uri.fsPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Debug a Julia source file inside the selected PerfChecker folder.');
    await extension.activate();
    const project = resolveControllerProject(folder.uri.fsPath, vscode.workspace.getConfiguration('perfchecker', folder.uri), 'scenarioProject').project;
    return await vscode.debug.startDebugging(folder, {type: 'julia', request: 'launch', name: `PerfChecker · ${path.basename(document.uri.fsPath)}`,
      program: document.uri.fsPath, cwd: folder.uri.fsPath, juliaEnv: project, stopOnEntry: true});
  }
  dispose() {this.pluto.dispose();this.panel?.dispose(); for (const terminal of this.terminals.values()) terminal.dispose();}
}

export function registerStudio(context: vscode.ExtensionContext) {
  const studio = new Studio(context);
  const command = (name: string, callback: (...args: any[]) => unknown) => vscode.commands.registerCommand(name, async (...args) => {
    try {return await callback(...args);} catch (error) {void vscode.window.showErrorMessage(`PerfChecker: ${error}`); throw error;}
  });
  context.subscriptions.push(studio,
    command('perfchecker.openStudio', requested => studio.open(requested)),
    command('perfchecker.openStudioForWorkspace', requested => {
      if (requested === undefined) throw new Error('Pass an open workspace folder or URI to perfchecker.openStudioForWorkspace.');
      return studio.open(requested);
    }),
    command('perfchecker.openTerminal', requested => studio.terminal(requested)),
    command('perfchecker.newNotebook', (requested,options) => studio.newNotebook(requested,options)),
    command('perfchecker.openNotebook', requested => studio.openNotebook(requested)),
    command('perfchecker.stopNotebookSession', requested => studio.stopNotebook(requested)),
    command('perfchecker.debugFile', requested => studio.debugFile(requested)));
}
