import assert from 'node:assert/strict';
import path from 'node:path';
import {TextDecoder} from 'node:util';
import fs from 'node:fs/promises';
import {constants as fileFlags} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {gunzipSync} from 'node:zlib';

const discoveryHash=value=>createHash('sha256').update(value).digest('hex');

// No stdout/stderr from an external inspection command reaches Actions logs.
export async function discoveryOwnedCommand(spawn,file,args,{signal,deadlineAt,states,stdio,allowStderr=false,record,stage,targetPid,sequence}={}){
  assert(deadlineAt>Date.now(),'An expired observation cannot start another process');
  let child,exited=false,closed=false,stopping=false,timer,escalation,drain,firstError,exitCode=null,exitSignal=null;
  const startedAt=Date.now();let size=0,stderrBytes=0;
  const stop=()=>{if(stopping)return;stopping=true;if(!exited&&!closed){try{child.kill('SIGTERM');}catch(error){firstError??=error;}
    escalation=setTimeout(()=>{if(!exited&&!closed)try{child.kill('SIGKILL');}catch(error){firstError??=error;}},1000);}
    drain=setTimeout(()=>{if(!closed){const cleanup=new Error('Owned diagnostic process close is unknown');
      finish(firstError?new AggregateError([firstError,cleanup],'Diagnostic command and physical drain failed'):cleanup);}},3000);};
  let finish;
  const pending=new Promise((resolve,reject)=>{
    const chunks=[];let settled=false;
    finish=error=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(escalation);clearTimeout(drain);
      signal?.removeEventListener('abort',stop);
      try{record?.({stage:'tool-result',step:stage,sequence,targetPid,tool:path.basename(file),pid:child?.pid,
        elapsedMs:Date.now()-startedAt,exitCode,signal:exitSignal,stdoutBytes:size,stderrBytes,physicalClose:closed,
        status:error?'inconclusive':'completed'});}catch{/* An observation sink never throws from a child listener. */}
      error?reject(error):resolve(Buffer.concat(chunks));};
    try{child=spawn(file,args,{stdio:stdio||['ignore','pipe','pipe']});}catch(error){finish(error);return;}
    const state={child,get exited(){return exited;},get closed(){return closed;}};states?.push(state);
    child.once('error',error=>{firstError??=error;});child.once('exit',(code,signal)=>{exited=true;exitCode=Number.isInteger(code)?code:null;
      exitSignal=/^SIG[A-Z0-9]+$/.test(signal??'')?signal:null;});
    child.stdout?.on('data',bytes=>{size+=bytes.length;if(size>131072){firstError??=new Error('Diagnostic output exceeds its bound');stop();}else chunks.push(bytes);});
    child.stderr?.on('data',bytes=>{stderrBytes+=bytes.length;if(stderrBytes>16384){firstError??=new Error('Diagnostic stderr exceeds its bound');stop();}});
    child.once('close',(code)=>{closed=true;finish(firstError||(code!==0||stderrBytes&&!allowStderr?new Error('Owned diagnostic command failed'):undefined));});
    if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
    timer=setTimeout(()=>{firstError??=new Error('Diagnostic command deadline');stop();},Math.max(0,deadlineAt-Date.now()));
  });
  return await pending;
}

export async function readBoundedNativeFile(handle,size,maximum){
  assert(Number.isSafeInteger(size)&&size>=0&&size<=maximum);
  const bytes=Buffer.alloc(size+1);let count=0;
  while(count<bytes.length){const result=await handle.read(bytes,count,bytes.length-count,count);
    assert(Number.isInteger(result.bytesRead)&&result.bytesRead>=0&&result.bytesRead<=bytes.length-count);
    if(!result.bytesRead)break;count+=result.bytesRead;}
  assert.equal(count,size,'A bounded diagnostic read refuses growth or a short read');
  return bytes.subarray(0,count);
}

export function nativeSampleProjection(bytes){
  assert(Buffer.isBuffer(bytes)&&bytes.length<=2000000);
  const categories={jit:0,loading:0,io:0,waiting:0},symbols=new Map(),unknown=createHash('sha256');
  const known={jl_compile_method_internal:'jit',jl_generate_fptr_impl:'jit',jl_emit_code:'jit',jl_add_to_ee:'jit',
    jl_load:'loading',jl_parse_eval_all:'loading',jl_toplevel_eval_flex:'loading',jl_require:'loading',
    read:'io',pread:'io',open:'io',stat:'io',fstat:'io',kevent:'io',uv_fs_work:'io',__read:'io',__open:'io',
    pthread_cond_wait:'waiting',pthread_mutex_lock:'waiting',semaphore_wait_trap:'waiting',mach_msg_trap:'waiting',
    __psynch_cvwait:'waiting',__psynch_mutexwait:'waiting'};
  let unknownLines=0,unknownWeight=0,rejectedLines=0;
  for(const line of bytes.toString('utf8').split(/\r?\n/)){
    if(line.length>2048){rejectedLines++;continue;}
    const match=/^\s*(?:[+!|:]\s*)*(\d{1,9})\s+([A-Za-z_][A-Za-z0-9_:<>.]{0,159})(?:\s|$)/.exec(line);if(!match)continue;
    const name=match[2],weight=Number(match[1]);assert(Number.isSafeInteger(weight)&&weight<=999999999);
    const category=Object.hasOwn(known,name)?known[name]:undefined;
    if(category){categories[category]+=weight;symbols.set(name,(symbols.get(name)||0)+weight);}
    else{unknownLines++;unknownWeight+=weight;unknown.update(name+'\n');}
  }
  assert([...Object.values(categories),unknownWeight].every(Number.isSafeInteger));
  return{bytes:bytes.length,sha256:discoveryHash(bytes),categories,
    symbols:[...symbols].map(([name,count])=>({name,count})),
    unclassified:{lines:unknownLines,weight:unknownWeight,namesSha256:unknown.digest('hex')},rejectedLines,
    scope:'Observed call-graph weights, not exclusive time or a historical cause'};
}

