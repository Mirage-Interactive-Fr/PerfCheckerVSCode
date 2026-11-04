// Exercise the installed workflow with actual Core measurements and package tests.
// The MCP service is a protocol fixture; no model inference or speedup is claimed.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {NATIVE_READINESS_MS}=require('./native-readiness.cjs');
const execute=promisify(execFile);
async function eventually(read,label){
  const until=Date.now()+NATIVE_READINESS_MS;
  do {const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<until);
  throw new Error(label);
}

exports.run=async(context,options={})=>{
  const {vscode,workspace,findFrame,proof}=context,uri=vscode.Uri.file(workspace);
  const settings=vscode.workspace.getConfiguration('perfchecker',uri),calls=[],errors=[];
  const keys=['advisorEnabled','advisorProtocol','advisorEndpoint','advisorConfig','advisorMcpTool','advisorMcpVersion',
    'advisorMcpPromptArgument','advisorMcpResponse','advisorImplementationMcpTool','advisorImplementationMcpPromptArgument',
    'advisorImplementationMcpWorkspaceArgument','advisorImplementationMcpArguments','advisorInstructions'];
  const previous=keys.map(key=>[key,settings.inspect(key)?.workspaceFolderValue]);
  const git=(...args)=>execute('git',args,{cwd:workspace,windowsHide:true}).then(result=>result.stdout);
  const source=path.join(workspace,'src','PerfCheckerNativeFixture.jl'),original=await fs.readFile(source,'utf8');
  const proposed=original.replace('sum(xs .^ 2)','sum((x * x for x in xs); init=zero(eltype(xs)))');assert.notEqual(proposed,original);
  const tests=path.join(workspace,'test','runtests.jl'),oldTests=await fs.readFile(tests).catch(error=>{if(error.code!=='ENOENT')throw error;});
  const ignore=path.join(workspace,'.gitignore'),oldIgnore=await fs.readFile(ignore).catch(error=>{if(error.code!=='ENOENT')throw error;});
  await fs.appendFile(ignore,'\n/perf/results/\n/Manifest.toml\n');
  await fs.writeFile(tests,'include(joinpath(@__DIR__, "..", "src", "PerfCheckerNativeFixture.jl"))\nscore=PerfCheckerNativeFixture.sum_squares\n@assert score(Float64[]) == 0.0\n@assert score([1.0,-2.0,3.0]) == 14.0\n@assert score(collect(1.0:1000.0)) == 333833500.0\n');
  const head=await git('rev-parse','HEAD'),index=await fs.readFile(path.join(workspace,'.git','index'));
  let slow=false,slowStarted=false;
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.method==='DELETE'){res.writeHead(204);res.end();return;}
      let bytes='';for await(const chunk of req)bytes+=chunk;const message=JSON.parse(bytes);let result;
      if(['notifications/initialized','notifications/cancelled'].includes(message.method)){res.writeHead(202);res.end();return;}
      if(message.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}}};
      else if(message.method==='server/discover')result={supportedVersions:['2026-07-28'],capabilities:{tools:{}}};
      else if(message.method==='tools/list')result={tools:[{name:'analyze_selected',inputSchema:{type:'object',properties:{question:{type:'string'}},required:['question']}},
        {name:'implement_selected',inputSchema:{type:'object',properties:{request:{type:'string'},checkout:{type:'string'}},required:['request','checkout']}}]};
      else if(message.method==='tools/call'){
        const {name,arguments:args}=message.params;calls.push({name,...args});
        if(slow){slowStarted=true;return;}
        if(name==='implement_selected'){
          assert(path.isAbsolute(args.checkout));assert.notEqual(await fs.realpath(args.checkout),await fs.realpath(workspace));
          await fs.writeFile(path.join(args.checkout,'src','PerfCheckerNativeFixture.jl'),proposed);
          result={content:[{type:'text',text:'Prepared one controlled generator change. Review the diff and run verification.'}]};
        }else{
          assert.equal(name,'analyze_selected');
          const payload=JSON.parse(args.question.split('\n').at(-1)),selected=payload.execution.results;
          assert(selected.length>=1);assert(selected.every(result=>result.check==='benchmark'));
          assert(payload.evidence.measurements.length>0,'Actual canonical measurements reach the MCP tool');
          result={content:[{type:'text',text:JSON.stringify({schema_version:'perfchecker-guided-analysis/1',summary:'Controlled analysis of the selected saved check. No performance verdict is inferred.',
            findings:[{id:'recorded',title:'Saved benchmark evidence',detail:'Review the actual recorded quantities and their qualification.',resultIds:[selected[0].id]}],
            suggestions:[{id:'generator',title:'Try a generator',rationale:'Check a bounded hypothesis.',change:'Replace the allocating square broadcast with a generator while preserving the fixture oracles.',checks:['Run Pkg.test() and repeat the selected benchmark.'],resultIds:[selected[0].id]}]})}]};
        }
      }else throw new Error('Unexpected protocol fixture method');
      if(message.params?._meta?.['io.modelcontextprotocol/protocolVersion']==='2026-07-28')result.resultType='complete';
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
    }catch(error){errors.push(String(error));res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}/mcp`,state=()=>vscode.commands.executeCommand('perfchecker.chatState');
  let view;
  const click=async name=>{await vscode.commands.executeCommand('perfchecker.openChat');view=await findFrame('#workflow-root');await view.getByRole('button',{name,exact:true}).click({timeout:NATIVE_READINESS_MS});};
  try {
    if(options.stdio){
      const node=await fs.realpath(process.env.PERFCHECKER_NATIVE_NODE);
      const program='const readline=require("readline");readline.createInterface({input:process.stdin}).on("line",async line=>{const body=JSON.parse(line);try{const r=await fetch(process.argv[1],{method:"POST",headers:{"Content-Type":"application/json"},body:line});if(body.id!==undefined)process.stdout.write(await r.text()+"\\n");}catch{process.exitCode=1}});';
      await vscode.commands.executeCommand('perfchecker.connectMcpStdio',{protocol:'mcp_stdio',stdio_command:node,
        stdio_args:['-e',program,endpoint],stdio_cwd:workspace,mcp_version:'2026-07-28',mcp_tool:'analyze_selected',mcp_prompt_argument:'question',
        timeout:120,implementation:{tool:'implement_selected',promptArgument:'request',workspaceArgument:'checkout',arguments:{}}});
      proof('native-mcp-stdio-connected-session',{protocol:'2026-07-28',actualNativeNode:node,customArgumentNames:true});
    }else{
      for(const [key,value]of Object.entries({advisorEnabled:true,advisorProtocol:'mcp_http',advisorEndpoint:endpoint,advisorConfig:'',advisorMcpTool:'analyze_selected',
        advisorMcpVersion:'2026-07-28',advisorMcpPromptArgument:'question',advisorMcpResponse:'text',advisorImplementationMcpTool:'implement_selected',
        advisorImplementationMcpPromptArgument:'request',advisorImplementationMcpWorkspaceArgument:'checkout',advisorImplementationMcpArguments:{},advisorInstructions:''}))
        await settings.update(key,value,vscode.ConfigurationTarget.WorkspaceFolder);
    }
    await vscode.commands.executeCommand('perfchecker.openDesignerForWorkspace',uri);
    const designer=await findFrame('#cards',{allowAttached:true});
    await eventually(async()=>await designer.locator('#cards .card').count()>0,'The real suite plan is ready');
    await designer.locator('#reset-filters').click({timeout:NATIVE_READINESS_MS});await designer.locator('#clear-all').click({timeout:NATIVE_READINESS_MS});
    const card=designer.locator('#cards .card').filter({has:designer.locator('.package',{hasText:/^PerfCheckerNativeFixture$/})}).filter({has:designer.locator('strong',{hasText:/^sum_squares$/})}).first();
    await card.locator('.check-option.ready').filter({hasText:'BenchmarkTools'}).locator('input').check({timeout:NATIVE_READINESS_MS});
    await designer.locator('#open-after-run').uncheck({timeout:NATIVE_READINESS_MS});
    const reports=path.resolve(workspace,settings.get('reports','perf/results/vscode'));
    const oldSeries=await fs.readFile(path.join(reports,'version-series.json'),'utf8').catch(()=>undefined);
    await designer.locator('#run-only').click({timeout:NATIVE_READINESS_MS});
    const series=await eventually(async()=>{const bytes=await fs.readFile(path.join(reports,'version-series.json'),'utf8').catch(()=>undefined);
      if(!bytes||bytes===oldSeries)return;const value=JSON.parse(bytes);return value.run_id&&!(await designer.locator('#run-only').isDisabled())&&value;},'One selected real check completes');
    await vscode.commands.executeCommand('perfchecker.openChat');view=await findFrame('#workflow-root');
    const entry=await eventually(async()=>(await state()).evidence.find(item=>item.id.startsWith('suite:')&&item.id.includes(series.run_id)),'The saved execution appears');
    await view.locator('#workflow-execution').selectOption(entry.id,{timeout:NATIVE_READINESS_MS});
    await eventually(async()=>(await state()).guided.selectedResultIds.length===1,'The result is selected without calling an agent');assert.equal(calls.length,0);
    await click('Analyze selected results');
    if(options.general100){await eventually(async()=>!(await state()).busy,'Legacy Core refuses unavailable canonical measurements');assert.equal(calls.length,0);return;}
    await eventually(async()=>{assert.deepEqual(errors,[]);const value=await state();return !value.busy&&value.guided.analysis;},'The selected result has a structured MCP analysis');
    const checkpoint=(await state()).guided.history.current;assert.equal(calls.length,1);
    proof('native-guided-selected-result-analysis',{runId:series.run_id,actualCoreMeasurements:true,noProviderOnOpenOrSelection:true,structuredSuggestions:true});
    await view.getByRole('radio').check({timeout:NATIVE_READINESS_MS});await click('Try selected suggestion');
    await eventually(async()=>{const value=await state();return !value.busy&&value.proposal;},'The isolated implementation produces a reviewable diff');
    assert.equal(await fs.readFile(source,'utf8'),original);assert.equal((await state()).proposal.applied,false);
    await click('Apply, test & analyze');
    const verified=await eventually(async()=>{const value=await state();return !value.busy&&value.guided.verification?.finishedAt&&value;},'Package tests and the selected performance check finish');
    assert.equal(verified.guided.verification.error,undefined,JSON.stringify(verified.guided.verification));
    assert.equal(verified.guided.verification.packageTests.status,'passed');assert.equal(verified.guided.verification.checks.status,'passed');
    assert(verified.guided.verification.checks.trialSelections.every(result=>result.version.startsWith('dev')),'The actual modified working tree is measured');
    assert(verified.guided.verification.checks.comparisons.length>0);assert(verified.guided.verification.checks.comparisons.every(row=>row.candidate_version.startsWith('dev')));
    await eventually(async()=>{const value=await state();return !value.busy&&value.guided.analysis&&value.guided.context.runId!==series.run_id;},'Verification feedback returns to the analysis');
    assert.equal(await fs.readFile(source,'utf8'),proposed);
    proof('native-guided-package-and-performance-verification',{packageTests:'passed',checks:'passed',comparison:verified.guided.verification.checks.comparisons,
      actualRepeatedMeasurement:true,performanceVerdict:'Observed changes only; protocol fixture, no model inference or statistical gain claimed.'});
    await click('Restore previous code');await eventually(async()=>await fs.readFile(source,'utf8')===original,'Restore reproduces the exact original source');
    const beforeBranch=(await state()).guided.history.nodes.length;
    await view.locator('.history-node').filter({hasText:'Agent analysis'}).first().getByRole('button',{name:'Continue from here',exact:true}).click({timeout:NATIVE_READINESS_MS});
    await eventually(async()=>(await state()).guided.history.current===checkpoint,'The old analysis checkpoint is selected');
    await click('Analyze selected results');await eventually(async()=>{const value=await state();return !value.busy&&value.guided.history.nodes.length===beforeBranch+1;},'A new branch is appended');
    const branched=await state();assert.equal(branched.guided.history.nodes.at(-1).parent,checkpoint);
    await click('Open plots');const plots=await findFrame('.result-list');
    assert((await plots.locator('h1').innerText()).includes(series.run_id),'The original execution remains viewable after the trial writes new reports');
    assert.equal(await plots.locator('.result-card').count(),1);
    slow=true;await click('Analyze selected results');await eventually(()=>slowStarted,'The cancellable MCP request is active');await click('Cancel action');
    await eventually(async()=>!(await state()).busy,'Cancel returns the workflow to idle');
    assert.equal(await git('rev-parse','HEAD'),head);assert.deepEqual(await fs.readFile(path.join(workspace,'.git','index')),index);assert.deepEqual(errors,[]);
    proof('native-mcp-reviewed-apply-exact-restore',{checkpoint:true,reviewBeforeApply:true,packageTests:true,actualPerformanceChecks:true,exactSourceIndexHead:true,
      branchHistoryPreserved:true,frozenResultStillVisible:true,cancelledActualMcp:true,provider:'Controlled protocol fixture; no model credentials or inference.'});
  }finally{
    if(options.stdio)await vscode.commands.executeCommand('perfchecker.cancelMcpStdio',uri.toString());
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    if(await fs.readFile(source,'utf8')===proposed)await vscode.commands.executeCommand('perfchecker.restoreImplementation').catch(()=>{});
    for(const [key,value]of previous)await settings.update(key,value,vscode.ConfigurationTarget.WorkspaceFolder);
    if(oldTests)await fs.writeFile(tests,oldTests);else await fs.unlink(tests).catch(()=>{});
    if(oldIgnore)await fs.writeFile(ignore,oldIgnore);else await fs.unlink(ignore).catch(()=>{});
  }
};
