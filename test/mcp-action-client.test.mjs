import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {callMcpAction} from '../dist/mcpActionClient.js';

async function fixture(callback, options={}) {
  const messages=[];
  const server=http.createServer(async(req,res)=>{
    if(req.method==='DELETE'){res.writeHead(204);res.end();return;}
    let bytes='';for await(const chunk of req)bytes+=chunk;
    const message=JSON.parse(bytes);messages.push({message,headers:req.headers});
    if(message.method==='notifications/initialized'){res.writeHead(202);res.end();return;}
    let result;
    if(message.method==='initialize'){
      res.setHeader('mcp-session-id','test-session');
      result={protocolVersion:'2025-11-25',capabilities:{tools:{}}};
    }else if(message.method==='tools/list')result={tools:[{name:'analyze',inputSchema:{type:'object',properties:{prompt:{type:'string'},parent:{type:'string'}},required:['prompt']},
      ...(options.native?{_meta:{'perfchecker/conversation':{provider:'fixture',connection:'connection-a',forkArgument:'parent'}}}:{})}]};
    else if(message.method==='tools/call')result={content:[{type:'text',text:'A useful result.'}],
      ...(options.native?{_meta:{'perfchecker/agentSession':{provider:'fixture',connection:'connection-a',id:'session-b'}}}:{})};
    else throw new Error('Unexpected fixture request');
    const body=JSON.stringify({jsonrpc:'2.0',id:message.id,result});
    if(options.sse&&message.method==='tools/call'){
      res.setHeader('content-type','text/event-stream');
      // A complete response must finish the action even though the stream stays open.
      res.write('data: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{}})+'\r\n\r\n');
      for(const byte of Buffer.from('data: '+body+'\r\n\r\n'))res.write(Buffer.from([byte]));
    }else{res.setHeader('content-type','application/json');res.end(body);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={protocol:'mcp_http',endpoint:`http://127.0.0.1:${server.address().port}/mcp`,mcp_tool:'analyze',
    mcp_prompt_argument:'prompt',mcp_version:options.legacy?'2025-11-25':'2026-07-28',timeout:3};
  try{return await callback(config,messages);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

test('guided actions negotiate legacy sessions and make exactly the selected tool call',async()=>{
  await fixture(async(config,messages)=>{
    const result=await callMcpAction(config,{prompt:'Selected check results.'});
    assert.equal(result.text,'A useful result.');
    assert.deepEqual(messages.map(m=>m.message.method),['initialize','notifications/initialized','tools/list','tools/call']);
    assert.equal(messages.at(-1).message.params.name,'analyze');
    assert.equal(messages.at(-1).headers['mcp-session-id'],'test-session');
  },{legacy:true});
});

test('a declared native fork receives the parent handle and leaves unrelated branch history out',async()=>{
  await fixture(async(config,messages)=>{
    const result=await callMcpAction(config,{prompt:'New action.',replayPrompt:'Portable full branch.',
      parentSession:{provider:'fixture',connection:'connection-a',id:'session-a'}});
    assert.equal(result.historyMode,'native-fork');assert.equal(result.agentSession.id,'session-b');
    assert.deepEqual(messages.at(-1).message.params.arguments,{prompt:'New action.',parent:'session-a'});
    assert.equal(messages.at(-1).headers['mcp-method'],'tools/call');
    assert.equal(messages.at(-1).message.params._meta['io.modelcontextprotocol/protocolVersion'],'2026-07-28');
  },{native:true});
});

test('a provider without native forks receives the actual branch replay, including after reconnect',async()=>{
  for(const native of [false,true])await fixture(async(config,messages)=>{
    const result=await callMcpAction(config,{prompt:'New action.',replayPrompt:'Previous response and test feedback.',
      parentSession:{provider:'fixture',connection:'an-older-connection',id:'session-a'}});
    assert.equal(result.historyMode,'context-replay');
    assert.deepEqual(messages.at(-1).message.params.arguments,{prompt:'Previous response and test feedback.'});
  },{native});
});

test('SSE notifications, split byte boundaries and an open stream preserve the final action result',async()=>{
  await fixture(async config=>assert.equal((await callMcpAction(config,{prompt:'Analyze this.'})).text,'A useful result.'),{sse:true});
});

test('invalid endpoints and unconfigured remote access fail before making a request',async()=>{
  for(const endpoint of ['https://remote.example/mcp','http://user:secret@127.0.0.1/mcp','file:///tmp/agent'])
    await assert.rejects(callMcpAction({protocol:'mcp_http',endpoint,mcp_tool:'analyze'},{prompt:'Analyze.'}),/endpoint/);
});