export function nativeSampleManualContract(raw){
  assert(Buffer.isBuffer(raw)&&raw.length<=1048576);
  const text=raw.toString('utf8').replace(/.\x08/g,'');
  const supported=/\bsample\b[\s\S]{0,600}\b(?:pid|process)\b/i.test(text)&&
    /(?:-mayDie\b|\.Fl[ \t]+mayDie\b)/.test(text)&&/(?:-file\b|\.Fl[ \t]+file\b)/.test(text)&&
    /\bduration\b/i.test(text)&&/\binterval\b/i.test(text);
  return{supported,manualSha256:discoveryHash(raw),manualBytes:raw.length,
    contract:'sample PID duration interval -mayDie -file output',descriptorOutputSupport:'unverified-until-tool-return-and-file-read',rawManualRetained:false};
}

export async function verifyNativeSampleSyntax(){
  // Read the installed manual directly: man can start a pager or formatter.
  let raw;
  for(const name of ['/usr/share/man/man1/sample.1','/usr/share/man/man1/sample.1.gz']){
    let handle;try{const before=await fs.lstat(name);assert(before.isFile()&&!before.isSymbolicLink()&&before.size<=1048576);
      handle=await fs.open(name,fileFlags.O_RDONLY|fileFlags.O_NOFOLLOW);const opened=await handle.stat();
      assert.equal(opened.dev,before.dev);assert.equal(opened.ino,before.ino);
      raw=await readBoundedNativeFile(handle,before.size,1048576);
      const after=await handle.stat(),named=await fs.lstat(name);
      for(const key of ['dev','ino','size','mtimeMs']){assert.equal(after[key],before[key]);assert.equal(named[key],before[key]);}
      if(name.endsWith('.gz'))raw=gunzipSync(raw,{maxOutputLength:1048576});break;
    }catch(error){if(error.code!=='ENOENT')throw error;}finally{await handle?.close();}
  }
  if(!raw)return{supported:false,reason:'installed-manual-unavailable'};
  return nativeSampleManualContract(raw);
}

export function createNativeDiscoveryReaders(expected,{sampleSyntax,record}={}){
  const states=[],temporary=[];let incarnation,imageIdentity,sampled=false;
  const check=(capture,options)=>{assert(!options.signal.aborted&&Date.now()<options.deadlineAt);
    assert(!capture.exited&&!capture.closed,'A product exit invalidates live-process observations');};
  const sameFile=(a,b)=>['dev','ino','size','mtimeMs','nlink'].every(key=>a[key]===b[key]);
  const readListing=async(capture,options)=>{
    assert(!options.signal.aborted&&Date.now()<options.deadlineAt);
    const directory=path.dirname(capture.output),parent=await fs.lstat(directory),canonicalDirectory=await fs.realpath(directory);
    assert(parent.isDirectory()&&!parent.isSymbolicLink());
    const recheckParent=async()=>{const after=await fs.lstat(directory);assert(after.isDirectory()&&!after.isSymbolicLink());
      assert.equal(after.dev,parent.dev);assert.equal(after.ino,parent.ino);assert.equal(await fs.realpath(directory),canonicalDirectory);};
    let before;try{before=await fs.lstat(capture.output);}catch(error){if(error.code==='ENOENT'){await recheckParent();return{status:'not-observed'};}throw error;}
    assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=262144);
    const handle=await fs.open(capture.output,fileFlags.O_RDONLY|fileFlags.O_NOFOLLOW);
    try{assert(sameFile(before,await handle.stat()));const bytes=await readBoundedNativeFile(handle,before.size,262144);
      assert.equal(bytes.length,before.size);assert(sameFile(before,await handle.stat()));assert(sameFile(before,await fs.lstat(capture.output)));
      await recheckParent();
      const value=JSON.parse(bytes);assert.equal(value.schema_version,'perfchecker-testitems/1');assert.equal(value.root,expected.root);
      assert.equal(value.executed,false);assert(Array.isArray(value.items)&&value.items.length<=1024);
      const selected=value.items.filter(item=>item.name==='Vector reduction'&&typeof item.file==='string'&&item.file.replaceAll('\\','/')==='test/performance.jl');
      assert(selected.length<=4&&selected.every(item=>typeof item.id==='string'&&item.id.length<=128));
      assert(!options.signal.aborted&&Date.now()<options.deadlineAt);
      return{status:'valid-listing',schema:value.schema_version,sha256:discoveryHash(bytes),bytes:bytes.length,
        modifiedAt:before.mtime.toISOString(),rootMatches:true,items:value.items.length,targetMatches:selected.length,
        targetIds:selected.map(item=>discoveryHash(String(item.id)))};
    }finally{await handle.close();}
  };
  const observe=async(capture,options)=>{
    let stage='identity-before';
    const step=async(name,run)=>{stage=name;try{return await run();}catch(error){throw Object.assign(new Error('Discovery observation is inconclusive'),
      {name:error?.name==='AssertionError'?'AssertionError':'Error',code:/^[A-Z0-9_]+$/.test(error?.code??'')?error.code:undefined,diagnosticStage:name});}};
    const command=(file,args)=>discoveryOwnedCommand(options.originalSpawn,file,args,{...options,states,record,stage,targetPid:capture.pid});
    const identity=async()=>{check(capture,options);const text=(await command('/bin/ps',['-p',String(capture.pid),'-o','ppid=','-o','lstart='])).toString('utf8').trim();
      const match=/^(\d+)\s+(.+)$/.exec(text);assert(match&&Number.isFinite(Date.parse(match[2])));
      const value={pid:capture.pid,parent:Number(match[1]),started:match[2],createdAt:Date.parse(match[2])};
      assert.equal(value.parent,capture.parent);assert(value.createdAt>=capture.startedAt-1000&&value.createdAt<=capture.spawnedAt+1000);
      if(incarnation)assert.deepEqual(value,incarnation);else incarnation=value;return value;};
    const mappings=async()=>{check(capture,options);const raw=(await command('/usr/sbin/lsof',['-a','-p',String(capture.pid),'-d','txt','-Fn'])).toString('utf8');
      const lines=raw.split('\n'),pids=lines.filter(line=>line.startsWith('p'));
      assert(pids.length>0&&pids.every(line=>/^p[1-9]\d*$/.test(line)&&Number(line.slice(1))===capture.pid),
        'The lsof process identity must match the captured Julia PID');
      assert(lines.includes('n'+expected.canonicalExecutable),'The expected Julia image remains mapped');
      const keys=['dev','ino','size','mtimeMs','ctimeMs','nlink','mode'];
      const identityOf=stat=>{assert(stat.isFile()&&!stat.isSymbolicLink());
        const value=Object.fromEntries(keys.map(key=>[key,stat[key]]));assert(Object.values(value).every(Number.isFinite));return value;};
      const before=identityOf(await fs.lstat(expected.canonicalExecutable));
      assert.equal(await fs.realpath(expected.canonicalExecutable),expected.canonicalExecutable,
        'The expected Julia image must retain its exact canonical path');
      const after=identityOf(await fs.lstat(expected.canonicalExecutable));assert.deepEqual(after,before);
      if(imageIdentity)assert.deepEqual(after,imageIdentity);else imageIdentity=after;
      check(capture,options);
    };
    const before=await step('identity-before',identity);await step('image-before',mappings);
    const fields=await step('cpu',async()=>{const fields=(await command('/bin/ps',['-p',String(capture.pid),'-o','stat=','-o','etime=','-o','time=','-o','%cpu='])).toString('utf8').trim().split(/\s+/);
      assert.equal(fields.length,4);assert(/^[A-Z+<NLEsIlTRUXWZ]{1,8}$/.test(fields[0]));assert(fields.slice(1,3).every(v=>/^[\d:.-]{1,32}$/.test(v)));
      assert(/^\d+(?:\.\d+)?$/.test(fields[3])&&fields[3].length<=32);return fields;});
    let stack;
    if(options.sample&&!sampled&&sampleSyntax?.supported){
      sampled=true;check(capture,options);
      const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pc-discovery-sample-')),owned={directory};temporary.push(owned);
      await fs.chmod(directory,0o700);
      const file=path.join(directory,'sample.txt'),handle=await fs.open(file,'wx+',0o600);Object.assign(owned,{file,handle});
      const original=await handle.stat();assert(original.isFile()&&original.nlink===1);
      // The output names the inherited descriptor, not a writer path that can be replaced.
      await step('sample-tool',()=>discoveryOwnedCommand(options.originalSpawn,'/usr/bin/sample',[String(capture.pid),'1','10','-mayDie','-file','/dev/fd/3'],
        {...options,states,record,stage,targetPid:capture.pid,allowStderr:true,stdio:['ignore','pipe','pipe',handle.fd]}));
      stack=await step('sample-read',async()=>{const current=await handle.stat(),named=await fs.lstat(file);
      assert(!named.isSymbolicLink()&&named.nlink===1&&current.nlink===1&&current.size<=2000000);
      assert.equal(current.dev,original.dev);assert.equal(current.ino,original.ino);assert.equal(named.dev,current.dev);assert.equal(named.ino,current.ino);
      const bytes=await readBoundedNativeFile(handle,current.size,2000000);assert(bytes.length>0,'Descriptor output support was not observed');const projection=nativeSampleProjection(bytes);
      assert(sameFile(current,await handle.stat()));assert(sameFile(current,await fs.lstat(file)));return projection;});
    }
    await step('image-after',mappings);await step('identity-after',async()=>{assert.deepEqual(await identity(),before);check(capture,options);});
    return{qualified:true,pid:before.pid,parent:before.parent,createdAt:new Date(before.createdAt).toISOString(),
      executable:{basename:path.basename(expected.canonicalExecutable),pathSha256:discoveryHash(expected.canonicalExecutable)},
      state:fields[0],elapsed:fields[1],cpuTime:fields[2],cpuPercent:fields[3],stack,
      sampleUnavailable:options.sample&&!sampleSyntax?.supported};
  };
  return{readListing,observe,async retire(){
    const closed=states.every(state=>state.closed),errors=[];
    try{record({stage:'owned-observers-retired',physicalClose:closed,observerPids:states.map(state=>state.child.pid),
      sampled,diagnosticOnly:true,perturbing:true,qualifiesCanonicalProduct:false});}catch(error){errors.push(error);}
    if(!closed)errors.push(new Error('Every owned diagnostic process must physically close before raw temporary output is removed'));
    else for(const value of temporary){
      try{await value.handle?.close();}catch(error){errors.push(error);continue;}
      try{await fs.rm(value.directory,{recursive:true});}catch(error){errors.push(error);}
    }
    if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'Discovery reader retirement failed');
  }};
}

