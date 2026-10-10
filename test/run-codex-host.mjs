// Local opt-in only: authenticated CLI stays on this machine; no account files are read.
// Launch this Node itself with taskset -c 16,17 BEFORE it creates any threads.
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const client=path.dirname(path.dirname(fileURLToPath(import.meta.url))),rawExecute=promisify(execFile);
const preparationAbort=new AbortController();
const execute=(command,args,options={})=>rawExecute(command,args,{timeout:60000,...options,signal:preparationAbort.signal});
const vsixSha='a7494937bd14f94b9bc403320ff5d02b09dde76ec6c8b3284f9ce80b63739b7d';
const coreTree='9abef061386c97c97bf136b9e4747673fe690b01';
const coreCommit='9942c4e1fb9dc02a66a03f629b40efdf9c6bdc33';
const bibliography=process.env.PERFCHECKER_TEST_BIBLIOGRAPHY;
const capturePreflightOnly=process.env.PERFCHECKER_TEST_CAPTURE_PREFLIGHT_ONLY==='1';
const dialogueCancelOnly=process.env.PERFCHECKER_TEST_DIALOGUE_CANCEL_ONLY==='1';
const liveCancelOnly=process.env.PERFCHECKER_TEST_LIVE_CANCEL_ONLY==='1';
if(capturePreflightOnly)assert(bibliography,'The capture-only preflight uses the explicit private Bibliography fixture');
if(dialogueCancelOnly)assert(bibliography&&!capturePreflightOnly,'Dialogue/Cancel is a distinct explicit Bibliography qualification');
if(liveCancelOnly)assert(dialogueCancelOnly,'Live Cancel alone requires the explicit complementary mode');
// This explicit real-package demo includes a cold isolated Julia environment.
// Forced timeout/cancellation fixtures retain their separate 180 second budget.
const advisorTimeout=bibliography?600:180;
if(process.env.CI)throw new Error('Authenticated Codex qualification is local-only. Never transfer authentication to CI.');
if(process.platform!=='linux')throw new Error('This isolated display qualification currently requires Linux and a private Xvfb.');
for(const name of ['PERFCHECKER_TEST_CONTROLLER','PERFCHECKER_TEST_CODEX','PERFCHECKER_TEST_JULIA','PERFCHECKER_TEST_VSIX'])
  if(!process.env[name]||!path.isAbsolute(process.env[name]))throw new Error(`Provide an absolute ${name} path.`);
