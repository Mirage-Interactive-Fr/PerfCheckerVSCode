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
if(prompt.includes('SLOW')){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)']);fs.writeFileSync(path.join(process.cwd(),'descendant.pid'),String(child.pid));setInterval(()=>{},1000);return}
if(args[args.indexOf('--sandbox')+1]==='workspace-write')fs.writeFileSync(path.join(process.cwd(),'source.txt'),'optimized\\n');
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],prompt.includes('OVERSIZED')?'x'.repeat(64001):'Review the allocation evidence and verify the suggested changes.');});`);
  try {await run(root);} finally {delete process.env.PERFCHECKER_FAKE_AUTH; await rm(root, {recursive: true, force: true});}
}
async function call(connector, method, params, signal) {
  const response = await fetch(connector.endpoint, {method: 'POST', signal,
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${connector.token}`, 'MCP-Protocol-Version': '2026-07-28'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
  return (await response.json()).result;
}
const tool = (connector, name, args, signal) => call(connector, 'tools/call', {name, arguments: args}, signal);
async function until(read) {for (let i=0;i<100;i++) {try {return await read();} catch {await new Promise(r=>setTimeout(r,20));}} throw new Error('Fixture process did not start.');}

test('authenticated local MCP exposes two exact tools and never forwards its token to Codex', async () => environment(async root => {
  assert.equal(await inspectCodex('sacrificial-codex', root), 'codex-cli 0.159.2');
  process.env.PERFCHECKER_FAKE_AUTH = 'no'; await assert.rejects(inspectCodex('sacrificial-codex', root), /not authenticated/);
  delete process.env.PERFCHECKER_FAKE_AUTH;
  const connector = await new CodexConnector({cli:'sacrificial-codex', root}).start();
  try {
    assert.equal((await fetch(connector.endpoint, {method:'POST'})).status,401);
    assert.equal((await fetch(connector.endpoint, {method:'POST',headers:{Authorization:`Bearer ${connector.token}`,Origin:'https://example.test'}})).status,401);
    const initialized=await call(connector,'initialize',{protocolVersion:'2026-07-28'}); assert.equal(initialized.protocolVersion,'2026-07-28');
    const listed=await call(connector,'tools/list'); assert.deepEqual(listed.tools.map(t=>t.name),['ask_perfchecker','implement_perfchecker']);
    assert.deepEqual(listed.tools[1].inputSchema.required,['prompt','workspace']);
    assert.equal(listed.tools[1].inputSchema.additionalProperties,false);
    assert.match((await tool(connector,'ask_perfchecker',{prompt:'Advice only.'})).content[0].text,/allocation evidence/);
    const captured=JSON.parse(await readFile(path.join(root,'captured.json'),'utf8'));
    assert.equal(captured.leaked,false);assert.equal(captured.args[captured.args.indexOf('--sandbox')+1],'read-only');
    assert.ok(captured.args.includes('--ignore-user-config'));assert.ok(captured.args.includes('--ignore-rules'));assert.ok(captured.args.includes('--ephemeral'));
    assert.equal(captured.args[0],'--no-daemon');assert.equal(captured.args[1],'exec');
    assert.ok(!captured.args.includes('--model'));assert.match(captured.prompt,/Give advice only/);
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
    const connector=await new CodexConnector({cli:'sacrificial-codex',root,timeoutMs:mode==='timeout'?300:10000}).start();
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