export function assertNativeDiscoveryDiagnostic(value){
  if(!value.enabled)return;
  assert.equal(value.event,'workflow_dispatch');assert.equal(value.artifact,'candidate');
  assert.equal(value.stage,'full');assert.equal(value.scope,'macos-stable');
  assert.equal(value.core,'candidate');assert.equal(value.partition,'measure');
  if(value.platform!==undefined)assert.equal(value.platform,'darwin');if(value.arch!==undefined)assert.equal(value.arch,'x64');
  assert.equal(value.backendJulia,'1');
  assert.equal(value.originRun,'38653410110');
  assert.equal(value.originName,'native-candidate-73b99deb87efaf45bd5e96036f755e42c748bdab');
  assert.equal(value.originSha,'bc61f9fa172069c61722e0691900d3ddf8a39ce143fd9d553b252304dbc55850');
  assert.equal(value.coreCommit,'d079efd5c24c3dcac5b7550781822038e0ff780f');
  assert.equal(value.coreTree,'749f8eac351ed2a1f0bc110456f2eb37a3bc08ee');
  assert.equal(value.newOrigin,false);
}

// Match private spawn inputs without publishing them or inspecting process argv.
export function nativeDiscoverySpawnOutput(file,args,options,expected){
  if(file!==expected.executable||!Array.isArray(args)||args.length!==12||options?.cwd!==expected.root)return;
  const prefix=['--startup-file=no',`--project=${expected.project}`,'-e',expected.expression,'--','testitems',
    `--root=${expected.root}`,`--project=${expected.project}`];
  if(!prefix.every((arg,index)=>args[index]===arg)||args[9]!=='--list'||args[10]!=='--tags='||args[11]!=='--exclude-tags=')return;
  if(!args[8].startsWith('--output='))return;
  const output=args[8].slice('--output='.length),directory=path.dirname(output);
  if(path.basename(output)!=='result.json'||path.dirname(directory)!==expected.outputRoot||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(path.basename(directory)))return;
  return output;
}

