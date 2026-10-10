// Local opt-in only: authenticated CLI stays on this machine; no account files are read.
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const client=path.dirname(path.dirname(fileURLToPath(import.meta.url))),execute=promisify(execFile);
const vsixSha='1af8108bfe2c491684da2435e4b9bc5430b33e8f8a6d8f02699790074d249de4';
const coreTree='920bd59cee056970d2c2ab03ef0d9103e071c536';
const bibliography=process.env.PERFCHECKER_TEST_BIBLIOGRAPHY;
if(process.env.CI)throw new Error('Authenticated Codex qualification is local-only. Never transfer authentication to CI.');
if(process.platform!=='linux')throw new Error('This isolated display qualification currently requires Linux and a private Xvfb.');
for(const name of ['PERFCHECKER_TEST_CONTROLLER','PERFCHECKER_TEST_CODEX','PERFCHECKER_TEST_JULIA','PERFCHECKER_TEST_VSIX'])
  if(!process.env[name]||!path.isAbsolute(process.env[name]))throw new Error(`Provide an absolute ${name} path.`);
const archive=await fs.realpath(process.env.PERFCHECKER_TEST_VSIX);
assert.equal(createHash('sha256').update(await fs.readFile(archive)).digest('hex'),vsixSha,'Use the approved VSIX bytes, not a development build');
assert.equal((await fs.stat(archive)).size,1068437);
if(bibliography){
  assert(path.isAbsolute(bibliography),'Provide an absolute private Bibliography pilot path');
  assert.match(await fs.readFile('/proc/self/status','utf8'),/^Cpus_allowed_list:\s*16-17\s*$/m,'The real-package driver must inherit the approved two-CPU pool');
  Object.assign(process.env,{JULIA_NUM_THREADS:'2',JULIA_NUM_PRECOMPILE_TASKS:'1',JULIA_NUM_GC_THREADS:'1',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'});
  assert(process.env.PERFCHECKER_TEST_RESULTS&&path.isAbsolute(process.env.PERFCHECKER_TEST_RESULTS),'Provide an explicit absolute proof destination for the Bibliography qualification');
}
process.env.PERFCHECKER_CODEX_HOST_ONLY='1';
const {prepareJuliaCodexFixture,prepareBibliographyCodexFixture,stopObservedCodexProcesses,ownedProcessState}=await import('./codex-real.test.mjs');
const sdk=await import(process.env.PERFCHECKER_TEST_ELECTRON?pathToFileURL(process.env.PERFCHECKER_TEST_ELECTRON).href:'@vscode/test-electron');
const session=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-codex-host-'));
let displayChild,displayExit,sessionMayRemove=true,expired=false,forceDeadline;
// The SDK's own SIGINT handler first closes its private VS Code gracefully;
// its second handler stops that same process tree. Owned detached workers are
// independently identity-checked below before any temporary files are removed.
const deadline=setTimeout(()=>{
  expired=true;process.emit('SIGINT');
  forceDeadline=setTimeout(()=>process.emit('SIGINT'),45000);
},(bibliography?25:18)*60*1000);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
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
    'perfchecker.advisorConfig':'perf/advisor.json','perfchecker.advisorEnabled':false,'perfchecker.advisorImplementationMcpTool':'previous_agent','perfchecker.advisorTimeout':180,
    ...(bibliography?{'perfchecker.scenarioCatalog':'perf/episode-05a/timing/scenarios.toml','perfchecker.scenarioSamples':100,
      'perfchecker.scenarioThreads':2,'perfchecker.analysisTimeout':120}:{}),
    'telemetry.telemetryLevel':'off','workbench.startupEditor':'none','window.restoreWindows':'none'}));
  const fixture=await (bibliography?prepareBibliographyCodexFixture:prepareJuliaCodexFixture)(root,
    {julia:process.env.PERFCHECKER_TEST_JULIA,project:process.env.PERFCHECKER_TEST_CONTROLLER,coreVersion:'1.0.1',coreTree});
  await execute('unzip',['-q',archive,'-d',path.join(session,'archive')]);
  const archiveExtension=path.join(session,'archive','extension');
  assert.equal(JSON.parse(await fs.readFile(path.join(archiveExtension,'package.json'),'utf8')).version,'1.0.1');
  // -displayfd asks Xvfb to reserve its own free display. Never attach to the user's DISPLAY.
  displayChild=spawn(process.env.PERFCHECKER_TEST_XVFB||'Xvfb',
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
  const privateEnv={...process.env,DISPLAY:display,XAUTHORITY:''};
  const vscodeExecutablePath=await sdk.downloadAndUnzipVSCode({version:'1.141.0',cachePath:path.join(session,'vscode'),timeout:30000});
  assert(vscodeExecutablePath.startsWith(session+path.sep),'Use only the temporary VS Code download');
  const application=path.join(path.dirname(vscodeExecutablePath),'resources','app');
  assert.equal(JSON.parse(await fs.readFile(path.join(application,'package.json'),'utf8')).version,'1.141.0');
  const cliSource=await fs.readFile(path.join(application,'out','cli.js'),'utf8');
  const privateDirectoryFlags=['shared-data-dir','agent-plugins-dir','agents-user-data-dir','agents-extensions-dir'];
  for(const flag of privateDirectoryFlags)assert(cliSource.includes(`"${flag}":`),`The actual host CLI must support ${flag}`);
  const privateDirectories=privateDirectoryFlags.map(flag=>[flag,path.join(profile,flag)]);
  await Promise.all(privateDirectories.map(([,directory])=>fs.mkdir(directory,{recursive:true})));
  const privateProfile=[`--user-data-dir=${profile}`,`--extensions-dir=${extensions}`,
    ...privateDirectories.map(([flag,directory])=>`--${flag}=${directory}`)];
  const [cli,...cliArgs]=sdk.resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  await execute(cli,[...cliArgs,...privateProfile,'--install-extension',archive],{env:privateEnv,timeout:120000});
  const portServer=createServer();await new Promise((resolve,reject)=>{portServer.once('error',reject);portServer.listen(0,'127.0.0.1',resolve);});
  const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
  // VS Code requires a development location to execute its test runner. This
  // neutral manifest supplies it without loading any development product code.
  const driver=path.join(session,'driver');await fs.mkdir(driver);
  await fs.writeFile(path.join(driver,'package.json'),JSON.stringify({name:'perfchecker-local-authentication-driver',publisher:'qualification',version:'0.0.0',engines:{vscode:'^1.96.0'}}));
  assert(!expired,'The local runner exceeded its total deadline before launch');
  await sdk.runTests({vscodeExecutablePath,extensionDevelopmentPath:driver,extensionTestsPath:path.join(client,'test','codex-vscode-host.cjs'),
    launchArgs:[root,'--new-window','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-gpu',
      ...privateProfile,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],
    extensionTestsEnv:{DISPLAY:display,XAUTHORITY:'',PERFCHECKER_HOST_RESULT:path.join(session,'result.json'),
      PERFCHECKER_HOST_SESSION:session,PERFCHECKER_HOST_ARCHIVE:archive,PERFCHECKER_HOST_ARCHIVE_EXTENSION:archiveExtension,
      PERFCHECKER_HOST_VSIX_SHA:vsixSha,PERFCHECKER_HOST_CDP_PORT:String(port),PERFCHECKER_HOST_BASELINE_BYTES:String(fixture.baselineBytes),
      PERFCHECKER_HOST_CORE:JSON.stringify(fixture.core),PERFCHECKER_CODEX_HOST_ONLY:'1',
      ...(bibliography?{PERFCHECKER_HOST_BIBLIOGRAPHY:JSON.stringify(fixture.probe)}:{}),
      ...(process.env.PERFCHECKER_TEST_RESULTS?{PERFCHECKER_HOST_PROOFS:process.env.PERFCHECKER_TEST_RESULTS}:{}),
      JULIA_NUM_THREADS:bibliography?'2':'1',JULIA_NUM_PRECOMPILE_TASKS:'1',JULIA_NUM_GC_THREADS:'1',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}});
  const result=JSON.parse(await fs.readFile(path.join(session,'result.json'),'utf8'));
  assert(!expired,'The local runner exceeded its total deadline');
  assert.equal(result.runner,'codex-vscode-host.cjs');assert.equal(result.hostExecuted,true);
  assert.equal(result.cleanupSafeToRemove,true);
  assert.equal(result.vsixSha256,vsixSha);assert.equal(result.status,'passed');console.log(JSON.stringify(result));
}catch(error){
  // Preserve the host's primary outcome in stdout before its required temporary
  // result/profile files are removed. No credential or environment dump is made.
  const result=await fs.readFile(path.join(session,'result.json'),'utf8').catch(value=>{if(value.code==='ENOENT')return undefined;throw value;});
  if(result){
    const outcome=JSON.parse(result);console.log(result);
    try{
      await stopObservedCodexProcesses(outcome.observedProcesses||[]);
      for(const record of outcome.observedProcesses||[])assert.notEqual((await ownedProcessState(record.pid))?.start,record.start);
      sessionMayRemove=outcome.cleanupSafeToRemove!==false;
    }catch(cleanupError){sessionMayRemove=false;console.error(`Owned failure cleanup failed: ${cleanupError}`);}
  }
  throw error;
}finally{
  clearTimeout(deadline);clearTimeout(forceDeadline);
  try{
    if(process.env.PERFCHECKER_TEST_RESULTS){
      await fs.mkdir(process.env.PERFCHECKER_TEST_RESULTS,{recursive:true});
      await fs.copyFile(path.join(session,'result.json'),path.join(process.env.PERFCHECKER_TEST_RESULTS,'result.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
  }finally{
    if(displayChild?.pid&&displayChild.exitCode===null&&displayChild.signalCode===null){
      displayChild.kill('SIGTERM');await Promise.race([displayExit,delay(2000)]);
      if(displayChild.exitCode===null&&displayChild.signalCode===null){displayChild.kill('SIGKILL');await displayExit;}
    }
    if(sessionMayRemove)await fs.rm(session,{recursive:true,force:true});
    else console.error(`Failed session preserved while process cleanup is unresolved: ${session}`);
  }
}
