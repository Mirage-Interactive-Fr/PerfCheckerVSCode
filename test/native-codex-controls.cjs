// Explicit local opt-in: existing authentication is read-only, no model is called.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const net=require('node:net');
const {createHash}=require('node:crypto');
const {nativeIdentity,observeNativeIdentityGone}=require('./native-mcp-controls.cjs');
const {createCoalescingObserver,eventually,beforeDeadline}=require('./native-landscape-controls.cjs');

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const allowedPreflights=new Map([
  [JSON.stringify(['--version']),'version'],[JSON.stringify(['--help']),'global-help'],
  [JSON.stringify(['exec','--help']),'exec-help'],[JSON.stringify(['login','status']),'login-status'],
]);
const tokenNames=()=>Object.keys(process.env).filter(name=>name.startsWith('PERFCHECKER_CODEX_TOKEN_')).sort();
// Never serialize CLI output, error messages, arguments, or authentication data.
// Numeric source locations and bounded structure preserve a primary cause when
// strict cleanup adds another failure, without recording assertion values.
function codexFailureDetail(error){
  const seen=new Set();let nodes=0;
  const visit=(value,depth)=>{
    if(nodes++>=16||depth>4)return {truncated:true};
    if(!value||typeof value!=='object')return {type:typeof value};
    if(seen.has(value))return {repeated:true};seen.add(value);
    const result={name:/^[A-Za-z][A-Za-z0-9_]*$/.test(value.name)?value.name:'Error'};
    if(typeof value.code==='number'||typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code))result.code=value.code;
    if(typeof value.signal==='string'&&/^SIG[A-Z0-9]{1,16}$/.test(value.signal))result.signal=value.signal;
    if(typeof value.killed==='boolean')result.killed=value.killed;
    result.locations=String(value.stack||'').split('\n').flatMap(line=>{
      const location=line.match(/\/(native-codex-controls\.cjs|native-mcp-controls\.cjs|native-landscape-controls\.cjs):(\d+):(\d+)\)?$/);
      return location?[{file:location[1],line:Number(location[2]),column:Number(location[3])}]:[];
    }).slice(0,8);
    if(value.cause!==undefined)result.cause=visit(value.cause,depth+1);
    if(Array.isArray(value.errors)){result.errors=value.errors.slice(0,8).map(child=>visit(child,depth+1));if(value.errors.length>8)result.omittedErrors=value.errors.length-8;}
    return result;
  };
  return visit(error,0);
}
exports.codexFailureDetail=codexFailureDetail;
async function children(pid){
  const file=`/proc/${pid}/task/${pid}/children`;
  try{return (await fs.readFile(file,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);}
  catch(error){if(['ENOENT','ESRCH'].includes(error.code))return [];throw error;}
}
async function refused(port){
  return await new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port});
    socket.setTimeout(1000,()=>{socket.destroy();reject(new Error('The owned connector port did not resolve within one second'));});
    socket.once('connect',()=>{socket.destroy();resolve(false);});
    socket.once('error',error=>{socket.destroy();if(error.code==='ECONNREFUSED')resolve(true);else reject(error);});
  });
}
async function unauthenticatedStatus(endpoint){
  return await new Promise((resolve,reject)=>{
    const request=http.get(endpoint,{agent:false},response=>{
      response.resume();response.once('end',()=>resolve(response.statusCode));response.once('error',reject);
    });
    request.setTimeout(1000,()=>request.destroy(new Error('The local connector did not answer its authentication guard')));
    request.once('error',reject);
  });
}
exports.run=async context=>{
  const {vscode,workspace,session,extension,findFrame,windowPage,proof}=context;
  assert.equal(process.platform,'linux','This opt-in observes Linux process incarnations');
  assert.equal(process.env.PERFCHECKER_NATIVE_CODEX_NO_MODEL,'1');
  const externalDeadline=Date.parse(process.env.PERFCHECKER_NATIVE_CODEX_DEADLINE);
  assert(Number.isFinite(externalDeadline)&&externalDeadline>Date.now(),'The external native-case deadline must be finite and future');
  const deadline=Math.min(Date.now()+120000,externalDeadline);
  assert.equal(await fs.realpath(workspace),path.join(await fs.realpath(session),'workspace'));
  const cli=await fs.realpath(process.env.PERFCHECKER_NATIVE_CODEX_EXECUTABLE);
  assert.equal(cli,'/usr/lib/chatgpt/resources/codex','Only the explicitly reviewed installed native CLI is selected');
  const cliSha256=digest(await fs.readFile(cli));
  const folder=vscode.workspace.workspaceFolders.find(value=>value.uri.fsPath===workspace);assert(folder);
  const settings=()=>vscode.workspace.getConfiguration('perfchecker',folder.uri);
  const singleFolder=vscode.workspace.workspaceFolders.length===1;
  const target=singleFolder?vscode.ConfigurationTarget.Workspace:vscode.ConfigurationTarget.WorkspaceFolder;
  const level=singleFolder?'workspaceValue':'workspaceFolderValue';
  const previous=settings().inspect('codexExecutable')[level];
  const provider=path.join(workspace,'perf','advisor.json'),providerBefore=await fs.readFile(provider);
  const source=path.join(workspace,'source.txt'),sourceBefore=await fs.readFile(source);
  const savedSetting=settings().get('advisorConfig');assert.equal(savedSetting,'perf/advisor.json');
  const initialTokens=tokenNames(),baselineChildren=new Set(await children(process.pid));
  const records=new Map(),extinctions=new Map(),observations=[],observerErrors=[];
  const observe=entry=>{assert(observations.length<256,'The bounded no-model identity witness overflowed');observations.push(entry);};
  const inspect=async check=>{
    const live=[];check();
    for(const pid of await children(process.pid)){
      check();if(baselineChildren.has(pid))continue;
      if(records.has(pid)){
        const {kind,...identity}=records.get(pid);
        // A repeated number is not a new owner. Birth/group/image mismatches
        // remain a failure even if an earlier extinction was already proven.
        await nativeIdentity(pid,cli,observe,identity);check();continue;
      }
      // Built-in editor extensions may spawn unrelated helpers. Discovery is
      // only a filter, never ownership or an extinction certificate.
      let executable;
      try{executable=await fs.realpath(`/proc/${pid}/exe`);}
      catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw error;}
      check();if(executable!==cli)continue;
      const identity=await nativeIdentity(pid,cli,observe);check();if(!identity)continue;
      assert.equal(identity.parent,process.pid);
      let argv;
      try{argv=(await fs.readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0').filter(Boolean).slice(1);}
      catch(error){if(['ENOENT','ESRCH'].includes(error.code)&&await observeNativeIdentityGone(identity,observe,extinctions))continue;throw error;}
      const current=await nativeIdentity(pid,cli,observe,identity);
      if(!current&&!argv.length){assert(await observeNativeIdentityGone(identity,observe,extinctions));continue;}
      const kind=allowedPreflights.get(JSON.stringify(argv));
      assert(kind,'The no-model qualification permits only version/help/login-status CLI calls');
      records.set(pid,{...identity,kind});
    }
    for(const record of records.values()){
      const {kind,...identity}=record;
      check();if(!await observeNativeIdentityGone(identity,observe,extinctions))live.push(record.pid);
    }
    return live;
  };
  const observer=createCoalescingObserver(inspect,{interval:5,onError:error=>observerErrors.push(error)});
  const state=()=>vscode.commands.executeCommand('perfchecker.codexConnectionState');
  const chatState=()=>vscode.commands.executeCommand('perfchecker.chatState');
  const connection=()=>require(path.join(extension.extensionPath,'dist','advisorConnection.js')).localAdvisorConnection(folder.uri.toString());
  let port,primary,connected=false,stage='initial-connection-state';
  try{
    assert.equal((await state()).connected,false);
    stage='update-selected-executable';
    await settings().update('codexExecutable',cli,target);
    stage='verify-selected-executable';
    assert.equal(settings().get('codexExecutable'),cli);
    assert.equal(settings().inspect('codexExecutable')[level],cli);
    stage='open-chat';
    await vscode.commands.executeCommand('perfchecker.openChat');const frame=await findFrame('#chat-root');
    await frame.locator('summary').filter({hasText:'Optional Codex CLI connector'}).click();
    stage='native-connect-click';
    await frame.getByRole('button',{name:'Connect Codex CLI',exact:true}).click();
    stage='wait-connected-state';
    await eventually(async()=>{
      if(observerErrors.length)throw observerErrors[0];return (await state()).connected;
    },'The selected authenticated native CLI connects without a model request',60000,deadline);
    connected=true;
    const active=connection();assert.equal(active.kind,'codex');
    assert.match(active.label,/^codex-cli 0\.162\.0-alpha\.17\.2/);
    const endpoint=new URL(active.config.endpoint);assert.equal(endpoint.hostname,'127.0.0.1');assert.equal(endpoint.pathname,'/mcp');
    port=Number(endpoint.port);assert(Number.isSafeInteger(port)&&port>0);
    stage='verify-authentication-guard';
    assert.equal(await unauthenticatedStatus(endpoint),401,'The actual listener refuses requests without a token');
    assert.equal((await chatState()).connectionKind,'codex');
    assert.equal((await chatState()).messages.length,0,'No conversation or model request is sent');
    assert.equal(tokenNames().length,initialTokens.length+1);
    assert.equal((await observer.sample(deadline)).length,0,'All observed CLI preflights finish before Connect returns');
    assert(records.size>0,'At least one real selected CLI incarnation is physically witnessed');
    assert.deepEqual(await fs.readFile(provider),providerBefore);
    await windowPage.screenshot({path:path.join(context.output,'native-codex-connected-no-model.png')});
    proof('native-codex-authenticated-connect',{command:'perfchecker.connectCodex',nativeClick:true,selectedExecutable:cli,executableSha256:cliSha256,
      authenticated:true,labelVersion:'0.162.0-alpha.17.2',loopbackPort:port,unauthenticatedStatus:401,
      preflightKindsObserved:[...new Set([...records.values()].map(value=>value.kind))],preflightIdentities:[...records.values()],
      observedPreflightsAbsentBeforeTeardown:true,unobservedPreflightCountNotClaimed:true,savedProviderBytesPreserved:true,modelRequestsSent:0,implementationRequestsSent:0});
    stage='native-disconnect-click';
    await frame.getByRole('button',{name:'Disconnect Codex',exact:true}).click();
    stage='wait-disconnected-state';
    await eventually(async()=>!(await state()).connected,'Actual Disconnect clears the authenticated temporary connection',10000,deadline);
    connected=false;assert.equal(connection(),undefined);
    await eventually(()=>refused(port),'The actual local connector listener closes before teardown',10000,deadline);
    assert.equal((await chatState()).connectionKind,undefined);
    assert.equal((await chatState()).messages.length,0);
    assert.deepEqual(tokenNames(),initialTokens,'The temporary connector token is removed without reading its value');
    assert.equal((await observer.sample(deadline)).length,0);
    assert.equal(settings().get('advisorConfig'),savedSetting);
    assert.deepEqual(await fs.readFile(provider),providerBefore);assert.deepEqual(await fs.readFile(source),sourceBefore);
    proof('native-codex-active-disconnect',{command:'perfchecker.disconnectCodex',nativeClick:true,previouslyAuthenticated:true,
      connectionEmpty:true,loopbackPortClosedBeforeTeardown:true,observedPreflightsAbsentBeforeTeardown:true,unobservedPreflightCountNotClaimed:true,
      temporaryTokenRemoved:true,savedProviderBytesPreserved:true,sourceBytesPreserved:true,modelRequestsSent:0,implementationRequestsSent:0});
  }catch(error){primary=error;context.log('native-codex-primary-failure',{stage,error:codexFailureDetail(error)});}
  finally{
    const cleanupDeadline=Date.now()+120000;const cleanup=operation=>beforeDeadline(operation,cleanupDeadline,'Codex native-case cleanup120s deadline expired');
    const errors=[];
    try{if(connected||(await cleanup(state)).connected)await cleanup(()=>vscode.commands.executeCommand('perfchecker.disconnectCodex'));}catch(error){errors.push(error);}
    try{await observer.stop(cleanupDeadline);assert(observer.idle);assert.equal((await cleanup(()=>inspect(()=>{
      if(Date.now()>=cleanupDeadline)throw new Error('Codex cleanup deadline expired');}))).length,0);if(port)assert(await cleanup(()=>refused(port)));}catch(error){errors.push(error);}
    try{await cleanup(()=>settings().update('codexExecutable',previous,target));assert.equal(settings().inspect('codexExecutable')[level],previous);}catch(error){errors.push(error);}
    errors.push(...observerErrors);
    if(errors.length){
      const failure=new AggregateError([...(primary?[primary]:[]),...errors],'The no-model native case retained a failure or unqualified cleanup');
      context.log('native-codex-aggregate-failure',{stage,error:codexFailureDetail(failure)});
      throw failure;
    }
  }
  if(primary)throw primary;
};