export function installNativeDiscoveryObserver({childProcess,expected,observe,readListing,record,
    delays=[0,60000,85000],now=Date.now}){
  const originalSpawn=childProcess.spawn,captures=[],timers=new Set(),errors=[];
  let stopped=false,active,abortController;
  const emit=value=>{try{record({diagnosticOnly:true,perturbing:true,qualifiesCanonicalProduct:false,
    observedAt:new Date(now()).toISOString(),...value});}catch{errors.push(new Error('Discovery diagnostic sink failed'));}};
  const fail=error=>{try{return{errorClass:/^[A-Za-z]+$/.test(error?.name??'')?error.name:null,
    code:/^[A-Z0-9_]+$/.test(error?.code??'')?error.code:null,
    step:['identity-before','image-before','cpu','sample-tool','sample-read','image-after','identity-after','listing-open-read','retire'].includes(error?.diagnosticStage)?error.diagnosticStage:null};}catch{return{errorClass:null,code:null,step:null};}};
  const collect=(capture,sequence,onlyListing=false)=>{
    if(stopped||active||(!onlyListing&&(capture.exited||now()>=capture.deadlineAt)))return;
    const abort=abortController=new AbortController(),deadlineAt=onlyListing?now()+2000:Math.min(capture.deadlineAt,now()+5000);
    if(deadlineAt<=now())return;
    const timeout=setTimeout(()=>abort.abort(),deadlineAt-now());
    active=Promise.resolve().then(async()=>{
      let listing;try{listing=await readListing(capture,{signal:abort.signal,deadlineAt});}
      catch(error){throw Object.assign(new Error('Listing observation is inconclusive'),{diagnosticStage:'listing-open-read',
        code:/^[A-Z0-9_]+$/.test(error?.code??'')?error.code:undefined});}
      if(abort.signal.aborted||stopped||now()>=deadlineAt){
        emit({stage:'listing-unknown',sequence,pid:capture.pid,reason:'observation-deadline-or-stop'});return;
      }
      emit({stage:'listing-observed',sequence,pid:capture.pid,listing,historical:onlyListing});
      const process=onlyListing?undefined:await observe(capture,{signal:abort.signal,deadlineAt,
        sequence,sample:sequence===3&&listing.status==='not-observed',originalSpawn});
      if(!abort.signal.aborted&&!stopped&&now()<deadlineAt)
        emit({stage:onlyListing?'historical-listing-after-close':'snapshot',sequence,pid:capture.pid,
          afterUiOracle:onlyListing?now()>=capture.startedAt+120000:undefined,listing,process});
      else emit({stage:'snapshot-unknown',sequence,pid:capture.pid,reason:'observation-deadline-or-stop'});
    }).catch(error=>emit({stage:'snapshot-unknown',sequence,pid:capture.pid,...fail(error)}))
      .finally(()=>{clearTimeout(timeout);active=undefined;});
  };
  function wrapper(file,args,options){
    const startedAt=now();
    // The actual call, its synchronous error and ChildProcess identity are untouched.
    const child=Reflect.apply(originalSpawn,this,arguments),spawnedAt=now();
    try{
    const output=nativeDiscoverySpawnOutput(file,args,options,expected);
    if(!output||stopped)return child;
    const capture={pid:child.pid,parent:process.pid,startedAt,spawnedAt,deadlineAt:startedAt+118000,
      output,child,exited:child.exitCode!=null||child.signalCode!=null,closed:false};captures.push(capture);
    const outcome=(code,signal)=>({code:Number.isInteger(code)?code:null,signal:/^SIG[A-Z0-9]+$/.test(signal??'')?signal:null});
    const exit=(code,signal)=>{capture.exited=true;queueMicrotask(()=>emit({stage:'product-exit',pid:capture.pid,
      ...outcome(code,signal),elapsedMs:now()-startedAt}));};
    const close=(code,signal)=>{capture.closed=true;queueMicrotask(()=>{emit({stage:'product-close',pid:capture.pid,
      ...outcome(code,signal),elapsedMs:now()-startedAt});
      const pending=active;void(pending?pending.then(()=>collect(capture,0,true)):Promise.resolve(collect(capture,0,true)));});};
    const error=value=>queueMicrotask(()=>emit({stage:'product-error',pid:capture.pid,...fail(value)}));
    capture.remove=()=>{child.removeListener('exit',exit);child.removeListener('close',close);child.removeListener('error',error);};
    child.once('exit',exit);child.once('close',close);child.once('error',error);
    queueMicrotask(()=>{
      if(stopped)return;
      emit({stage:'product-spawn-returned',pid:capture.pid,parent:capture.parent,
        startedAt:new Date(startedAt).toISOString(),spawnedAt:new Date(spawnedAt).toISOString(),invocation:captures.length});
      if(captures.length!==1){errors.push(new Error('Multiple diagnostic listing invocations'));return;}
      for(const [index,delay]of delays.entries()){
        const timer=setTimeout(()=>{timers.delete(timer);collect(capture,index+1);},delay);timers.add(timer);
      }
    });
    }catch(error){errors.push(new Error('Discovery observer setup failed'));queueMicrotask(()=>emit({stage:'observer-setup-unknown',...fail(error)}));}
    return child;
  }
  childProcess.spawn=wrapper;
  return{originalSpawn,captures,async retire(){
    stopped=true;for(const timer of timers)clearTimeout(timer);timers.clear();abortController?.abort();
    if(childProcess.spawn===wrapper)childProcess.spawn=originalSpawn;
    else errors.push(new Error('Another spawn hook replaced the diagnostic observer'));
    let drained=!active,expiry;
    try{if(active)drained=await Promise.race([active.then(()=>true),new Promise(resolve=>{expiry=setTimeout(()=>resolve(false),5000);})]);}
    finally{clearTimeout(expiry);for(const capture of captures)capture.remove?.();}
    emit({stage:'observer-retired',drained,invocations:captures.length,
      productCloseObserved:captures.length===1&&captures[0].closed});
    if(!drained)errors.push(new Error('Discovery observer physical drain was not established'));
    if(errors.length)throw new AggregateError(errors,'Discovery diagnostic retirement failed');
  }};
}

