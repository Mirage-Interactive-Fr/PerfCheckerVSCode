// Actual CodeLens and quick-fix clicks in disposable native VS Code hosts.
// Findings come from a real JET worker; no diagnostic or report is injected.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(read,description,timeout=180000){
  const deadline=Date.now()+timeout;let last;
  while(Date.now()<deadline){try{const value=await read();if(value)return value;}catch(error){last=error;}await delay(150);}
  throw new Error(`${description}${last?`: ${last.message}`:''}`);
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// Only the separately selected Linux editor qualification observes these
// incarnations. No observation sends signals or supplies fake worker evidence.
exports.beginQualification=async context=>{
  assert.equal(process.platform,'linux');assert.equal(process.env.PERFCHECKER_NATIVE_PHASE,'editor');
  const deadline=Date.parse(process.env.PERFCHECKER_NATIVE_EDITOR_DEADLINE_AT);assert(Number.isFinite(deadline)&&deadline>Date.now());
  const executable=await fs.realpath(process.env.PERFCHECKER_NATIVE_JULIA),known=new Map(),groups=new Set(),ports=new Set(),errors=[];
  const read=async file=>{assert(Date.now()<deadline);return fs.readFile(file,{encoding:'utf8',signal:AbortSignal.timeout(Math.min(3000,deadline-Date.now()))});};
  const identity=async pid=>{
    try{const value=await read(`/proc/${pid}/stat`),end=value.lastIndexOf(')'),fields=value.slice(end+2).trim().split(/\s+/);
      assert(end>0&&fields.length>19&&[fields[1],fields[2],fields[19]].every(x=>/^\d+$/.test(x)));
      const parent=Number(fields[1]),group=Number(fields[2]);assert(Number.isSafeInteger(pid)&&pid>0&&Number.isSafeInteger(parent)&&parent>=0&&Number.isSafeInteger(group)&&group>=0);
      return {pid,parent,group,started:fields[19],state:fields[0]};
    }catch(error){if(['ENOENT','ESRCH'].includes(error.code))return undefined;throw error;}
  };
  const host=await identity(process.pid);assert(host);const hostExecutable=await fs.realpath(`/proc/${process.pid}/exe`);
  let inventorySignature;
  const inspect=async stage=>{
    assert(Date.now()<deadline);const rows=[],current=[],observedErrors=[];
    for(const name of await fs.readdir('/proc'))if(/^\d+$/.test(name))try{const row=await identity(Number(name));if(row)current.push(row);}catch(error){observedErrors.push({pid:Number(name),kind:'stat-unknown',code:error.code||error.name});}
    const currentHost=await identity(process.pid);assert(currentHost&&['pid','parent','group','started'].every(key=>currentHost[key]===host[key]),'The extension host retains its physical incarnation');assert.equal(await fs.realpath(`/proc/${process.pid}/exe`),hostExecutable);
    const owned=new Set(current.filter(row=>known.has(`${row.pid}/${row.started}`)).map(row=>row.pid));
    for(const row of current.filter(row=>row.parent===process.pid&&!['Z','X'].includes(row.state)))try{
      if(await fs.realpath(`/proc/${row.pid}/exe`)===executable){owned.add(row.pid);if(row.group===row.pid)groups.add(row.group);}
    }catch(error){const after=await identity(row.pid);if(!['ENOENT','ESRCH'].includes(error.code)||after&&(after.started!==row.started||after.group!==row.group||!['Z','X'].includes(after.state)))observedErrors.push({pid:row.pid,kind:'direct-executable-unknown',code:error.code||error.name});}
    for(let changed=true;changed;){changed=false;for(const row of current)if(owned.has(row.parent)&&!owned.has(row.pid)){owned.add(row.pid);changed=true;}}
    for(const row of current.filter(row=>groups.has(row.group)&&!owned.has(row.pid)&&!['Z','X'].includes(row.state)))observedErrors.push({pid:row.pid,kind:'unqualified-private-group-member'});
    for(const row of current.filter(row=>owned.has(row.pid)))try{
      if(['Z','X'].includes(row.state)){rows.push({...row,gone:true});continue;}
      const actual=await fs.realpath(`/proc/${row.pid}/exe`),after=await identity(row.pid);
      if(!after){rows.push({...row,gone:true});continue;}
      assert(after.group===row.group&&after.started===row.started);
      if(['Z','X'].includes(after.state)){rows.push({...row,gone:true});continue;}
      if(after.parent!==row.parent)context.log('native-editor-parent-transition',{stage,pid:row.pid,started:row.started,group:row.group,
        initialObservedParent:row.parent,currentParent:after.parent,stillAlive:true,observedAt:new Date().toISOString()});
      assert.equal(await fs.realpath(`/proc/${row.pid}/exe`),actual,'The executable is revalidated with the same incarnation');
      const key=`${row.pid}/${row.started}`,prior=known.get(key);assert(!prior||prior.canonicalExecutable===actual,'Executable changes stay unqualified');
      const value={...after,canonicalExecutable:actual};known.set(key,value);rows.push(value);
    }catch(error){let after;try{after=await identity(row.pid);}catch(observation){observedErrors.push({pid:row.pid,kind:'revalidation-unknown',code:observation.code||observation.name});}
      if(['ENOENT','ESRCH'].includes(error.code)&&(!after||after.started===row.started&&after.group===row.group&&['Z','X'].includes(after.state))&&!observedErrors.some(x=>x.pid===row.pid)){rows.push({...row,gone:true});continue;}
      observedErrors.push({pid:row.pid,kind:'identity-unknown',code:error.code||error.name});}
    for(const prior of known.values())if(current.some(row=>row.pid===prior.pid&&row.started!==prior.started))observedErrors.push({pid:prior.pid,kind:'pid-reused'});
    const tcp=[];
    if(ports.size)for(const family of ['tcp','tcp6'])for(const line of (await read(`/proc/net/${family}`)).trim().split('\n').slice(1)){
      const fields=line.trim().split(/\s+/),local=fields[1]?.split(':'),remote=fields[2]?.split(':');
      assert(fields.length>9&&[local,remote].every(x=>x?.length===2&&/^(?:[a-f\d]{8}|[a-f\d]{32})$/i.test(x[0])&&/^[a-f\d]{4}$/i.test(x[1]))&&/^[a-f\d]{2}$/i.test(fields[3])&&/^\d+$/.test(fields[9]));
      const localPort=parseInt(local[1],16),remotePort=parseInt(remote[1],16),loopback=address=>['0100007F','0000000000000000FFFF00000100007F'].includes(address.toUpperCase());
      if(!(ports.has(localPort)&&loopback(local[0]))&&!(ports.has(remotePort)&&loopback(remote[0])))continue;
      tcp.push({family,localPort,remotePort,localAddressHex:local[0],remoteAddressHex:remote[0],state:fields[3],inode:fields[9]});
    }
    errors.push(...observedErrors);const value={stage,observedAt:new Date().toISOString(),host,hostExecutable,rows,tcp,errors:observedErrors};
    const signature=JSON.stringify({stage,rows:rows.map(row=>({...row,state:row.gone?row.state:'alive'})),tcp,errors:observedErrors});
    if(signature!==inventorySignature){context.log('native-editor-physical-inventory',value);inventorySignature=signature;}
    assert.equal(observedErrors.length,0,'Inspection errors do not qualify disappearance');assert(Date.now()<deadline);return value;
  };
  let observation=Promise.resolve();const sample=stage=>{const call=observation.then(()=>inspect(stage));observation=call.catch(()=>{});return call;};
  const settings=()=>Object.fromEntries(Object.keys(context.vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode').packageJSON.contributes.configuration.properties)
    .map(option=>{const key=option.replace(/^perfchecker\./,'');const value=context.vscode.workspace.getConfiguration('perfchecker',context.vscode.Uri.file(context.workspace)).inspect(key);return [key,{workspace:value?.workspaceValue,folder:value?.workspaceFolderValue}];}));
  const beforeSettings=settings(),beforeFolders=context.vscode.workspace.workspaceFolders.map(x=>x.uri.toString());
  const protectedFiles=[path.join(context.controller,'Project.toml'),path.join(context.controller,'Manifest.toml'),
    ...['Project.toml','src/PerfCheckerNativeFixture.jl','perf/cases.jl','perf/scenarios.toml','test/performance.jl'].map(x=>path.join(context.workspace,x))];
  const hashes=async()=>Object.fromEntries(await Promise.all(protectedFiles.map(async file=>[file,sha(await fs.readFile(file))])));const beforeHashes=await hashes();
  const memory=async()=>{const result={};const walk=async directory=>{for(const leaf of await fs.readdir(directory)){const file=path.join(directory,leaf),stat=await fs.lstat(file);
    if(stat.isSymbolicLink())continue;if(stat.isDirectory())await walk(file);else if(leaf.endsWith('.mem')){assert(stat.isFile());result[file]=sha(await fs.readFile(file));}}};
    await walk(context.workspace);await walk(context.controller);return result;};const beforeMemory=await memory();
  const first=await sample('before-editor-actions');assert.equal(first.rows.filter(row=>!row.gone).length,0,'No existing Core worker is relabelled as an editor action');
  let observing=true,observationFailure;
  const observer=(async()=>{while(observing){try{await sample('editor-actions-running');}catch(error){observationFailure||=error;observing=false;}if(observing)await delay(250);}})();
  context.editorQualification={
    surface:(stage,frame)=>observeSurface(context,stage,frame),
    worker:async record=>{assert(record&&Number.isSafeInteger(record.pid)&&Number.isSafeInteger(record.parent)&&/^\d+$/.test(record.started));
      assert.equal(await fs.realpath(record.canonicalExecutable),executable);await sample('worker-self-observation');
      const prior=known.get(`${record.pid}/${record.started}`);
      if(prior)assert.equal(prior.canonicalExecutable,record.canonicalExecutable);
      else{const row=await identity(record.pid);assert(!row||['Z','X'].includes(row.state),'A live worker requires independently observed ownership');
        // A worker's own start identity is evidence, but does not invent an
        // independently observed process tree after its parent disappeared.
        context.log('native-editor-self-only-worker',{...record,ownershipObserved:false});throw new Error('The real sample worker was not observed independently while alive');}
      context.log('native-editor-verified-sample-worker',{...record,ownershipObserved:true});},
    port:async port=>{assert(Number.isInteger(port)&&port>0&&port<65536);ports.add(port);const value=await sample('owned-provider-listener');
      const listener=value.tcp.filter(row=>row.localPort===port&&row.state==='0A');assert.equal(listener.length,1,'One real fixture listener exists before requests');
      const owned=[];for(const fd of await fs.readdir(`/proc/${process.pid}/fd`))try{if(await fs.readlink(`/proc/${process.pid}/fd/${fd}`)===`socket:[${listener[0].inode}]`)owned.push(fd);}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
      assert(owned.length>0,'The exact listener inode belongs to this independently identified extension host');
      context.log('native-editor-owned-provider-socket',{host,hostExecutable,port,inode:listener[0].inode,ownedDescriptors:owned});},
  };
  return {finish:async effectsCompleted=>{
    observing=false;await observer;if(observationFailure)throw observationFailure;
    // Reuse the existing phase deadline; no new grace or signals are introduced.
    const last=await sample('editor-before-harness-teardown');assert(last.rows.every(row=>row.gone),'Observed editor workers are gone before teardown');
    assert(last.tcp.every(row=>row.state==='06'),'Only closed TIME_WAIT tuples may remain; other TCP states are not cleanup proof');
    for(const port of ports)await new Promise((resolve,reject)=>{const socket=require('node:net').createConnection({host:'127.0.0.1',port});
      socket.setTimeout(Math.min(1000,Math.max(1,deadline-Date.now())));socket.once('connect',()=>{socket.destroy();reject(new Error('The owned provider still accepts connections'));});
      socket.once('error',error=>{socket.destroy();error.code==='ECONNREFUSED'?resolve():reject(error);});socket.once('timeout',()=>{socket.destroy();reject(new Error('The provider probe is UNKNOWN'));});});
    assert.equal(errors.length,0);assert.deepEqual(settings(),beforeSettings);assert.deepEqual(context.vscode.workspace.workspaceFolders.map(x=>x.uri.toString()),beforeFolders);assert.deepEqual(await hashes(),beforeHashes);assert.deepEqual(await memory(),beforeMemory);assert(Date.now()<deadline);
    assert.equal(effectsCompleted,true,'Cleanup cannot turn an incomplete editor effect into PASS');
    context.proof('native-editor-effects-and-cleanup',{observedBeforeHarnessCleanup:true,host,known:[...known.values()],exactPorts:[...ports],listenerAbsent:true,activeTcpAbsent:true,
      timeWaitNotActive:true,connectionRefused:true,settingsRestored:true,workspaceFoldersRestored:true,protectedFileHashes:beforeHashes,memoryFilesBefore:beforeMemory,memoryUnchanged:true,errors:[],observerSignalsSent:false,caseFinallyAlreadyCompleted:true,
      scope:'Observed Linux descendants and directly anchored private groups; no arbitrary unobserved daemon ownership'});
  }};
};
async function observeSurface(context,stage,frame){
  if(!context.editorQualification)return;
  const counts=await context.windowPage.locator('.codelens-decoration a:visible').allTextContents();
  const detail={stage,codeLens:counts,visibleButtons:[]};
  if(frame)detail.visibleButtons=await frame.locator('button:visible').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent.trim(),disabled:node.disabled})));
  assert(/^[a-z-]+$/.test(stage));context.editorSurfaceSequence=(context.editorSurfaceSequence||0)+1;
  const file=`native-linux-editor-${context.editorSurfaceSequence}-${stage}.png`,bytes=await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,file)});
  detail.screenshot={file,sha256:sha(bytes),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),scope:'Actual Electron renderer viewport; no physical X11 or Full HD framing claim'};
  context.log('native-editor-visible-surface',detail);
}
async function reports(root){return new Set(await fs.readdir(root).catch(error=>{if(error.code==='ENOENT')return [];throw error;}));}
async function reportAfter(root,before,name){
  return eventually(async()=>{
    for(const id of await reports(root)){
      if(before.has(id))continue;
      const file=path.join(root,id,`${name}.json`);
      try{return {file,payload:JSON.parse(await fs.readFile(file,'utf8'))};}
      catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    }
    return false;
  },`The actual ${name} worker writes its report`,360000);
}
async function view(context){
  await context.vscode.commands.executeCommand('perfchecker.openInvestigations');
  return context.findFrame('#app');
}

