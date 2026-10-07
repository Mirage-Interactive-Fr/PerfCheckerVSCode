import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
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
