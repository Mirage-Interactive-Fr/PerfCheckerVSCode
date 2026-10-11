import * as vscode from 'vscode';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import {cancellableJulia, controllerCancellation} from './controllerCancellation';
import {resolveControllerProject} from './workspace-root';

const active = new Set<{cancel: ReturnType<typeof controllerCancellation>; finished: Promise<void>}>();
class ControllerCancellationFailure extends Error {}
export async function shutdownWorkspaceSetup(): Promise<void> {
  for(const item of active)item.cancel.request();
  await Promise.allSettled([...active].map(item=>item.finished));
}

/** Bootstrap is a visible user action. Merely opening Studio never installs packages. */
export async function prepareWorkspaceController(folder: vscode.WorkspaceFolder, output: vscode.OutputChannel): Promise<boolean> {
  const settings=vscode.workspace.getConfiguration('perfchecker',folder.uri);
  const snapshot=()=>({runnerProject:vscode.workspace.getConfiguration('perfchecker',folder.uri).get('runnerProject','perf'),
    scenarioProject:vscode.workspace.getConfiguration('perfchecker',folder.uri).get('scenarioProject','perf'),
    juliaExecutable:vscode.workspace.getConfiguration('perfchecker',folder.uri).get('juliaExecutable','julia')});
  let expected=snapshot();
  const current=()=>{
    if(!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.some(item=>item.uri.toString()===folder.uri.toString()))
      throw new Error('Open the original trusted workspace before setting up PerfChecker.');
    if(JSON.stringify(snapshot())!==JSON.stringify(expected))throw new Error('The PerfChecker controller settings changed during setup. Your new settings were preserved; start setup again.');
  };
  const verifyCode='using PerfChecker; v"1.1.0" <= Base.pkgversion(PerfChecker) < v"2.0.0" || error("PerfChecker 1.1.0 or newer in the 1.x series is required. Explicitly upgrade this controller environment from General before continuing.")';
  const run=async(project:string,code:string,title:string)=>{
  await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title,cancellable:true},async(_progress,token)=>{
    current();
    if(token.isCancellationRequested)throw new vscode.CancellationError();
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(settings.get('juliaExecutable','julia'),['--startup-file=no','--history-file=no',`--project=${project}`,'-e',cancellableJulia(code)],
        {cwd:folder.uri.fsPath,env:{...process.env,JULIA_LOAD_PATH:['@','@stdlib'].join(path.delimiter)},windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
      const cancel=controllerCancellation(child,message=>output.appendLine(message));
      const finished=new Promise<void>(done=>{child.once('close',done);child.once('error',()=>done());});
      const owned={cancel,finished};active.add(owned);void finished.then(()=>active.delete(owned));
      const subscriptions=[token.onCancellationRequested(()=>cancel.request()),vscode.workspace.onDidChangeWorkspaceFolders(()=>{try{current();}catch{cancel.request();}}),
        vscode.workspace.onDidChangeConfiguration(event=>{if(['runnerProject','scenarioProject','juliaExecutable'].some(key=>event.affectsConfiguration(`perfchecker.${key}`,folder.uri))){try{current();}catch{cancel.request();}}})];
      const timer=setTimeout(()=>cancel.request(),600000);
      child.stdout?.on('data',data=>output.append(data.toString()));child.stderr?.on('data',data=>output.append(data.toString()));
      child.once('error',error=>reject(new Error(`Cannot start Julia (${settings.get('juliaExecutable','julia')}). Install Julia or configure perfchecker.juliaExecutable. ${error.message}`)));
      const cleanup=()=>{clearTimeout(timer);for(const subscription of subscriptions)subscription.dispose();cancel.dispose();};
      child.once('error',cleanup);
      child.once('close',status=>{cleanup();try{current();}catch(error){reject(error);return;}
        if(token.isCancellationRequested&&status!==0&&status!==130){reject(new ControllerCancellationFailure('Controller cancellation failed. Inspect PerfChecker output for cleanup errors; no installation wizard or settings change was performed.'));return;}
        if(token.isCancellationRequested||status===130){reject(new vscode.CancellationError());return;}
        status===0?resolve():reject(new Error('Controller setup did not finish. This integration requires registered PerfChecker 1.1.0 or newer in the 1.x series. Install or upgrade it explicitly in this controller environment; inspect PerfChecker output for the Julia dependency error. No controller setting was changed.'));});
    });
  });
  };
  current();
  try{const selected=resolveControllerProject(folder.uri.fsPath,settings);await run(selected.project,verifyCode,'PerfChecker · Verify controller');return true;}catch(error){if(error instanceof vscode.CancellationError)return false;if(error instanceof ControllerCancellationFailure)throw error;output.appendLine(`Controller prerequisite: ${error}`);current();}

  const choice=await vscode.window.showQuickPick([
    {label:'Create controller environment',description:'Install registered PerfChecker 1.1.0 and collectors in perf/controller.',action:'create'},
    {label:'Use an existing controller',description:'Choose a Julia project containing PerfChecker.',action:'existing'},
    {label:'Read the setup guide',description:'Manual setup, Julia prerequisites and environment configuration.',action:'guide'},
  ],{title:'PerfChecker · Set up this workspace'});
  if(!choice)return false;
  if(choice.action==='guide'){await vscode.env.openExternal(vscode.Uri.parse('https://perfchecker.mirageinteractive.fr/interfaces/vscode.html'));return false;}
  let project=path.join(folder.uri.fsPath,'perf','controller');
  if(choice.action==='existing'){
    const selected=await vscode.window.showOpenDialog({defaultUri:folder.uri,canSelectFolders:true,canSelectFiles:false,canSelectMany:false,title:'PerfChecker · Choose controller project'});
    if(!selected?.length)return false;
    project=selected[0].fsPath;
    if(!await fs.stat(path.join(project,'Project.toml')).then(stat=>stat.isFile()).catch(()=>false))throw new Error('Choose a Julia environment containing Project.toml and PerfChecker.');
  }else{
    const confirmed=await vscode.window.showWarningMessage(`Install PerfChecker 1.1.0, BenchmarkTools, Chairmarks and TestItemRunner in ${project}? This downloads Julia packages from General and creates or updates only that controller environment. Existing package tests also need the package under test and its test dependencies in this environment; they are not installed automatically.`,{modal:true},'Install controller');
    if(confirmed!=='Install controller')return false;
    current();
    // Do not follow a perf symlink out of this workspace during automatic setup.
    const root=await fs.realpath(folder.uri.fsPath);
    let ancestor=project;while(!await fs.stat(ancestor).then(()=>true).catch(()=>false))ancestor=path.dirname(ancestor);
    const relative=path.relative(root,await fs.realpath(ancestor));
    if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error('The controller directory resolves outside this workspace. Choose an existing environment explicitly.');
    await fs.mkdir(project,{recursive:true});
  }
  const existing=choice.action==='existing';
  const code=existing ? verifyCode :
    'using Pkg; Pkg.add(PackageSpec(name="PerfChecker",version="1.1.0")); Pkg.add(["BenchmarkTools","Chairmarks","TestItemRunner"]); using PerfChecker; @assert Base.pkgversion(PerfChecker)==v"1.1.0"';
  try{await run(project,code,existing?'PerfChecker · Verify controller':'PerfChecker · Install controller');}
  catch(error){if(error instanceof vscode.CancellationError)return false;throw error;}
  current();
  const value=path.relative(folder.uri.fsPath,project)||'.';
  await settings.update('runnerProject',value,vscode.ConfigurationTarget.WorkspaceFolder);
  expected={...expected,runnerProject:value};current();
  if(!settings.inspect<string>('scenarioProject')?.workspaceFolderValue && !settings.inspect<string>('scenarioProject')?.workspaceValue && !settings.inspect<string>('scenarioProject')?.globalValue)
    await settings.update('scenarioProject',value,vscode.ConfigurationTarget.WorkspaceFolder);
  return true;
}
