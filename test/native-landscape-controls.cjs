// Opt-in native command qualification with the real Landscape game and SDL/Vulkan.
// The runner supplies a disposable tag checkout, its pinned SDK environment and
// a private Xvfb display. This module never replaces VS Code or provider APIs.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {createHash,randomUUID}=require('node:crypto');

const execute=promisify(execFile);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const gameCommit='dc8124a0cc35977ca26316450e8b688abd6ab6b8';
const quality='mobile-leger';
const title=`PerfChecker · live graphics · ${quality}`;
const sdk={
  EtenduContracts:['0a129097a06ce36b10657e901a6039d2588a8042','efc4e7ed302b253142b20b7dbe2f2f592d3ec4cfe8ebf5dfc7ee16608e6bebd0'],
  EtenduNativeArtifacts:['9ae20356d9205d6c74b70bcb0996752d20c12c6c','f59124db09e24551e4dcebb3b9eb6c2e97fc85f8760635290518540369e88979'],
  EtenduRender:['884493d4fc9ac0188d2399eef1dd77410b423ef3','5818e9e543b206c54bd7d026ae0a1cbfec10772022c966fa0b85b47cfd939e5f'],
  EtenduRuntime:['f848c18a144e2cc8cae9c7dcf102de943aad21cc','9e7021f0d9c1c2d68aeeef1fece7a5cba00ceb5f75c23a0a8c3b1df80470cf09'],
  EtenduSDLGPU:['d0455b1dcbefcd1cc8b6085f341c18f5a13115c7','9171345a5675fb750af010dc023f4872fa72dded07fd16c4840a330c14ce9dcc'],
};

