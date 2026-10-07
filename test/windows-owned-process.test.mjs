import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Script} from 'node:vm';

const require=createRequire(import.meta.url);
const {spawnWindowsOwnedProcess}=require('../dist/windowsOwnedProcess.js');
const windows=process.platform==='win32';
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function until(predicate,description,timeout=20000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error(`Timed out waiting for ${description}.`);
}
function completion(child){
  let stdout='',stderr='';
  child.stdout?.setEncoding('utf8');child.stdout?.on('data',chunk=>stdout+=chunk);
  child.stderr?.setEncoding('utf8');child.stderr?.on('data',chunk=>stderr+=chunk);
  return new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{
    const result={code,signal,stdout,stderr};
    if(code!==0&&code!==37&&signal===null)console.log(JSON.stringify({event:'owned-process-finished',...result,stdout:stdout.slice(0,4000),stderr:stderr.slice(0,12000)}));
    resolve(result);
  });});
}
async function fixture(body){
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-owned-Δ space-'));
  const script=path.join(root,'fixture ü.js');
  await writeFile(script,body,'utf8');
  return {root,script};
}
const treeSource=String.raw`
const fs=require('node:fs'),cp=require('node:child_process');
const root=process.env.PCW_TEST_ROOT,role=process.argv[2],mode=process.argv[3];
fs.writeFileSync(root+'/'+role+'.pid',String(process.pid));
if(role==='grandchild'){fs.writeFileSync(root+'/ready','ready');setInterval(()=>{},1000);}
else if(role==='child'){
 cp.spawn(process.execPath,[__filename,'grandchild',mode],{stdio:['ignore',1,2],env:process.env});
 if(mode==='intermediate')setTimeout(()=>process.exit(0),100);
 else setInterval(()=>{},1000);
}else{
 if(mode==='intermediate'){
  // A Node intermediary closes its own libuv Job on exit and may already kill
  // the grandchild. A native PowerShell intermediary preserves the actual
  // surviving-descendant precondition we need to qualify our private Job.
  const literal=value=>"'"+value.replace(/'/g,"''")+"'";
  const code='[IO.File]::WriteAllText('+literal(root+'/child.pid')+', [string]$PID);'+
   '$start=New-Object Diagnostics.ProcessStartInfo;$start.FileName='+literal(process.execPath)+';'+
   '$start.Arguments='+literal('"'+__filename+'" grandchild intermediate')+';$start.UseShellExecute=$false;'+
   '$process=[Diagnostics.Process]::Start($start);while(-not [IO.File]::Exists('+literal(root+'/ready')+')){Start-Sleep -Milliseconds 20};exit 0';
  cp.spawn(process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe',
   ['-NoProfile','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{stdio:['ignore',1,2],env:process.env});
 }else cp.spawn(process.execPath,[__filename,'child',mode],{stdio:['ignore',1,2],env:process.env});
 const timer=setInterval(()=>{if(fs.existsSync(root+'/ready')){
  fs.writeFileSync(root+'/leader-ready','ready');
  process.stdout.write('leader ready\n');
  if(mode==='exit'){clearInterval(timer);process.exit(0);}
 }},20);
}
`;

for(const mode of ['exit','active','intermediate'])test(`Windows private Job: ${mode} leader/descendants with inherited streams`,{skip:!windows,timeout:45000},async()=>{
  const {root,script}=await fixture(treeSource);
  const foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  const child=spawnWindowsOwnedProcess(process.execPath,[script,'leader',mode],{cwd:root,env:{...process.env,PCW_TEST_ROOT:root}});
  const finished=completion(child);child.stdin.end('A normal prompt EOF is not cancellation.');
  let pids=[];
  try{
    await until(async()=>{try{await readFile(path.join(root,'leader-ready'));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}},'actual child and grandchild readiness');
    pids=await Promise.all(['leader','child','grandchild'].map(async role=>Number(await readFile(path.join(root,role+'.pid'),'utf8'))));
    if(mode!=='exit'){
      assert.equal(alive(pids[0]),true,'leader is executing before cancellation');
      assert.equal(alive(pids[2]),true,'actual grandchild is alive before cancellation');
      if(mode==='intermediate')await until(()=>!alive(pids[1]),'intermediate exit with a living grandchild');
      assert.equal(alive(pids[2]),true,'descendant survived intermediate exit before the owned stop');
      child.kill('SIGKILL');
    }
    const result=await finished;
    if(mode==='exit')assert.equal(result.code,0,result.stderr);
    for(const pid of pids)assert.equal(alive(pid),false,`owned PID ${pid} must be stopped before wrapper close`);
    assert.equal(alive(foreign.pid),true,'unrelated process is preserved before teardown');
  }finally{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await finished.catch(()=>{});
    for(const pid of pids)if(alive(pid))process.kill(pid,'SIGKILL');
    if(foreign.pid&&alive(foreign.pid))foreign.kill('SIGKILL');
    await new Promise(resolve=>foreign.exitCode!==null||foreign.signalCode!==null?resolve():foreign.once('close',resolve));
    await rm(root,{recursive:true,force:true});
  }
});

