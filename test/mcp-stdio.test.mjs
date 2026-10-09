import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Module, {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {McpStdioConnector} = require('../dist/mcpStdioConnector.js');
const {localAdvisorConnection, disconnectLocalAdvisorConnection, assertSavedAdvisorConfiguration} = require('../dist/advisorConnection.js');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, timeout = 5000) {
  const deadline = Date.now() + timeout; let error;
  do {try {const result = await action(); if (result) return result;} catch (value) {error = value;} await pause(20);} while (Date.now() < deadline);
  throw error ?? new Error('Timed out waiting for a real fixture process state.');
}
async function alive(pid) {
  if (process.platform === 'linux') {
    try {const text = await readFile(`/proc/${pid}/stat`, 'utf8'); return !['Z','X'].includes(text.slice(text.lastIndexOf(')')+2).split(/\s+/)[0]);}
    catch (error) {if (error.code === 'ENOENT') return false; throw error;}
  }
  try {process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}
}
async function fixture(run, mode = '') {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-stdio-contract-'));
  const file = path.join(root, 'server.cjs');
  // An actual neutral JSON-RPC process. Its fixed reply is a transport fixture,
  // not an inference claim. No Codex executable, profile or login is involved.
  await writeFile(file, `const fs=require('node:fs'),cp=require('node:child_process'),readline=require('node:readline');
const mode=process.argv[2],root=process.cwd();let initialized=false,owned;
fs.writeFileSync('server.pid',String(process.pid));
const schemas=[{name:'consult',inputSchema:{type:'object',properties:{question:{type:'string'},flavour:{type:'string'}},required:['question','flavour'],additionalProperties:false}},
{name:'modify',inputSchema:{type:'object',properties:{request:{type:'string'},directory:{type:'string'},style:{type:'string'}},required:['request','directory','style'],additionalProperties:false}}];
// Keep stdout on its original fd: Node's Windows process.stdout pipe would
// duplicate fd 1 and retain another writer after fs.closeSync(1).
const send=(id,result)=>fs.writeSync(1,JSON.stringify({jsonrpc:'2.0',id,result:{...(initialized?{}:{resultType:'complete',...(Object.hasOwn(result,'tools')?{ttlMs:0,cacheScope:'private'}:{})}),...result}})+'\\n');
const log=m=>fs.appendFileSync('requests.jsonl',JSON.stringify(m)+'\\n');
process.stderr.write('Informational server log; stderr does not imply failure.\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);log(m);
if(m.method==='notifications/initialized'){initialized=true;return}
if(m.method==='notifications/cancelled'){fs.writeFileSync('cancel.json',JSON.stringify(m.params));return}
if(m.method==='initialize'){if(mode==='hold-init')return;initialized=true;send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'Neutral tools',version:'1'}});return}
if(!initialized&&m.params?._meta?.['io.modelcontextprotocol/protocolVersion']!=='2026-07-28')throw Error('Missing explicit modern version');
if(m.method==='server/discover'){send(m.id,{resultType:'complete',ttlMs:0,cacheScope:'private',supportedVersions:['2026-07-28'],capabilities:{tools:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'Neutral tools',version:'1'}}});return}
if(m.method==='tools/list'){
 if(mode==='slow-pages'){setTimeout(()=>send(m.id,m.params.cursor?{tools:[schemas[1]]}:{tools:[schemas[0]],nextCursor:'second'}),300);return}
 if(mode==='slow-list'&&fs.existsSync('slow-list')){fs.writeFileSync('listing-waiting','yes');setTimeout(()=>send(m.id,{tools:schemas}),1000);return}
 if(mode==='duplicate'){send(m.id,{tools:[schemas[0],schemas[0]]});return}
 if(mode==='bad-cursor'){send(m.id,{tools:[],nextCursor:'same'});return}
 send(m.id,{...(m.params._meta?{resultType:'complete',ttlMs:0,cacheScope:'private'}:{}),...(m.params.cursor?{tools:[schemas[1]]}:{tools:[schemas[0]],nextCursor:'second'})});return}
if(m.method==='tools/call'){
 if(mode==='eof'||mode==='partial-eof'){
  if(mode==='partial-eof')fs.writeSync(1,'incomplete-json');
  fs.closeSync(1);fs.writeFileSync('output-closed.json',JSON.stringify({pid:process.pid,stdoutClosed:true,aliveAfterClose:true}));
  setInterval(()=>{},1000);return}
 if(mode==='invalid'){fs.writeSync(1,'not-json\\n');return}
 if(mode==='wrong-id'){send(m.id+1,{});return}
 if(mode==='interactive'){send(m.id,{resultType:'input_required',inputRequests:{test:{method:'elicitation/create'}}});return}
 if(mode==='slow'||mode==='orphan'||mode==='detached'){
  owned=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:mode==='detached',stdio:['ignore','inherit','inherit']});
  fs.writeFileSync('owned.json',JSON.stringify({leader:process.pid,descendant:owned.pid}));
  if(mode==='orphan'||mode==='detached')setTimeout(()=>process.exit(0),1000);
  return}
 if(m.params.name==='modify')fs.writeFileSync(require('node:path').join(m.params.arguments.directory,'edited.txt'),m.params.arguments.style);
 send(m.id,{content:[{type:'text',text:'Neutral fixture response'}]});return}
throw Error('Unsupported fixture method');});
process.stdin.on('end',()=>{if(['ignore-eof','eof','partial-eof'].includes(mode))setInterval(()=>{},1000);else process.exit(0)});
`);
  const options = {command: process.execPath, args: [file, mode], cwd: root, version:'2026-07-28',timeoutMs:5000};
  const connectors = [];
  try {await run({root,options,create:(overrides={})=>{const connector=new McpStdioConnector({...options,...overrides});connectors.push(connector);return connector;}});}
  finally {
    await Promise.allSettled(connectors.map(connector=>connector.dispose()));
    // Do not signal a PID merely because a fixture once reported it. Failed
    // ownership/cleanup preserves the directory and the failure for inspection.
    const owned=await readFile(path.join(root,'owned.json'),'utf8').then(JSON.parse).catch(()=>undefined);
    for(const pid of [owned?.descendant,Number(await readFile(path.join(root,'server.pid'),'utf8').catch(()=>0))])
      if(pid&&await alive(pid))throw new Error(`Fixture cleanup unqualified; preserved ${root}`);
    await rm(root,{recursive:true,force:true});
  }
}
async function post(connector,method,params={},signal) {
  if(connector.options.version==='2026-07-28')params={...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28',
    'io.modelcontextprotocol/clientInfo':{name:'Fixture client',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}};
  const response=await fetch(connector.endpoint,{method:'POST',headers:{Authorization:`Bearer ${connector.token}`,'Content-Type':'application/json','MCP-Protocol-Version':connector.options.version},
    body:JSON.stringify({jsonrpc:'2.0',id:'http-request',method,params}),signal});
  return response.json();
}

