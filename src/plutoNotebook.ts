import * as vscode from 'vscode';
import {spawn, ChildProcess} from 'node:child_process';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import {createServer} from 'node:net';
import {randomBytes, randomUUID} from 'node:crypto';
import {cancellableJulia, controllerCancellation} from './controllerCancellation';
import {currentWorkspaceFolder, selectWorkspaceFolder, resolveControllerProject} from './workspace-root';

const closing = new Set<Promise<void>>();
const managers = new Set<PlutoNotebooks>();
export async function shutdownPlutoSessions(): Promise<void> {
  for (const manager of [...managers]) manager.dispose();
  await Promise.allSettled([...closing]);
}

const installCode = `
using Pkg
Pkg.add(PackageSpec(name="PerfChecker", version="1.0.0"))
Pkg.add([PackageSpec(name="Pluto", version="1.0.4"), PackageSpec(name="PlutoUI"),
    PackageSpec(name="BenchmarkTools"), PackageSpec(name="Chairmarks")])
Pkg.add(PackageSpec(url="https://github.com/Mirage-Interactive-Fr/PerfChecker.jl",
    subdir="packages/PerfCheckerPluto", rev="v1.0.0"))
using PerfChecker, PerfCheckerPluto, Pluto, PlutoUI
`;
const generateCode = `
using PerfChecker, PerfCheckerPluto, Base64
p = PerfChecker.JSON.parse(ENV["PERFCHECKER_PLUTO_ARGUMENTS"])
mktempdir() do directory
    notebook = joinpath(directory, "notebook.jl")
    if p["kind"] == "investigation"
        write_investigation_notebook(notebook; root=p["root"], catalog=p["catalog"], project=p["project"])
        source = read(notebook, String)
        from = "project=" * repr(p["project"]) * ", tools="
        to = "project=" * repr(p["target"]) * ", tools="
        length(findall(from, source)) == 1 || error("Unsupported investigation notebook generator: target project binding changed.")
        source = replace(source, from => to; count=1)
    else
        write_suite_notebook(notebook; suite_path=p["suite"], factory=Symbol(p["factory"]),
            profile=Symbol(p["profile"]), project=p["project"], reports_root=p["reports"], result_path=p["result"])
        source = read(notebook, String)
    end
    PerfChecker.JuliaSyntax.parseall(PerfChecker.JuliaSyntax.SyntaxNode, source)
    println("PERFCHECKER_PLUTO_NOTEBOOK ", base64encode(source))
end
`;
const environmentCode = `
using PerfChecker, PerfCheckerPluto, Pluto, PlutoUI
println("Detected PerfChecker ", Base.pkgversion(PerfChecker), "; Pluto ", Base.pkgversion(Pluto))
v"1.0.0" <= Base.pkgversion(PerfChecker) < v"2.0.0" || error("This integration requires PerfChecker 1.x.")
Base.pkgversion(Pluto) == v"1.0.4" || error("This integration currently qualifies Pluto 1.0.4. Explicitly update the separate Pluto environment to use it.")
isdefined(Pluto, :ServerSession) && isdefined(Pluto, :run!) || error("Pluto server API is unavailable.")
hasmethod(PerfChecker.write_suite_notebook, Tuple{AbstractString}) || error("PerfChecker Pluto companion is unavailable.")
`;
const serverCode = `
using Logging
Logging.global_logger(Logging.NullLogger()) # Pluto's startup URL contains the session secret.
using Pluto
p = parse(Int, ENV["PERFCHECKER_PLUTO_PORT"])
options = Pluto.Configuration.from_flat_kwargs(host="127.0.0.1", port=p,
    launch_browser=false, notebook=ENV["PERFCHECKER_PLUTO_NOTEBOOK"],
    require_secret_for_access=true, require_secret_for_open_links=true,
    auto_reload_from_file=false, threads=1)
session = Pluto.ServerSession(options=options, secret=ENV["PERFCHECKER_PLUTO_SECRET"])
server = nothing
try
    server = Pluto.run!(session)
    notebook = only(values(session.notebooks))
    println("PERFCHECKER_PLUTO_READY ", p, " ", notebook.notebook_id)
    flush(stdout)
    wait(server)
finally
    server === nothing || close(server)
end
`;

