const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const documents=['manifest.json','measurement-definitions.json','observations.jsonl','diagnostics.jsonl','artifacts.json','integrity.json'];
async function eventually(callback,label,timeout=180000){
  const until=Date.now()+timeout;
  do {const result=await callback();if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<until);
  throw new Error(label);
}

// The driver verifies the exact Core version and source tree before this host.
// General1.0.0 has its separately executable CLI integration test.
exports.run=async(context,{calls,receipts,providerErrors,state,setAttached})=>{
  const {vscode,workspace,findFrame,proof}=context,uri=vscode.Uri.file(workspace);
  assert.equal(context.core.version,process.env.PERFCHECKER_NATIVE_CORE_VERSION,
    'The native Suite evidence uses the exact Core version already verified by the driver');
  const settings=vscode.workspace.getConfiguration('perfchecker',uri);
  const reports=path.resolve(workspace,settings.get('reports','perf/results/vscode'));
  assert(!path.relative(workspace,reports).startsWith('..')&&!path.isAbsolute(path.relative(workspace,reports)));
  const previous=await fs.readFile(path.join(reports,'suite-result.json')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  await vscode.commands.executeCommand('perfchecker.openDesignerForWorkspace',uri);
  const designer=await findFrame('#cards',{allowAttached:true});
  await eventually(async()=>await designer.locator('#check-types label').count()>0&&await designer.locator('#cards .card').count()>0,
    'The real controller supplies the suite plan before Run selection',360000);
  await designer.locator('#reset-filters').click();await designer.locator('#clear-all').click();
  const card=designer.locator('#cards .card')
    .filter({has:designer.locator('.package',{hasText:/^PerfCheckerNativeFixture$/})})
    .filter({has:designer.locator('strong',{hasText:/^sum_squares$/})}).first();
  assert.equal(await card.count(),1);
  const check=card.locator('.check-option.ready').filter({hasText:'BenchmarkTools'});
  assert.equal(await check.count(),1);await check.locator('input').check();
  assert.match(await designer.locator('#count').innerText(),/^1 selected/);
  await designer.locator('#open-after-run').uncheck();await designer.locator('#run').click();
  let suite;
  await eventually(async()=>{
    const bytes=await fs.readFile(path.join(reports,'suite-result.json')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
    if(!bytes||bytes.equals(previous??Buffer.alloc(0)))return false;
    try{suite=JSON.parse(bytes);}catch(error){if(error instanceof SyntaxError)return false;throw error;}
    return suite.schema_version==='perfchecker-suite-result/1'&&suite.runs.length===1&&suite.runs[0].status==='pass'&&!(await designer.locator('#run').isDisabled());
  },'The one selected real BenchmarkTools suite check generates its saved report',360000);
  assert.equal(suite.runs[0].package,'PerfCheckerNativeFixture');
  assert.equal(suite.runs[0].feature,'sum_squares_benchmark');
  const series=JSON.parse(await fs.readFile(path.join(reports,'version-series.json')));
  assert.equal(series.schema_version,'perfchecker-version-series/1');assert.match(series.run_id,/^[a-f\d-]{36}$/);
  const workspaceReal=await fs.realpath(workspace),reportsReal=await fs.realpath(reports);
  const reportsRelative=path.relative(workspaceReal,reportsReal);
  assert(reportsRelative!=='..'&&!reportsRelative.startsWith('..'+path.sep)&&!path.isAbsolute(reportsRelative));
  const directory=await fs.realpath(path.join(reports,'bundles','run-'+series.run_id));
  const bundleRelative=path.relative(reportsReal,directory);
  assert(bundleRelative!=='..'&&!bundleRelative.startsWith('..'+path.sep)&&!path.isAbsolute(bundleRelative));
  const tracked=[...documents.map(name=>({name:'bundle/'+name,file:path.join(directory,name)})),
    ...['suite-result.json','version-series.json'].map(name=>({name,file:path.join(reportsReal,name)}))];
  const sourceHashes=async()=>Object.fromEntries(await Promise.all(tracked.map(async({name,file})=>[name,hash(await fs.readFile(file))])));
  const before=await sourceHashes();
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json')));
  assert.equal(manifest.plan.runs.length,1);assert.equal(manifest.plan.runs[0].backend,'benchmark');
  assert.equal(manifest.plan.runs[0].feature,suite.runs[0].feature);
  // Independent actual Core projection is the oracle. No advice, series or
  // measurement row is manufactured by the host qualification.
  const projected=await execute(process.env.PERFCHECKER_NATIVE_JULIA,['--startup-file=no',`--project=${context.controller}`,'-e',
    'using PerfChecker; bundle=read_run_bundle(ARGS[1];require_integrity=true); advice=advise(bundle); @assert haskey(advice,"measurement_summaries"); config=PerfChecker.AdvisorConfig(protocol=:mcp_http,mcp_tool="ask_perfchecker",mcp_response=:text); evidence=PerfChecker._advisor_evidence(advice,config); serialized=PerfChecker.JSON.json(evidence); PerfChecker.JSON.print(Dict("version"=>string(Base.pkgversion(PerfChecker)),"advice"=>advice,"evidence"=>evidence,"characters"=>length(serialized),"budget"=>config.max_evidence_chars))',directory],
    {windowsHide:true,timeout:180000,env:{...process.env,JULIA_LOAD_PATH:'@'+path.delimiter+'@stdlib'}});
  const expected=JSON.parse(projected.stdout);assert.equal(expected.version,context.core.version);
  assert.equal(expected.budget,12000);assert(expected.characters<=expected.budget);
  const measured=expected.evidence.filter(row=>row.kind==='measurement');assert(measured.length>0);
  const observations=(await fs.readFile(path.join(directory,'observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  for(const row of measured){assert.equal(row.run_id,series.run_id);assert.equal(row.collector,'benchmark');
    assert(row.record_count>0&&row.record_count<=3);assert.equal(row.bundle_status,'complete');
    assert.equal(row.record_semantics,'operation_measurement');assert(row.unit&&row.measurement_definition&&row.correctness_scope);
    assert(observations.some(record=>record.measurement_definition===row.measurement_definition&&record.metric===row.metric&&record.unit===row.unit));
  }
  proof('native-mcp-suite-generated-evidence',{runId:series.run_id,realRunSelection:true,selectedChecks:1,
    collector:'BenchmarkTools',maximumSamples:3,core:context.core,protocolHashes:before,
    actualAdviceRecommendations:expected.advice.recommendations,
    performanceComparison:'not established; small transport fixture, no measured gain claimed'});
  const beforeCalls=calls.length,beforeOpenReceipts=receipts.length;
  const question='native suite evidence probe: explain only the saved quantities and their small-sample qualification; no gain is established.';
  const sourceFiles=await Promise.all(['perf/sum.jl','src/PerfCheckerNativeFixture.jl'].map(name=>fs.readFile(path.join(workspace,name),'utf8')));
  const forbidden=[workspace,workspaceReal,context.controller,reports,reportsReal,directory].flatMap(value=>
    [value,value.replace(/\\/g,'/'),value.replace(/\//g,'\\'),vscode.Uri.file(value).toString()]);
  const sourceFragments=sourceFiles.flatMap(text=>[text,...text.split(/\r?\n/).filter(line=>line.trim().length>=24)]);
  const strings=value=>typeof value==='string'?[value]:value&&typeof value==='object'?Object.values(value).flatMap(strings):[];
  let inspectedPayloads=0,payloadSha256;
  const inspectPayload=(body,projection)=>{
    assert.deepEqual(Object.keys(projection).sort(),['allowed_experiments','conversation','evidence'].sort());
    assert.deepEqual(projection.allowed_experiments,[]);assert.deepEqual(projection.conversation,[{role:'user',content:question}]);
    assert.deepEqual(projection.evidence,expected.evidence);
    assert([...JSON.stringify(projection.evidence)].length<=expected.budget);
    assert.equal(new Set(projection.evidence.map(row=>row.id)).size,projection.evidence.length);
    // Inspect every JSON-RPC string and the decoded evidence, including metadata
    // and non-prompt arguments. Escaped/URI paths and actual source lines cannot hide there.
    for(const text of [...strings(body),...strings(projection)]){
      for(const token of [...forbidden,...sourceFragments]){
        assert(!text.includes(token)&&!text.includes(JSON.stringify(token).slice(1,-1)),'The complete Suite payload contains no local location or raw fixture source');
      }
      assert(!/(?:^|[\s"'=])(?:[A-Za-z]:[\\/]|\/[A-Za-z0-9_.-]+[\\/])/.test(text),'No absolute filesystem path appears anywhere in the Suite payload');
    }
    inspectedPayloads++;payloadSha256=hash(JSON.stringify(body));
  };
  let chat,originalObservations,corrupted=false,primaryError;
  try{
    await vscode.commands.executeCommand('perfchecker.openChat');chat=await findFrame('#chat-root');
    await chat.getByRole('tab',{name:'01 · Advice',exact:true}).click();
    const entry=await eventually(async()=>(await state()).evidence.find(item=>item.id.startsWith('suite:')&&item.id.includes(series.run_id)&&!item.unavailable),
      'Chat refresh exposes the exact generated Suite run before its selection');
    assert(entry&&!entry.unavailable,'The real picker exposes the generated bundle by explicit workspace/run identity');
    assert(entry.id.includes(uri.toString()));
    assert.equal(receipts.length,beforeOpenReceipts,'Open Chat contacts no provider');
    await chat.getByRole('combobox',{name:'Attach saved evidence',exact:true}).selectOption(entry.id);
    await eventually(async()=>{const value=await state();return value.evidenceId===entry.id&&!value.busy&&value.messages.length===0;},'Native Suite selection stays idle');
    assert.equal(calls.length,beforeCalls);assert.equal(receipts.length,beforeOpenReceipts);
    assert.deepEqual(await sourceHashes(),before);
    setAttached({evidence:expected.evidence,evidenceBudget:expected.budget,inspectPayload});
    await chat.locator('#chat-question').fill(question);
    await chat.getByRole('button',{name:'Send question',exact:true}).click();
    await eventually(async()=>{assert.deepEqual(providerErrors,[]);const value=await state();return !value.busy&&value.messages.length===2;},'Actual Suite projection and the real MCP request complete');
    assert.equal(calls.length,beforeCalls+1);assert.deepEqual(calls.at(-1).evidenceIds,expected.evidence.map(row=>row.id));
    assert.equal(inspectedPayloads,1,'The complete real request was inspected before its controlled reply');
    assert(!calls.at(-1).prompt.includes(directory),'No raw bundle path is transmitted');
    assert.deepEqual(await sourceHashes(),before);
    proof('native-mcp-suite-selected-measurements',{runId:series.run_id,nativeSelector:true,noProviderOnOpenOrSelection:true,
      localProjectionOnSend:true,payloadObservedBeforeReply:true,canonicalMeasuredRows:measured,
      actualEvidenceIds:calls.at(-1).evidenceIds,projectionSha256:calls.at(-1).projectionSha256,
      evidenceCharacters:expected.characters,maxEvidenceCharacters:expected.budget,
      canonicalRowsAvailable:expected.advice.measurement_summaries.length,canonicalRowsSent:measured.length,
      completePayloadSha256:payloadSha256,completePayloadNoPathsOrRawSource:true,uniqueEvidenceIds:true,
      originalProtocolBytesPreserved:true,originalIdentityReportBytesPreserved:true,
      provider:'Controlled actual MCP transport; no agent inference or performance gain claimed'});
    await chat.getByRole('button',{name:'New conversation',exact:true}).click();
    await eventually(async()=>!(await state()).busy&&(await state()).messages.length===0,'Clear Suite conversation before integrity refusal');
    originalObservations=await fs.readFile(path.join(directory,'observations.jsonl'));
    const changedObservations=Buffer.concat([originalObservations,Buffer.from('\n')]);
    await fs.writeFile(path.join(directory,'observations.jsonl'),changedObservations);corrupted=true;
    const refusedHashes={...before,'bundle/observations.jsonl':hash(changedObservations)};
    assert.deepEqual(await sourceHashes(),refusedHashes,'Only the deliberate disposable observation corruption changes any source or identity report');
    const beforeRejectedCalls=calls.length,beforeRejectedReceipts=receipts.length;
    await chat.locator('#chat-question').fill('Do not send this modified bundle.');
    await chat.getByRole('button',{name:'Send question',exact:true}).click();
    await eventually(async()=>{const value=await state();return !value.busy&&/byte integrity check.*No measurements were sent/.test(value.status);},'A modified real bundle is refused before contacting MCP');
    assert.equal(calls.length,beforeRejectedCalls);assert.equal(receipts.length,beforeRejectedReceipts);
    assert.deepEqual((await state()).messages,[]);
    assert.deepEqual(await sourceHashes(),refusedHashes,'Refusal preserves both identity reports and every supplied bundle byte, including the deliberate corruption');
    proof('native-mcp-suite-tamper-refused',{runId:series.run_id,actualProtocolByteChange:true,refusedBeforeProvider:true,
      newProviderRequests:0,uiIdle:true,noConversationRecorded:true,originalIdentityReportBytesPreserved:true,
      sourceHashesAfterRefusal:refusedHashes,core:context.core});
  }catch(error){primaryError=error;throw error;}
  finally{
    const errors=[];
    try{if(corrupted)await fs.writeFile(path.join(directory,'observations.jsonl'),originalObservations);}catch(error){errors.push(error);}
    setAttached(undefined);
    try{if(chat){await chat.getByRole('combobox',{name:'Attach saved evidence',exact:true}).selectOption('');
      await eventually(async()=>!(await state()).busy&&(await state()).evidenceId===''&&(await state()).messages.length===0,'Restore configuration-only conversation after the Suite test');}}
    catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError([...(primaryError?[primaryError]:[]),...errors],'Native Suite evidence failed or could not restore its disposable fixture');
  }
  assert.deepEqual(await sourceHashes(),before,'The deliberately corrupted disposable bundle is restored byte-for-byte');
  proof('native-mcp-suite-original-restored',{runId:series.run_id,protocolHashes:before,identityReportsIncluded:true,restoredByteExact:true});
  return chat;
};