for(const version of ['2025-11-25','2026-07-28'])test(`neutral stdio ${version}: explicit handshake, pagination, schemas, two distinct tools`,()=>fixture(async({root,create})=>{
  const connector=await create({version}).start();
  assert.equal(connector.serverName,'Neutral tools');
  assert.deepEqual(connector.tools.map(tool=>tool.name),['consult','modify']);
  assert.deepEqual(connector.tools[1].inputSchema.required,['request','directory','style']);
  const catalog=await post(connector,'tools/list');assert.equal(catalog.result.tools.length,2);
  const advice=await post(connector,'tools/call',{name:'consult',arguments:{question:'Explain saved data',flavour:'concise'}});
  assert.equal(advice.result.content[0].text,'Neutral fixture response');
  const implementation=await post(connector,'tools/call',{name:'modify',arguments:{request:'Reviewed change',directory:root,style:'exact-edit'}});
  assert.equal(implementation.result.isError,undefined);assert.equal(await readFile(path.join(root,'edited.txt'),'utf8'),'exact-edit');
  const requests=(await readFile(path.join(root,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests[0].method,version==='2026-07-28'?'server/discover':'initialize');
  assert.equal(requests.some(row=>row.method==='initialize'),version==='2025-11-25');
  const calls=requests.filter(row=>row.method==='tools/call');
  assert.deepEqual(calls.map(row=>row.params.arguments),[{question:'Explain saved data',flavour:'concise'},{request:'Reviewed change',directory:root,style:'exact-edit'}]);
  if(version==='2026-07-28')for(const row of requests.filter(row=>row.id!==undefined))assert.deepEqual(row.params._meta['io.modelcontextprotocol/clientCapabilities'],{});
  const pid=Number(await readFile(path.join(root,'server.pid'),'utf8'));await connector.dispose();
  assert.equal(await alive(pid),false,'Server is gone before test teardown');
  assert.equal(process.env[connector.keyEnvironment],undefined);await assert.rejects(fetch(connector.endpoint));
}));

for(const mode of ['slow','orphan','detached'])test(`stdio ${mode}: owned descendants stop before teardown; foreign process survives`,()=>fixture(async({root,create})=>{
  const foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const connector=await create().start();
  let result;
  const controller=new AbortController();
  const request=post(connector,'tools/call',{name:'consult',arguments:{question:'Wait',flavour:'slow'}},controller.signal).catch(error=>error);
  try {
    const owned=await until(async()=>JSON.parse(await readFile(path.join(root,'owned.json'),'utf8')));
    assert(await alive(owned.descendant));assert(await alive(foreign.pid));
    if(process.platform!=='win32')await until(()=>connector.known.has(owned.descendant));
    if(mode==='slow')controller.abort();
    result=await request;
    await until(async()=>!await alive(owned.descendant),12000);
    await connector.dispose();
    assert.equal(await alive(owned.leader),false);assert.equal(await alive(owned.descendant),false);
    assert.equal(await alive(foreign.pid),true,'Only the owned server group/Job is stopped');
    if(mode==='slow') {
      const cancellation=JSON.parse(await readFile(path.join(root,'cancel.json'),'utf8'));
      const calls=(await readFile(path.join(root,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(row=>row.method==='tools/call');
      assert.equal(cancellation.requestId,calls[0].id,'Cancellation references the actual stdio request ID');
    }
  }finally{foreign.kill('SIGKILL');await new Promise(resolve=>foreign.once('close',resolve));await request;}
},mode));

for(const mode of ['duplicate','bad-cursor','invalid','wrong-id','interactive'])test(`stdio ${mode} fails explicitly without an orphan server`,()=>fixture(async({root,create})=>{
  const connector=create();
  if(['duplicate','bad-cursor'].includes(mode))await assert.rejects(connector.start());
  else {await connector.start();const response=await post(connector,'tools/call',{name:'consult',arguments:{question:'test',flavour:'x'}});assert(response.error);await connector.dispose();}
  const pid=Number(await readFile(path.join(root,'server.pid'),'utf8'));assert.equal(await alive(pid),false);
},mode));

for(const mode of ['eof','partial-eof'])test(`stdio ${mode}: output EOF retires a still-live server without waiting for the tool timeout`,()=>fixture(async({root,create})=>{
  const connector=await create().start(),pid=Number(await readFile(path.join(root,'server.pid'),'utf8'));
  assert(await alive(pid));
  // Observe EOF while the real server is alive before allowing the product's
  // automatic cleanup to start. Otherwise its two-second kill can race this
  // observation on a busy host and turn a genuine EOF into an exit-only proof.
  let releaseCleanup;
  const readyForCleanup=new Promise(resolve=>{releaseCleanup=resolve;}),stop=connector.stop.bind(connector);
  connector.stop=async()=>{await readyForCleanup;await stop();};
  const evidenceDeadline=Date.now()+5000;
  const response=post(connector,'tools/call',{name:'consult',arguments:{question:'Close output',flavour:'fixture'}}).catch(error=>error);
  try {
    await until(()=>connector.failure,Math.max(1,evidenceDeadline-Date.now()));
    assert.match(connector.failure.message,mode==='partial-eof'?/incomplete protocol message/:/output stream closed/);
    const closed=await until(async()=>JSON.parse(await readFile(path.join(root,'output-closed.json'),'utf8')),Math.max(1,evidenceDeadline-Date.now()));
    assert.deepEqual(closed,{pid,stdoutClosed:true,aliveAfterClose:true});
    assert(await alive(pid),'The server remains alive after verified output closure and before owned cleanup');
    assert(connector.closing instanceof Promise,'EOF schedules automatic owned cleanup before the test releases it');
  }finally{releaseCleanup();await connector.dispose();await response;}
  assert.equal(await alive(pid),false,'EOF cleans the still-live process before harness teardown');
},mode));

test('real owned server retries cleanup after a transient identity observation failure',{skip:process.platform==='win32'?'Unix process observer; Windows Job retry has a separate real-process contract':false},()=>fixture(async({root,create})=>{
  const connector=await create().start(),pid=Number(await readFile(path.join(root,'server.pid'),'utf8'));
  const foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  clearInterval(connector.observer);await connector.observation;
  const observe=connector.observe.bind(connector);let first=true;
  connector.observe=async(...args)=>{if(first){first=false;throw new Error('Transient fixture observation failure');}return observe(...args);};
  try {
    await assert.rejects(connector.dispose(),/Transient fixture observation failure/);
    assert.equal(connector.closing,undefined,'Rejected cleanup promise does not poison an explicit retry');
    assert(await alive(pid));assert(await alive(foreign.pid));
    await connector.dispose();assert.equal(await alive(pid),false);assert(await alive(foreign.pid));
  }finally{foreign.kill('SIGKILL');await new Promise(resolve=>foreign.once('close',resolve));}
},'ignore-eof'));

test('Windows owned Job retries a failed owner stop while childClosed is false',{skip:process.platform!=='win32'},()=>fixture(async({root,create})=>{
  const connector=await create().start(),pid=Number(await readFile(path.join(root,'server.pid'),'utf8'));
  const owner=connector.child,kill=owner.kill.bind(owner),foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  let first=true;
  owner.kill=(...args)=>{if(first){first=false;throw new Error('Transient fixture owner stop failure');}return kill(...args);};
  try {
    await assert.rejects(connector.dispose(),/Transient fixture owner stop failure/);
    assert.equal(connector.closing,undefined,'Failed Job cleanup remains explicitly retryable');
    assert.equal(connector.childClosed,false);assert(await alive(owner.pid));assert(await alive(pid));assert(await alive(foreign.pid));
    await connector.dispose();
    assert.equal(connector.childClosed,true);assert.equal(await alive(owner.pid),false);assert.equal(await alive(pid),false);
    assert(await alive(foreign.pid),'Retry stops only the private Job, before test teardown');
  }finally{owner.kill=kill;foreign.kill('SIGKILL');await new Promise(resolve=>foreign.once('close',resolve));}
},'ignore-eof'));

test('one bounded discovery deadline includes all actual tool pages',()=>fixture(async({root,create})=>{
  const connector=create({timeoutMs:450});
  await assert.rejects(connector.start(),/tool discovery timed out/);
  const pid=Number(await readFile(path.join(root,'server.pid'),'utf8'));
  assert.equal(await alive(pid),false,'Discovery deadline stops the owned server before teardown');
},'slow-pages'));

test('legacy initialize timeout never emits a forbidden initialize cancellation notification',()=>fixture(async({root,create})=>{
  const connector=create({version:'2025-11-25',timeoutMs:250});
  await assert.rejects(connector.start(),/timed out/);
  const requests=(await readFile(path.join(root,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests[0].method,'initialize');assert.equal(requests.some(row=>row.method==='notifications/cancelled'),false);
  assert.equal(await alive(Number(await readFile(path.join(root,'server.pid'),'utf8'))),false);
},'hold-init'));

test('no shell, no relative executable/directory, no automatic revision fallback',async()=>{
  for(const options of [{command:'node',args:[],cwd:tmpdir(),version:'2026-07-28'},
    {command:process.execPath,args:'--version',cwd:tmpdir(),version:'2026-07-28'},
    {command:process.execPath,args:[],cwd:'.',version:'2026-07-28'},
    {command:process.execPath,args:[],cwd:tmpdir(),version:'automatic'}])await assert.rejects(new McpStdioConnector(options).start());
  for(const api_key_env of ['PERFCHECKER_MCP_TOKEN_TEST','PERFCHECKER_CODEX_TOKEN_TEST'])assert.throws(()=>assertSavedAdvisorConfiguration({api_key_env}),/temporary/);
});

test('Cancel while native executable validation is pending starts no process or endpoint',()=>fixture(async({root,create})=>{
  const filesystem=require('node:fs/promises'),nativeRealpath=filesystem.realpath;
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;}),resume=new Promise(resolve=>{release=resolve;});
  filesystem.realpath=async value=>{if(value===process.execPath){entered();await resume;}return nativeRealpath(value);};
  const connector=create();
  try {
    const pending=connector.start();await waiting;await connector.dispose();release();
    await assert.rejects(pending,/cancelled before launch/);
    assert.equal(connector.child,undefined);assert.equal(connector.endpoint,'');
    assert.equal(process.env[connector.keyEnvironment],undefined);
    await assert.rejects(readFile(path.join(root,'server.pid')),error=>error.code==='ENOENT');
  }finally{release();filesystem.realpath=nativeRealpath;}
}));

test('shared connection registry: failed tool selection and workspace/trust changes retire the real server',()=>fixture(async({root,options})=>{
  const callbacks=new Map(),subscriptions=[];
  const folder={name:'Private fixture',uri:{scheme:'file',fsPath:root,toString:()=>`file://${root}`}};
  const workspace={isTrusted:true,workspaceFolders:[folder],onDidChangeWorkspaceFolders:()=>({dispose(){}})};
  let panel;
  const savedProvider=JSON.stringify({protocol:'mcp_http',endpoint:'http://127.0.0.1:1/saved-provider',mcp_tool:'previous_tool'})+'\n';
  await writeFile(path.join(root,'provider.json'),savedProvider);
  workspace.getConfiguration=()=>({get:(name,fallback)=>name==='codexExecutable'?path.join(root,'absent-codex-fixture'):name==='advisorConfig'?'provider.json':fallback,
    update(){throw new Error('A temporary connector must not write settings.');}});
  const vscode={workspace,Uri:{joinPath:(uri,...parts)=>({fsPath:path.join(uri.fsPath,...parts)})},ViewColumn:{One:1},
    commands:{registerCommand:(name,callback)=>{callbacks.set(name,callback);return{dispose(){}};},executeCommand:(name,...args)=>callbacks.get(name)(...args)},window:{showErrorMessage(){},showInformationMessage(){},
      createWebviewPanel:()=>{let disposed;panel={disposed:false,webview:{asWebviewUri:uri=>uri.fsPath,cspSource:'fixture',onDidReceiveMessage(){},async postMessage(){}},
        onDidDispose:callback=>{disposed=callback;},dispose(){this.disposed=true;disposed?.();}};return panel;}}};
  const original=Module._load;
  Module._load=function(name,...args){if(name==='vscode')return vscode;return original.call(this,name,...args);};
  let register,registerCodex,AdvisorSetup,AdvisorChat;
  try {({registerMcpStdioConnections:register}=require('../dist/mcpStdioIntegration.js'));
    ({registerCodexConnections:registerCodex}=require('../dist/codexIntegration.js'));
    ({AdvisorSetup}=require('../dist/advisorSetup.js'));
    ({AdvisorChat}=require('../dist/advisorChat.js'));
  }finally{Module._load=original;}
  const state=new Map();
  const context={subscriptions,extensionUri:folder.uri,workspaceState:{get:key=>state.get(key),update:async(key,value)=>{state.set(key,value);}}};
  register(context,()=>false,()=>{});registerCodex(context,()=>false,()=>{});
  const setup=new AdvisorSetup(context);
  const {selectWorkspaceFolder}=require('../dist/workspace-root.js');selectWorkspaceFolder(workspace.workspaceFolders,folder);
  const input={protocol:'mcp_stdio',stdio_command:options.command,stdio_args:options.args,stdio_cwd:root,mcp_version:options.version,timeout:5,
    mcp_tool:'consult',mcp_prompt_argument:'question',mcp_arguments:{flavour:'read-only'},
    implementation:{tool:'modify',promptArgument:'request',workspaceArgument:'directory',arguments:{style:'separate'}}};
  try {
    await callbacks.get('perfchecker.discoverMcpStdio')(input);
    const first=Number(await readFile(path.join(root,'server.pid'),'utf8'));
    await setup.open();const oldHttpPanel=panel;
    await setup.open({stdio:true});assert.equal(oldHttpPanel.disposed,true);
    assert.match(panel.webview.html,/"protocol":"mcp_stdio"/,'Connect stdio replaces an already open HTTP form');
    const connectionPanel=panel;
    await setup.action({action:'save',config:input});
    assert.equal(connectionPanel.disposed,true,'Publishing the connection retires its stale form');
    assert(await alive(first),'Connection-induced panel closure must not cancel the newly connected server');
    assert.equal(Number(await readFile(path.join(root,'server.pid'),'utf8')),first,'Probe then Connect retains one server');
    const connection=localAdvisorConnection(folder.uri.toString());assert.equal(connection.kind,'stdio');
    assert.equal((await callbacks.get('perfchecker.codexConnectionState')()).connected,false);
    assert.deepEqual(connection.config.mcp_arguments,{flavour:'read-only'});assert.deepEqual(connection.implementation.arguments,{style:'separate'});
    await callbacks.get('perfchecker.discoverMcpStdio')(input);assert(await alive(first),'Probe does not close an active connection');
    await setup.open({stdio:true});
    input.stdio_args=[...options.args,'replacement'];
    await setup.action({action:'save',config:input});
    const replacementServer=Number(await readFile(path.join(root,'server.pid'),'utf8'));
    assert.notEqual(replacementServer,first);assert.equal(await alive(first),false);
    assert(await alive(replacementServer),'Retiring the older connection form does not cancel the explicit replacement');
    const chat=new AdvisorChat(context,()=>[],async()=>{});
    let entered,release;const preparing=new Promise(resolve=>{entered=resolve;}),resume=new Promise(resolve=>{release=resolve;});
    chat.invoke=async()=>{entered();await resume;throw new Error('Controlled preparation cancelled before Julia or HTTP launch');};
    const sending=chat.send('Controlled pre-HTTP cancellation; no inference or measurement.').catch(error=>error);
    await Promise.race([preparing,sending.then(error=>{throw error;})]);
    const other={name:'Other folder',uri:{scheme:'file',fsPath:path.join(root,'other'),toString:()=>`file://${root}/other`}};
    workspace.workspaceFolders=[folder,other];selectWorkspaceFolder(workspace.workspaceFolders,other);
    chat.cancel();await until(async()=>!await alive(replacementServer)&&!localAdvisorConnection(folder.uri.toString()));release();
    assert.match((await sending).message,/before Julia or HTTP/);
    assert.equal(localAdvisorConnection(folder.uri.toString()),undefined);
    assert.equal(await readFile(path.join(root,'provider.json'),'utf8'),savedProvider);
    assert.equal((await readFile(path.join(root,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).some(row=>row.method==='tools/call'),false);
    chat.dispose();workspace.workspaceFolders=[folder];selectWorkspaceFolder(workspace.workspaceFolders,folder);
    await disconnectLocalAdvisorConnection(folder.uri.toString());assert.equal(await alive(first),false);
    assert.equal(await alive(replacementServer),false);
    await assert.rejects(callbacks.get('perfchecker.connectMcpStdio')({...input,mcp_tool:'missing'}),/available/);
    const failed=Number(await readFile(path.join(root,'server.pid'),'utf8'));assert.equal(await alive(failed),false,'Failed selection leaves no discovery process');
    await callbacks.get('perfchecker.connectMcpStdio')(input);
    const idleServer=Number(await readFile(path.join(root,'server.pid'),'utf8'));
    const idleChat=new AdvisorChat(context,()=>[],async()=>{});idleChat.recoverProposal=async()=>{};
    await idleChat.open();panel.dispose();
    await until(async()=>!await alive(idleServer)&&!localAdvisorConnection(folder.uri.toString()));idleChat.dispose();
    assert.equal(localAdvisorConnection(folder.uri.toString()),undefined,'Closing idle Chat retires its connected stdio server before any HTTP call');
    assert.equal(await readFile(path.join(root,'provider.json'),'utf8'),savedProvider);
    input.stdio_args=[options.args[0],'slow-list'];
    await callbacks.get('perfchecker.discoverMcpStdio')(input);
    await writeFile(path.join(root,'slow-list'),'yes');
    const pending=callbacks.get('perfchecker.connectMcpStdio')(input);
    await until(()=>readFile(path.join(root,'listing-waiting'),'utf8'));
    await assert.rejects(callbacks.get('perfchecker.connectCodex')(),/local connector operation/);
    assert(await alive(Number(await readFile(path.join(root,'server.pid'),'utf8'))),'Concurrent Codex cannot replace or stop the discovering stdio server');
    workspace.isTrusted=false;
    await assert.rejects(pending,/trust/);
    const changed=Number(await readFile(path.join(root,'server.pid'),'utf8'));assert.equal(await alive(changed),false);
    assert.equal(localAdvisorConnection(folder.uri.toString()),undefined);
    workspace.isTrusted=true;
    await rm(path.join(root,'slow-list'));await rm(path.join(root,'listing-waiting'));
    await callbacks.get('perfchecker.discoverMcpStdio')(input);
    await writeFile(path.join(root,'slow-list'),'yes');
    const switching=callbacks.get('perfchecker.connectMcpStdio')(input);
    await until(()=>readFile(path.join(root,'listing-waiting'),'utf8'));
    const replacement={name:'Other folder',uri:{scheme:'file',fsPath:path.join(root,'other'),toString:()=>`file://${root}/other`}};
    workspace.workspaceFolders=[replacement];selectWorkspaceFolder(workspace.workspaceFolders,replacement);
    await assert.rejects(switching,/Workspace or trust changed/);
    const removed=Number(await readFile(path.join(root,'server.pid'),'utf8'));assert.equal(await alive(removed),false);
    assert.equal(localAdvisorConnection(folder.uri.toString()),undefined);
  }finally{workspace.isTrusted=true;workspace.workspaceFolders=[folder];selectWorkspaceFolder(workspace.workspaceFolders,folder);await callbacks.get('perfchecker.disconnectMcpStdio')();setup.dispose();for(const item of subscriptions)item.dispose();}
}));