async function eventually(read,label,timeout,deadline){
  const until=Math.min(Date.now()+timeout,deadline);let last;
  while(Date.now()<until){
    try{const value=await read();if(value)return value;}catch(error){last=error;}
    await delay(100);
  }
  throw new Error(`${label}${last?`: ${last.message}`:''}`);
}
async function bounded(promise,label,timeout,deadline){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label)),Math.max(1,Math.min(timeout,deadline-Date.now())));
  })]);}finally{clearTimeout(timer);}
}
async function command(executable,args,options={}){
  const result=await execute(executable,args,{encoding:'utf8',timeout:120000,maxBuffer:4000000,...options});
  return result.stdout.trim();
}
async function sourceDigest(root,relative=''){
  const records=[];
  for(const entry of (await fs.readdir(path.join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
    const name=path.posix.join(relative,entry.name);
    if(entry.isDirectory())records.push(...await sourceDigest(root,name));
    else{assert(entry.isFile(),'The resolved SDK archive contains regular files');records.push(name+'\0'+digest(await fs.readFile(path.join(root,name)))+'\0');}
  }
  return records;
}
async function memSnapshot(roots){
  const records={};
  async function walk(root,label,relative=''){
    for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
      if(entry.name==='.git')continue;
      const name=path.posix.join(relative,entry.name);
      if(entry.isDirectory())await walk(root,label,name);
      else if(entry.isFile()&&entry.name.endsWith('.mem'))records[label+'/'+name]=digest(await fs.readFile(path.join(root,name)));
    }
  }
  for(const [label,root]of Object.entries(roots))await walk(root,label);
  return Object.fromEntries(Object.entries(records).sort(([a],[b])=>a.localeCompare(b)));
}
async function processIdentity(pid){
  const text=await fs.readFile(`/proc/${pid}/stat`,'utf8').catch(error=>{if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;});
  if(!text)return null;
  const fields=text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/);
  return {pid,state:fields[0],parent:Number(fields[1]),group:Number(fields[2]),started:fields[19]};
}
async function living(records){
  const result=[];
  for(const record of records.values()){
    const current=await processIdentity(record.pid);
    if(current?.started===record.started&&current.state!=='Z')result.push(current);
  }
  return result;
}
async function children(pid,started){
  const before=await processIdentity(pid);if(!before||before.state==='Z'||started!==undefined&&before.started!==started)return [];
  const tasks=await fs.readdir(`/proc/${pid}/task`).catch(error=>{if(error.code==='ENOENT'||error.code==='ESRCH')return [];throw error;});
  const found=new Set();
  for(const tid of tasks.filter(name=>/^\d+$/.test(name))){
    const text=await fs.readFile(`/proc/${pid}/task/${tid}/children`,'utf8').catch(error=>{if(error.code==='ENOENT'||error.code==='ESRCH')return '';throw error;});
    for(const child of text.trim().split(/\s+/).filter(Boolean).map(Number))found.add(child);
  }
  const after=await processIdentity(pid);
  return after?.started===before.started&&after.state!=='Z'?[...found]:[];
}
async function trackTree(pid,records,role,provider,parent,started){
  const current=await processIdentity(pid);if(!current||current.state==='Z')return;
  if(parent!==undefined&&current.parent!==parent||started!==undefined&&current.started!==started)return;
  const old=records.get(pid);
  assert(!old||old.started===current.started,'A PID cannot change identity inside the observed owned tree');
  const argv=(await fs.readFile(`/proc/${pid}/cmdline`).catch(error=>{if(error.code==='ENOENT'||error.code==='ESRCH')return Buffer.alloc(0);throw error;})).toString().split('\0');
  if(argv.includes(provider)&&!argv.includes('-e'))role='renderer';
  records.set(pid,{...current,role:role==='renderer'?role:old?.role||role});
  for(const child of await children(pid,current.started))await trackTree(child,records,'provider-descendant',provider,pid);
}
function observe(root,reports,records){
  const provider=path.join(root,'perf','live_provider.jl');
  let pending=Promise.resolve(),error;
  const inspect=async()=>{
    for(const pid of await children(process.pid)){
      const current=await processIdentity(pid);if(!current||current.parent!==process.pid)continue;
      const argv=(await fs.readFile(`/proc/${pid}/cmdline`).catch(e=>{if(e.code==='ENOENT'||e.code==='ESRCH')return Buffer.alloc(0);throw e;})).toString().split('\0');
      if(argv.includes(root)&&argv.includes(reports)&&argv.some(arg=>arg.includes('PERFCHECKER_LIVE_BUNDLE')||arg.includes('NATIVE_LANDSCAPE_SDK')))
        await trackTree(pid,records,argv.some(arg=>arg.includes('NATIVE_LANDSCAPE_SDK'))?'sdk-probe':'controller',provider,process.pid,current.started);
    }
    for(const record of [...records.values()]){
      const current=await processIdentity(record.pid);
      if(current?.started===record.started&&current.state!=='Z')await trackTree(record.pid,records,record.role,provider,undefined,record.started);
    }
  };
  const schedule=()=>pending=pending.then(inspect).catch(e=>{error??=e;});
  const timer=setInterval(schedule,50);
  return {async sample(){await schedule();if(error)throw error;},async stop(){clearInterval(timer);await schedule();if(error)throw error;}};
}
async function renderedFrame(display){
  const tree=await command('xwininfo',['-display',display,'-root','-tree'],{timeout:5000});
  const window=tree.match(/(0x[0-9a-f]+) "Beautiful Landscape/);if(!window)return null;
  const {stdout}=await execute('xwd',['-display',display,'-id',window[1],'-silent'],{encoding:'buffer',timeout:5000,maxBuffer:5000000});
  const header=Array.from({length:25},(_,i)=>stdout.readUInt32BE(4*i));
  assert.equal(header[1],7);assert.equal(header[4],960);assert.equal(header[5],540);assert.equal(header[11],32);
  const pixels=stdout.subarray(header[0]+12*header[19]),colors=new Set();
  for(let i=0;i+4<=pixels.length;i+=4*13)colors.add((header[7]===0?pixels.readUInt32LE(i):pixels.readUInt32BE(i))&0xffffff);
  return colors.size<100?null:{sha256:digest(pixels),sampledColors:colors.size};
}
async function stopObserved(records,log,observer){
  // Failure cleanup only. The positive oracle has already required an empty tree.
  const terminatedOwnedPids=new Set();
  let observationError;
  for(const signal of ['SIGTERM','SIGKILL']){
    const signalled=new Set();
    const until=Date.now()+(signal==='SIGTERM'?5000:2000);
    do{
      try{await observer?.sample();}catch(error){observationError??=error;}
      for(const record of (await living(records)).reverse()){
        const identity=record.pid+'/'+record.started,current=await processIdentity(record.pid);
        if(signalled.has(identity)||current?.started!==record.started||current.state==='Z')continue;
        try{process.kill(record.pid,signal);signalled.add(identity);terminatedOwnedPids.add(record.pid);}catch(error){if(error.code!=='ESRCH')throw error;}
      }
      if(!(await living(records)).length)break;
      await delay(100);
    }while(Date.now()<until);
    if(!(await living(records)).length)break;
  }
  const remaining=await living(records);
  log('native-landscape-failure-teardown',{terminatedOwnedPids:[...terminatedOwnedPids],survivingOwnedPids:remaining.map(x=>x.pid)});
  assert.deepEqual(remaining,[],'Only identity-checked owned workers may be stopped, and must die before deleting fixture files');
  if(observationError)throw observationError;
}

exports.run=async context=>{
  assert.equal(process.platform,'linux','This software renderer qualification uses Linux/X11 process identities');
  assert.equal(process.env.CI,'true','Only the disposable native host is supported');
  assert.equal(process.env.PERFCHECKER_NATIVE_PHASE,'landscape');
  const {vscode,windowPage}=context,deadline=Date.now()+420000;
  const session=await fs.realpath(process.env.PERFCHECKER_NATIVE_SESSION);
  assert.match(path.basename(session),/^pc-vsix-/,'Use the existing runner-owned native session');
  const insideSession=location=>{const relative=path.relative(session,location);return !!relative&&!path.isAbsolute(relative)&&relative.split(path.sep)[0]!=='..';};
  assert(insideSession(await fs.realpath(process.env.PERFCHECKER_NATIVE_PROFILE)),'The native host uses a private runner profile');
  const root=await fs.realpath(process.env.PERFCHECKER_NATIVE_LANDSCAPE_WORKSPACE);
  const relative=path.relative(session,root);
  assert(relative&&!path.isAbsolute(relative)&&relative.split(path.sep)[0]!=='..','The game must be a disposable runner-owned checkout');
  const controller=await fs.realpath(context.controller),julia=process.env.PERFCHECKER_NATIVE_JULIA;
  assert(path.isAbsolute(julia),'The runner supplies its actual Julia executable');
  assert.notEqual(root,controller,'The Core controller and game project remain separate');
  const uri=vscode.Uri.file(root);
  assert.equal(vscode.workspace.getWorkspaceFolder(uri)?.uri.toString(),uri.toString(),'The game is an actual open workspace folder');
  const extension=vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');
  assert(extension?.isActive,'The installed VSIX is activated by the native host');
  assert(!extension.extensionPath.includes('qualification-host'));
  assert(insideSession(await fs.realpath(extension.extensionPath)),'The product is installed in the private runner session, not a user extension directory');
  assert.match(process.env.PERFCHECKER_NATIVE_SHA||'',/^[0-9a-f]{64}$/);
  const git=args=>command('git',args,{cwd:root});
  assert.equal(await git(['rev-parse','HEAD']),gameCommit);
  const protectedPaths=['Project.toml','EtenduGame.toml','src','content/scenes','config/quality.toml','perf/live_provider.jl','perf/live_measure.jl'];
  assert.equal(await git(['diff','--name-only',gameCommit,'--',...protectedPaths]),'','No generated or modified provider replaces the game tag');
  const lfs=JSON.parse(await git(['lfs','ls-files','--json',gameCommit])).files;
  assert.equal(lfs.length,143);let lfsBytes=0;
  for(const item of lfs){const bytes=await fs.readFile(path.join(root,item.name));assert.equal(bytes.length,item.size);assert.equal(digest(bytes),item.oid);lfsBytes+=bytes.length;}
  assert.equal(lfsBytes,384633618);
  const display=process.env.DISPLAY;
  assert.match(display||'',/^:\d+(?:\.\d+)?$/);
  assert.equal(process.env.SDL_VIDEODRIVER,'x11');assert.equal(process.env.SDL_GPU_DRIVER,'vulkan');
  assert.match(process.env.VK_ICD_FILENAMES||'',/\/lvp_icd(?:\.x86_64)?\.json$/,'The host explicitly selects the software Vulkan ICD');
  const vulkan=await command('vulkaninfo',['--summary']);
  assert.match(vulkan,/llvmpipe/);assert.match(vulkan,/PHYSICAL_DEVICE_TYPE_CPU/);
  const settings=()=>vscode.workspace.getConfiguration('perfchecker',uri);
  const keys=['juliaExecutable','runnerProject'],previous=Object.fromEntries(keys.map(key=>[key,settings().inspect(key)?.workspaceFolderValue]));
  const reports=path.join(root,'perf','results','live'),roots={game:root,controller},baselineMem=await memSnapshot(roots);
  const qualityDigest=digest(await fs.readFile(path.join(root,'config','quality.toml'))),sceneDigest=digest(await fs.readFile(path.join(root,'content','scenes','beautiful_landscape.toml')));
  const sentinel=path.join(root,`native-landscape-unrelated-${randomUUID()}.mem`),sentinelBytes=Buffer.from('Unrelated allocation trace must survive native cancellation.\n');
  const records=new Map();let observer,foreign,foreignIdentity,primaryError,invocation,resolved,settled=true;
  const notification=()=>windowPage.locator('.notification-list-item').filter({hasText:title});
  const cancel=async()=>{
    await vscode.commands.executeCommand('notifications.showList');
    const owned=notification();assert.equal(await owned.count(),1,'Select only the live graphics progress notification');
    await owned.getByRole('button',{name:'Cancel',exact:true}).click();
  };
  const start=()=>{settled=false;return invocation=Promise.resolve(vscode.commands.executeCommand('perfchecker.runLandscapeLiveForWorkspace',uri,quality))
    .then(directory=>{settled=true;return {ok:true,directory};},error=>{settled=true;return {ok:false,error};});};
  try{
    for(const [key,value]of Object.entries({juliaExecutable:julia,runnerProject:controller}))await settings().update(key,value,vscode.ConfigurationTarget.WorkspaceFolder);
    observer=observe(root,reports,records);
    const workerCode='using EtenduBeautifulLandscape,EtenduContracts,EtenduNativeArtifacts,EtenduRender,EtenduRuntime,EtenduSDLGPU,JSON3; println("NATIVE_LANDSCAPE_SDK "*JSON3.write([Dict("name"=>string(nameof(m)),"version"=>string(Base.pkgversion(m)),"root"=>pkgdir(m)) for m in (EtenduContracts,EtenduNativeArtifacts,EtenduRender,EtenduRuntime,EtenduSDLGPU)]))';
    const worker=await command(julia,['--startup-file=no','--history-file=no',`--project=${root}`,'-e',workerCode,'--',root,reports],{env:{...process.env,JULIA_LOAD_PATH:'@:@stdlib'}});
    resolved=JSON.parse(worker.match(/^NATIVE_LANDSCAPE_SDK (.+)$/m)?.[1]||'null');
    assert.equal(resolved?.length,5);
    for(const dependency of resolved){assert(sdk[dependency.name]);assert.equal(dependency.version,'0.1.1');assert.equal(digest((await sourceDigest(dependency.root)).join('')),sdk[dependency.name][1]);}
    await observer.sample();assert.deepEqual(await living(records),[],'SDK preparation leaves no child alive');records.clear();
    const completed=await bounded(start(),'The real native Landscape command completes its measurement',180000,deadline);
    assert.equal(completed.ok,true,String(completed.error));
    const directory=await fs.realpath(completed.directory);
    assert.equal(path.dirname(directory),await fs.realpath(reports));
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath,vscode.Uri.file(path.join(directory,'manifest.json')).fsPath,'The installed command opens its actual completed manifest');
    const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
    const integrity=JSON.parse(await fs.readFile(path.join(directory,'integrity.json'),'utf8'));
    assert.equal(manifest.schema_version,'perfchecker-run-bundle/1');assert.equal(manifest.state,'complete');assert.equal(manifest.suite,'etendu-beautiful-landscape-live');
    assert.equal(integrity.schema_version,'perfchecker-bundle-integrity/1');assert.equal(integrity.algorithm,'sha256');
    assert.deepEqual(new Set(integrity.files.map(x=>x.path)),new Set(['manifest.json','measurement-definitions.json','observations.jsonl','diagnostics.jsonl','artifacts.json']));
    for(const file of integrity.files){const bytes=await fs.readFile(path.join(directory,file.path));assert.equal(bytes.length,file.bytes);assert.equal(digest(bytes),file.sha256);}
    const environment=manifest.environment;
    for(const [key,value]of Object.entries({quality_profile:quality,width:960,height:540,requested_frames:60,warmup_frames:20,measured_submissions:40,scene_sha256:sceneDigest,scene_file_changed_during_run:false,gpu_timing:'unavailable',physical_presentation:'unavailable'}))assert.equal(environment[key],value);
    assert.equal(environment.hardware.gpu_driver,'vulkan');
    const observations=(await fs.readFile(path.join(directory,'observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(observations.length,6);
    assert.deepEqual(new Set(observations.map(x=>x.metric)),new Set(['cpu','submit_interval'].flatMap(kind=>['median','p95','p99'].map(stat=>`landscape.${kind}.${stat}`))));
    for(const observation of observations){assert.equal(observation.unit,'ms');assert(Number.isFinite(observation.value)&&observation.value>=0);}
    await observer.sample();assert([...records.values()].some(x=>x.role==='controller')&&[...records.values()].some(x=>x.role==='renderer'),
      'The command owns an actual Core controller and game provider, not only an opened JSON file');
    assert.deepEqual(await living(records),[]);assert.deepEqual(await memSnapshot(roots),baselineMem);
    assert.equal(digest(await fs.readFile(path.join(root,'config','quality.toml'))),qualityDigest);
    context.proof('native-landscape-command-completed',{nativeCommand:true,command:'perfchecker.runLandscapeLiveForWorkspace',workspace:uri.toString(),quality,
      installedPath:extension.extensionPath,vsixSha256:process.env.PERFCHECKER_NATIVE_SHA,core:context.core,gameCommit,lfsFiles:lfs.length,lfsBytes,
      sdk:resolved.map(d=>({name:d.name,version:d.version,commit:sdk[d.name][0],sourceSha256:sdk[d.name][1]})),manifestOpened:true,
      integrityDocuments:integrity.files.length,manifestSha256:digest(await fs.readFile(path.join(directory,'manifest.json'))),sceneSha256:sceneDigest,
      measuredSubmissions:40,observations,noOwnedProcessesBeforeTeardown:true,noNewMem:true,scope:'SDL/Vulkan llvmpipe software rendering; GPU timing and physical presentation unavailable'});

    const beforeReports=(await fs.readdir(reports)).sort();
    await fs.writeFile(sentinel,sentinelBytes,{flag:'wx'});
    foreign=spawn(process.execPath,['-e','process.stdout.write("NATIVE_FOREIGN_READY\\n");setInterval(()=>{},1000)'],
      {env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});
    const foreignReady=new Promise((resolve,reject)=>{let text='';foreign.stdout.on('data',bytes=>{text+=bytes;if(text.includes('NATIVE_FOREIGN_READY'))resolve();});foreign.once('error',reject);foreign.once('exit',()=>reject(new Error('The unrelated native fixture exits before readiness')));});
    void foreignReady.catch(()=>{});
    foreignIdentity=await processIdentity(foreign.pid);assert.equal(foreignIdentity?.parent,process.pid);
    await bounded(foreignReady,
      'The unrelated fixture reaches readiness',10000,deadline);
    records.clear();start();let first;
    const changed=await eventually(async()=>{
      await observer.sample();assert.equal(settled,false,'The active renderer must still be measuring before its native Cancel');
      const current=await renderedFrame(display);if(!current)return false;
      if(!first){first=current;return false;}return current.sha256!==first.sha256?current:false;
    },'Observe two different actual rendered scene buffers before cancellation',75000,deadline);
    const activeBefore=await living(records),activeIds=new Set(activeBefore.map(x=>x.pid));
    assert([...records.values()].some(x=>x.role==='controller'&&activeIds.has(x.pid))&&[...records.values()].some(x=>x.role==='renderer'&&activeIds.has(x.pid)),
      'The actual controller and rendering provider are both alive before Cancel');
    const ownedBefore=[...records.values()].map(({pid,parent,group,started,role})=>({pid,parent,group,started,role}));
    context.log('native-landscape-before-cancel',{owned:ownedBefore,foreign:foreignIdentity.pid,renderedBuffers:[first,changed]});
    await cancel();
    const cancelled=await bounded(invocation,'Native progress Cancel waits for real controller cleanup',75000,deadline);
    assert.equal(cancelled.ok,false);assert.match(String(cancelled.error),/Live measurement cancelled/i);
    await observer.sample();assert.deepEqual(await living(records),[],'All observed owned processes exit before harness teardown');
    const foreignAfter=await processIdentity(foreignIdentity.pid);
    assert.equal(foreignAfter?.started,foreignIdentity.started,'The unrelated process keeps its identity');assert.notEqual(foreignAfter.state,'Z','The unrelated process stays alive');
    assert.deepEqual((await fs.readdir(reports)).sort(),beforeReports,'Cancelled rendering publishes no completed bundle');
    assert.equal(digest(await fs.readFile(sentinel)),digest(sentinelBytes));
    const expectedMem={...baselineMem,[`game/${path.basename(sentinel)}`]:digest(sentinelBytes)};
    assert.deepEqual(await memSnapshot(roots),Object.fromEntries(Object.entries(expectedMem).sort(([a],[b])=>a.localeCompare(b))));
    assert.equal(await git(['diff','--name-only',gameCommit,'--',...protectedPaths]),'');
    context.proof('native-landscape-cancel-owned-renderer',{nativeProgressCancelClick:true,command:'perfchecker.runLandscapeLiveForWorkspace',quality,
      core:context.core,vsixSha256:process.env.PERFCHECKER_NATIVE_SHA,gameCommit,ownedBefore,pidsDeadBeforeHarnessCleanup:true,
      changedSceneBuffers:true,sampledColors:changed.sampledColors,unrelatedProcessPreserved:true,preExistingMemPreserved:true,noNewMem:true,
      cancelledReportsUnchanged:true,scope:'Owned native controller/provider and fixture .mem inventory; no physical GPU or arbitrary user callback guarantee'});
  }catch(error){primaryError=error;throw error;}
  finally{
    const errors=[];let observerFailed=false;
    if(!settled&&invocation)try{await cancel();await bounded(invocation,'Failure cancellation finishes',75000,Date.now()+75000);}catch(error){errors.push(error);}
    if(observer){
      try{await observer.sample();}catch(error){observerFailed=true;errors.push(error);}
    }
    if((await living(records)).length){
      errors.push(new Error('Native Landscape left owned processes alive; harness teardown cannot turn that failure into PASS'));
      try{await stopObserved(records,context.log,observer);}catch(error){errors.push(error);}
    }
    if(foreign){
      try{
        const current=await processIdentity(foreign.pid);
        if(foreignIdentity?.parent===process.pid&&current?.started===foreignIdentity.started&&current.state!=='Z')foreign.kill('SIGTERM');
        const finished=new Promise(resolve=>{if(foreign.exitCode!==null||foreign.signalCode!==null)resolve();else foreign.once('close',resolve);});
        try{await bounded(finished,'The unrelated fixture stops only during its own teardown',5000,Date.now()+5000);}
        catch(error){
          const remaining=await processIdentity(foreign.pid);
          if(foreignIdentity?.parent===process.pid&&remaining?.started===foreignIdentity.started&&remaining.state!=='Z')foreign.kill('SIGKILL');
          await bounded(finished,'Identity-checked unrelated fixture teardown finishes',2000,Date.now()+2000);throw error;
        }
        const remaining=await processIdentity(foreign.pid);
        assert(!remaining||remaining.started!==foreignIdentity?.started||remaining.state==='Z','The fixture process is dead before its session is removed');
      }catch(error){errors.push(error);}
    }
    if(observer)try{await observer.stop();}catch(error){observerFailed=true;errors.push(error);}
    const remaining=await living(records);
    if(remaining.length||observerFailed)errors.push(new Error('The final drained Landscape inventory could not confirm an empty owned tree; fixture files are preserved'));
    if(!remaining.length&&!observerFailed){
      try{await fs.rm(sentinel,{force:true});assert.deepEqual(await memSnapshot(roots),baselineMem);}catch(error){errors.push(error);}
      for(const key of keys)try{await settings().update(key,previous[key],vscode.ConfigurationTarget.WorkspaceFolder);}catch(error){errors.push(error);}
    }
    if(errors.length)throw new AggregateError(primaryError?[primaryError,...errors]:errors,'Native Landscape failed or its owned cleanup remained incomplete');
  }
};
