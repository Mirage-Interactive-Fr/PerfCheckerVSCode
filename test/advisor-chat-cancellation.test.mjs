import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {mkdtemp, rm, writeFile, readFile, stat} from 'node:fs/promises';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

const julia=process.env.PERFCHECKER_TEST_JULIA;
const project=process.env.PERFCHECKER_TEST_JULIA_PROJECT;
const execute=promisify(execFile);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};

// This optional integration uses the real installed Core and its detached HTTP
// worker. Only VS Code's configuration surface is supplied here; the native
// webview campaign independently clicks the same Cancel action.
test('chat cancellation waits for its real detached advisor worker and HTTP socket',
  {skip:!julia||!project||process.platform==='win32',timeout:360000},async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'perfchecker-chat-owner-'));
    const folder={name:'Disposable chat worker',uri:{scheme:'file',fsPath:root,toString:()=>`file://${root}`}};
    const values={runnerProject:project,scenarioProject:project,juliaExecutable:julia,advisorConfig:'',advisorProtocol:'mcp_http',advisorMcpTool:'ask_perfchecker',advisorMcpResponse:'text',advisorMcpVersion:'2026-07-28',advisorTimeout:180};
    const settings={get:(key,fallback)=>values[key]??fallback};
    const vscode={workspace:{getConfiguration:()=>settings,workspaceFolders:[folder],isTrusted:true}};
    const original=Module._load,require=createRequire(import.meta.url);
    Module._load=function(name,...args){return name==='vscode'?vscode:original.call(this,name,...args);};
    let AdvisorChat;
    try{({AdvisorChat}=require('../dist/advisorChat.js'));}finally{Module._load=original;}
    const context={workspaceState:{get:()=>undefined,update:async()=>undefined}};
    const {shutdownControllerProcesses}=require('../dist/controllerCancellation.js');
    const foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const foreignFinished=new Promise(resolve=>foreign.once('close',resolve));
    try{for(const mode of ['cancel','dispose','deactivation','timeout'])await t.test(mode,async()=>{
    const chat=new AdvisorChat(context,()=>[],async()=>undefined);
    let coreReply;
    const invoke=chat.invoke.bind(chat);
    chat.invoke=async(...args)=>{coreReply=await invoke(...args);return coreReply;};
    const sockets=new Set();let active,worker;
    const server=http.createServer(async(request,response)=>{
      let text='';for await(const bytes of request)text+=bytes;
      const message=JSON.parse(text);
      response.setHeader('content-type','application/json');
      if(message.method==='tools/list')response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,
        result:{tools:[{name:'ask_perfchecker',inputSchema:{type:'object',properties:{prompt:{type:'string'}},required:['prompt']}}]}}));
      else if(message.method==='tools/call'){
        assert.equal(message.params.name,'ask_perfchecker');
        active={socketClosed:false,responseClosed:false};
        request.socket.once('close',()=>{active.socketClosed=true;});
        response.once('close',()=>{active.responseClosed=true;});
        // No response is sent. A client-owned worker must close this socket.
      }else throw new Error(`Unexpected fixture method ${message.method}`);
    });
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    let outcome;
    try{
      values.advisorEndpoint=`http://127.0.0.1:${server.address().port}/mcp`;
      values.advisorTimeout=mode==='timeout'?45:180;
      const invocation=chat.send('Controlled cancellation probe; no model or authentication.');
      const completed=invocation.then(value=>{outcome={value};},error=>{outcome={error};});
      let deadline=Date.now()+180000;
      while(!active){assert.equal(outcome,undefined,'The real CLI must reach the provider before cancellation');
        assert(Date.now()<deadline,'The installed Core advisor worker reaches the real HTTP fixture');await delay(50);}
      const cli=chat.child;
      assert(cli?.pid&&alive(cli.pid));
      const rows=(await execute('ps',['-eo','pid,ppid,pgid,args'])).stdout.split('\n').map(line=>line.trim().split(/\s+/));
      const workers=rows.filter(row=>Number(row[1])===cli.pid&&row.slice(3).join(' ').includes('advisor_worker.jl'));
      assert.equal(workers.length,1,'Core owns exactly one live advisor process for this active request');
      worker={pid:Number(workers[0][0]),group:Number(workers[0][2])};assert(alive(worker.pid));
      if(mode==='cancel'){chat.cancel();chat.cancel();}
      else if(mode==='dispose')chat.dispose();
      else if(mode==='deactivation')await shutdownControllerProcesses();
      deadline=Date.now()+60000;
      while(outcome===undefined){assert(Date.now()<deadline,'Cancellation must finish after Core cleanup');await delay(50);}
      await completed;
      if(mode==='timeout'){
        assert.equal(coreReply?.status,'timeout','The installed Core reports its real request deadline');
        assert.equal(coreReply.message,'isolated worker stopped');
        assert.match(outcome.error?.message??'',/isolated worker stopped/);
      }else assert.match(outcome.error?.message??'',/cancelled|InterruptException/i);
      deadline=Date.now()+2000;
      while(Date.now()<deadline&&(alive(worker.pid)||!active.socketClosed))await delay(20);
      assert.equal(alive(worker.pid),false,'The advisor process is gone BEFORE harness teardown');
      assert.equal(active.socketClosed,true,'The active provider socket closed BEFORE harness teardown');
      assert.equal(active.responseClosed,true,'The held HTTP response closes with its owned client');
      assert.equal(alive(cli.pid),false,'The CLI process is gone BEFORE harness teardown');
      assert.equal(chat.state().busy,false,'Final chat state is idle only after its processes finish');
      assert.match(chat.state().status,mode==='timeout'?/isolated worker stopped/:/cancelled|InterruptException/i);
      assert(alive(foreign.pid),'A foreign process survives every owned cleanup path');
      if(mode!=='timeout')assert.equal(cli.exitCode,130,'The CLI finished cooperative cleanup instead of being killed');
      t.diagnostic(JSON.stringify({mode,cli:cli.pid,worker:worker.pid,cliExitCode:cli.exitCode,
        cliGone:!alive(cli.pid),workerGone:!alive(worker.pid),socketClosed:active.socketClosed,
        responseClosed:active.responseClosed,busy:chat.state().busy,foreignAlive:alive(foreign.pid),
        ...(mode==='timeout'?{coreStatus:coreReply.status}:{}),beforeHarnessCleanup:true}));
    }finally{
      chat.dispose();
      // Failure cleanup is restricted to the one captured worker group. The
      // assertions above run first and cannot be satisfied by this fallback.
      if(worker&&alive(worker.pid))try{process.kill(-worker.group,'SIGKILL');}catch{}
      if(chat.child&&alive(chat.child.pid))try{process.kill(-chat.child.pid,'SIGKILL');}catch{}
      for(const socket of sockets)socket.destroy();
      await new Promise(resolve=>server.close(resolve));
    }
    });}finally{foreign.kill();await foreignFinished;await rm(root,{recursive:true,force:true});}
  });

