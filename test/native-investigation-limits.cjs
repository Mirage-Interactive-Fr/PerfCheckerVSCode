// Installed VSIX callbacks, actual Julia workers and an owned MCP protocol fixture.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {randomUUID}=require('node:crypto');

async function eventually(read,label,timeout=180000){
  const until=Date.now()+timeout;let last;
  while(Date.now()<until){try{const value=await read();if(value)return value;}catch(error){last=error;}
    await new Promise(resolve=>setTimeout(resolve,100));}
  throw Error(`${label}${last?`: ${last.message}`:''}`);
}
async function alive(pid){
  try{process.kill(pid,0);}catch(error){if(['ESRCH','ENOENT'].includes(error.code))return false;throw error;}
  if(process.platform==='linux'){
    try{return !['Z','X'].includes((await fs.readFile(`/proc/${pid}/stat`,'utf8')).replace(/^.*\) /,'').split(' ')[0]);}
    catch(error){if(['ESRCH','ENOENT'].includes(error.code))return false;throw error;}
  }
  return true;
}
async function panel(context,tab){
  await context.vscode.commands.executeCommand('perfchecker.openInvestigations');
  const frame=await context.findFrame('#app nav[aria-label="Investigation views"]');
  if(tab)await frame.getByRole('button',{name:tab,exact:true}).click();
  return frame;
}
async function entries(root){return new Set(await fs.readdir(root).catch(error=>{if(error.code==='ENOENT')return [];throw error;}));}
async function completed(context,root,before,name){
  const result=await eventually(async()=>{
    for(const id of await entries(root)){if(before.has(id))continue;
      const file=path.join(root,id,`${name}.json`);
      try{return {file,report:JSON.parse(await fs.readFile(file,'utf8'))};}
      catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    }
  },`The real ${name} report is written`,240000);
  const frame=await panel(context);
  await eventually(async()=>!(await frame.locator('#app .status').getAttribute('class')).includes('busy'),'The actual controller completes cleanup');
  assert(await frame.getByRole('button',{name:'Cancel',exact:true}).isDisabled());
  return result;
}
async function decisionFixture(){
  const state={calls:[],errors:[],sockets:new Set()};
  const server=http.createServer(async(request,response)=>{
    try{
      if(request.method==='DELETE'){response.writeHead(204);response.end();return;}
      let text='';for await(const chunk of request){text+=chunk;assert(text.length<100000);}
      const body=JSON.parse(text);response.setHeader('Content-Type','application/json');
      if(body.method==='notifications/initialized'){response.writeHead(202);response.end();return;}
      let result;
      if(body.method==='initialize'){
        assert.equal(body.params.protocolVersion,'2025-11-25');response.setHeader('Mcp-Session-Id','native-bounded-decision');
        result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'Owned bounded decision fixture',version:'1'}};
      }else if(body.method==='tools/list'){
        result={tools:[{name:'native_choose_experiment',inputSchema:{type:'object',required:['question','native_contract'],
          properties:{question:{type:'string'},native_contract:{type:'object'}}}}]};
      }else if(body.method==='tools/call'){
        assert.equal(request.headers['mcp-protocol-version'],'2025-11-25');
        assert.equal(body.params.name,'native_choose_experiment');
        assert.deepEqual(body.params.arguments.native_contract,{label:'bounded-real-native',enabled:true});
        assert.deepEqual(Object.keys(body.params.arguments).sort(),['native_contract','question']);
        const prompt=body.params.arguments.question;
        assert(prompt.startsWith('Preserve this native bounded decision instruction.\n\n'));
        const projection=JSON.parse(prompt.split('\n\nPerfChecker evidence:\n').at(-1));
        assert(projection.allowed_experiments.length>=2);
        assert(projection.allowed_experiments.every(row=>row.id&&row.purpose));
        state.calls.push({menu:projection.allowed_experiments,customFieldsPreserved:true});
        result={structuredContent:{cards:[],experiment_id:'stop'},content:[]};
      }else throw Error(`Unexpected MCP method ${body.method}`);
      response.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
    }catch(error){state.errors.push(String(error));response.writeHead(400);response.end(JSON.stringify({error:'Owned protocol fixture rejected the request'}));}
  });
  server.on('connection',socket=>{state.sockets.add(socket);socket.once('close',()=>state.sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  state.endpoint=`http://127.0.0.1:${server.address().port}/mcp`;
  state.close=async()=>{for(const socket of state.sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));};
  return state;
}

exports.run=async context=>{
  assert.equal(process.env.CI,'true','Only disposable native CI profiles are supported');
  const uri=context.vscode.Uri.file(context.workspace),settings=()=>context.vscode.workspace.getConfiguration('perfchecker',uri);
  const relative=`perf/native-limits-${randomUUID()}`,directory=path.join(context.workspace,relative),marker=path.join(directory,'worker.pid');
  const values={scenarioCatalog:`${relative}/scenarios.toml`,scenarioSamples:1,analysisTools:['latency'],analysisTimeout:180,
    investigationMaxExperiments:4,investigationBudgetSeconds:180,investigationReports:`perf/results/native-limits-${path.basename(directory)}`,advisorEnabled:true,
    advisorConfig:'',advisorInvestigates:true,advisorProtocol:'mcp_http',advisorMcpTool:'native_choose_experiment',
    advisorMcpPromptArgument:'question',advisorMcpArguments:{native_contract:{label:'bounded-real-native',enabled:true}},
    advisorMcpVersion:'2025-11-25',advisorMcpResponse:'structured',advisorTimeout:180,
    advisorInstructions:'Preserve this native bounded decision instruction.'};
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,settings().inspect(key)?.workspaceFolderValue]));
  const fixture=await decisionFixture();values.advisorEndpoint=fixture.endpoint;
  previous.advisorEndpoint=settings().inspect('advisorEndpoint')?.workspaceFolderValue;
  const source='function make_native_limit_case(p)\n    (prepare=()->nothing, operation=x->begin write(p["marker"],string(getpid())); sleep(1800); 1 end, verify=(x,r)->r==1)\nend\n';
  const factory=path.join(directory,'case.jl'),root=path.join(context.workspace,values.investigationReports);
  await fs.mkdir(directory,{recursive:true});await fs.writeFile(factory,source);
  await fs.writeFile(path.join(directory,'scenarios.toml'),`schema_version = "perfchecker-scenario-catalog/1"\nroot = "."\n[[scenarios]]\nid = "native_limits"\nimplementation = "sleeping"\nsource = "case.jl"\nfactory = "make_native_limit_case"\ncollectors = ["benchmark"]\nparameters = { marker = ${JSON.stringify(marker)} }\n`);
  try{
    for(const [key,value]of Object.entries(values))await settings().update(key,value,context.vscode.ConfigurationTarget.WorkspaceFolder);
    let frame=await panel(context,'Scenarios');await frame.getByRole('button',{name:'Discover tests',exact:true}).click();
    await completed(context,root,new Set(),'discovery');
    frame=await panel(context,'Scenarios');await frame.getByRole('button',{name:'Clear selection',exact:true}).click();
    await frame.locator('article.card').filter({has:frame.locator('.scenario-title strong',{hasText:'native_limits'})}).first()
      .locator('.scenario-title input').check();
    const fieldset=frame.locator('fieldset').filter({has:frame.getByText('Diagnostic tools',{exact:true})});
    for(const label of await fieldset.locator('label span').allTextContents()){
      const input=fieldset.locator('label').filter({hasText:label}).locator('input');
      if(label.split(' · ')[0]==='latency')await input.check();else await input.uncheck();
    }
    let before=await entries(root);await frame.getByRole('button',{name:'Investigate selected',exact:true}).click();
    const enabled=await completed(context,root,before,'investigation');
    assert.equal(enabled.report.status,'advisor_stopped');assert.equal(enabled.report.experiments.length,0);
    assert.equal(enabled.report.decisions.length,1);assert.equal(enabled.report.decisions[0].status,'complete');
    assert.equal(enabled.report.decisions[0].experiment_id,'stop');assert(enabled.report.unexecuted.length>=2);
    assert.equal(fixture.calls.length,1);assert.deepEqual(fixture.errors,[]);
    await assert.rejects(fs.stat(marker),{code:'ENOENT'},'A stop decision executes no sleeping scenario');
    frame=await panel(context,'Findings & advice');assert.match(await frame.locator('#app').innerText(),/advisor_stopped/);
    await frame.getByText('Optional model decisions',{exact:true}).click();
    assert.match(await frame.locator('#app').innerText(),/"experiment_id": "stop"/);
    context.proof('native-investigation-enabled-model-decision',{nativeClick:true,core:context.core,customMcpFieldsAndInstructionsPreserved:true,
      structuredResponse:true,declaredMenu:fixture.calls[0].menu,status:enabled.report.status,noScenarioExecution:true,nativeDecisionVisible:true});

    await settings().update('advisorInvestigates',false,context.vscode.ConfigurationTarget.WorkspaceFolder);
    await settings().update('analysisTimeout',45,context.vscode.ConfigurationTarget.WorkspaceFolder);
    for(const [name,label,budget]of [['run','Measure selected',180],['investigation','Investigate selected',45]]){
      await fs.rm(marker,{force:true});await settings().update('investigationBudgetSeconds',budget,context.vscode.ConfigurationTarget.WorkspaceFolder);
      if(name==='investigation')await settings().update('analysisTimeout',180,context.vscode.ConfigurationTarget.WorkspaceFolder);
      before=await entries(root);frame=await panel(context,'Scenarios');await frame.getByRole('button',{name:label,exact:true}).click();
      const pid=await eventually(async()=>{const value=Number(await fs.readFile(marker,'utf8'));return value>0?value:false;},'The actual sleeping scenario publishes its worker PID');
      assert(await alive(pid),'The real operation is active before its configured limit expires');
      context.log('native-limit-worker-active',{limit:name,pid,budgetSeconds:budget,analysisTimeout:settings().get('analysisTimeout')});
      const result=await completed(context,root,before,name);
      const runs=result.report.runs;assert.equal(runs.length,1);assert.equal(runs[0].qualification.availability,'timeout');
      await eventually(async()=>!await alive(pid),'The owned deadline worker is gone before harness cleanup',15000);
      frame=await panel(context,'Findings & advice');
      if(name==='investigation'){
        assert.equal(result.report.status,'budget_exhausted');assert.equal(result.report.limits.budget_seconds,45);
        assert.equal(result.report.experiments.length,1);assert(result.report.unexecuted.length>0);
        assert.match(await frame.locator('#app').innerText(),/budget_exhausted/);
      }else assert.match(await frame.locator('#app').innerText(),/timeout/);
      assert.equal(await fs.readFile(factory,'utf8'),source);assert.equal(fixture.calls.length,1);
      context.proof(name==='run'?'native-analysis-configured-deadline':'native-investigation-elapsed-budget',{
        nativeClick:true,pid,operationActuallyStarted:true,configuredSeconds:45,noCancelClick:true,
        status:name==='run'?runs[0].qualification.availability:result.report.status,
        ownedWorkerGoneBeforeHarnessCleanup:true,nativeOutcomeVisible:true,sourceUnchanged:true,disabledModelMadeNoRequests:true});
    }
  }finally{
    await context.vscode.commands.executeCommand('perfchecker.cancelInvestigation');
    const frame=await panel(context);
    await eventually(async()=>!(await frame.locator('#app .status').getAttribute('class')).includes('busy'),'Limits teardown waits for owned controller cleanup');
    await fixture.close();
    for(const [key,value]of Object.entries(previous))await settings().update(key,value,context.vscode.ConfigurationTarget.WorkspaceFolder);
    await fs.rm(directory,{recursive:true,force:true});
  }
};
