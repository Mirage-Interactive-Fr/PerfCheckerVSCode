import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {mkdtemp, writeFile, readFile, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url), original=Module._load;
const saved={advisorConfig:'advisor.json',advisorImplementationMcpTool:'previous_agent'};
const settings={get:(key,fallback)=>saved[key]??fallback,update:()=>{throw new Error('A temporary connection must not update saved settings.');}};
let panel, delayTemporary;
const nativeFs=require('node:fs'), nativeChildProcess=require('node:child_process');
let spawned=0;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const vscode={workspace:{getConfiguration:()=>settings,isTrusted:true},ViewColumn:{One:1},ConfigurationTarget:{WorkspaceFolder:1},ProgressLocation:{Notification:1},
  Uri:{joinPath:(uri,...parts)=>({fsPath:path.join(uri.fsPath,...parts)})},window:{
    withProgress:(_options,run)=>run({}, {onCancellationRequested:()=>({dispose(){}})}),
    createWebviewPanel:()=>{let disposed;panel={disposed:false,webview:{asWebviewUri:uri=>uri.fsPath,cspSource:'fixture',onDidReceiveMessage:()=>{},postMessage:async()=>{}},
      onDidDispose:run=>{disposed=run;},dispose:()=>{panel.disposed=true;disposed?.();}};return panel;}
  }};
Module._load=function(name,...args){
  if(name==='vscode')return vscode;
  if(name==='node:fs')return {...nativeFs,promises:{...nativeFs.promises,mkdtemp:async prefix=>{
    if(delayTemporary){const current=delayTemporary;current.started.resolve();await current.release.promise;}
    return nativeFs.promises.mkdtemp(prefix);
  }}};
  if(name==='node:child_process')return {...nativeChildProcess,spawn:(...args)=>{spawned++;return nativeChildProcess.spawn(...args);}};
  return original.call(this,name,...args);
};
let readAdvisorConfiguration,AdvisorSetup,AdvisorChat;
try{({readAdvisorConfiguration,AdvisorSetup}=require('../dist/advisorSetup.js'));({AdvisorChat}=require('../dist/advisorChat.js'));}finally{Module._load=original;}
const {setLocalAdvisorConnection,localAdvisorConnection}=require('../dist/advisorConnection.js');

test('explicit local connection overrides a saved file in memory and restores it byte for byte',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-connection-')), key=`file://${root}`;
  const folder={name:'fixture',uri:{fsPath:root,toString:()=>key}};
  vscode.workspace.workspaceFolders=[folder];
  const bytes=JSON.stringify({protocol:'mcp_http',endpoint:'https://previous.example.test/mcp',mcp_tool:'previous_advice'})+'\n';
  await writeFile(path.join(root,'advisor.json'),bytes);
  try{
    assert.equal((await readAdvisorConfiguration(folder)).mcp_tool,'previous_advice');
    setLocalAdvisorConnection(key,{label:'local Codex',config:{protocol:'mcp_http',endpoint:'http://127.0.0.1:1/mcp',mcp_tool:'ask_perfchecker'},
      implementation:{tool:'implement_perfchecker',promptArgument:'prompt',workspaceArgument:'workspace'}});
    const config=await readAdvisorConfiguration(folder);assert.equal(config.mcp_tool,'ask_perfchecker');
    config.mcp_tool='tampered';assert.equal(localAdvisorConnection(key).config.mcp_tool,'ask_perfchecker');
    const setup=new AdvisorSetup({});setup.folder=()=>folder;
    try {await assert.rejects(setup.action({action:'save',config}),/must not be saved/);} finally {setup.dispose();}
    const chat=new AdvisorChat({},()=>[],async()=>{});chat.folder=()=>folder;
    assert.equal(chat.state().implementation.tool,'implement_perfchecker');
    await assert.rejects(chat.saveImplementationSettings({tool:'other'}),/Disconnect/);
    assert.equal(await readFile(path.join(root,'advisor.json'),'utf8'),bytes);
    setLocalAdvisorConnection(key);
    assert.equal((await readAdvisorConfiguration(folder)).mcp_tool,'previous_advice');
    assert.equal(chat.state().implementation.tool,'previous_agent');
    assert.equal(await readFile(path.join(root,'advisor.json'),'utf8'),bytes);
  }finally{setLocalAdvisorConnection(key);await rm(root,{recursive:true,force:true});}
});

