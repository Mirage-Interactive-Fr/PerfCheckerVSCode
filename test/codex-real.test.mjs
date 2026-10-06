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
const git=async(root,...args)=>(await execute('git',args,{cwd:root})).stdout;

// Opt-in named-agent qualification; it uses the user's existing CLI account and model quota.
test('real authenticated Codex through local MCP: advice, isolated edits, verified diff, apply, restore, cancel',
  {skip:!process.env.PERFCHECKER_TEST_CODEX,timeout:300000},async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'perfchecker-codex-real-'));
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
      const advice=await call('tools/call',{name:'ask_perfchecker',arguments:{prompt:`No tools or commands. Give concise advice for removing the intermediate array from this JavaScript function while preserving empty-array behavior and numeric results: ${source}`}});
      assert.ok(advice.content[0].text.length>10);assert.equal(await readFile(path.join(root,'source.cjs'),'utf8'),source);assert.equal(await git(root,'status','--porcelain'),'');
      checkout=await createImplementationCheckout(root);
      const summary=await call('tools/call',{name:'implement_perfchecker',arguments:{workspace:checkout.workspace,
        prompt:`Implement this reviewed advice in source.cjs only: remove the intermediate map array from sumSquares. Preserve CommonJS exports and semantics. Advice: ${advice.content[0].text}. You may use only file editing and the Node executable ${process.execPath} for tests. Do not run Julia, install dependencies, create extra files or invoke external services. Test empty, positive and negative values. Leave the source change for review.`}});
      const proposal=await checkout.collect();assert.deepEqual(proposal.files,['source.cjs']);assert.ok(proposal.patch);
      const verify=async(directory)=>execute(process.execPath,['-e',`const assert=require('node:assert/strict'),{sumSquares}=require('./source.cjs');assert.equal(sumSquares([]),0);assert.equal(sumSquares([1,2,3]),14);assert.equal(sumSquares([-2,3]),13);`],{cwd:directory});
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
      controller.abort();await rejected;await connector.dispose();connector=undefined;
      assert.ok(child.exitCode!==null||child.signalCode!==null);assert.equal(await readFile(path.join(root,'source.cjs'),'utf8'),source);
      console.log(JSON.stringify({status:'passed',agent:version,transport:'MCP HTTP loopback',checks:['advice unchanged source','isolated source edit','Node semantic verification','diff review','apply','restore bytes/index/HEAD','cancel process'],advice:advice.content[0].text,summary:summary.content[0].text}));
    }finally{await connector?.dispose();await checkout?.dispose();await rm(root,{recursive:true,force:true});}
  });
