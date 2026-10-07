// Real workbench buttons, Julia processes and resource-scoped settings in disposable CI.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {clickStudioAction}=require('./native-studio-controls.cjs');

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class DebugExecutionFailed extends Error {}
async function eventually(read,description,timeout=180000){
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){try{const value=await read();if(value)return value;}catch(error){if(error instanceof DebugExecutionFailed)throw error;last=error;}await delay(150);}
  throw new Error(`${description}${last?`: ${last.message}`:''}`);
}
async function existingController(context){
  const {vscode,workspace,controller,windowPage}=context;
  const uri=vscode.Uri.file(workspace),settings=vscode.workspace.getConfiguration('perfchecker',uri);
  const files=vscode.workspace.getConfiguration('files',uri),oldDialog=files.inspect('simpleDialog.enable')?.globalValue;
  const previous=settings.inspect('runnerProject')?.workspaceFolderValue;
  try{
    await files.update('simpleDialog.enable',true,vscode.ConfigurationTarget.Global);
    await settings.update('runnerProject','perf/not-installed-controller',vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',uri);
    let frame=await context.findFrame('#setup-workspace');
    await frame.locator('#setup-workspace').click();
    const picker=windowPage.locator('.quick-input-widget');await picker.waitFor({state:'visible',timeout:60000});
    for(const name of ['Create controller environment','Use an existing controller','Read the setup guide'])
      assert(await picker.locator('.monaco-list-row').filter({hasText:name}).isVisible());
    if(process.env.PERFCHECKER_NATIVE_VIDEO==='1')await delay(2500);
    await picker.locator('.monaco-list-row').filter({hasText:'Use an existing controller'}).click();
    const input=picker.locator('input[type="text"]');await input.fill(controller+path.sep);await delay(300);await input.press('Enter');
    await eventually(()=>vscode.Uri.file(path.resolve(workspace,settings.get('runnerProject'))).fsPath===vscode.Uri.file(controller).fsPath,
      'The real controller chooser verifies the existing Core environment and saves its selected path',180000);
    frame=await context.findFrame('#studio-root');
    const environment=frame.locator('details.environment');
    if(await environment.getAttribute('open')===null)await environment.locator('summary').click();
    await eventually(async()=>(await environment.innerText()).includes(controller),'Studio displays the selected controller');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    if(process.env.PERFCHECKER_NATIVE_VIDEO==='1')await delay(3000);
    context.proof('bootstrap-existing-controller',{nativeStudioClick:true,realChooser:true,selectionVerified:true,core:context.core,
      installerNotInvoked:true,registeredBootstrapQualified:false,minimum:'1.0.1',controller});
  }finally{await settings.update('runnerProject',previous,vscode.ConfigurationTarget.WorkspaceFolder);await files.update('simpleDialog.enable',oldDialog,vscode.ConfigurationTarget.Global);}
}
async function repl(context){
  const {vscode,workspace,controller,windowPage}=context;
  const before=new Set(vscode.window.terminals);
  await clickStudioAction(context,'julia');
  const terminal=await eventually(()=>vscode.window.terminals.find(item=>!before.has(item)&&/Julia/i.test(item.name))||vscode.window.terminals.find(item=>/Julia/i.test(item.name)),'The Studio REPL button starts the official Julia terminal');
  const marker=path.join(workspace,'julia-repl-version.txt');
  terminal.sendText(`using Pkg; Pkg.activate(${JSON.stringify(controller)}); using PerfChecker; println("Julia ",VERSION," · PerfChecker ",Base.pkgversion(PerfChecker)); println("Active project: ",Base.active_project()); write(${JSON.stringify(marker)}, string(Base.pkgversion(PerfChecker))*"\\n"*string(VERSION)*"\\n"*Base.active_project())`);
  await eventually(async()=>{
    const [coreVersion,juliaVersion,activeProject]=(await fs.readFile(marker,'utf8')).split('\n');
    return coreVersion===context.coreVersion&&juliaVersion===process.env.PERFCHECKER_NATIVE_OFFICIAL_JULIA_VERSION&&
      activeProject&&vscode.Uri.file(activeProject).fsPath===vscode.Uri.file(path.join(controller,'Project.toml')).fsPath;
  },'The official Julia REPL evaluates code with its documented runtime in the explicitly activated controller');
  if(process.env.PERFCHECKER_NATIVE_VIDEO==='1')await delay(3000);
  await vscode.commands.executeCommand('language-julia.stopREPL');
  context.proof('official-julia-repl',{nativeStudioClick:true,explicitTestActivation:true,activeProjectVerified:true,controller,core:context.core,julia:process.env.PERFCHECKER_NATIVE_OFFICIAL_JULIA_VERSION,runnerJulia:process.env.PERFCHECKER_NATIVE_JULIA_VERSION});
}
async function debug(context){
  const {vscode,workspace,windowPage}=context;
  const marker=path.join(workspace,'native-debug-version.txt');
  await fs.rm(marker,{force:true});
  const program=path.join(workspace,'perf','native-debug.jl');
  await fs.writeFile(program,`include(${JSON.stringify(path.join(workspace,'src','PerfCheckerNativeFixture.jl'))})\nusing .PerfCheckerNativeFixture\nvalue=PerfCheckerNativeFixture.sum_squares(collect(1.0:1000.0))\nwrite(${JSON.stringify(marker+'.pending')},string(VERSION)*"\\n"*Base.active_project()*"\\n"*string(value))\nmv(${JSON.stringify(marker+'.pending')},${JSON.stringify(marker)};force=true)\n`);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(program)));
  let stopped=false,terminated=false,session,primaryError;
  const protocol=[];
  const tracker=vscode.debug.registerDebugAdapterTrackerFactory('julia',{createDebugAdapterTracker(current){
    if(typeof current.configuration.program!=='string'||vscode.Uri.file(current.configuration.program).fsPath!==vscode.Uri.file(program).fsPath)return undefined;session=current;
    return {onDidSendMessage(message){
      if(message.type==='event'&&['stopped','terminated','output','exited'].includes(message.event)){
        protocol.push({event:message.event,body:message.body});if(protocol.length>30)protocol.shift();
      }
      if(message.type==='event'&&message.event==='stopped')stopped=true;if(message.type==='event'&&message.event==='terminated')terminated=true;
    }};
  }});
  try{
    await clickStudioAction(context,'debug');
    await eventually(()=>stopped,'The Studio debugger uses the real Julia debug adapter and stops on entry',240000);
    assert.equal(vscode.Uri.file(session.configuration.project).fsPath,vscode.Uri.file(context.controller).fsPath);
    const button=windowPage.locator('.debug-toolbar .action-label[title^="Continue"],.debug-toolbar .action-label[aria-label^="Continue"]').first();
    await button.click();
    await eventually(async()=>{
      if(terminated&&!await fs.stat(marker).then(()=>true).catch(()=>false))throw new DebugExecutionFailed(`The real Julia adapter terminated without the program marker: ${JSON.stringify(protocol).slice(-6000)}`);
      const lines=(await fs.readFile(marker,'utf8')).split('\n');
      try {
        assert.equal(lines[0],process.env.PERFCHECKER_NATIVE_OFFICIAL_JULIA_VERSION);
        assert.equal(vscode.Uri.file(lines[1]).fsPath,vscode.Uri.file(path.join(context.controller,'Project.toml')).fsPath);
        assert.equal(Number(lines[2]),333833500);
      } catch(error) {throw new DebugExecutionFailed(`The executed debugger marker diverges from its requested runtime/controller/oracle: ${error.message}`);}
      return true;
    },'The actual Continue button executes the saved Julia file in the selected controller',240000);
    await eventually(()=>terminated||!vscode.debug.activeDebugSession,'The Julia debug session terminates after execution');
    context.proof('official-julia-debug',{nativeStudioClick:true,nativeContinueClick:true,stopOnEntry:true,controller:context.controller,workspace:path.basename(workspace),julia:process.env.PERFCHECKER_NATIVE_OFFICIAL_JULIA_VERSION,targetSourceExecuted:true,activeProjectVerified:true,coreImportUnderInterpreter:false});
  }catch(error){primaryError=error;context.log('julia-debug-protocol',{events:protocol,error:String(error)});throw error;}
  finally{
    tracker.dispose();
    if(session&&!terminated&&vscode.debug.activeDebugSession?.id===session.id){
      try{await vscode.debug.stopDebugging(session);}catch(error){
        if(primaryError)throw new AggregateError([primaryError,error],'Debug validation failed and its teardown also reported an error');
        throw error;
      }
    }
    await fs.rm(marker+'.pending',{force:true});
  }
}
async function tasks(context){
  const {vscode,workspace,windowPage}=context;
  const marker=path.join(workspace,'native-task-version.txt');
  const file=path.join(workspace,'.vscode','tasks.json');
  const previous=await fs.readFile(file).catch(()=>undefined);
  try{
    await fs.writeFile(file,JSON.stringify({version:'2.0.0',tasks:[{label:'PerfChecker native fixture',type:'process',command:process.env.PERFCHECKER_NATIVE_JULIA,args:['--startup-file=no',`--project=${context.controller}`,'-e',`using PerfChecker;write(${JSON.stringify(marker)},string(Base.pkgversion(PerfChecker)))`],problemMatcher:[]}]}));
    await eventually(async()=>(await vscode.tasks.fetchTasks()).some(task=>task.name==='PerfChecker native fixture'),'The native task provider has loaded the on-disk task before its picker opens',60000);
    await clickStudioAction(context,'tasks');
    const picker=windowPage.locator('.quick-input-widget');await picker.waitFor({state:'visible'});
    await picker.locator('.monaco-list-row').filter({hasText:'PerfChecker native fixture'}).first().click();
    // VS Code may ask for the problem-matcher choice even for an explicitly empty matcher.
    await delay(300);
    const noMatcher=picker.locator('.monaco-list-row').filter({hasText:'Continue without scanning the task output'});
    if(await noMatcher.isVisible().catch(()=>false))await noMatcher.click();
    await eventually(async()=>await fs.readFile(marker,'utf8')===context.coreVersion,'The Project tasks button runs the real Julia task');
    context.proof('project-task',{nativeStudioClick:true,core:context.core});
  }finally{if(previous)await fs.writeFile(file,previous);else await fs.rm(file,{force:true});}
}
async function multiRoot(context){
  const {vscode,workspace}=context;
  assert(vscode.workspace.workspaceFile,'The multi-root driver starts in a saved disposable workspace to avoid host restart');
  const second=path.join(path.dirname(workspace),'workspace-second');
  await fs.mkdir(path.join(second,'perf'),{recursive:true});
  await fs.writeFile(path.join(second,'Project.toml'),'name="SecondNativeFixture"\nuuid="1904c3c1-3d82-4801-94ca-c7c628ec22d1"\nversion="0.1.0"\n');
  const uri=vscode.Uri.file(second);
  let observedAddition=false;
  const added=vscode.workspace.onDidChangeWorkspaceFolders(event=>{if(event.added.some(folder=>folder.uri.fsPath===uri.fsPath))observedAddition=true;});
  assert(vscode.workspace.updateWorkspaceFolders(1,0,{uri:vscode.Uri.file(second),name:'Second native workspace'}));
  try{await eventually(()=>observedAddition,'The real workspace-folder event reports the normalized second URI');}finally{added.dispose();}
  try{
    const secondController=path.join(second,'perf','controller');
    await fs.mkdir(secondController,{recursive:true});
    for(const file of ['Project.toml','Manifest.toml'])await fs.copyFile(path.join(context.controller,file),path.join(secondController,file));
    await fs.mkdir(path.join(second,'src'),{recursive:true});
    await fs.copyFile(path.join(workspace,'src','PerfCheckerNativeFixture.jl'),path.join(second,'src','PerfCheckerNativeFixture.jl'));
    const settings=vscode.workspace.getConfiguration('perfchecker',uri);
    await settings.update('runnerProject',secondController,vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('scenarioProject',secondController,vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('juliaExecutable',process.env.PERFCHECKER_NATIVE_JULIA,vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',uri);
    const studio=await context.findFrame('#studio-root');
    const environment=studio.locator('details.environment');
    if(!await environment.evaluate(element=>element.open))await environment.locator('summary').click();
    await eventually(async()=>(await studio.locator('.workspace strong').innerText())==='Second native workspace'&&
      (await environment.innerText()).includes(secondController),'The Studio identifies the selected second folder and its expanded controller');
    await clickStudioAction({...context,workspace:second},'terminal');
    const terminal=await eventually(()=>vscode.window.terminals.find(item=>item.name==='PerfChecker · Second native workspace'),'Studio routes its terminal to the explicitly selected second folder');
    const marker=path.join(second,'terminal-version.txt');
    terminal.sendText(`using PerfChecker;write(${JSON.stringify(marker)}, string(Base.pkgversion(PerfChecker))*"\\n"*Base.active_project())`);
    await eventually(async()=>await fs.readFile(marker,'utf8')===context.coreVersion+'\n'+path.join(secondController,'Project.toml'),'Second-folder terminal uses its own resource controller');
    terminal.dispose();
    assert.equal(vscode.workspace.getConfiguration('perfchecker',vscode.Uri.file(workspace)).get('runnerProject'),context.controller);
    await assert.rejects(vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(path.join(second,'outside'))),/not an open workspace folder/);
    await debug({...context,workspace:second,controller:secondController});
    context.proof('multi-root-explicit-routing',{folders:2,nativeStudioClick:true,firstResourcePreserved:true,distinctController:true,secondFolderDebuggerProjectVersionAndOracle:true});
  }finally{
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(workspace));
    const index=vscode.workspace.workspaceFolders.findIndex(folder=>folder.uri.fsPath===uri.fsPath);
    if(index>=0)vscode.workspace.updateWorkspaceFolders(index,1);
  }
}
async function landscape(context){
  const {vscode,workspace}=context,uri=vscode.Uri.file(workspace);
  await assert.rejects(vscode.commands.executeCommand('perfchecker.runLandscapeLiveForWorkspace',uri),/valid render quality slug/);
  await assert.rejects(vscode.commands.executeCommand('perfchecker.runLandscapeLiveForWorkspace',uri,'desktop-natif'),/EtenduGame\.toml|Beautiful Landscape.*contract/);
  context.proof('landscape-live-prerequisite',{status:'prerequisite',command:'perfchecker.runLandscapeLiveForWorkspace',reason:'The disposable package is not an Étendue Beautiful Landscape workspace; its game manifest, quality profiles, live provider and physical GPU are absent.',gpuRenderingValidated:false});
}
exports.run=async context=>{
  assert.equal(process.env.CI,'true');const failures=[];
  for(const [name,run]of[['existing-controller',existingController],['julia-repl',repl],['julia-debug',debug],['project-tasks',tasks],['multi-root',multiRoot],['landscape-prerequisite',landscape]]){
    const commands=await context.vscode.commands.getCommands(true);
    if(commands.includes('notifications.clearAll'))await context.vscode.commands.executeCommand('notifications.clearAll');
    try{await run(context);}catch(error){
      await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,`${process.env.PERFCHECKER_NATIVE_PHASE}-${name}-failure.png`)}).catch(()=>{});
      failures.push(error);context.log(`${name}-failure`,{message:String(error),stack:error.stack});
    }
  }
  if(failures.length)throw new AggregateError(failures,'Native workbench controls failed; remaining groups were still attempted');
};
