// Real HTTP MCP transport and Julia workers, driven through the installed webview.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {execFile,spawn} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const {clickStudioAction}=require('./native-studio-controls.cjs');
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hold = async()=>{if(process.env.PERFCHECKER_NATIVE_VIDEO==='1')await delay(3000);};
async function eventually(read, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {if (await read()) return; await delay(100);}
  throw new Error(label);
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const processAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
function assertTemporaryCheckout(temporaryRoot,root,original){
  const relative=path.relative(temporaryRoot,root),parts=relative.split(path.sep);
  assert(relative&&!path.isAbsolute(relative)&&parts.length===2&&parts[0]!=='..'&&
    /^perfchecker-implementation-[^/\\]+$/.test(parts[0])&&parts[1]==='checkout',
    'Only the supplied disposable checkout is edited');
  assert.notEqual(root,original,'The provider never edits the original workspace');
  return relative;
}
async function ownedChatProcesses(log,heldSockets,snapshot,stage){
  const started=Date.now();
  let rows;
  if(process.platform==='win32'){
    assert.equal(heldSockets.length,1,'One actual provider request owns the cancellation probe socket');
    const socket=heldSockets[0];assert(!socket.destroyed,'The provider keeps the original connection open');
    const tuple={localAddress:socket.remoteAddress,localPort:socket.remotePort,
      remoteAddress:socket.localAddress,remotePort:socket.localPort};
    assert.equal(tuple.localAddress,'127.0.0.1');assert.equal(tuple.remoteAddress,'127.0.0.1');
    for(const key of ['localPort','remotePort'])assert(Number.isInteger(tuple[key])&&tuple[key]>0&&tuple[key]<65536);
    const before=await snapshot();
    let value;
    try{
      const {stdout}=await execute('powershell.exe',['-NoProfile','-Command',
        `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -like "julia*" } | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;executable=$_.ExecutablePath;createdAt=$_.CreationDate.ToUniversalTime().ToString('o');pidType=$_.ProcessId.GetType().FullName;parentType=$_.ParentProcessId.GetType().FullName;commandLength=([string]$_.CommandLine).Length;chatMarker=($_.CommandLine -match 'perfchecker-chat-');sourceArgument=($_.CommandLine -match '--source=');advisorWorker=($_.CommandLine -match 'advisor_worker\\.jl')} }); $tcp=@(Get-NetTCPConnection -State Established -ErrorAction Stop | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.RemoteAddress -eq '127.0.0.1' -and $_.LocalPort -eq ${tuple.localPort} -and $_.RemotePort -eq ${tuple.remotePort} } | ForEach-Object { @{pid=$_.OwningProcess;localAddress=$_.LocalAddress;localPort=$_.LocalPort;remoteAddress=$_.RemoteAddress;remotePort=$_.RemotePort;state=[string]$_.State} }); @{rows=$rows;connections=$tcp} | ConvertTo-Json -Depth 4 -Compress`]);
      value=JSON.parse(stdout);
    }catch(error){log('native-mcp-windows-query-failure',{stage,name:error.name,code:error.code,
      stderrBytes:Buffer.byteLength(error.stderr||''),queryMilliseconds:Date.now()-started});throw error;}
    rows=value.rows;assert(Array.isArray(rows));assert(Array.isArray(value.connections));
    const connection=value.connections.length===1?value.connections[0]:undefined;
    const worker=connection&&rows.find(row=>row.pid===connection.pid);
    const cli=worker&&rows.find(row=>row.pid===worker.parent&&row.parent===process.pid);
    const expectedExecutable=await fs.realpath(process.env.PERFCHECKER_NATIVE_JULIA);
    const identities=[];
    for(const row of [cli,worker].filter(Boolean)){
      assert.equal(typeof row.pid,'number');assert.equal(typeof row.parent,'number');
      assert(typeof row.createdAt==='string'&&/^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.createdAt)&&Number.isFinite(Date.parse(row.createdAt)),
        'Every retained process has a nonempty parseable ISO creation date');
      identities.push({pid:row.pid,canonicalExecutable:await fs.realpath(row.executable)});
    }
    const selectedJulia=identities.length===2&&identities.every(row=>row.canonicalExecutable.toLowerCase()===expectedExecutable.toLowerCase());
    const cliAlive=!!cli&&processAlive(cli.pid),workerAlive=!!worker&&processAlive(worker.pid);
    const after=await snapshot();
    log('native-mcp-owned-process-inventory',{stage,extensionHost:process.pid,tuple,connections:value.connections,
      queryMilliseconds:Date.now()-started,before,after,
      rows:rows.map(row=>({...row,pidJsonType:typeof row.pid,parentJsonType:typeof row.parent})),
      identities,expectedExecutable,selectedJulia,matchedCli:cli?.pid??null,matchedWorker:worker?.pid??null,
      cliAlive,workerAlive,heldSocketOpen:!socket.destroyed,commandArgumentsUnavailableAfterJuliaStartup:true});
    assert(connection&&connection.state==='Established'&&connection.localAddress===tuple.localAddress&&connection.remoteAddress===tuple.remoteAddress&&
      connection.localPort===tuple.localPort&&connection.remotePort===tuple.remotePort,'The exact retained HTTP connection identifies its actual worker');
    assert(before.pending===1&&after.pending===1&&before.uiBusy&&after.uiBusy&&!socket.destroyed,
      'The original provider request remains held across the physical ownership query');
    return cli&&worker&&selectedJulia&&cliAlive&&workerAlive?{cli:cli.pid,worker:worker.pid,cliCreatedAt:cli.createdAt,workerCreatedAt:worker.createdAt}:undefined;
  }else{
    const {stdout}=await execute('ps',['-eo','pid=,ppid=,args=']);
    rows=stdout.split('\n').map(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return match?{pid:Number(match[1]),parent:Number(match[2]),command:match[3]}:undefined;}).filter(Boolean);
  }
  const cli=rows.find(row=>row.parent===process.pid&&/perfchecker-chat-/.test(row.command||'')&&/--source=/.test(row.command||''));
  const worker=cli&&rows.find(row=>row.parent===cli.pid&&/advisor_worker\.jl/.test(row.command||''));
  // Keep the original ownership predicate. Physical inventory explains a
  // missing match without disclosing command lines or accepting another tree.
  log('native-mcp-owned-process-inventory',{extensionHost:process.pid,queryMilliseconds:Date.now()-started,
    rows:rows.filter(row=>process.platform==='win32'||/julia|perfchecker-chat-|advisor_worker\.jl/.test(row.command||''))
      .map(row=>({pid:Number(row.pid),parent:Number(row.parent),commandLength:(row.command||'').length,
        chatMarker:/perfchecker-chat-/.test(row.command||''),sourceArgument:/--source=/.test(row.command||''),
        advisorWorker:/advisor_worker\.jl/.test(row.command||''),extensionHostChild:row.parent===process.pid})),
    matchedCli:cli?Number(cli.pid):null,matchedWorker:worker?Number(worker.pid):null});
  return cli&&worker?{cli:Number(cli.pid),worker:Number(worker.pid)}:undefined;
}

