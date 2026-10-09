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
const vsixSha='ff5a1af088ababeccd0847f27bcd2e6c0f7e9c0f894b37e35e5711d7b044857d';
const mediaWorkspace='/home/azzaare/.julia/dev/Bibliography-perfchecker-mcp-pilot-20261008';
const mediaOutput='/home/azzaare/Documents/Codex/2026-10-03/on-commence-arriver-sur-la-fin/outputs';
async function preflightMeasurementWorker(){
  const project=path.join(mediaWorkspace,'perf/media/scenario-worker');
  const depot=process.env.JULIA_DEPOT_PATH?.split(path.delimiter);
  assert(depot?.length&&depot.every(value=>value.startsWith('/tmp/perfchecker-')),'Only explicit private depots may supply the measurement worker');
  const files=['Project.toml','Manifest.toml'];
  const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async name=>[name,createHash('sha256').update(await fs.readFile(path.join(project,name))).digest('hex')])));
  const before=await hashes();
  assert.equal(before['Project.toml'],'50e66a4204d79edb2c1b44c8866aca6612d704528032866b63721a645b6d6a2e');
  assert.equal(before['Manifest.toml'],'0a5552fc0d3716bd323dd9bad77e2cff1edd4e0cae917d005398619cc323b85d');
  const script=String.raw`started=time()
    @assert occursin(r"(?m)^Cpus_allowed_list:\s*16-17$",read("/proc/self/status",String))
    for name in ("BenchmarkTools","Bibliography","BibInternal","BibParser")
      found=Base.find_package(name)
      println("WORKER_PREFLIGHT_STAGE found ",name," ",time()-started," ",something(found,"MISSING"));flush(stdout)
      @assert found!==nothing "Missing worker package: $name"
      println("WORKER_PREFLIGHT_STAGE before_import ",name," ",time()-started);flush(stdout)
      m=Base.require(Main,Symbol(name))
      println("WORKER_PREFLIGHT_STAGE after_import ",name," ",time()-started);flush(stdout)
      if name=="BenchmarkTools";@assert Base.pkgversion(m)==v"1.8.0";end
      if name=="Bibliography";@assert realpath(pkgdir(m))==ARGS[1];end
      println("WORKER_PREFLIGHT ",nameof(m)," ",Base.pkgversion(m)," ",realpath(pathof(m)));flush(stdout)
    end`;
  let output,after,failure;
  try{output=await execute(process.env.PERFCHECKER_TEST_JULIA,['--startup-file=no',`--project=${project}`,'-e',script,mediaWorkspace],{timeout:180000,env:{...process.env}});}
  catch(error){failure=error;output={stdout:error.stdout||'',stderr:error.stderr||''};}
  finally{after=await hashes();assert.deepEqual(after,before,'Worker preflight must not mutate its project or manifest');}
  const packages=output.stdout.trim().split(/\r?\n/).filter(line=>line.startsWith('WORKER_PREFLIGHT ')).map(line=>{
    const match=line.match(/^WORKER_PREFLIGHT (\S+) (\S+) (.+)$/);assert(match);return {name:match[1],version:match[2],path:match[3]};
  });
  const receipt={status:failure?'failed':'passed',project,depot,packages,stages:output.stdout.split(/\r?\n/).filter(line=>line.startsWith('WORKER_PREFLIGHT_STAGE ')),
    stderr:output.stderr.slice(-4096),failure:failure?{code:failure.code,signal:failure.signal,killed:failure.killed,error:String(failure).slice(-4096)}:undefined,
    timeoutSeconds:180,hashesBefore:before,hashesAfter:after,measurements:0,agentRequests:0};
  if(failure){failure.workerPreflight=receipt;console.log(JSON.stringify(receipt,null,2));throw failure;}
  assert.deepEqual(packages.map(value=>value.name),['BenchmarkTools','Bibliography','BibInternal','BibParser']);
  return receipt;
}
function supportingWmWindow(text){
  const line=text.split(/\r?\n/).find(value=>/^_NET_SUPPORTING_WM_CHECK(?:\(WINDOW\))?(?::|\s*=)/.test(value));
  return line?.match(/^_NET_SUPPORTING_WM_CHECK(?:\(WINDOW\))?(?:: window id #|\s*=)\s*(0x[0-9a-f]+)\s*$/)?.[1];
}
async function startPrivateWindowManager(session,privateEnv,runnerState,resultFile,{reuseCache=false}={}){
  let wmChild,wmExit;
  try{
    const wm=await fs.realpath(process.env.PERFCHECKER_TEST_OPENBOX);
    assert(wm.startsWith('/tmp/perfchecker-pilot-openbox.')&&wm.endsWith('/runtime/usr/bin/openbox'));
    assert.equal(createHash('sha256').update(await fs.readFile(wm)).digest('hex'),'941e69bf5479d77805bdeae7a6dee17142ff429b8db9e7d0c1b579e9c70a0b52');
    const wmRoot=path.resolve(path.dirname(wm),'..');
    const wmConfig=path.join(session,'wm','rc.xml'),wmCache=path.join(session,'wm-cache');
    await fs.mkdir(path.dirname(wmConfig),{recursive:true});
    if(reuseCache){
      const previous=await fs.lstat(wmCache).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(previous){assert(previous.isDirectory()&&!previous.isSymbolicLink());assert.equal(await fs.realpath(wmCache),path.join(await fs.realpath(session),'wm-cache'));}
      else await fs.mkdir(wmCache);
    }else await fs.mkdir(wmCache);
    await fs.writeFile(wmConfig,'<?xml version="1.0"?><openbox_config xmlns="http://openbox.org/3.4/rc"><theme><name>Clearlooks</name></theme><desktops><number>1</number></desktops><keyboard/><mouse/><menu/></openbox_config>');
    const wmEnv={...privateEnv,XDG_CONFIG_HOME:path.dirname(wmConfig),XDG_CONFIG_DIRS:path.dirname(wmConfig),XDG_CACHE_HOME:wmCache,
      XDG_DATA_HOME:path.join(session,'wm-data'),XDG_DATA_DIRS:path.join(wmRoot,'share'),
      LD_LIBRARY_PATH:[path.join(wmRoot,'lib','x86_64-linux-gnu'),privateEnv.LD_LIBRARY_PATH].filter(Boolean).join(':')};
    runnerState.windowManagerStartup.status='starting';
    runnerState.windowManagerStartup.expectedExecutable=wm;
    runnerState.windowManagerStartup.configSha256=createHash('sha256').update(await fs.readFile(wmConfig)).digest('hex');
    await fs.writeFile(resultFile,JSON.stringify(runnerState,null,2));
    wmChild=spawn(wm,['--sm-disable','--config-file',wmConfig],{env:wmEnv,stdio:['ignore','ignore','pipe']});
    wmExit=new Promise(resolve=>wmChild.once('exit',resolve));
    wmChild.once('error',error=>{runnerState.windowManagerStartup.spawnError=String(error);});
    wmChild.stderr.on('data',chunk=>{runnerState.windowManagerStartup.stderr=(runnerState.windowManagerStartup.stderr+chunk).slice(-4096);});
    runnerState.windowManagerStartup.pid=wmChild.pid;
    const readyUntil=Date.now()+10000;let wmIdentity;
    while(Date.now()<readyUntil){
      assert(wmChild.exitCode===null&&wmChild.signalCode===null,'The private window manager must remain alive');
      runnerState.windowManagerStartup.observedAt=new Date().toISOString();
      const currentExe=await fs.realpath(`/proc/${wmChild.pid}/exe`).catch(()=>undefined);
      const currentStat=await fs.readFile(`/proc/${wmChild.pid}/stat`,'utf8').catch(()=>undefined);
      const currentFields=currentStat?.slice(currentStat.lastIndexOf(') ')+2).trim().split(/\s+/);
      runnerState.windowManagerStartup.childIdentity={pid:wmChild.pid,executable:currentExe,parent:currentFields?Number(currentFields[1]):null,start:currentFields?.[19],state:currentFields?.[0],
        affinity:(await fs.readFile(`/proc/${wmChild.pid}/status`,'utf8').catch(()=>'' )).match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1]};
      await fs.writeFile(resultFile,JSON.stringify(runnerState,null,2));
      let rootProperties;
      try{rootProperties=(await execute('/usr/bin/xprop',['-root','_NET_SUPPORTING_WM_CHECK','_NET_SUPPORTED'],{env:privateEnv,timeout:5000})).stdout;}
      catch(error){runnerState.windowManagerStartup.rootObservationError={error:String(error),stdout:String(error.stdout||'').slice(-4096),stderr:String(error.stderr||'').slice(-4096)};throw error;}
      runnerState.windowManagerStartup.lastRootProperties=rootProperties;
      await fs.writeFile(resultFile,JSON.stringify(runnerState,null,2));
      const xid=supportingWmWindow(rootProperties);
      if(xid){
        let properties;
        try{properties=(await execute('/usr/bin/xprop',['-id',xid,'_NET_SUPPORTING_WM_CHECK','_NET_WM_NAME','_NET_WM_PID'],{env:privateEnv,timeout:5000})).stdout;}
        catch(error){runnerState.windowManagerStartup.windowObservationError={error:String(error),stdout:String(error.stdout||'').slice(-4096),stderr:String(error.stderr||'').slice(-4096)};throw error;}
        runnerState.windowManagerStartup.lastWindowProperties=properties;
        await fs.writeFile(resultFile,JSON.stringify(runnerState,null,2));
        assert.equal(supportingWmWindow(properties),xid);
        assert(/_NET_WM_NAME.*Openbox/.test(properties));assert(rootProperties.includes('_NET_WM_STATE_FULLSCREEN'));
        const executable=await fs.realpath(`/proc/${wmChild.pid}/exe`);assert.equal(executable,wm);
        const stat=await fs.readFile(`/proc/${wmChild.pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/);
        assert.equal(Number(fields[1]),process.pid);assert.notEqual(fields[0],'Z');
        const affinity=(await fs.readFile(`/proc/${wmChild.pid}/status`,'utf8')).match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1];assert.equal(affinity,'16-17');
        const reportedPid=properties.match(/_NET_WM_PID[^=]*=\s*(\d+)/)?.[1];if(reportedPid)assert.equal(Number(reportedPid),wmChild.pid);
        wmIdentity={pid:wmChild.pid,parent:process.pid,executable,start:fields[19],affinity,xid,reportedPid:reportedPid?Number(reportedPid):null,reportedPidPresent:Boolean(reportedPid),rootProperties,properties,
          binarySha256:createHash('sha256').update(await fs.readFile(wm)).digest('hex'),configSha256:createHash('sha256').update(await fs.readFile(wmConfig)).digest('hex')};break;
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(wmIdentity,'The private EWMH supporting window must exist before VS Code starts');

    runnerState.windowManagerStartup.status='ready';runnerState.privateWindowManager=wmIdentity;
    await fs.writeFile(resultFile,JSON.stringify(runnerState,null,2));
    return {child:wmChild,exit:wmExit,identity:wmIdentity};
  }catch(error){
    runnerState.status='failed';runnerState.error=String(error);
    await fs.writeFile(resultFile,JSON.stringify(runnerState,null,2));
    if(wmChild?.pid&&wmChild.exitCode===null&&wmChild.signalCode===null){wmChild.kill('SIGTERM');await Promise.race([wmExit,new Promise(resolve=>setTimeout(resolve,2000))]);if(wmChild.exitCode===null&&wmChild.signalCode===null){wmChild.kill('SIGKILL');await wmExit;}}
    throw error;
  }
}
async function runFramingOnly({studioThemes=false}={}){
  assert(!process.env.CI);assert.equal(process.platform,'linux');
  const archive=await fs.realpath(process.env.PERFCHECKER_TEST_VSIX);
  let candidate;
  if(studioThemes){
    candidate={sha256:process.env.PERFCHECKER_UI_VSIX_SHA,size:Number(process.env.PERFCHECKER_UI_VSIX_SIZE),
      source:process.env.PERFCHECKER_UI_SOURCE_COMMIT,tree:process.env.PERFCHECKER_UI_SOURCE_TREE};
    assert(/^[a-f0-9]{64}$/.test(candidate.sha256));assert(Number.isSafeInteger(candidate.size)&&candidate.size>0);
    assert(/^[a-f0-9]{40}$/.test(candidate.source));assert(/^[a-f0-9]{40}$/.test(candidate.tree));
    const repository='/home/azzaare/Gits/PerfCheckerVSCode-native-plots';
    assert.equal((await execute('git',['-C',repository,'rev-parse','HEAD'])).stdout.trim(),candidate.source);
    assert.equal((await execute('git',['-C',repository,'rev-parse','HEAD^{tree}'])).stdout.trim(),candidate.tree);
    assert.equal((await execute('git',['-C',repository,'status','--porcelain'])).stdout,'');
    assert.equal(createHash('sha256').update(await fs.readFile(archive)).digest('hex'),candidate.sha256);
    assert.equal((await fs.stat(archive)).size,candidate.size);
  }else{
    assert.equal(createHash('sha256').update(await fs.readFile(archive)).digest('hex'),vsixSha);
    assert.equal((await fs.stat(archive)).size,1031159);
  }
  const sdk=await import(pathToFileURL(process.env.PERFCHECKER_TEST_ELECTRON).href);
  const session=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-framing-host-'));
  const output=await fs.mkdtemp(path.join(os.tmpdir(),studioThemes?'perfchecker-studio-themes-':'perfchecker-native-framing-'));
  const resultFile=path.join(output,'framing.json');
  let displayChild,displayExit,wmChild,wmExit;
  let nativeShutdownQualified=!studioThemes;
  const runnerState={runner:'run-bibliography-pilot.mjs',mode:studioThemes?'studio-theme-only':'framing-only',status:'starting',startedAt:new Date().toISOString(),windowManagerStartup:{status:'not-started',stderr:''},...(studioThemes?{candidate}: {})};
  await fs.writeFile(resultFile,JSON.stringify(runnerState,null,2));
  try{
    const root=path.join(session,'empty-workspace'),profile=path.join(session,'profile'),extensions=path.join(session,'extensions');
    await fs.mkdir(root);
    await execute('unzip',['-q',archive,'-d',path.join(session,'archive')]);
    displayChild=spawn(process.env.PERFCHECKER_TEST_XVFB,['-displayfd','3','-screen','0','1920x1080x24','-nolisten','tcp','-ac'],{stdio:['ignore','ignore','pipe','pipe']});
    displayExit=new Promise(resolve=>displayChild.once('exit',resolve));
    const display=await new Promise((resolve,reject)=>{
      let data='';const timer=setTimeout(()=>reject(new Error('Private framing Xvfb did not start')),15000);
      const finish=(error,value)=>{clearTimeout(timer);error?reject(error):resolve(value);};
      displayChild.once('error',error=>finish(error));displayChild.once('exit',()=>finish(new Error('Private framing Xvfb exited')));
      displayChild.stdio[3].on('data',chunk=>{data+=chunk;const match=data.match(/^(\d+)\s*$/);if(match)finish(undefined,`:${match[1]}`);});
      displayChild.stderr.resume();
    });
    const privateEnv={...process.env,DISPLAY:display,XAUTHORITY:''};
    delete privateEnv.WAYLAND_DISPLAY;
    if(studioThemes)for(const key of ['PERFCHECKER_TEST_CONTROLLER','PERFCHECKER_TEST_JULIA','PERFCHECKER_TEST_CODEX','JULIA_DEPOT_PATH','JULIA_LOAD_PATH'])delete privateEnv[key];
    const windowManager=await startPrivateWindowManager(session,privateEnv,runnerState,resultFile);
    wmChild=windowManager.child;wmExit=windowManager.exit;const wmIdentity=windowManager.identity;
    runnerState.status='wm-ready';runnerState.windowManagerStartup.status='ready';runnerState.privateWindowManager=wmIdentity;
    await fs.writeFile(resultFile,JSON.stringify(runnerState,null,2));
    const executable=await sdk.downloadAndUnzipVSCode({version:'1.141.0',cachePath:path.join(session,'vscode'),timeout:30000});
    assert((await fs.realpath(executable)).startsWith(session+path.sep));
    const application=path.join(path.dirname(executable),'resources','app');
    assert.equal(JSON.parse(await fs.readFile(path.join(application,'package.json'),'utf8')).version,'1.141.0');
    const cliSource=await fs.readFile(path.join(application,'out','cli.js'),'utf8');
    const flags=['shared-data-dir','agent-plugins-dir','agents-user-data-dir','agents-extensions-dir'];
    for(const flag of flags)assert(cliSource.includes(`"${flag}":`));
    const privateProfile=[`--user-data-dir=${profile}`,`--extensions-dir=${extensions}`];
    for(const flag of flags){const directory=path.join(profile,flag);await fs.mkdir(directory,{recursive:true});privateProfile.push(`--${flag}=${directory}`);}
    const [cli,...cliArgs]=sdk.resolveCliArgsFromVSCodeExecutablePath(executable);
    await execute(cli,[...cliArgs,...privateProfile,'--ozone-platform=x11','--install-extension',archive],{env:privateEnv,timeout:120000});
    const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
    const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
    const driver=path.join(session,'driver');await fs.mkdir(driver);
    await fs.writeFile(path.join(driver,'package.json'),JSON.stringify({name:'perfchecker-framing-driver',publisher:'qualification',version:'0.0.0',engines:{vscode:'^1.96.0'}}));
    if(studioThemes){runnerState.sdkStartedAt=new Date().toISOString();await fs.writeFile(resultFile,JSON.stringify(runnerState,null,2));}
    await sdk.runTests({vscodeExecutablePath:executable,extensionDevelopmentPath:driver,extensionTestsPath:path.join(client,'test','bibliography-pilot-host.cjs'),
      launchArgs:[root,'--new-window','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-gpu','--ozone-platform=x11',...privateProfile,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],
      extensionTestsEnv:{...privateEnv,WAYLAND_DISPLAY:undefined,PERFCHECKER_PRIVATE_DISPLAY:display,PERFCHECKER_FRAMING_ONLY:studioThemes?'0':'1',PERFCHECKER_STUDIO_THEME_ONLY:studioThemes?'1':'0',
        ...(studioThemes?Object.fromEntries(['PERFCHECKER_TEST_CONTROLLER','PERFCHECKER_TEST_JULIA','PERFCHECKER_TEST_CODEX','JULIA_DEPOT_PATH','JULIA_LOAD_PATH'].map(key=>[key,undefined])):{}),
        PERFCHECKER_FRAMING_OUTPUT:output,PERFCHECKER_HOST_RESULT:resultFile,PERFCHECKER_HOST_SESSION:session,PERFCHECKER_PRIVATE_WM:JSON.stringify(wmIdentity),
        PERFCHECKER_HOST_ARCHIVE:archive,PERFCHECKER_HOST_ARCHIVE_EXTENSION:path.join(session,'archive','extension'),PERFCHECKER_HOST_CDP_PORT:String(port)}});
    if(studioThemes)runnerState.sdkReturnedAt=new Date().toISOString();
  }catch(error){
    runnerState.status='failed';runnerState.error=String(error);runnerState.stack=error.stack;
    const previous=await fs.readFile(resultFile,'utf8').then(JSON.parse).catch(()=>({}));
    await fs.writeFile(resultFile,JSON.stringify({...previous,status:'failed',error:String(error),runnerState},null,2));
    throw error;
  }finally{
    console.log(`Framing evidence directory: ${output}`);
    if(studioThemes){
      try{
      const nativeReceipt=await fs.readFile(resultFile,'utf8').then(JSON.parse);
      const identities=new Map();
      const identityErrors=[];
      for(const row of [nativeReceipt.nativeWindowIdentity,nativeReceipt.nativeHostIdentity,...(nativeReceipt.nativeProcessObservations||[]).flatMap(observation=>observation.records||[])]){
        if(row&&Number.isInteger(row.pid)&&/^\d+$/.test(row.start))identities.set(`${row.pid}/${row.start}`,row);
        else identityErrors.push({error:'An observed native identity is missing its PID or process start',pid:row?.pid??null});
      }
      const shutdown={startedAt:new Date().toISOString(),identities:[...identities.values()],observations:[],errors:identityErrors,qualified:false};
      runnerState.nativeShutdown=shutdown;
      if(runnerState.sdkStartedAt&&(!nativeReceipt.nativeWindowIdentity?.start||!nativeReceipt.nativeHostIdentity?.start))shutdown.errors.push({error:'Native window/host ownership was not fully observed before SDK completion'});
      const until=Date.now()+10000;
      do{
        const observations=[];
        for(const row of identities.values()){
          try{
            let stat;try{stat=await fs.readFile(`/proc/${row.pid}/stat`,'utf8');}catch(error){if(['ENOENT','ESRCH'].includes(error.code)){observations.push({pid:row.pid,originalStart:row.start,state:'absent',originalIdentityGone:true});continue;}throw error;}
            const fields=stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/);assert(/^\d+$/.test(fields[19]));
            observations.push({pid:row.pid,originalStart:row.start,observedStart:fields[19],state:fields[0],
              status:fields[19]!==row.start?'reused PID':/^[ZX]$/.test(fields[0])?'stopped':'alive',originalIdentityGone:fields[19]!==row.start||/^[ZX]$/.test(fields[0])});
          }catch(error){shutdown.errors.push({pid:row.pid,error:String(error)});observations.push({pid:row.pid,originalStart:row.start,status:'unknown',originalIdentityGone:false});}
        }
        shutdown.observations.push({observedAt:new Date().toISOString(),processes:observations});
        if(observations.every(row=>row.originalIdentityGone))break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }while(Date.now()<until);
      shutdown.finishedAt=new Date().toISOString();shutdown.qualified=identities.size>0&&!shutdown.errors.length&&shutdown.observations.at(-1).processes.every(row=>row.originalIdentityGone);
      nativeShutdownQualified=shutdown.qualified;
      if(!nativeShutdownQualified){runnerState.status='failed';nativeReceipt.status='failed';nativeReceipt.nativeShutdownError='Private native process disappearance is unqualified; session preserved';}
      await fs.writeFile(resultFile,JSON.stringify({...nativeReceipt,runnerState},null,2));
      }catch(error){nativeShutdownQualified=false;runnerState.status='failed';runnerState.nativeShutdownInspectionError=String(error);}
    }
    if(wmChild?.pid&&wmChild.exitCode===null&&wmChild.signalCode===null){
      wmChild.kill('SIGTERM');await Promise.race([wmExit,new Promise(resolve=>setTimeout(resolve,2000))]);
      if(wmChild.exitCode===null&&wmChild.signalCode===null){wmChild.kill('SIGKILL');await wmExit;}
    }
    if(displayChild?.pid&&displayChild.exitCode===null&&displayChild.signalCode===null){
      displayChild.kill('SIGTERM');await Promise.race([displayExit,new Promise(resolve=>setTimeout(resolve,2000))]);
      if(displayChild.exitCode===null&&displayChild.signalCode===null){displayChild.kill('SIGKILL');await displayExit;}
    }
    runnerState.windowManagerStartup.exitCode=wmChild?.exitCode??null;runnerState.windowManagerStartup.signal=wmChild?.signalCode??null;
    const previous=await fs.readFile(resultFile,'utf8').then(JSON.parse).catch(()=>({}));
    if(studioThemes&&!nativeShutdownQualified)previous.status='failed';
    if(wmChild?.pid){
      const stat=await fs.readFile(`/proc/${wmChild.pid}/stat`,'utf8').catch(()=>undefined),fields=stat?.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/);
      runnerState.windowManagerCleanup={pid:wmChild.pid,originalStart:runnerState.windowManagerStartup.childIdentity?.start,observedStart:fields?.[19]??null,state:fields?.[0]??null,
        identityObserved:Boolean(runnerState.windowManagerStartup.childIdentity?.start),
        originalIdentityGone:runnerState.windowManagerStartup.childIdentity?.start?(!fields||fields[0]==='Z'||fields[19]!==runnerState.windowManagerStartup.childIdentity.start):null};
    }
    runnerState.finishedAt=new Date().toISOString();
    if(previous.status==='passed')runnerState.status='passed';
    await fs.writeFile(resultFile,JSON.stringify({...previous,runnerState},null,2));
    console.log(await fs.readFile(resultFile,'utf8'));
    if(!studioThemes||nativeShutdownQualified)await fs.rm(session,{recursive:true,force:true});
    else{console.error(`Studio theme session preserved: ${session}`);throw new Error('Studio theme native process shutdown was not qualified');}
  }
}
async function runPublicLesson(mode){
  assert(!process.env.CI);assert.equal(process.platform,'linux');
  assert(['installation','installation-continuation','testitem','testitem-continuation','reports-only'].includes(mode));
  const reportsOnly=mode==='reports-only',itemLesson=mode==='testitem'||mode==='testitem-continuation'||reportsOnly;
  const publicSha='c4123271e71e4c4d148fe0e613ba260f4aeea6f28445338cab11d3fb9513df09';
  const archive=await fs.realpath(process.env.PERFCHECKER_TEST_VSIX);
  assert.equal(createHash('sha256').update(await fs.readFile(archive)).digest('hex'),publicSha);
  assert.equal((await fs.stat(archive)).size,1001589);
  assert.equal(path.basename(archive),'perfchecker-vscode-1.0.0.vsix');
  const julia=await fs.realpath(process.env.PERFCHECKER_TEST_JULIA);
  assert.equal(path.basename(julia),'julia','Supply the real Julia runtime executable, rather than a version-dispatching launcher');
  const workspace=path.resolve(process.env.PERFCHECKER_PUBLIC_WORKSPACE);
  const dev=await fs.realpath('/home/azzaare/.julia/dev');
  assert.equal(path.dirname(workspace),dev);assert(path.basename(workspace).startsWith('PerfChecker-first-testitem-public100-'));
  let setup,controllerHashesBefore,failedTestItemParent,failedLocatorParent;
  if(mode==='installation'){
    assert(!await fs.stat(workspace).catch(()=>undefined),'A fresh tutorial package must not overwrite existing work');
    await fs.mkdir(path.join(workspace,'src'),{recursive:true});
    await fs.writeFile(path.join(workspace,'Project.toml'),'name = "PerfCheckerFirstTestItem"\nuuid = "4989be2f-9543-4cac-965c-318294e628ef"\nversion = "0.1.0"\n\n[compat]\njulia = "1.10"\n');
    await fs.writeFile(path.join(workspace,'src','PerfCheckerFirstTestItem.jl'),'module PerfCheckerFirstTestItem\nend\n');
    setup=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-public-lesson-'));
    await fs.mkdir(path.join(setup,'depot'));
  }else{
    const prior=JSON.parse(await fs.readFile(process.env.PERFCHECKER_PUBLIC_INSTALLATION_RECEIPT,'utf8'));
    assert.equal(prior.status,mode==='installation-continuation'?'failed':'passed');
    assert(['public-installation','public-installation-continuation'].includes(prior.mode));
    assert.equal(prior.workspace,workspace);assert.equal(prior.publicArchive.sha256,publicSha);
    assert.equal(prior.runnerState.nativeShutdown.qualified,true);
    assert.equal(prior.runnerState.windowManagerCleanup.originalIdentityGone,true);
    setup=await fs.realpath(prior.setup);assert(setup.startsWith('/tmp/perfchecker-public-lesson-'));
    if(mode==='installation-continuation'){
      assert.equal(prior.mode,'public-installation');
      assert.equal(prior.error,'Error: Test run failed with code 1');
      assert(prior.captures.some(capture=>capture.label==='visible-built-in-vsix-picker'));
      for(const root of [path.join(prior.output,'archive/extension'),path.join(setup,'extensions/mirage-interactive-fr.perfchecker-vscode-1.0.0')])
        assert(!await fs.stat(path.join(root,'resources')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;}),'The public archive and actual installed payload both have no resources directory');
      assert.equal(prior.steps.find(step=>step.label==='actual-public-controller-installation')?.receipt.core,'1.0.0');
      controllerHashesBefore=Object.fromEntries(await Promise.all(['Project.toml','Manifest.toml'].map(async name=>[name,createHash('sha256').update(await fs.readFile(path.join(workspace,'perf/controller',name))).digest('hex')])));
    }else{
      for(const [name,sha]of Object.entries(prior.controllerHashes))assert.equal(createHash('sha256').update(await fs.readFile(path.join(workspace,'perf/controller',name))).digest('hex'),sha);
      assert.equal(Object.keys(prior.tutorialSourceHashes).length,2);
      for(const [name,sha]of Object.entries(prior.tutorialSourceHashes))assert.equal(createHash('sha256').update(await fs.readFile(path.join(workspace,name))).digest('hex'),sha);
    }
  }
  if(mode==='testitem-continuation'){
    const bytes=await fs.readFile(process.env.PERFCHECKER_PUBLIC_TESTITEM_RECEIPT),prior=JSON.parse(bytes);
    const sha256=createHash('sha256').update(bytes).digest('hex');assert.equal(sha256,'665ecc3e0326981bbe9bf6cc5cdcce935f0d70742022fd2873f704a3a89faa63');
    assert.equal(prior.mode,'public-testitem');assert.equal(prior.status,'failed');assert.equal(prior.measurements,0);assert.equal(prior.agentRequests,0);
    assert.equal(prior.workspace,workspace);assert.equal(prior.setup,setup);assert.equal(prior.publicArchive.sha256,publicSha);
    assert.equal(prior.runnerState.nativeShutdown.qualified,true);assert.equal(prior.runnerState.windowManagerCleanup.originalIdentityGone,true);
    assert.equal(prior.testItemSource.file,path.join(workspace,'test/performance.jl'));assert.equal(prior.testItemSource.sha256,'df13f23d706576c86e9d88edfca27fa805df2c4ebcfd71b302f942a687abdaf5');
    const info=await fs.lstat(prior.testItemSource.file);assert(info.isFile()&&!info.isSymbolicLink());assert.equal(await fs.realpath(prior.testItemSource.file),prior.testItemSource.file);
    assert.equal(createHash('sha256').update(await fs.readFile(prior.testItemSource.file)).digest('hex'),prior.testItemSource.sha256);
    for(const [name,sha]of Object.entries(prior.controllerHashes))assert.equal(createHash('sha256').update(await fs.readFile(path.join(workspace,'perf/controller',name))).digest('hex'),sha);
    failedTestItemParent={file:process.env.PERFCHECKER_PUBLIC_TESTITEM_RECEIPT,sha256,hostError:prior.hostError,juliaCleanup:prior.juliaCleanup};
    const locatorBytes=await fs.readFile(process.env.PERFCHECKER_PUBLIC_LOCATOR_RECEIPT),locator=JSON.parse(locatorBytes),locatorSha=createHash('sha256').update(locatorBytes).digest('hex');
    assert.equal(locatorSha,'78f3ad86797fc4ebe915d765e42ffebf2f78b488b7bcc183c0d7abf6053c55aa');assert.equal(locator.mode,'public-testitem-continuation');
    assert.equal(locator.status,'failed');assert.equal(locator.measurements,0);assert.equal(locator.agentRequests,0);assert.equal(locator.workspace,workspace);assert.equal(locator.setup,setup);
    assert.equal(locator.runnerState.nativeShutdown.qualified,true);assert.equal(locator.runnerState.windowManagerCleanup.originalIdentityGone,true);
    assert.equal(locator.testItemSource.sha256,prior.testItemSource.sha256);
    failedLocatorParent={file:process.env.PERFCHECKER_PUBLIC_LOCATOR_RECEIPT,sha256:locatorSha,hostError:locator.hostError};
  }
  let existingEvidenceParent,existingEvidenceDirectoriesBefore;
  if(reportsOnly){const hash=value=>createHash('sha256').update(value).digest('hex');
    const parentBytes=await fs.readFile(process.env.PERFCHECKER_PUBLIC_EVIDENCE_RECEIPT),parent=JSON.parse(parentBytes);
    assert.equal(hash(parentBytes),'8763117caee01945dbf3db2b9e9446b406cdc5ab6e81efd0ad3d4366069a51cf');
    assert.equal(parent.mode,'public-testitem-continuation');assert.equal(parent.status,'failed');assert.equal(parent.measurements,1);assert.equal(parent.intentionalItemLaunches,1);assert.equal(parent.agentRequests,0);
    assert.equal(parent.setup,setup);assert.equal(parent.workspace,workspace);assert.equal(parent.publicArchive.sha256,'c4123271e71e4c4d148fe0e613ba260f4aeea6f28445338cab11d3fb9513df09');
    assert.equal(parent.nativeShutdown.qualified,true);assert.equal(parent.windowManagerCleanup.originalIdentityGone,true);
    assert.deepEqual(parent.juliaCleanup.signals,[]);assert.deepEqual(parent.juliaCleanup.remaining,[]);assert.deepEqual(parent.processObservationErrors,[]);
    assert.equal(parent.testItemSource.file,path.join(workspace,'test/performance.jl'));assert.equal(parent.testItemSource.sha256,'df13f23d706576c86e9d88edfca27fa805df2c4ebcfd71b302f942a687abdaf5');
    assert.equal(await fs.realpath(parent.testItemSource.file),parent.testItemSource.file);assert.equal(hash(await fs.readFile(parent.testItemSource.file)),parent.testItemSource.sha256);
    for(const [name,sha]of Object.entries(parent.controllerHashes))assert.equal(hash(await fs.readFile(path.join(workspace,'perf/controller',name))),sha);
    const evidenceFile=parent.evidence.file,info=await fs.lstat(evidenceFile);assert(info.isFile()&&!info.isSymbolicLink());assert.equal(await fs.realpath(evidenceFile),evidenceFile);
    assert.equal(path.dirname(path.dirname(evidenceFile)),path.join(setup,'profile/User/globalStorage/mirage-interactive-fr.perfchecker-vscode/native-testitems'));assert.equal(path.basename(evidenceFile),'result.json');
    const bytes=await fs.readFile(evidenceFile),payload=JSON.parse(bytes);assert.equal(hash(bytes),parent.evidence.sha256);
    assert.equal(payload.schema_version,'perfchecker-testitem-run/1');assert.equal(payload.root,workspace);assert.equal(payload.passed,true);assert.equal(payload.runs.length,1);
    const run=payload.runs[0];assert.equal(run.status,'validated');assert.deepEqual(run.item,parent.evidence.item);assert.equal(run.item.source_sha256,parent.testItemSource.sha256);assert.equal(run.samples.length,1);assert.deepEqual(run.samples[0],parent.evidence.sample);
    assert.equal(run.samples[0].correctness,'passed');assert.equal(run.samples[0].passes,1);assert.equal(run.samples[0].errors,0);assert.equal(run.samples[0].failures,0);

    existingEvidenceParent={file:process.env.PERFCHECKER_PUBLIC_EVIDENCE_RECEIPT,sha256:hash(parentBytes),hostError:parent.hostError};
    existingEvidenceDirectoriesBefore=(await fs.readdir(path.dirname(path.dirname(evidenceFile)))).sort();
  }
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const output=path.join(mediaOutput,`perfchecker-episode-01${itemLesson?'b':'a'}-${reportsOnly?'reports-only-':mode.endsWith('-continuation')?'continuation-':''}native-${stamp}`);
  await fs.mkdir(output);
  const resultFile=path.join(output,'receipt.json'),profile=path.join(setup,'profile'),extensions=path.join(setup,'extensions');
  const state={mode:`public-${mode}`,status:'starting',startedAt:new Date().toISOString(),setup,workspace,output,
    publicArchive:{sha256:publicSha,size:1001589,release:'v1.0.0',source:'992af2a449cf2c5586555339e5fbba08c0dd79df',tree:'b43098d4f468ba88b2f5436e0857c4f8eb67e436'},windowManagerStartup:{status:'not-started',stderr:''}};
  if(mode==='installation-continuation')state.failedParent={file:process.env.PERFCHECKER_PUBLIC_INSTALLATION_RECEIPT,sha256:createHash('sha256').update(await fs.readFile(process.env.PERFCHECKER_PUBLIC_INSTALLATION_RECEIPT)).digest('hex'),controllerHashesBefore};
  if(failedTestItemParent){state.failedTestItemParent=failedTestItemParent;state.failedLocatorParent=failedLocatorParent;state.sourcePrepared=true;}
  if(existingEvidenceParent){state.existingEvidenceParent=existingEvidenceParent;state.inspectedMeasurements=1;state.nativeEvidenceDirectoriesBeforeSdk=existingEvidenceDirectoriesBefore;}
  const globalDeadline=Date.parse(state.startedAt)+(itemLesson?8:12)*60000;
  state.deadlineAt=new Date(globalDeadline).toISOString();state.shutdownGraceSeconds=20;
  const remaining=()=>{assert(Date.now()<globalDeadline,'The public lesson exceeded its total filming budget');return globalDeadline-Date.now();};
  await fs.writeFile(resultFile,JSON.stringify(state,null,2));
  let displayChild,displayExit,wmChild,wmExit,nativeShutdownQualified=false,deadline,forceDeadline,drainDeadline;
  // Keep the SDK from exiting this runner before its evidence/owned shutdown finally executes.
  const retainRunner=()=>{};process.on('SIGINT',retainRunner);
  try{
    await execute('unzip',['-q',archive,'-d',path.join(output,'archive')],{timeout:remaining()});
    const sdk=await import(pathToFileURL(process.env.PERFCHECKER_TEST_ELECTRON).href);
    displayChild=spawn(process.env.PERFCHECKER_TEST_XVFB,['-displayfd','3','-screen','0','1920x1080x24','-nolisten','tcp','-ac'],{stdio:['ignore','ignore','pipe','pipe']});
    displayExit=new Promise(resolve=>displayChild.once('exit',resolve));
    const display=await new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(new Error('Private tutorial Xvfb did not start')),15000);displayChild.once('error',error=>{clearTimeout(timer);reject(error);});displayChild.stdio[3].on('data',chunk=>{data+=chunk;const match=data.match(/^(\d+)\s*$/);if(match){clearTimeout(timer);resolve(`:${match[1]}`);}});displayChild.stderr.resume();});
    const privateEnv={...process.env,DISPLAY:display,XAUTHORITY:'',JULIA_DEPOT_PATH:path.join(setup,'depot'),JULIA_LOAD_PATH:['@','@stdlib'].join(path.delimiter),JULIA_NUM_THREADS:'2',JULIA_NUM_GC_THREADS:'1',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',JULIA_NUM_PRECOMPILE_TASKS:'1'};
    for(const key of ['WAYLAND_DISPLAY','JULIA_PROJECT','PERFCHECKER_TEST_CONTROLLER','PERFCHECKER_TEST_CODEX'])delete privateEnv[key];
    const wm=await startPrivateWindowManager(setup,privateEnv,state,resultFile,{reuseCache:mode!=='installation'});wmChild=wm.child;wmExit=wm.exit;
    const executable=await sdk.downloadAndUnzipVSCode({version:'1.141.0',cachePath:path.join(setup,'vscode'),timeout:Math.min(30000,remaining())});remaining();
    assert((await fs.realpath(executable)).startsWith(setup+path.sep));
    const app=path.join(path.dirname(executable),'resources/app');assert.equal(JSON.parse(await fs.readFile(path.join(app,'package.json'),'utf8')).version,'1.141.0');
    const cliSource=await fs.readFile(path.join(app,'out/cli.js'),'utf8');
    const flags=['shared-data-dir','agent-plugins-dir','agents-user-data-dir','agents-extensions-dir'];
    const privateProfile=[`--user-data-dir=${profile}`,`--extensions-dir=${extensions}`];
    for(const flag of flags){assert(cliSource.includes(`"${flag}":`));const directory=path.join(profile,flag);await fs.mkdir(directory,{recursive:true});privateProfile.push(`--${flag}=${directory}`);}
    if(mode==='installation'){
      await fs.mkdir(path.join(profile,'User'),{recursive:true});
      await fs.writeFile(path.join(profile,'User/settings.json'),JSON.stringify({'files.simpleDialog.enable':true,'window.dialogStyle':'custom','extensions.autoUpdate':false,'extensions.autoCheckUpdates':false,'editor.fontSize':22,'terminal.integrated.fontSize':22}));
    }
    const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
    const driver=path.join(output,'driver');await fs.mkdir(driver);await fs.writeFile(path.join(driver,'package.json'),JSON.stringify({name:'perfchecker-public-lesson-driver',publisher:'qualification',version:'0.0.0',engines:{vscode:'^1.96.0'}}));
    state.sdkStartedAt=new Date().toISOString();await fs.writeFile(resultFile,JSON.stringify(state,null,2));
    const sdkTimeout=new Promise((_,reject)=>{deadline=setTimeout(()=>{
      state.filmingTimedOut=true;state.timeoutObservedAt=new Date().toISOString();
      // These are the SDK's own handlers for its one private VS Code child.
      process.emit('SIGINT');
      forceDeadline=setTimeout(()=>{if(process.listeners('SIGINT').some(listener=>listener!==retainRunner))process.emit('SIGINT');},5000);
      drainDeadline=setTimeout(()=>reject(new Error('The public lesson exceeded its total filming deadline and SDK shutdown grace')),20000);
    },remaining());});
    const sdkRun=sdk.runTests({vscodeExecutablePath:executable,extensionDevelopmentPath:driver,extensionTestsPath:path.join(client,'test/bibliography-pilot-host.cjs'),
      launchArgs:[workspace,'--new-window','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-gpu','--ozone-platform=x11',...privateProfile,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],
      extensionTestsEnv:{...privateEnv,WAYLAND_DISPLAY:undefined,JULIA_PROJECT:undefined,PERFCHECKER_TEST_CONTROLLER:undefined,PERFCHECKER_TEST_CODEX:undefined,
        PERFCHECKER_PUBLIC_LESSON:mode,PERFCHECKER_PUBLIC_WORKSPACE:workspace,PERFCHECKER_PUBLIC_SETUP:setup,PERFCHECKER_PUBLIC_JULIA:julia,PERFCHECKER_PUBLIC_DEADLINE:String(globalDeadline),
        ...(reportsOnly?{PERFCHECKER_PUBLIC_EVIDENCE_DIRECTORIES:JSON.stringify(existingEvidenceDirectoriesBefore)}:{}),
        ...(mode==='installation-continuation'?{PERFCHECKER_PUBLIC_CONTROLLER_HASHES:JSON.stringify(controllerHashesBefore)}:{}),
        PERFCHECKER_HOST_SESSION:setup,PERFCHECKER_HOST_ARCHIVE:archive,PERFCHECKER_HOST_ARCHIVE_EXTENSION:path.join(output,'archive/extension'),
        PERFCHECKER_HOST_RESULT:resultFile,PERFCHECKER_FRAMING_OUTPUT:output,PERFCHECKER_HOST_CDP_PORT:String(port),PERFCHECKER_PRIVATE_DISPLAY:display,PERFCHECKER_PRIVATE_WM:JSON.stringify(wm.identity)}});
    await Promise.race([sdkRun,sdkTimeout]);assert(!state.filmingTimedOut,'A deadline-triggered shutdown never qualifies the lesson');
    state.sdkReturnedAt=new Date().toISOString();
  }catch(error){state.status='failed';state.error=String(error);state.stack=error.stack;throw error;}
  finally{
    clearTimeout(deadline);clearTimeout(forceDeadline);clearTimeout(drainDeadline);process.removeListener('SIGINT',retainRunner);
    if(reportsOnly)try{state.nativeEvidenceDirectoriesAfterSdk=(await fs.readdir(path.join(setup,'profile/User/globalStorage/mirage-interactive-fr.perfchecker-vscode/native-testitems'))).sort();assert.deepEqual(state.nativeEvidenceDirectoriesAfterSdk,existingEvidenceDirectoriesBefore,'A reports-only session must not create discovery or measurement evidence');}catch(error){state.evidenceInventoryError=String(error);state.error??=String(error);state.status='failed';}
    const receipt=await fs.readFile(resultFile,'utf8').then(JSON.parse).catch(()=>({}));
    const identities=new Map((receipt.nativeIdentities||[]).map(row=>[`${row.pid}/${row.start}`,row]));
    const shutdown={startedAt:new Date().toISOString(),scope:'Observed private native process incarnations; no claim about unobserved detached daemons',qualified:false,observations:[],errors:[]};state.nativeShutdown=shutdown;
    if(state.sdkStartedAt&&(!receipt.mainIdentity?.start||!identities.has(`${receipt.mainIdentity.pid}/${receipt.mainIdentity.start}`)||![...identities.values()].some(row=>row.pid===receipt.hostPid)))shutdown.errors.push({error:'The SDK window and extension host identities were not both observed'});
    const until=Date.now()+10000;
    do{
      const rows=[];for(const row of identities.values())try{assert(Number.isInteger(row.pid)&&row.pid>0&&/^\d+$/.test(row.start));const stat=await fs.readFile(`/proc/${row.pid}/stat`,'utf8').catch(error=>{if(['ENOENT','ESRCH'].includes(error.code))return undefined;throw error;});const fields=stat?.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/);if(fields)assert(/^\d+$/.test(fields[19]));rows.push({pid:row.pid,originalStart:row.start,start:fields?.[19]??null,state:fields?.[0]??'absent',originalIdentityGone:!fields||fields[19]!==row.start||/^[ZX]$/.test(fields[0])});}catch(error){shutdown.errors.push({pid:row.pid,error:String(error)});rows.push({pid:row.pid,originalIdentityGone:false});}
      shutdown.observations.push({at:new Date().toISOString(),rows});if(rows.every(row=>row.originalIdentityGone))break;await new Promise(resolve=>setTimeout(resolve,100));
    }while(Date.now()<until);
    shutdown.finishedAt=new Date().toISOString();nativeShutdownQualified=shutdown.qualified=identities.size>0&&!shutdown.errors.length&&shutdown.observations.at(-1).rows.every(row=>row.originalIdentityGone);
    if(wmChild?.pid&&wmChild.exitCode===null&&wmChild.signalCode===null){wmChild.kill('SIGTERM');await Promise.race([wmExit,new Promise(resolve=>setTimeout(resolve,2000))]);if(wmChild.exitCode===null&&wmChild.signalCode===null){wmChild.kill('SIGKILL');await wmExit;}}
    if(displayChild?.pid&&displayChild.exitCode===null&&displayChild.signalCode===null){displayChild.kill('SIGTERM');await Promise.race([displayExit,new Promise(resolve=>setTimeout(resolve,2000))]);if(displayChild.exitCode===null&&displayChild.signalCode===null){displayChild.kill('SIGKILL');await displayExit;}}
    if(wmChild?.pid){
      const stat=await fs.readFile(`/proc/${wmChild.pid}/stat`,'utf8').catch(error=>{if(['ENOENT','ESRCH'].includes(error.code))return undefined;throw error;}),fields=stat?.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/),start=state.windowManagerStartup.childIdentity?.start;
      state.windowManagerCleanup={pid:wmChild.pid,originalStart:start??null,observedStart:fields?.[19]??null,state:fields?.[0]??'absent',originalIdentityGone:Boolean(start)&&(!fields||/^[ZX]$/.test(fields[0])||fields[19]!==start)};
      if(!state.windowManagerCleanup.originalIdentityGone)state.error??='The private WM disappearance is unqualified';
    }
    state.finishedAt=new Date().toISOString();state.retainedSetup='Private installed profile/depot retained for the separately authorized next chapter; no human profile is used';
    const passed=receipt.status==='passed'&&nativeShutdownQualified&&!state.error;state.status=passed?'passed':'failed';
    await fs.writeFile(resultFile,JSON.stringify({...receipt,...state,hostError:receipt.error??null,hostStack:receipt.stack??null,runnerState:state},null,2));
    console.log(`Public lesson evidence: ${resultFile}`);console.log(JSON.stringify({status:state.status,nativeShutdownQualified,setup,output}));
    if(!passed)throw new Error('Public lesson or native shutdown failed; setup and evidence preserved');
  }
}
if(process.env.PERFCHECKER_PUBLIC_LESSON){
  assert.notEqual(process.env.PERFCHECKER_STUDIO_THEME_ONLY,'1');assert.notEqual(process.env.PERFCHECKER_FRAMING_ONLY,'1');assert.notEqual(process.env.PERFCHECKER_WORKER_PREFLIGHT_ONLY,'1');
  await runPublicLesson(process.env.PERFCHECKER_PUBLIC_LESSON);
  process.exit(0);
}
if(process.env.PERFCHECKER_STUDIO_THEME_ONLY==='1'){
  assert.notEqual(process.env.PERFCHECKER_WORKER_PREFLIGHT_ONLY,'1');assert.notEqual(process.env.PERFCHECKER_FRAMING_ONLY,'1');
  await runFramingOnly({studioThemes:true});
}else if(process.env.PERFCHECKER_WORKER_PREFLIGHT_ONLY==='1'){
  console.log(JSON.stringify(await preflightMeasurementWorker(),null,2));
}else if(process.env.PERFCHECKER_FRAMING_ONLY==='1'){
  await runFramingOnly();
}else{
if(process.env.CI)throw new Error('Authenticated Codex qualification is local-only. Never transfer authentication to CI.');
if(process.platform!=='linux')throw new Error('This isolated display qualification currently requires Linux and a private Xvfb.');
for(const name of ['PERFCHECKER_TEST_CONTROLLER','PERFCHECKER_TEST_CODEX','PERFCHECKER_TEST_JULIA','PERFCHECKER_TEST_VSIX'])
  if(!process.env[name]||!path.isAbsolute(process.env[name]))throw new Error(`Provide an absolute ${name} path.`);
const archive=await fs.realpath(process.env.PERFCHECKER_TEST_VSIX);
assert.equal(createHash('sha256').update(await fs.readFile(archive)).digest('hex'),vsixSha,'Use the approved VSIX bytes, not a development build');
assert.equal((await fs.stat(archive)).size,1031159);
process.env.PERFCHECKER_CODEX_HOST_ONLY='1';
process.env.PERFCHECKER_TEST_EXTENSION_PATH='/home/azzaare/Gits/PerfCheckerVSCode-native-plots';
const {stopObservedCodexProcesses,ownedProcessState}=await import('./codex-real.test.mjs');
const sdk=await import(process.env.PERFCHECKER_TEST_ELECTRON?pathToFileURL(process.env.PERFCHECKER_TEST_ELECTRON).href:'@vscode/test-electron');
const session=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-codex-host-'));
let displayChild,displayExit,wmChild,wmExit,wmIdentity,sessionMayRemove=true,expired=false,forceDeadline;
const pilotRunnerState={mode:'bibliography-pilot',status:'starting',startedAt:new Date().toISOString(),windowManagerStartup:{status:'not-started',stderr:''}};
// The SDK's own SIGINT handler first closes its private VS Code gracefully;
// its second handler stops that same process tree. Owned detached workers are
// independently identity-checked below before any temporary files are removed.
const deadline=setTimeout(()=>{
  expired=true;process.emit('SIGINT');
  forceDeadline=setTimeout(()=>process.emit('SIGINT'),45000);
},18*60*1000);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  const root=await fs.realpath(mediaWorkspace),profile=path.join(session,'profile'),extensions=path.join(session,'extensions');
  assert.equal((await execute('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim(),'2e86892401536ca4cfd20eb45c00e98168b482a3');
  assert.equal((await execute('git',['status','--porcelain'],{cwd:root})).stdout,'');
  const workerPreflight=await preflightMeasurementWorker();
  await fs.mkdir(path.join(root,'.vscode'),{recursive:true});
  await fs.writeFile(path.join(root,'.perfchecker-test-fixture'),'sacrificial\n');
  await fs.writeFile(path.join(root,'perf','advisor.json'),JSON.stringify({protocol:'mcp_http',endpoint:'https://previous.example.invalid/mcp',mcp_tool:'previous_advice'}));
  await fs.writeFile(path.join(root,'.vscode','settings.json'),JSON.stringify({
    'perfchecker.runnerProject':process.env.PERFCHECKER_TEST_CONTROLLER,'perfchecker.scenarioProject':path.join(root,'perf/media/scenario-worker'),
    'perfchecker.scenarioThreads':2,'perfchecker.scenarioSamples':100,'perfchecker.analysisTimeout':180,
    'perfchecker.juliaExecutable':process.env.PERFCHECKER_TEST_JULIA,'perfchecker.codexExecutable':process.env.PERFCHECKER_TEST_CODEX,
    'perfchecker.advisorConfig':'perf/advisor.json','perfchecker.advisorEnabled':false,'perfchecker.advisorImplementationMcpTool':'previous_agent','perfchecker.advisorTimeout':180,
    'telemetry.telemetryLevel':'off','workbench.startupEditor':'none','window.restoreWindows':'none'}));
  const core=JSON.parse((await execute(process.env.PERFCHECKER_TEST_JULIA,['--startup-file=no',`--project=${process.env.PERFCHECKER_TEST_CONTROLLER}`,'-e','using PerfChecker; PerfChecker.JSON.print(Dict("path"=>pkgdir(PerfChecker),"version"=>string(Base.pkgversion(PerfChecker))))'],{timeout:120000})).stdout);
  assert.equal(core.version,'1.0.1');assert.equal(core.path,'/home/azzaare/.julia/dev/PerfChecker-media-core-context-20261009');
  core.sourceCommit=(await execute('git',['rev-parse','HEAD'],{cwd:core.path})).stdout.trim();
  core.sourceTree=(await execute('git',['rev-parse','HEAD^{tree}'],{cwd:core.path})).stdout.trim();
  assert.equal(core.sourceCommit,'51d369ab86a9f404869164cc2bd06acf2478b409');
  assert.equal(core.sourceTree,'c5b31ff939afddf1d9fb476be4953bd904ea6442');
  assert.equal((await execute('git',['status','--porcelain'],{cwd:core.path})).stdout,'');
  core.sourceStatus='qualified candidate, not a registered release';
  core.sourcePullRequest='https://github.com/Mirage-Interactive-Fr/PerfChecker.jl/pull/143';
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
  delete privateEnv.WAYLAND_DISPLAY;
  const windowManager=await startPrivateWindowManager(session,privateEnv,pilotRunnerState,path.join(session,'result.json'));
  wmChild=windowManager.child;wmExit=windowManager.exit;wmIdentity=windowManager.identity;
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
  await execute(cli,[...cliArgs,...privateProfile,'--ozone-platform=x11','--install-extension',archive],{env:privateEnv,timeout:120000});
  const portServer=createServer();await new Promise((resolve,reject)=>{portServer.once('error',reject);portServer.listen(0,'127.0.0.1',resolve);});
  const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
  // VS Code requires a development location to execute its test runner. This
  // neutral manifest supplies it without loading any development product code.
  const driver=path.join(session,'driver');await fs.mkdir(driver);
  await fs.writeFile(path.join(driver,'package.json'),JSON.stringify({name:'perfchecker-local-authentication-driver',publisher:'qualification',version:'0.0.0',engines:{vscode:'^1.96.0'}}));
  assert(!expired,'The local runner exceeded its eighteen-minute total deadline before launch');
  await sdk.runTests({vscodeExecutablePath,extensionDevelopmentPath:driver,extensionTestsPath:path.join(client,'test','bibliography-pilot-host.cjs'),
    launchArgs:[root,'--new-window','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-gpu','--ozone-platform=x11',
      ...privateProfile,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],
    extensionTestsEnv:{...privateEnv,WAYLAND_DISPLAY:undefined,PERFCHECKER_PRIVATE_DISPLAY:display,PERFCHECKER_PRIVATE_WM:JSON.stringify(wmIdentity),PERFCHECKER_HOST_RESULT:path.join(session,'result.json'),
      PERFCHECKER_HOST_SESSION:session,PERFCHECKER_HOST_ARCHIVE:archive,PERFCHECKER_HOST_ARCHIVE_EXTENSION:archiveExtension,
      PERFCHECKER_HOST_VSIX_SHA:vsixSha,PERFCHECKER_HOST_CDP_PORT:String(port),PERFCHECKER_HOST_BASELINE_BYTES:'4080',
      PERFCHECKER_HOST_CORE:JSON.stringify(core),PERFCHECKER_WORKER_PREFLIGHT:JSON.stringify(workerPreflight),PERFCHECKER_CODEX_HOST_ONLY:'1',
      PERFCHECKER_MEDIA_OUTPUT:mediaOutput,PERFCHECKER_MEDIA_WORKSPACE:root,
      PERFCHECKER_UUID:'0615b0bc-7e5b-4b7c-baf7-f50fdd726d6a',JULIA_NUM_THREADS:'2',JULIA_NUM_PRECOMPILE_TASKS:'1',JULIA_NUM_GC_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
  const result=JSON.parse(await fs.readFile(path.join(session,'result.json'),'utf8'));
  assert(!expired,'The local runner exceeded its eighteen-minute total deadline');
  assert.equal(result.runner,'bibliography-pilot-host.cjs');assert.equal(result.hostExecuted,true);
  assert.equal(result.cleanupSafeToRemove,true);
  assert.equal(result.vsixSha256,vsixSha);assert.equal(result.status,'passed');await fs.writeFile(path.join(mediaOutput,'perfchecker-episode-00-mcp-dialogue.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){
  pilotRunnerState.status='failed';pilotRunnerState.error=String(error);
  if(error.workerPreflight)pilotRunnerState.workerPreflight=error.workerPreflight;
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
  if(wmChild?.pid&&wmChild.exitCode===null&&wmChild.signalCode===null){
    wmChild.kill('SIGTERM');await Promise.race([wmExit,delay(2000)]);
    if(wmChild.exitCode===null&&wmChild.signalCode===null){wmChild.kill('SIGKILL');await wmExit;}
  }
  if(wmIdentity){
    const stat=await fs.readFile(`/proc/${wmIdentity.pid}/stat`,'utf8').catch(()=>undefined),fields=stat?.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/);
    pilotRunnerState.windowManagerCleanup={pid:wmIdentity.pid,start:wmIdentity.start,observedStart:fields?.[19]??null,originalIdentityGone:!fields||fields[0]==='Z'||fields[19]!==wmIdentity.start};
    assert(pilotRunnerState.windowManagerCleanup.originalIdentityGone,'The same private WM must stop before its config is removed');
    const result=await fs.readFile(path.join(session,'result.json'),'utf8').then(JSON.parse).catch(()=>undefined);
    if(result){result.pilotRunnerState=pilotRunnerState;if(result.status==='passed')await fs.writeFile(path.join(mediaOutput,'perfchecker-episode-00-mcp-dialogue.json'),JSON.stringify(result,null,2));}
  }
  if(displayChild?.pid&&displayChild.exitCode===null&&displayChild.signalCode===null){
    displayChild.kill('SIGTERM');await Promise.race([displayExit,delay(2000)]);
    if(displayChild.exitCode===null&&displayChild.signalCode===null){displayChild.kill('SIGKILL');await displayExit;}
  }
  if(pilotRunnerState.status==='failed'){
    const result=await fs.readFile(path.join(session,'result.json'),'utf8').then(JSON.parse).catch(()=>({}));
    const retainedFailure=path.join(mediaOutput,`perfchecker-episode-00-mcp-dialogue-failed-${pilotRunnerState.startedAt.replace(/[:.]/g,'-')}.json`);
    await fs.writeFile(retainedFailure,JSON.stringify({...result,status:'failed',pilotRunnerState},null,2),{flag:'wx'});
    console.error(`Immutable failed take receipt: ${retainedFailure}`);
  }
  if(sessionMayRemove){await fs.rm(session,{recursive:true,force:true});await fs.rm(path.join(mediaWorkspace,'.vscode'),{recursive:true,force:true});await fs.rm(path.join(mediaWorkspace,'.perfchecker-test-fixture'),{force:true});await fs.rm(path.join(mediaWorkspace,'perf','advisor.json'),{force:true});}
  else console.error(`Failed session preserved while process cleanup is unresolved: ${session}`);
}
}
