// Real workbench buttons, Julia processes and resource-scoped settings in disposable CI.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {clickStudioAction}=require('./native-studio-controls.cjs');

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(read,description,timeout=180000){
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){try{const value=await read();if(value)return value;}catch(error){last=error;}await delay(150);}
  throw new Error(`${description}${last?`: ${last.message}`:''}`);
}
async function repl(context){
  const {vscode,workspace,controller,windowPage}=context;
  const before=new Set(vscode.window.terminals);
  await clickStudioAction(context,'julia');
  const terminal=await eventually(()=>vscode.window.terminals.find(item=>!before.has(item)&&/Julia/i.test(item.name))||vscode.window.terminals.find(item=>/Julia/i.test(item.name)),'The Studio REPL button starts the official Julia terminal');
  const marker=path.join(workspace,'julia-repl-version.txt');
  terminal.sendText(`using Pkg; Pkg.activate(${JSON.stringify(controller)}); using PerfChecker; write(${JSON.stringify(marker)}, string(Base.pkgversion(PerfChecker)))`);
  await eventually(async()=>await fs.readFile(marker,'utf8')===context.coreVersion,'The official Julia REPL evaluates code in the qualified controller');
  await vscode.commands.executeCommand('language-julia.stopREPL');
  context.log('official-julia-repl',{nativeStudioClick:true,controller,core:context.core});
}
async function debug(context){
  const {vscode,workspace,windowPage}=context;
  const marker=path.join(workspace,'native-debug-version.txt');
  const program=path.join(workspace,'perf','native-debug.jl');
  await fs.writeFile(program,`using PerfChecker\nwrite(${JSON.stringify(marker)}, string(Base.pkgversion(PerfChecker)))\n`);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(program)));
  let stopped=false,terminated=false,session;
  const tracker=vscode.debug.registerDebugAdapterTrackerFactory('julia',{createDebugAdapterTracker(current){
    if(current.configuration.program!==program)return undefined;session=current;
    return {onDidSendMessage(message){if(message.type==='event'&&message.event==='stopped')stopped=true;if(message.type==='event'&&message.event==='terminated')terminated=true;}};
  }});
  try{
    await clickStudioAction(context,'debug');
    await eventually(()=>stopped,'The Studio debugger uses the real Julia debug adapter and stops on entry',240000);
    assert.equal(session.configuration.juliaEnv,context.controller);
    const button=windowPage.locator('.debug-toolbar .action-label[title^="Continue"],.debug-toolbar .action-label[aria-label^="Continue"]').first();
    await button.click();
    await eventually(async()=>await fs.readFile(marker,'utf8')===context.coreVersion,'The actual Continue button executes the saved Julia file in the selected controller',240000);
    await eventually(()=>terminated||!vscode.debug.activeDebugSession,'The Julia debug session terminates after execution');
    context.log('official-julia-debug',{nativeStudioClick:true,nativeContinueClick:true,stopOnEntry:true,core:context.core});
  }finally{tracker.dispose();if(session&&!terminated)await vscode.debug.stopDebugging(session);}
}
async function tasks(context){
  const {vscode,workspace,windowPage}=context;
  const marker=path.join(workspace,'native-task-version.txt');
  const file=path.join(workspace,'.vscode','tasks.json');
  const previous=await fs.readFile(file).catch(()=>undefined);
  try{
    await fs.writeFile(file,JSON.stringify({version:'2.0.0',tasks:[{label:'PerfChecker native fixture',type:'process',command:process.env.PERFCHECKER_NATIVE_JULIA,args:['--startup-file=no',`--project=${context.controller}`,'-e',`using PerfChecker;write(${JSON.stringify(marker)},string(Base.pkgversion(PerfChecker)))`],problemMatcher:[]}]}));
    await clickStudioAction(context,'tasks');
    const picker=windowPage.locator('.quick-input-widget');await picker.waitFor({state:'visible'});
    await picker.locator('.monaco-list-row').filter({hasText:'PerfChecker native fixture'}).first().click();
    // VS Code may ask for the problem-matcher choice even for an explicitly empty matcher.
    await delay(300);
    const noMatcher=picker.locator('.monaco-list-row').filter({hasText:'Continue without scanning the task output'});
    if(await noMatcher.isVisible().catch(()=>false))await noMatcher.click();
    await eventually(async()=>await fs.readFile(marker,'utf8')===context.coreVersion,'The Project tasks button runs the real Julia task');
    context.log('project-task',{nativeStudioClick:true,core:context.core});
  }finally{if(previous)await fs.writeFile(file,previous);else await fs.rm(file,{force:true});}
}
async function multiRoot(context){
  const {vscode,workspace}=context;
  const second=path.join(path.dirname(workspace),'workspace-second');
  await fs.mkdir(path.join(second,'perf'),{recursive:true});
  await fs.writeFile(path.join(second,'Project.toml'),'name="SecondNativeFixture"\nuuid="1904c3c1-3d82-4801-94ca-c7c628ec22d1"\nversion="0.1.0"\n');
  const added=vscode.workspace.onDidChangeWorkspaceFolders;
  const changed=new Promise(resolve=>{const disposable=added(event=>{if(event.added.some(folder=>folder.uri.fsPath===second)){disposable.dispose();resolve();}});});
  assert(vscode.workspace.updateWorkspaceFolders(1,0,{uri:vscode.Uri.file(second),name:'Second native workspace'}));
  await changed;
  const uri=vscode.Uri.file(second);
  try{
    const settings=vscode.workspace.getConfiguration('perfchecker',uri);
    await settings.update('runnerProject',context.controller,vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('juliaExecutable',process.env.PERFCHECKER_NATIVE_JULIA,vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',uri);
    const studio=await context.findFrame('#studio-root');
    assert((await studio.locator('details.environment').innerText()).includes('Second native workspace'));
    await clickStudioAction({...context,workspace:second},'terminal');
    const terminal=await eventually(()=>vscode.window.terminals.find(item=>item.name==='PerfChecker · Second native workspace'),'Studio routes its terminal to the explicitly selected second folder');
    const marker=path.join(second,'terminal-version.txt');
    terminal.sendText(`using PerfChecker;write(${JSON.stringify(marker)}, string(Base.pkgversion(PerfChecker)))`);
    await eventually(async()=>await fs.readFile(marker,'utf8')===context.coreVersion,'Second-folder terminal uses its own resource controller');
    terminal.dispose();
    assert.equal(vscode.workspace.getConfiguration('perfchecker',vscode.Uri.file(workspace)).get('runnerProject'),context.controller);
    await assert.rejects(vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(path.join(second,'outside'))),/not an open workspace folder/);
    context.log('multi-root-explicit-routing',{folders:2,nativeStudioClick:true,firstResourcePreserved:true});
  }finally{
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(workspace));
    const index=vscode.workspace.workspaceFolders.findIndex(folder=>folder.uri.fsPath===second);
    if(index>=0)vscode.workspace.updateWorkspaceFolders(index,1);
  }
}
async function landscape(context){
  const {vscode,workspace}=context,uri=vscode.Uri.file(workspace);
  await assert.rejects(vscode.commands.executeCommand('perfchecker.runLandscapeLiveForWorkspace',uri),/valid render quality slug/);
  await assert.rejects(vscode.commands.executeCommand('perfchecker.runLandscapeLiveForWorkspace',uri,'desktop-natif'),/EtenduGame\.toml|Beautiful Landscape.*contract/);
  context.log('landscape-live-prerequisite',{status:'prerequisite',command:'perfchecker.runLandscapeLiveForWorkspace',reason:'The disposable package is not an Étendue Beautiful Landscape workspace; its game manifest, quality profiles, live provider and physical GPU are absent.',gpuRenderingValidated:false});
}
exports.run=async context=>{
  assert.equal(process.env.CI,'true');const failures=[];
  for(const [name,run]of[['julia-repl',repl],['julia-debug',debug],['project-tasks',tasks],['multi-root',multiRoot],['landscape-prerequisite',landscape]]){
    try{await run(context);}catch(error){failures.push(error);context.log(`${name}-failure`,{message:String(error),stack:error.stack});}
  }
  if(failures.length)throw new AggregateError(failures,'Native workbench controls failed; remaining groups were still attempted');
};