test('Cancel in the owning chat webview still stops its controller after another folder is selected',{timeout:10000},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'perfchecker-chat-folders-'));
  const require=createRequire(import.meta.url),original=Module._load;
  const uri=fsPath=>({scheme:'file',fsPath,toString:()=>`file://${fsPath}`});
  const a={name:'A',uri:uri(root)},b={name:'B',uri:uri(path.join(root,'other'))};
  const values={runnerProject:root,scenarioProject:root,juliaExecutable:'controlled-folder-cli',advisorConfig:'',
    advisorProtocol:'mcp_http',advisorEndpoint:'http://127.0.0.1:1/mcp',advisorMcpTool:'controlled_fixture',advisorMcpResponse:'text'};
  let panel,child,ready;
  const started=new Promise(resolve=>{ready=resolve;});
  const vscode={Uri:{joinPath:(base,...segments)=>uri(path.join(base.fsPath,...segments))},ViewColumn:{One:1},
    workspace:{isTrusted:true,workspaceFolders:[a,b],getConfiguration:()=>({get:(key,fallback)=>values[key]??fallback})},
    window:{createWebviewPanel:()=>{
      panel={messages:[],reveal(){},dispose(){this.closed=true;this.onDispose?.();},
        onDidDispose(callback){this.onDispose=callback;},webview:{cspSource:'controlled-fixture',asWebviewUri:source=>source.toString(),
          postMessage(message){panel.messages.push(message);return Promise.resolve(true);},
          onDidReceiveMessage(callback){panel.send=callback;return{dispose(){}};}}};
      return panel;
    }}};
  const source=require.resolve('../dist/advisorChat.js'),cached=require.cache[source];delete require.cache[source];
  Module._load=function(name,...args){
    if(name==='vscode')return vscode;
    if(name==='node:child_process')return {...require('child_process'),spawn:(executable,argv,options)=>{
      if(executable!=='controlled-folder-cli')return spawn(executable,argv,options);
      child=spawn(process.execPath,['-e','process.stdin.setEncoding("utf8");process.stdin.on("data",text=>{if(text.includes("PERFCHECKER_CANCEL/1"))setTimeout(()=>process.exit(130),30);});process.stdout.write("ready\\n");setInterval(()=>{},1000)'],options);
      child.stdout.once('data',ready);return child;
    }};
    return original.call(this,name,...args);
  };
  let AdvisorChat;
  try{({AdvisorChat}=require('../dist/advisorChat.js'));}
  finally{Module._load=original;if(cached)require.cache[source]=cached;else delete require.cache[source];}
  const roots=require('../dist/workspace-root.js');roots.selectWorkspaceFolder([a,b],a);
  const connections=require('../dist/advisorConnection.js');
  const evidenceCalls=[];
  const chat=new AdvisorChat({extensionUri:uri(root),subscriptions:[],workspaceState:{get:()=>undefined,update:async()=>undefined}},()=>{
    const selected=roots.currentWorkspaceFolder([a,b]);evidenceCalls.push(selected.name);
    return[{id:`report-${selected.name}`,label:`Measured report ${selected.name}`}];
  },async()=>undefined);
  let request;
  try{
    await writeFile(path.join(root,'Project.toml'),'name="DisposableController"\n');
    await chat.open();request=panel.send({type:'chatSend',question:'Controlled folder cancellation; no model.'});
    await Promise.race([started,request.then(()=>{throw new Error('The controller must reach its active request');})]);
    assert.equal(chat.busy,true);assert(alive(child.pid));
    roots.selectWorkspaceFolder([a,b],b);
    await panel.send({type:'chatCancel'});
    const deadline=Date.now()+1000;while(alive(child.pid)&&Date.now()<deadline)await delay(10);
    assert.equal(alive(child.pid),false,'The actual message from panel A stops A’s controller while B is selected');
    await request;
    assert.equal(child.exitCode,130);
    assert.equal(panel.messages.at(-1).workspace,'A','The old panel publishes only its owned folder');
    assert.equal(panel.messages.at(-1).busy,false);
    assert.match(panel.messages.at(-1).status,/cancelled after local worker cleanup/i);
    assert.deepEqual(panel.messages.at(-1).evidence,[{id:'report-A',label:'Measured report A'}]);
    assert(!evidenceCalls.includes('B'),'Publishing A must not call the selected-folder evidence provider for B');
    assert.equal(roots.currentWorkspaceFolder([a,b]),b,'Cancelling A must not change the selected folder B');
    const ownerPanel=panel,history=structuredClone(chat.state().messages);
    connections.setLocalAdvisorConnection(a.uri.toString(),{kind:'stdio',label:'Owned A transport',config:{},
      implementation:{tool:'',promptArgument:'prompt',workspaceArgument:'workspace'}});
    chat.connectionChanged();
    assert.equal(ownerPanel.closed,undefined,'A connection callback keeps the idle owning panel open while B is selected');
    assert.equal(panel,ownerPanel);
    assert.equal(chat.state().connection,'Owned A transport');
    connections.setLocalAdvisorConnection(a.uri.toString());
    chat.connectionChanged();
    assert.equal(ownerPanel.closed,undefined,'Completing A’s connector cleanup must not dispose A’s conversation');
    assert.equal(chat.state().workspace,'A');
    assert.equal(chat.state().connection,undefined);
    assert.deepEqual(chat.state().messages,history);
    assert.deepEqual(chat.state().evidence,[{id:'report-A',label:'Measured report A'}]);
    assert(!evidenceCalls.includes('B'),'Connector callbacks keep using A’s displayed evidence');
    assert.equal(roots.currentWorkspaceFolder([a,b]),b);
  }finally{
    connections.setLocalAdvisorConnection(a.uri.toString());
    chat.dispose();await request;
    if(child&&alive(child.pid))child.kill('SIGKILL');
    roots.selectWorkspaceFolder([a,b],a);
    await rm(root,{recursive:true,force:true});
  }
});

