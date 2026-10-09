// Compatibility of the candidate VSIX with the registered General 1.0.0 tree.
// APIs checked against v1.0.0: testitems CLI (src/testitems.jl), FeatureSpec /
// plan_suite / run_suite / read_run_bundle (src/suites.jl, src/protocol.jl),
// advise (src/advice.jl), _advisor_evidence / chat_advice / implement_advice
// (src/advisor.jl) and HTTPAdvisorExt. No canonical summaries are invented.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {createHash}=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const documents=['manifest.json','measurement-definitions.json','observations.jsonl','diagnostics.jsonl','artifacts.json','integrity.json'];
async function eventually(read,label,timeout=180000){const until=Date.now()+timeout;do{const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<until);throw new Error(label);}
function contract(context){assert.equal(context.core.mode,'general100');assert.equal(context.core.version,'1.0.0');assert.equal(context.core.tree,'7af0cc74194b953c5e998efd7523f0c5f455e395');assert.equal(context.core.registered,true);}
async function core(context,code,args=[]){const result=await execute(process.env.PERFCHECKER_NATIVE_JULIA,['--startup-file=no',`--project=${context.controller}`,'-e',code,...args],
  {timeout:180000,windowsHide:true,env:{...process.env,JULIA_LOAD_PATH:'@'+path.delimiter+'@stdlib'}});return JSON.parse(result.stdout);}