interface Session {
  folder: vscode.WorkspaceFolder; notebook: string; project: string; panel: vscode.WebviewPanel;
  child?: ChildProcess; cancel?: ReturnType<typeof controllerCancellation>;
  stopped?: Promise<void>; starting?: Promise<void>; disposed: boolean;
}

async function contained(root: string, file: string): Promise<void> {
  const rootPath = await fs.realpath(root);
  let parent = file;
  while (!await fs.stat(parent).then(() => true).catch(() => false)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error('Choose a file inside the selected workspace.');
    parent = next;
  }
  const real = await fs.realpath(parent), relative = path.relative(rootPath, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('Choose a Pluto notebook or a new environment inside the selected workspace.');
}
async function canonical(file: string): Promise<string> {
  let ancestor=file;
  while(!await fs.stat(ancestor).then(()=>true).catch(()=>false))ancestor=path.dirname(ancestor);
  const resolved=path.join(await fs.realpath(ancestor),path.relative(ancestor,file));
  return process.platform==='win32'?resolved.toLowerCase():resolved;
}
const html = (text: string) => text.replace(/[&<>"']/g, value => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[value]!));

/** Each notebook owns its loopback server and workers. Opening is never a measurement request. */
export class PlutoNotebooks implements vscode.Disposable {
  private sessions = new Map<string, Session>();
  private setups = new Map<ChildProcess, {cancel: ReturnType<typeof controllerCancellation>; finished: Promise<void>}>();
  private disposed = false;
  private output: vscode.OutputChannel;
  constructor(private context: vscode.ExtensionContext) {
    managers.add(this);
    this.output = vscode.window.createOutputChannel('PerfChecker Pluto');
    context.subscriptions.push(this.output);
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      for (const session of this.sessions.values()) {
        if (!vscode.workspace.workspaceFolders?.some(folder => folder.uri.toString() === session.folder.uri.toString())) session.panel.dispose();
      }
    }));
  }
  private selected(requested?: vscode.Uri | vscode.WorkspaceFolder): {folder: vscode.WorkspaceFolder; file?: vscode.Uri} {
    if (requested && !('uri' in requested) && requested.scheme === 'file' &&
        !vscode.workspace.workspaceFolders?.some(folder => folder.uri.toString() === requested.toString())) {
      const folder = vscode.workspace.getWorkspaceFolder(requested);
      if (!folder) throw new Error('Choose a Pluto notebook inside an open workspace.');
      return {folder:this.folder(folder),file:requested};
    }
    return {folder:this.folder(requested)};
  }
  private folder(requested?: vscode.Uri | vscode.WorkspaceFolder) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before opening an executable Pluto notebook.');
    return requested === undefined ? currentWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders) :
      selectWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders, requested);
  }
  private assertCurrent(folder: vscode.WorkspaceFolder, project: string) {
    if (this.disposed || !vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.some(item => item.uri.toString() === folder.uri.toString()))
      throw new Error('The workspace was closed or its trust changed. Start the Pluto action again.');
    if (this.project(folder) !== project) throw new Error('The Pluto environment changed. Start the action again.');
  }
  private project(folder: vscode.WorkspaceFolder) {
    return path.resolve(folder.uri.fsPath, vscode.workspace.getConfiguration('perfchecker', folder.uri).get('plutoProject', 'perf/pluto'));
  }
  private async command(folder: vscode.WorkspaceFolder, project: string, code: string, title: string,
      environment: Record<string, string> = {}, capture = false): Promise<string> {
    return await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title, cancellable: true}, async (_progress, token) => {
      this.assertCurrent(folder, project);
      const executable = vscode.workspace.getConfiguration('perfchecker', folder.uri).get('juliaExecutable', 'julia');
      let text = '';
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, ['--startup-file=no', '--history-file=no', `--project=${project}`, '-e', cancellableJulia(code)],
          {cwd: folder.uri.fsPath, env: {...process.env, ...environment}, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe']});
        const cancel = controllerCancellation(child, message => this.output.appendLine(message));
        const finished = new Promise<void>(done => {child.once('close',done);child.once('error',()=>done());});
        this.setups.set(child,{cancel,finished});closing.add(finished);
        void finished.then(()=>{this.setups.delete(child);closing.delete(finished);});
        const subscription = token.onCancellationRequested(() => cancel.request());
        const timeout = setTimeout(() => cancel.request(), 600000);
        child.stdout?.on('data', data => {if(capture){text += data.toString();if(text.length>2000000){cancel.request();reject(new Error('Generated Pluto notebook exceeded 2 MB.'));}}
          else this.output.append(data.toString());});
        child.stderr?.on('data', data => this.output.append(data.toString()));
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(token.isCancellationRequested ?
          'Pluto setup cancelled after worker cleanup.' : 'Pluto setup failed. Inspect the PerfChecker Pluto output for the missing dependency or Julia error.')));
        child.once('close', () => {clearTimeout(timeout); subscription.dispose(); cancel.dispose();});
      });
      this.assertCurrent(folder, project);
      return text;
    });
  }
  private async ensureEnvironment(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    const project = this.project(folder);
    const exists = await fs.stat(path.join(project, 'Project.toml')).then(stat => stat.isFile()).catch(() => false);
    if (exists) {
      try {
        await this.command(folder, project, environmentCode, 'PerfChecker · Check Pluto environment');
        return project;
      } catch (error) {
        if (String(error).includes('cancelled')) throw error;
      }
    }
    const choice = await vscode.window.showWarningMessage(
      `Pluto needs its own Julia environment at ${project}. Install PerfChecker 1.0.0, Pluto 1.0.4, PlutoUI and the official Pluto companion there? This downloads packages and updates that environment. Your MCP controller stays separate.`,
      {modal: true}, 'Install Pluto environment', 'Open setup guide');
    if (choice === 'Open setup guide') {
      await vscode.env.openExternal(vscode.Uri.parse('https://perfchecker.mirageinteractive.fr/interfaces/repl-pluto.html')); return;
    }
    if (choice !== 'Install Pluto environment') return;
    this.assertCurrent(folder, project);
    const settings=vscode.workspace.getConfiguration('perfchecker',folder.uri), selected=await canonical(project);
    for(const key of ['runnerProject','scenarioProject'] as const){
      let controller=path.resolve(folder.uri.fsPath,settings.get(key,'perf'));
      try{controller=resolveControllerProject(folder.uri.fsPath,settings,key).project;}catch{/* Compare the configured path even if it is not prepared yet. */}
      if(selected===await canonical(controller))throw new Error('The Pluto environment must be separate from the measurement/MCP controller before installing stable Pluto. Set perfchecker.plutoProject to perf/pluto or another separate project.');
    }
    await contained(folder.uri.fsPath, project);
    await fs.mkdir(project, {recursive: true});
    await this.command(folder, project, installCode + environmentCode, 'PerfChecker · Install separate Pluto environment');
    return project;
  }
  async create(requested?: vscode.Uri | vscode.WorkspaceFolder, options?: {kind: 'suite' | 'investigation'}): Promise<vscode.Uri | undefined> {
    const {folder,file} = this.selected(requested);
    const notebook = file ?? await vscode.window.showSaveDialog({defaultUri: vscode.Uri.file(path.join(folder.uri.fsPath, 'perf','notebooks','performance.jl')),
      filters: {'Pluto notebook': ['jl']}, title: 'PerfChecker · Create Pluto notebook'});
    if (!notebook) return;
    await contained(folder.uri.fsPath, notebook.fsPath);
    if (!notebook.fsPath.endsWith('.jl')) throw new Error('Save a Pluto notebook with the .jl extension.');
    if (await fs.stat(notebook.fsPath).then(() => true).catch(() => false)) throw new Error('This notebook already exists. Use Open Pluto notebook to keep its cells.');
    if (options && !['suite','investigation'].includes(options.kind)) throw new Error('Choose a suite or investigation Pluto dashboard.');
    const kind = options ? {notebookKind:options.kind} : await vscode.window.showQuickPick([{label:'Feature suite', description:'Select checks, run, cancel and save real reports.', notebookKind:'suite'},
      {label:'Investigation', description:'Discover scenarios, diagnose and compare measurements.', notebookKind:'investigation'}], {title:'PerfChecker · Pluto dashboard'});
    if (!kind) return;
    const project = await this.ensureEnvironment(folder); if (!project) return;
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    const suite = path.resolve(folder.uri.fsPath, settings.get('suite', 'perf/suite.jl'));
    const suiteExists = await fs.stat(suite).then(stat => stat.isFile()).catch(() => false);
    const reports = path.resolve(folder.uri.fsPath, settings.get('reports', 'perf/results/vscode'));
    const target = kind.notebookKind === 'investigation' ? resolveControllerProject(folder.uri.fsPath,settings,'scenarioProject').project : project;
    await fs.mkdir(path.dirname(notebook.fsPath), {recursive: true});
    const generated = await this.command(folder, project, generateCode, 'PerfChecker · Write Pluto dashboard', {PERFCHECKER_PLUTO_ARGUMENTS: JSON.stringify({
      kind: kind.notebookKind, notebook: notebook.fsPath, root: folder.uri.fsPath, catalog: path.resolve(folder.uri.fsPath, settings.get('scenarioCatalog','perf/scenarios.toml')),
      suite: suiteExists ? suite : null, factory: settings.get('factory','build_suite'), profile: settings.get('profile','quick'),
      reports, result: path.join(reports,'suite-result.json'), project,target})},true);
    const encoded = /^PERFCHECKER_PLUTO_NOTEBOOK ([A-Za-z0-9+/=]+)$/m.exec(generated)?.[1];
    if(!encoded)throw new Error('The Pluto generator did not return a native notebook. Inspect the PerfChecker Pluto output.');
    this.assertCurrent(folder,project);
    await contained(folder.uri.fsPath,notebook.fsPath);
    await fs.writeFile(notebook.fsPath,Buffer.from(encoded,'base64'),{flag:'wx'});
    return await this.openFile(folder, notebook.fsPath, project);
  }
  async open(requested?: vscode.Uri | vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
    const {folder,file} = this.selected(requested);
    const chosen = file ? [file] : await vscode.window.showOpenDialog({defaultUri: vscode.Uri.file(path.join(folder.uri.fsPath,'perf','notebooks')),
      canSelectMany:false, filters:{'Pluto notebook':['jl']}, title:'PerfChecker · Open Pluto notebook'});
    if (!chosen?.length) return;
    await contained(folder.uri.fsPath, chosen[0].fsPath);
    if (!(await fs.readFile(chosen[0].fsPath,'utf8')).startsWith('### A Pluto.jl notebook ###'))
      throw new Error('Choose a Pluto .jl notebook. Julia source files can be opened normally in the editor.');
    const project = await this.ensureEnvironment(folder); if (!project) return;
    return await this.openFile(folder, chosen[0].fsPath, project);
  }
  private async openFile(folder: vscode.WorkspaceFolder, notebook: string, project: string): Promise<vscode.Uri> {
    this.assertCurrent(folder, project);
    const key = `${folder.uri.toString()}\n${notebook}`;
    let session = this.sessions.get(key);
    if (session) {session.panel.reveal(); await session.starting; return vscode.Uri.file(notebook);}
    const panel = vscode.window.createWebviewPanel('perfchecker.pluto', `Pluto · ${path.basename(notebook)}`, vscode.ViewColumn.One,
      {enableScripts:true, retainContextWhenHidden:true, localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'media')]});
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri,'media','perfchecker.svg');
    session = {folder,notebook,project,panel,disposed:false}; this.sessions.set(key,session);
    const owned = session;
    panel.onDidDispose(() => {owned.disposed = true; if (this.sessions.get(key) === owned) this.sessions.delete(key); void this.stop(owned);});
    panel.webview.onDidReceiveMessage(async message => {
      try {
        this.assertCurrent(folder, project);
        if (message?.type === 'plutoSource') await vscode.window.showTextDocument(vscode.Uri.file(notebook));
        else if (message?.type === 'plutoStop') {await this.stop(owned); if (!owned.disposed) this.render(owned, undefined, 'Session stopped. Notebook cells and saved reports remain on disk.');}
        else if (message?.type === 'plutoRestart' && !owned.starting) {owned.starting = (async()=>{await this.stop(owned);await this.start(owned);})(); try {await owned.starting;} finally {owned.starting = undefined;}}
      } catch (error) {if (!owned.disposed) this.render(owned,undefined,String(error));}
    }, undefined, this.context.subscriptions);
    owned.starting = this.start(owned);
    try {await owned.starting;} catch (error) {await this.stop(owned); if (!owned.disposed) this.render(owned,undefined,String(error)); throw error;}
    finally {owned.starting = undefined;}
    return vscode.Uri.file(notebook);
  }
  private async start(session: Session): Promise<void> {
    await session.stopped;
    if (session.disposed) throw new Error('The Pluto view was closed.');
    this.assertCurrent(session.folder,session.project);
    this.render(session,undefined,'Starting Pluto. Opening and changing selectors do not launch measurements.');
    const port = await new Promise<number>((resolve,reject) => {
      const reservation = createServer(); reservation.once('error',reject);
      reservation.listen(0,'127.0.0.1',() => {const address=reservation.address(); const value=typeof address==='object' && address ? address.port : 0;
        reservation.close(error => error ? reject(error) : resolve(value));});
    });
    if (session.disposed) throw new Error('The Pluto view was closed.');
    this.assertCurrent(session.folder,session.project);
    const secret = randomBytes(32).toString('hex');
    const child = spawn(vscode.workspace.getConfiguration('perfchecker',session.folder.uri).get('juliaExecutable','julia'),
      ['--startup-file=no','--history-file=no',`--project=${session.project}`,'-e',cancellableJulia(serverCode)],
      {cwd:session.folder.uri.fsPath, windowsHide:true, detached:process.platform!=='win32', stdio:['pipe','pipe','pipe'],
        env:{...process.env, PERFCHECKER_PLUTO_SECRET:secret, PERFCHECKER_PLUTO_PORT:String(port), PERFCHECKER_PLUTO_NOTEBOOK:session.notebook}});
    const redact = (line: string) => line.replaceAll(secret,'[session secret]').replace(/([?&]secret=)[^&\s"'<>]*/gi,'$1[session secret]');
    let errors = '';
    child.stderr?.on('data',data=>{
      errors += data.toString();
      for(let newline;(newline=errors.indexOf('\n'))>=0;){this.output.appendLine(redact(errors.slice(0,newline)));errors=errors.slice(newline+1);}
      if(errors.length>65536) {this.output.appendLine('Pluto emitted an oversized diagnostic line; omitted.');errors='';}
    });
    child.stderr?.once('end',()=>{if(errors)this.output.appendLine(redact(errors));});
    session.child=child; const cancel=controllerCancellation(child,message=>this.output.appendLine(message));session.cancel=cancel;
    const exited = new Promise<void>(resolve => {child.once('close',()=>resolve()); child.once('error',()=>resolve());});
    const startup = new Promise<string>((resolve,reject) => {
      let pending = '';
      const timer = setTimeout(()=>{reject(new Error('Pluto did not become ready. Inspect PerfChecker Pluto output, then restart the session.')); session.cancel?.request();},180000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);reject(new Error(`Pluto stopped before opening (exit ${code}). Inspect PerfChecker Pluto output.`));});
      child.stdout?.on('data',data=>{
        pending += data.toString();
        for (let newline; (newline=pending.indexOf('\n'))>=0;) {
          const line=pending.slice(0,newline).replace(/\r$/,''); pending=pending.slice(newline+1);
          const ready=/^PERFCHECKER_PLUTO_READY (\d+) ([a-f0-9-]{36})$/.exec(line);
          if (ready) {clearTimeout(timer); if(Number(ready[1])!==port) reject(new Error('Pluto reported an unexpected port.')); else resolve(ready[2]);}
          else this.output.appendLine(redact(line));
        }
        if(pending.length>65536) {this.output.appendLine('Pluto emitted an oversized diagnostic line; omitted.');pending='';}
      });
    });
    session.stopped = exited;
    child.once('close',()=>{cancel.dispose(); if(session.child===child){session.child=undefined;session.cancel=undefined;
      if(!session.disposed)this.render(session,undefined,'Pluto session stopped. Use Restart session to reopen the saved notebook.');}});
    const id = await startup;
    this.assertCurrent(session.folder,session.project);
    if(session.disposed) {session.cancel?.request(); return;}
    let uri: vscode.Uri;
    try {uri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}/edit?id=${id}&secret=${secret}`));}
    catch(error) {throw new Error(redact(`The remote Pluto port could not be forwarded: ${error}`));}
    session.panel.webview.options={...session.panel.webview.options,portMapping:[{webviewPort:port,extensionHostPort:port}]};
    this.render(session,uri);
  }
  private render(session: Session, uri?: vscode.Uri, status='') {
    const nonce=randomUUID(), origin=uri ? new URL(uri.toString()).origin : 'http://127.0.0.1';
    const source=uri ? `<iframe class="perfchecker-pluto-frame" title="Interactive Pluto notebook" src="${html(uri.toString())}" allow="clipboard-read; clipboard-write"></iframe>` : `<div class="status" role="status">${html(status)}</div>`;
    session.panel.webview.html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${html(origin)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">html,body{height:100%;margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)}body{display:flex;flex-direction:column}header{display:flex;gap:12px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border)}header strong{margin-right:auto}button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:6px 10px;cursor:pointer}.perfchecker-pluto-frame{flex:1;width:100%;border:0}.status{padding:24px;line-height:1.6}</style><title>PerfChecker Pluto</title></head><body><header><strong>PerfChecker · Pluto</strong><span>Run checks explicitly · notebook saved as .jl</span><button id="pluto-source">Open source</button><button id="pluto-stop">Stop session</button><button id="pluto-restart">Restart session</button></header>${source}<script nonce="${nonce}">const api=acquireVsCodeApi();for(const [id,type]of [['pluto-source','plutoSource'],['pluto-stop','plutoStop'],['pluto-restart','plutoRestart']])document.getElementById(id).addEventListener('click',()=>api.postMessage({type}));</script></body></html>`;
  }
  private async stop(session: Session): Promise<void> {
    const promise=session.stopped;
    if(!promise) return;
    closing.add(promise); session.cancel?.request();
    try {await promise;} finally {closing.delete(promise);}
  }
  async stopWorkspace(requested?: vscode.Uri | vscode.WorkspaceFolder): Promise<void> {
    const folder=requested === undefined ? currentWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders) :
      selectWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders,requested);
    await Promise.all([...this.sessions.values()].filter(session=>session.folder.uri.toString()===folder.uri.toString()).map(session=>this.stop(session)));
  }
  dispose(): void {this.disposed=true;managers.delete(this);for(const setup of this.setups.values())setup.cancel.request();
    for(const session of this.sessions.values()) {session.disposed=true;void this.stop(session);session.panel.dispose();}this.sessions.clear();}
}
