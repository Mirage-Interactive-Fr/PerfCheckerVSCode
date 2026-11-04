import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const require=createRequire(import.meta.url),exec=promisify(execFile);

test('guided actions use selected results, review one isolated change, verify it and branch without losing feedback',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-guided-'));
  const uri={scheme:'file',fsPath:root,toString:()=>`file://${root}`},folder={name:'Example',uri};
  const settings={advisorEnabled:true,advisorImplementationMcpTool:'implement'};
  const saved=new Map(), requests=[];let testStatus='passed',perfRuns=0,currentSource,config;
  const git=(...args)=>exec('git',args,{cwd:root});
  const {SuiteChatEvidence,captureSuiteChatSource}=require('../dist/suiteChatEvidence.js');
  const inventory=new SuiteChatEvidence();
  async function execution(value) {
    const runId=randomUUID(),reports=path.join(root,'perf/results'),directory=path.join(reports,'bundles',`run-${runId}`);
    await mkdir(directory,{recursive:true});
    const identity={suite:'example',profile:'quick',started_at:'2026-11-04T00:00:00',finished_at:'2026-11-04T00:01:00'};
    const run={package:'Example',feature:'push_benchmark',version:'dev',target_kind:'dev',comparison_key:'workload',status:'pass',summary:{median:value}};
    await writeFile(path.join(reports,'suite-result.json'),JSON.stringify({schema_version:'perfchecker-suite-result/1',...identity,runs:[run]}));
    await writeFile(path.join(reports,'version-series.json'),JSON.stringify({schema_version:'perfchecker-version-series/1',run_id:runId,series:[],plots:[]}));
    const files={'manifest.json':JSON.stringify({schema_version:'perfchecker-run-bundle/1',run_id:runId,...identity,state:'complete',
      plan:{runs:[{...run,backend:'benchmark',target_revision:'a'.repeat(40)}]}}),
      'measurement-definitions.json':'[]','observations.jsonl':'','diagnostics.jsonl':'','artifacts.json':'[]'};
    for(const [name,bytes]of Object.entries(files))await writeFile(path.join(directory,name),bytes);
    await writeFile(path.join(directory,'integrity.json'),JSON.stringify({schema_version:'perfchecker-bundle-integrity/1',algorithm:'sha256',
      files:Object.entries(files).map(([name,bytes])=>({path:name,bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')}))}));
    await inventory.refresh(uri.toString(),root,'perf/results');
    const option=inventory.options(uri.toString())[0];
    return currentSource=await captureSuiteChatSource(await inventory.read(option.id,uri.toString()));
  }
  const vscode={workspace:{isTrusted:true,workspaceFolders:[folder],textDocuments:[],getConfiguration:()=>({get:(key,fallback)=>settings[key]??fallback})},
    commands:{executeCommand:async(name,input)=>{
      assert.equal(name,'perfchecker.runVerificationChecks');assert.equal(input.workspace,uri);assert.equal(input.selections.length,1);
      perfRuns++;const source=await execution(80);return {status:'passed',runId:source.runId,selections:input.selections,trialSelections:input.selections};
    }},window:{showWarningMessage:()=>undefined}};
  const original=Module._load;
  Module._load=function(name,...args){
    if(name==='vscode')return vscode;
    if(name==='./advisorSetup')return {readAdvisorConfiguration:async()=>({...config})};
    if(name==='./packageTests')return {runPackageTests:async()=>({status:testStatus,exitCode:testStatus==='passed'?0:1,output:'Actual controlled test feedback.'})};
    return original.call(this,name,...args);
  };
  let AdvisorChat;try{({AdvisorChat}=require('../dist/advisorChat.js'));}finally{Module._load=original;}
  const server=http.createServer(async(req,res)=>{
    if(req.method==='DELETE'){res.writeHead(204);res.end();return;}
    let bytes='';for await(const chunk of req)bytes+=chunk;
    const request=JSON.parse(bytes);let result;
    if(request.method==='tools/list') result={tools:['analyze','implement'].map(name=>({name,inputSchema:{type:'object',required:['prompt'],properties:{prompt:{type:'string'}}}}))};
    else {
      const {name,arguments:args}=request.params;requests.push({name,...args});
      if(name==='implement') {await writeFile(path.join(args.workspace,'source.txt'),'trial\n');result={content:[{type:'text',text:'One selected suggestion prepared for diff review.'}]};}
      else {
        const execution=JSON.parse(args.prompt.split('\n').at(-1)).execution;
        result={content:[{type:'text',text:JSON.stringify({schema_version:'perfchecker-guided-analysis/1',summary:'Controlled protocol analysis.',findings:[],
          suggestions:[{id:'try-one',title:'Try one change',rationale:'Check the hypothesis.',change:'Update source.txt.',checks:['Run package tests and repeat the check.'],resultIds:execution.results.map(r=>r.id)}]})}]};
      }
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  });
  let chat;
  try {
    await git('init','-q');await git('config','user.email','fixture@example.invalid');await git('config','user.name','Protocol fixture');
    await writeFile(path.join(root,'source.txt'),'original\n');await writeFile(path.join(root,'.gitignore'),'perf/results/\n');
    await git('add','.');await git('commit','-qm','Fixture baseline');
    const head=(await git('rev-parse','HEAD')).stdout,index=(await git('write-tree')).stdout;
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    config={protocol:'mcp_http',endpoint:`http://127.0.0.1:${server.address().port}/mcp`,mcp_tool:'analyze',mcp_version:'2026-07-28',timeout:5};
    chat=new AdvisorChat({workspaceState:{get:key=>saved.get(key),update:async(key,value)=>saved.set(key,value)}},
      ()=>inventory.options(uri.toString()),id=>inventory.read(id,uri.toString()),async()=>{});
    chat.invoke=async(_folder,_config,_request,command,bundle)=>{
      assert.equal(command,'advise');const source=JSON.parse(await readFile(path.join(bundle,'manifest.json'),'utf8'));
      return {schema_version:'perfchecker-advice/1',recommendations:[],measurement_summaries:[{case_id:'example/Example/push_benchmark',target_id:'dev',
        median:source.run_id===baseline.runId?100:80,record_semantics:'operation_measurement',scope:'whole_operation',aggregation:'sample',
        metric:'julia.wall.time',unit:'ns',collector:'benchmark',comparison_fingerprint:'matching',measurement_definition:'time-v1',correctness:'passed'}]};
    };
    const baseline=await execution(100);await chat.selectSavedResults(baseline);await chat.analyze();
    const analysisNode=chat.state().guided.history.current;
    await chat.trySuggestion('try-one');
    assert.equal(await readFile(path.join(root,'source.txt'),'utf8'),'original\n','The implementation tool edits only the isolated checkout');
    assert.match(requests.find(r=>r.name==='implement').prompt,/Update source.txt/);
    const candidate=chat.activeIntent.candidateRef;chat.activeIntent.candidateRef='another-choice';
    await assert.rejects(chat.apply(),/another choice/);assert.equal(await readFile(path.join(root,'source.txt'),'utf8'),'original\n');
    chat.activeIntent.candidateRef=candidate;
    await chat.apply();testStatus='failed';await chat.verifyTrial();
    assert.equal(perfRuns,0,'Failed package tests prevent performance measurements');
    await assert.rejects(chat.keepTrial(),/must pass/);
    const reloaded=new AdvisorChat({workspaceState:{get:key=>saved.get(key),update:async(key,value)=>saved.set(key,value)}},
      ()=>inventory.options(uri.toString()),id=>inventory.read(id,uri.toString()),async()=>{});
    reloaded.workflow();await reloaded.recoverProposal();
    assert.equal(reloaded.state().proposal.applied,true);
    assert.equal(reloaded.activeIntent.context.runId,baseline.runId,'Reload retains the original trial baseline');
    assert.equal(reloaded.activeIntent.candidateRef,reloaded.proposal.candidateRef);
    assert.equal(reloaded.state().guided.verification.packageTests.status,'failed');reloaded.dispose();
    testStatus='passed';await chat.verifyTrial();
    assert.equal(perfRuns,1);assert.equal(chat.state().guided.verification.checks.comparisons[0].relative_delta,-0.2);
    await chat.analyzeTrial();assert.match(requests.at(-1).prompt,/Actual controlled test feedback/);
    await chat.restoreTrial();assert.equal(await readFile(path.join(root,'source.txt'),'utf8'),'original\n');
    const priorNodes=chat.state().guided.history.nodes.length;
    await chat.continueFrom(analysisNode);await chat.analyze({instructions:'Try a different approach.'});
    assert.equal(chat.state().guided.history.nodes.length,priorNodes+1);
    assert.equal(chat.state().guided.history.nodes.at(-1).parent,analysisNode);
    assert.doesNotMatch(requests.at(-1).prompt,/Actual controlled test feedback/,'Replay includes only the chosen branch');
    assert.equal((await git('rev-parse','HEAD')).stdout,head);assert.equal((await git('write-tree')).stdout,index);
    chat.guidedContext=undefined;chat.verification={id:randomUUID(),packageTests:{status:'failed',output:'Newly created checks failed package tests.'}};
    await chat.analyzeTrial();
    assert.equal(chat.state().guided.context.results[0].check,'package-tests');
    assert.match(requests.at(-1).prompt,/Newly created checks failed package tests/);
    assert.equal(perfRuns,1,'Failure analysis does not invent a performance run');
  } finally {chat?.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