async function resource(context,workspace,controller,threads,previousEditorAction){
  const {vscode,windowPage}=context,uri=vscode.Uri.file(workspace);
  const settings=vscode.workspace.getConfiguration('perfchecker',uri);
  const keys=['runnerProject','scenarioProject','juliaExecutable','scenarioCatalog','analysisTools','scenarioThreads','investigationReports'];
  const previous=Object.fromEntries(keys.map(key=>[key,settings.inspect(key)?.workspaceFolderValue]));
  assert.equal(vscode.workspace.getWorkspaceFolder(uri)?.uri.toString(),uri.toString(),
    'Every editor setting is scoped to the actual owning workspace URI');
  const update=async(key,value,stage)=>{
    try{await settings.update(key,value,vscode.ConfigurationTarget.WorkspaceFolder);}
    catch(error){context.log('native-editor-scoped-setting-failure',{key,stage,resource:uri.toString(),
      owner:vscode.workspace.getWorkspaceFolder(uri)?.uri.toString(),workspaceFile:vscode.workspace.workspaceFile?.toString(),message:String(error)});throw error;}
  };
  const catalog=path.join(workspace,'perf','scenarios.toml'),factory=path.join(workspace,'perf','native-editor-actions.jl');
  const original=await fs.readFile(catalog).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  const source='function make_editor_case(p)\n    (prepare=()->Any[identity,42], operation=x->x[1](x[2]), verify=(x,r)->r==42)\nend\n';
  const declaration='\n[[scenarios]]\nid = "native_editor_branch"\nsource = "native-editor-actions.jl"\nfactory = "make_editor_case"\nimplementation = "conditional"\ncollectors = ["benchmark"]\n';
  await fs.mkdir(path.dirname(catalog),{recursive:true});
  await fs.writeFile(factory,source);
  const header=(original?.toString()??'schema_version = "perfchecker-scenario-catalog/1"\nroot = ".."\n')
    .replace('root = "."','root = ".."');
  await fs.writeFile(catalog,header+declaration);
  try{
    for(const [key,value]of Object.entries({runnerProject:controller,scenarioProject:controller,
      juliaExecutable:process.env.PERFCHECKER_NATIVE_JULIA,scenarioCatalog:'perf/scenarios.toml',
      analysisTools:['jet'],scenarioThreads:threads,investigationReports:'perf/results/editor-actions'}))
      await update(key,value,'prepare');
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',uri);
    let frame=await view(context),root=path.join(workspace,'perf','results','editor-actions'),before=await reports(root);
    await frame.getByRole('button',{name:'Discover tests',exact:true}).click();
    const discovery=await reportAfter(root,before,'discovery');
    assert(discovery.payload.declared.some(item=>item.id==='native_editor_branch'));
    assert(discovery.payload.candidates.length,'The actual TestItem fixture exposes a proposal CodeLens');
    if(previousEditorAction){
      const unchanged=await reports(root);
      await assert.rejects(vscode.commands.executeCommand(previousEditorAction.command,...previousEditorAction.arguments),
        /another workspace/,'A real first-folder CodeLens command cannot diagnose the same scenario ID in the second folder');
      assert.deepEqual(await reports(root),unchanged,'Rejecting a stale editor action creates no second-folder report');
      context.proof('native-stale-codelens-workspace-owner',{realCodeLensArguments:true,
        previousOwner:previousEditorAction.arguments[1],selectedOwner:uri.toString(),
        identicalScenarioId:'native_editor_branch',rejectedBeforeWorker:true,noNewReport:true});
    }

    const candidate=discovery.payload.candidates[0];
    await vscode.commands.executeCommand('perfchecker.openInvestigationSource',candidate.origin.file,candidate.origin.line);
    const prepareLens=windowPage.locator('.codelens-decoration a').filter({hasText:'Prepare shared performance case'}).first();
    await prepareLens.waitFor({state:'visible',timeout:60000});await observeSurface(context,'proposal-codelens');await prepareLens.click();
    await eventually(()=>vscode.window.activeTextEditor?.document.isUntitled,'The real proposal CodeLens opens an untitled shared-case draft');
    assert.match(vscode.window.activeTextEditor.document.getText(),/prepare/);
    assert.match(vscode.window.activeTextEditor.document.getText(),/verify/);

    const sourceUri=vscode.Uri.file(factory);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sourceUri),
      {preview:false,selection:new vscode.Range(0,0,0,0)});
    const lens=windowPage.locator('.codelens-decoration a').filter({hasText:'Diagnose native_editor_branch · conditional'});
    const actualLenses=await vscode.commands.executeCommand('vscode.executeCodeLensProvider',sourceUri);
    const editorAction=actualLenses.find(item=>item.command?.title==='Diagnose native_editor_branch · conditional')?.command;
    assert.equal(editorAction?.arguments[1],uri.toString(),'The registered native CodeLens contains its owning workspace URI');
    await lens.waitFor({state:'visible',timeout:60000});await observeSurface(context,'diagnosis-codelens');before=await reports(root);await lens.click();
    const diagnosis=await reportAfter(root,before,'diagnosis');
    const record=diagnosis.payload.records.find(item=>item.scenario==='native_editor_branch');
    assert(record,'The clicked CodeLens diagnoses its own selected scenario');
    assert.equal(record.tool,'jet');assert.equal(record.status,'complete');assert.equal(record.correctness,'passed');
    assert.equal(vscode.Uri.file(record.configuration.project).fsPath,vscode.Uri.file(controller).fsPath);
    assert.equal(record.runtime.threads,threads);
    const finding=record.findings.find(item=>item.location?.file&&
      vscode.Uri.file(path.resolve(workspace,item.location.file)).fsPath===sourceUri.fsPath&&item.location.line>0);
    assert(finding,'JET must emit a genuine finding at the actual local factory file');
    const diagnostic=await eventually(()=>vscode.languages.getDiagnostics(sourceUri).find(item=>item.source==='PerfChecker'),
      'The actual diagnosis publishes a native PerfChecker diagnostic');
    assert.equal(diagnostic.range.start.line,finding.location.line-1);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sourceUri),
      {preview:false,selection:diagnostic.range});
    await vscode.commands.executeCommand('editor.action.quickFix');
    const action=windowPage.getByText('Read evidence and verification steps',{exact:true});
    await action.waitFor({state:'visible',timeout:30000});
    if(context.editorQualification)context.log('native-editor-visible-quickfix',{entries:await action.count(),label:'Read evidence and verification steps',visible:await action.isVisible()});
    const menu=windowPage.locator('.action-widget:visible');assert.equal(await menu.count(),1);
    const entries=await menu.getByRole('option').count();assert(entries>0);
    const focused=()=>action.evaluate(node=>node.closest('.monaco-list-row')?.classList.contains('focused')===true);
    let next=0;
    while(!await focused()&&next<entries){await windowPage.keyboard.press('ArrowDown');next++;}
    assert(await focused(),'Native keyboard navigation focuses the exact visible PerfChecker quick fix');
    context.log('native-editor-quickfix-keyboard',{label:'Read evidence and verification steps',options:entries,arrowDown:next,exactRowFocused:true});
    await windowPage.keyboard.press('Enter');
    frame=await context.findFrame('#app');
    await eventually(async()=>(await frame.locator('body').innerText()).includes('native_editor_branch'),
      'The chosen native quick fix opens the evidence for the same workspace');
    assert.equal(await fs.readFile(factory,'utf8'),source,'Quick fix opens evidence without editing source');
    const currentSettings=vscode.workspace.getConfiguration('perfchecker',uri);
    assert.equal(currentSettings.get('scenarioProject'),controller);
    assert.equal(currentSettings.inspect('scenarioProject')?.workspaceFolderValue,controller);
    await observeSurface(context,'quickfix-evidence',frame);
    context.proof('native-codelens-and-quickfix',{workspace:path.basename(workspace),controller,
      sourceUri:sourceUri.toString(),sourceSha256:sha(Buffer.from(source)),threads,
      proposalCodeLensNativeClick:true,diagnosisCodeLensNativeClick:true,quickFixNativeChoice:true,
      diagnosticLine:finding.location.line,rule:finding.rule_id,report:diagnosis.file,
      reportSha256:sha(await fs.readFile(diagnosis.file)),sourceUnchanged:true});
    return editorAction;
  }finally{
    await vscode.commands.executeCommand('perfchecker.cancelInvestigation');
    {
      const current=await view(context);
      await eventually(async()=>!((await current.locator('#app .status').getAttribute('class'))||'').includes('busy'),
        'Editor-action workers finish before restoring their fixture');
    }
    for(const key of keys)await update(key,previous[key],'restore');
    if(original)await fs.writeFile(catalog,original);else await fs.rm(catalog,{force:true});
    await fs.rm(factory,{force:true});
  }
}