// Passive native-test evidence only. No argv, environment, source, request or
// arbitrary log payload is accepted; the process reader proves incarnations.
export function nativeOperationSnapshot(value){
  assert(Number.isSafeInteger(value.hostPid)&&value.hostPid>0);
  assert(typeof value.expectedExecutable==='string'&&path.isAbsolute(value.expectedExecutable));
  assert(Array.isArray(value.rows)&&value.rows.length<=32);
  assert(Array.isArray(value.files??[])&&(value.files??[]).length<=4);
  const rows=new Map(value.rows.map(row=>[row.pid,row]));
  assert.equal(rows.size,value.rows.length,'Observation refuses ambiguous process identities');
  const owned=pid=>{
    const seen=new Set();
    while(pid!==value.hostPid){
      assert(!seen.has(pid),'Observation refuses a cyclic or foreign process ancestry');seen.add(pid);
      const row=rows.get(pid);assert(row&&!row.identityOnly,'Observation requires verified process ownership');
      assert(Number.isSafeInteger(row.pid)&&row.pid>0&&Number.isSafeInteger(row.parent)&&row.parent>0);
      assert(typeof row.createdAt==='string'&&Number.isFinite(Date.parse(row.createdAt)));
      pid=row.parent;
    }
  };
  for(const row of rows.values())owned(row.pid);
  return {hostPid:value.hostPid,processes:[...rows.values()].filter(row=>row.canonicalExecutable===value.expectedExecutable).map(row=>({
    pid:row.pid,parent:row.parent,createdAt:row.createdAt,executable:row.canonicalExecutable,
    ...(row.progress?{progress:Object.fromEntries(['state','elapsed','cpuTime','cpuPercent'].map(key=>{
      const field=row.progress[key],pattern=key==='state'?/^[A-Z+<NLEsIlTRUXWZ]{1,8}$/:key==='cpuPercent'?/^\d+(?:\.\d+)?$/:/^[0-9:.-]{1,32}$/;
      assert(typeof field==='string'&&field.length<=32&&pattern.test(field));return[key,field];}))}:{})})),
    files:(value.files??[]).map(file=>{
      assert(['suite','plan','controller-project','controller-manifest'].includes(file.name));
      assert(typeof file.present==='boolean');
      if(!file.present)return{name:file.name,present:false};
      assert(Number.isSafeInteger(file.bytes)&&file.bytes>=0&&Number.isFinite(Date.parse(file.modifiedAt)));
      return{name:file.name,present:true,bytes:file.bytes,modifiedAt:file.modifiedAt};
    })};
}

export async function captureQualifiedNativeProgress(expected,beforeMappings,readProgress,readMappings){
  assert(beforeMappings.includes(expected),'Progress observation requires the canonical executable before reading states');
  const progress=await readProgress();
  assert((await readMappings()).includes(expected),'Progress observation refuses a changed or uncertain executable');
  return progress;
}

export async function observeNativeOperation(operation,run,{sample,record,deadlineAt,
  intervalMs=15000,sampleTimeoutMs=2000,maxSamples=40}={}){
  assert(['initialize','plan','diagnose'].includes(operation));assert.equal(typeof run,'function');
  assert.equal(typeof sample,'function');assert.equal(typeof record,'function');
  assert(Number.isFinite(deadlineAt)&&Number.isInteger(intervalMs)&&intervalMs>0&&Number.isInteger(sampleTimeoutMs)&&sampleTimeoutMs>0);
  assert(Number.isInteger(maxSamples)&&maxSamples>0&&maxSamples<=64);
  let stopped=false,active,timer,controller,count=0;
  const emit=detail=>{try{record({operation,at:new Date().toISOString(),...detail});}catch{/* A diagnostic sink cannot change the real operation. */}};
  const collect=()=>{
    if(stopped||active||count>=maxSamples||Date.now()>=deadlineAt)return;
    const abort=controller=new AbortController(),sampleDeadline=Math.min(deadlineAt,Date.now()+sampleTimeoutMs);
    const expiry=setTimeout(()=>abort.abort(),Math.max(1,sampleDeadline-Date.now()));count++;
    active=Promise.resolve().then(()=>sample({signal:abort.signal,deadlineAt:sampleDeadline})).then(value=>{
      if(!stopped&&!abort.signal.aborted&&Date.now()<sampleDeadline)emit({stage:'sample',sequence:count,...nativeOperationSnapshot(value)});
    }).catch(error=>{if(!stopped)emit({stage:'inspection-error',sequence:count,
      errorClass:/^[A-Za-z]+$/.test(error?.name??'')?error.name:null,code:/^[A-Z0-9_]+$/.test(error?.code??'')?error.code:null});})
      .finally(()=>{clearTimeout(expiry);active=undefined;});
  };
  try{
    // Invoke the actual action before scheduling any potentially blocking read.
    const pending=run();emit({stage:'started',deadlineAt:new Date(deadlineAt).toISOString()});
    collect();timer=setInterval(collect,intervalMs);
    return await pending;
  }finally{
    stopped=true;clearInterval(timer);controller?.abort();
    let drained=!active,expiry;
    try{if(active)drained=await Promise.race([active.then(()=>true),new Promise(resolve=>{expiry=setTimeout(()=>resolve(false),sampleTimeoutMs);})]);}
    finally{clearTimeout(expiry);emit({stage:'observer-stopped',samples:count,drained});}
  }
}

// A READY received during an asynchronous process inventory belongs to its next
// snapshot. The caller still verifies that leader, parent and executable.
export async function captureControllerInventory(readReadyPid,readRows){
  const readyPid=readReadyPid();
  return {readyPid,rows:await readRows()};
}

export function controllerReadinessObserved({readyPid,started,identities,live,parent,expected,canonical}){
  if(!readyPid||started)return false;
  const leader=identities.get(readyPid);
  assert(leader&&live.has(readyPid));
  assert.equal(leader.parent,parent);
  assert.equal(canonical(leader.executable),canonical(expected));
  return true;
}