async function prerequisites(context){
  const {vscode,workspace,windowPage,proof}=context,uri=vscode.Uri.file(workspace),settings=vscode.workspace.getConfiguration('perfchecker',uri);
  const tracked=[path.join(context.controller,'Project.toml'),path.join(context.controller,'Manifest.toml'),path.join(workspace,'.vscode','settings.json')];
  const hashes=async()=>Object.fromEntries(await Promise.all(tracked.map(async file=>[file,hash(await fs.readFile(file))])));const before=await hashes();
  const files=vscode.workspace.getConfiguration('files',uri),oldDialog=files.inspect('simpleDialog.enable')?.globalValue;
  let guidedResult;
  try{
    await files.update('simpleDialog.enable',true,vscode.ConfigurationTarget.Global);
    // Observe rejection from creation: a real failed version check must not become unhandled.
    const guided=Promise.resolve(vscode.commands.executeCommand('perfchecker.initialize',uri)).then(()=>({returned:true}),error=>({error}));
    const picker=windowPage.locator('.quick-input-widget');await picker.waitFor({state:'visible',timeout:180000});
    await picker.locator('.monaco-list-row').filter({hasText:'Use an existing controller'}).click();
    const dialog=windowPage.locator('.quick-input-widget').filter({has:windowPage.locator('.quick-input-title').filter({hasText:/^PerfChecker · Choose controller project$/})});
    const input=dialog.locator('input[type="text"]');await input.waitFor({state:'visible',timeout:60000});
    await input.fill(context.controller+path.sep);await input.press('Enter');await input.waitFor({state:'hidden',timeout:60000});
    guidedResult=await guided;
    assert(guidedResult.error,'Choosing the real registered100 controller must fail its actual minimum-version check');
    assert.match(String(guidedResult.error),/requires registered PerfChecker 1\.0\.1/);
  }finally{await files.update('simpleDialog.enable',oldDialog,vscode.ConfigurationTarget.Global);}
  assert.deepEqual(await hashes(),before,'Real guided version refusal changes neither the registered controller nor workspace settings');
  proof('native-general100-guided-prerequisite',{minimum:'1.0.1',actualCore:context.core,nativeExistingControllerPicker:true,
    actualVersionCheckRejected:true,error:String(guidedResult.error),upgradeNotAccepted:true,bytesPreserved:true,positiveSetupQualified:false});
  const notebook=path.join(workspace,'perf','notebooks','general100-prerequisite.jl');
  const requested=vscode.commands.executeCommand('perfchecker.newNotebook',vscode.Uri.file(notebook),{kind:'suite'});
  await windowPage.getByRole('button',{name:'Install Pluto environment',exact:true}).waitFor({timeout:180000});
  assert.match(await windowPage.locator('.monaco-dialog-box').innerText(),/PerfChecker 1\.0\.1.*PerfCheckerPluto 1\.0\.1/s);
  await windowPage.keyboard.press('Escape');assert.equal(await requested,undefined);
  assert.equal(await fs.stat(path.join(workspace,'perf','pluto','Project.toml')).then(()=>true).catch(error=>{if(error.code==='ENOENT')return false;throw error;}),false);
  assert.deepEqual(await hashes(),before);
  proof('native-general100-pluto-prerequisite',{minimumCore:'1.0.1',minimumCompanion:'1.0.1',explicitNativeDialog:true,installationDeclined:true,noEnvironmentCreated:true,positivePlutoQualified:false});
  assert.equal(settings.get('runnerProject'),context.controller);
}
exports.run=async context=>{
  contract(context);
  const controllerHashes=async()=>Object.fromEntries(await Promise.all(['Project.toml','Manifest.toml'].map(async name=>[name,hash(await fs.readFile(path.join(context.controller,name)))])));
  const controllerBefore=await controllerHashes();
  const capability=await core(context,'using PerfChecker,Pkg; info=Pkg.dependencies()[Base.PkgId(PerfChecker).uuid]; names=(:perfchecker_main,:plan_suite,:run_suite,:read_run_bundle,:advise,:chat_advice,:implement_advice,:_advisor_evidence); @assert all(name->isdefined(PerfChecker,name),names); @assert Base.pkgversion(PerfChecker)==v"1.0.0"; @assert info.is_tracking_registry; @assert string(info.tree_hash)=="7af0cc74194b953c5e998efd7523f0c5f455e395"; PerfChecker.JSON.print(Dict("version"=>string(Base.pkgversion(PerfChecker)),"tree"=>string(info.tree_hash),"registered"=>info.is_tracking_registry,"apis"=>string.(names)))');
  context.proof('native-general100-real-registry-capabilities',capability);
  await prerequisites(context);
  await context.measureTestItem({samples:1,proofName:'native-general100-testing-evidence'});
  const {vscode,workspace,findFrame,proof}=context;
  await vscode.commands.executeCommand('perfchecker.openDesignerForWorkspace',vscode.Uri.file(workspace));
  let designer=await findFrame('#cards');await designer.locator('#reset-filters').click();await designer.locator('#clear-all').click();
  const card=designer.locator('#cards .card').filter({has:designer.locator('.package',{hasText:/^PerfCheckerNativeFixture$/})}).filter({has:designer.locator('strong',{hasText:/^sum_squares$/})}).first();
  const check=card.locator('.check-option.ready').filter({hasText:'BenchmarkTools'});assert.equal(await check.count(),1);await check.locator('input').check();
  assert.match(await designer.locator('#count').innerText(),/^1 selected/);await designer.locator('#open-after-run').uncheck();await designer.locator('#run').click();
  const reports=path.join(workspace,'perf','results','vscode');
  await eventually(async()=>{const file=await fs.readFile(path.join(reports,'suite-result.json')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});if(!file)return false;let value;try{value=JSON.parse(file);}catch(error){if(error instanceof SyntaxError)return false;throw error;}return value.runs.length===1&&value.runs[0].status==='pass'&&!(await designer.locator('#run').isDisabled());},'General100 completes the single real selected suite',360000);
  await vscode.commands.executeCommand('perfchecker.openOutput');const output=await findFrame('button[data-report="suite-result.json"]');
  assert(await output.locator('[data-result-item]').count()>0);
  const temporal=output.locator('.chart-card').filter({has:output.locator('header strong',{hasText:/^julia\.wall\.time distribution$/})}).first().locator('.distribution-view');
  assert.equal(await temporal.count(),1,'Use the actual timing distribution, not constant allocation or GC measurements');
  const full={min:Number(await temporal.getAttribute('data-full-min')),max:Number(await temporal.getAttribute('data-full-max'))};
  assert(full.max>full.min,'The actual temporal samples must have nonzero extent');
  const range=async()=>({min:Number(await temporal.locator('svg').getAttribute('data-current-min')),max:Number(await temporal.locator('svg').getAttribute('data-current-max'))});
  const fit=temporal.getByRole('button',{name:'Fit all samples',exact:true}),zoom=temporal.getByRole('button',{name:'Zoom in',exact:true});
  assert.deepEqual(await range(),full);assert(await fit.isDisabled());assert(await zoom.isEnabled());
  const points=temporal.locator('.sample'),pointCount=await points.count();assert(pointCount>1);await points.first().focus();
  assert((await temporal.locator('.plot-detail').innerText()).includes('sorted sample'));
  const before=await fs.readFile(path.join(reports,'version-series.json'));
  await zoom.click();const zoomed=await eventually(async()=>{const current=await range();return current.max-current.min<full.max-full.min&&await fit.isEnabled()&&current;},'Real temporal Zoom narrows the range and enables Fit');
  assert(zoomed.min>=full.min&&zoomed.max<=full.max);await fit.click();
  await eventually(async()=>{const current=await range();return current.min===full.min&&current.max===full.max&&await fit.isDisabled();},'Native Fit restores the exact initial full temporal range');
  assert.equal(await points.count(),pointCount);assert.deepEqual(await fs.readFile(path.join(reports,'version-series.json')),before);
  proof('native-general100-suite-output',{selectedChecks:1,collector:'BenchmarkTools',realRunSelection:true,realSavedOutput:true,
    metric:'julia.wall.time',pointFocus:true,pointCount,fullRange:full,zoomedRange:zoomed,fitRestoresExactFullRange:true,reportBytesPreserved:true,noComparisonGainClaimed:true});
  await require('./native-mcp-controls.cjs').run(context,{general100:true});
  assert.deepEqual(await controllerHashes(),controllerBefore,'Every native compatibility action preserves the pinned registered controller bytes');
  context.proof('native-general100-controller-preserved',{core:context.core,hashes:controllerBefore,noUpgrade:true,noGitFallback:true});
};