exports.run=async context=>{
  const {vscode,workspace,controller}=context;
  assert(vscode.workspace.workspaceFile,'The scoped editor test requires the saved disposable workspace');
  const editor=vscode.workspace.getConfiguration('editor'),oldLens=editor.inspect('codeLens')?.globalValue;
  const second=path.join(path.dirname(workspace),'workspace-editor-second'),secondUri=vscode.Uri.file(second);
  let added=false;
  try{
    await editor.update('codeLens',true,vscode.ConfigurationTarget.Global);
    const firstEditorAction=await resource(context,workspace,controller,1);
    await fs.mkdir(path.join(second,'test'),{recursive:true});
    await fs.copyFile(path.join(workspace,'test','performance.jl'),path.join(second,'test','performance.jl'));
    const secondController=path.join(second,'perf','controller');await fs.mkdir(secondController,{recursive:true});
    for(const file of ['Project.toml','Manifest.toml'])await fs.copyFile(path.join(controller,file),path.join(secondController,file));
    // updateWorkspaceFolders exposes an optimistic extension-host list before
    // the workbench acknowledges its configuration model. Await the real event
    // rather than attempting folder-setting writes against that optimistic list.
    let acknowledged=false;
    const changed=vscode.workspace.onDidChangeWorkspaceFolders(event=>{
      if(event.added.some(folder=>folder.uri.toString()===secondUri.toString()))acknowledged=true;
    });
    try{
      added=vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length,0,{uri:secondUri,name:'Editor action second workspace'});
      assert(added);await eventually(()=>acknowledged,'The workbench acknowledges the second workspace and its configuration model',30000);
    }finally{changed.dispose();}
    assert.equal(vscode.workspace.getWorkspaceFolder(secondUri)?.uri.toString(),secondUri.toString());
    context.log('native-editor-second-workspace-acknowledged',{resource:secondUri.toString(),actualWorkspaceEvent:true});
    await resource(context,second,secondController,2,firstEditorAction);
  }finally{
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(workspace));
    if(added){const index=vscode.workspace.workspaceFolders.findIndex(folder=>folder.uri.toString()===secondUri.toString());
      if(index>=0)vscode.workspace.updateWorkspaceFolders(index,1);}
    await editor.update('codeLens',oldLens,vscode.ConfigurationTarget.Global);
  }
};