// Pkg's LibGit2 checkout reads its own configuration search path. The Git CLI's
// GIT_CONFIG_GLOBAL alone does not select that file for the embedded library.
export const candidateGitSetupScript=String.raw`using LibGit2
if Sys.iswindows()
 @assert get(ENV,"CI","")=="true" && get(ENV,"GITHUB_ACTIONS","")=="true"
 config=realpath(ENV["PERFCHECKER_NATIVE_GIT_CONFIG"]);@assert basename(config)==".gitconfig"
 LibGit2.ensure_initialized()
 result=ccall((:git_libgit2_opts,LibGit2.libgit2),Cint,(Cint,Cint,Cstring),LibGit2.Consts.SET_SEARCH_PATH,LibGit2.Consts.CONFIG_LEVEL_GLOBAL,dirname(config));@assert result==0
 @assert LibGit2.getconfig("core.autocrlf",true)==false
 @assert LibGit2.getconfig("core.eol","")=="lf"
 println("CANDIDATE_GIT_CONFIG_V1 path=",bytes2hex(codeunits(config))," sha256=",bytes2hex(Pkg.GitTools.SHA.sha256(read(config)))," autocrlf=false eol=lf library=",LibGit2.VERSION);flush(stdout)
end`;

// NTFS ACLs inherited by LibGit2's checkout can mark every file executable.
// Pkg.set_readonly deliberately retains that access. Restore the immutable
// Git modes, without rewriting bytes, then require Pkg's ORIGINAL whole-tree hash.
export const candidateCheckoutPermissionsScript=String.raw`if Sys.iswindows()
 @assert get(ENV,"CI","")=="true" && get(ENV,"GITHUB_ACTIONS","")=="true"
 info=only(info for info in values(Pkg.dependencies()) if info.name=="PerfChecker")
 @assert string(info.tree_hash)==ARGS[3]
 root=realpath(info.source);depot=realpath(first(DEPOT_PATH));@assert startswith(root,depot*Base.Filesystem.path_separator)
 count=Ref(0);changed=Ref(0);bytecount=Ref(Int64(0));before_modes=Dict{String,Int}()
 function restore_candidate_modes(tree,directory)
  entries=[tree[i] for i in 1:LibGit2.count(tree)]
  @assert sort(readdir(directory))==sort(LibGit2.filename.(entries))
  for entry in entries
   name=LibGit2.filename(entry);@assert basename(name)==name && name!="." && name!=".."
   file=joinpath(directory,name);mode=LibGit2.filemode(entry)
   if mode==0o040000
    @assert isdir(file) && !islink(file)
    LibGit2.with(LibGit2.GitTree,entry) do child;restore_candidate_modes(child,file);end
   else
    @assert mode in (0o100644,0o100755) && isfile(file) && !islink(file)
    count[]+=1;bytecount[]+=filesize(file);before=string(Pkg.GitTools.gitmode(file));before_modes[before]=get(before_modes,before,0)+1
    chmod(file,mode==0o100644 ? 0o444 : 0o555)
    @assert string(Pkg.GitTools.gitmode(file))==string(mode;base=8)
    changed[]+=before!=string(mode;base=8)
   end
  end
 end
 LibGit2.with(LibGit2.GitRepo,Pkg.Types.add_repo_cache_path("https://github.com/Mirage-Interactive-Fr/PerfChecker.jl")) do repo
  @assert LibGit2.getconfig(repo,"core.autocrlf",true)==false && LibGit2.getconfig(repo,"core.eol","")=="lf"
  LibGit2.with(LibGit2.GitTree,repo,ARGS[3]) do tree
   @assert string(LibGit2.GitHash(tree))==ARGS[3]
   restore_candidate_modes(tree,root)
  end
 end
 actual=bytes2hex(Pkg.GitTools.tree_hash(root));@assert actual==ARGS[3]
 println("CANDIDATE_CHECKOUT_V1 tree=",actual," files=",count[]," bytes=",bytecount[]," aclChanged=",changed[]," beforeModes=",join([k*":"*string(v) for (k,v) in sort!(collect(before_modes))],",")," contentRewritten=false complete=true");flush(stdout)
end`;

// Package installation disables automatic precompilation in this disposable
// campaign. Finish the selected provider caches explicitly before observing a
// prepared import; the owner/descendant observer also covers this process.
export const controllerCachePreparationScript=String.raw`println("CONTROLLER_PREFLIGHT_READY ",getpid());flush(stdout);readline(stdin)
using Pkg;Pkg.activate(ARGS[1]);started=time()
packages=["PerfChecker","HTTP"];discovery=length(ARGS)==3
if discovery;push!(packages,"TestItemRunner");end
println("CONTROLLER_CACHE_PREPARATION_BEGIN ",join(packages," ")," strict=true");flush(stdout)
Pkg.precompile(packages;strict=true)
if discovery
 using Dates,PerfChecker,TestItemRunner
 discovery_started=Dates.format(now(UTC),Dates.DateFormat("yyyy-mm-ddTHH:MM:SS.sssZ"));discovery_time=time()
 @assert all(info.name!="PerfCheckerNativeFixture" for info in values(Pkg.dependencies()))
 code=PerfChecker.perfchecker_main(["testitems","--root="*ARGS[2],"--project="*ARGS[1],"--output="*ARGS[3],"--list","--tags=","--exclude-tags="])
 @assert code==0
 listing=PerfChecker.JSON.parsefile(ARGS[3]);@assert listing["schema_version"]=="perfchecker-testitems/1";@assert listing["executed"]==false
 matches=filter(item->item["name"]=="Vector reduction"&&replace(item["file"],'\\'=>'/')=="test/performance.jl",listing["items"])
 @assert length(matches)==1
 receipt=Dict("schema_version"=>"perfchecker-native-testitem-discovery/1","root"=>realpath(ARGS[2]),
  "project"=>realpath(Base.active_project()),"startedAt"=>discovery_started,
  "finishedAt"=>Dates.format(now(UTC),Dates.DateFormat("yyyy-mm-ddTHH:MM:SS.sssZ")),"elapsedSeconds"=>time()-discovery_time,
  "listingSchema"=>listing["schema_version"],"listingRoot"=>listing["root"],"executed"=>listing["executed"],"item"=>only(matches),"targetPrepared"=>false,
  "TestItemRunner"=>Dict("version"=>string(Base.pkgversion(TestItemRunner)),"source"=>realpath(pathof(TestItemRunner))))
 print("CONTROLLER_TESTITEM_DISCOVERY_V1 ");PerfChecker.JSON.print(receipt);println();flush(stdout)
end
println("CONTROLLER_CACHE_PREPARATION_COMPLETE_V1 ",time()-started);flush(stdout)`;