async function measuredEvidence(context) {
  const root=path.resolve(context.workspace,context.vscode.workspace.getConfiguration('perfchecker',context.vscode.Uri.file(context.workspace)).get('investigationReports','perf/results/investigations'));
  const entries=()=>fs.readdir(root).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  const previousDiscovery=new Set(await entries());
  await context.vscode.commands.executeCommand('perfchecker.openInvestigations');
  let frame=await context.findFrame('#app nav[aria-label="Investigation views"]');
  await frame.getByRole('button',{name:'Discover tests',exact:true}).click();
  await eventually(async()=>!(await frame.locator('#app .status').getAttribute('class')).includes('busy')&&
    await frame.locator('.scenario-title strong').filter({hasText:/^advisor_sum_squares$/}).count()===1,'Actual Core discovers the distinct declared advisor allocation scenario',240000);
  let declared;
  for(const id of await entries()){
    if(previousDiscovery.has(id))continue;
    const bytes=await fs.readFile(path.join(root,id,'discovery.json')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
    if(!bytes)continue;
    const discovery=JSON.parse(bytes),matches=discovery.declared.filter(scenario=>scenario.id==='advisor_sum_squares'&&scenario.implementation==='allocating');
    if(!matches.length)continue;
    assert.equal(matches.length,1,'Discovery cannot ambiguously alias the advisor scenario');
    declared=matches[0];
    assert.equal(declared.catalog,'perf/advisor/scenarios.toml');
    assert.deepEqual(declared.collectors,['benchmark']);
    assert.equal(await fs.realpath(declared.source),await fs.realpath(path.join(context.workspace,'perf','cases.jl')));
    assert.deepEqual(discovery.declared.find(scenario=>scenario.id==='sum_squares'&&scenario.implementation==='allocating').collectors,
      ['benchmark','chairmark','profile','profile_alloc'],'The original catalogue retains all four collectors');
  }
  assert(declared,'The saved discovery must identify the exact single-collector catalogue before launch');
  context.proof('native-mcp-benchmark-catalog-discovery',{id:declared.id,implementation:declared.implementation,catalog:declared.catalog,
    source:declared.source,collectors:declared.collectors,originalFourCollectorsPreserved:true,assertedBeforeMeasurement:true});
  await frame.getByRole('button',{name:'Scenarios',exact:true}).click();
  await frame.getByRole('button',{name:'Clear selection',exact:true}).click();
  const selectedCard=frame.locator('article.card').filter({has:frame.locator('.scenario-title strong',{hasText:/^advisor_sum_squares$/})})
    .filter({has:frame.locator('.implementation',{hasText:/^allocating$/})});
  assert.equal(await selectedCard.count(),1,'Only the exact advisor declaration is selected');
  await selectedCard.locator('.scenario-title input').check();
  const before=new Set(await entries());
  await frame.getByRole('button',{name:'Measure selected',exact:true}).click();
  let measured;
  await eventually(async()=>{
    for(const id of await entries()){
      if(before.has(id))continue;
      const directory=path.join(root,id),file=path.join(directory,'run.json');
      const data=await fs.readFile(file).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(!data)continue;
      let report;
      try{report=JSON.parse(data);}catch(error){if(error instanceof SyntaxError)continue;throw error;}
      if(report.schema_version!=='perfchecker-scenario-run/1')continue;
      assert.equal(report.runs.length,1,'The explicitly selected MCP catalogue measures only BenchmarkTools');
      assert(report.runs.every(run=>run.scenario.id==='advisor_sum_squares'&&run.scenario.implementation==='allocating'&&run.collector==='benchmark'&&run.qualification.availability==='complete'&&run.qualification.correctness==='passed'));
      assert(report.runs[0].summaries.some(summary=>summary.metric==='julia.wall.time'&&summary.samples===100),'The real BenchmarkTools report contains 100 timing samples');
      const measurementProject=await fs.realpath(context.vscode.workspace.getConfiguration('perfchecker',context.vscode.Uri.file(context.workspace)).get('scenarioProject'));
      const manifests=await Promise.all(report.runs.map(run=>fs.readFile(path.join(directory,run.run_id,'manifest.json'),'utf8').then(JSON.parse)));
      const environments=manifests.flatMap(manifest=>manifest.environment_provenance);
      assert(environments.length>0,'The actual measurement retains its worker environment provenance');
      for(const environment of environments){
        assert.equal(await fs.realpath(environment.path),measurementProject,'Real measurements use the distinct selected worker environment');
        assert.equal(environment.project_sha256,hash(await fs.readFile(path.join(measurementProject,'Project.toml'))));
        assert.equal(environment.manifest_sha256,hash(await fs.readFile(path.join(measurementProject,'Manifest.toml'))));
        const packages=environment.resolved_packages.map(item=>item.name);
        assert(packages.includes('BenchmarkTools'),'The actual worker resolves its collector');
        assert(!packages.includes('PerfChecker')&&!packages.includes('HTTP'),'The measurement worker cannot supply the provider Core or HTTP dependencies');
      }
      const adviceBytes=await fs.readFile(path.join(directory,'advice','advice.json')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(!adviceBytes)continue;
      let advice;
      try{advice=JSON.parse(adviceBytes);}catch(error){if(error instanceof SyntaxError)continue;throw error;}
      assert.deepEqual(advice.recommendations,[],'The 100-sample passed report has no deterministic recommendation');
      const rawEvidence=advice.measurement_summaries;
      assert.equal(rawEvidence.length,3,'The actual saved advice retains all three canonical measured quantities');
      assert.deepEqual(rawEvidence.map(row=>[row.metric,row.unit]).sort(),[['julia.alloc.bytes','By'],['julia.alloc.count','1'],['julia.wall.time','s']]);
      const observations=(await fs.readFile(path.join(directory,report.runs[0].run_id,'observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      for(const row of rawEvidence){
        assert.match(row.id,/^measurement-[a-f0-9]{64}$/);
        assert.equal(row.run_id,report.runs[0].run_id);
        assert.equal(row.collector,'benchmark');assert.equal(row.record_count,100);
        assert.equal(row.record_semantics,'operation_measurement');assert.equal(row.aggregation,'sample');
        assert.equal(row.bundle_status,'complete');assert.equal(row.correctness,'passed');
        assert.equal(observations.filter(record=>record.measurement_definition===row.measurement_definition&&record.metric===row.metric&&record.unit===row.unit).length,row.record_count,'Summary count comes from the actual saved records');
      }
      const adviceFile=path.join(directory,'advice','advice.json');
      // The installed Core validates and serializes the canonical saved summaries.
      // No recommendation or measurement row is fabricated by this native test.
      const projected=await execute(process.env.PERFCHECKER_NATIVE_JULIA,
        ['--startup-file=no',`--project=${context.controller}`,'-e',
          'using PerfChecker; advice=PerfChecker.read_advice(ARGS[1]); config=PerfChecker.AdvisorConfig(protocol=:mcp_http,mcp_tool="ask_perfchecker",mcp_response=:text); evidence=PerfChecker._advisor_evidence(advice,config); serialized=PerfChecker.JSON.json(evidence); print(PerfChecker.JSON.json(Dict("evidence"=>evidence,"serialized"=>serialized,"characters"=>length(serialized),"budget"=>config.max_evidence_chars)))',adviceFile],
        {windowsHide:true,env:{...process.env,JULIA_LOAD_PATH:process.env.PERFCHECKER_LOAD_PATH||'@'+path.delimiter+'@stdlib'}});
      const projection=JSON.parse(projected.stdout),evidence=projection.evidence;
      assert.equal(new Set(evidence.map(row=>row.id)).size,evidence.length,'The Core projection has unique evidence IDs');
      assert.equal(projection.budget,12000);assert.equal([...projection.serialized].length,projection.characters);
      assert(projection.characters<=projection.budget,'The actual Core serialized array respects the exact Unicode character limit');
      assert.deepEqual(JSON.parse(projection.serialized),evidence);
      assert.deepEqual(evidence,rawEvidence,'The bounded projection preserves all saved canonical summaries exactly');
      measured={id,file,adviceFile,evidence,rawEvidence,recommendations:advice.recommendations,
        evidenceCharacters:projection.characters,evidenceBudget:projection.budget,runSha256:hash(data),adviceSha256:hash(adviceBytes),
        measurementEnvironments:environments.map(environment=>({path:environment.path,projectSha256:environment.project_sha256,
          manifestSha256:environment.manifest_sha256,collector:environment.resolved_packages.find(item=>item.name==='BenchmarkTools'),
          providerDependenciesAbsent:true}))};
      return !(await frame.locator('#app .status').getAttribute('class')).includes('busy');
    }
    return false;
  },'Real Julia measurements and their saved deterministic advice complete',360000);
  return measured;
}

exports.run = async (context,options={}) => {
  assert.equal(process.env.CI, 'true');
  const {vscode, workspace, findFrame, log, proof} = context;
  const uri = vscode.Uri.file(workspace);
  const settings = () => vscode.workspace.getConfiguration('perfchecker', uri);
  const measurementProject=await fs.realpath(path.join(workspace,'worker-environment'));
  const controllerProject=await fs.realpath(context.controller);
  assert.notEqual(measurementProject,controllerProject,'Controller and measurement projects are physically distinct');
  const measurementDependencies=await fs.readFile(path.join(measurementProject,'Project.toml'),'utf8');
  assert(!/^\s*(PerfChecker|HTTP)\s*=/m.test(measurementDependencies));
  assert(!process.env.PERFCHECKER_LOAD_PATH||process.env.PERFCHECKER_LOAD_PATH==='@'+path.delimiter+'@stdlib',
    'No extra load path may hide provider/measurement dependency separation');
  const source = path.join(workspace, 'src', 'PerfCheckerNativeFixture.jl');
  const original = await fs.readFile(source, 'utf8');
  const proposed = original.replace('sum(xs .^ 2)', 'sum((x * x for x in xs); init=zero(eltype(xs)))');
  assert.notEqual(proposed, original);
  const git = async (...args) => (await execute('git', args, {cwd: workspace,
    env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}, windowsHide: true})).stdout;
  const head = await git('rev-parse', 'HEAD');
  const probe = async root => {
    const code = 'include("src/PerfCheckerNativeFixture.jl"); score=PerfCheckerNativeFixture.sum_squares; @assert score(Float64[]) == 0.0; @assert score([1.0,-2.0,3.0]) == 14.0; xs=collect(1.0:1000.0); score(xs); @assert score(xs)==333833500.0; println(@allocated score(xs))';
    return Number((await execute(process.env.PERFCHECKER_NATIVE_JULIA,
      ['--startup-file=no', '-e', code], {cwd: root, windowsHide: true,
        env: {...process.env, UV_THREADPOOL_SIZE: '1'}})).stdout.trim());
  };
  const baselineBytes = await probe(workspace);
  const calls = [], pending = new Set(), pendingSockets=new Map(), providerErrors=[],receipts=[];
  let alternateFolder;
  const foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const foreignFinished=new Promise(resolve=>foreign.once('close',resolve));
  const custom=options.customArguments===true;
  const adviceArgument=custom?'question':'prompt',implementationArgument=custom?'change_request':'prompt',workspaceArgument=custom?'checkout_path':'workspace';
  const additional=custom?{native_contract:{label:'real-native-request',enabled:true}}:{};
  let implementationBytes,attached,savedEvidence;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'DELETE') {receipts.push({method:'DELETE',observedAt:new Date().toISOString()});res.writeHead(204); res.end(); return;}
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      receipts.push({method:req.method,rpc:body.method,observedAt:new Date().toISOString()});
      res.setHeader('Content-Type', 'application/json');
      if (body.method === 'notifications/initialized') {res.writeHead(202); res.end(); return;}
      let result = {};
      if (body.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'native-deterministic-provider');
        result = {protocolVersion: body.params.protocolVersion, capabilities: {tools: {}},
          serverInfo: {name: 'Deterministic native qualification provider', version: '1'}};
      }
      if (body.method === 'tools/list') result = {tools: ['ask_perfchecker', 'implement_perfchecker'].map(name => {
        const promptArgument=name.startsWith('implement')?implementationArgument:adviceArgument;
        return {name,inputSchema:{type:'object',properties:{[promptArgument]:{type:'string'},[workspaceArgument]:{type:'string'},
          ...(custom?{native_contract:{type:'object'}}:{})},required:name.startsWith('implement')?[promptArgument,workspaceArgument]:[promptArgument]}};
      })};
      if (body.method === 'tools/call') {
        assert.equal(req.headers['mcp-protocol-version'], '2026-07-28');
        const {name, arguments: args} = body.params;
        const promptArgument=name==='implement_perfchecker'?implementationArgument:adviceArgument,prompt=args[promptArgument];
        assert.equal(typeof prompt, 'string');
        if(custom){assert.deepEqual(args.native_contract,additional.native_contract);assert.equal(Object.hasOwn(args,'prompt'),false);
          assert.deepEqual(Object.keys(args).sort(),[promptArgument,...(name==='implement_perfchecker'?[workspaceArgument]:[]),'native_contract'].sort());}
        const projection=JSON.parse(prompt.split('\n\nPerfChecker evidence:\n').at(-1));
        assert(Array.isArray(projection.evidence));
        if(attached){
          assert.deepEqual(projection.evidence,attached.evidence,'The explicitly attached canonical measured IDs and content reach tools/call before the reply');
          assert([...JSON.stringify(projection.evidence)].length<=attached.evidenceBudget,'The actual request remains inside the serialized evidence budget');
          if(name!=='implement_perfchecker')assert(prompt.includes('No recommendations does not mean no measurements'));
        }else{
          assert.deepEqual(projection.evidence,[],'No saved measurement reaches the server without explicit Attach');
          assert(prompt.includes('No saved report was attached.'));
          assert(savedEvidence,'A real saved report already exists before testing the absence of implicit attachment');
        }
        calls.push({name,prompt,promptArgument,workspaceArgument:name==='implement_perfchecker'?workspaceArgument:undefined,additionalArgumentsVerified:custom,
          evidenceIds:projection.evidence.map(row=>row.id),projectionSha256:hash(JSON.stringify(canonical(projection.evidence))),
          evidenceInspectedBeforeReply:true,savedReportPresent:!!savedEvidence,explicitAttachment:!!attached});
        let answer = 'Consider a generator to remove the intermediate squared array. Verify empty inputs and signed floating-point values, then measure allocations; speed is not yet qualified.';
        if (prompt.includes('native cancellation probe')) {
          pending.add(res);pendingSockets.set(res,req.socket); res.on('close', () => {pending.delete(res);pendingSockets.delete(res);}); return;
        }
        if (name === 'implement_perfchecker') {
          const root = await fs.realpath(args[workspaceArgument]);
          const temporaryRoot=await fs.realpath(os.tmpdir()),originalRoot=await fs.realpath(workspace);
          // Record the physical alias boundary before any refusal or file edit.
          log('native-implementation-checkout-boundary',{temporaryRoot:os.tmpdir(),canonicalTemporaryRoot:temporaryRoot,
            suppliedCheckout:args[workspaceArgument],canonicalCheckout:root,canonicalOriginalWorkspace:originalRoot,
            temporaryAliasResolved:temporaryRoot!==os.tmpdir(),checkoutAliasResolved:root!==args[workspaceArgument]});
          const relative=assertTemporaryCheckout(temporaryRoot,root,originalRoot);
          for(const refused of [temporaryRoot,path.join(temporaryRoot,'perfchecker-implementation-sibling'),
            path.join(temporaryRoot,'perfchecker-implementation-sibling','not-checkout'),
            path.join(root,'nested-workspace'),
            path.join(path.dirname(temporaryRoot),'perfchecker-implementation-outside','checkout'),originalRoot])
            assert.throws(()=>assertTemporaryCheckout(temporaryRoot,refused,originalRoot));
          log('native-implementation-boundary-refusals',{rootSiblingOutsideOriginalRejected:true,relativeCheckout:relative});
          const file = path.join(root, 'src', 'PerfCheckerNativeFixture.jl');
          assert.equal(await fs.readFile(file, 'utf8'), original);
          await fs.writeFile(file, proposed);
          implementationBytes = await probe(root);
          assert(implementationBytes < baselineBytes);
          answer = 'The generator was implemented and the empty, signed and Float64 oracles passed in the supplied isolated copy. Review the diff before applying.';
        }
        result = {content: [{type: 'text', text: answer}]};
      }
      res.end(JSON.stringify({jsonrpc: '2.0', id: body.id, result}));
    } catch (error) {providerErrors.push(String(error));log('native-controlled-provider-error',{error:String(error)});res.writeHead(500); res.end(JSON.stringify({error: String(error)}));}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const values = {advisorEnabled: true, advisorProtocol: 'mcp_http',
    scenarioProject:measurementProject,scenarioCatalog:'perf/advisor/scenarios.toml',
    advisorEndpoint: `http://127.0.0.1:${server.address().port}/mcp`, advisorModel: 'native-fixture',
    advisorMcpTool: 'ask_perfchecker', advisorMcpResponse: 'text', advisorMcpVersion: '2026-07-28',
    advisorImplementationMcpTool: 'implement_perfchecker', advisorTimeout: 180,
    advisorMcpPromptArgument:adviceArgument,advisorMcpArguments:additional,
    advisorImplementationMcpPromptArgument:implementationArgument,advisorImplementationMcpWorkspaceArgument:workspaceArgument,
    codexExecutable: path.join(workspace, 'not-installed-codex')};
  values.scenarioSamples=100;
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, settings().inspect(key)?.workspaceFolderValue]));
  const state = () => vscode.commands.executeCommand('perfchecker.chatState');
  try {
    for (const [key, value] of Object.entries(values)) await settings().update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    assert.equal(await fs.realpath(settings().get('runnerProject')),controllerProject);
    assert.equal(await fs.realpath(settings().get('scenarioProject')),measurementProject);
    proof('native-mcp-distinct-controller-and-measurement-projects',{controllerProject,measurementProject,
      providerDependenciesExcludedFromMeasurement:true,extraLoadPath:false,settingsRestoredInFinally:true});
    const configuredPath=settings().get('advisorConfig','perf/advisor.json');
    const configuredFile=typeof configuredPath==='string'&&configuredPath.trim()?path.resolve(workspace,configuredPath):undefined;
    const readSavedConfiguration=()=>configuredFile?fs.readFile(configuredFile).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;}):Promise.resolve(undefined);
    const savedConfig=await readSavedConfiguration();
    await clickStudioAction(context,'chat');
    let view = await findFrame('#chat-root');
    await view.locator('summary').filter({hasText: 'Optional Codex CLI connector'}).click();
    await view.getByRole('button', {name: 'Connect Codex CLI', exact: true}).click();
    await eventually(async () => /ENOENT|executable|could not|launch/i.test(await view.locator('[role="status"]').innerText()), 'Missing Codex explains its executable prerequisite');
    assert.equal((await vscode.commands.executeCommand('perfchecker.codexConnectionState')).connected, false);
    proof('codex-missing-native-prerequisite',{command:'perfchecker.connectCodex',status:'prerequisite',reason:'Codex executable absent from disposable CI; no human credentials are transferred.'});
    assert.deepEqual(await vscode.commands.executeCommand('perfchecker.disconnectCodex'),{connected:false});
    assert.equal((await vscode.commands.executeCommand('perfchecker.codexConnectionState')).connected,false);
    assert.equal(settings().get('advisorConfig','perf/advisor.json'),configuredPath);
    assert.deepEqual(await readSavedConfiguration(),savedConfig,'The failed temporary CLI connection and explicit disconnect preserve the saved provider bytes');
    proof('codex-disconnected-command',{command:'perfchecker.disconnectCodex',returnValueVerified:true,alreadyDisconnected:true,savedConfigurationPreserved:true,optionalConfigurationPath:configuredPath,directoryRead:false,activeAuthenticatedDisconnection:false});
    await view.getByRole('button', {name: 'New conversation', exact: true}).click();
    const diagnoseSend=async(stage)=>{
      const diagnostic={stage,extensionHost:process.pid,controllerProject,measurementProject,
        configuredTimeoutSeconds:values.advisorTimeout,externalTimeoutSeconds:values.advisorTimeout+60,
        nativeOracleTimeoutSeconds:180,receipts:[...receipts],providerErrors:[...providerErrors]};
      try{diagnostic.chatState=await state();}catch(error){diagnostic.stateError=String(error);}
      if(process.platform==='darwin'){
        try{
          const expectedExecutable=await fs.realpath(process.env.PERFCHECKER_NATIVE_JULIA);
          const snapshot=execute('ps',['-axo','pid=,ppid=,args='],{timeout:5000});
          const observerPID=snapshot.child.pid;
          const {stdout}=await snapshot;
          const rows=stdout.split('\n').map(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return match?{pid:Number(match[1]),parent:Number(match[2]),command:match[3]}:undefined;}).filter(Boolean);
          const observer=rows.find(row=>row.pid===observerPID);
          if(observer){assert.equal(observer.parent,process.pid);diagnostic.excludedObserver={pid:observerPID,parent:observer.parent};}
          const parents=new Set([process.pid]),owned=[];
          diagnostic.ownedProcesses=owned;
          diagnostic.processDiagnosticErrors=[];
          for(let depth=0;depth<2;depth++)for(const row of rows.filter(row=>row.pid!==observerPID&&parents.has(row.parent)&&!owned.some(x=>x.pid===row.pid))){
            try{
            const {stdout:files}=await execute('lsof',['-nP','-a','-p',String(row.pid),'-d','txt','-F','n'],{timeout:5000});
            const executables=await Promise.all(files.split('\n').filter(line=>line.startsWith('n')).map(line=>fs.realpath(line.slice(1)).catch(()=>undefined)));
            if(!executables.includes(expectedExecutable))continue;
            const start=(await execute('ps',['-p',String(row.pid),'-o','lstart='],{timeout:5000})).stdout.trim();
            const item={pid:row.pid,parent:row.parent,canonicalExecutable:expectedExecutable,startIdentity:start,
              alive:processAlive(row.pid),projects:[...row.command.matchAll(/--project=(\S+)/g)].map(match=>match[1]),
              commandLength:row.command.length,advisorWorker:/advisor_worker\.jl/.test(row.command),sameIdentityAfterRead:false};
            owned.push(item);parents.add(row.pid);
            const configuration=row.command.match(/--advisor-config=(\S+)/)?.[1];
            if(configuration){
              const directory=await fs.realpath(path.dirname(configuration)),temporaryRoot=await fs.realpath(os.tmpdir());
              assert.equal(path.dirname(directory),temporaryRoot);assert(/^perfchecker-chat-/.test(path.basename(directory)));
              const bytes=await fs.readFile(configuration),config=JSON.parse(bytes);
              item.actualAdvisorFile={path:configuration,sha256:hash(bytes),timeout:config.timeout,protocol:config.protocol};
            }
            const request=row.command.match(/\s(\/\S+\/request\.toml)(?:\s|$)/)?.[1];
            if(request){
              const directory=await fs.realpath(path.dirname(request)),temporaryRoot=await fs.realpath(os.tmpdir());
              assert.equal(path.dirname(directory),temporaryRoot);
              const bytes=await fs.readFile(path.join(directory,'worker.log'));
              item.workerPhaseMarkers=bytes.subarray(Math.max(0,bytes.length-8192)).toString('utf8').split('\n')
                .filter(line=>/^PERFCHECKER_ADVISOR_PHASE [a-z_]+ [0-9]+\.[0-9]+(?:e[+-]?[0-9]+)?$/.test(line));
            }
            const after=(await execute('ps',['-p',String(row.pid),'-o','lstart='],{timeout:5000})).stdout.trim();
            item.sameIdentityAfterRead=!!start&&start===after;
            }catch(error){diagnostic.processDiagnosticErrors.push({pid:row.pid,parent:row.parent,error:String(error)});}
          }
        }catch(error){diagnostic.processDiagnosticError=String(error);}
      }
      log('native-mcp-send-diagnostic',diagnostic);
    };
    const send = async (question, count) => {
      await view.locator('#chat-question').fill(question);
      log('native-ui-action',{surface:'MCP conversation',action:'Send question',turn:count/2});
      await view.getByRole('button', {name: 'Send question', exact: true}).click();
      let nextDiagnostic=Date.now()+60000;
      try{
        await eventually(async () => {assert.deepEqual(providerErrors,[],'The real provider must accept the exact Core request');const value = await state();
          if(process.platform==='darwin'&&Date.now()>=nextDiagnostic){await diagnoseSend('waiting');nextDiagnostic=Date.now()+60000;}
          return !value.busy && value.messages.length === count;}, 'Actual Julia MCP worker returns the conversation');
      }catch(error){await diagnoseSend('failed-before-teardown');throw error;}
    };
    savedEvidence=await measuredEvidence(context);
    await vscode.commands.executeCommand('perfchecker.openChat');view=await findFrame('#chat-root');
    assert.equal((await state()).evidenceId,'','Saving a real report does not attach it to the conversation');
    await send('Inspect the intermediate allocation in sum_squares without editing. What should I verify?', 2);
    assert.deepEqual(calls[0].evidenceIds,[],'The configuration-only path remains valid without saved measurements');
    proof('native-mcp-configuration-only-conversation',{adviceTurns:1,noSavedEvidence:true,savedReportPresent:true,
      historyId:savedEvidence.id,evidenceInspectedBeforeReply:calls[0].evidenceInspectedBeforeReply,sourceUnchanged:await fs.readFile(source,'utf8')===original});
    attached=savedEvidence;
    await view.getByRole('combobox',{name:'Attach saved evidence',exact:true}).selectOption(attached.id);
    await eventually(async()=>{const value=await state();return value.evidenceId===attached.id&&value.messages.length===0;},'The real evidence selector starts a conversation with the selected measured bundle');
    await send('Inspect the intermediate allocation in sum_squares using this measured evidence without editing. What should I verify?',2);
    await send('Continue this conversation: how should empty inputs and signed Float64 values be checked?', 4);
    assert.equal(await fs.readFile(source, 'utf8'), original);
    assert(calls[2].prompt.includes('Inspect the intermediate allocation') && calls[2].prompt.includes('signed Float64'), 'The second attached-evidence MCP call contains the bounded conversation');
    assert.deepEqual(calls[1].evidenceIds,attached.evidence.map(row=>row.id));
    assert.equal(calls[1].projectionSha256,calls[2].projectionSha256,'Follow-up sends the same bounded measured evidence');
    assert.equal(hash(await fs.readFile(attached.file)),attached.runSha256);
    assert.equal(hash(await fs.readFile(attached.adviceFile)),attached.adviceSha256);
    proof('native-mcp-selected-measured-evidence',{nativeSelector:true,historyId:attached.id,evidenceIds:calls[1].evidenceIds,
      controllerProject,measurementProject,measurementEnvironments:attached.measurementEnvironments,
      runSha256:attached.runSha256,adviceSha256:attached.adviceSha256,projectionSha256:calls[1].projectionSha256,
      rawRecommendations:attached.recommendations,canonicalMeasurementSummaries:attached.rawEvidence,boundedCoreProjection:attached.evidence,
      uniqueEvidenceIds:true,evidenceCharacters:attached.evidenceCharacters,maxEvidenceCharacters:attached.evidenceBudget,
      samples:100,noDeterministicRecommendations:true,evidenceInspectedBeforeBothReplies:calls.slice(1,3).every(call=>call.evidenceInspectedBeforeReply),
      contextualTurns:2,provider:'Controlled real HTTP MCP service; no inference or credentials',sourceUnchanged:true});
    assert.equal(await view.locator('.message.assistant').count(), 2);
    await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,
      `native-${process.env.PERFCHECKER_NATIVE_EXPECTED_VERSION}-${process.platform}-${vscode.version}-mcp-controlled-provider.png`)});
    await hold();
    await view.getByRole('tab', {name: '02 · Implementation', exact: true}).click();
    assert.match(await view.locator('.warning').innerText(), /Git checkpoint.*isolated copy.*diff review/);
    await view.getByText('Configure the MCP implementation tool', {exact: true}).click();
    await view.getByRole('textbox', {name: 'Implementation tool name', exact: true}).fill('implement_perfchecker');
    await view.getByRole('button', {name: 'Save implementation tool', exact: true}).click();
    await eventually(async () => /Implementation tool saved/.test((await state()).status), 'The native tool configuration is saved');
    // Snapshot immediately before the checkpoint, after measurement and native
    // editor activity; earlier stat-cache changes are not part of this action.
    const index = await fs.readFile(path.join(workspace, '.git', 'index'));
    log('native-ui-action',{surface:'MCP implementation',action:'Prepare implementation after review'});
    await view.getByRole('button', {name: 'I reviewed the advice · Prepare implementation', exact: true}).click();
    await eventually(async () => {const value = await state(); return !value.busy && value.proposal?.files.includes('src/PerfCheckerNativeFixture.jl');}, 'The real implementation worker returns its Git proposal', 240000);
    assert.equal(await fs.readFile(source, 'utf8'), original);
    assert.match((await state()).backupRef, /^refs\/perfchecker\/checkpoints\//);
    const proposedChanges=view.getByLabel('Proposed changes',{exact:true});
    assert((await proposedChanges.innerText()).includes('init=zero'),'The real proposed patch is populated before the review capture');
    await proposedChanges.scrollIntoViewIfNeeded();
    await eventually(async()=>proposedChanges.evaluate(element=>{const box=element.getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;}),'The actual proposed patch fits the native review viewport');
    await view.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,`native-${process.platform}-${vscode.version}-mcp-reviewed-proposal.png`)});await hold();
    log('native-ui-action',{surface:'MCP implementation',action:'Open full diff'});
    await view.getByRole('button', {name: 'Open full diff', exact: true}).click();
    await eventually(() => vscode.workspace.textDocuments.some(document => document.languageId === 'diff' && document.getText().includes('init=zero')), 'The actual diff editor opens');
    await hold();
    await vscode.commands.executeCommand('perfchecker.openChat'); view = await findFrame('#chat-root');
    log('native-ui-action',{surface:'MCP implementation',action:'Apply reviewed changes'});
    await view.getByRole('button', {name: 'Apply reviewed changes', exact: true}).click();
    await eventually(async () => !((await state()).busy) && (await fs.readFile(source, 'utf8')) === proposed, 'Apply changes the original only after the native user click');
    assert.equal(await probe(workspace), implementationBytes);
    log('native-mcp-applied-oracle',{allocationBytes:implementationBytes,baselineBytes,originalChangedAfterReview:true});await hold();
    log('native-ui-action',{surface:'MCP implementation',action:'Restore previous code'});
    await view.getByRole('button', {name: 'Restore previous code', exact: true}).click();
    await eventually(async () => !((await state()).busy) && (await fs.readFile(source, 'utf8')) === original, 'Restore returns the exact original bytes');
    assert.deepEqual(await fs.readFile(path.join(workspace, '.git', 'index')), index);
    assert.equal(await git('rev-parse', 'HEAD'), head);
    await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,`native-${process.platform}-${vscode.version}-mcp-exact-restore.png`)});await hold();
    proof('native-mcp-reviewed-apply-exact-restore',{provider:'Controlled real HTTP MCP service; no inference or credentials',checkpoint:true,diffEditor:true,apply:true,exactSourceIndexHead:true,
      allocationBaselineBytes:baselineBytes,allocationCandidateBytes:implementationBytes,indexSha256:hash(index)});
    if(custom)proof('native-mcp-custom-arguments',{adviceArgument,implementationArgument,workspaceArgument,additionalArgumentsVerified:true,
      actualHttpCalls:calls.length,measuredEvidenceIds:attached.evidence.map(row=>row.id),configurationRestoredInFinally:true});
    await view.getByRole('button', {name: 'Discard proposal', exact: true}).click();
    await eventually(async () => !(await state()).proposal, 'Discard closes the recovery proposal');
    await view.getByRole('tab', {name: '01 · Advice', exact: true}).click();
    await view.locator('#chat-question').fill('native cancellation probe');
    await view.getByRole('button', {name: 'Send question', exact: true}).click();
    await eventually(() => pending.size > 0, 'The actual MCP request reached the provider');
    const ownershipSnapshot=async()=>({pending:pending.size,uiBusy:(await state()).busy});
    const owned=await ownedChatProcesses(log,[...pendingSockets.values()],ownershipSnapshot,'before-folder-switch');
    assert(owned&&processAlive(owned.cli)&&processAlive(owned.worker),'The active native chat owns a real CLI and detached advisor worker');
    const callsBeforeSwitch=calls.length;
    const owningEvidence=(await state()).evidence;
    assert(vscode.workspace.workspaceFile,'This regression uses a saved disposable multi-root workspace');
    const alternate=path.join(path.dirname(workspace),'chat-alternate-workspace');
    await fs.mkdir(alternate,{recursive:true});await fs.writeFile(path.join(alternate,'Project.toml'),'name="AlternateChatFixture"\n');
    alternateFolder=vscode.Uri.file(alternate);
    assert(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length,0,{uri:alternateFolder,name:'Chat alternate folder'}));
    await eventually(()=>vscode.workspace.workspaceFolders.some(folder=>folder.uri.toString()===alternateFolder.toString()),
      'The real workspace has added the independent alternate folder');
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',alternateFolder);
    const alternateStudio=await findFrame('#studio-root');
    await eventually(async()=>await alternateStudio.locator('.workspace strong').innerText()==='Chat alternate folder',
      'Studio selects the second folder while the first chat request is still active');
    const owningChatTab=()=>context.windowPage.locator('.tabs-container .tab').filter({
      has:context.windowPage.locator('.label-name').filter({hasText:/^PerfChecker · Chat$/})}).filter({visible:true}).first();
    await owningChatTab().click();
    await eventually(async()=>await owningChatTab().getAttribute('aria-selected')==='true',
      'The exact owning Chat tab is active, rather than the alternate Studio with a similar title');
    view=await findFrame('#chat-root');
    const requestedOwner=vscode.Uri.file(workspace),owner=vscode.workspace.getWorkspaceFolder(requestedOwner);
    assert(owner,'The native workspace API resolves the actual owning chat folder');
    assert.equal(owner.uri.toString(),requestedOwner.toString(),'The native owning folder is the exact requested chat workspace');
    log('native-mcp-owning-workspace',{requestedPath:workspace,requestedUri:requestedOwner.toString(),ownerUri:owner.uri.toString(),ownerPath:owner.uri.fsPath,name:owner.name});
    assert.equal((await state()).workspace,owner.name,
      'The displayed chat still identifies its first folder while Studio selects another');
    assert.deepEqual((await state()).evidence,owningEvidence,'Publishing A retains A’s evidence inventory instead of reading the selected folder B');
    assert.equal((await state()).evidenceId,attached.id);
    assert.deepEqual(await ownedChatProcesses(log,[...pendingSockets.values()],ownershipSnapshot,'after-folder-switch'),owned,
      'The same physical CLI/worker still owns the original held request after selecting another folder');
    assert(processAlive(owned.cli)&&processAlive(owned.worker),'Selecting the alternate Studio preserves the original active request');
    assert.equal(calls.length,callsBeforeSwitch,'Selecting another Studio must not send another provider request');
    log('native-mcp-cancel-before',{...owned,foreign:foreign.pid,heldResponses:pending.size,uiBusy:(await state()).busy});
    await view.getByRole('button', {name: 'Cancel request', exact: true}).click();
    await eventually(async () => !(await state()).busy, 'Cancel stops the real local Julia worker', 60000);
    await eventually(()=>pending.size===0,'The cancelled provider connection closes before the harness destroys any socket',15000);
    assert.equal(processAlive(owned.cli),false,'The CLI is gone before harness teardown');
    assert.equal(processAlive(owned.worker),false,'The detached advisor worker is gone before harness teardown');
    assert(processAlive(foreign.pid),'Cancellation preserves an unrelated process');
    proof('native-mcp-cancel-owned-processes',{...owned,foreignPreserved:true,heldResponseClosed:true,uiIdleAfterCleanup:true,
      observedBeforeHarnessCleanup:true,nativeOwningPanelCancelAfterAlternateStudioSelected:true,
      originalOwnedProcessesPreservedBeforeCancel:true,owningEvidenceInventoryPreserved:true,
      additionalProviderRequestsOnWorkspaceSwitch:calls.length-callsBeforeSwitch});
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(workspace));
    await owningChatTab().click();
    await eventually(async()=>await owningChatTab().getAttribute('aria-selected')==='true','The exact Chat tab is active after restoring Studio selection');
    view=await findFrame('#chat-root');
    assert.equal(await fs.readFile(source, 'utf8'), original);
    await view.getByRole('button', {name: 'New conversation', exact: true}).click();
    await eventually(async () => (await state()).messages.length === 0, 'The native clear command removes the conversation');
    proof('native-mcp-advice-implementation-restore', {provider: 'deterministic real HTTP MCP server; no model credentials',
      adviceTurns: 2, checkpoint: true, diffEditor: true, apply: true, exactRestore: true, cancellation: true,
      allocationBaselineBytes: baselineBytes, allocationCandidateBytes: implementationBytes});
    if(custom){assert(calls.some(call=>call.name==='ask_perfchecker'&&call.promptArgument===adviceArgument));
      assert(calls.some(call=>call.name==='implement_perfchecker'&&call.promptArgument===implementationArgument&&call.workspaceArgument===workspaceArgument));
      proof('native-mcp-custom-arguments',{adviceArgument,implementationArgument,workspaceArgument,additionalArgumentsVerified:true,
        actualHttpCalls:calls.length,measuredEvidenceIds:attached.evidence.map(row=>row.id),configurationRestoredInFinally:true});}
  } finally {
    if(alternateFolder){
      await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(workspace));
      const index=vscode.workspace.workspaceFolders.findIndex(folder=>folder.uri.toString()===alternateFolder.toString());
      if(index>=0)assert(vscode.workspace.updateWorkspaceFolders(index,1));
    }
    for (const response of pending) response.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) await settings().update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    foreign.kill();await foreignFinished;
  }
};