exports.runSuiteLog=async context=>{
  const {vscode,windowPage,workspace,controller}=context;
  await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(workspace));
  await vscode.commands.executeCommand('perfchecker.refresh');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.showCommands');
  const picker=windowPage.locator('.quick-input-widget');await picker.waitFor({state:'visible'});
  await picker.locator('input[type="text"]').fill('>PerfChecker: Show worker output');
  if(context.editorQualification){const action=picker.getByText('PerfChecker: Show worker output',{exact:true});await action.waitFor({state:'visible'});
    context.log('native-editor-visible-palette',{command:'perfchecker.showLog',entries:await action.count(),visible:await action.isVisible()});}
  await picker.getByText('PerfChecker: Show worker output',{exact:true}).click();
  await picker.waitFor({state:'hidden'});
  // OutputViewPane's official output-view class scopes the visible Monaco
  // editor; the native channel selector independently identifies the suite log.
  const output=windowPage.locator('.output-view:visible');await output.waitFor({state:'visible'});
  const canonicalController=await fs.realpath(controller);
  // Monaco only renders the current viewport. Reveal the first physical log
  // line with a native editor gesture before asserting its visible contents.
  assert((await vscode.commands.getCommands(true)).includes('workbench.action.focusPanel'));
  await vscode.commands.executeCommand('workbench.action.focusPanel');
  await eventually(()=>output.evaluate(element=>element.contains(document.activeElement)),
    'The native Focus into Panel command focuses the actual visible Output editor',30000);
  await windowPage.keyboard.press(process.platform==='darwin'?'Meta+Home':'Control+Home');
  const file=`native-${process.platform}-vscode-${vscode.version}-suite-worker-output.png`;
  await windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,file)});
  context.log('native-suite-worker-output-visible',{screenshot:file,
    channels:await windowPage.locator('select:visible').evaluateAll(nodes=>nodes.map(node=>node.selectedOptions[0]?.textContent)),
    controllerLine:(await output.locator('.view-lines').allInnerTexts()).join('').split('\n').find(line=>line.includes('Controller project:'))});
  await eventually(async()=>{
    const selected=await windowPage.locator('select:visible').evaluateAll(nodes=>nodes.map(node=>node.selectedOptions[0]?.textContent));
    const text=(await output.locator('.view-lines').allInnerTexts()).join('').replace(/\s+/g,'');
    const shown=/Controllerproject:(.*?)\(/.exec(text)?.[1];
    if(!selected.includes('PerfChecker')||!shown)return false;
    const normalize=value=>process.platform==='win32'?value.toLowerCase():value;
    return normalize(await fs.realpath(shown))===normalize(canonicalController);
  },'The real Show worker output palette command displays the suite channel and actual controller log');
  context.proof('native-suite-worker-output',{nativePaletteClick:true,command:'perfchecker.showLog',
    channel:'PerfChecker',actualControllerVisible:true,controller,screenshot:file});
  await vscode.commands.executeCommand('workbench.action.closePanel');
};