test('chat preserves the forced-stop warning after a real controller cannot unwind',{timeout:10000},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'perfchecker-chat-forced-'));
  const require=createRequire(import.meta.url),original=Module._load;
  const cancellation=require('../dist/controllerCancellation.js');
  const folder={name:'Disposable forced controller',uri:{scheme:'file',fsPath:root,toString:()=>`file://${root}`}};
  const values={runnerProject:root,scenarioProject:root,juliaExecutable:'controlled-forced-cli',advisorConfig:'',advisorProtocol:'mcp_http',
    advisorEndpoint:'http://127.0.0.1:1/mcp',advisorMcpTool:'controlled_fixture',advisorMcpResponse:'text'};
  const vscode={workspace:{isTrusted:true,workspaceFolders:[folder],getConfiguration:()=>({get:(key,fallback)=>values[key]??fallback})}};
  let child,ready;
  const started=new Promise(resolve=>{ready=resolve;});
  const fixtureSpawn=(_executable,_args,options)=>{
    if(_executable!=='controlled-forced-cli')return spawn(_executable,_args,options);
    child=spawn(process.execPath,['-e','process.stdin.resume();process.stdout.write("ready\\n");setInterval(()=>{},1000)'],options);
    child.stdout.once('data',ready);return child;
  };
  const source=require.resolve('../dist/advisorChat.js'),cached=require.cache[source];
  delete require.cache[source];
  Module._load=function(name,...args){
    if(name==='vscode')return vscode;
    if(name==='node:child_process')return {...require('child_process'),spawn:fixtureSpawn};
    if(name==='./controllerCancellation')return {...cancellation,
      controllerCancellation:(owned,notice)=>cancellation.controllerCancellation(owned,notice,50)};
    return original.call(this,name,...args);
  };
  let AdvisorChat;
  try{({AdvisorChat}=require('../dist/advisorChat.js'));}
  finally{Module._load=original;if(cached)require.cache[source]=cached;else delete require.cache[source];}
  const chat=new AdvisorChat({workspaceState:{get:()=>undefined,update:async()=>undefined}},()=>[],async()=>undefined);
  require('../dist/workspace-root.js').selectWorkspaceFolder([folder],folder);
  try{
    await writeFile(path.join(root,'Project.toml'),'name="DisposableController"\n');
    const request=chat.send('Controlled forced-stop process; no Julia or provider authentication.');
    const outcome=request.then(()=>undefined,error=>error);
    await Promise.race([started,outcome.then(error=>{throw error??new Error('The controlled process finished before the cancellation probe');})]);chat.cancel();
    const error=await outcome;
    assert.match(error?.message??'',/Forced stop: advisor controller cleanup did not finish/);
    assert.doesNotMatch(error.message,/after local worker cleanup/);
    assert.equal(alive(child.pid),false,'The forced controller is gone before test teardown');
    assert.equal(chat.state().busy,false);
    assert.match(chat.state().status,/Forced stop:/);
  }finally{
    chat.dispose();if(child&&alive(child.pid))child.kill('SIGKILL');
    await rm(root,{recursive:true,force:true});
  }
});

