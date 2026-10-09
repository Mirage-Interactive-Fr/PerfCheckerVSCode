import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {spawn as nativeSpawn} from 'node:child_process';
import * as nativeChildProcess from 'node:child_process';
import {mkdtemp, writeFile, readFile, mkdir, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Exercise HTTP and real process lifetime with a sacrificial CLI, not a model response claim.
let fixture;
const require = createRequire(import.meta.url), original = Module._load;
Module._load = function(name, ...args) {
  if (name === './windowsOwnedProcess') {
    const owner = original.call(this, name, ...args);
    return {...owner, spawnWindowsOwnedProcess: (cli, argv, options) => {
      const child=cli === 'sacrificial-codex' ? owner.spawnWindowsOwnedProcess(process.execPath,[fixture,...argv],options) : owner.spawnWindowsOwnedProcess(cli,argv,options);
      if(cli==='sacrificial-codex'){
        const started=Date.now();let stdoutBytes=0,stderrBytes=0,firstOutput;
        const output=(kind,chunk)=>{if(firstOutput===undefined)firstOutput=Date.now()-started;kind==='stdout'?stdoutBytes+=Buffer.byteLength(chunk):stderrBytes+=Buffer.byteLength(chunk);};
        child.stdout.on('data',chunk=>output('stdout',chunk));child.stderr.on('data',chunk=>output('stderr',chunk));
        child.once('close',(code,signal)=>console.log(JSON.stringify({event:'sacrificial-windows-cli-timing',phase:argv[0]==='exec'?'exec-help':argv[0],
          milliseconds:Date.now()-started,firstOutputMilliseconds:firstOutput,stdoutBytes,stderrBytes,code,signal})));
      }
      return child;
    }};
  }
  if (name === 'node:child_process') return {...nativeChildProcess, spawn: (cli, argv, options) =>
    cli === 'sacrificial-codex' ? nativeSpawn(process.execPath, [fixture, ...argv], options) : nativeSpawn(cli, argv, options)};
  return original.call(this, name, ...args);
};
let CodexConnector, inspectCodex;
try {({CodexConnector, inspectCodex} = require('../dist/codexConnector.js'));} finally {Module._load = original;}

async function environment(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-codex-contract-'));
  fixture = path.join(root, 'cli.cjs');
  await writeFile(fixture, `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const args=process.argv.slice(2);if(args[0]==='--version'){console.log('codex-cli 0.159.2');process.exit(0)}
if(args[0]==='--help'){console.log('--no-daemon');process.exit(0)}
if(args[1]==='--help'){console.log('--ephemeral --sandbox --output-last-message --json --skip-git-repo-check --ignore-user-config --ignore-rules');process.exit(0)}
if(args[0]==='login'){process.exit(process.env.PERFCHECKER_FAKE_AUTH==='no'?1:0)}
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{
fs.writeFileSync(path.join(process.cwd(),'captured.json'),JSON.stringify({args,prompt,leaked:Object.keys(process.env).some(k=>k.startsWith('PERFCHECKER_CODEX_TOKEN_'))}));
if(prompt.includes('EXIT_WITH_CHILD')||prompt.includes('OWNED_ACTIVE_CHILD')){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});fs.writeFileSync(path.join(process.cwd(),'exited-cli.json'),JSON.stringify({leader:process.pid,descendant:child.pid}));if(prompt.includes('EXIT_WITH_CHILD'))process.exit(0);setInterval(()=>{},1000);return}
if(prompt.includes('SLOW')){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)']);fs.writeFileSync(path.join(process.cwd(),'descendant.pid'),String(child.pid));setInterval(()=>{},1000);return}
if(args[args.indexOf('--sandbox')+1]==='workspace-write')fs.writeFileSync(path.join(process.cwd(),'source.txt'),'optimized\\n');
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],prompt.includes('OVERSIZED')?'x'.repeat(64001):'Review the allocation evidence and verify the suggested changes.');});`);
  try {await run(root);} finally {delete process.env.PERFCHECKER_FAKE_AUTH; await rm(root, {recursive: true, force: true});}
}
const metadata=version=>({'io.modelcontextprotocol/protocolVersion':version,
  'io.modelcontextprotocol/clientInfo':{name:'Connector contract test',version:'1'},
  'io.modelcontextprotocol/clientCapabilities':{}});
async function request(connector, method, params = {}, {signal,version='2026-07-28',headers={},body} = {}) {
  const response = await fetch(connector.endpoint, {method: 'POST', signal,
    headers: {'Content-Type': 'application/json', Accept:'application/json, text/event-stream',
      Authorization: `Bearer ${connector.token}`, 'MCP-Protocol-Version': version,
      ...(version==='2025-11-25'?{}:{'Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':params.name}:{})}),...headers},
    body: body ?? JSON.stringify({jsonrpc: '2.0', id: 1, method,
      params:version==='2025-11-25'?params:{...params,_meta:metadata(version)}})});
  return {status:response.status,message:await response.json()};
}
async function call(connector, method, params, signal) {
  const {status,message}=await request(connector,method,params,{signal});
  assert.equal(status,200,JSON.stringify(message));assert.equal(message.error,undefined,JSON.stringify(message));
  assert.equal(message.result.resultType,'complete');
  return message.result;
}
const tool = (connector, name, args, signal) => call(connector, 'tools/call', {name, arguments: args}, signal);
async function until(read) {for (let i=0;i<(process.platform==='win32'?1000:100);i++) {try {return await read();} catch {await new Promise(r=>setTimeout(r,20));}} throw new Error('Fixture process did not start.');}