export function parseControllerTestItemDiscoveryReceipt(text,{project,root}) {
  const prefix='CONTROLLER_TESTITEM_DISCOVERY_V1 ';
  const lines=text.split(/\r?\n/).filter(line=>line.startsWith('CONTROLLER_TESTITEM_DISCOVERY'));
  assert.equal(lines.length,1,'Exactly one completed discovery receipt is required');
  assert(lines[0].startsWith(prefix),'Unknown discovery receipt protocol');
  const receipt=JSON.parse(lines[0].slice(prefix.length));
  assert.equal(receipt.schema_version,'perfchecker-native-testitem-discovery/1');
  assert.equal(receipt.project,project);assert.equal(receipt.root,root);
  for(const key of ['startedAt','finishedAt'])assert(Number.isFinite(Date.parse(receipt[key])),'Discovery timestamps are required');
  assert(Date.parse(receipt.finishedAt)>=Date.parse(receipt.startedAt),'Discovery timestamps preserve their order');
  assert(Number.isFinite(receipt.elapsedSeconds)&&receipt.elapsedSeconds>=0);
  assert.equal(receipt.listingSchema,'perfchecker-testitems/1');assert.equal(receipt.targetPrepared,false,
    'Discovery preparation must not install the intentionally missing target');
  assert.equal(receipt.executed,false,'The listing must not execute the missing-target workload');
  assert(path.isAbsolute(receipt.listingRoot),'The actual listing root is retained');
  assert.equal(receipt.item?.name,'Vector reduction');assert.equal(receipt.item?.file?.replaceAll('\\','/'),'test/performance.jl');
  assert(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(receipt.TestItemRunner?.version));
  assert(path.isAbsolute(receipt.TestItemRunner?.source),'The loaded discovery dependency records its real source');
  return receipt;
}

// Emit primitive fields rather than compiling a generic JSON writer after the
// prepared HTTP import. All loading, identity checks and the 180 s budget remain real.
export const controllerPreflightScript=String.raw`println("CONTROLLER_PREFLIGHT_READY ",getpid());flush(stdout);readline(stdin)
using Pkg;Pkg.activate(ARGS[1]);started=time();modules=Module[]
for name in (:PerfChecker,:HTTP)
 println("CONTROLLER_IMPORT_BEFORE ",name," elapsed=",time()-started);flush(stdout)
 m=Base.require(Main,name);push!(modules,m)
 println("CONTROLLER_IMPORT_AFTER ",name," elapsed=",time()-started," version=",Base.pkgversion(m)," source=",pathof(m));flush(stdout)
end
core=first(modules);extension=Base.get_extension(core,:HTTPAdvisorExt);@assert extension!==nothing
function diagnose_controller_tree(m,root,source,tree,pinned)
 println(join(["CONTROLLER_TREE_CHECK_V1",string(nameof(m)),string(Base.pkgversion(m)),bytes2hex(codeunits(root)),bytes2hex(codeunits(source)),tree,pinned],'\t'));flush(stdout)
 tree==pinned&&return
 println("CONTROLLER_TREE_MISMATCH_V1 ",nameof(m));flush(stdout)
 config=Cmd(["git","-C",root,"config","--show-origin","--get-regexp","^core\\.(autocrlf|eol|filemode)\$"])
 try
  process=open(pipeline(ignorestatus(config),stderr=devnull));value=""
  try;value=read(process,String);wait(process)
   println(join(["CONTROLLER_GIT_CONFIG_V1",string(nameof(m)),string(process.exitcode),bytes2hex(codeunits(first(value,min(length(value),8192))))],'\t'))
  finally;close(process);end
 catch error;println("CONTROLLER_GIT_CONFIG_UNKNOWN_V1 ",nameof(m)," ",nameof(typeof(error)));end
 count=0;total=0
 for (directory,subdirs,files) in walkdir(root)
  filter!(name->name!=".git",subdirs)
  names=sort!(vcat(filter(name->islink(joinpath(directory,name)),subdirs),filter(name->name!=".git",files)))
  for name in names
   file=joinpath(directory,name);count+=1;total+=islink(file) ? ncodeunits(readlink(file)) : filesize(file)
   if count>5000||total>100_000_000
    println("CONTROLLER_TREE_INVENTORY_UNKNOWN_V1 observation-budget files=",count," bytes=",total);flush(stdout);return
   end
   bytes=islink(file) ? Vector{UInt8}(codeunits(readlink(file))) : read(file)
   hash=bytes2hex(Pkg.GitTools.SHA.sha1(vcat(codeunits("blob $(length(bytes))\0"),bytes)))
   crlf=0;for i in 1:(length(bytes)-1);crlf+=(bytes[i]==0x0d&&bytes[i+1]==0x0a);end
   normalized="-";value=String(copy(bytes))
   if crlf>0&&isvalid(value)
    value=replace(value,"\r\n"=>"\n");normalized=bytes2hex(Pkg.GitTools.SHA.sha1(vcat(codeunits("blob $(ncodeunits(value))\0"),codeunits(value))))
   end
   println(join(["CONTROLLER_TREE_FILE_V1",string(nameof(m)),bytes2hex(codeunits(relpath(file,root))),string(Pkg.GitTools.gitmode(file)),string(length(bytes)),hash,string(crlf),normalized],'\t'))
  end
 end
 println("CONTROLLER_TREE_INVENTORY_COMPLETE_V1 ",nameof(m)," files=",count," bytes=",total);flush(stdout)
end
fields=String["CONTROLLER_IMPORT_RECEIPT_V1","",string(nameof(extension)),bytes2hex(codeunits(realpath(Base.active_project())))];deps=Pkg.dependencies()
identities=map(modules) do m
 root=realpath(pkgdir(m));source=realpath(pathof(m));tree=bytes2hex(Pkg.GitTools.tree_hash(root));pinned=string(deps[Base.PkgId(m).uuid].tree_hash)
 (m,root,source,tree,pinned)
end
for (m,root,source,tree,pinned) in identities;diagnose_controller_tree(m,root,source,tree,pinned);end
for (m,root,source,tree,pinned) in identities
 @assert tree==pinned
 append!(fields,[string(nameof(m)),string(Base.pkgversion(m)),bytes2hex(codeunits(root)),bytes2hex(codeunits(source)),tree,pinned])
end
fields[2]=string(time()-started);println(join(fields,'\t'));flush(stdout)`;