// Real Git checkpoint/copy and a live owned child; only the Core response is
// controlled. This proves cleanup ordering rather than a model convergence claim.
test('failed local implementation awaits physical cleanup before removing its isolated copy', {timeout:20000},async t=>{
  const require=createRequire(import.meta.url),connections=require('../dist/advisorConnection.js');
  for(const mode of ['deferred','reject-then-retry'])await t.test(mode,async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'perfchecker-chat-copy-owner-'));
    const folder={name:'Owned implementation copy',uri:{scheme:'file',fsPath:root,toString:()=>`file://${root}`}},key=folder.uri.toString();
    const git=async(...args)=>(await execute('git',['-c','core.hooksPath=',...args],{cwd:root})).stdout.trim();
    const vscode={workspace:{isTrusted:true,workspaceFolders:[folder],textDocuments:[],getConfiguration:()=>({get:(_key,fallback)=>fallback})}};
    const source=require.resolve('../dist/advisorChat.js'),cached=require.cache[source],original=Module._load;
    delete require.cache[source];
    Module._load=function(name,...args){
      if(name==='vscode')return vscode;
      if(name==='./advisorSetup')return {readAdvisorConfiguration:async()=>connections.localAdvisorConnection(key).config};
      return original.call(this,name,...args);
    };
    let AdvisorChat;
    try{({AdvisorChat}=require('../dist/advisorChat.js'));}
    finally{Module._load=original;if(cached)require.cache[source]=cached;else delete require.cache[source];}
    const chat=new AdvisorChat({workspaceState:{get:()=>undefined,update:async()=>undefined}},()=>[],async()=>undefined);
    require('../dist/workspace-root.js').selectWorkspaceFolder([folder],folder);
    let copy,checkpoint,release,cleanupStarted,attempts=0;
    const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{cleanupStarted=resolve;});
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const closed=new Promise(resolve=>child.once('close',resolve));
    const disconnect=async()=>{
      attempts++;cleanupStarted();
      if(attempts===1){await gate;if(mode==='reject-then-retry')throw new Error('Controlled owner inspection failure; retry is required.');}
      child.kill('SIGKILL');await closed;
      assert.equal(alive(child.pid),false,'Disconnect resolves only after the actual owner is gone');
    };
    try{
      await git('init');await git('config','user.name','PerfChecker test');await git('config','user.email','perfchecker@test.invalid');
      await writeFile(path.join(root,'source.txt'),'original\n');await git('add','source.txt');await git('commit','-m','baseline');
      const head=await git('rev-parse','HEAD'),index=await git('write-tree');
      connections.setLocalAdvisorConnection(key,{kind:'codex',label:'Controlled real process owner',
        config:{protocol:'mcp_http',timeout:180},implementation:{tool:'implement_perfchecker',promptArgument:'prompt',workspaceArgument:'workspace'}},disconnect);
      chat.folder();chat.messages=[{role:'user',content:'Review allocations.'},{role:'assistant',content:'Consider a bounded implementation.'}];
      chat.invoke=async(_folder,_config,request)=>{
        copy=request.workspace;checkpoint=chat.backupRef;
        return {schema_version:'perfchecker-narrative/1',status:'timeout',message:'isolated worker stopped',
          authority:'unverified_narrative',reference_status:'unstructured_not_verified',cards:[]};
      };
      const outcome=chat.implement(true).then(()=>undefined,error=>error);
      await started;
      assert.equal(await readFile(path.join(copy,'source.txt'),'utf8'),'original\n');
      assert(alive(child.pid));assert.equal(chat.isBusy(),true,'The failed request stays busy while owner cleanup is deferred');
      release();const error=await outcome;
      assert.match(error.message,/Global request timed out after 180 seconds.*isolated worker stopped/);
      assert.equal(await git('rev-parse',checkpoint+'^{tree}'),index,'The usable checkpoint is retained');
      if(mode==='reject-then-retry'){
        assert.match(error.message,/cleanup is incomplete/);assert(connections.localAdvisorConnection(key));
        assert.equal(await readFile(path.join(copy,'source.txt'),'utf8'),'original\n');
        assert(alive(child.pid));assert(chat.retainedImplementation,'The retry handle retains the actual checkout');
        await assert.rejects(chat.implement(true),/Retry Disconnect/);
        await assert.rejects(chat.send('No new advice during incomplete cleanup'),/Retry Disconnect/);
        await connections.disconnectLocalAdvisorConnection(key);
        assert.equal(attempts,2);assert.equal(connections.localAdvisorConnection(key),undefined);
        chat.connectionChanged(); // Same public callback invoked after the real Disconnect action.
        const deadline=Date.now()+1000;
        while(chat.retainedImplementation){assert(Date.now()<deadline,'Retry Disconnect releases its retained copy');await delay(10);}
      }
      assert.equal(alive(child.pid),false);assert.equal(chat.retainedImplementation,undefined);
      await assert.rejects(stat(copy),{code:'ENOENT'});
      assert.equal(chat.isBusy(),false);assert.equal(await git('rev-parse','HEAD'),head);assert.equal(await git('write-tree'),index);
      assert.equal(await readFile(path.join(root,'source.txt'),'utf8'),'original\n');
      t.diagnostic(JSON.stringify({mode,cleanupAttempts:attempts,copyRemovedAfterOwnerExit:true,checkpointRetained:true,sourceHeadIndexUnchanged:true}));
    }finally{
      release?.();if(alive(child.pid)){child.kill('SIGKILL');await closed;}
      connections.setLocalAdvisorConnection(key);chat.dispose();
      if(copy)await rm(path.dirname(copy),{recursive:true,force:true});await rm(root,{recursive:true,force:true});
    }
  });
});

