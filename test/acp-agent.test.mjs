import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {McpStdioConnector} from '../dist/mcpStdioConnector.js';
import {AcpAgent} from '../dist/acpAgent.js';
import {callMcpAction} from '../dist/mcpActionClient.js';

// A real stdio process exercises ACP framing, server requests and session isolation.
// It is a protocol fixture, not a response from Claude or another model.
const program=String.raw`
const readline=require('readline'),path=require('path');
const native=process.argv[1]==='native',sessions=new Map(),waiting=new Map();let next=0,requestId=1000;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const response=(id,result)=>send({jsonrpc:'2.0',id,result});
const client=(method,params)=>new Promise(resolve=>{const id=++requestId;waiting.set(id,resolve);send({jsonrpc:'2.0',id,method,params})});
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const message=JSON.parse(line),{id,method,params={}}=message;
 if(!method){waiting.get(id)?.(message);waiting.delete(id);return}
 if(params._meta){send({jsonrpc:'2.0',id,error:{code:-32600,message:'MCP metadata is not ACP'}});return}
 if(method==='initialize')return response(id,{protocolVersion:1,agentInfo:{name:process.argv[2]},agentCapabilities:{sessionCapabilities:native?{fork:{}}:{}}});
 if(method==='session/new'||method==='session/fork'){
  const sessionId='session-'+(++next),parent=sessions.get(params.sessionId);
  if(method==='session/fork'&&!parent)return send({jsonrpc:'2.0',id,error:{code:-32602}});
  sessions.set(sessionId,{root:params.cwd,marker:parent?.marker});
  return response(id,{sessionId,modes:{currentModeId:'accept-edits',availableModes:[{id:'accept-edits',name:'Edit'},{id:'ask',name:'Ask'},{id:'plan',name:'Plan'}]}});
 }
 if(method==='session/set_mode')return response(id,{});
 if(method==='session/cancel')return;
 if(method==='session/prompt'){
  const session=sessions.get(params.sessionId),prompt=params.prompt[0].text;let text;
  if(prompt.includes('WAIT'))return;
  if(prompt.includes('WRITE_TRIAL')||prompt.includes('OUTSIDE_WRITE')){
   const target=path.join(session.root,prompt.includes('OUTSIDE_WRITE')?'../outside.txt':'source.txt');
   const reply=await client('fs/write_text_file',{sessionId:params.sessionId,path:target,content:'trial\n'});text=reply.error?'DENIED':'EDITED';
  }else if(prompt.includes('SET_MARKER:')){session.marker=prompt.split('SET_MARKER:')[1].trim();text='READY'}else text=session.marker||'UNKNOWN';
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
  return response(id,{stopReason:'end_turn'});
 }
 send({jsonrpc:'2.0',id,error:{code:-32601}});
});`;

async function fixture(native,name,run){
  const root=await mkdtemp(path.join(os.tmpdir(),'perfchecker-acp-test-'));
  const connector=new McpStdioConnector({command:process.execPath,args:['-e',program,native?'native':'replay',name],cwd:root,
    version:'2026-07-28',timeoutMs:3000,agent:new AcpAgent(root)});
  try {
    await connector.start();
    const config={protocol:'mcp_http',endpoint:connector.endpoint,mcp_tool:'ask_perfchecker',mcp_version:'2026-07-28',timeout:3,api_key_env:connector.keyEnvironment};
    await run({root,connector,config});
  } finally {await connector.dispose();await rm(root,{recursive:true,force:true});}
}

for(const name of ['Vibe-shaped ACP fixture','Claude-shaped ACP fixture'])
test(`${name}: native forks preserve the parent and use the common MCP contract`,async()=>fixture(true,name,async({config})=>{
  const first=await callMcpAction(config,{prompt:'SET_MARKER:CEDAR'});
  assert.equal(first.text,'READY');assert.equal(first.agentSession.provider,'acp');
  const branch=await callMcpAction(config,{prompt:'SET_MARKER:AMBER',parentSession:first.agentSession,replayPrompt:'Wrong branch'});
  assert.equal(branch.historyMode,'native-fork');assert.notEqual(branch.agentSession.id,first.agentSession.id);
  const original=await callMcpAction(config,{prompt:'Read the marker.',parentSession:first.agentSession});assert.equal(original.text,'CEDAR');
  const child=await callMcpAction(config,{prompt:'Read the marker.',parentSession:branch.agentSession});assert.equal(child.text,'AMBER');
}));

test('an ACP agent without forks receives branch context and does not advertise native sessions',async()=>fixture(false,'No-fork fixture',async({config})=>{
  const result=await callMcpAction(config,{prompt:'Unused',replayPrompt:'SET_MARKER:REPLAY',parentSession:{provider:'acp',connection:'old',id:'foreign'}});
  assert.equal(result.text,'READY');assert.equal(result.historyMode,'context-replay');assert.equal(result.agentSession,undefined);
}));

test('ACP source writes require an isolated trial and stay inside its root',async()=>fixture(true,'File-service fixture',async({root,config})=>{
  assert.equal((await callMcpAction(config,{prompt:'WRITE_TRIAL'})).text,'DENIED');
  await assert.rejects(access(path.join(root,'source.txt')));
  const temporary=await mkdtemp(path.join(os.tmpdir(),'perfchecker-implementation-acp-')),checkout=path.join(temporary,'checkout');
  try {
    await mkdir(checkout);await writeFile(path.join(checkout,'source.txt'),'original\n');
    const implementation={...config,mcp_tool:'implement_perfchecker'};
    assert.equal((await callMcpAction(implementation,{prompt:'WRITE_TRIAL',arguments:{workspace:checkout}})).text,'EDITED');
    assert.equal(await readFile(path.join(checkout,'source.txt'),'utf8'),'trial\n');
    assert.equal((await callMcpAction(implementation,{prompt:'OUTSIDE_WRITE',arguments:{workspace:checkout}})).text,'DENIED');
    await assert.rejects(access(path.join(temporary,'outside.txt')));
  } finally {await rm(temporary,{recursive:true,force:true});}
}));

test('cancelling an ACP action drains the actual owned process before disconnect completes',async()=>fixture(true,'Cancellation fixture',async({config,connector})=>{
  const abort=new AbortController(),pid=connector.child.pid;
  const pending=callMcpAction(config,{prompt:'WAIT'},abort.signal);
  setTimeout(()=>abort.abort(),100);await assert.rejects(pending,/cancelled/);
  await connector.dispose();assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.equal(process.env[connector.keyEnvironment],undefined);
}));
