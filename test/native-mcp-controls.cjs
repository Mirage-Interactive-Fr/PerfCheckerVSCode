// Real HTTP MCP transport and Julia workers, driven through the installed webview.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {execFile,spawn} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const {clickStudioAction}=require('./native-studio-controls.cjs');
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hold = async()=>{if(process.env.PERFCHECKER_NATIVE_VIDEO==='1')await delay(3000);};
async function eventually(read, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {if (await read()) return; await delay(100);}
  throw new Error(label);
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// The executable entry below is the neutral server used by the installed UI.
// Only tools/call delegates to this test's controlled backend; no agent is used.
async function neutralStdioServer(){
  const [backend,root,version]=process.argv.slice(3);
  assert(['2025-11-25','2026-07-28'].includes(version));
  assert.equal(await fs.realpath(process.cwd()),await fs.realpath(root));
  const ledger=record=>require('node:fs').appendFileSync(path.join(root,'stdio-requests.jsonl'),JSON.stringify({...record,observedAt:new Date().toISOString()})+'\n');
  await fs.writeFile(path.join(root,'server.pid'),String(process.pid));
  const tools=[{name:'consult_native',description:'Neutral advice transport fixture; no model inference',inputSchema:{type:'object',properties:{question:{type:'string'},native_contract:{type:'object'}},required:['question','native_contract']}},
    {name:'modify_native',description:'Explicitly edits only the supplied disposable checkout',inputSchema:{type:'object',properties:{change_request:{type:'string'},checkout_path:{type:'string'},native_contract:{type:'object'}},required:['change_request','checkout_path','native_contract']}}];
  const pending=new Map();let initialized=false;
  const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result:{...(version==='2026-07-28'?{resultType:'complete',ttlMs:0,cacheScope:'private'}:{}),...result}})+'\n');
  process.stderr.write('Neutral stdio fixture: informational stderr is not a transport failure.\n');
  require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
    let message;
    try{
      message=JSON.parse(line);
      ledger({method:message.method,requestId:message.id??null,cancelledRequestId:message.params?.requestId??null,
        tool:message.params?.name??null,argumentNames:Object.keys(message.params?.arguments??{}),version});
      if(message.method==='notifications/cancelled'){pending.get(message.params.requestId)?.abort();return;}
      if(message.method==='notifications/initialized'){assert.equal(version,'2025-11-25');initialized=true;return;}
      if(message.method==='initialize'){
        assert.equal(version,'2025-11-25');assert.equal(message.params.protocolVersion,version);
        send(message.id,{protocolVersion:version,capabilities:{tools:{}},serverInfo:{name:'Neutral native stdio tools',version:'1'}});return;
      }
      if(version==='2026-07-28'){
        assert.equal(message.params?._meta?.['io.modelcontextprotocol/protocolVersion'],version);
        assert(message.params._meta['io.modelcontextprotocol/clientInfo']);assert(message.params._meta['io.modelcontextprotocol/clientCapabilities']);
      }else assert(initialized,'Legacy requests follow the initialized notification');
      if(message.method==='server/discover'){
        assert.equal(version,'2026-07-28');send(message.id,{supportedVersions:[version],capabilities:{tools:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'Neutral native stdio tools',version:'1'}}});return;
      }
      if(message.method==='tools/list'){
        assert(!message.params.cursor||message.params.cursor==='second-page');
        send(message.id,message.params.cursor?{tools:[tools[1]]}:{tools:[tools[0]],nextCursor:'second-page'});return;
      }
      assert.equal(message.method,'tools/call');assert(tools.some(tool=>tool.name===message.params.name));
      const controller=new AbortController();pending.set(message.id,controller);
      const prompt=message.params.arguments[message.params.name==='modify_native'?'change_request':'question'];
      if(prompt.includes('native cancellation probe')){
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform!=='win32',stdio:'ignore'});
        await fs.writeFile(path.join(root,'descendant.pid'),String(child.pid));
      }
      try{
        const response=await fetch(backend,{method:'POST',headers:{'Content-Type':'application/json','MCP-Protocol-Version':version},
          body:JSON.stringify(message),signal:controller.signal});
        assert(response.ok);const value=await response.json();assert(value.result);
        send(message.id,value.result);
      }catch(error){if(controller.signal.aborted)return;throw error;}finally{pending.delete(message.id);}
    }catch(error){ledger({method:'fixture/contract-error',errorClass:error.name});process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message?.id??null,error:{code:-32603,message:'Neutral fixture contract failed'}})+'\n');}
  });
  process.stdin.on('end',()=>{ledger({method:'stdin/eof',version});for(const controller of pending.values())controller.abort();process.exit(0);});
}
async function linuxNativeStat(pid){
  let value;try{value=await fs.readFile(`/proc/${pid}/stat`,'utf8');}
  catch(error){if(['ENOENT','ESRCH'].includes(error.code))return undefined;throw error;}
  const end=value.lastIndexOf(')'),fields=value.slice(end+2).trim().split(/\s+/);
  assert(end>0&&Number(value.slice(0,value.indexOf(' ')))===pid&&fields.length>19&&/^[A-Za-z]$/.test(fields[0]));
  assert([fields[1],fields[2],fields[19]].every(field=>/^\d+$/.test(field)));
  const current={pid,parent:Number(fields[1]),group:Number(fields[2]),start:fields[19],state:fields[0]};
  assert(Number.isSafeInteger(current.parent)&&current.parent>=0&&Number.isSafeInteger(current.group)&&current.group>=0);return current;
}
async function nativeIdentity(pid,expectedExecutable,observe=()=>{},expectedIdentity){
  assert(Number.isSafeInteger(pid)&&pid>0);
  if(process.platform==='linux'){
    const before=await linuxNativeStat(pid);if(!before)return;
    const same=after=>{assert.equal(after.start,before.start,'PID reuse during executable inspection remains a failure');assert.equal(after.group,before.group);};
    if(expectedIdentity){assert.equal(before.start,expectedIdentity.start);assert.equal(before.group,expectedIdentity.group);}
    if(['Z','X'].includes(before.state))return;
    let executable;
    try{executable=await fs.realpath(`/proc/${pid}/exe`);}
    catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;
      const current=await linuxNativeStat(pid);if(!current)return;same(current);
      if(['Z','X'].includes(current.state))return;throw error;}
    const after=await linuxNativeStat(pid);if(!after)return;same(after);
    if(['Z','X'].includes(after.state))return;
    assert.equal(executable,expectedExecutable);
    if(after.parent!==before.parent||after.state!==before.state)observe({kind:'mutable-process-fields',pid,start:after.start,executable,group:after.group,
      beforeParent:before.parent,currentParent:after.parent,beforeState:before.state,currentState:after.state,stillAlive:true,observedAt:new Date().toISOString()});
    return {pid,parent:after.parent,group:after.group,start:after.start,executable};
  }
  if(process.platform==='win32'){
    const text=(await execute('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop;if($p){@{pid=$p.ProcessId;parent=$p.ParentProcessId;start=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath}|ConvertTo-Json -Compress}`],{timeout:5000})).stdout.trim();
    if(!text)return;const row=JSON.parse(text);assert.equal(row.pid,pid);assert(Number.isSafeInteger(row.parent)&&row.parent>0);assert(Number.isFinite(Date.parse(row.start)));
    row.executable=await fs.realpath(row.executable);assert.equal(row.executable.toLowerCase(),expectedExecutable.toLowerCase());return row;
  }
  const read=async()=>{try{return(await execute('ps',['-p',String(pid),'-o','ppid=,pgid=,stat=,lstart='],{timeout:5000})).stdout.trim();}
    catch(error){if(error.code===1&&!String(error.stdout||'').trim()&&!String(error.stderr||'').trim())return '';throw error;}};
  const parse=text=>{
    const match=text.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);assert(match);
    const value={parent:Number(match[1]),group:Number(match[2]),state:match[3],start:match[4]};
    assert(Number.isSafeInteger(value.parent)&&value.parent>=0&&Number.isSafeInteger(value.group)&&value.group>0);return value;
  };
  const beforeText=await read();if(!beforeText)return;
  const before=parse(beforeText);if(/^[ZX]/.test(before.state))return;
  let mappings;
  try{mappings=(await execute('lsof',['-nP','-a','-p',String(pid),'-d','txt','-F','n'],{timeout:5000})).stdout;}
  catch(error){if(error.code!==1||String(error.stdout||'').trim()||String(error.stderr||'').trim())throw error;
    const current=await read();if(!current)return;const after=parse(current);
    assert.equal(after.start,before.start);assert.equal(after.group,before.group);
    if(/^[ZX]/.test(after.state))return;throw error;}
  const files=await Promise.all(mappings.split('\n').filter(line=>line.startsWith('n')).map(line=>fs.realpath(line.slice(1))));
  const afterText=await read();if(!afterText)return;
  const after=parse(afterText);
  assert.equal(after.start,before.start,'PID reuse during executable inspection remains a failure');
  assert.equal(after.group,before.group,'The private process group remains anchored');
  if(/^[ZX]/.test(after.state))return;
  assert(files.includes(expectedExecutable));
  if(after.parent!==before.parent||after.state!==before.state)observe({kind:'mutable-process-fields',pid,start:after.start,executable:expectedExecutable,group:after.group,
    beforeParent:before.parent,currentParent:after.parent,beforeState:before.state,currentState:after.state,stillAlive:true,observedAt:new Date().toISOString()});
  return {pid,parent:after.parent,group:after.group,start:after.start,executable:expectedExecutable};
}
const nativeParentObservations=new WeakMap();
async function observeNativeIdentityGone(identity,observe){
  const current=await nativeIdentity(identity.pid,identity.executable,observe,identity);
  if(!current)return true;
  assert.equal(current.start,identity.start,'PID reuse is recorded as an identity mismatch, never silently accepted');
  const incarnation=({parent,...value})=>value;
  assert.deepEqual(incarnation(current),incarnation(identity),'The established incarnation retains its PID, start, executable and private group');
  if(current.parent!==identity.parent&&nativeParentObservations.get(identity)!==current.parent){
    nativeParentObservations.set(identity,current.parent);
    observe({kind:'parent-transition',pid:identity.pid,start:identity.start,executable:identity.executable,group:identity.group,
      originalParent:identity.parent,currentParent:current.parent,stillAlive:true,observedAt:new Date().toISOString()});
  }
  return false;
}
async function ownedStdioJuliaProcesses(){
  const expected=await fs.realpath(process.env.PERFCHECKER_NATIVE_JULIA);
  let rows;
  if(process.platform==='win32'){
    rows=JSON.parse((await execute('powershell.exe',['-NoProfile','-Command',
      "$ErrorActionPreference='Stop';ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {$_.Name -like 'julia*'} | ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;executable=$_.ExecutablePath}}) -Compress"],{timeout:5000})).stdout);
  }else{
    const query=execute('ps',['-eo','pid=,ppid='],{timeout:5000}),observer=query.child.pid;
    rows=(await query).stdout.trim().split('\n').map(line=>{const [pid,parent]=line.trim().split(/\s+/).map(Number);return{pid,parent};});
    const observed=rows.find(row=>row.pid===observer);if(observed)assert.equal(observed.parent,process.pid);
    rows=rows.filter(row=>row.pid!==observer);
  }
  const matches=async row=>{
    if(process.platform==='linux'){try{return await fs.realpath(`/proc/${row.pid}/exe`)===expected;}catch(error){
      if(!['ENOENT','ESRCH'].includes(error.code))throw error;const current=await linuxNativeStat(row.pid);
      if(!current||['Z','X'].includes(current.state))return false;throw error;}}
    if(process.platform==='win32')return (await fs.realpath(row.executable)).toLowerCase()===expected.toLowerCase();
    const files=(await execute('lsof',['-nP','-a','-p',String(row.pid),'-d','txt','-F','n'],{timeout:5000})).stdout;
    return(await Promise.all(files.split('\n').filter(line=>line.startsWith('n')).map(line=>fs.realpath(line.slice(1))))).includes(expected);
  };
  const direct=[];for(const row of rows.filter(row=>row.parent===process.pid))if(await matches(row))direct.push(row);
  assert.equal(direct.length,1,'One active canonical Julia controller is a direct extension-host child');
  const children=[];for(const row of rows.filter(row=>row.parent===direct[0].pid))if(await matches(row))children.push(row);
  assert.equal(children.length,1,'One active canonical Julia advisor worker belongs to that controller');
  const cliIdentity=await nativeIdentity(direct[0].pid,expected),workerIdentity=await nativeIdentity(children[0].pid,expected);
  assert(cliIdentity&&workerIdentity);assert.equal(cliIdentity.parent,process.pid);assert.equal(workerIdentity.parent,cliIdentity.pid);
  const bridgeTuple=await ownedLoopbackConnection(workerIdentity);
  assert.deepEqual(await nativeIdentity(workerIdentity.pid,expected),workerIdentity);
  return{cli:cliIdentity.pid,worker:workerIdentity.pid,cliIdentity,workerIdentity,bridgeTuple};
}
async function ownedLoopbackConnection(identity){
  let rows;
  if(process.platform==='linux'){
    const inodes=new Set();for(const fd of await fs.readdir(`/proc/${identity.pid}/fd`)){
      const target=await fs.readlink(`/proc/${identity.pid}/fd/${fd}`).catch(error=>{if(['ENOENT','ESRCH'].includes(error.code))return '';throw error;});
      const match=target.match(/^socket:\[(\d+)\]$/);if(match)inodes.add(match[1]);
    }
    rows=(await fs.readFile('/proc/net/tcp','utf8')).trim().split('\n').slice(1).map(line=>line.trim().split(/\s+/))
      .filter(fields=>fields[3]==='01'&&inodes.has(fields[9])).map(fields=>{
        assert(fields.length>9&&/^\d+$/.test(fields[9]));const [local,remote]=[fields[1],fields[2]].map(value=>value.split(':'));
        assert.equal(local[0],'0100007F');assert.equal(remote[0],'0100007F');
        return{localAddress:'127.0.0.1',localPort:parseInt(local[1],16),remoteAddress:'127.0.0.1',remotePort:parseInt(remote[1],16),inode:fields[9]};
      });
  }else if(process.platform==='win32')rows=JSON.parse((await execute('powershell.exe',['-NoProfile','-Command',
    `$ErrorActionPreference='Stop';ConvertTo-Json -InputObject @(Get-NetTCPConnection -State Established -OwningProcess ${identity.pid} -ErrorAction Stop | ForEach-Object {@{localAddress=$_.LocalAddress;localPort=$_.LocalPort;remoteAddress=$_.RemoteAddress;remotePort=$_.RemotePort}}) -Compress`],{timeout:5000})).stdout);
  else rows=(await execute('lsof',['-nP','-a','-p',String(identity.pid),'-iTCP','-sTCP:ESTABLISHED','-F','n'],{timeout:5000})).stdout.split('\n').filter(line=>line.startsWith('n')).map(line=>{
    const match=line.match(/^n127\.0\.0\.1:(\d+)->127\.0\.0\.1:(\d+)$/);assert(match);return{localAddress:'127.0.0.1',localPort:Number(match[1]),remoteAddress:'127.0.0.1',remotePort:Number(match[2])};
  });
  assert.equal(rows.length,1,'The held actual Julia worker owns exactly one loopback HTTP connection to the adapter');
  for(const key of ['localPort','remotePort'])assert(Number.isSafeInteger(rows[0][key])&&rows[0][key]>0&&rows[0][key]<65536);
  assert.equal(rows[0].localAddress,'127.0.0.1');assert.equal(rows[0].remoteAddress,'127.0.0.1');return rows[0];
}
async function bridgeClosed(tuple){
  const port=tuple.remotePort;let count;
  if(process.platform==='linux')count=(await fs.readFile('/proc/net/tcp','utf8')).trim().split('\n').slice(1)
    .map(line=>line.trim().split(/\s+/)).filter(fields=>fields[3]==='0A'&&fields[1]===`0100007F:${port.toString(16).toUpperCase().padStart(4,'0')}`).length;
  else if(process.platform==='win32')count=Number((await execute('powershell.exe',['-NoProfile','-Command',
    `$ErrorActionPreference='Stop';@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq ${port}}).Count`],{timeout:5000})).stdout.trim());
  else{
    try{count=(await execute('lsof',['-nP',`-iTCP@127.0.0.1:${port}`,'-sTCP:LISTEN','-F','n'],{timeout:5000})).stdout.split('\n').filter(line=>line.startsWith('n')).length;}
    catch(error){if(error.code===1&&!String(error.stdout||'').trim()&&!String(error.stderr||'').trim())count=0;else throw error;}
  }
  assert(Number.isSafeInteger(count)&&count>=0);if(count)return false;
  return new Promise((resolve,reject)=>{const socket=require('node:net').connect({host:'127.0.0.1',port});
    socket.setTimeout(1000,()=>{socket.destroy();reject(new Error('Adapter TCP observation timed out; closure is unknown'));});
    socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',error=>error.code==='ECONNREFUSED'?resolve(true):reject(error));});
}
const stdioHandoffFile=()=>path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,'mcp-stdio-reload-handoff.json');
async function stdioHandoff(){
  let stat;try{stat=await fs.lstat(stdioHandoffFile());}catch(error){if(error.code==='ENOENT')return;throw error;}
  assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<128000);
  const value=JSON.parse(await fs.readFile(stdioHandoffFile(),'utf8'));
  assert.equal(value.status,'awaiting-reload');assert.equal(value.invocation,process.env.PERFCHECKER_NATIVE_INVOCATION);
  assert.equal(value.vsixSha256,process.env.PERFCHECKER_NATIVE_SHA);assert.equal(value.workspace,process.env.PERFCHECKER_NATIVE_WORKSPACE);
  assert.deepEqual(value.core,JSON.parse(process.env.PERFCHECKER_NATIVE_CORE_PROVENANCE));
  assert.equal(value.qualifierSourceSha256,hash(await fs.readFile(__filename)));
  assert.deepEqual(Object.keys(value).sort(),['status','invocation','vsixSha256','workspace','oldHostPid','core','connection','files','head',
    'beforeReportSha256','qualifierSourceSha256','reloadRequestedAt','savedMeasurement'].sort());
  assert.deepEqual(Object.keys(value.connection).sort(),['root','identity','command','version',...(value.connection.windowsJobOwner?['windowsJobOwner']:[])].sort());
  const root=value.connection.root,session=await fs.realpath(process.env.PERFCHECKER_NATIVE_SESSION);
  assert.equal(path.dirname(await fs.realpath(root)),session);assert(path.basename(root).startsWith('neutral-mcp-'));
  assert((await fs.lstat(root)).isDirectory()&&!(await fs.lstat(root)).isSymbolicLink());
  assert.equal(value.connection.command,await fs.realpath(process.env.PERFCHECKER_NATIVE_NODE));assert.equal(value.connection.version,'2026-07-28');
  const expectedFiles=[path.join(value.workspace,'src','PerfCheckerNativeFixture.jl'),path.join(value.workspace,'.git','index'),path.join(value.workspace,'.vscode','settings.json'),
    ...[process.env.PERFCHECKER_NATIVE_CONTROLLER,path.join(value.workspace,'worker-environment')].flatMap(directory=>['Project.toml','Manifest.toml'].map(name=>path.join(directory,name))),
    value.savedMeasurement.file,value.savedMeasurement.adviceFile];
  assert.deepEqual(Object.keys(value.files).sort(),expectedFiles.sort());
  for(const file of [value.savedMeasurement.file,value.savedMeasurement.adviceFile]){
    const relative=path.relative(path.join(value.workspace,'perf','results','investigations'),file);
    assert(relative&&!path.isAbsolute(relative)&&!relative.split(path.sep).includes('..'));
    assert(['run.json','advice.json'].includes(path.basename(file)));
  }
  assert(Object.values(value.files).every(digest=>/^[a-f0-9]{64}$/.test(digest)));return value;
}
exports.validateStdioReloadHandoff=async previous=>{
  const value=await stdioHandoff();assert(value);assert.notEqual(process.pid,value.oldHostPid);
  assert.equal(process.env.PERFCHECKER_NATIVE_PHASE,'mcp-stdio');
  const activations=previous.filter(row=>row.invocation===value.invocation);assert.equal(activations.length,1);assert.equal(activations[0].pid,value.oldHostPid);
  const report=await fs.readFile(path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,'mcp-stdio.json'));
  assert.equal(hash(report),value.beforeReportSha256);assert.deepEqual(JSON.parse(report).failures,[]);
  await fs.writeFile(path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,'mcp-stdio-before-host-restart.json'),report);
};
async function resumeStdioReload(context,value){
  assert.notEqual(process.pid,value.oldHostPid);
  const {vscode,workspace,proof}=context;
  const sameNativeIdentityGone=identity=>observeNativeIdentityGone(identity,observation=>context.log('native-mcp-stdio-identity-observation',observation));
  const deadline=Date.parse(value.reloadRequestedAt)+60000;
  assert(Date.now()<deadline,'The new extension host must resume inside the existing 60-second shutdown bound');
  await eventually(async()=>!processAlive(value.oldHostPid)&&await sameNativeIdentityGone(value.connection.identity)&&
    (!value.connection.windowsJobOwner||await sameNativeIdentityGone(value.connection.windowsJobOwner))&&Date.now()<deadline,
  'Official Reload finishes owned stdio cleanup before final teardown',Math.max(1,deadline-Date.now()));
  assert.equal(Number(await fs.readFile(path.join(value.connection.root,'server.pid'),'utf8')),value.connection.identity.pid,
    'A new extension host must not automatically launch another server');
  const selected=vscode.workspace.getWorkspaceFolder(vscode.Uri.file(value.workspace));
  assert(selected);assert.equal(selected.uri.fsPath,value.workspace);
  await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(value.workspace));
  await vscode.commands.executeCommand('perfchecker.openChat');const state=await vscode.commands.executeCommand('perfchecker.chatState');
  assert.equal(state.workspace,selected.name,'The restarted host opens the explicitly selected owning workspace');
  assert.equal(state.connectionKind,undefined);assert.equal(state.busy,false);assert.deepEqual(state.messages,[]);
  for(const [file,digest] of Object.entries(value.files))assert.equal(hash(await fs.readFile(file)),digest,'Reload preserves source, Git index, settings, result and project/manifest bytes');
  assert.equal((await execute('git',['rev-parse','HEAD'],{cwd:workspace,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout,value.head);
  const records=(await fs.readFile(path.join(value.connection.root,'stdio-requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert(records.some(row=>row.method==='stdin/eof'));
  const activations=(await fs.readFile(path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,'mcp-stdio-activations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(row=>row.invocation===value.invocation);
  assert.equal(activations.length,2);assert.deepEqual(activations.map(row=>row.pid),[value.oldHostPid,process.pid]);
  proof('native-mcp-stdio-official-editor-reload',{oldHostPid:value.oldHostPid,newHostPid:process.pid,activations,
    oldHostAbsentBeforeTeardown:true,explicitWorkspaceSelectionAfterReload:true,
    server:value.connection.identity,windowsJobOwner:value.connection.windowsJobOwner,observedAbsentBeforeTeardown:true,
    sourceProjectManifestSettingsAndMeasuredResultPreserved:true,noAutomaticServerLaunch:true,sessionConnectionEmpty:true,
    newMeasurement:false,newAgent:false,priorReportSha256:value.beforeReportSha256,priorReport:'mcp-stdio-before-host-restart.json',
    timeoutSeconds:180,shutdownBoundSeconds:60,core:value.core,vsixSha256:value.vsixSha256});
  await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,`native-${process.platform}-${vscode.version}-mcp-stdio-after-reload.png`)});
  value.status='passed';value.newHostPid=process.pid;value.completedAt=new Date().toISOString();
  await fs.writeFile(stdioHandoffFile(),JSON.stringify(value,null,2));
}
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const processAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
function assertTemporaryCheckout(temporaryRoot,root,original){
  const relative=path.relative(temporaryRoot,root),parts=relative.split(path.sep);
  assert(relative&&!path.isAbsolute(relative)&&parts.length===2&&parts[0]!=='..'&&
    /^perfchecker-implementation-[^/\\]+$/.test(parts[0])&&parts[1]==='checkout',
    'Only the supplied disposable checkout is edited');
  assert.notEqual(root,original,'The provider never edits the original workspace');
  return relative;
}
async function ownedChatProcesses(log,heldSockets,snapshot,stage){
  const started=Date.now();
  let rows;
  if(process.platform==='win32'){
    assert.equal(heldSockets.length,1,'One actual provider request owns the cancellation probe socket');
    const socket=heldSockets[0];assert(!socket.destroyed,'The provider keeps the original connection open');
    const tuple={localAddress:socket.remoteAddress,localPort:socket.remotePort,
      remoteAddress:socket.localAddress,remotePort:socket.localPort};
    assert.equal(tuple.localAddress,'127.0.0.1');assert.equal(tuple.remoteAddress,'127.0.0.1');
    for(const key of ['localPort','remotePort'])assert(Number.isInteger(tuple[key])&&tuple[key]>0&&tuple[key]<65536);
    const before=await snapshot();
    let value;
    try{
      const {stdout}=await execute('powershell.exe',['-NoProfile','-Command',
        `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -like "julia*" } | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;executable=$_.ExecutablePath;createdAt=$_.CreationDate.ToUniversalTime().ToString('o');pidType=$_.ProcessId.GetType().FullName;parentType=$_.ParentProcessId.GetType().FullName;commandLength=([string]$_.CommandLine).Length;chatMarker=($_.CommandLine -match 'perfchecker-chat-');sourceArgument=($_.CommandLine -match '--source=');advisorWorker=($_.CommandLine -match 'advisor_worker\\.jl')} }); $tcp=@(Get-NetTCPConnection -State Established -ErrorAction Stop | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.RemoteAddress -eq '127.0.0.1' -and $_.LocalPort -eq ${tuple.localPort} -and $_.RemotePort -eq ${tuple.remotePort} } | ForEach-Object { @{pid=$_.OwningProcess;localAddress=$_.LocalAddress;localPort=$_.LocalPort;remoteAddress=$_.RemoteAddress;remotePort=$_.RemotePort;state=[string]$_.State} }); @{rows=$rows;connections=$tcp} | ConvertTo-Json -Depth 4 -Compress`]);
      value=JSON.parse(stdout);
    }catch(error){log('native-mcp-windows-query-failure',{stage,name:error.name,code:error.code,
      stderrBytes:Buffer.byteLength(error.stderr||''),queryMilliseconds:Date.now()-started});throw error;}
    rows=value.rows;assert(Array.isArray(rows));assert(Array.isArray(value.connections));
    const connection=value.connections.length===1?value.connections[0]:undefined;
    const worker=connection&&rows.find(row=>row.pid===connection.pid);
    const cli=worker&&rows.find(row=>row.pid===worker.parent&&row.parent===process.pid);
    const expectedExecutable=await fs.realpath(process.env.PERFCHECKER_NATIVE_JULIA);
    const identities=[];
    for(const row of [cli,worker].filter(Boolean)){
      assert.equal(typeof row.pid,'number');assert.equal(typeof row.parent,'number');
      assert(typeof row.createdAt==='string'&&/^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.createdAt)&&Number.isFinite(Date.parse(row.createdAt)),
        'Every retained process has a nonempty parseable ISO creation date');
      identities.push({pid:row.pid,canonicalExecutable:await fs.realpath(row.executable)});
    }
    const selectedJulia=identities.length===2&&identities.every(row=>row.canonicalExecutable.toLowerCase()===expectedExecutable.toLowerCase());
    const cliAlive=!!cli&&processAlive(cli.pid),workerAlive=!!worker&&processAlive(worker.pid);
    const after=await snapshot();
    log('native-mcp-owned-process-inventory',{stage,extensionHost:process.pid,tuple,connections:value.connections,
      queryMilliseconds:Date.now()-started,before,after,
      rows:rows.map(row=>({...row,pidJsonType:typeof row.pid,parentJsonType:typeof row.parent})),
      identities,expectedExecutable,selectedJulia,matchedCli:cli?.pid??null,matchedWorker:worker?.pid??null,
      cliAlive,workerAlive,heldSocketOpen:!socket.destroyed,commandArgumentsUnavailableAfterJuliaStartup:true});
    assert(connection&&connection.state==='Established'&&connection.localAddress===tuple.localAddress&&connection.remoteAddress===tuple.remoteAddress&&
      connection.localPort===tuple.localPort&&connection.remotePort===tuple.remotePort,'The exact retained HTTP connection identifies its actual worker');
    assert(before.pending===1&&after.pending===1&&before.uiBusy&&after.uiBusy&&!socket.destroyed,
      'The original provider request remains held across the physical ownership query');
    return cli&&worker&&selectedJulia&&cliAlive&&workerAlive?{cli:cli.pid,worker:worker.pid,cliCreatedAt:cli.createdAt,workerCreatedAt:worker.createdAt}:undefined;
  }else{
    const {stdout}=await execute('ps',['-eo','pid=,ppid=,args=']);
    rows=stdout.split('\n').map(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return match?{pid:Number(match[1]),parent:Number(match[2]),command:match[3]}:undefined;}).filter(Boolean);
  }
  const cli=rows.find(row=>row.parent===process.pid&&/perfchecker-chat-/.test(row.command||'')&&/--source=/.test(row.command||''));
  const worker=cli&&rows.find(row=>row.parent===cli.pid&&/advisor_worker\.jl/.test(row.command||''));
  // Keep the original ownership predicate. Physical inventory explains a
  // missing match without disclosing command lines or accepting another tree.
  log('native-mcp-owned-process-inventory',{extensionHost:process.pid,queryMilliseconds:Date.now()-started,
    rows:rows.filter(row=>process.platform==='win32'||/julia|perfchecker-chat-|advisor_worker\.jl/.test(row.command||''))
      .map(row=>({pid:Number(row.pid),parent:Number(row.parent),commandLength:(row.command||'').length,
        chatMarker:/perfchecker-chat-/.test(row.command||''),sourceArgument:/--source=/.test(row.command||''),
        advisorWorker:/advisor_worker\.jl/.test(row.command||''),extensionHostChild:row.parent===process.pid})),
    matchedCli:cli?Number(cli.pid):null,matchedWorker:worker?Number(worker.pid):null});
  return cli&&worker?{cli:Number(cli.pid),worker:Number(worker.pid)}:undefined;
}

async function measuredEvidence(context) {
  const root=path.resolve(context.workspace,context.vscode.workspace.getConfiguration('perfchecker',context.vscode.Uri.file(context.workspace)).get('investigationReports','perf/results/investigations'));
  const entries=()=>fs.readdir(root).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  const previousDiscovery=new Set(await entries());
  await context.vscode.commands.executeCommand('perfchecker.openInvestigations');
  let frame=await context.findFrame('#app nav[aria-label="Investigation views"]');
  await frame.getByRole('button',{name:'Discover tests',exact:true}).click();
  await eventually(async()=>!(await frame.locator('#app .status').getAttribute('class')).includes('busy')&&
    await frame.locator('.scenario-title strong').filter({hasText:/^advisor_sum_squares$/}).count()===1,'Actual Core discovers the distinct declared advisor allocation scenario',240000);
  let declared;
  for(const id of await entries()){
    if(previousDiscovery.has(id))continue;
    const bytes=await fs.readFile(path.join(root,id,'discovery.json')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
    if(!bytes)continue;
    const discovery=JSON.parse(bytes),matches=discovery.declared.filter(scenario=>scenario.id==='advisor_sum_squares'&&scenario.implementation==='allocating');
    if(!matches.length)continue;
    assert.equal(matches.length,1,'Discovery cannot ambiguously alias the advisor scenario');
    declared=matches[0];
    assert.equal(declared.catalog,'perf/advisor/scenarios.toml');
    assert.deepEqual(declared.collectors,['benchmark']);
    assert.equal(await fs.realpath(declared.source),await fs.realpath(path.join(context.workspace,'perf','cases.jl')));
    assert.deepEqual(discovery.declared.find(scenario=>scenario.id==='sum_squares'&&scenario.implementation==='allocating').collectors,
      ['benchmark','chairmark','profile','profile_alloc'],'The original catalogue retains all four collectors');
  }
  assert(declared,'The saved discovery must identify the exact single-collector catalogue before launch');
  context.proof('native-mcp-benchmark-catalog-discovery',{id:declared.id,implementation:declared.implementation,catalog:declared.catalog,
    source:declared.source,collectors:declared.collectors,originalFourCollectorsPreserved:true,assertedBeforeMeasurement:true});
  await frame.getByRole('button',{name:'Scenarios',exact:true}).click();
  await frame.getByRole('button',{name:'Clear selection',exact:true}).click();
  const selectedCard=frame.locator('article.card').filter({has:frame.locator('.scenario-title strong',{hasText:/^advisor_sum_squares$/})})
    .filter({has:frame.locator('.implementation',{hasText:/^allocating$/})});
  assert.equal(await selectedCard.count(),1,'Only the exact advisor declaration is selected');
  await selectedCard.locator('.scenario-title input').check();
  const before=new Set(await entries());
  await frame.getByRole('button',{name:'Measure selected',exact:true}).click();
  let measured;
  await eventually(async()=>{
    for(const id of await entries()){
      if(before.has(id))continue;
      const directory=path.join(root,id),file=path.join(directory,'run.json');
      const data=await fs.readFile(file).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(!data)continue;
      let report;
      try{report=JSON.parse(data);}catch(error){if(error instanceof SyntaxError)continue;throw error;}
      if(report.schema_version!=='perfchecker-scenario-run/1')continue;
      assert.equal(report.runs.length,1,'The explicitly selected MCP catalogue measures only BenchmarkTools');
      assert(report.runs.every(run=>run.scenario.id==='advisor_sum_squares'&&run.scenario.implementation==='allocating'&&run.collector==='benchmark'&&run.qualification.availability==='complete'&&run.qualification.correctness==='passed'));
      assert(report.runs[0].summaries.some(summary=>summary.metric==='julia.wall.time'&&summary.samples===100),'The real BenchmarkTools report contains 100 timing samples');
      const measurementProject=await fs.realpath(context.vscode.workspace.getConfiguration('perfchecker',context.vscode.Uri.file(context.workspace)).get('scenarioProject'));
      const manifests=await Promise.all(report.runs.map(run=>fs.readFile(path.join(directory,run.run_id,'manifest.json'),'utf8').then(JSON.parse)));
      const environments=manifests.flatMap(manifest=>manifest.environment_provenance);
      assert(environments.length>0,'The actual measurement retains its worker environment provenance');
      for(const environment of environments){
        assert.equal(await fs.realpath(environment.path),measurementProject,'Real measurements use the distinct selected worker environment');
        assert.equal(environment.project_sha256,hash(await fs.readFile(path.join(measurementProject,'Project.toml'))));
        assert.equal(environment.manifest_sha256,hash(await fs.readFile(path.join(measurementProject,'Manifest.toml'))));
        const packages=environment.resolved_packages.map(item=>item.name);
        assert(packages.includes('BenchmarkTools'),'The actual worker resolves its collector');
        assert(!packages.includes('PerfChecker')&&!packages.includes('HTTP'),'The measurement worker cannot supply the provider Core or HTTP dependencies');
      }
      const adviceBytes=await fs.readFile(path.join(directory,'advice','advice.json')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(!adviceBytes)continue;
      let advice;
      try{advice=JSON.parse(adviceBytes);}catch(error){if(error instanceof SyntaxError)continue;throw error;}
      assert.deepEqual(advice.recommendations,[],'The 100-sample passed report has no deterministic recommendation');
      const rawEvidence=advice.measurement_summaries;
      assert.equal(rawEvidence.length,3,'The actual saved advice retains all three canonical measured quantities');
      assert.deepEqual(rawEvidence.map(row=>[row.metric,row.unit]).sort(),[['julia.alloc.bytes','By'],['julia.alloc.count','1'],['julia.wall.time','s']]);
      const observations=(await fs.readFile(path.join(directory,report.runs[0].run_id,'observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      for(const row of rawEvidence){
        assert.match(row.id,/^measurement-[a-f0-9]{64}$/);
        assert.equal(row.run_id,report.runs[0].run_id);
        assert.equal(row.collector,'benchmark');assert.equal(row.record_count,100);
        assert.equal(row.record_semantics,'operation_measurement');assert.equal(row.aggregation,'sample');
        assert.equal(row.bundle_status,'complete');assert.equal(row.correctness,'passed');
        assert.equal(observations.filter(record=>record.measurement_definition===row.measurement_definition&&record.metric===row.metric&&record.unit===row.unit).length,row.record_count,'Summary count comes from the actual saved records');
      }
      const adviceFile=path.join(directory,'advice','advice.json');
      // The installed Core validates and serializes the canonical saved summaries.
      // No recommendation or measurement row is fabricated by this native test.
      const projected=await execute(process.env.PERFCHECKER_NATIVE_JULIA,
        ['--startup-file=no',`--project=${context.controller}`,'-e',
          'using PerfChecker; advice=PerfChecker.read_advice(ARGS[1]); config=PerfChecker.AdvisorConfig(protocol=:mcp_http,mcp_tool="ask_perfchecker",mcp_response=:text); evidence=PerfChecker._advisor_evidence(advice,config); serialized=PerfChecker.JSON.json(evidence); print(PerfChecker.JSON.json(Dict("evidence"=>evidence,"serialized"=>serialized,"characters"=>length(serialized),"budget"=>config.max_evidence_chars)))',adviceFile],
        {windowsHide:true,env:{...process.env,JULIA_LOAD_PATH:process.env.PERFCHECKER_LOAD_PATH||'@'+path.delimiter+'@stdlib'}});
      const projection=JSON.parse(projected.stdout),evidence=projection.evidence;
      assert.equal(new Set(evidence.map(row=>row.id)).size,evidence.length,'The Core projection has unique evidence IDs');
      assert.equal(projection.budget,12000);assert.equal([...projection.serialized].length,projection.characters);
      assert(projection.characters<=projection.budget,'The actual Core serialized array respects the exact Unicode character limit');
      assert.deepEqual(JSON.parse(projection.serialized),evidence);
      assert.deepEqual(evidence,rawEvidence,'The bounded projection preserves all saved canonical summaries exactly');
      measured={id,file,adviceFile,evidence,rawEvidence,recommendations:advice.recommendations,
        evidenceCharacters:projection.characters,evidenceBudget:projection.budget,runSha256:hash(data),adviceSha256:hash(adviceBytes),
        measurementEnvironments:environments.map(environment=>({path:environment.path,projectSha256:environment.project_sha256,
          manifestSha256:environment.manifest_sha256,collector:environment.resolved_packages.find(item=>item.name==='BenchmarkTools'),
          providerDependenciesAbsent:true}))};
      return !(await frame.locator('#app .status').getAttribute('class')).includes('busy');
    }
    return false;
  },'Real Julia measurements and their saved deterministic advice complete',360000);
  return measured;
}

exports.run = async (context,options={}) => {
  assert.equal(process.env.CI, 'true');
  if(options.stdio){const handoff=await stdioHandoff();if(handoff)return resumeStdioReload(context,handoff);}
  const {vscode, workspace, findFrame, log, proof} = context;
  const sameNativeIdentityGone=identity=>observeNativeIdentityGone(identity,observation=>log('native-mcp-stdio-identity-observation',observation));
  const uri = vscode.Uri.file(workspace);
  const settings = () => vscode.workspace.getConfiguration('perfchecker', uri);
  const measurementProject=await fs.realpath(path.join(workspace,'worker-environment'));
  const controllerProject=await fs.realpath(context.controller);
  assert.notEqual(measurementProject,controllerProject,'Controller and measurement projects are physically distinct');
  const measurementDependencies=await fs.readFile(path.join(measurementProject,'Project.toml'),'utf8');
  assert(!/^\s*(PerfChecker|HTTP)\s*=/m.test(measurementDependencies));
  assert(!process.env.PERFCHECKER_LOAD_PATH||process.env.PERFCHECKER_LOAD_PATH==='@'+path.delimiter+'@stdlib',
    'No extra load path may hide provider/measurement dependency separation');
  const source = path.join(workspace, 'src', 'PerfCheckerNativeFixture.jl');
  const original = await fs.readFile(source, 'utf8');
  const proposed = original.replace('sum(xs .^ 2)', 'sum((x * x for x in xs); init=zero(eltype(xs)))');
  assert.notEqual(proposed, original);
  const git = async (...args) => (await execute('git', args, {cwd: workspace,
    env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}, windowsHide: true})).stdout;
  const head = await git('rev-parse', 'HEAD');
  const probe = async root => {
    const code = 'include("src/PerfCheckerNativeFixture.jl"); score=PerfCheckerNativeFixture.sum_squares; @assert score(Float64[]) == 0.0; @assert score([1.0,-2.0,3.0]) == 14.0; xs=collect(1.0:1000.0); score(xs); @assert score(xs)==333833500.0; println(@allocated score(xs))';
    return Number((await execute(process.env.PERFCHECKER_NATIVE_JULIA,
      ['--startup-file=no', '-e', code], {cwd: root, windowsHide: true,
        env: {...process.env, UV_THREADPOOL_SIZE: '1'}})).stdout.trim());
  };
  const baselineBytes = await probe(workspace);
  const calls = [], pending = new Set(), pendingSockets=new Map(), providerErrors=[],receipts=[];
  let alternateFolder;
  const stdio=options.stdio===true;
  const nativeNode=stdio?await fs.realpath(process.env.PERFCHECKER_NATIVE_NODE):undefined;
  if(stdio){const provenance=JSON.parse(process.env.PERFCHECKER_NATIVE_NODE_PROVENANCE);assert.equal(provenance.executable,nativeNode);
    assert.equal(provenance.sha256,hash(await fs.readFile(nativeNode)));assert.equal(provenance.electron,false);proof('native-mcp-stdio-node-runtime',provenance);}
  const foreign=spawn(stdio?nativeNode:process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const foreignFinished=new Promise(resolve=>foreign.once('close',resolve));
  const foreignIdentity=stdio?await nativeIdentity(foreign.pid,nativeNode):undefined;
  const custom=options.customArguments===true;
  const adviceTool=stdio?'consult_native':'ask_perfchecker',implementationTool=stdio?'modify_native':'implement_perfchecker';
  const adviceArgument=custom?'question':'prompt',implementationArgument=custom?'change_request':'prompt',workspaceArgument=custom?'checkout_path':'workspace';
  const additional=custom?{native_contract:{label:'real-native-request',enabled:true}}:{};
  const implementationAdditional=stdio?{native_contract:{label:'independent-implementation-request',enabled:true}}:additional;
  const providerLabel=stdio?'Neutral real MCP stdio server and controlled backend; transport/UX only, no inference or credentials':'Controlled real HTTP MCP service; no inference or credentials';
  let implementationBytes,attached,savedEvidence,legacyJulia;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'DELETE') {receipts.push({method:'DELETE',observedAt:new Date().toISOString()});res.writeHead(204); res.end(); return;}
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      receipts.push({method:req.method,rpc:body.method,observedAt:new Date().toISOString()});
      res.setHeader('Content-Type', 'application/json');
      if (body.method === 'notifications/initialized') {res.writeHead(202); res.end(); return;}
      let result = {};
      if (body.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'native-deterministic-provider');
        result = {protocolVersion: body.params.protocolVersion, capabilities: {tools: {}},
          serverInfo: {name: 'Deterministic native qualification provider', version: '1'}};
      }
      if (body.method === 'tools/list') result = {tools: [adviceTool, implementationTool].map(name => {
        const promptArgument=name===implementationTool?implementationArgument:adviceArgument;
        return {name,inputSchema:{type:'object',properties:{[promptArgument]:{type:'string'},[workspaceArgument]:{type:'string'},
          ...(custom?{native_contract:{type:'object'}}:{})},required:name===implementationTool?[promptArgument,workspaceArgument]:[promptArgument]}};
      })};
      if (body.method === 'tools/call') {
        assert(stdio?['2025-11-25','2026-07-28'].includes(req.headers['mcp-protocol-version']):req.headers['mcp-protocol-version']==='2026-07-28');
        const {name, arguments: args} = body.params;
        const promptArgument=name===implementationTool?implementationArgument:adviceArgument,prompt=args[promptArgument];
        assert.equal(typeof prompt, 'string');
        if(custom){assert.deepEqual(args.native_contract,(name===implementationTool?implementationAdditional:additional).native_contract);assert.equal(Object.hasOwn(args,'prompt'),false);
          assert.deepEqual(Object.keys(args).sort(),[promptArgument,...(name===implementationTool?[workspaceArgument]:[]),'native_contract'].sort());}
        const projection=JSON.parse(prompt.split('\n\nPerfChecker evidence:\n').at(-1));
        assert(Array.isArray(projection.evidence));
        if(attached){
          assert.deepEqual(projection.evidence,attached.evidence,'The explicitly attached canonical measured IDs and content reach tools/call before the reply');
          assert([...JSON.stringify(projection.evidence)].length<=attached.evidenceBudget,'The actual request remains inside the serialized evidence budget');
          if(name!==implementationTool)assert(prompt.includes('No recommendations does not mean no measurements'));
        }else{
          assert.deepEqual(projection.evidence,[],'No saved measurement reaches the server without explicit Attach');
          assert(prompt.includes('No saved report was attached.'));
          assert(savedEvidence,'A real saved report already exists before testing the absence of implicit attachment');
        }
        calls.push({name,prompt,promptArgument,workspaceArgument:name===implementationTool?workspaceArgument:undefined,additionalArgumentsVerified:custom,revision:req.headers['mcp-protocol-version'],
          evidenceIds:projection.evidence.map(row=>row.id),projectionSha256:hash(JSON.stringify(canonical(projection.evidence))),
          evidenceInspectedBeforeReply:true,savedReportPresent:!!savedEvidence,explicitAttachment:!!attached});
        let answer = 'Consider a generator to remove the intermediate squared array. Verify empty inputs and signed floating-point values, then measure allocations; speed is not yet qualified.';
        if (prompt.includes('native cancellation probe')) {
          pending.add(res);pendingSockets.set(res,req.socket); res.on('close', () => {pending.delete(res);pendingSockets.delete(res);}); return;
        }
        if(stdio&&prompt.includes('native legacy transport probe')){
          legacyJulia=await ownedStdioJuliaProcesses();assert.equal(activeStdio.version,'2025-11-25');activeStdio.observedJulia=legacyJulia;
        }
        if (name === implementationTool) {
          const root = await fs.realpath(args[workspaceArgument]);
          const temporaryRoot=await fs.realpath(os.tmpdir()),originalRoot=await fs.realpath(workspace);
          // Record the physical alias boundary before any refusal or file edit.
          log('native-implementation-checkout-boundary',{temporaryRoot:os.tmpdir(),canonicalTemporaryRoot:temporaryRoot,
            suppliedCheckout:args[workspaceArgument],canonicalCheckout:root,canonicalOriginalWorkspace:originalRoot,
            temporaryAliasResolved:temporaryRoot!==os.tmpdir(),checkoutAliasResolved:root!==args[workspaceArgument]});
          const relative=assertTemporaryCheckout(temporaryRoot,root,originalRoot);
          for(const refused of [temporaryRoot,path.join(temporaryRoot,'perfchecker-implementation-sibling'),
            path.join(temporaryRoot,'perfchecker-implementation-sibling','not-checkout'),
            path.join(root,'nested-workspace'),
            path.join(path.dirname(temporaryRoot),'perfchecker-implementation-outside','checkout'),originalRoot])
            assert.throws(()=>assertTemporaryCheckout(temporaryRoot,refused,originalRoot));
          log('native-implementation-boundary-refusals',{rootSiblingOutsideOriginalRejected:true,relativeCheckout:relative});
          const file = path.join(root, 'src', 'PerfCheckerNativeFixture.jl');
          assert.equal(await fs.readFile(file, 'utf8'), original);
          await fs.writeFile(file, proposed);
          implementationBytes = await probe(root);
          assert(implementationBytes < baselineBytes);
          answer = 'The generator was implemented and the empty, signed and Float64 oracles passed in the supplied isolated copy. Review the diff before applying.';
        }
        result = {content: [{type: 'text', text: answer}]};
      }
      res.end(JSON.stringify({jsonrpc: '2.0', id: body.id, result}));
    } catch (error) {providerErrors.push(String(error));log('native-controlled-provider-error',{error:String(error)});res.writeHead(500); res.end(JSON.stringify({error: String(error)}));}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const values = {advisorEnabled: true, advisorProtocol: 'mcp_http',
    scenarioProject:measurementProject,scenarioCatalog:'perf/advisor/scenarios.toml',
    advisorEndpoint: `http://127.0.0.1:${server.address().port}/mcp`, advisorModel: 'native-fixture',
    advisorMcpTool: adviceTool, advisorMcpResponse: 'text', advisorMcpVersion: '2026-07-28',
    advisorImplementationMcpTool: implementationTool, advisorTimeout: 180,
    advisorMcpPromptArgument:adviceArgument,advisorMcpArguments:additional,
    advisorImplementationMcpPromptArgument:implementationArgument,advisorImplementationMcpWorkspaceArgument:workspaceArgument,
    codexExecutable: path.join(workspace, 'not-installed-codex')};
  values.scenarioSamples=100;
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, settings().inspect(key)?.workspaceFolderValue]));
  const state = () => vscode.commands.executeCommand('perfchecker.chatState');
  const stdioConnections=[];let activeStdio,reloading=false,primaryError;
  const stdioRecords=async connection=>(await fs.readFile(path.join(connection.root,'stdio-requests.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const stdioSelect=async(panel,id,caption)=>{
    const input=panel.locator('select#'+id);assert.equal(await input.count(),1);
    assert.equal(await input.locator('..').locator(':scope > span').innerText(),caption);return input;
  };
  const connectStdio=async(version)=>{
    assert.equal((await state()).connectionKind,undefined,'A new native connection starts from a disconnected chat');
    const root=await fs.mkdtemp(path.join(process.env.PERFCHECKER_NATIVE_SESSION,'neutral-mcp-'));
    const command=await fs.realpath(nativeNode),serverFile=await fs.realpath(__filename),args=[serverFile,'--neutral-stdio',values.advisorEndpoint,root,version];
    assert.equal(await fs.realpath(path.dirname(root)),await fs.realpath(process.env.PERFCHECKER_NATIVE_SESSION));
    assert.equal((await fs.lstat(root)).isSymbolicLink(),false);
    await vscode.commands.executeCommand('perfchecker.openChat');let chat=await findFrame('#chat-root');
    await chat.getByRole('button',{name:'Connect local MCP server',exact:true}).click();
    const panel=await findFrame('#advisor-root');
    await(await stdioSelect(panel,'advisor-protocol','Mode')).selectOption('mcp_stdio');
    await panel.getByLabel('Absolute MCP server executable',{exact:true}).fill(command);
    await panel.getByLabel('Executable arguments (JSON array)',{exact:true}).fill(JSON.stringify(args));
    await panel.getByLabel('Absolute server working directory',{exact:true}).fill(root);
    await(await stdioSelect(panel,'advisor-mcp_version','MCP version')).selectOption(version);
    await panel.getByLabel('Connection / download timeout (seconds)',{exact:true}).fill(String(values.advisorTimeout));
    await panel.getByRole('button',{name:'Test connection / discover',exact:true}).click();
    await eventually(async()=>await panel.getByRole('heading',{name:adviceTool,exact:true}).count()===1&&await panel.getByRole('heading',{name:implementationTool,exact:true}).count()===1&&
      await panel.locator('#advisor-root').getAttribute('aria-busy')==='false','The real stdio transport displays both paginated tool schemas');
    const row=name=>panel.locator('article.card').filter({has:panel.getByRole('heading',{name,exact:true})});
    await row(adviceTool).getByRole('button',{name:'Use',exact:true}).click();
    await row(implementationTool).getByRole('button',{name:'Use for implementation',exact:true}).click();
    await panel.getByLabel('Other tool arguments (JSON)',{exact:true}).fill(JSON.stringify(additional));
    await panel.getByLabel('Implementation prompt argument',{exact:true}).fill(implementationArgument);
    await panel.getByLabel('Isolated checkout argument',{exact:true}).fill(workspaceArgument);
    await panel.getByLabel('Other implementation arguments (JSON)',{exact:true}).fill(JSON.stringify(implementationAdditional));
    assert.equal(await panel.getByLabel('Selected MCP tool',{exact:true}).inputValue(),adviceTool);
    assert.equal(await panel.getByLabel('Prompt argument',{exact:true}).inputValue(),adviceArgument);
    assert.equal(await panel.getByLabel('Optional implementation tool',{exact:true}).inputValue(),implementationTool);
    const schemas=[];
    for(const name of [adviceTool,implementationTool]){
      await row(name).locator('summary').click();
      const schema=JSON.parse(await row(name).locator('pre').innerText());schemas.push({name,schema});
      assert.deepEqual(schema.required,name===adviceTool?[adviceArgument,'native_contract']:[implementationArgument,workspaceArgument,'native_contract']);
    }
    const discoveredPID=Number(await fs.readFile(path.join(root,'server.pid'),'utf8'));
    const identity=await nativeIdentity(discoveredPID,command);assert(identity);let windowsJobOwner;
    if(process.platform!=='win32'){assert.equal(identity.parent,process.pid);assert.equal(identity.group,identity.pid);}
    else{
      const ownerExecutable=await fs.realpath(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'));
      windowsJobOwner=await nativeIdentity(identity.parent,ownerExecutable);assert(windowsJobOwner);assert.equal(windowsJobOwner.parent,process.pid);
    }
    activeStdio={root,identity,windowsJobOwner,command,args,version,schemas};stdioConnections.push(activeStdio);
    proof('native-mcp-stdio-discovered-schema',{version,command,args,cwd:root,sourceSha256:hash(await fs.readFile(serverFile)),identity,windowsJobOwner,
      schemas,timeoutSeconds:values.advisorTimeout,timeoutScope:'Explicit qualification configuration, not the default',toolsCalled:0,
      provider:providerLabel,explicitNativeFieldGestures:true,independentImplementationArguments:implementationAdditional});
    await panel.getByLabel('Absolute MCP server executable',{exact:true}).scrollIntoViewIfNeeded();
    await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,`native-${process.platform}-${vscode.version}-mcp-stdio-${version}-configuration.png`)});
    await row(implementationTool).scrollIntoViewIfNeeded();
    await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,`native-${process.platform}-${vscode.version}-mcp-stdio-${version}-schema.png`)});
    await panel.getByRole('button',{name:'Connect for this editor session',exact:true}).click();
    await eventually(async()=>(await state()).connectionKind==='stdio','Native Save publishes the connection and does not cancel its server');
    assert.deepEqual(await nativeIdentity(identity.pid,command),identity,
      'Discovery and Connect retain exactly the same native server');
    assert.deepEqual((await state()).implementation.arguments,implementationAdditional);
    assert.equal((await vscode.commands.executeCommand('perfchecker.codexConnectionState')).connected,false);
    const connectedRecords=await stdioRecords(activeStdio);
    assert(connectedRecords.filter(record=>record.method==='tools/list').length>=2,'The real paginated discovery completed before Connect');
    proof('native-mcp-stdio-connected-session',{version,server:identity,windowsJobOwner,connectionKind:'stdio',
      sameServerAfterDiscovery:true,nativeConnectClick:true,paginatedSchemaNames:schemas.map(schema=>schema.name),
      adviceTool,implementationTool,adviceArgument,implementationArgument,workspaceArgument,
      independentImplementationArguments:implementationAdditional,sessionOnly:true,savedSettingsNotQualified:true,provider:providerLabel});
    await vscode.commands.executeCommand('perfchecker.openChat');chat=await findFrame('#chat-root');
    await chat.getByRole('button',{name:'New conversation',exact:true}).click();
    return chat;
  };
  try {
    await context.editorQualification?.port(server.address().port);
    for (const [key, value] of Object.entries(values)) await settings().update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    assert.equal(await fs.realpath(settings().get('runnerProject')),controllerProject);
    assert.equal(await fs.realpath(settings().get('scenarioProject')),measurementProject);
    proof('native-mcp-distinct-controller-and-measurement-projects',{controllerProject,measurementProject,
      providerDependenciesExcludedFromMeasurement:true,extraLoadPath:false,settingsRestoredInFinally:true});
    const configuredPath=settings().get('advisorConfig','perf/advisor.json');
    const configuredFile=typeof configuredPath==='string'&&configuredPath.trim()?path.resolve(workspace,configuredPath):undefined;
    const readSavedConfiguration=()=>configuredFile?fs.readFile(configuredFile).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;}):Promise.resolve(undefined);
    const savedConfig=await readSavedConfiguration();
    await clickStudioAction(context,'chat');
    let view = await findFrame('#chat-root');
    await context.editorQualification?.surface('custom-mcp-before-connect',view);
    if(!stdio){
    await view.locator('summary').filter({hasText: 'Optional Codex CLI connector'}).click();
    await view.getByRole('button', {name: 'Connect Codex CLI', exact: true}).click();
    await eventually(async () => /ENOENT|executable|could not|launch/i.test(await view.locator('[role="status"]').innerText()), 'Missing Codex explains its executable prerequisite');
    assert.equal((await vscode.commands.executeCommand('perfchecker.codexConnectionState')).connected, false);
    proof('codex-missing-native-prerequisite',{command:'perfchecker.connectCodex',status:'prerequisite',reason:'Codex executable absent from disposable CI; no human credentials are transferred.'});
    assert.deepEqual(await vscode.commands.executeCommand('perfchecker.disconnectCodex'),{connected:false});
    assert.equal((await vscode.commands.executeCommand('perfchecker.codexConnectionState')).connected,false);
    assert.equal(settings().get('advisorConfig','perf/advisor.json'),configuredPath);
    assert.deepEqual(await readSavedConfiguration(),savedConfig,'The failed temporary CLI connection and explicit disconnect preserve the saved provider bytes');
    proof('codex-disconnected-command',{command:'perfchecker.disconnectCodex',returnValueVerified:true,alreadyDisconnected:true,savedConfigurationPreserved:true,optionalConfigurationPath:configuredPath,directoryRead:false,activeAuthenticatedDisconnection:false});
    }
    await view.getByRole('button', {name: 'New conversation', exact: true}).click();
    const diagnoseSend=async(stage)=>{
      const diagnostic={stage,extensionHost:process.pid,controllerProject,measurementProject,
        configuredTimeoutSeconds:values.advisorTimeout,externalTimeoutSeconds:values.advisorTimeout+60,
        nativeOracleTimeoutSeconds:180,receipts:[...receipts],providerErrors:[...providerErrors]};
      try{diagnostic.chatState=await state();}catch(error){diagnostic.stateError=String(error);}
      if(process.platform==='darwin'){
        try{
          const expectedExecutable=await fs.realpath(process.env.PERFCHECKER_NATIVE_JULIA);
          const snapshot=execute('ps',['-axo','pid=,ppid=,args='],{timeout:5000});
          const observerPID=snapshot.child.pid;
          const {stdout}=await snapshot;
          const rows=stdout.split('\n').map(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return match?{pid:Number(match[1]),parent:Number(match[2]),command:match[3]}:undefined;}).filter(Boolean);
          const observer=rows.find(row=>row.pid===observerPID);
          if(observer){assert.equal(observer.parent,process.pid);diagnostic.excludedObserver={pid:observerPID,parent:observer.parent};}
          const parents=new Set([process.pid]),owned=[];
          diagnostic.ownedProcesses=owned;
          diagnostic.processDiagnosticErrors=[];
          for(let depth=0;depth<2;depth++)for(const row of rows.filter(row=>row.pid!==observerPID&&parents.has(row.parent)&&!owned.some(x=>x.pid===row.pid))){
            try{
            const {stdout:files}=await execute('lsof',['-nP','-a','-p',String(row.pid),'-d','txt','-F','n'],{timeout:5000});
            const executables=await Promise.all(files.split('\n').filter(line=>line.startsWith('n')).map(line=>fs.realpath(line.slice(1)).catch(()=>undefined)));
            if(!executables.includes(expectedExecutable))continue;
            const start=(await execute('ps',['-p',String(row.pid),'-o','lstart='],{timeout:5000})).stdout.trim();
            const item={pid:row.pid,parent:row.parent,canonicalExecutable:expectedExecutable,startIdentity:start,
              alive:processAlive(row.pid),projects:[...row.command.matchAll(/--project=(\S+)/g)].map(match=>match[1]),
              commandLength:row.command.length,advisorWorker:/advisor_worker\.jl/.test(row.command),sameIdentityAfterRead:false};
            owned.push(item);parents.add(row.pid);
            const configuration=row.command.match(/--advisor-config=(\S+)/)?.[1];
            if(configuration){
              const directory=await fs.realpath(path.dirname(configuration)),temporaryRoot=await fs.realpath(os.tmpdir());
              assert.equal(path.dirname(directory),temporaryRoot);assert(/^perfchecker-chat-/.test(path.basename(directory)));
              const bytes=await fs.readFile(configuration),config=JSON.parse(bytes);
              item.actualAdvisorFile={path:configuration,sha256:hash(bytes),timeout:config.timeout,protocol:config.protocol};
            }
            const request=row.command.match(/\s(\/\S+\/request\.toml)(?:\s|$)/)?.[1];
            if(request){
              const directory=await fs.realpath(path.dirname(request)),temporaryRoot=await fs.realpath(os.tmpdir());
              assert.equal(path.dirname(directory),temporaryRoot);
              const bytes=await fs.readFile(path.join(directory,'worker.log'));
              item.workerPhaseMarkers=bytes.subarray(Math.max(0,bytes.length-8192)).toString('utf8').split('\n')
                .filter(line=>/^PERFCHECKER_ADVISOR_PHASE [a-z_]+ [0-9]+\.[0-9]+(?:e[+-]?[0-9]+)?$/.test(line));
            }
            const after=(await execute('ps',['-p',String(row.pid),'-o','lstart='],{timeout:5000})).stdout.trim();
            item.sameIdentityAfterRead=!!start&&start===after;
            }catch(error){diagnostic.processDiagnosticErrors.push({pid:row.pid,parent:row.parent,error:String(error)});}
          }
        }catch(error){diagnostic.processDiagnosticError=String(error);}
      }
      log('native-mcp-send-diagnostic',diagnostic);
    };
    const send = async (question, count) => {
      await view.locator('#chat-question').fill(question);
      log('native-ui-action',{surface:'MCP conversation',action:'Send question',turn:count/2});
      await view.getByRole('button', {name: 'Send question', exact: true}).click();
      let nextDiagnostic=Date.now()+60000;
      try{
        await eventually(async () => {assert.deepEqual(providerErrors,[],'The real provider must accept the exact Core request');const value = await state();
          if(process.platform==='darwin'&&Date.now()>=nextDiagnostic){await diagnoseSend('waiting');nextDiagnostic=Date.now()+60000;}
          return !value.busy && value.messages.length === count;}, 'Actual Julia MCP worker returns the conversation');
      }catch(error){await diagnoseSend('failed-before-teardown');throw error;}
    };
    savedEvidence=await measuredEvidence(context);
    await vscode.commands.executeCommand('perfchecker.openChat');view=await findFrame('#chat-root');
    if(stdio){
      view=await connectStdio('2025-11-25');
      await send('native legacy transport probe: inspect the intermediate allocation without editing or attaching the saved report.',2);
      assert(legacyJulia);await eventually(async()=>await sameNativeIdentityGone(legacyJulia.cliIdentity)&&await sameNativeIdentityGone(legacyJulia.workerIdentity),
        'The completed legacy request releases its actual Julia client processes while the stdio server remains available',60000);
      const connection=activeStdio;
      assert.deepEqual(await nativeIdentity(connection.identity.pid,nativeNode),connection.identity);
      assert.equal((await state()).connectionKind,'stdio','The completed legacy advice retains its existing stdio connection');
      await view.getByRole('button',{name:'Configure MCP connection',exact:true}).click();
      const panel=await findFrame('#advisor-root');
      assert.equal(await(await stdioSelect(panel,'advisor-protocol','Mode')).inputValue(),'mcp_stdio');
      assert.equal(await(await stdioSelect(panel,'advisor-mcp_version','MCP version')).inputValue(),'2025-11-25',
        'Reopening configuration reads the connected legacy revision from memory, rather than the modern saved settings');
      await panel.getByRole('button',{name:'Test connection / discover',exact:true}).click();
      await eventually(async()=>await panel.locator('#advisor-root').getAttribute('aria-busy')==='false'&&
        await panel.getByRole('heading',{name:adviceTool,exact:true}).count()===1,'Probe after a completed legacy conversation keeps the existing server usable');
      assert.deepEqual(await nativeIdentity(connection.identity.pid,nativeNode),connection.identity);
      const records=await stdioRecords(connection);
      for(const method of ['initialize','notifications/initialized','tools/list','tools/call'])assert(records.some(row=>row.method===method));
      assert(records.every(row=>row.version==='2025-11-25'));assert.equal(records.some(row=>row.method==='server/discover'),false);
      const disconnectUntil=Date.now()+60000;
      await panel.getByRole('button',{name:'Disconnect local MCP server',exact:true}).click();
      await eventually(async()=>await sameNativeIdentityGone(connection.identity)&&
        (!connection.windowsJobOwner||await sameNativeIdentityGone(connection.windowsJobOwner))&&!(await state()).connectionKind&&
        await bridgeClosed(legacyJulia.bridgeTuple)&&Date.now()<disconnectUntil,
      'Explicit legacy Disconnect closes the same server after its real advice turn',Math.max(1,disconnectUntil-Date.now()));
      proof('native-mcp-stdio-legacy-real-advice',{version:'2025-11-25',records,actualCoreConversation:true,legacyJulia,
        sameServerAvailableAfterCompletedRequest:true,probeReusesIdentity:true,explicitDisconnect:true,ownedServerAbsentBeforeTeardown:true,
        httpSessionIdEmitted:false,httpSessionMode:'stateless; no session DELETE required',adapterExactListenerAbsentAndTcpRefused:true,
        timeoutSeconds:values.advisorTimeout,provider:providerLabel});
      calls.splice(0);
      view=await connectStdio('2026-07-28');
    }
    assert.equal((await state()).evidenceId,'','Saving a real report does not attach it to the conversation');
    await send('Inspect the intermediate allocation in sum_squares without editing. What should I verify?', 2);
    assert.deepEqual(calls[0].evidenceIds,[],'The configuration-only path remains valid without saved measurements');
    proof('native-mcp-configuration-only-conversation',{adviceTurns:1,noSavedEvidence:true,savedReportPresent:true,
      historyId:savedEvidence.id,evidenceInspectedBeforeReply:calls[0].evidenceInspectedBeforeReply,sourceUnchanged:await fs.readFile(source,'utf8')===original});
    attached=savedEvidence;
    await view.getByRole('combobox',{name:'Attach saved evidence',exact:true}).selectOption(attached.id);
    await eventually(async()=>{const value=await state();return value.evidenceId===attached.id&&value.messages.length===0;},'The real evidence selector starts a conversation with the selected measured bundle');
    await send('Inspect the intermediate allocation in sum_squares using this measured evidence without editing. What should I verify?',2);
    await send('Continue this conversation: how should empty inputs and signed Float64 values be checked?', 4);
    assert.equal(await fs.readFile(source, 'utf8'), original);
    assert(calls[2].prompt.includes('Inspect the intermediate allocation') && calls[2].prompt.includes('signed Float64'), 'The second attached-evidence MCP call contains the bounded conversation');
    assert.deepEqual(calls[1].evidenceIds,attached.evidence.map(row=>row.id));
    assert.equal(calls[1].projectionSha256,calls[2].projectionSha256,'Follow-up sends the same bounded measured evidence');
    assert.equal(hash(await fs.readFile(attached.file)),attached.runSha256);
    assert.equal(hash(await fs.readFile(attached.adviceFile)),attached.adviceSha256);
    proof('native-mcp-selected-measured-evidence',{nativeSelector:true,historyId:attached.id,evidenceIds:calls[1].evidenceIds,
      controllerProject,measurementProject,measurementEnvironments:attached.measurementEnvironments,
      runSha256:attached.runSha256,adviceSha256:attached.adviceSha256,projectionSha256:calls[1].projectionSha256,
      rawRecommendations:attached.recommendations,canonicalMeasurementSummaries:attached.rawEvidence,boundedCoreProjection:attached.evidence,
      uniqueEvidenceIds:true,evidenceCharacters:attached.evidenceCharacters,maxEvidenceCharacters:attached.evidenceBudget,
      samples:100,noDeterministicRecommendations:true,evidenceInspectedBeforeBothReplies:calls.slice(1,3).every(call=>call.evidenceInspectedBeforeReply),
      contextualTurns:2,provider:providerLabel,protocolRevision:'2026-07-28',sourceUnchanged:true});
    assert.equal(await view.locator('.message.assistant').count(), 2);
    await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,
      `native-${process.env.PERFCHECKER_NATIVE_EXPECTED_VERSION}-${process.platform}-${vscode.version}-mcp-controlled-provider.png`)});
    await hold();
    await view.getByRole('tab', {name: '02 · Implementation', exact: true}).click();
    assert.match(await view.locator('.warning').innerText(), /Git checkpoint.*isolated copy.*diff review/);
    if(!stdio){
      await view.getByText('Configure the MCP implementation tool', {exact: true}).click();
      await view.getByRole('textbox', {name: 'Implementation tool name', exact: true}).fill(implementationTool);
      await view.getByRole('button', {name: 'Save implementation tool', exact: true}).click();
      await eventually(async () => /Implementation tool saved/.test((await state()).status), 'The native tool configuration is saved');
    }else{
      assert.deepEqual((await state()).implementation,{tool:implementationTool,promptArgument:implementationArgument,workspaceArgument,arguments:implementationAdditional});
    }
    // Snapshot immediately before the checkpoint, after measurement and native
    // editor activity; earlier stat-cache changes are not part of this action.
    const index = await fs.readFile(path.join(workspace, '.git', 'index'));
    log('native-ui-action',{surface:'MCP implementation',action:'Prepare implementation after review'});
    await view.getByRole('button', {name: 'I reviewed the advice · Prepare implementation', exact: true}).click();
    await eventually(async () => {const value = await state(); return !value.busy && value.proposal?.files.includes('src/PerfCheckerNativeFixture.jl');}, 'The real implementation worker returns its Git proposal', 240000);
    assert.equal(await fs.readFile(source, 'utf8'), original);
    assert.match((await state()).backupRef, /^refs\/perfchecker\/checkpoints\//);
    const proposedChanges=view.getByLabel('Proposed changes',{exact:true});
    assert((await proposedChanges.innerText()).includes('init=zero'),'The real proposed patch is populated before the review capture');
    await proposedChanges.scrollIntoViewIfNeeded();
    await eventually(async()=>proposedChanges.evaluate(element=>{const box=element.getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;}),'The actual proposed patch fits the native review viewport');
    await view.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,`native-${process.platform}-${vscode.version}-mcp-reviewed-proposal.png`)});await hold();
    log('native-ui-action',{surface:'MCP implementation',action:'Open full diff'});
    await view.getByRole('button', {name: 'Open full diff', exact: true}).click();
    await eventually(() => vscode.workspace.textDocuments.some(document => document.languageId === 'diff' && document.getText().includes('init=zero')), 'The actual diff editor opens');
    await hold();
    await vscode.commands.executeCommand('perfchecker.openChat'); view = await findFrame('#chat-root');
    log('native-ui-action',{surface:'MCP implementation',action:'Apply reviewed changes'});
    await view.getByRole('button', {name: 'Apply reviewed changes', exact: true}).click();
    await eventually(async () => !((await state()).busy) && (await fs.readFile(source, 'utf8')) === proposed, 'Apply changes the original only after the native user click');
    assert.equal(await probe(workspace), implementationBytes);
    log('native-mcp-applied-oracle',{allocationBytes:implementationBytes,baselineBytes,originalChangedAfterReview:true});await hold();
    log('native-ui-action',{surface:'MCP implementation',action:'Restore previous code'});
    await view.getByRole('button', {name: 'Restore previous code', exact: true}).click();
    await eventually(async () => !((await state()).busy) && (await fs.readFile(source, 'utf8')) === original, 'Restore returns the exact original bytes');
    assert.deepEqual(await fs.readFile(path.join(workspace, '.git', 'index')), index);
    assert.equal(await git('rev-parse', 'HEAD'), head);
    await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,`native-${process.platform}-${vscode.version}-mcp-exact-restore.png`)});await hold();
    proof('native-mcp-reviewed-apply-exact-restore',{provider:providerLabel,protocolRevision:'2026-07-28',checkpoint:true,diffEditor:true,apply:true,exactSourceIndexHead:true,
      allocationBaselineBytes:baselineBytes,allocationCandidateBytes:implementationBytes,indexSha256:hash(index)});
    if(custom)proof('native-mcp-custom-arguments',{adviceArgument,implementationArgument,workspaceArgument,additionalArgumentsVerified:true,
      actualHttpCalls:calls.length,measuredEvidenceIds:attached.evidence.map(row=>row.id),configurationRestoredInFinally:true});
    await view.getByRole('button', {name: 'Discard proposal', exact: true}).click();
    await eventually(async () => !(await state()).proposal, 'Discard closes the recovery proposal');
    await view.getByRole('tab', {name: '01 · Advice', exact: true}).click();
    await view.locator('#chat-question').fill('native cancellation probe');
    await view.getByRole('button', {name: 'Send question', exact: true}).click();
    await eventually(() => pending.size > 0, 'The actual MCP request reached the provider');
    const ownershipSnapshot=async()=>({pending:pending.size,uiBusy:(await state()).busy});
    const owned=stdio?await ownedStdioJuliaProcesses():await ownedChatProcesses(log,[...pendingSockets.values()],ownershipSnapshot,'before-folder-switch');
    assert(owned&&processAlive(owned.cli)&&processAlive(owned.worker),'The active native chat owns a real CLI and detached advisor worker');
    let stdioDescendant;
    if(stdio){
      stdioDescendant=await nativeIdentity(Number(await fs.readFile(path.join(activeStdio.root,'descendant.pid'),'utf8')),nativeNode);assert(stdioDescendant);
      activeStdio.observedDescendant=stdioDescendant;activeStdio.observedJulia=owned;
      assert.equal(stdioDescendant.parent,activeStdio.identity.pid);
      if(process.platform!=='win32')assert.equal(stdioDescendant.group,stdioDescendant.pid,'The real detached child has its independently owned process group');
      proof('native-mcp-stdio-active-cancel-identities',{server:activeStdio.identity,windowsJobOwner:activeStdio.windowsJobOwner,stdioDescendant,ownedJulia:owned,
        pendingRequestIds:(await stdioRecords(activeStdio)).filter(row=>row.method==='tools/call').map(row=>row.requestId),provider:providerLabel});
    }
    const callsBeforeSwitch=calls.length;
    const owningEvidence=(await state()).evidence;
    assert(vscode.workspace.workspaceFile,'This regression uses a saved disposable multi-root workspace');
    const alternate=path.join(path.dirname(workspace),'chat-alternate-workspace');
    await fs.mkdir(alternate,{recursive:true});await fs.writeFile(path.join(alternate,'Project.toml'),'name="AlternateChatFixture"\n');
    alternateFolder=vscode.Uri.file(alternate);
    assert(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length,0,{uri:alternateFolder,name:'Chat alternate folder'}));
    await eventually(()=>vscode.workspace.workspaceFolders.some(folder=>folder.uri.toString()===alternateFolder.toString()),
      'The real workspace has added the independent alternate folder');
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',alternateFolder);
    const alternateStudio=await findFrame('#studio-root');
    await eventually(async()=>await alternateStudio.locator('.workspace strong').innerText()==='Chat alternate folder',
      'Studio selects the second folder while the first chat request is still active');
    const owningChatTab=()=>context.windowPage.locator('.tabs-container .tab').filter({
      has:context.windowPage.locator('.label-name').filter({hasText:/^PerfChecker · Chat$/})}).filter({visible:true}).first();
    await owningChatTab().click();
    await eventually(async()=>await owningChatTab().getAttribute('aria-selected')==='true',
      'The exact owning Chat tab is active, rather than the alternate Studio with a similar title');
    view=await findFrame('#chat-root');
    const requestedOwner=vscode.Uri.file(workspace),owner=vscode.workspace.getWorkspaceFolder(requestedOwner);
    assert(owner,'The native workspace API resolves the actual owning chat folder');
    assert.equal(owner.uri.toString(),requestedOwner.toString(),'The native owning folder is the exact requested chat workspace');
    log('native-mcp-owning-workspace',{requestedPath:workspace,requestedUri:requestedOwner.toString(),ownerUri:owner.uri.toString(),ownerPath:owner.uri.fsPath,name:owner.name});
    assert.equal((await state()).workspace,owner.name,
      'The displayed chat still identifies its first folder while Studio selects another');
    assert.deepEqual((await state()).evidence,owningEvidence,'Publishing A retains A’s evidence inventory instead of reading the selected folder B');
    assert.equal((await state()).evidenceId,attached.id);
    assert.deepEqual(stdio?await ownedStdioJuliaProcesses():await ownedChatProcesses(log,[...pendingSockets.values()],ownershipSnapshot,'after-folder-switch'),owned,
      'The same physical CLI/worker still owns the original held request after selecting another folder');
    assert(processAlive(owned.cli)&&processAlive(owned.worker),'Selecting the alternate Studio preserves the original active request');
    assert.equal(calls.length,callsBeforeSwitch,'Selecting another Studio must not send another provider request');
    log('native-mcp-cancel-before',{...owned,foreign:foreign.pid,heldResponses:pending.size,uiBusy:(await state()).busy});
    const cancelUntil=Date.now()+60000;
    await view.getByRole('button', {name: 'Cancel request', exact: true}).click();
    await eventually(async () => {
      const idle=!(await state()).busy;
      const localGone=!stdio||await sameNativeIdentityGone(activeStdio.identity)&&await sameNativeIdentityGone(stdioDescendant)&&
        (!activeStdio.windowsJobOwner||await sameNativeIdentityGone(activeStdio.windowsJobOwner))&&!(await state()).connectionKind;
      const juliaGone=!stdio||await sameNativeIdentityGone(owned.cliIdentity)&&await sameNativeIdentityGone(owned.workerIdentity);
      const adapterGone=!stdio||await bridgeClosed(owned.bridgeTuple);
      return idle&&localGone&&juliaGone&&adapterGone&&Date.now()<cancelUntil;
    }, 'Cancel stops the real local Julia worker and captured stdio owner',Math.max(1,cancelUntil-Date.now()));
    await eventually(()=>pending.size===0,'The cancelled provider connection closes before the harness destroys any socket',15000);
    assert.equal((await state()).workspace,owner.name,'Connector cleanup preserves the owning conversation while the alternate Studio remains selected');
    assert.deepEqual((await state()).evidence,owningEvidence,'Connector cleanup preserves the owning conversation’s evidence');
    assert.equal((await state()).evidenceId,attached.id);
    assert.equal(await owningChatTab().count(),1,'The original owning Chat panel survives connector cleanup');
    assert.equal(processAlive(owned.cli),false,'The CLI is gone before harness teardown');
    assert.equal(processAlive(owned.worker),false,'The detached advisor worker is gone before harness teardown');
    assert(processAlive(foreign.pid),'Cancellation preserves an unrelated process');
    if(stdio)assert.deepEqual(await nativeIdentity(foreign.pid,nativeNode),foreignIdentity,'Cancel preserves the same unrelated process incarnation');
    if(stdio){
      const records=await stdioRecords(activeStdio),held=records.filter(row=>row.method==='tools/call').at(-1);
      assert(held&&records.some(row=>row.method==='notifications/cancelled'&&row.cancelledRequestId===held.requestId),
        'The server receives cancellation for the actual pending request before EOF');
      assert(records.some(row=>row.method==='stdin/eof'),'The server receives EOF during owned cleanup');
      proof('native-mcp-stdio-cancel-before-teardown',{version:activeStdio.version,records,server:activeStdio.identity,stdioDescendant,
        windowsJobOwner:activeStdio.windowsJobOwner,serverAndObservedDetachedChildAbsent:true,heldBackendSocketClosed:pending.size===0,
        foreignPreserved:true,ownedJulia:owned,adapterExactListenerAbsentAndTcpRefused:true,scope:'Real neutral stdio transport and controlled backend, not inference'});
    }
    proof('native-mcp-cancel-owned-processes',{...owned,foreignPreserved:true,heldResponseClosed:true,uiIdleAfterCleanup:true,
      observedBeforeHarnessCleanup:true,nativeOwningPanelCancelAfterAlternateStudioSelected:true,
      originalOwnedProcessesPreservedBeforeCancel:true,owningEvidenceInventoryPreserved:true,
      additionalProviderRequestsOnWorkspaceSwitch:calls.length-callsBeforeSwitch});
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(workspace));
    await owningChatTab().click();
    await eventually(async()=>await owningChatTab().getAttribute('aria-selected')==='true','The exact Chat tab is active after restoring Studio selection');
    view=await findFrame('#chat-root');
    assert.equal(await fs.readFile(source, 'utf8'), original);
    await view.getByRole('button', {name: 'New conversation', exact: true}).click();
    await eventually(async () => (await state()).messages.length === 0, 'The native clear command removes the conversation');
    proof('native-mcp-advice-implementation-restore', {provider: providerLabel,protocolRevision:'2026-07-28',
      adviceTurns: 2, checkpoint: true, diffEditor: true, apply: true, exactRestore: true, cancellation: true,
      allocationBaselineBytes: baselineBytes, allocationCandidateBytes: implementationBytes});
    if(custom){assert(calls.some(call=>call.name===adviceTool&&call.promptArgument===adviceArgument));
      assert(calls.some(call=>call.name===implementationTool&&call.promptArgument===implementationArgument&&call.workspaceArgument===workspaceArgument));
      proof('native-mcp-custom-arguments',{adviceArgument,implementationArgument,workspaceArgument,additionalArgumentsVerified:true,
        actualHttpCalls:calls.length,measuredEvidenceIds:attached.evidence.map(row=>row.id),configurationRestoredInFinally:true});}
    if(stdio){
      assert.deepEqual(await readSavedConfiguration(),savedConfig);
      view=await connectStdio('2026-07-28');const disconnected=activeStdio;
      const disconnectUntil=Date.now()+60000;
      await view.getByRole('button',{name:'Disconnect local MCP server',exact:true}).click();
      await eventually(async()=>await sameNativeIdentityGone(disconnected.identity)&&
        (!disconnected.windowsJobOwner||await sameNativeIdentityGone(disconnected.windowsJobOwner))&&!(await state()).connectionKind&&Date.now()<disconnectUntil,
      'Native Disconnect closes the explicit modern server and restores its saved provider',Math.max(1,disconnectUntil-Date.now()));
      assert.deepEqual(await readSavedConfiguration(),savedConfig);
      proof('native-mcp-stdio-modern-disconnect',{server:disconnected.identity,windowsJobOwner:disconnected.windowsJobOwner,
        actualNativeClick:true,ownedServerAbsentBeforeTeardown:true,savedProviderBytesPreserved:true,provider:providerLabel});
      view=await connectStdio('2026-07-28');
      assert((await vscode.commands.getCommands(true)).includes('workbench.action.reloadWindow'));
      assert.deepEqual(await readSavedConfiguration(),savedConfig);
      for(const connection of stdioConnections.filter(connection=>connection!==activeStdio))assert(await sameNativeIdentityGone(connection.identity));
      // All preceding fixture requests/foreign process end before Reload; only
      // the newly connected server is left for product deactivation to reclaim.
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      assert.deepEqual(await nativeIdentity(foreign.pid,nativeNode),foreignIdentity);foreign.kill();await foreignFinished;
      assert(await sameNativeIdentityGone(foreignIdentity));
      // Restore the original resource settings while the first host still owns
      // their values. The handoff carries hashes only, never arbitrary settings
      // (which could contain provider endpoints, instructions or token names).
      for(const [key,value] of Object.entries(previous))await settings().update(key,value,vscode.ConfigurationTarget.WorkspaceFolder);
      assert.deepEqual(await nativeIdentity(activeStdio.identity.pid,nativeNode),activeStdio.identity,'Restoring saved settings keeps the connected server alive');
      if(activeStdio.windowsJobOwner)assert.deepEqual(await nativeIdentity(activeStdio.windowsJobOwner.pid,activeStdio.windowsJobOwner.executable),activeStdio.windowsJobOwner);
      const files={};
      for(const file of [source,path.join(workspace,'.git','index'),path.join(workspace,'.vscode','settings.json'),
        ...[controllerProject,measurementProject].flatMap(root=>['Project.toml','Manifest.toml'].map(name=>path.join(root,name))),attached.file,attached.adviceFile])
        files[file]=hash(await fs.readFile(file));
      proof('native-mcp-stdio-before-official-reload',{server:activeStdio.identity,windowsJobOwner:activeStdio.windowsJobOwner,
        independentAdviceAndImplementationTools:true,savedProviderPreserved:true,foreignFixtureEndedAfterPreservationProof:true,
        timeoutSeconds:values.advisorTimeout,sourceAndProjects:files,provider:providerLabel});
      await context.flushReport();
      const report=await fs.readFile(path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,'mcp-stdio.json'));
      assert.deepEqual(await nativeIdentity(activeStdio.identity.pid,nativeNode),activeStdio.identity,'The identical connected server is alive immediately before official Reload');
      if(activeStdio.windowsJobOwner)assert.deepEqual(await nativeIdentity(activeStdio.windowsJobOwner.pid,activeStdio.windowsJobOwner.executable),activeStdio.windowsJobOwner);
      const handoff={status:'awaiting-reload',invocation:process.env.PERFCHECKER_NATIVE_INVOCATION,vsixSha256:process.env.PERFCHECKER_NATIVE_SHA,
        workspace,oldHostPid:process.pid,core:context.core,connection:{root:activeStdio.root,identity:activeStdio.identity,
          ...(activeStdio.windowsJobOwner?{windowsJobOwner:activeStdio.windowsJobOwner}:{}),command:activeStdio.command,version:activeStdio.version},files,head,
        beforeReportSha256:hash(report),qualifierSourceSha256:hash(await fs.readFile(__filename)),reloadRequestedAt:new Date().toISOString(),savedMeasurement:{file:attached.file,adviceFile:attached.adviceFile}};
      await fs.writeFile(stdioHandoffFile(),JSON.stringify(handoff,null,2));
      reloading=true;
      let reloadWatchdog;
      try{
        const watchdog=new Promise((resolve,reject)=>{reloadWatchdog=setTimeout(()=>reject(new Error('The official Reload Window did not restart the extension host within 30 seconds')),30000);});
        const command=Promise.resolve(vscode.commands.executeCommand('workbench.action.reloadWindow')).catch(error=>{
          // This RPC can lose its channel during the actual host shutdown.
          // Only this command's observed Canceled leaves the handoff intact.
          if(error?.name!=='Canceled')throw error;
        });
        // Neither resolution nor channel cancellation proves a restart. Keep
        // the watchdog active even if the command never settles: only this
        // host's termination permits the new host's independent cleanup oracle.
        await Promise.race([watchdog,command.then(()=>new Promise(()=>{}))]);
      }catch(error){
        // Every other command error and a surviving old host fail normally.
        reloading=false;handoff.status='reload-failed';handoff.failureClass=error.name;
        await fs.writeFile(stdioHandoffFile(),JSON.stringify(handoff,null,2));throw error;
      }finally{clearTimeout(reloadWatchdog);}
    }
  } catch(error){primaryError=error;throw error;}
  finally {
    if(stdio&&!reloading){
      const errors=[],observations=[];
      const cleanup=async(stage,action)=>{try{await action();}catch(error){errors.push(error);observations.push({stage,errorClass:error.name,code:error.code});}};
      // Attempt every owned cleanup even when an earlier one fails; retain the
      // original assertion alongside cleanup errors and preserve an unknown tree.
      await cleanup('cancel-owned-chat',()=>vscode.commands.executeCommand('perfchecker.chatCancel'));
      await cleanup('cancel-owned-stdio',()=>vscode.commands.executeCommand('perfchecker.cancelMcpStdio',uri.toString()));
      for(const connection of stdioConnections)await cleanup('observe-owned-stdio',async()=>{
        assert(await sameNativeIdentityGone(connection.identity));
        if(connection.windowsJobOwner)assert(await sameNativeIdentityGone(connection.windowsJobOwner));
        if(connection.observedDescendant)assert(await sameNativeIdentityGone(connection.observedDescendant));
        if(connection.observedJulia)for(const identity of [connection.observedJulia.cliIdentity,connection.observedJulia.workerIdentity])assert(await sameNativeIdentityGone(identity));
        observations.push({stage:'observe-owned-stdio',version:connection.version,server:connection.identity,
          ...(connection.windowsJobOwner?{windowsJobOwner:connection.windowsJobOwner}:{}),
          ...(connection.observedDescendant?{descendant:connection.observedDescendant}:{}),
          ...(connection.observedJulia?{juliaClient:connection.observedJulia.cliIdentity,juliaWorker:connection.observedJulia.workerIdentity}:{}),
          allListedIdentitiesAbsent:true,observedAt:new Date().toISOString()});
        log('native-mcp-stdio-final-ledger',{version:connection.version,records:await stdioRecords(connection)});
      });
      for(const response of pending)response.destroy();
      await cleanup('close-controlled-provider',async()=>{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));});
      await cleanup('restore-resource-settings',async()=>{for(const [key,value]of Object.entries(previous))await settings().update(key,value,vscode.ConfigurationTarget.WorkspaceFolder);});
      await cleanup('end-owned-foreign-fixture',async()=>{
        if(foreign.exitCode===null&&foreign.signalCode===null){assert.deepEqual(await nativeIdentity(foreign.pid,nativeNode),foreignIdentity);foreign.kill();}
        await foreignFinished;assert(await sameNativeIdentityGone(foreignIdentity));
      });
      if(alternateFolder)await cleanup('remove-owned-alternate-folder',async()=>{
        await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(workspace));
        const index=vscode.workspace.workspaceFolders.findIndex(folder=>folder.uri.toString()===alternateFolder.toString());
        if(index>=0)assert(vscode.workspace.updateWorkspaceFolders(index,1));
      });
      await fs.writeFile(path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,'mcp-stdio-cleanup.json'),JSON.stringify({
        invocation:process.env.PERFCHECKER_NATIVE_INVOCATION,session:process.env.PERFCHECKER_NATIVE_SESSION,
        qualified:errors.length===0,observedAt:new Date().toISOString(),observations},null,2));
      if(errors.length)throw new AggregateError(primaryError?[primaryError,...errors]:errors,'Native stdio assertion or owned cleanup failed');
    }else if(!stdio){
    if(alternateFolder){
      await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.Uri.file(workspace));
      const index=vscode.workspace.workspaceFolders.findIndex(folder=>folder.uri.toString()===alternateFolder.toString());
      if(index>=0)assert(vscode.workspace.updateWorkspaceFolders(index,1));
    }
    for (const response of pending) response.destroy();
    if(!reloading){
      server.closeAllConnections();if(server.listening)await new Promise(resolve => server.close(resolve));
      for (const [key, value] of Object.entries(previous)) await settings().update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
      if(foreign.exitCode===null&&foreign.signalCode===null){foreign.kill();}await foreignFinished;
    }
    }
  }
};
if(require.main===module){
  assert.equal(process.argv[2],'--neutral-stdio');
  void neutralStdioServer().catch(()=>{process.stderr.write('Neutral stdio fixture startup failed.\n');process.exitCode=1;});
}