test('disconnect closes a temporary configuration form and stale Save preserves the previous provider',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-advisor-stale-')),key=`file://${root}`;
  const folder={uri:{fsPath:root,toString:()=>key}},context={extensionUri:folder.uri,subscriptions:[]};
  const bytes=JSON.stringify({protocol:'mcp_http',endpoint:'https://previous.example.test/mcp',mcp_tool:'previous_advice'})+'\n';
  await writeFile(path.join(root,'advisor.json'),bytes);
  vscode.workspace.workspaceFolders=[folder];
  const setup=new AdvisorSetup(context);
  try {
    setLocalAdvisorConnection(key,{label:'local Codex',config:{protocol:'mcp_http',endpoint:'http://127.0.0.1:12345/mcp',api_key_env:'PERFCHECKER_CODEX_TOKEN_RETIRED',mcp_tool:'ask_perfchecker'},
      implementation:{tool:'implement_perfchecker',promptArgument:'prompt',workspaceArgument:'workspace'}});
    await setup.open();const opened=panel,stale=await readAdvisorConfiguration(folder);
    assert.equal(opened.disposed,false);
    setLocalAdvisorConnection(key);assert.equal(opened.disposed,true);
    setup.invoke=()=>{throw new Error('A retired endpoint must be rejected before a worker starts.');};
    await assert.rejects(setup.action({action:'save',config:stale}),/temporary local connector endpoint must not be saved/);
    assert.equal(await readFile(path.join(root,'advisor.json'),'utf8'),bytes);
    assert.equal((await readAdvisorConfiguration(folder)).mcp_tool,'previous_advice');
  } finally {setLocalAdvisorConnection(key);setup.dispose();await rm(root,{recursive:true,force:true});}
});

test('Save pending validation never writes the selected replacement workspace or its settings',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-advisor-workspaces-'));
  const folders=['a','b'].map(name=>({uri:{fsPath:path.join(root,name),toString:()=>`file://${root}/${name}`}}));
  const bytes=['provider A\n','provider B\n'],updates=[];
  for(let i=0;i<folders.length;i++){await nativeFs.promises.mkdir(path.join(folders[i].uri.fsPath,'perf'),{recursive:true});await writeFile(path.join(folders[i].uri.fsPath,'perf','Project.toml'),'[deps]\n');await writeFile(path.join(folders[i].uri.fsPath,'advisor.json'),bytes[i]);}
  let selected=folders[0];const validated=deferred(),started=deferred();
  const setup=new AdvisorSetup({});setup.folder=()=>selected;
  const originalConfiguration=vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration=(_section,uri)=>({get:(key,fallback)=>saved[key]??fallback,update:(key,value)=>updates.push({uri:uri.toString(),key,value})});
  setup.invoke=async(_input,cwd,project,julia)=>{assert.equal(cwd,folders[0].uri.fsPath);assert.equal(project,path.join(cwd,'perf'));assert.equal(julia,'julia');started.resolve();return validated.promise;};
  try {
    const pending=setup.action({action:'save',config:{protocol:'mcp_http',endpoint:'https://new.example.test/mcp'}});
    await started.promise;selected=folders[1];validated.resolve({status:'complete',config:{protocol:'mcp_http',endpoint:'https://new.example.test/mcp'}});
    await assert.rejects(pending,/folder or trust changed/);
    for(let i=0;i<folders.length;i++)assert.equal(await readFile(path.join(folders[i].uri.fsPath,'advisor.json'),'utf8'),bytes[i]);
    assert.deepEqual(updates,[]);
  } finally {validated.resolve({status:'cancelled'});vscode.workspace.getConfiguration=originalConfiguration;setup.dispose();await rm(root,{recursive:true,force:true});}
});

test('Cancel during temporary setup preparation starts no worker, saves nothing and removes its temporary directory',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-advisor-cancel-')),key=`file://${root}`;
  const folder={uri:{fsPath:root,toString:()=>key}},bytes='original provider\n';
  await writeFile(path.join(root,'advisor.json'),bytes);
  await nativeFs.promises.mkdir(path.join(root,'perf'));await writeFile(path.join(root,'perf','Project.toml'),'[deps]\n');
  const setup=new AdvisorSetup({});setup.folder=()=>folder;
  const before=new Set((await readdir(tmpdir())).filter(name=>name.startsWith('perfchecker-setup-'))),spawnedBefore=spawned;
  delayTemporary={started:deferred(),release:deferred()};
  try {
    const pending=setup.action({action:'save',config:{protocol:'mcp_http',endpoint:'https://new.example.test/mcp'}});
    await delayTemporary.started.promise;setup.cancel();delayTemporary.release.resolve();
    assert.equal((await pending).status,'cancelled');assert.equal(spawned,spawnedBefore);
    assert.equal(await readFile(path.join(root,'advisor.json'),'utf8'),bytes);
    assert.deepEqual(new Set((await readdir(tmpdir())).filter(name=>name.startsWith('perfchecker-setup-'))),before);
  } finally {delayTemporary?.release.resolve();delayTemporary=undefined;setup.dispose();await rm(root,{recursive:true,force:true});}
});

