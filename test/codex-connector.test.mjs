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
let CodexConnector, inspectCodex, shutdownCodexPreflights;
try {({CodexConnector, inspectCodex, shutdownCodexPreflights} = require('../dist/codexConnector.js'));} finally {Module._load = original;}

async function environment(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-codex-contract-'));
  fixture = path.join(root, 'cli.cjs');
  await writeFile(fixture, `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const args=process.argv.slice(2);
function execImage(){const child=cp.spawn('/bin/sh',['-c','while [ ! -e "$1" ]; do sleep 0.02; done; exec /bin/sleep 1000','--',path.join(process.cwd(),'release-exec')],{stdio:'ignore'});fs.writeFileSync('exec-image.json',JSON.stringify({leader:process.pid,child:child.pid}));setInterval(()=>{if(fs.existsSync('release-parent'))process.exit(0)},10)}
if(args[0]==='--exec-owner'){execImage();return}
if(args[0]==='--cohort-detached'){const leaf=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('cohort.json',JSON.stringify({middle:process.ppid,detached:process.pid,leaf:leaf.pid}));setInterval(()=>{},1000);return}
if(args[0]==='--cohort-middle'){cp.spawn(process.execPath,[__filename,'--cohort-detached'],{detached:true,stdio:'ignore'});setInterval(()=>{if(fs.existsSync('release-middle'))process.exit(0)},10);return}
if(args[0]==='--version'){console.log('codex-cli 0.159.2');process.exit(0)}
if(args[0]==='--help'){console.log('--no-daemon');process.exit(0)}
if(args[1]==='--help'){console.log('--ephemeral --sandbox --output-last-message --json --skip-git-repo-check --ignore-user-config --ignore-rules');process.exit(0)}
if(args[0]==='login'){process.exit(process.env.PERFCHECKER_FAKE_AUTH==='no'?1:0)}
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{
fs.writeFileSync(path.join(process.cwd(),'captured.json'),JSON.stringify({args,prompt,leaked:Object.keys(process.env).some(k=>k.startsWith('PERFCHECKER_CODEX_TOKEN_'))}));
if(prompt.includes('EXEC_IMAGE')){execImage();return}
if(prompt.includes('REPARENT_COHORT')){const middle=cp.spawn(process.execPath,[__filename,'--cohort-middle'],{stdio:'ignore'});fs.writeFileSync('cohort-leader.json',JSON.stringify({leader:process.pid,middle:middle.pid}));setInterval(()=>{if(fs.existsSync('release-leader'))process.exit(0)},10);return}
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

// No model/authentication: exercise the installed product bridge against a real
// disposable process cohort. Its ancestry is observed before either fork parent
// exits; the detached child and its child survive that reparenting naturally.
test('Codex owns an observed detached/reparented cohort through timeout, HTTP abort, disposal and natural exit',
  {skip:process.platform==='win32'},async t=>environment(async root=>{
  const identity=async pid=>{
    try{
      if(process.platform==='linux'){
        const raw=await readFile('/proc/'+pid+'/stat','utf8'),f=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
        if(['Z','X'].includes(f[0]))return undefined;
        return{pid,parent:Number(f[1]),group:Number(f[2]),session:Number(f[3]),start:f[19],exe:await realpath('/proc/'+pid+'/exe')};
      }
      const exec=(file,args)=>new Promise((resolve,reject)=>nativeChildProcess.execFile(file,args,{timeout:2000},(error,stdout)=>error?reject(error):resolve(stdout)));
      const raw=await exec('/bin/ps',['-p',String(pid),'-o','pid=,ppid=,pgid=,sess=,stat=,lstart=']);
      const m=raw.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
      if(!m||/^[ZX]/.test(m[5]))return undefined;
      const mapped=await exec('/usr/sbin/lsof',['-a','-p',String(pid),'-d','txt','-Fn']);
      const filename=mapped.split('\n').find(x=>x.startsWith('n/'))?.slice(1);assert(filename);
      return{pid,parent:Number(m[2]),group:Number(m[3]),session:m[4],state:m[5],start:m[6],exe:await realpath(filename)};
    }catch(error){if(['ENOENT','ESRCH'].includes(error.code)||error.code===1)return undefined;throw error;}
  };
  for(const mode of ['timeout','cancel','dispose','natural-exit'])await t.test(mode,async()=>{
    for(const file of ['cohort.json','cohort-leader.json','release-middle','release-leader'])await rm(path.join(root,file),{force:true});
    const foreign=nativeSpawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,detached:true,stdio:'ignore'});
    const connector=await new CodexConnector({cli:'sacrificial-codex',root,timeoutMs:mode==='timeout'?5000:30000}).start();
    const abort=new AbortController(),pending=tool(connector,'ask_perfchecker',{prompt:'REPARENT_COHORT'},abort.signal).catch(error=>error);
    const qualified=[];
    try{
      const leader=JSON.parse(await until(()=>readFile(path.join(root,'cohort-leader.json'),'utf8')));
      const cohort=JSON.parse(await until(()=>readFile(path.join(root,'cohort.json'),'utf8')));
      for(const pid of [leader.leader,cohort.middle,cohort.detached,cohort.leaf]){
        const current=await identity(pid);assert(current,'Every ancestor is alive before reparenting');qualified.push(current);
      }
      assert.equal(qualified[1].parent,leader.leader);assert.equal(qualified[2].parent,cohort.middle);assert.equal(qualified[3].parent,cohort.detached);
      assert.notEqual(qualified[2].group,qualified[0].group);
      if(process.platform==='linux')assert.notEqual(qualified[2].session,qualified[0].session);
      else{
        // Darwin ps sess exposes the kernel e_sess pointer, which XNU leaves
        // zero. Its stat 's' is the actual EPROC_SLEADER session-leader flag.
        assert.equal(qualified[2].group,qualified[2].pid);assert.match(qualified[2].state,/s/);
      }
      const owner=connector.owners?.values().next().value;
      if(owner?.cohort)await until(()=>{assert(qualified.every(row=>owner.cohort.known.get(row.pid)?.start===row.start));return true;});
      await writeFile(path.join(root,'release-middle'),'release');
      const reparented=await until(async()=>{assert.equal(await identity(cohort.middle),undefined);const row=await identity(cohort.detached);assert(row);assert.notEqual(row.parent,cohort.middle);return row;});
      assert.equal(reparented.start,qualified[2].start);assert.equal(reparented.exe,qualified[2].exe);
      assert(await identity(cohort.leaf));assert(await identity(foreign.pid));
      if(mode==='cancel')abort.abort();
      const disposal=mode==='dispose'?connector.dispose():undefined;
      if(mode==='natural-exit')await writeFile(path.join(root,'release-leader'),'release');
      const outcome=await pending;await disposal;
      // Fetch aborts before the server finishes ownership cleanup. Await its
      // actual retained request, without calling dispose as a cleanup oracle.
      await until(async()=>{assert.equal(connector.owners.size,0);assert.equal(connector.children.size,0);return true;});
      for(const row of qualified)assert.equal(await identity(row.pid),undefined,mode+': owned incarnation absent before harness teardown');
      assert(await identity(foreign.pid),'An unrelated process with the same executable/cwd survives');
      if(mode==='timeout'){assert.equal(outcome.isError,true);assert.match(outcome.content[0].text,/timed out/);}
      if(owner)assert.equal(connector.owners.size,0,'Only proven cleanup retires ownership');
      t.diagnostic(JSON.stringify({mode,qualified,reparented,ownedAbsentBeforeTeardown:true,foreignAlive:true}));
    }finally{
      abort.abort();
      // On a regression, reclaim only an exact incarnation recorded alive while
      // its full parent chain was still attached to this fixture's leader.
      for(const row of qualified.reverse()){
        const current=await identity(row.pid);
        if(current?.start===row.start&&current.exe===row.exe)try{process.kill(row.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
      }
      await connector.dispose();await pending;
      foreign.kill('SIGKILL');await new Promise(resolve=>foreign.once('close',resolve));
    }
  });
}));


test('Codex preflight handles a missing executable and rapid normal exit without retaining an owner',async()=>environment(async root=>{
  // POSIX spawn raises ENOENT; the Windows private launcher reports failure
  // through its exit code, which inspectCodex translates into the public refusal.
  await assert.rejects(inspectCodex(path.join(root,'missing-native-cli'),root),
    process.platform==='win32'?/^Error: Choose a Codex CLI executable, then reconnect\.$/:/ENOENT/);
  await shutdownCodexPreflights();
  for(let iteration=0;iteration<3;iteration++)assert.equal(await inspectCodex('sacrificial-codex',root),'codex-cli 0.159.2');
  await shutdownCodexPreflights();
}));

test('Codex recovers cleanup after a rejected initial identity inspection without losing its owner',
  {skip:process.platform==='win32',timeout:10000},async()=>environment(async root=>{
  const {PosixProcessCohort}=require('../dist/posixProcessCohort.js'),observe=PosixProcessCohort.prototype.observe;
  let failed=false,pid;
  PosixProcessCohort.prototype.observe=async function(initial,...args){
    if(initial&&!failed){failed=true;pid=this.child.pid;throw new Error('Controlled initial process inspection failure.');}
    return observe.call(this,initial,...args);
  };
  try{await assert.rejects(inspectCodex('sacrificial-codex',root),/Controlled initial/);}
  finally{PosixProcessCohort.prototype.observe=observe;}
  assert(failed&&pid);await shutdownCodexPreflights();
  const rows=await new PosixProcessCohort({pid},true).group(true);
  assert.equal(rows.length,0,'The rejected preflight process is physically absent before retry');
  assert.equal(await inspectCodex('sacrificial-codex',root),'codex-cli 0.159.2');
}));


test('a live unobservable Codex owner is retained, blocks new calls, and can be disconnected after observation recovers',
  {skip:process.platform==='win32',timeout:10000},async()=>environment(async root=>{
  const {PosixProcessCohort}=require('../dist/posixProcessCohort.js'),observe=PosixProcessCohort.prototype.observe;
  const connector=await new CodexConnector({cli:'sacrificial-codex',root}).start();
  let pid;
  PosixProcessCohort.prototype.observe=async function(initial,...args){
    pid??=this.child.pid;throw new Error('Controlled unavailable process inspection.');
  };
  try{
    const result=await tool(connector,'ask_perfchecker',{prompt:'Must never be sent without qualified ownership.'});
    assert.equal(result.isError,true);assert.match(result.content[0].text,/Controlled unavailable/);
    assert.equal(connector.owners.size,1);assert.equal(connector.children.size,1);
    assert(pid);process.kill(pid,0);
    const blocked=await tool(connector,'ask_perfchecker',{prompt:'No second invocation.'});
    assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/cleanup is incomplete/);
  }finally{PosixProcessCohort.prototype.observe=observe;await connector.dispose();}
  assert.equal(connector.owners.size,0);assert.equal(connector.children.size,0);
  const rows=await new PosixProcessCohort({pid},true).group(true);assert.equal(rows.length,0);
}));


test('Codex observes a real shell exec while its parent is owned; an exec after reparenting is refused explicitly',
  {skip:process.platform==='win32',timeout:15000},async t=>{
  const {PosixProcessCohort}=require('../dist/posixProcessCohort.js');
  const identity=async pid=>(await new PosixProcessCohort({pid},true).group(true)).find(row=>row.pid===pid);
  const image=await realpath('/bin/sleep');
  for(const mode of ['attached','reparented'])await t.test(mode,()=>environment(async root=>{
    const foreign=nativeSpawn('/bin/sleep',['1000'],{stdio:'ignore'}),foreignClosed=new Promise(resolve=>foreign.once('close',resolve));
    const abort=new AbortController();let connector,leader,closed,pending,cohort,owned,initial;
    try{
      if(mode==='attached'){
        connector=await new CodexConnector({cli:'sacrificial-codex',root,timeoutMs:10000}).start();
        pending=tool(connector,'ask_perfchecker',{prompt:'EXEC_IMAGE'},abort.signal).catch(error=>error);
      }else{
        leader=nativeSpawn(process.execPath,[fixture,'--exec-owner'],{cwd:root,detached:true,stdio:'ignore'});
        closed=new Promise(resolve=>leader.once('close',resolve));cohort=new PosixProcessCohort(leader,true);await cohort.observe(true);
      }
      owned=JSON.parse(await until(()=>readFile(path.join(root,'exec-image.json'),'utf8')));
      if(connector)cohort=connector.owners.values().next().value.cohort;
      await until(async()=>{await cohort.observe();assert(cohort.known.has(owned.child));return true;});
      initial=cohort.known.get(owned.child);assert.notEqual(initial.exe,image);assert.equal(initial.parent,owned.leader);
      if(mode==='reparented'){
        await writeFile(path.join(root,'release-parent'),'release');await closed;
        await until(async()=>{await cohort.observe();assert.notEqual(cohort.known.get(owned.child).parent,owned.leader);return true;});
      }
      await writeFile(path.join(root,'release-exec'),'release');
      const current=await until(async()=>{const row=await identity(owned.child);assert(row);assert.equal(row.exe,image);return row;});
      assert.equal(current.start,initial.start,'exec keeps the exact observed kernel birth');
      if(mode==='attached'){
        await until(()=>{assert.equal(cohort.known.get(owned.child).exe,image);return true;});
        abort.abort();await pending;await until(()=>{assert.equal(connector.owners.size,0);return true;});
        assert.equal(await identity(owned.child),undefined,'The new executable is stopped before harness cleanup');
      }else{
        await assert.rejects(cohort.observe(),/executable changed without a currently qualified live parent/);
        await assert.rejects(cohort.signal('SIGKILL'),/executable changed without a currently qualified live parent/);
        assert(await identity(owned.child),'The unresolved image is not signalled on incomplete ownership proof');
      }
      assert(await identity(foreign.pid),'The unrelated same-executable process survives');
      t.diagnostic(JSON.stringify({mode,pid:owned.child,start:initial.start,fromExecutable:initial.exe,toExecutable:current.exe,
        executableTransitionQualified:mode==='attached',cleanupRefusedExplicitly:mode==='reparented',foreignAlive:true}));
    }finally{
      abort.abort();
      // External fixture teardown has its own creation/birth proof, distinct
      // from the product's deliberately refused detached-image cleanup.
      if(owned&&initial){const current=await identity(owned.child);if(current?.start===initial.start)process.kill(owned.child,'SIGKILL');}
      if(leader&&await identity(leader.pid))leader.kill('SIGKILL');
      if(closed)await closed;if(connector)await connector.dispose();if(pending)await pending;
      foreign.kill('SIGKILL');await foreignClosed;
    }
  }));
});