export function parseControllerImportReceipt(text,{project,version,tree}){
  const lines=text.split(/\r?\n/).filter(line=>line.startsWith('CONTROLLER_IMPORT_RECEIPT'));
  assert.equal(lines.length,1,'Exactly one complete controller import receipt is required');
  const fields=lines[0].split('\t');
  assert.equal(fields.length,16,'The primitive receipt has every identity field');
  assert.equal(fields[0],'CONTROLLER_IMPORT_RECEIPT_V1','Unknown controller receipt protocol');
  assert(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(fields[1]));
  const elapsedSeconds=Number(fields[1]);assert(Number.isFinite(elapsedSeconds)&&elapsedSeconds>=0);
  assert.equal(fields[2],'HTTPAdvisorExt','The real HTTP extension must be loaded');
  const decode=value=>{
    assert(/^(?:[a-f0-9]{2})+$/.test(value),'Identity strings use canonical nonempty UTF-8 hex');
    const decoded=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(value,'hex'));
    assert(!/[\0\r\n]/.test(decoded),'Identity paths cannot contain control delimiters');
    assert(path.isAbsolute(decoded),'Identity paths are absolute');return decoded;
  };
  const activeProject=decode(fields[3]);assert.equal(activeProject,project,'The imported controller is the prepared project');
  const packages=[4,10].map((offset,index)=>{
    const [name,actualVersion,rootHex,sourceHex,actualTree,pinnedTree]=fields.slice(offset,offset+6);
    assert.equal(name,index===0?'PerfChecker':'HTTP');assert(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(actualVersion));
    const root=decode(rootHex),source=decode(sourceHex);
    assert.equal(source,path.join(root,'src',`${name}.jl`),'The actual entrypoint belongs to the reported package');
    assert(/^[a-f0-9]{40}$/.test(actualTree));assert.equal(actualTree,pinnedTree,'Loaded source matches its pinned dependency tree');
    return {name,version:actualVersion,root,source,tree:actualTree};
  });
  assert.equal(packages[0].version,version);assert.equal(packages[0].tree,tree,'The imported Core matches the qualified immutable tree');
  return {elapsedSeconds,extension:fields[2],activeProject,packages};
}

// Inspection failures remain fatal. Retain the evidence execFile supplies,
// without its command/environment or unbounded stdout/stderr dumps.
export function controllerInspectionFailure(error,{stage,pid,ownerPid}){
  return {stage,pid,ownerPid,observedAt:new Date().toISOString(),
    error:String(error.message??error).slice(0,4000),code:error.code??null,signal:error.signal??null,
    killed:typeof error.killed==='boolean'?error.killed:null,
    stderr:String(error.stderr??'').slice(-4000)};
}

// Only an already qualified incarnation may resolve a transient /proc/exe
// disappearance. These reads grant no signal authority while its image is unknown.
export async function revalidateQualifiedLinuxExecutable({identity,error,deadlineAt,readCurrent,readExecutable,record,
  now=Date.now,wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))}){
  assert(identity&&Number.isSafeInteger(identity.pid)&&identity.pid>0&&/^\d+$/.test(identity.started)&&
    Number.isSafeInteger(identity.group)&&identity.group>0&&path.isAbsolute(identity.executable));
  if(!['ENOENT','ESRCH'].includes(error.code))throw error;
  const until=Math.min(deadlineAt,now()+1000);
  const observation={stage:'qualified-executable-revalidation',pid:identity.pid,started:identity.started,group:identity.group,
    expectedExecutable:identity.executable,errorCode:error.code,observedAt:new Date(now()).toISOString(),rechecks:[],resolution:'pending'};
  record(observation);
  const bounded=async callback=>{
    const remaining=until-now();if(remaining<=0)throw error;let timer;
    try{return await Promise.race([Promise.resolve().then(callback),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(error),remaining);})]);}
    finally{clearTimeout(timer);}
  };
  const current=async(attempt,step)=>{
    const value=await bounded(()=>readCurrent(identity.pid));attempt[step]=value??null;
    if(value){assert.equal(value.pid,identity.pid);assert.equal(value.started,identity.started,'Reused PID cannot resolve an executable inspection failure');
      assert.equal(value.group,identity.group,'A changed process group cannot resolve an executable inspection failure');}
    return value;
  };
  const gone=value=>!value||['Z','X'].includes(value.state);
  const resolvedGone=value=>{observation.resolution=value?'same-incarnation-dead':'proved-absent';return undefined;};
  try{
    while(true){
      const attempt={observedAt:new Date(now()).toISOString()};observation.rechecks.push(attempt);
      let value=await current(attempt,'before');if(gone(value))return resolvedGone(value);
      try{
        for(const step of ['first','second']){
          const executable=await bounded(()=>readExecutable(identity.pid));attempt[step+'Executable']=executable;
          assert.equal(executable,identity.executable,'A different executable cannot resolve an owned image inspection failure');
          value=await current(attempt,step+'After');if(gone(value))return resolvedGone(value);
        }
        observation.resolution='same-incarnation-stable-image';return {...value,executable:identity.executable};
      }catch(recheckError){
        if(!['ENOENT','ESRCH'].includes(recheckError.code))throw recheckError;
        attempt.executableError=recheckError.code;value=await current(attempt,'afterError');if(gone(value))return resolvedGone(value);
      }
      if(now()>=until)throw error;
      await wait(Math.min(25,until-now()));
    }
  }catch(refusal){observation.resolution='refused';observation.refusal=String(refusal.message??refusal).slice(0,1000);throw refusal;}
  finally{observation.finishedAt=new Date(now()).toISOString();}
}