const archive=await fs.realpath(process.env.PERFCHECKER_TEST_VSIX);
assert.equal(createHash('sha256').update(await fs.readFile(archive)).digest('hex'),vsixSha,'Use the approved VSIX bytes, not a development build');
assert.equal((await fs.stat(archive)).size,1077372);
if(bibliography){
  assert(path.isAbsolute(bibliography),'Provide an absolute private Bibliography pilot path');
  assert(!process.env.WAYLAND_DISPLAY,'Remove WAYLAND_DISPLAY before launching this private X11 test');
  assert.match(await fs.readFile('/proc/self/status','utf8'),/^Cpus_allowed_list:\s*16-17\s*$/m,'The real-package driver must inherit the approved two-CPU pool');
  Object.assign(process.env,{JULIA_NUM_THREADS:'2',JULIA_NUM_PRECOMPILE_TASKS:'1',JULIA_NUM_GC_THREADS:'1',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'});
  assert(process.env.PERFCHECKER_TEST_RESULTS&&path.isAbsolute(process.env.PERFCHECKER_TEST_RESULTS),'Provide an explicit absolute proof destination for the Bibliography qualification');
}
process.env.PERFCHECKER_CODEX_HOST_ONLY='1';
const {prepareJuliaCodexFixture,prepareBibliographyCodexFixture,stopObservedCodexProcesses,ownedProcessState,observePrivateProcess}=await import('./codex-real.test.mjs');
const sdk=await import(process.env.PERFCHECKER_TEST_ELECTRON?pathToFileURL(process.env.PERFCHECKER_TEST_ELECTRON).href:'@vscode/test-electron');
const session=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-codex-host-'));
let displayChild,displayExit,sessionMayRemove=true,expired=false,forceDeadline,sdkRunning=false;
let affinityTimer,affinityPending,affinityError;
const affinityProcesses=new Map(),affinityReceipt={cpus:'16-17',source:'read-only /proc PID/start, all observed TID children and per-TID status',
  observations:0,processes:[],errors:[],neverObservedDescendants:'Not established by a sampling observer'};
const gone=error=>['ENOENT','ESRCH'].includes(error.code);
const processBirth=ownedProcessState;
const inspectAffinity=async()=>{
  if(affinityPending)return affinityPending;
  affinityPending=(async()=>{
    const queue=affinityProcesses.size?[...affinityProcesses.values()]:[{pid:process.pid}],seen=new Set();
    while(queue.length){
      const prior=queue.shift(),identity=await observePrivateProcess(prior.pid,{
        known:affinityProcesses.get(`${prior.pid}:${prior.start}`),parent:prior.observedParent});
      if(!identity||prior.start&&identity.start!==prior.start)continue;
      const key=`${identity.pid}:${identity.start}`;if(seen.has(key))continue;seen.add(key);
      assert(affinityProcesses.size<10000||affinityProcesses.has(key),'Affinity observation identity budget exceeded');
      const known=affinityProcesses.get(key),record={...known,...identity,firstObservedAt:known?.firstObservedAt??new Date().toISOString(),
        threads:{...known?.threads}},next=[];
      if(!identity.executable)delete record.executable;
      // Persist even an unknown image before inspecting its TIDs. This map
      // records observations only and never grants permission to send signals.
      affinityProcesses.set(key,record);
      let tids;try{tids=await fs.readdir(`/proc/${identity.pid}/task`);}catch(error){if(gone(error))continue;throw error;}
      for(const tid of tids){
        assert(/^\d+$/.test(tid));const directory=`/proc/${identity.pid}/task/${tid}`;
        try{
          const before=await fs.readFile(path.join(directory,'stat'),'utf8'),start=before.slice(before.lastIndexOf(') ')+2).trim().split(/\s+/)[19];
          const status=await fs.readFile(path.join(directory,'status'),'utf8'),cpus=/^Cpus_allowed_list:\s*(.+)$/m.exec(status)?.[1].trim();
          const children=await fs.readFile(path.join(directory,'children'),'utf8');
          const after=await fs.readFile(path.join(directory,'stat'),'utf8');
          if(after.slice(after.lastIndexOf(') ')+2).trim().split(/\s+/)[19]!==start)continue;
          assert(/^\d+$/.test(start));
          if(cpus!=='16-17'){
            // Preserve the offending observation before the assertion aborts this
            // scan. This metadata never grants permission to signal a process.
            const violation={at:new Date().toISOString(),pid:identity.pid,start:identity.start,parent:identity.parent,
              executableObservation:identity.executableObservation,group:identity.group,session:identity.session,tid:Number(tid),tidStart:start,cpus};
            try{violation.cgroup=await fs.readFile(path.join(directory,'cgroup'),'utf8');}
            catch(error){violation.cgroupUnavailable=String(error.code??error.name);}
            affinityReceipt.violation=violation;
            record.threads[`${tid}:${start}`]={tid:Number(tid),start,cpus};record.lastObservedAt=violation.at;
            affinityProcesses.set(key,record);
            await fs.writeFile(path.join(session,'affinity-observed.json'),JSON.stringify({processes:[...affinityProcesses.values()],violation}));
          }
          assert.equal(cpus,'16-17',`Private PID ${identity.pid} TID ${tid} left the approved CPU pool`);
          record.threads[`${tid}:${start}`]={tid:Number(tid),start,cpus};
          for(const child of children.trim().split(/\s+/).filter(Boolean)){
            assert(/^\d+$/.test(child));const current=await processBirth(Number(child));
            if(current?.parent===identity.pid)next.push({...current,observedParent:identity});
          }
        }catch(error){if(!gone(error))throw error;}
      }
      const after=await observePrivateProcess(identity.pid,{known:record});
      if(!after||after.start!==identity.start)continue;
      Object.assign(record,after);if(!after.executable)delete record.executable;
      record.lastObservedAt=new Date().toISOString();affinityProcesses.set(key,record);queue.push(...next);
    }
    affinityReceipt.observations++;
    await fs.writeFile(path.join(session,'affinity-observed.json'),JSON.stringify({processes:[...affinityProcesses.values()],violation:affinityReceipt.violation}));
  })();
  try{return await affinityPending;}finally{affinityPending=undefined;}
};
// Before runTests the SDK has no SIGINT handler. Abort only directly launched
// preparation children; this never proves that their descendants are extinct.
// Once active, the SDK stops only its own private VS Code tree.
const onDriverInterrupt=()=>{
  expired=true;sessionMayRemove=false;
  if(sdkRunning)forceDeadline??=setTimeout(()=>process.emit('SIGINT'),45000);
  else preparationAbort.abort(new Error('Private preparation interrupted'));
};
// Retain our listener until finally: otherwise the SDK exits the entire driver
// after SIGINT, before it can persist proof or clean its own display.
process.on('SIGINT',onDriverInterrupt);
const requestStop=reason=>{
  expired=true;sessionMayRemove=false;
  if(sdkRunning)process.emit('SIGINT');else preparationAbort.abort(reason);
};
const checkPreparation=()=>{preparationAbort.signal.throwIfAborted();assert(!expired,'The local runner exceeded its total deadline before launch');};
const deadline=setTimeout(()=>requestStop(new Error('The local runner exceeded its total deadline')),(capturePreflightOnly?5:dialogueCancelOnly?14:bibliography?25:18)*60*1000);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  if(bibliography){
    await inspectAffinity();
    affinityTimer=setInterval(()=>{void inspectAffinity().catch(error=>{
      if(affinityError)return;affinityError=error;affinityReceipt.errors.push({at:new Date().toISOString(),message:String(error)});
      affinityReceipt.stopPhase=sdkRunning?'private-sdk-host':'pre-host-preparation';
      affinityReceipt.descendantExtinction='Not established by aborting an execFile leader';
      requestStop(error);
    });},1000);
  }
  const root=path.join(session,'workspace'),profile=path.join(session,'profile'),extensions=path.join(session,'extensions');
  if(bibliography){
    const revision='2e86892401536ca4cfd20eb45c00e98168b482a3',tree='877ce28d85f3ac37d43f8e19a41b25a3f262c04c';
    const gitEnv={...process.env,GIT_NO_LAZY_FETCH:'1'};
    assert.equal((await execute('git',['rev-parse','HEAD'],{cwd:bibliography,env:gitEnv})).stdout.trim(),revision,'Use the reviewed private pilot revision');
    await execute('git',['diff','--exit-code','HEAD'],{cwd:bibliography,env:gitEnv});
    // The pilot is a worktree of a partial clone. A local object-directory copy
    // loses its promisor configuration and leaves historical blobs missing.
    await execute('git',['clone','--quiet','--no-checkout','https://github.com/JuliaBibliographies/Bibliography.jl.git',root],{env:gitEnv});
    await execute('git',['fetch','--quiet','--no-tags',await fs.realpath(bibliography),revision],{cwd:root,env:gitEnv});
    await execute('git',['checkout','--quiet','--detach',revision],{cwd:root,env:gitEnv});
    assert.equal((await execute('git',['rev-parse','HEAD'],{cwd:root,env:gitEnv})).stdout.trim(),revision);
    assert.equal((await execute('git',['rev-parse','HEAD^{tree}'],{cwd:root,env:gitEnv})).stdout.trim(),tree);
    await execute('git',['fsck','--full','--no-dangling'],{cwd:root,env:gitEnv,maxBuffer:2000000});
    await execute('git',['remote','remove','origin'],{cwd:root});
    for(const file of ['correctness.jl','timing/scenarios.toml','allocation/scenarios.toml','worker/Project.toml']){
      const target=path.join(root,'perf','episode-05a',file);await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.copyFile(path.join(bibliography,'perf','episode-05a',file),target);
    }
  }
  await fs.mkdir(path.join(root,'.vscode'),{recursive:true});await fs.mkdir(path.join(root,'perf'),{recursive:true});
  await fs.writeFile(path.join(root,'.perfchecker-test-fixture'),'sacrificial\n');
  await fs.writeFile(path.join(root,'perf','advisor.json'),JSON.stringify({protocol:'mcp_http',endpoint:'https://previous.example.invalid/mcp',mcp_tool:'previous_advice'}));
  await fs.writeFile(path.join(root,'.vscode','settings.json'),JSON.stringify({
    'perfchecker.runnerProject':process.env.PERFCHECKER_TEST_CONTROLLER,'perfchecker.scenarioProject':bibliography?'perf/episode-05a/worker':process.env.PERFCHECKER_TEST_CONTROLLER,
    'perfchecker.juliaExecutable':process.env.PERFCHECKER_TEST_JULIA,'perfchecker.codexExecutable':process.env.PERFCHECKER_TEST_CODEX,
    'perfchecker.advisorConfig':'perf/advisor.json','perfchecker.advisorEnabled':false,'perfchecker.advisorImplementationMcpTool':'previous_agent','perfchecker.advisorTimeout':advisorTimeout,
    ...(bibliography?{'perfchecker.scenarioCatalog':'perf/episode-05a/timing/scenarios.toml','perfchecker.scenarioSamples':100,
      'perfchecker.scenarioThreads':2,'perfchecker.analysisTimeout':120,'window.zoomLevel':2.75}:{}),
    'telemetry.telemetryLevel':'off','workbench.startupEditor':'none','window.restoreWindows':'none'}));
  checkPreparation();
  const fixture=capturePreflightOnly?{probe:{mode:'capture-only',oracleExecuted:false}}:
    await (bibliography?prepareBibliographyCodexFixture:prepareJuliaCodexFixture)(root,
      {julia:process.env.PERFCHECKER_TEST_JULIA,project:process.env.PERFCHECKER_TEST_CONTROLLER,coreVersion:'1.1.0',coreTree,coreCommit,signal:preparationAbort.signal,dialogueCancelOnly});
  if(affinityError)throw affinityError;checkPreparation();
  await execute('unzip',['-q',archive,'-d',path.join(session,'archive')]);
  const archiveExtension=path.join(session,'archive','extension');
  assert.equal(JSON.parse(await fs.readFile(path.join(archiveExtension,'package.json'),'utf8')).version,'1.0.2');
  // -displayfd asks Xvfb to reserve its own free display. Never attach to the user's DISPLAY.
  checkPreparation();displayChild=spawn(process.env.PERFCHECKER_TEST_XVFB||'Xvfb',
    ['-displayfd','3','-screen','0','1920x1080x24','-nolisten','tcp','-ac'],{stdio:['ignore','ignore','pipe','pipe']});
  displayExit=new Promise(resolve=>displayChild.once('exit',resolve));
  const display=await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(new Error('Private Xvfb did not become ready.')),15000);
    const finish=(error,value)=>{clearTimeout(timer);error?reject(error):resolve(value);};
    displayChild.once('error',error=>finish(error));
    displayChild.once('exit',()=>finish(new Error('Private Xvfb exited before VS Code started.')));
    displayChild.stdio[3].on('data',chunk=>{output+=chunk;const match=output.match(/^(\d+)\s*$/);if(match)finish(undefined,`:${match[1]}`);});
    displayChild.stderr.resume();
  });
  const privateEnv={...process.env,DISPLAY:display,XAUTHORITY:'',XDG_SESSION_TYPE:'x11'};delete privateEnv.WAYLAND_DISPLAY;
  checkPreparation();
  const vscodeExecutablePath=await sdk.downloadAndUnzipVSCode({version:'1.141.0',cachePath:path.join(session,'vscode'),timeout:30000});
  checkPreparation();assert(vscodeExecutablePath.startsWith(session+path.sep),'Use only the temporary VS Code download');
  const application=path.join(path.dirname(vscodeExecutablePath),'resources','app');
  assert.equal(JSON.parse(await fs.readFile(path.join(application,'package.json'),'utf8')).version,'1.141.0');
  const cliSource=await fs.readFile(path.join(application,'out','cli.js'),'utf8');
  const privateDirectoryFlags=['shared-data-dir','agent-plugins-dir','agents-user-data-dir','agents-extensions-dir'];
  for(const flag of ['user-data-dir','extensions-dir',...privateDirectoryFlags])
    assert(cliSource.includes(`"${flag}":`),`The actual host CLI must support ${flag}`);
  const privateDirectories=privateDirectoryFlags.map(flag=>[flag,path.join(profile,flag)]);
  const directories=[['user-data-dir',profile],['extensions-dir',extensions],...privateDirectories];
  for(const entry of directories){await fs.mkdir(entry[1],{recursive:true});entry[1]=await fs.realpath(entry[1]);
    assert(entry[1].startsWith(await fs.realpath(session)+path.sep),'Every Code directory is inside the private session');}
  assert.equal(new Set(directories.map(([,directory])=>directory)).size,6,'Use six distinct canonical private Code directories');
  const privateProfile=directories.map(([flag,directory])=>`--${flag}=${directory}`);
  const [cli,...cliArgs]=sdk.resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  await execute(cli,[...cliArgs,'--ozone-platform=x11',...privateProfile,'--install-extension',archive],{env:privateEnv,timeout:120000});
  const portServer=createServer();await new Promise((resolve,reject)=>{portServer.once('error',reject);portServer.listen(0,'127.0.0.1',resolve);});
  const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
  // VS Code requires a development location to execute its test runner. This
  // neutral manifest supplies it without loading any development product code.
  const driver=path.join(session,'driver');await fs.mkdir(driver);
  await fs.writeFile(path.join(driver,'package.json'),JSON.stringify({name:'perfchecker-local-authentication-driver',publisher:'qualification',version:'0.0.0',engines:{vscode:'^1.96.0'}}));
  checkPreparation();sdkRunning=true;
  try{await sdk.runTests({vscodeExecutablePath,extensionDevelopmentPath:driver,extensionTestsPath:path.join(client,'test','codex-vscode-host.cjs'),
    launchArgs:[root,'--new-window','--ozone-platform=x11','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-gpu',
      ...privateProfile,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],
    extensionTestsEnv:{DISPLAY:display,XAUTHORITY:'',XDG_SESSION_TYPE:'x11',PERFCHECKER_HOST_RESULT:path.join(session,'result.json'),
      PERFCHECKER_HOST_SESSION:session,PERFCHECKER_HOST_ARCHIVE:archive,PERFCHECKER_HOST_ARCHIVE_EXTENSION:archiveExtension,
      PERFCHECKER_HOST_VSIX_SHA:vsixSha,PERFCHECKER_HOST_CDP_PORT:String(port),PERFCHECKER_CODEX_HOST_ONLY:'1',
      ...(!capturePreflightOnly?{PERFCHECKER_HOST_BASELINE_BYTES:String(fixture.baselineBytes),PERFCHECKER_HOST_CORE:JSON.stringify(fixture.core)}:{}),
      PERFCHECKER_HOST_PRIVATE_DIRECTORIES:JSON.stringify(directories),PERFCHECKER_HOST_ADVISOR_TIMEOUT:String(advisorTimeout),
      ...(capturePreflightOnly?{PERFCHECKER_HOST_CAPTURE_PREFLIGHT_ONLY:'1'}:{}),
      ...(dialogueCancelOnly?{PERFCHECKER_HOST_DIALOGUE_CANCEL_ONLY:'1'}:{}),
      ...(liveCancelOnly?{PERFCHECKER_HOST_LIVE_CANCEL_ONLY:'1'}:{}),
      ...(bibliography?{PERFCHECKER_HOST_BIBLIOGRAPHY:JSON.stringify(fixture.probe)}:{}),
      ...(process.env.PERFCHECKER_TEST_RESULTS?{PERFCHECKER_HOST_PROOFS:process.env.PERFCHECKER_TEST_RESULTS}:{}),
      JULIA_NUM_THREADS:bibliography?'2':'1',JULIA_NUM_PRECOMPILE_TASKS:'1',JULIA_NUM_GC_THREADS:'1',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}});}
  finally{sdkRunning=false;}
  const result=JSON.parse(await fs.readFile(path.join(session,'result.json'),'utf8'));
  if(affinityError)throw affinityError;
  assert(!expired,'The local runner exceeded its total deadline');
  assert.equal(result.runner,'codex-vscode-host.cjs');assert.equal(result.hostExecuted,true);
  assert.equal(result.cleanupSafeToRemove,true);
  if(capturePreflightOnly)assert.equal(result.mode,'landscape-capture-preflight-only');
  assert.equal(result.vsixSha256,vsixSha);assert.equal(result.status,'passed');console.log(JSON.stringify(result));
}catch(error){
  const primary=affinityError??error;
  if(bibliography)affinityReceipt.failure={name:primary.name,message:String(primary.message),sessionPreserved:!sessionMayRemove};
  // Preserve the host's primary outcome in stdout before its required temporary
  // result/profile files are removed. No credential or environment dump is made.
  const result=await fs.readFile(path.join(session,'result.json'),'utf8').catch(value=>{if(value.code==='ENOENT')return undefined;throw value;});
  if(result){
    const outcome=JSON.parse(result);console.log(result);
    try{
      await stopObservedCodexProcesses(outcome.observedProcesses||[]);
      for(const record of outcome.observedProcesses||[])assert.notEqual((await ownedProcessState(record.pid))?.start,record.start);
      sessionMayRemove&&=outcome.cleanupSafeToRemove!==false;
    }catch(cleanupError){sessionMayRemove=false;console.error(`Owned failure cleanup failed: ${cleanupError}`);}
  }
  throw primary;
}finally{
  clearInterval(affinityTimer);await affinityPending?.catch(()=>{});
  clearTimeout(deadline);clearTimeout(forceDeadline);process.removeListener('SIGINT',onDriverInterrupt);
  try{
    if(process.env.PERFCHECKER_TEST_RESULTS){
      await fs.mkdir(process.env.PERFCHECKER_TEST_RESULTS,{recursive:true});
      await fs.copyFile(path.join(session,'result.json'),path.join(process.env.PERFCHECKER_TEST_RESULTS,'result.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
      if(bibliography){affinityReceipt.processes=[...affinityProcesses.values()];
        await fs.writeFile(path.join(process.env.PERFCHECKER_TEST_RESULTS,'cpu-affinity.json'),JSON.stringify(affinityReceipt,null,2));}
    }
  }finally{
    if(displayChild?.pid&&displayChild.exitCode===null&&displayChild.signalCode===null){
      displayChild.kill('SIGTERM');await Promise.race([displayExit,delay(2000)]);
      if(displayChild.exitCode===null&&displayChild.signalCode===null){displayChild.kill('SIGKILL');await displayExit;}
    }
    if(bibliography){
      let living=[];const cleanupEnd=Date.now()+60000;
      do{
        living=[];
        for(const record of affinityProcesses.values())if(record.pid!==process.pid&&(await processBirth(record.pid))?.start===record.start)
          living.push({pid:record.pid,start:record.start,executableObservation:record.executableObservation});
        if(!living.length||Date.now()>=cleanupEnd)break;
        await delay(100);
      }while(true);
      affinityReceipt.afterSdkAndDisplayCleanup={at:new Date().toISOString(),observedLiving:living,
        neverObservedDescendants:'Not established by a sampling observer'};
      if(process.env.PERFCHECKER_TEST_RESULTS)await fs.writeFile(path.join(process.env.PERFCHECKER_TEST_RESULTS,'cpu-affinity.json'),JSON.stringify(affinityReceipt,null,2));
      const outcome=await fs.readFile(path.join(session,'result.json'),'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;});
      if(outcome){const result=JSON.parse(outcome);result.driverCleanup=affinityReceipt.afterSdkAndDisplayCleanup;
        if(living.length)Object.assign(result,{status:'failed',cleanupSafeToRemove:false,cleanupError:'Observed private descendants remain alive after SDK/display cleanup'});
        await fs.writeFile(path.join(session,'result.json'),JSON.stringify(result,null,2));
        if(process.env.PERFCHECKER_TEST_RESULTS)await fs.copyFile(path.join(session,'result.json'),path.join(process.env.PERFCHECKER_TEST_RESULTS,'result.json'));}
      if(living.length){sessionMayRemove=false;console.error(`Private session retained: ${session}`);
        throw new Error('Observed private descendants remain alive; preserve the session instead of claiming extinction');}
    }
    if(sessionMayRemove)await fs.rm(session,{recursive:true,force:true});
    else console.error(`Failed session preserved while process cleanup is unresolved: ${session}`);
  }
}