// Real legacy Investigation evidence: recommendations only, not canonical measurements.
exports.measuredEvidence=async context=>{
  contract(context);const {vscode,workspace,findFrame}=context,settings=vscode.workspace.getConfiguration('perfchecker',vscode.Uri.file(workspace));
  const root=path.resolve(workspace,settings.get('investigationReports','perf/results/investigations'));
  const entries=()=>fs.readdir(root).catch(error=>{if(error.code==='ENOENT')return [];throw error;});const previous=new Set(await entries());
  await vscode.commands.executeCommand('perfchecker.openInvestigations');const frame=await findFrame('#app nav[aria-label="Investigation views"]');
  await frame.getByRole('button',{name:'Discover tests',exact:true}).click();
  await eventually(async()=>!(await frame.locator('#app .status').getAttribute('class')).includes('busy')&&await frame.locator('.scenario-title strong').filter({hasText:/^advisor_sum_squares$/}).count()===1,'General100 discovers the actual advisor scenario',240000);
  await frame.getByRole('button',{name:'Scenarios',exact:true}).click();await frame.getByRole('button',{name:'Clear selection',exact:true}).click();
  const card=frame.locator('article.card').filter({has:frame.locator('.scenario-title strong',{hasText:/^advisor_sum_squares$/})}).filter({has:frame.locator('.implementation',{hasText:/^allocating$/})});
  assert.equal(await card.count(),1);await card.locator('.scenario-title input').check();await frame.getByRole('button',{name:'Measure selected',exact:true}).click();
  let result;
  await eventually(async()=>{for(const id of await entries()){
    if(previous.has(id))continue;const file=path.join(root,id,'run.json'),adviceFile=path.join(root,id,'advice','advice.json');
    const bytes=await fs.readFile(file).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});if(!bytes)continue;
    let report;try{report=JSON.parse(bytes);}catch(error){if(error instanceof SyntaxError)continue;throw error;}if(report.schema_version!=='perfchecker-scenario-run/1')continue;
    assert.equal(report.runs.length,1);assert.equal(report.runs[0].scenario.id,'advisor_sum_squares');assert.equal(report.runs[0].collector,'benchmark');
    assert.equal(report.runs[0].qualification.correctness,'passed');assert(report.runs[0].summaries.some(row=>row.samples===3));
    const adviceBytes=await fs.readFile(adviceFile).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});if(!adviceBytes)continue;
    const advice=JSON.parse(adviceBytes);assert.equal(Object.hasOwn(advice,'measurement_summaries'),false);assert(advice.recommendations.length>0);
    const projection=await core(context,'using PerfChecker; advice=read_advice(ARGS[1]); config=AdvisorConfig(protocol=:mcp_http,mcp_tool="ask_perfchecker",mcp_response=:text); evidence=PerfChecker._advisor_evidence(advice,config); PerfChecker.JSON.print(Dict("evidence"=>evidence,"characters"=>length(PerfChecker.JSON.json(evidence)),"budget"=>config.max_evidence_chars))',[adviceFile]);
    assert(projection.evidence.length>0);assert(projection.characters<=projection.budget);assert(projection.evidence.every(row=>typeof row.rule==='string'&&!Object.hasOwn(row,'metric')));
    result={id,file,adviceFile,evidence:projection.evidence,recommendations:advice.recommendations,evidenceCharacters:projection.characters,evidenceBudget:projection.budget,runSha256:hash(bytes),adviceSha256:hash(adviceBytes)};
    return !(await frame.locator('#app .status').getAttribute('class')).includes('busy');
  }return false;},'General100 saves its real measurements and legacy deterministic advice',360000);
  return result;
};
exports.suiteRefusal=async(context,{state,calls,receipts})=>{
  contract(context);const {vscode,workspace,findFrame,proof}=context,root=await fs.realpath(path.join(workspace,'perf','results','vscode'));
  const series=JSON.parse(await fs.readFile(path.join(root,'version-series.json'))),directory=await fs.realpath(path.join(root,'bundles','run-'+series.run_id));
  const relative=path.relative(root,directory);assert(relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));
  const files=[...documents.map(name=>path.join(directory,name)),...['suite-result.json','version-series.json'].map(name=>path.join(root,name))];
  const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[path.relative(root,file),hash(await fs.readFile(file))])));const before=await hashes();
  const projection=await core(context,'using PerfChecker; bundle=read_run_bundle(ARGS[1];require_integrity=true); advice=advise(bundle); @assert !haskey(advice,"measurement_summaries"); PerfChecker.JSON.print(Dict("version"=>string(Base.pkgversion(PerfChecker)),"canonicalSummariesAvailable"=>false))',[directory]);
  assert.equal(projection.version,'1.0.0');const beforeCalls=calls.length,beforeReceipts=receipts.length;
  await vscode.commands.executeCommand('perfchecker.openChat');const chat=await findFrame('#chat-root');await chat.getByRole('tab',{name:'01 · Advice',exact:true}).click();
  const entry=await eventually(async()=>(await state()).evidence.find(item=>item.id.startsWith('suite:')&&JSON.parse(item.id.slice(6))[1]===series.run_id&&!item.unavailable),'The real General100 bundle appears in Chat');
  assert.equal(JSON.parse(entry.id.slice(6))[0],vscode.Uri.file(workspace).toString());
  await chat.getByRole('combobox',{name:'Attach saved evidence',exact:true}).selectOption(entry.id);
  await eventually(async()=>{const value=await state();return value.evidenceId===entry.id&&!value.busy&&value.messages.length===0;},'Suite selection is local and idle');
  assert.equal(calls.length,beforeCalls);assert.equal(receipts.length,beforeReceipts);
  await chat.locator('#chat-question').fill('Explain the saved suite without inventing canonical measurements.');await chat.getByRole('button',{name:'Send question',exact:true}).click();
  await eventually(async()=>{const value=await state();return !value.busy&&/1\.0\.0 does not provide/.test(value.status)&&/No measurements were sent/.test(value.status);},'General100 explicitly refuses canonical Suite transmission');
  assert.equal(calls.length,beforeCalls);assert.equal(receipts.length,beforeReceipts);assert.deepEqual((await state()).messages,[]);assert.deepEqual(await hashes(),before);
  proof('native-general100-suite-canonical-refusal',{runId:series.run_id,actualCoreProjection:projection,nativePicker:true,newProviderRequests:0,noInventedSummaries:true,uiIdle:true,noConversationRecorded:true,protocolAndIdentityHashes:before});
  let original;
  try{original=await fs.readFile(path.join(directory,'observations.jsonl'));await fs.writeFile(path.join(directory,'observations.jsonl'),Buffer.concat([original,Buffer.from('\n')]));
    await chat.locator('#chat-question').fill('Do not send the modified bundle.');await chat.getByRole('button',{name:'Send question',exact:true}).click();
    await eventually(async()=>{const value=await state();return !value.busy&&/byte integrity check.*No measurements were sent/.test(value.status);},'General100 also refuses actual bundle corruption before provider');
    assert.equal(calls.length,beforeCalls);assert.equal(receipts.length,beforeReceipts);assert.deepEqual((await state()).messages,[]);
    const changed={...before,[path.relative(root,path.join(directory,'observations.jsonl'))]:hash(Buffer.concat([original,Buffer.from('\n')]))};assert.deepEqual(await hashes(),changed);
    proof('native-general100-suite-corruption-refusal',{runId:series.run_id,actualByteChange:true,newProviderRequests:0,identityReportsPreserved:true});
  }finally{if(original)await fs.writeFile(path.join(directory,'observations.jsonl'),original);}
  assert.deepEqual(await hashes(),before);await chat.getByRole('combobox',{name:'Attach saved evidence',exact:true}).selectOption('');
  await eventually(async()=>{const value=await state();return value.evidenceId===''&&!value.busy&&value.messages.length===0;},'Restore configuration-only Chat after General100 refusal');
  proof('native-general100-suite-restored',{runId:series.run_id,allEightHashesPreserved:true,hashes:before});return chat;
};