test('ordinary validated Save still persists the chosen provider and only its captured folder settings',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-advisor-save-')),key=`file://${root}`;
  const folder={uri:{fsPath:root,toString:()=>key}},updates=[],config={protocol:'mcp_http',endpoint:'https://chosen.example.test/mcp',mcp_tool:'chosen_agent',custom_provider:'preserved'};
  await nativeFs.promises.mkdir(path.join(root,'perf'));await writeFile(path.join(root,'perf','Project.toml'),'[deps]\n');
  const setup=new AdvisorSetup({});setup.folder=()=>folder;
  const originalConfiguration=vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration=(_section,uri)=>({get:(name,fallback)=>saved[name]??fallback,update:(name,value)=>updates.push({workspace:uri.toString(),name,value})});
  setup.invoke=async(input,cwd,project,julia)=>{assert.equal(input.action,'validate');assert.equal(cwd,root);assert.equal(project,path.join(root,'perf'));assert.equal(julia,'julia');return {status:'complete',config};};
  try {
    assert.equal((await setup.action({action:'save',config})).status,'complete');
    assert.deepEqual(JSON.parse(await readFile(path.join(root,'advisor.json'),'utf8')),config);
    assert.ok(updates.every(update=>update.workspace===key));
    assert.ok(updates.some(update=>update.name==='advisorConfig'&&update.value==='advisor.json'));
    assert.ok(updates.some(update=>update.name==='advisorEnabled'&&update.value===true));
  } finally {vscode.workspace.getConfiguration=originalConfiguration;setup.dispose();await rm(root,{recursive:true,force:true});}
});

test('manual implementation arguments preserve unset providers, replace explicitly and reject reserved collisions before edits',()=>{
  const {implementationMcpArguments,assertSavedAdvisorConfiguration}=require('../dist/advisorConnection.js');
  const previous={model_options:{temperature:0},flavour:'advice'};
  const inherited=implementationMcpArguments(previous,undefined,'request','directory');
  assert.deepEqual(inherited,previous);inherited.model_options.temperature=1;assert.equal(previous.model_options.temperature,0);
  assert.deepEqual(implementationMcpArguments(previous,{},'request','directory'),{});
  assert.deepEqual(implementationMcpArguments(previous,{style:'patch'},'request','directory'),{style:'patch'});
  for(const value of [{request:'unexpected'}, {directory:'/foreign'}, [], null, {large:'x'.repeat(12001)}])
    assert.throws(()=>implementationMcpArguments(previous,value,'request','directory'),/Implementation arguments/);
  assert.throws(()=>implementationMcpArguments({directory:'/foreign'},undefined,'request','directory'),/Implementation arguments/);
  for(const api_key_env of ['PERFCHECKER_MCP_TOKEN_RETIRED','PERFCHECKER_CODEX_TOKEN_RETIRED'])
    assert.throws(()=>assertSavedAdvisorConfiguration({api_key_env}),/temporary local connector/);
});

test('failed Disconnect retains the exact owner and cleanup handle for an explicit retry',async()=>{
  const {disconnectLocalAdvisorConnection}=require('../dist/advisorConnection.js');
  const key='file:///retry-private-fixture';let attempts=0;
  setLocalAdvisorConnection(key,{kind:'stdio',label:'Neutral fixture',config:{endpoint:'http://127.0.0.1:1/mcp'},
    implementation:{tool:'modify',promptArgument:'request',workspaceArgument:'directory'}},async()=>{
    if(++attempts===1)throw new Error('Observed cleanup failure');
  });
  await assert.rejects(disconnectLocalAdvisorConnection(key),/Observed cleanup failure/);
  assert.equal(localAdvisorConnection(key).label,'Neutral fixture');
  await disconnectLocalAdvisorConnection(key);
  assert.equal(attempts,2);assert.equal(localAdvisorConnection(key),undefined);
});
