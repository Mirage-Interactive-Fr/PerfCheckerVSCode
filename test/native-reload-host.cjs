// A real single-folder -> saved multi-root conversion restarts the extension
// host. The handoff is test evidence, not a fallback in the product.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');

async function eventually(read,description,timeout=90000){
  const until=Date.now()+timeout;let last;
  while(Date.now()<until){
    try{const result=await read();if(result)return result;}catch(error){if(error.nativeTerminal)throw error;last=error;}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error(`${description}${last?`: ${last.message}`:''}`);
}

async function allocationInventory(directory){
  const result={};
  async function visit(root){
    for(const item of await fs.readdir(root,{withFileTypes:true})){
      const file=path.join(root,item.name);
      if(item.isDirectory())await visit(file);
      else if(item.isFile()&&item.name.endsWith('.mem'))result[path.relative(directory,file)]=createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  await visit(directory);return result;
}

function alive(pid){
  try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}
}

async function privateChecks(){
  return (await fs.readdir(os.tmpdir(),{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.startsWith('perfchecker-check-')).map(entry=>path.join(os.tmpdir(),entry.name));
}

exports.validateHandoff=async(previous)=>{
  const output=process.env.PERFCHECKER_NATIVE_OUTPUT;
  const state=JSON.parse(await fs.readFile(path.join(output,'reload-handoff.json'),'utf8'));
  assert.equal(state.status,'awaiting-reload');
  assert.equal(state.invocation,process.env.PERFCHECKER_NATIVE_INVOCATION);
  assert.equal(state.vsixSha256,process.env.PERFCHECKER_NATIVE_SHA);
  assert.equal(state.workspace,process.env.PERFCHECKER_NATIVE_WORKSPACE);
  assert(previous.some(entry=>entry.invocation===state.invocation&&entry.pid===state.oldHostPid));
  assert.notEqual(process.pid,state.oldHostPid,'The oracle must run in a different, genuinely restarted extension host');
  await fs.copyFile(path.join(output,'reload.json'),path.join(output,'reload-before-host-restart.json'));
  return state;
};

exports.run=async context=>{
  const {vscode,workspace,controller,log,proof}=context;
  assert.equal(process.env.CI,'true');
  assert.equal(process.env.PERFCHECKER_NATIVE_MODE,'candidate');
  const output=process.env.PERFCHECKER_NATIVE_OUTPUT;
  const file=path.join(output,'reload-handoff.json');
  const state=await fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return;throw error;});
  const marker=path.join(workspace,'perf','owned-suite-worker.marker');
  if(state){
    assert.equal(state.status,'awaiting-reload');assert.notEqual(process.pid,state.oldHostPid);
    assert.equal(vscode.workspace.workspaceFolders.length,2);
    assert(vscode.workspace.workspaceFolders.some(folder=>folder.uri.fsPath===vscode.Uri.file(state.secondFolder).fsPath));
    const start=Date.now();
    // All ownership oracles precede deleting any fixture or requesting another
    // Cancel. EOF/deactivation must finish the worker's actual cleanup itself.
    await eventually(()=>!alive(state.workerPid),'Workspace conversion terminates the detached measured worker',45000);
    await eventually(()=>fs.stat(state.ownedDirectory).then(()=>false).catch(error=>{if(error.code==='ENOENT')return true;throw error;}),'Reload finishes cleanup of the real private allocation environment',45000);
    assert.deepEqual(await allocationInventory(workspace),state.beforeMem,'Reload restores existing allocation evidence and removes only its own .mem traces');
    for(const directory of state.privateCheckDirectories)
      assert.equal(await fs.stat(directory).then(()=>true).catch(error=>{if(error.code==='ENOENT')return false;throw error;}),false,'The private allocation inventory belonging to this worker is cleaned');
    const journal=(await fs.readFile(path.join(output,'reload-activations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(entry=>entry.invocation===state.invocation);
    assert.equal(journal.length,2,'Exactly one expected extension-host restart is allowed');
    assert.deepEqual(journal.map(entry=>entry.pid),[state.oldHostPid,process.pid]);
    const result={...state,status:'passed',newHostPid:process.pid,observedAt:new Date().toISOString(),cleanupObservedMilliseconds:Date.now()-start,
      workerTerminated:true,ownedDirectoryRemoved:true,cleanupFinished:true,allocationInventoryPreserved:true,privateInventoriesRemoved:true,verifiedBeforeHarnessCleanup:true};
    await fs.writeFile(file,JSON.stringify(result,null,2));
    proof('native-reload-owned-allocation-cleanup',{status:'passed',oldHostPid:state.oldHostPid,newHostPid:process.pid,workerPid:state.workerPid,
      nativeWorkspaceConversion:true,ownerRestarted:true,cancellationRoute:'Owned deactivation or dedicated-pipe EOF; this oracle does not distinguish the two.',ownedDirectoryRemoved:true,cleanupFinished:true,noNewMem:true,preExistingMemPreserved:true,privateInventoriesRemoved:true,
      vsixSha256:state.vsixSha256,scope:'An actual suite allocation worker and its Core-owned environment/artifacts; user callbacks and other worker families have separate lifecycle contracts.'});
    await context.windowPage.screenshot({path:path.join(output,`native-${process.platform}-vscode-${vscode.version}-reload-cleanup.png`)});
    return;
  }
  assert.equal(vscode.workspace.workspaceFolders.length,1);
  assert(!vscode.workspace.workspaceFile,'The initial window must be a real bare single-folder workspace');
  const settings=vscode.workspace.getConfiguration('perfchecker',vscode.Uri.file(workspace));
  for(const [key,value] of Object.entries({juliaExecutable:process.env.PERFCHECKER_NATIVE_JULIA,runnerProject:controller,scenarioProject:controller,
    suite:'perf/owned-suite.jl',profile:'quick',reports:'perf/results/reload',advisorEnabled:false}))
    await settings.update(key,value,vscode.ConfigurationTarget.WorkspaceFolder);
  for(const name of ['owned-suite-worker.marker','owned-suite-cleaning.marker','owned-suite-cleaned.marker'])await fs.rm(path.join(workspace,'perf',name),{force:true});
  const preserved=path.join(workspace,'perf','owned-cancel.jl.999.mem');
  await fs.writeFile(preserved,'Existing allocation evidence owned by the fixture\n');
  const beforeMem=await allocationInventory(workspace);
  const beforeChecks=new Set(await privateChecks());
  await vscode.commands.executeCommand('perfchecker.refresh');
  const running=vscode.commands.executeCommand('perfchecker.runAll').then(()=>({status:'finished'}),error=>({status:'rejected',error:String(error)}));
  let outcome;void running.then(result=>{outcome=result;});
  const info=await eventually(async()=>{
    if(outcome)throw Object.assign(new Error(`The owned allocation check ended before its active-worker marker: ${JSON.stringify(outcome)}`),{nativeTerminal:true});
    const text=await fs.readFile(marker,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    const [pid,directory]=text.split('\n');
    return /^\d+$/.test(pid)&&directory&&path.isAbsolute(directory)?{pid:Number(pid),directory}:false;
  },'A real allocation workload reaches its owned PID/directory marker',360000);
  assert(alive(info.pid));assert(await fs.stat(path.join(info.directory,'owned.tmp')));
  assert(path.basename(path.dirname(info.directory)).startsWith('perfchecker-check-'),'The workload marker must point inside this allocation worker\'s private Core environment');
  const privateCheckDirectories=[];
  for(const directory of await privateChecks()){
    if(beforeChecks.has(directory))continue;
    const journal=await fs.readFile(path.join(directory,'allocation-artifacts')).catch(error=>{if(error.code==='ENOENT')return Buffer.alloc(0);throw error;});
    if(journal.includes(Buffer.from(`.${info.pid}.mem`)))privateCheckDirectories.push(directory);
  }
  assert(privateCheckDirectories.length>0,'A physical allocation journal identifies this worker\'s owned private check directories');
  const secondFolder=path.join(path.dirname(workspace),'reload-second-folder');
  await fs.mkdir(secondFolder);
  const handoff={status:'awaiting-reload',invocation:process.env.PERFCHECKER_NATIVE_INVOCATION,vsixSha256:process.env.PERFCHECKER_NATIVE_SHA,
    workspace,oldHostPid:process.pid,workerPid:info.pid,ownedDirectory:info.directory,privateCheckDirectories,secondFolder,beforeMem,startedAt:new Date().toISOString(),core:context.core};
  await fs.writeFile(file,JSON.stringify(handoff,null,2));
  log('native-reload-active-allocation-worker',{workerPid:info.pid,oldHostPid:process.pid,ownedDirectory:info.directory,actualWorkerActive:true});
  await context.windowPage.screenshot({path:path.join(output,`native-${process.platform}-vscode-${vscode.version}-before-reload.png`)});
  log('native-ui-action',{surface:'VS Code workspace',action:'Convert single folder to multi-root using updateWorkspaceFolders',expectedHostRestart:true});
  assert(vscode.workspace.updateWorkspaceFolders(1,0,{uri:vscode.Uri.file(secondFolder),name:'Reload lifecycle fixture'}));
  await new Promise((resolve,reject)=>setTimeout(()=>reject(new Error('The actual single-folder workspace conversion did not restart its extension host within 30 seconds')),30000));
};
