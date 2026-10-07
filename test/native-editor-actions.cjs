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

async function resource(context,workspace,controller,threads){
  const {vscode,windowPage}=context,uri=vscode.Uri.file(workspace);
  const settings=vscode.workspace.getConfiguration('perfchecker',uri);
  const keys=['runnerProject','scenarioProject','juliaExecutable','scenarioCatalog','analysisTools','scenarioThreads','investigationReports'];
  const previous=Object.fromEntries(keys.map(key=>[key,settings.inspect(key)?.workspaceFolderValue]));
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
      await settings.update(key,value,vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',uri);
    let frame=await view(context),root=path.join(workspace,'perf','results','editor-actions'),before=await reports(root);
    await frame.getByRole('button',{name:'Discover tests',exact:true}).click();
    const discovery=await reportAfter(root,before,'discovery');
    assert(discovery.payload.declared.some(item=>item.id==='native_editor_branch'));
    assert(discovery.payload.candidates.length,'The actual TestItem fixture exposes a proposal CodeLens');

    const candidate=discovery.payload.candidates[0];
    await vscode.commands.executeCommand('perfchecker.openInvestigationSource',candidate.origin.file,candidate.origin.line);
    const prepareLens=windowPage.locator('.codelens-decoration a').filter({hasText:'Prepare shared performance case'}).first();
    await prepareLens.waitFor({state:'visible',timeout:60000});await prepareLens.click();
    await eventually(()=>vscode.window.activeTextEditor?.document.isUntitled,'The real proposal CodeLens opens an untitled shared-case draft');
    assert.match(vscode.window.activeTextEditor.document.getText(),/prepare/);
    assert.match(vscode.window.activeTextEditor.document.getText(),/verify/);

    const sourceUri=vscode.Uri.file(factory);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sourceUri),
      {preview:false,selection:new vscode.Range(0,0,0,0)});
    const lens=windowPage.locator('.codelens-decoration a').filter({hasText:'Diagnose native_editor_branch · conditional'});
    await lens.waitFor({state:'visible',timeout:60000});before=await reports(root);await lens.click();
    const diagnosis=await reportAfter(root,before,'diagnosis');
    const record=diagnosis.payload.records.find(item=>item.scenario==='native_editor_branch');
    assert(record,'The clicked CodeLens diagnoses its own selected scenario');
    assert.equal(record.tool,'jet');assert.equal(record.status,'complete');assert.equal(record.correctness.status,'passed');
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
    await action.waitFor({state:'visible',timeout:30000});await action.click();
    frame=await context.findFrame('#app');
    await eventually(async()=>(await frame.locator('body').innerText()).includes('native_editor_branch'),
      'The chosen native quick fix opens the evidence for the same workspace');
    assert.equal(await fs.readFile(factory,'utf8'),source,'Quick fix opens evidence without editing source');
    assert.equal(settings.get('scenarioProject'),controller);
    context.proof('native-codelens-and-quickfix',{workspace:path.basename(workspace),controller,
      sourceUri:sourceUri.toString(),sourceSha256:sha(Buffer.from(source)),threads,
      proposalCodeLensNativeClick:true,diagnosisCodeLensNativeClick:true,quickFixNativeChoice:true,
      diagnosticLine:finding.location.line,rule:finding.rule_id,report:diagnosis.file,
      reportSha256:sha(await fs.readFile(diagnosis.file)),sourceUnchanged:true});
  }finally{
    await vscode.commands.executeCommand('perfchecker.cancelInvestigation');
    {
      const current=await view(context);
      await eventually(async()=>!((await current.locator('#app .status').getAttribute('class'))||'').includes('busy'),
        'Editor-action workers finish before restoring their fixture');
    }
    for(const key of keys)await settings.update(key,previous[key],vscode.ConfigurationTarget.WorkspaceFolder);
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
    await resource(context,workspace,controller,1);
    await fs.mkdir(path.join(second,'test'),{recursive:true});
    await fs.copyFile(path.join(workspace,'test','performance.jl'),path.join(second,'test','performance.jl'));
    const secondController=path.join(second,'perf','controller');await fs.mkdir(secondController,{recursive:true});
    for(const file of ['Project.toml','Manifest.toml'])await fs.copyFile(path.join(controller,file),path.join(secondController,file));
    added=vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length,0,{uri:secondUri,name:'Editor action second workspace'});
    assert(added);await eventually(()=>vscode.workspace.workspaceFolders.some(folder=>folder.uri.toString()===secondUri.toString()),
      'The second native workspace is actually present');
    await resource(context,second,secondController,2);
  }finally{
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(workspace));
    if(added){const index=vscode.workspace.workspaceFolders.findIndex(folder=>folder.uri.toString()===secondUri.toString());
      if(index>=0)vscode.workspace.updateWorkspaceFolders(index,1);}
    await editor.update('codeLens',oldLens,vscode.ConfigurationTarget.Global);
  }
};

exports.runTestItems=async context=>{
  const {vscode,workspace}=context,settings=vscode.workspace.getConfiguration('perfchecker',vscode.Uri.file(workspace));
  const keys=['testItemTags','testItemExcludeTags','testItemSamples'],previous=Object.fromEntries(keys.map(key=>[key,settings.inspect(key)?.workspaceFolderValue]));
  const file=path.join(workspace,'test','native-tags.jl'),marker=path.join(workspace,'test','native-tags-pids.txt');
  const storage=path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','native-testitems');
  const body='using TestItems\n'+[
    ['Native tagged inclusion',':nativeinclude','wanted'],
    ['Native tagged exclusion',':nativeinclude,:nativeexclude','excluded'],
    ['Native other tag',':nativeother','other'],
  ].map(([name,tags,role])=>`@testitem "${name}" tags=[${tags}] begin\n    using Test\n    open(joinpath(@__DIR__,"native-tags-pids.txt"),"a") do io\n        println(io,"${role}:",getpid())\n    end\n    @test sum(1:10)==55\nend\n`).join('');
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
    const measured=await context.measureTestItem({name:'Native tagged inclusion',file:'test/native-tags.jl',samples:2,
      retainName:'native-tagged-testitem',proofName:'native-testitem-tagged-current-evidence'});
    const lines=(await fs.readFile(marker,'utf8')).trim().split(/\r?\n/);
    assert.equal(lines.length,2,'Exactly the configured samples execute');
    assert(lines.every(line=>line.startsWith('wanted:')),'Excluded and other-tag test bodies never execute');
    const pids=lines.map(line=>Number(line.split(':')[1]));assert.equal(new Set(pids).size,2,'Samples execute in distinct fresh workers');
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
    frame=await view(context);await frame.getByRole('button',{name:'Cancel',exact:true}).click();
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
