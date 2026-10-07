import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url),execute=promisify(execFile);
const {CodexConnector,inspectCodex}=require('../dist/codexConnector.js');
const {createImplementationCheckout,applyImplementation}=require('../dist/implementation.js');
// Read-only status observations must not refresh Git's index stat cache after restore.
const git=async(root,...args)=>(await execute('git',args,{cwd:root,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;

// Opt-in named-agent qualification; it uses the user's existing CLI account and model quota.
test('real authenticated Codex through local MCP: two advice turns, isolated edits, verified diff, apply, restore, cancel and disconnect',
  {skip:!process.env.PERFCHECKER_TEST_CODEX,timeout:300000},async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'perfchecker-codex-real-'));
    const requests=await mkdtemp(path.join(tmpdir(),'perfchecker-codex-requests-'));
    let connector,checkout;
    try{
      await git(root,'init');await git(root,'config','user.name','PerfChecker qualification');await git(root,'config','user.email','qualification@example.invalid');
      const source='exports.sumSquares = values => values.map(value => value * value).reduce((sum, value) => sum + value, 0);\n';
      await writeFile(path.join(root,'source.cjs'),source);await git(root,'add','.');await git(root,'commit','-m','Sacrificial allocation fixture');
      const index=await readFile(path.join(root,'.git','index')),head=await git(root,'rev-parse','HEAD');
      const version=await inspectCodex(process.env.PERFCHECKER_TEST_CODEX,root);
      connector=await new CodexConnector({cli:process.env.PERFCHECKER_TEST_CODEX,root,timeoutMs:120000}).start();
      const call=async(method,params,signal)=>{
        const response=await fetch(connector.endpoint,{method:'POST',signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${connector.token}`,'MCP-Protocol-Version':'2026-07-28'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
        const result=(await response.json()).result;assert.ok(!result.isError,result.content?.[0]?.text);return result;
      };
      await call('initialize',{protocolVersion:'2026-07-28'});assert.equal((await call('tools/list')).tools.length,2);
      const juliaProject=process.env.PERFCHECKER_TEST_JULIA_PROJECT;
      const julia=process.env.PERFCHECKER_TEST_JULIA||'julia';
      const juliaEnvironment={...process.env,PERFCHECKER_UUID:'6309bf6b-a531-4b08-891e-8ee981e5c424'};
      let coreVersion;
      if(juliaProject){
        const metadata=JSON.parse((await execute(julia,['--startup-file=no',`--project=${juliaProject}`,'-e',
          'using PerfChecker, Pkg; PerfChecker.JSON.print(Dict("version"=>string(Base.pkgversion(PerfChecker)),"tree"=>bytes2hex(Pkg.GitTools.tree_hash(dirname(dirname(pathof(PerfChecker)))))))'],{env:juliaEnvironment})).stdout);
        assert.equal(metadata.version,'1.0.0');assert.equal(metadata.tree,'7af0cc74194b953c5e998efd7523f0c5f455e395');coreVersion=metadata.version;
      }
      const invoke=async(command,messages,workspace)=>{
        const sourceFile=path.join(requests,'request.json'),configFile=path.join(requests,'advisor.json');
        await writeFile(sourceFile,JSON.stringify({messages,...(workspace?{workspace}:{})}),{mode:0o600});
        await writeFile(configFile,JSON.stringify({protocol:'mcp_http',endpoint:connector.endpoint,model:'Codex CLI',timeout:120,
          mcp_tool:command==='implement'?'implement_perfchecker':'ask_perfchecker',mcp_prompt_argument:'prompt',mcp_arguments:{},mcp_response:'text',
          mcp_version:'2026-07-28',api_key_env:connector.keyEnvironment,allow_remote:false}),{mode:0o600});
        const output=await execute(julia,['--startup-file=no',`--project=${juliaProject}`,'-e','using PerfChecker; exit(perfchecker_main(ARGS))','--',
          command,`--source=${sourceFile}`,`--advisor-config=${configFile}`,`--project=${juliaProject}`],{cwd:root,env:juliaEnvironment,timeout:180000,maxBuffer:2000000});
        const result=JSON.parse(output.stdout);assert.equal(result.status,'complete');
        assert.equal(result.message_count,messages.length);assert.equal(result.advisor_mode,command==='implement'?'implementation':'advice');
        if(command==='implement')assert.equal(result.implementation_status,'requires_diff_review');
        return {content:[{type:'text',text:result.external_review}]};
      };
      const question=`No tools or commands. Give concise advice for removing the intermediate array from this JavaScript function while preserving empty-array behavior and numeric results: ${source}`;
      const conversation=[{role:'user',content:question}];
      const advice=juliaProject?await invoke('chat',conversation):await call('tools/call',{name:'ask_perfchecker',arguments:{prompt:question}});
      assert.ok(advice.content[0].text.length>10);assert.equal(await readFile(path.join(root,'source.cjs'),'utf8'),source);assert.equal(await git(root,'status','--porcelain'),'');
      const followupQuestion='Before implementing, what correctness checks should I run for empty inputs, negative numbers, floating-point numbers, NaN, Infinity and sparse arrays? Distinguish a possible allocation reduction from an unmeasured speedup. No tools, commands or file changes.';
      conversation.push({role:'assistant',content:advice.content[0].text},{role:'user',content:followupQuestion});
      const followup=juliaProject?await invoke('chat',conversation):await call('tools/call',{name:'ask_perfchecker',arguments:{prompt:`Continue this bounded advice conversation without tools, commands or file changes. User: ${question}\nAssistant: ${advice.content[0].text}\nUser: ${followupQuestion}`}});
      assert.ok(followup.content[0].text.length>10);assert.equal(await readFile(path.join(root,'source.cjs'),'utf8'),source);assert.equal(await git(root,'status','--porcelain'),'');
      checkout=await createImplementationCheckout(root);
      const implementationQuestion=`Implement this reviewed advice in source.cjs only: remove the intermediate map array from sumSquares. Preserve CommonJS exports and JavaScript Array semantics, including skipping sparse holes. You may use only file editing and the Node executable ${process.execPath} for tests. Do not run Julia, install dependencies, create extra files or invoke external services. Test empty, positive, negative and floating-point values, NaN, Infinity and sparse arrays. Leave the source change for review.`;
      conversation.push({role:'assistant',content:followup.content[0].text},{role:'user',content:implementationQuestion});
      const summary=juliaProject?await invoke('implement',conversation,checkout.workspace):await call('tools/call',{name:'implement_perfchecker',arguments:{workspace:checkout.workspace,
        prompt:`${implementationQuestion} Advice: ${advice.content[0].text}. Reviewed validation: ${followup.content[0].text}.`}});
      const proposal=await checkout.collect();assert.deepEqual(proposal.files,['source.cjs']);assert.ok(proposal.patch);
      const verify=async(directory)=>execute(process.execPath,['-e',`const assert=require('node:assert/strict'),{sumSquares}=require('./source.cjs');const baseline=values=>values.map(value=>value*value).reduce((sum,value)=>sum+value,0);for(const values of [[],[1,2,3],[-2,3],[.5,-1.25],[-0],[NaN],[Infinity],Array(3),[,,2]])assert(Object.is(sumSquares(values),baseline(values)),JSON.stringify(values));`],{cwd:directory});
      await verify(checkout.workspace);
      assert.equal(await readFile(path.join(root,'source.cjs'),'utf8'),source);assert.deepEqual(await readFile(path.join(root,'.git','index')),index);
      await applyImplementation(proposal);await verify(root);assert.notEqual(await readFile(path.join(root,'source.cjs'),'utf8'),source);
      await applyImplementation(proposal,true);assert.equal(await readFile(path.join(root,'source.cjs'),'utf8'),source);assert.deepEqual(await readFile(path.join(root,'.git','index')),index);assert.equal(await git(root,'rev-parse','HEAD'),head);
      const controller=new AbortController();const cancelled=call('tools/call',{name:'ask_perfchecker',arguments:{prompt:'No tools. Explain how to validate an allocation improvement in detail.'}},controller.signal);
      const rejected=assert.rejects(cancelled,/abort|cancel|fetch/i);
      const deadline=Date.now()+10000;while(!connector.children.size&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
      assert.ok(connector.children.size);const child=[...connector.children][0];
      let events='';child.stdout.on('data',chunk=>{events+=chunk;});
      const turnDeadline=Date.now()+20000;while(!events.includes('turn.started')&&Date.now()<turnDeadline)await new Promise(resolve=>setTimeout(resolve,20));
      assert.ok(events.includes('turn.started'),'A real Codex turn must start before cancellation is qualified.');
      const endpoint=connector.endpoint;
      controller.abort();await rejected;await connector.dispose();connector=undefined;
      assert.ok(child.exitCode!==null||child.signalCode!==null);assert.equal(await readFile(path.join(root,'source.cjs'),'utf8'),source);
      await assert.rejects(fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(5000),body:'{}'}),/fetch|connect|abort/i);
      assert.equal(await git(root,'status','--porcelain'),'');assert.deepEqual(await readFile(path.join(root,'.git','index')),index);assert.equal(await git(root,'rev-parse','HEAD'),head);
      console.log(JSON.stringify({status:'passed',agent:version,transport:'MCP HTTP loopback',...(coreVersion?{coreVersion,worker:'registered PerfChecker Julia CLI'}:{}),checks:['two contextual advice turns leave source unchanged','isolated source edit','empty/signed/float/NaN/Infinity/sparse oracle','diff review','apply','restore bytes/index/HEAD','cancel live process','disconnect endpoint'],adviceCharacters:[advice.content[0].text.length,followup.content[0].text.length],summaryCharacters:summary.content[0].text.length,changedFiles:proposal.files}));
    }finally{await connector?.dispose();await checkout?.dispose();await rm(root,{recursive:true,force:true});await rm(requests,{recursive:true,force:true});}
  });

// Separate Julia-source proof: the earlier JavaScript test remains useful, but
// cannot qualify an agent's Julia edits or their actual allocation measurements.
test('real Codex Julia implementation: measured sum_squares, contextual advice, isolated patch, oracles, apply and exact restore',
  {skip:!process.env.PERFCHECKER_TEST_CODEX_JULIA||!process.env.PERFCHECKER_TEST_CODEX||!process.env.PERFCHECKER_TEST_JULIA_PROJECT,timeout:360000},async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'perfchecker-codex-julia-real-'));
    const requests=await mkdtemp(path.join(tmpdir(),'perfchecker-codex-julia-requests-'));
    const julia=process.env.PERFCHECKER_TEST_JULIA||'julia',project=process.env.PERFCHECKER_TEST_JULIA_PROJECT;
    let connector,checkout;
    try{
      const relative='src/PerfCheckerNativeFixture.jl',file=path.join(root,relative);
      await mkdir(path.dirname(file));
      const source='module PerfCheckerNativeFixture\nBase.@noinline sum_squares(xs) = sum(xs .^ 2)\nend\n';
      await writeFile(file,source);
      await git(root,'init');await git(root,'config','user.name','PerfChecker qualification');await git(root,'config','user.email','qualification@example.invalid');
      await git(root,'add','.');await git(root,'commit','-m','Sacrificial Julia allocation fixture');
      const index=await readFile(path.join(root,'.git','index')),head=await git(root,'rev-parse','HEAD');
      const probe=async directory=>{
        const code='include("src/PerfCheckerNativeFixture.jl"); score=PerfCheckerNativeFixture.sum_squares; @assert score(Float64[])==0.0;@assert score([1.0,-2.0,3.0])==14.0;xs=collect(1.0:1000.0);score(xs);@assert score(xs)==333833500.0;println(@allocated score(xs))';
        return Number((await execute(julia,['--startup-file=no','--history-file=no','-e',code],{cwd:directory,timeout:60000})).stdout.trim());
      };
      const baselineBytes=await probe(root);assert(baselineBytes>0);
      const core=JSON.parse((await execute(julia,['--startup-file=no',`--project=${project}`,'-e','using PerfChecker,Pkg; info=Pkg.dependencies()[Base.PkgId(PerfChecker).uuid]; PerfChecker.JSON.print(Dict("version"=>string(Base.pkgversion(PerfChecker)),"tree"=>bytes2hex(Pkg.GitTools.tree_hash(pkgdir(PerfChecker))),"registered"=>info.is_tracking_registry))'])).stdout);
      if(process.env.PERFCHECKER_TEST_CORE_TREE)assert.equal(core.tree,process.env.PERFCHECKER_TEST_CORE_TREE);
      else {assert.equal(core.version,'1.0.0');assert.equal(core.tree,'7af0cc74194b953c5e998efd7523f0c5f455e395');assert.equal(core.registered,true);}
      const version=await inspectCodex(process.env.PERFCHECKER_TEST_CODEX,root);
      connector=await new CodexConnector({cli:process.env.PERFCHECKER_TEST_CODEX,root,timeoutMs:150000}).start();
      const invoke=async(command,messages,workspace)=>{
        const request=path.join(requests,'request.json'),config=path.join(requests,'advisor.json');
        await writeFile(request,JSON.stringify({messages,...(workspace?{workspace}:{})}),{mode:0o600});
        await writeFile(config,JSON.stringify({protocol:'mcp_http',endpoint:connector.endpoint,model:'Codex CLI',timeout:150,mcp_tool:command==='implement'?'implement_perfchecker':'ask_perfchecker',
          mcp_prompt_argument:'prompt',mcp_arguments:{},mcp_response:'text',mcp_version:'2026-07-28',api_key_env:connector.keyEnvironment,allow_remote:false}),{mode:0o600});
        const result=JSON.parse((await execute(julia,['--startup-file=no',`--project=${project}`,'-e','using PerfChecker;exit(perfchecker_main(ARGS))','--',command,
          `--source=${request}`,`--advisor-config=${config}`,`--project=${project}`],{cwd:root,env:{...process.env,PERFCHECKER_UUID:'6309bf6b-a531-4b08-891e-8ee981e5c424'},timeout:210000,maxBuffer:2000000})).stdout);
        assert.equal(result.status,'complete');assert.equal(result.message_count,messages.length);
        if(command==='implement')assert.equal(result.implementation_status,'requires_diff_review');
        return result.external_review;
      };
      const messages=[{role:'user',content:`Give advice only, no commands or file changes. This Julia function was measured after warming on1000 Float64 inputs: ${baselineBytes} allocation bytes. What might remove the intermediate squared array, and what remains unmeasured? ${source}`}];
      const first=await invoke('chat',messages);assert(first.length>10);
      assert.equal(await readFile(file,'utf8'),source);assert.equal(await git(root,'status','--porcelain'),'');
      messages.push({role:'assistant',content:first},{role:'user',content:'Continue the same conversation. Specify checks for empty Float64 input, [1,-2,3], and1:1000. Expected results are0,14 and333833500. Distinguish an allocation reduction from a speed claim. Advice only, no tools or editing.'});
      const second=await invoke('chat',messages);assert(second.length>10);assert.equal(await readFile(file,'utf8'),source);
      checkout=await createImplementationCheckout(root);
      messages.push({role:'assistant',content:second},{role:'user',content:`Implement the reviewed allocation change ONLY in ${relative}, preserving its Julia module and @noinline API. Do not create extra files, install anything or call external services. Use the existing Julia executable ${julia} with --startup-file=no and -e to check empty Float64 input==0, [1.0,-2.0,3.0]==14 and collect(1.0:1000.0)==333833500. Warm the function then measure @allocated on1000 inputs. Leave the edit for diff review; do not claim timing improved.`});
      const summary=await invoke('implement',messages,checkout.workspace);assert(summary.length>10);
      const proposal=await checkout.collect();assert.deepEqual(proposal.files,[relative]);assert(proposal.patch.length>0);
      const candidateBytes=await probe(checkout.workspace);assert(candidateBytes<baselineBytes,'The actual Julia candidate reduces measured allocations');
      assert.equal(await readFile(file,'utf8'),source);assert.deepEqual(await readFile(path.join(root,'.git','index')),index);
      await applyImplementation(proposal);assert.equal(await probe(root),candidateBytes);assert.notEqual(await readFile(file,'utf8'),source);
      await applyImplementation(proposal,true);assert.equal(await readFile(file,'utf8'),source);assert.deepEqual(await readFile(path.join(root,'.git','index')),index);assert.equal(await git(root,'rev-parse','HEAD'),head);
      const abort=new AbortController();
      const pending=fetch(connector.endpoint,{method:'POST',signal:abort.signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${connector.token}`,'MCP-Protocol-Version':'2026-07-28'},
        body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ask_perfchecker',arguments:{prompt:'Advice only, no tools: discuss the remaining uncertainty in this Julia sum_squares optimization in detail.'}}})});
      const rejected=assert.rejects(pending,/abort|cancel|fetch/i);
      const until=Date.now()+20000;while(!connector.children.size&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
      assert(connector.children.size>0);const child=[...connector.children][0];let events='';child.stdout.on('data',chunk=>events+=chunk);
      const turnDeadline=Date.now()+20000;while(!events.includes('turn.started')&&Date.now()<turnDeadline)await new Promise(resolve=>setTimeout(resolve,20));
      assert(events.includes('turn.started'),'Cancellation follows a real authenticated Codex turn');
      const endpoint=connector.endpoint;abort.abort();await rejected;await connector.dispose();connector=undefined;
      assert(child.exitCode!==null||child.signalCode!==null);await assert.rejects(fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(5000),body:'{}'}));
      assert.equal(await readFile(file,'utf8'),source);assert.deepEqual(await readFile(path.join(root,'.git','index')),index);assert.equal(await git(root,'rev-parse','HEAD'),head);assert.equal(await git(root,'status','--porcelain'),'');
      console.log(JSON.stringify({status:'passed',agent:version,core,source:'real Julia source through Core chat/implement and local MCP',adviceTurns:2,
        oracle:{empty:0,signed:14,range1000:333833500},allocationBaselineBytes:baselineBytes,allocationCandidateBytes:candidateBytes,
        isolatedDiff:true,apply:true,exactRestore:true,cancelRealTurn:true,disconnected:true,changedFiles:proposal.files}));
    }finally{await connector?.dispose();await checkout?.dispose();await rm(root,{recursive:true,force:true});await rm(requests,{recursive:true,force:true});}
  });