test('Cancel advice keeps the local chat busy until its actual owned cleanup finishes',{timeout:10000},async t=>{
  for(const mode of ['deferred','reject-then-retry'])await t.test(mode,async()=>{
  const require=createRequire(import.meta.url),connections=require('../dist/advisorConnection.js');
  const root=await mkdtemp(path.join(os.tmpdir(),'perfchecker-chat-advice-owner-'));
  const folder={name:'Owned advice request',uri:{scheme:'file',fsPath:root,toString:()=>`file://${root}`}},key=folder.uri.toString();
  const vscode={workspace:{isTrusted:true,workspaceFolders:[folder],textDocuments:[],getConfiguration:()=>({get:(_key,fallback)=>fallback})}};
  const source=require.resolve('../dist/advisorChat.js'),cached=require.cache[source],original=Module._load;
  delete require.cache[source];
  Module._load=function(name,...args){
    if(name==='vscode')return vscode;
    if(name==='./advisorSetup')return {readAdvisorConfiguration:async()=>connections.localAdvisorConnection(key).config};
    return original.call(this,name,...args);
  };
  let AdvisorChat;
  try{({AdvisorChat}=require('../dist/advisorChat.js'));}
  finally{Module._load=original;if(cached)require.cache[source]=cached;else delete require.cache[source];}
  require('../dist/workspace-root.js').selectWorkspaceFolder([folder],folder);
  const chat=new AdvisorChat({workspaceState:{get:()=>undefined,update:async()=>undefined}},()=>[],async()=>undefined);
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}),closed=new Promise(resolve=>child.once('close',resolve));
  let invoked,reply,cleanupStarted,release,attempts=0;
  const started=new Promise(resolve=>{invoked=resolve;}),response=new Promise(resolve=>{reply=resolve;});
  const cleaning=new Promise(resolve=>{cleanupStarted=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  connections.setLocalAdvisorConnection(key,{kind:'codex',label:'Controlled advice process',
    config:{protocol:'mcp_http',mcp_response:'text',mcp_tool:'ask_perfchecker',timeout:180},
    implementation:{tool:'implement_perfchecker',promptArgument:'prompt',workspaceArgument:'workspace'}},async()=>{
      attempts++;cleanupStarted();if(attempts===1){await gate;if(mode==='reject-then-retry')throw new Error('Controlled advice owner cleanup failure.');}
      child.kill('SIGKILL');await closed;assert.equal(alive(child.pid),false);
    });
  chat.invoke=async()=>{invoked();return response;};
  try{
    const pending=chat.send('Controlled advice cancellation; no model.').then(()=>undefined,error=>error);
    await started;chat.cancel();reply({});await cleaning;
    assert(alive(child.pid));assert.equal(chat.isBusy(),true,'HTTP completion must not publish idle before local ownership cleanup');
    await assert.rejects(chat.send('No overlap'),/already running|cleanup is incomplete/);
    release();const error=await pending;assert.match(error.message,/cancelled/i);
    if(mode==='reject-then-retry'){
      assert.match(error.message,/cleanup is incomplete/);assert(alive(child.pid));assert(connections.localAdvisorConnection(key));
      await assert.rejects(chat.send('Refused until physical cleanup'),/Retry Disconnect/);
      await connections.disconnectLocalAdvisorConnection(key);assert.equal(attempts,2);
    }
    assert.equal(chat.isBusy(),false);assert.equal(alive(child.pid),false);assert.equal(connections.localAdvisorConnection(key),undefined);
  }finally{release?.();reply?.({});if(alive(child.pid)){child.kill('SIGKILL');await closed;}connections.setLocalAdvisorConnection(key);chat.dispose();await rm(root,{recursive:true,force:true});}
  });
});