test('Windows Job owner stops if its Node parent disappears',{skip:!windows,timeout:45000},async t=>{
  const {root,script}=await fixture(treeSource);
  const host=path.join(root,'owner host.js');
  const module=require.resolve('../dist/windowsOwnedProcess.js');
  const hostSource=`const fs=require('node:fs');const {spawnWindowsOwnedProcess}=require(${JSON.stringify(module)});const child=spawnWindowsOwnedProcess(process.execPath,[${JSON.stringify(script)},'leader','active'],{cwd:${JSON.stringify(root)},env:{...process.env,PCW_TEST_ROOT:${JSON.stringify(root)}}});fs.writeFileSync(${JSON.stringify(path.join(root,'wrapper.pid'))},String(child.pid));let stderr='';child.stdout.resume();child.stderr.on('data',chunk=>stderr+=chunk);child.on('close',(code,signal)=>fs.writeFileSync(${JSON.stringify(path.join(root,'wrapper-result.json'))},JSON.stringify({code,signal,stderr})));child.stdin.end('complete prompt');setInterval(()=>{},1000);`;
  new Script(hostSource,{filename:host});
  await writeFile(host,hostSource);
  const parent=spawn(process.execPath,[host],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  const parentFinished=completion(parent);let parentResult;
  void parentFinished.then(result=>{parentResult=result;});
  let pids=[],primaryFailure;
  try{
    await until(async()=>{try{await readFile(path.join(root,'leader-ready'));return true;}catch(error){if(error.code!=='ENOENT')throw error;}
      const result=await readFile(path.join(root,'wrapper-result.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(result)throw new Error(`Owner-loss fixture failed before readiness: ${result}`);
      if(parentResult)throw new Error(`Owner-loss Node host failed before readiness: ${JSON.stringify(parentResult)}`);return false;
    },'real child/grandchild before owner loss');
    pids=await Promise.all(['wrapper','leader','child','grandchild'].map(async role=>Number(await readFile(path.join(root,role+'.pid'),'utf8'))));
    assert.equal(alive(pids[3]),true,'grandchild is running before its Node owner is stopped');
    parent.kill('SIGKILL');
    await new Promise(resolve=>parent.exitCode!==null||parent.signalCode!==null?resolve():parent.once('close',resolve));
    await until(()=>pids.every(pid=>!alive(pid)),'private Job and owner completion after Node owner loss',10000);
    t.diagnostic(JSON.stringify({event:'owned-parent-loss-before-teardown',parent:parent.pid,
      parentAlive:alive(parent.pid),owned:pids.map(pid=>({pid,alive:alive(pid)}))}));
    for(const pid of pids)assert.equal(alive(pid),false,'owned processes are stopped before fixture teardown');
  }catch(error){primaryFailure=error;throw error;}
  finally{
    try{
      if(parent.pid&&alive(parent.pid))parent.kill('SIGKILL');
      for(const pid of pids)if(alive(pid))process.kill(pid,'SIGKILL');
      await parentFinished;
      // Process/pipe completion is required above; Windows may still briefly
      // retain a filesystem lock while releasing a completed process's cwd.
      await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    }catch(cleanupFailure){
      if(primaryFailure)throw new AggregateError([primaryFailure,cleanupFailure],
        'Owner-loss verification and fixture cleanup both failed');
      throw cleanupFailure;
    }
  }
});

test('Windows owner preserves Unicode argv/cwd/env, stdin EOF, simultaneous large streams and exit status',{skip:!windows,timeout:60000},async()=>{
  const body=`const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{process.stdout.write('x'.repeat(1048576));process.stderr.write('y'.repeat(1048576));process.stdout.write('\\n'+JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.PCW_VALUE,input:Buffer.concat(chunks).toString('utf8')}));process.exitCode=37;});`;
  const {root,script}=await fixture(body);
  const args=['','two words','ü Δ 漢字','quote"value','trailing\\','two\\\\"slashes','$literal'];
  try{
    const child=spawnWindowsOwnedProcess(process.execPath,[script,...args],{cwd:root,env:{...process.env,PCW_VALUE:'ü " $ \\ value'}});
    const finished=completion(child);child.stdin.end('Prompt ü Δ\nsecond line\n');
    const result=await finished;
    assert.equal(result.code,37,result.stderr);
    assert.equal(result.stderr,'y'.repeat(1048576));
    assert.equal(result.stdout.slice(0,1048576),'x'.repeat(1048576));
    const actual=JSON.parse(result.stdout.slice(1048577));
    assert.deepEqual(actual,{args,cwd:root,value:'ü " $ \\ value',input:'Prompt ü Δ\nsecond line\n'});
    // Repeated physical launch/setup failures must not retain a private Job or pipe.
    for(let i=0;i<3;i++){
      const failed=spawnWindowsOwnedProcess(path.join(root,'absent.exe'),[],{cwd:root,env:{...process.env}});
      const done=completion(failed);failed.stdin.end();
      const result=await done;assert.notEqual(result.code,0);assert.match(result.stderr,/native process failed|Windows process owner failed/);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Windows owner refuses shell launchers and invalid NUL inputs before spawning',{skip:!windows},()=>{
  assert.throws(()=>spawnWindowsOwnedProcess('codex.cmd',[],{cwd:tmpdir(),env:process.env}),/native executable/);
  assert.throws(()=>spawnWindowsOwnedProcess(process.execPath,['bad\0argument'],{cwd:tmpdir(),env:process.env}),/NUL/);
});