test('modern discovery is authenticated, stateless and never starts a CLI; legacy 2025 remains distinct',async()=>environment(async root=>{
  const connector=await new CodexConnector({cli:path.join(root,'must-not-run'),root}).start();
  try{
    for(const options of [{headers:{Authorization:'Bearer invalid'}},{headers:{Origin:'https://example.test'}}]){
      const response=await fetch(connector.endpoint,{method:'POST',headers:{Authorization:`Bearer ${connector.token}`,...options.headers},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover'})});
      assert.equal(response.status,401);
    }
    // There is deliberately no initialize request before these modern operations.
    const discovered=await call(connector,'server/discover');
    assert.deepEqual(discovered.supportedVersions,['2026-07-28','2025-11-25']);
    assert.deepEqual(discovered.capabilities,{tools:{}});
    assert.equal(discovered._meta['io.modelcontextprotocol/serverInfo'].name,'PerfChecker local Codex connector');
    assert.equal(discovered.ttlMs,0);assert.equal(discovered.cacheScope,'private');
    const listed=await call(connector,'tools/list');
    assert.deepEqual(listed.tools.map(tool=>tool.name),['ask_perfchecker','implement_perfchecker']);
    assert.equal(listed.ttlMs,0);assert.equal(listed.cacheScope,'private');
    const legacy=await request(connector,'initialize',{protocolVersion:'2025-11-25'},{version:'2025-11-25'});
    assert.equal(legacy.status,200);assert.equal(legacy.message.result.protocolVersion,'2025-11-25');
    assert.equal(legacy.message.result.resultType,undefined);
    const initialized=await fetch(connector.endpoint,{method:'POST',headers:{Authorization:`Bearer ${connector.token}`,'MCP-Protocol-Version':'2025-11-25'},
      body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
    assert.equal(initialized.status,202);assert.equal(await initialized.text(),'');
    const legacyTools=await request(connector,'tools/list',{}, {version:'2025-11-25'});
    assert.equal(legacyTools.status,200);assert.deepEqual(legacyTools.message.result.tools,listed.tools);
    assert.equal(legacyTools.message.result.resultType,undefined);
    const errors=[
      ['server/discover',{}, {version:'2099-01-01'},400,-32022],
      ['server/discover',{}, {headers:{'Mcp-Method':'tools/list'}},400,-32020],
      ['tools/call',{name:'ask_perfchecker',arguments:{prompt:'Never run'}},{headers:{'Mcp-Name':'implement_perfchecker'}},400,-32020],
      ['server/discover',{}, {body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover',params:{}})},400,-32602],
      ['server/discover',{}, {body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover',params:{_meta:metadata('2025-11-25')}})},400,-32020],
      ['initialize',{protocolVersion:'2026-07-28'},{},404,-32601],
      ['unavailable/method',{}, {},404,-32601],
      ['tools/call',{name:'unavailable_tool',arguments:{}},{},400,-32602],
    ];
    for(const [method,params,options,status,code]of errors){
      const received=await request(connector,method,params,options);
      assert.equal(received.status,status,JSON.stringify(received));assert.equal(received.message.error.code,code);
      assert.equal(received.message.result,undefined,'Protocol failures must not masquerade as tool results');
      if(code===-32022)assert.deepEqual(received.message.error.data,{supported:['2026-07-28','2025-11-25'],requested:'2099-01-01'});
    }
    for(const [body,code]of [['{',-32700],['[]',-32600],[JSON.stringify({jsonrpc:'2.0',method:'server/discover',id:null}),-32600]]){
      const malformed=await request(connector,'server/discover',{}, {body});
      assert.equal(malformed.status,400);assert.equal(malformed.message.error.code,code);
      assert.equal(malformed.message.id,null,'Malformed requests with no readable ID must return JSON-RPC id:null');
    }
    assert.equal(connector.children.size,0);assert.equal(connector.busy,false);
    await assert.rejects(readFile(path.join(root,'captured.json')),error=>error.code==='ENOENT');
  }finally{await connector.dispose();}
  assert.equal(process.env[connector.keyEnvironment],undefined);await assert.rejects(fetch(connector.endpoint));
}));

test('authenticated local MCP exposes two exact tools and never forwards its token to Codex', async () => environment(async root => {
  assert.equal(await inspectCodex('sacrificial-codex', root), 'codex-cli 0.159.2');
  process.env.PERFCHECKER_FAKE_AUTH = 'no'; await assert.rejects(inspectCodex('sacrificial-codex', root), /not authenticated/);
  delete process.env.PERFCHECKER_FAKE_AUTH;
  const connector = await new CodexConnector({cli:'sacrificial-codex', root}).start();
  try {
    assert.equal((await fetch(connector.endpoint, {method:'POST'})).status,401);
    assert.equal((await fetch(connector.endpoint, {method:'POST',headers:{Authorization:`Bearer ${connector.token}`,Origin:'https://example.test'}})).status,401);
    const discovered=await call(connector,'server/discover');assert(discovered.supportedVersions.includes('2026-07-28'));
    const listed=await call(connector,'tools/list'); assert.deepEqual(listed.tools.map(t=>t.name),['ask_perfchecker','implement_perfchecker']);
    assert.deepEqual(listed.tools[1].inputSchema.required,['prompt','workspace']);
    assert.equal(listed.tools[1].inputSchema.additionalProperties,false);
    assert.match((await tool(connector,'ask_perfchecker',{prompt:'Advice only.'})).content[0].text,/allocation evidence/);
    const captured=JSON.parse(await readFile(path.join(root,'captured.json'),'utf8'));
    assert.equal(captured.leaked,false);assert.equal(captured.args[captured.args.indexOf('--sandbox')+1],'read-only');
    assert.ok(captured.args.includes('--ignore-user-config'));assert.ok(captured.args.includes('--ignore-rules'));assert.ok(captured.args.includes('--ephemeral'));
    assert.equal(captured.args[0],'--no-daemon');assert.equal(captured.args[1],'exec');
    assert.ok(!captured.args.includes('--model'));assert.match(captured.prompt,/Give advice only/);
    const legacyAdvice=await request(connector,'tools/call',{name:'ask_perfchecker',arguments:{prompt:'Legacy advice only.'}},{version:'2025-11-25'});
    assert.equal(legacyAdvice.status,200);assert.match(legacyAdvice.message.result.content[0].text,/allocation evidence/);
    assert.equal(legacyAdvice.message.result.resultType,undefined);
    const encodedAdvice=await request(connector,'tools/call',{name:'ask_perfchecker',arguments:{prompt:'Encoded tool name.'}},
      {headers:{'Mcp-Name':'=?base64?'+Buffer.from('ask_perfchecker').toString('base64')+'?='}});
    assert.equal(encodedAdvice.status,200);assert.equal(encodedAdvice.message.result.resultType,'complete');
    assert.equal((await tool(connector,'ask_perfchecker',{prompt:'Unexpected',workspace:root})).isError,true);
    assert.equal((await tool(connector,'implement_perfchecker',{prompt:'Edit',workspace:root})).isError,true);
    assert.equal((await tool(connector,'ask_perfchecker',{prompt:'OVERSIZED'})).isError,true);
    assert.equal((await tool(connector,'ask_perfchecker',{prompt:'Retry'})).isError,undefined);
  } finally {await connector.dispose();}
  assert.equal(process.env[connector.keyEnvironment],undefined);
  await assert.rejects(fetch(connector.endpoint));
}));

test('implementation accepts a canonical PerfChecker checkout and uses workspace-write without touching original files', async () => environment(async root => {
  const temporary=await mkdtemp(path.join(tmpdir(),'perfchecker-implementation-contract-')), checkout=path.join(temporary,'checkout');
  await mkdir(checkout);await writeFile(path.join(checkout,'source.txt'),'original\n');await writeFile(path.join(root,'source.txt'),'original\n');
  const connector=await new CodexConnector({cli:'sacrificial-codex',root}).start();
  try {
    assert.equal((await tool(connector,'implement_perfchecker',{prompt:'Implement reviewed advice.',workspace:checkout})).isError,undefined);
    assert.equal(await readFile(path.join(checkout,'source.txt'),'utf8'),'optimized\n');assert.equal(await readFile(path.join(root,'source.txt'),'utf8'),'original\n');
    const captured=JSON.parse(await readFile(path.join(checkout,'captured.json'),'utf8'));
    assert.equal(captured.args[captured.args.indexOf('-C')+1],await realpath(checkout));assert.equal(captured.args[captured.args.indexOf('--sandbox')+1],'workspace-write');
    assert.match(captured.prompt,/Do not publish, push, deploy/);
  } finally {await connector.dispose();await rm(temporary,{recursive:true,force:true});}
}));

test('timeout, HTTP cancellation and disposal stop the actual CLI process tree and permit retry', async () => environment(async root => {
  for (const mode of ['timeout','cancel','dispose']) {
    await rm(path.join(root,'descendant.pid'),{force:true});
    const connector=await new CodexConnector({cli:'sacrificial-codex',root,timeoutMs:mode==='timeout'?(process.platform==='win32'?10000:300):30000}).start();
    try {
    const controller=new AbortController();
    const pending=tool(connector,'ask_perfchecker',{prompt:'SLOW'},controller.signal);
    const handled=pending.catch(error=>error);
    const pid=Number(await until(()=>readFile(path.join(root,'descendant.pid'),'utf8')));
    const overlapping=await tool(connector,'ask_perfchecker',{prompt:'Second request'});assert.equal(overlapping.isError,true);assert.match(overlapping.content[0].text,/already handling/);
    if(mode==='cancel')controller.abort();if(mode==='dispose')await connector.dispose();
    const result=await handled;if(mode==='timeout'){assert.equal(result.isError,true);assert.match(result.content[0].text,/timed out/);}
    await until(async()=>{try{process.kill(pid,0);}catch{return true;}
      if(process.platform==='linux' && /\) Z /.test(await readFile(`/proc/${pid}/stat`,'utf8')))return true;
      throw new Error('Descendant still running');});
    if(mode!=='dispose')await until(async()=>{const retry=await tool(connector,'ask_perfchecker',{prompt:'Retry'});
      if(retry.isError)throw new Error(retry.content[0].text);return retry;});
    } finally {await connector.dispose();}
  }
}));

test('timeout, HTTP cancellation and disposal reclaim the owned CLI descendants before teardown', async t => environment(async root => {
  const failures=[], processObservations=[];
  const alive=async pid=>{
    try{process.kill(pid,0);}catch(error){
      if(error.code!=='ESRCH')throw error;
      processObservations.push({pid,state:'absent',code:error.code});return false;
    }
    if(process.platform==='linux'){
      try{
        const stat=await readFile(`/proc/${pid}/stat`,'utf8'), fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
        processObservations.push({pid,state:fields[0],startTicks:fields[19],statBytes:stat.length});
        return fields[0]!=='Z';
      }catch(error){
        if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;
        processObservations.push({pid,state:'absent',code:error.code});return false;
      }
    }
    return true;
  };
  for(const mode of ['timeout','cancel','dispose']){
    processObservations.length=0;
    await rm(path.join(root,'exited-cli.json'),{force:true});
    const windows=process.platform==='win32';
    const connector=await new CodexConnector({cli:'sacrificial-codex',root,timeoutMs:mode==='timeout'?(windows?10000:350):30000}).start();
    const controller=new AbortController();
    const request=tool(connector,'ask_perfchecker',{prompt:windows?'OWNED_ACTIVE_CHILD':'EXIT_WITH_CHILD'},controller.signal).catch(error=>error);
    let owned;
    try{
      owned=JSON.parse(await until(()=>readFile(path.join(root,'exited-cli.json'),'utf8')));
      if(!windows)await until(async()=>{if(await alive(owned.leader))throw new Error('The CLI leader has not exited yet');return true;});
      assert(await alive(owned.descendant),'The inherited-stream descendant is actually alive before the owned stop');
      const leaderAliveBeforeStop=await alive(owned.leader);
      assert.equal(leaderAliveBeforeStop,windows,'POSIX reproduces an exited leader; Windows owns and stops the Job immediately on natural leader exit (tested separately)');
      if(mode==='cancel')controller.abort();
      const disposal=mode==='dispose'?connector.dispose():undefined;
      const deadline=Date.now()+(windows?15000:2500);
      let survivingBeforeHarnessCleanup=await alive(owned.descendant);
      while(survivingBeforeHarnessCleanup&&Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,20));
        survivingBeforeHarnessCleanup=await alive(owned.descendant);
      }
      t.diagnostic(JSON.stringify({mode,...owned,leaderAliveBeforeStop,survivingBeforeHarnessCleanup,processObservations}));
      assert.equal(survivingBeforeHarnessCleanup,false,`${mode}: the owned descendant must stop before fixture teardown`);
      await disposal;
      const result=await request;
      if(mode==='timeout'){assert.equal(result.isError,true);assert.match(result.content[0].text,/timed out/);}
      if(mode!=='dispose'){
        await until(async()=>{
          const retry=await tool(connector,'ask_perfchecker',{prompt:'Retry'});
          assert.equal(retry.isError,undefined,'Cleanup returns the connector to idle');return retry;
        });
      }
    }catch(error){t.diagnostic(JSON.stringify({mode,error:String(error),stack:error.stack,processObservations}));failures.push(error);}
    finally{
      // Only the PID reported by this disposable fixture is eligible for teardown.
      if(owned&&await alive(owned.descendant)){
        try{process.kill(owned.descendant,'SIGKILL');}
        catch(error){if(error.code!=='ESRCH')throw error;}
      }
      await connector.dispose();await request;
    }
  }
  if(failures.length)throw new AggregateError(failures,'Exited CLI descendants survived before harness cleanup');
}));