exports.runTestItems=async context=>{
  const {vscode,workspace}=context,settings=vscode.workspace.getConfiguration('perfchecker',vscode.Uri.file(workspace));
  const keys=['testItemTags','testItemExcludeTags','testItemSamples'],previous=Object.fromEntries(keys.map(key=>[key,settings.inspect(key)?.workspaceFolderValue]));
  const file=path.join(workspace,'test','native-tags.jl'),marker=path.join(workspace,'test','native-tags-pids.txt');
  const storage=path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','native-testitems');
  const qualified=!!context.editorQualification;
  const body='using TestItems\n'+[
    ['Native tagged inclusion',':nativeinclude','wanted'],
    ['Native tagged exclusion',':nativeinclude,:nativeexclude','excluded'],
    ['Native other tag',':nativeother','other'],
  ].map(([name,tags,role])=>`@testitem "${name}" tags=[${tags}] begin\n    using Test\n    open(joinpath(@__DIR__,"native-tags-pids.txt"),"a") do io\n        ${qualified?'s=read("/proc/self/stat",String); fields=split(s[findlast(==(\')\'),s)+2:end]); println(io,join(("'+role+':"*string(getpid()),fields[2],fields[20],realpath("/proc/self/exe"),Base.active_project(),Threads.nthreads()),\'\\t\'))':'println(io,"'+role+':",getpid())'}\n    end\n    @test sum(1:10)==55\nend\n`).join('');
  await fs.writeFile(file,body);
  try{
    await settings.update('testItemTags',['nativeinclude'],vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('testItemExcludeTags',['nativeexclude'],vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('testItemSamples',2,vscode.ConfigurationTarget.WorkspaceFolder);
    const before=await reports(storage);
    await require('./native-studio-controls.cjs').clickStudioAction(context,'items');
    const listed=await eventually(async()=>{
      for(const id of await reports(storage)){
        if(before.has(id))continue;
        try{const result=JSON.parse(await fs.readFile(path.join(storage,id,'result.json'),'utf8'));
          if(result.schema_version==='perfchecker-testitems/1')return result;
        }catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
      }
      return false;
    },'Actual native discovery applies the configured include and exclude tags');
    assert.deepEqual(listed.items.map(item=>item.name),['Native tagged inclusion']);
    if(qualified){assert.equal(listed.executed,false,'Discovery does not execute any tagged body');assert.equal(await fs.realpath(listed.root),await fs.realpath(workspace));
      assert.equal(listed.items[0].file,'test/native-tags.jl');assert.deepEqual(listed.items[0].tags,['nativeinclude']);assert.equal(listed.items[0].source_sha256,sha(Buffer.from(body)));
      context.log('native-editor-tag-discovery',{included:listed.items.map(item=>({id:item.id,name:item.name,file:item.file,tags:item.tags})),root:listed.root,executed:false,sourceSha256:sha(Buffer.from(body)),tags:['nativeinclude'],excludeTags:['nativeexclude']});}
    const measured=await context.measureTestItem({name:'Native tagged inclusion',file:'test/native-tags.jl',samples:2,
      retainName:'native-tagged-testitem',proofName:'native-testitem-tagged-current-evidence'});
    const lines=(await fs.readFile(marker,'utf8')).trim().split(/\r?\n/);
    assert.equal(lines.length,2,'Exactly the configured samples execute');
    assert(lines.every(line=>line.startsWith('wanted:')),'Excluded and other-tag test bodies never execute');
    const pids=lines.map(line=>Number(line.split(':')[1].split('\t')[0]));assert.equal(new Set(pids).size,2,'Samples execute in distinct fresh workers');
    if(qualified)for(const line of lines){const fields=line.split('\t');assert.equal(fields.length,6);
      const record={pid:Number(fields[0].slice('wanted:'.length)),parent:Number(fields[1]),started:fields[2],canonicalExecutable:fields[3],project:fields[4],threads:Number(fields[5])};
      assert(Number.isSafeInteger(record.threads)&&record.threads>0);assert.equal(await fs.realpath(record.project),await fs.realpath(path.join(context.controller,'Project.toml')));
      await context.editorQualification.worker(record);}
    context.proof('native-testitems-tags-exclusions-samples',{nativeStudioDiscovery:true,nativeTestingRunClick:true,
      included:listed.items.map(item=>item.name),excludedNeverExecuted:true,samples:measured.payload.runs[0].samples.length,
      freshWorkerPids:pids,reportSha256:sha(await fs.readFile(measured.file)),tags:['nativeinclude'],excludeTags:['nativeexclude']});
  }finally{
    for(const key of keys)await settings.update(key,previous[key],vscode.ConfigurationTarget.WorkspaceFolder);
    await fs.rm(file,{force:true});await fs.rm(marker,{force:true});
  }
};

exports.runActiveSettings=async context=>{
  const {vscode,workspace,controller}=context,uri=vscode.Uri.file(workspace);
  const settings=()=>vscode.workspace.getConfiguration('perfchecker',uri);
  const keys=['runnerProject','scenarioProject','juliaExecutable','scenarioCatalog','scenarioSamples','analysisTimeout','investigationReports'];
  const previous=Object.fromEntries(keys.map(key=>[key,settings().inspect(key)?.workspaceFolderValue]));
  const catalog=path.join(workspace,'perf','scenarios.toml'),original=await fs.readFile(catalog);
  const factory=path.join(workspace,'perf','native-active-settings.jl'),marker=path.join(workspace,'perf','native-active-settings.marker');
  const nextController=path.join(workspace,'perf','alternate-controller');
  const missingJulia=path.join(workspace,'perf','explicitly-unavailable-julia');
  let ownedPid;
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
  await fs.mkdir(nextController,{recursive:true});
  for(const file of ['Project.toml','Manifest.toml'])await fs.copyFile(path.join(controller,file),path.join(nextController,file));
  await fs.writeFile(factory,'make_active_settings_case(p) = (prepare=()->42, operation=x->(write(p["marker"],string(getpid())*"\\n"*dirname(Base.active_project())*"\\n"*string(VERSION));sleep(120);x), verify=(x,r)->r==42)\n');
  await fs.writeFile(catalog,original.toString()+`\n[[scenarios]]\nid = "native_active_settings"\nsource = "native-active-settings.jl"\nfactory = "make_active_settings_case"\nimplementation = "owned"\ncollectors = ["benchmark"]\nparameters = { marker = ${JSON.stringify(marker)} }\n`);
  try{
    for(const [key,value]of Object.entries({runnerProject:controller,scenarioProject:controller,
      juliaExecutable:process.env.PERFCHECKER_NATIVE_JULIA,scenarioCatalog:'perf/scenarios.toml',scenarioSamples:1,
      analysisTimeout:180,investigationReports:'perf/results/active-settings'}))
      await settings().update(key,value,vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',uri);
    let frame=await view(context);const root=path.join(workspace,'perf','results','active-settings'),before=await reports(root);
    await frame.getByRole('button',{name:'Discover tests',exact:true}).click();await reportAfter(root,before,'discovery');
    await eventually(async()=>!((await frame.locator('#app .status').getAttribute('class'))||'').includes('busy'),'The actual declaration discovery finishes');
    await frame.getByRole('button',{name:'Scenarios',exact:true}).click();await frame.getByRole('button',{name:'Clear selection',exact:true}).click();
    await frame.locator('article.card').filter({has:frame.locator('.scenario-title strong',{hasText:'native_active_settings'})}).locator('.scenario-title input').check();
    await frame.getByRole('button',{name:'Measure selected',exact:true}).click();
    const started=await eventually(async()=>{
      const values=(await fs.readFile(marker,'utf8')).split('\n');return values.length===3?values:false;
    },'The real owned workload records its process and original target environment',240000);
    ownedPid=Number(started[0]);assert(ownedPid>0&&alive(ownedPid));
    assert.equal(vscode.Uri.file(started[1]).fsPath,vscode.Uri.file(controller).fsPath);
    assert.equal(started[2],process.env.PERFCHECKER_NATIVE_JULIA_VERSION);
    // These are real user settings changes while the original owned process runs.
    // Cancellation must use that retained process, not the newly selected executable.
    await settings().update('runnerProject',nextController,vscode.ConfigurationTarget.WorkspaceFolder);
    await settings().update('scenarioProject',nextController,vscode.ConfigurationTarget.WorkspaceFolder);
    await settings().update('juliaExecutable',missingJulia,vscode.ConfigurationTarget.WorkspaceFolder);
    const workerAliveAfterSettingsChanges=alive(ownedPid);
    context.log('native-active-settings-before-cancel',{pid:ownedPid,workerAlive:workerAliveAfterSettingsChanges,
      changedKeys:['runnerProject','scenarioProject','juliaExecutable']});
    frame=await view(context);await observeSurface(context,'active-settings-before-cancel',frame);await frame.getByRole('button',{name:'Cancel',exact:true}).click();
    await eventually(async()=>/Cancelled after controller cleanup/.test(await frame.locator('#app .status').innerText()),'Cancellation finishes despite changed controller/runtime settings',120000);
    await eventually(()=>!alive(ownedPid),'The original owned worker is dead before any fixture cleanup',30000);
    assert.equal(settings().get('runnerProject'),nextController);assert.equal(settings().get('scenarioProject'),nextController);assert.equal(settings().get('juliaExecutable'),missingJulia);
    await assert.rejects(vscode.commands.executeCommand('perfchecker.discoverScenarios'),/ENOENT|spawn.*unavailable/i,
      'The next action uses the new runtime and reports its explicit unavailability');
    assert.equal(settings().get('juliaExecutable'),missingJulia,'A failed new action must not overwrite the user choice');
    context.proof('native-active-controller-runtime-settings',{nativeCancelClick:true,originalWorkerPid:ownedPid,
      originalTarget:started[1],originalRuntime:started[2],workerDeadBeforeFixtureCleanup:true,
      changedKeys:['runnerProject','scenarioProject','juliaExecutable'],workerAliveAfterSettingsChanges,
      terminationAttributedToCancel:workerAliveAfterSettingsChanges,newSettingsPreserved:true,
      nextActionNewRuntimeUnavailableExplained:true,scope:'Cancellation of an already spawned process; not an assertion of cancellation on every setting change'});
  }finally{
    await vscode.commands.executeCommand('perfchecker.cancelInvestigation');
    if(ownedPid)await eventually(()=>!alive(ownedPid),'The owned worker must finish before restoring its fixture',30000);
    for(const key of keys)await settings().update(key,previous[key],vscode.ConfigurationTarget.WorkspaceFolder);
    await fs.writeFile(catalog,original);await fs.rm(factory,{force:true});await fs.rm(marker,{force:true});
  }
};
