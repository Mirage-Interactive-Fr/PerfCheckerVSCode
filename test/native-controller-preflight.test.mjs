import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {writeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {controllerPreflightScript,parseControllerImportReceipt,parseControllerTestItemDiscoveryReceipt,controllerInspectionFailure,revalidateQualifiedLinuxExecutable,captureControllerInventory,controllerReadinessObserved,nativeOperationSnapshot,observeNativeOperation,captureQualifiedNativeProgress,assertNativeDiscoveryDiagnostic,nativeDiscoverySpawnOutput,installNativeDiscoveryObserver,installPassiveNativeDiscoveryObserver,readBoundedNativeFile,nativeSampleProjection,nativeSampleManualContract,createNativeDiscoveryReaders,discoveryOwnedCommand} from './native-controller-preflight.mjs';

const nextObservationTurn=()=>new Promise(resolve=>setImmediate(resolve));
const discoveryExpected={executable:'/private/Julia/bin/julia',project:'/private/controller',root:'/private/workspace',
  expression:'immutable installed cancellation wrapper',outputRoot:'/private/profile/native-testitems'};
const discoveryArgs=()=>['--startup-file=no','--project=/private/controller','-e',discoveryExpected.expression,'--','testitems',
  '--root=/private/workspace','--project=/private/controller','--output=/private/profile/native-testitems/12345678-1234-1234-1234-123456789abc/result.json',
  '--list','--tags=','--exclude-tags='];
function observationChild(pid=123){const child=new EventEmitter();child.pid=pid;child.exitCode=null;child.signalCode=null;
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>true;return child;}
const diagnosticSelection=()=>({enabled:true,event:'workflow_dispatch',artifact:'candidate',stage:'full',scope:'macos-stable',
  core:'candidate',partition:'measure',platform:'darwin',arch:'x64',backendJulia:'1',originRun:'38653410110',
  originName:'native-candidate-73b99deb87efaf45bd5e96036f755e42c748bdab',
  originSha:'bc61f9fa172069c61722e0691900d3ddf8a39ce143fd9d553b252304dbc55850',
  coreCommit:'d079efd5c24c3dcac5b7550781822038e0ff780f',coreTree:'749f8eac351ed2a1f0bc110456f2eb37a3bc08ee',newOrigin:false});

function passiveDiscoveryFixture(changes={}){
  const records=[],calls=[],child=observationChild(),clock={at:1000,mono:0};let retired=0,reads=0;
  child.kill=()=>assert.fail('The passive diagnostic never signals the original Julia child');
  const cp={spawn:function(){calls.push({self:this,args:[...arguments]});return child;}},original=cp.spawn;
  const valid={status:'valid-listing',targetMatches:1,sourceMatches:true,directoryBoundBeforeClose:true};
  const observer=installPassiveNativeDiscoveryObserver({childProcess:cp,expected:discoveryExpected,
    now:()=>clock.at,monotonic:()=>clock.mono,phaseDeadlineAt:1000000,record:row=>records.push(row),
    readListing:async capture=>{reads++;return capture.closed?valid:{status:'not-observed'};},
    retireReaders:async()=>{retired++;},...changes});
  const spawn=()=>cp.spawn(discoveryExpected.executable,discoveryArgs(),{cwd:discoveryExpected.root});
  const advance=ms=>{clock.at+=ms;clock.mono+=ms;};
  const close=(code=0)=>{child.exitCode=code;child.emit('exit',code,null);child.emit('close',code,null);};
  return{observer,records,calls,child,cp,original,clock,spawn,advance,close,get retired(){return retired;},get reads(){return reads;}};
}

test('passive discovery delegates the original handle and streams once and observes close before UI120',async()=>{
  const f=passiveDiscoveryFixture();assert.equal(f.spawn(),f.child);assert.equal(f.reads,0);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].self,f.cp);assert.equal(f.calls[0].args.length,3);
  assert.equal(f.child.stdout.listenerCount('data'),0);assert.equal(f.child.stderr.listenerCount('data'),0);
  await nextObservationTurn();f.observer.uiStarted();f.advance(104000);f.close();
  f.observer.uiOutcome('passed');await f.observer.finish();
  assert.equal(f.cp.spawn,f.original);assert.equal(f.retired,1);assert.equal(f.calls.length,1);
  const spawn=f.records.find(r=>r.stage==='product-spawn-returned'),close=f.records.find(r=>r.stage==='product-close');
  assert.equal(spawn.parent,process.pid);assert.equal(spawn.uuidSha256,close.uuidSha256);assert.equal(close.code,0);
  assert.equal(close.elapsedMs,104000);assert(f.records.some(r=>r.stage==='passive-listing-read'&&r.trigger==='after-close'));
  assert(!JSON.stringify(f.records).includes('/private/'));assert.equal(f.records.at(-1).drained,true);
});

test('passive completion after failed UI120 never replaces that error or performs a late Run Test',async()=>{
  const f=passiveDiscoveryFixture(),primary=new Error('original UI120 refusal');let visibleCalls=0,settled=false;
  f.spawn();await nextObservationTurn();f.observer.uiStarted();f.advance(120001);
  f.observer.uiOutcome('failed',async()=>{visibleCalls++;return true;},primary);
  const finished=f.observer.finish(primary);finished.then(()=>{settled=true;},()=>{settled=true;});
  await nextObservationTurn();assert.equal(settled,false);assert.equal(visibleCalls,0);
  f.advance(30000);f.close();await assert.rejects(finished,error=>error===primary);
  assert.equal(visibleCalls,1);assert.equal(f.calls.length,1);assert.equal(f.retired,1);
  const fail=f.records.find(r=>r.stage==='original-ui-oracle-settled'),late=f.records.find(r=>r.stage==='passive-ui-row-query');
  assert.equal(fail.status,'failed');assert.equal(fail.elapsedMs,120001);assert.equal(late.visibleAtObservation,true);
  assert.equal(late.originalUiVerdict,'failed');assert.equal(late.lateRunTestPerformed,false);
  assert.equal(late.testControllerPublication,'unknown');assert.equal(late.publishingRefresh,'unknown');
});

test('a valid JSON after nonzero close is inconclusive and cannot trigger the late UI probe',async()=>{
  const f=passiveDiscoveryFixture(),primary=new Error('UI oracle');let visible=0;
  f.spawn();await nextObservationTurn();f.advance(120001);f.observer.uiOutcome('failed',()=>{visible++;return true;});f.close(1);
  await assert.rejects(f.observer.finish(primary),error=>error===primary);assert.equal(visible,0);
  assert.equal(f.records.find(r=>r.stage==='passive-completion-outcome').completion,'inconclusive');
});

test('exit without physical close stays unknown at observation180 and no inferred PID is signalled',async()=>{
  const f=passiveDiscoveryFixture(),primary=new Error('UI oracle');f.spawn();await nextObservationTurn();
  f.observer.uiOutcome('failed',()=>assert.fail('No UI query without physical close'));
  f.child.emit('exit',0,null);f.advance(180001);await assert.rejects(f.observer.finish(primary),error=>error===primary);
  assert.equal(f.records.find(r=>r.stage==='passive-completion-unknown').productCloseObserved,false);
  assert.equal(f.records.at(-1).productCloseObserved,false);assert.equal(f.retired,1);
});

test('phase abort clips the passive wait without affecting the original child or failure',async()=>{
  const abort=new AbortController(),f=passiveDiscoveryFixture({signal:abort.signal}),primary=new Error('UI oracle');
  f.spawn();await nextObservationTurn();f.observer.uiOutcome('failed');const finished=f.observer.finish(primary);
  await nextObservationTurn();abort.abort();await assert.rejects(finished,error=>error===primary);
  assert.equal(f.calls.length,1);assert.equal(f.retired,1);assert.equal(f.records.at(-1).drained,true);
});

test('changed discovery context refuses a late row attribution and false visibility remains unknown',async()=>{
  for(const contextUnchanged of [()=>false,()=>true]){
    const f=passiveDiscoveryFixture({contextUnchanged}),primary=new Error('UI oracle');let reads=0;
    f.spawn();await nextObservationTurn();f.advance(120001);f.observer.uiOutcome('failed',()=>{reads++;return false;});f.close();
    await assert.rejects(f.observer.finish(primary),error=>error===primary);
    const row=f.records.find(r=>r.stage==='passive-ui-row-query');assert.equal(row?.visibleAtObservation??'unknown','unknown');
    assert.equal(reads,contextUnchanged()?1:0);
  }
});

test('passive retirement is idempotent and cleanup errors retain the exact primary error directly first',async()=>{
  const primary=new Error('original UI error'),cleanup=new Error('reader retirement');let retired=0;
  const f=passiveDiscoveryFixture({retireReaders:async()=>{retired++;throw cleanup;}});
  f.spawn();await nextObservationTurn();f.observer.uiOutcome('failed');f.advance(180001);
  const first=f.observer.finish(primary),second=f.observer.finish(new Error('must not replace original'));
  assert.equal(first,second);await assert.rejects(first,error=>error instanceof AggregateError&&error.errors[0]===primary&&error.errors[1]===cleanup);
  assert.equal(retired,1);assert.equal(f.cp.spawn,f.original);
});

test('passive callback after retirement is never emitted and an undrained reader is explicit',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let release;
  const f=passiveDiscoveryFixture({readListing:()=>new Promise(resolve=>{release=resolve;})}),primary=new Error('UI oracle');
  f.spawn();await nextObservationTurn();f.observer.uiOutcome('failed');f.advance(180001);
  const finished=f.observer.finish(primary);const rejected=assert.rejects(finished,error=>error instanceof AggregateError&&error.errors[0]===primary);
  await nextObservationTurn();t.mock.timers.tick(5001);await rejected;
  assert.equal(f.records.at(-1).drained,false);const before=f.records.length;
  release({status:'valid-listing'});await nextObservationTurn();assert.equal(f.records.length,before);assert.equal(f.retired,1);
});

test('passive matching preserves synchronous errors and exact arguments and refuses ambiguous invocations',async()=>{
  const primary=new Error('original synchronous refusal'),cp={spawn(){assert.equal(arguments.length,2);throw primary;}};
  const observer=installPassiveNativeDiscoveryObserver({childProcess:cp,expected:discoveryExpected,phaseDeadlineAt:Date.now()+1000,
    readListing:()=>assert.fail('A refused spawn cannot read files'),retireReaders:async()=>{},record:()=>{}});
  assert.throws(()=>cp.spawn('other',[]),error=>error===primary);
  await assert.rejects(observer.finish(primary),error=>error instanceof AggregateError&&error.errors[0]===primary);
  const f=passiveDiscoveryFixture();f.spawn();await nextObservationTurn();f.spawn();await nextObservationTurn();
  f.observer.uiOutcome('failed');f.advance(180001);
  await assert.rejects(f.observer.finish(primary),error=>error instanceof AggregateError&&error.errors[0]===primary);
  assert.equal(f.calls.length,2);assert.equal(f.reads,1);assert.equal(f.retired,1);
});

test('a backward UTC clock cannot extend the monotonic passive observation window',async()=>{
  const f=passiveDiscoveryFixture(),primary=new Error('UI oracle');f.spawn();await nextObservationTurn();
  f.observer.uiOutcome('failed',()=>assert.fail('An expired monotonic observation cannot query UI'));
  f.clock.at=-1000000;f.clock.mono=180001;await assert.rejects(f.observer.finish(primary),error=>error===primary);
  assert(f.records.some(row=>row.stage==='passive-completion-unknown'));assert.equal(f.retired,1);
});

async function withPassiveListing(run){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'pc-passive-listing-')),root=await fs.realpath(temporary),directory=path.join(root,'output');
  await fs.mkdir(directory);await fs.mkdir(path.join(root,'test'));
  const sourceFile=path.join(root,'test','performance.jl'),source='private disposable test fixture';await fs.writeFile(sourceFile,source);
  const sourceSha256=createHash('sha256').update(source).digest('hex'),output=path.join(directory,'result.json');
  const readers=createNativeDiscoveryReaders({...discoveryExpected,root,stableOutput:true,sourceFile,sourceSha256},{record:()=>{}});
  const capture={output,pid:123,parent:process.pid,closed:false},options={signal:new AbortController().signal,deadlineAt:Date.now()+10000};
  const listing={schema_version:'perfchecker-testitems/1',executed:false,root,items:[{name:'Vector reduction',file:'test/performance.jl',id:'private target',source_sha256:sourceSha256}]};
  const write=()=>fs.writeFile(output,JSON.stringify(listing));
  try{await run({root,directory,sourceFile,output,readers,capture,options,listing,write});}
  finally{await readers.retire();await fs.rm(root,{recursive:true,force:true});}
}

test('passive listing binds its private directory before close and checks the exact target and source',async()=>{
  await withPassiveListing(async f=>{
    const absent=await f.readers.readListing(f.capture,f.options);assert.equal(absent.status,'not-observed');assert.equal(absent.directoryBoundBeforeClose,true);
    await f.write();f.capture.closed=true;const value=await f.readers.readListing(f.capture,f.options);
    assert.equal(value.targetMatches,1);assert.equal(value.sourceMatches,true);assert.equal(value.directoryBoundBeforeClose,true);
    assert.equal(value.targetIds.length,1);assert(!JSON.stringify(value).includes(f.root));
    await fs.unlink(f.output);await assert.rejects(f.readers.readListing(f.capture,f.options));
  });
});

test('passive listing refuses a replaced parent, substituted file, zero target or mismatched source',async()=>{
  for(const mode of ['parent','file','target','source'])await withPassiveListing(async f=>{
    await f.write();await f.readers.readListing(f.capture,f.options);
    if(mode==='parent'){await fs.rename(f.directory,f.directory+'-original');await fs.mkdir(f.directory);await f.write();}
    if(mode==='file'){await fs.rename(f.output,f.output+'-original');await f.write();}
    if(mode==='target'){f.listing.items=[];await f.write();}
    if(mode==='source')await fs.writeFile(f.sourceFile,'changed private fixture');
    await assert.rejects(f.readers.readListing(f.capture,f.options));
  });
});

test('passive listing refuses links, excessive size and phase abort and labels an anchor first acquired after close',async()=>{
  await withPassiveListing(async f=>{
    f.capture.closed=true;await f.write();const value=await f.readers.readListing(f.capture,f.options);assert.equal(value.directoryBoundBeforeClose,false);
    await fs.writeFile(f.output,Buffer.alloc(262145));await assert.rejects(f.readers.readListing(f.capture,f.options));
    await fs.unlink(f.output);await fs.symlink(f.sourceFile,f.output);await assert.rejects(f.readers.readListing(f.capture,f.options));
    const aborted=AbortSignal.abort();await assert.rejects(f.readers.readListing(f.capture,{...f.options,signal:aborted}));
  });
});

test('discovery diagnostic refuses another host, phase, product, Core or origin and is inert when off',()=>{
  assert.doesNotThrow(()=>assertNativeDiscoveryDiagnostic({enabled:false,stage:'irrelevant'}));
  assert.doesNotThrow(()=>assertNativeDiscoveryDiagnostic(diagnosticSelection()));
  for(const [key,value]of Object.entries({event:'pull_request',artifact:'public',stage:'focused',scope:'all',core:'general',
    partition:'agentic',platform:'linux',arch:'arm64',backendJulia:'1.10',originRun:'other',originName:'other',originSha:'other',
    coreCommit:'other',coreTree:'other',newOrigin:true}))assert.throws(()=>assertNativeDiscoveryDiagnostic({...diagnosticSelection(),[key]:value}),key);
});

test('discovery matcher uses the exact known private invocation and never inspects a running argv',()=>{
  const args=discoveryArgs(),options={cwd:discoveryExpected.root,env:{token:'PRIVATE'}};
  assert.equal(nativeDiscoverySpawnOutput(discoveryExpected.executable,args,options,discoveryExpected),args[8].slice(9));
  for(const index of [0,1,3,6,7,8,9,10,11]){const other=[...args];other[index]+='changed';
    assert.equal(nativeDiscoverySpawnOutput(discoveryExpected.executable,other,options,discoveryExpected),undefined);}
  assert.equal(nativeDiscoverySpawnOutput('/other/julia',args,options,discoveryExpected),undefined);
});

test('discovery hook delegates once with identical arguments, this and ChildProcess before observers run',async()=>{
  const records=[],calls=[],child=observationChild();let reads=0;
  const cp={spawn:function(){calls.push({self:this,args:[...arguments]});return child;}},original=cp.spawn;
  const observer=installNativeDiscoveryObserver({childProcess:cp,expected:discoveryExpected,delays:[0],record:row=>records.push(row),
    readListing:async()=>{reads++;return{status:'not-observed'};},observe:async()=>({qualified:true})});
  const args=discoveryArgs(),options={cwd:discoveryExpected.root};
  try{assert.equal(cp.spawn(discoveryExpected.executable,args,options),child);assert.equal(reads,0);assert.equal(calls.length,1);
    assert.equal(calls[0].self,cp);assert.equal(calls[0].args[1],args);assert.equal(calls[0].args[2],options);
    await new Promise(resolve=>setTimeout(resolve,5));assert.equal(reads,1);
    child.exitCode=0;child.emit('exit',0,null);child.emit('close',0,null);await nextObservationTurn();
  }finally{await observer.retire();}
  assert.equal(cp.spawn,original);assert(records.some(row=>row.stage==='product-close'));
  assert(!JSON.stringify(records).includes('/private/'));assert.equal(records.at(-1).drained,true);
});

test('diagnostic matcher and sink failures cannot lose an already spawned product or replace its synchronous error',async()=>{
  const child=observationChild(),calls=[],cp={spawn:function(){calls.push([...arguments]);return child;}};
  const observer=installNativeDiscoveryObserver({childProcess:cp,expected:discoveryExpected,delays:[],
    record:()=>{},observe:async()=>({}),readListing:async()=>({})});
  const args=discoveryArgs();Object.defineProperty(args,8,{get(){throw new Error('PRIVATE matcher failure');}});
  assert.equal(cp.spawn(discoveryExpected.executable,args,{cwd:discoveryExpected.root}),child);assert.equal(calls.length,1);
  await assert.rejects(observer.retire(),error=>error instanceof AggregateError&&!String(error).includes('PRIVATE'));
  const primary=new Error('original spawn refusal'),failing={spawn(){throw primary;}};
  const other=installNativeDiscoveryObserver({childProcess:failing,expected:discoveryExpected,record:()=>{throw new Error('PRIVATE sink');},
    observe:async()=>{assert.fail('No observer after refused spawn');},readListing:async()=>({})});
  assert.throws(()=>failing.spawn('anything',[]),error=>error===primary);
  await assert.rejects(other.retire());
  const short={spawn:function(){assert.equal(arguments.length,2);return child;}};
  const exact=installNativeDiscoveryObserver({childProcess:short,expected:discoveryExpected,record:()=>{},observe:async()=>({}),readListing:async()=>({})});
  assert.equal(short.spawn('other',[]),child);await exact.retire();
});

test('discovery observation keeps a valid listing when process inspection fails without leaking tool messages',async()=>{
  const records=[],child=observationChild(),cp={spawn:()=>child};let started;
  const entered=new Promise(resolve=>{started=resolve;});
  const observer=installNativeDiscoveryObserver({childProcess:cp,expected:discoveryExpected,delays:[0],record:row=>records.push(row),
    readListing:async()=>({status:'valid-listing',sha256:'safe'}),observe:async()=>{started();throw Object.assign(new Error('PRIVATE argv'),{diagnosticStage:'image-after',code:'EACCES'});}});
  try{cp.spawn(discoveryExpected.executable,discoveryArgs(),{cwd:discoveryExpected.root});await entered;await nextObservationTurn();}
  finally{await observer.retire();}
  assert(records.some(row=>row.stage==='listing-observed'&&row.listing.status==='valid-listing'));
  assert(records.some(row=>row.stage==='snapshot-unknown'&&row.step==='image-after'&&row.code==='EACCES'));
  assert(!JSON.stringify(records).includes('PRIVATE'));
});

test('discovery observer coalesces readers, aborts and physically drains them, and refuses a replaced hook',async()=>{
  const child=observationChild(),cp={spawn:()=>child},records=[];let calls=0,aborted=false,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const observer=installNativeDiscoveryObserver({childProcess:cp,expected:discoveryExpected,delays:[0,0,0],record:row=>records.push(row),
    readListing:async()=>({status:'not-observed'}),observe:(capture,{signal})=>new Promise(resolve=>{calls++;entered();
      signal.addEventListener('abort',()=>{aborted=true;resolve({qualified:true});},{once:true});})});
  cp.spawn(discoveryExpected.executable,discoveryArgs(),{cwd:discoveryExpected.root});await started;await nextObservationTurn();
  assert.equal(calls,1);await observer.retire();assert(aborted);assert.equal(records.at(-1).drained,true);
  const other=installNativeDiscoveryObserver({childProcess:cp,expected:discoveryExpected,delays:[],record:()=>{},observe:async()=>({}),readListing:async()=>({})});
  const foreign=()=>child;cp.spawn=foreign;await assert.rejects(other.retire(),/retirement failed/);assert.equal(cp.spawn,foreign);
});

test('discovery listing delayed beyond abort and retirement is unknown and never published as active',async()=>{
  const child=observationChild(),cp={spawn:()=>child},records=[];let resolveRead,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const observer=installNativeDiscoveryObserver({childProcess:cp,expected:discoveryExpected,delays:[0],record:row=>records.push(row),
    readListing:()=>new Promise(resolve=>{resolveRead=resolve;entered();}),observe:async()=>assert.fail('Late listing cannot inspect a process')});
  cp.spawn(discoveryExpected.executable,discoveryArgs(),{cwd:discoveryExpected.root});await started;
  const retired=observer.retire();resolveRead({status:'valid-listing',sha256:'late'});await retired;
  assert(!records.some(row=>row.stage==='listing-observed'));
  assert(records.some(row=>row.stage==='listing-unknown'));assert.equal(records.at(-1).drained,true);
});

test('bounded reads refuse growth and short data and accumulate partial physical reads exactly',async()=>{
  const fake=bytes=>({async read(out,offset,length,position){const n=Math.min(2,length,Math.max(0,bytes.length-position));bytes.copy(out,offset,position,position+n);return{bytesRead:n};}});
  assert.equal(String(await readBoundedNativeFile(fake(Buffer.from('abc')),3,4)),'abc');
  await assert.rejects(readBoundedNativeFile(fake(Buffer.from('ab')),3,4),/short read/);
  await assert.rejects(readBoundedNativeFile(fake(Buffer.from('abcd')),3,4),/growth/);
  await assert.rejects(readBoundedNativeFile(fake(Buffer.from('a')),5,4));
});

test('listing reader records current schema and hashed target and refuses links and stale live identity',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pc-discovery-test-'));
  const output=path.join(root,'result.json'),records=[];
  const readers=createNativeDiscoveryReaders({...discoveryExpected,root,canonicalExecutable:process.execPath},{record:row=>records.push(row)});
  const options={signal:new AbortController().signal,deadlineAt:Date.now()+1000};
  const capture={output,pid:123,parent:process.pid,exited:false,closed:false};
  try{assert.deepEqual(await readers.readListing(capture,options),{status:'not-observed'});
    await fs.writeFile(output,JSON.stringify({schema_version:'perfchecker-testitems/1',root,executed:false,
      items:[{id:'PRIVATE target',name:'Vector reduction',file:'test/performance.jl'}]}));
    const value=await readers.readListing(capture,options);assert.equal(value.targetMatches,1);assert.equal(value.targetIds[0].length,64);
    assert(!JSON.stringify(value).includes('PRIVATE'));await fs.unlink(output);await fs.symlink('missing',output);
    await assert.rejects(readers.readListing(capture,options));
    await assert.rejects(readers.observe({...capture,exited:true},{...options,originalSpawn:()=>assert.fail('Exited product cannot start an observer')}));
  }finally{await readers.retire();await fs.rm(root,{recursive:true,force:true});}
});

test('sample projection accepts only finite known symbols and hashes unknown or overlong names',()=>{
  const value=nativeSampleProjection(Buffer.from(' 12 jl_compile_method_internal (in Julia)\n 3 read\n 9 llvm::PRIVATE_TOKEN\n 8 jl_compilePRIVATE_TOKEN\n'+
    ' 999999999999999999999999 jl_load\n 1 '+ 'jl_compile'+ 'X'.repeat(3000)));
  assert.equal(value.categories.jit,12);assert.equal(value.categories.io,3);assert.equal(value.unclassified.weight,17);
  assert.equal(value.unclassified.lines,2);assert.equal(value.rejectedLines,1);
  assert(!JSON.stringify(value).includes('PRIVATE'));assert(Object.values(value.categories).every(Number.isSafeInteger));
  assert.throws(()=>nativeSampleProjection(Buffer.alloc(2000001)));
});

async function withDiscoveryImage(run){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pc-discovery-image-'));
  const image=path.join(await fs.realpath(directory),'julia');await fs.writeFile(image,'qualified image');
  const created=Date.now(),records=[],children=[],expected={...discoveryExpected,canonicalExecutable:image};
  const capture={pid:123,parent:process.pid,startedAt:created,spawnedAt:created,exited:false,closed:false};
  const control={mappings:()=>['p123','n'+expected.canonicalExecutable],
    identity:()=>process.pid+' '+new Date(created).toString(),cpu:async()=>{}};
  const originalSpawn=(file,args)=>{const child=observationChild(400+children.length);children.push(child);
    queueMicrotask(()=>{void(async()=>{
      let text;if(file.endsWith('lsof'))text=control.mappings().join('\n')+'\n';
      else if(args.includes('lstart='))text=control.identity()+'\n';
      else{await control.cpu();text='R 00:01 0:00.13 3.3\n';}
      child.stdout.emit('data',Buffer.from(text));child.exitCode=0;child.emit('exit',0,null);child.emit('close',0,null);
    })().catch(error=>{child.emit('error',error);child.exitCode=1;child.emit('exit',1,null);child.emit('close',1,null);});});
    return child;};
  const readers=createNativeDiscoveryReaders(expected,{record:row=>records.push(row)});
  const observe=changes=>readers.observe(capture,{signal:new AbortController().signal,deadlineAt:Date.now()+1000,
    originalSpawn,sample:false,...changes});
  const replace=async()=>{const replacement=path.join(directory,'replacement');await fs.writeFile(replacement,'replacement image');await fs.rename(replacement,image);};
  try{await run({image,directory,expected,capture,control,records,observe,replace});}
  finally{await readers.retire();assert.equal(records.at(-1).physicalClose,true);
    assert(children.every(child=>child.exitCode!==null));await fs.rm(directory,{recursive:true,force:true});}
}

test('discovery qualifies the exact expected mapped image despite an unrelated missing mapping and duplicate exact entries',async()=>{
  await withDiscoveryImage(async f=>{
    f.control.mappings=()=>['p123','n'+path.join(f.directory,'PRIVATE missing mapping'),'n'+f.image,'n'+f.image];
    for(let sequence=1;sequence<=2;sequence++){
      const value=await f.observe({sequence});assert.equal(value.qualified,true);assert.equal(value.pid,123);
      assert.equal(value.executable.basename,'julia');assert.equal(value.executable.pathSha256.length,64);
      assert(!JSON.stringify(value).includes(f.directory));
    }
    assert(!JSON.stringify(f.records).includes('PRIVATE'));assert(!JSON.stringify(f.records).includes(f.directory));
  });
});

test('discovery refuses missing, basename-only or foreign-PID image mappings without adopting another image',async()=>{
  for(const kind of ['missing','basename','no-pid','foreign-pid','mixed-pids','malformed-pid'])await withDiscoveryImage(async f=>{
    f.control.mappings=()=>kind==='missing'?['p123']:
      kind==='basename'?['p123','n'+path.join(f.directory,'other','julia')]:kind==='no-pid'?['n'+f.image]:
      kind==='foreign-pid'?['p124','n'+f.image]:kind==='mixed-pids'?['p123','n'+f.image,'p124','n'+f.image]:['punknown','n'+f.image];
    let cpu=false;f.control.cpu=async()=>{cpu=true;};
    await assert.rejects(f.observe(),error=>error.diagnosticStage==='image-before');assert.equal(cpu,false);
  });
});

test('discovery refuses a noncanonical expected path and an expected image which disappeared',async()=>{
  await withDiscoveryImage(async f=>{const alias=path.join(f.directory,'alias');await fs.symlink(f.image,alias);
    f.expected.canonicalExecutable=alias;
    await assert.rejects(f.observe(),error=>error.diagnosticStage==='image-before');
  });
  await withDiscoveryImage(async f=>{await fs.unlink(f.image);
    await assert.rejects(f.observe(),error=>error.diagnosticStage==='image-before'&&error.code==='ENOENT');
  });
});

test('discovery anchors the expected file incarnation across observations and refuses replacement',async()=>{
  await withDiscoveryImage(async f=>{assert.equal((await f.observe()).qualified,true);await f.replace();
    await assert.rejects(f.observe(),error=>error.diagnosticStage==='image-before');
  });
});

test('discovery rechecks the exact image after CPU observation and refuses replacement or removal',async()=>{
  for(const kind of ['replace','remove'])await withDiscoveryImage(async f=>{
    f.control.cpu=()=>kind==='replace'?f.replace():fs.unlink(f.image);
    await assert.rejects(f.observe(),error=>error.diagnosticStage==='image-after'&&(kind!=='remove'||error.code==='ENOENT'));
  });
});

test('discovery refuses changed process parent or incarnation before and after CPU observation',async()=>{
  for(const kind of ['parent','incarnation'])await withDiscoveryImage(async f=>{
    await f.observe();f.control.identity=()=>kind==='parent'?(process.pid+1)+' '+new Date(f.capture.startedAt).toString():
      process.pid+' '+new Date(f.capture.startedAt+2000).toString();
    await assert.rejects(f.observe(),error=>error.diagnosticStage==='identity-before');
  });
  await withDiscoveryImage(async f=>{f.control.cpu=async()=>{f.control.identity=()=>(process.pid+1)+' '+new Date(f.capture.startedAt).toString();};
    await assert.rejects(f.observe(),error=>error.diagnosticStage==='identity-after');
  });
});

test('discovery retains exit and abort refusals around the exact expected image',async()=>{
  await withDiscoveryImage(async f=>{f.control.cpu=async()=>{f.capture.exited=true;};
    await assert.rejects(f.observe(),error=>error.diagnosticStage==='image-after');
  });
  await withDiscoveryImage(async f=>{const abort=new AbortController();f.control.cpu=async()=>abort.abort();
    await assert.rejects(f.observe({signal:abort.signal}),error=>error.diagnosticStage==='image-after');
  });
});

test('sample temporary directories retire after chmod or open fails without launching a sample writer',async()=>{
  const realChmod=fs.chmod,realOpen=fs.open,realMkdtemp=fs.mkdtemp;
  for(const failingMethod of ['chmod','open']){
    const records=[],directoryNames=[],toolNames=[],created=Date.now(),image=await fs.realpath(process.execPath);
    const expected={...discoveryExpected,canonicalExecutable:image};
    const readers=createNativeDiscoveryReaders(expected,{sampleSyntax:{supported:true},record:row=>records.push(row)});
    const fakeSpawn=(file,args)=>{toolNames.push(path.basename(file));const child=observationChild(456);
      queueMicrotask(()=>{const text=file.endsWith('lsof')?'p123\nn'+image+'\n':args.includes('lstart=')?
        process.pid+' '+new Date(created).toString()+'\n':'R 00:01 0:00.01 1.0\n';
        child.stdout.emit('data',Buffer.from(text));child.emit('exit',0,null);child.emit('close',0,null);});return child;};
    const primary=new Error('controlled setup failure');
    fs.mkdtemp=async(...args)=>{const directory=await realMkdtemp(...args);directoryNames.push(directory);return directory;};
    fs.chmod=failingMethod==='chmod'?async()=>{throw primary;}:realChmod;
    fs.open=failingMethod==='open'?async()=>{throw primary;}:realOpen;
    try{await assert.rejects(readers.observe({pid:123,parent:process.pid,startedAt:created,spawnedAt:created,exited:false,closed:false},
      {signal:new AbortController().signal,deadlineAt:Date.now()+1000,originalSpawn:fakeSpawn,sample:true}),error=>error===primary);
    }finally{fs.chmod=realChmod;fs.open=realOpen;fs.mkdtemp=realMkdtemp;await readers.retire();}
    assert.equal(directoryNames.length,1);assert(!toolNames.includes('sample'));
    await assert.rejects(fs.lstat(directoryNames[0]),error=>error.code==='ENOENT');assert.equal(records.at(-1).physicalClose,true);
  }
});

test('reader retirement preserves a sink error after closing and removing safe sample output',async()=>{
  const primary=new Error('original diagnostic sink failure'),created=Date.now(),image=await fs.realpath(process.execPath);
  const realMkdtemp=fs.mkdtemp,directories=[];
  const readers=createNativeDiscoveryReaders({...discoveryExpected,canonicalExecutable:image},{sampleSyntax:{supported:true},
    record:row=>{if(row.stage==='owned-observers-retired')throw primary;}});
  const fakeSpawn=(file,args,options)=>{const child=observationChild(456);
    queueMicrotask(()=>{
      if(file.endsWith('sample')){assert.equal(args.at(-1),'/dev/fd/3');writeSync(options.stdio[3],' 4 jl_compile_method_internal\n');}
      else{const text=file.endsWith('lsof')?'p123\nn'+image+'\n':args.includes('lstart=')?
        process.pid+' '+new Date(created).toString()+'\n':'R 00:01 0:00.01 1.0\n';child.stdout.emit('data',Buffer.from(text));}
      child.emit('exit',0,null);child.emit('close',0,null);
    });return child;};
  fs.mkdtemp=async(...args)=>{const directory=await realMkdtemp(...args);directories.push(directory);return directory;};
  try{
    const result=await readers.observe({pid:123,parent:process.pid,startedAt:created,spawnedAt:created,exited:false,closed:false},
      {signal:new AbortController().signal,deadlineAt:Date.now()+1000,originalSpawn:fakeSpawn,sample:true});
    assert.equal(result.stack.categories.jit,4);
    await assert.rejects(readers.retire(),error=>error===primary);
    assert.equal(directories.length,1);await assert.rejects(fs.lstat(directories[0]),error=>error.code==='ENOENT');
  }finally{fs.mkdtemp=realMkdtemp;for(const directory of directories)await fs.rm(directory,{recursive:true,force:true});}
});

test('sample command syntax is supported only by explicit installed man or mdoc options',()=>{
  assert(nativeSampleManualContract(Buffer.from('sample pid duration interval [-mayDie] [-file output]')).supported);
  assert(nativeSampleManualContract(Buffer.from('.Dt SAMPLE 1\n.Nm sample\n.Ar pid\n.Ar duration\n.Ar interval\n.Fl mayDie\n.Fl file')).supported);
  for(const text of ['sample pid duration interval mayDie file','sample pid duration interval -mayDied -filename',
    'sample pid -file output -mayDie'])assert.equal(nativeSampleManualContract(Buffer.from(text)).supported,false);
});

test('owned inspection stops once and preserves the first error until real close with safe tool metadata',async()=>{
  const child=observationChild(),controller=new AbortController(),records=[],primary=new Error('PRIVATE original command error');let kills=0;
  child.kill=()=>{kills++;return true;};
  const pending=discoveryOwnedCommand(()=>child,'/bin/ps',[],{signal:controller.signal,deadlineAt:Date.now()+1000,states:[],
    record:row=>records.push(row),stage:'cpu',targetPid:456,sequence:1});
  child.emit('error',primary);child.stdout.emit('data',Buffer.alloc(131073));controller.abort();child.stderr.emit('data',Buffer.alloc(16385));
  assert.equal(kills,1);let finished=false;void pending.catch(()=>{finished=true;});await nextObservationTurn();assert.equal(finished,false);
  child.emit('exit',null,'SIGTERM');child.emit('close',null,'SIGTERM');await assert.rejects(pending,error=>error===primary);
  assert.equal(kills,1);assert.equal(records.length,1);assert.equal(records[0].physicalClose,true);
  assert.equal(records[0].tool,'ps');assert.equal(records[0].stdoutBytes,131073);assert(!JSON.stringify(records).includes('PRIVATE'));
});

const observationDelay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const operationSnapshot=()=>({hostPid:10,expectedExecutable:process.execPath,
  rows:[{pid:11,parent:10,createdAt:'2026-10-14T10:00:00.000Z',canonicalExecutable:process.execPath,
    progress:{state:'R',elapsed:'00:12',cpuTime:'0:03.10',cpuPercent:'25.0'},argv:'private source',token:'private token'}],
  files:[{name:'suite',present:false,contents:'private source'}],environment:'private environment'});

test('native state observations revalidate the executable after reading progress',async()=>{
  const order=[],progress={state:'R'};
  assert.equal(await captureQualifiedNativeProgress(process.execPath,[process.execPath],async()=>{order.push('states');return progress;},
    async()=>{order.push('image-after');return[process.execPath];}),progress);
  assert.deepEqual(order,['states','image-after']);
  await assert.rejects(captureQualifiedNativeProgress(process.execPath,[process.execPath],async()=>progress,async()=>['/other/executable']),/changed or uncertain executable/);
  const unknown=Object.assign(new Error('canonical executable unavailable'),{code:'ENOENT'});
  await assert.rejects(captureQualifiedNativeProgress(process.execPath,[process.execPath],async()=>progress,async()=>{throw unknown;}),error=>error===unknown);
  let read=false;
  await assert.rejects(captureQualifiedNativeProgress(process.execPath,[],async()=>{read=true;return progress;},async()=>[process.execPath]),/canonical executable before/);
  assert.equal(read,false);
});

test('native operation evidence refuses foreign or ambiguous ownership and strips private payloads',()=>{
  const value=operationSnapshot(),safe=nativeOperationSnapshot(value);
  assert(!JSON.stringify(safe).includes('private'));
  assert.deepEqual(safe.files,[{name:'suite',present:false}]);
  for(const rows of [[{...value.rows[0],parent:999}],[...value.rows,...value.rows],
    [{...value.rows[0],identityOnly:true}],[{...value.rows[0],createdAt:'unverified'}]])
    assert.throws(()=>nativeOperationSnapshot({...value,rows}));
  assert.throws(()=>nativeOperationSnapshot({...value,files:[{name:'user-source',present:true,bytes:1,modifiedAt:'2026-10-14T10:00:00Z'}]}));
});

test('native operation invokes the real action first and preserves its exact result',async()=>{
  const order=[],records=[],result={actual:'result'};
  const actual=await observeNativeOperation('plan',async()=>{order.push('action');await observationDelay(15);return result;},{
    deadlineAt:Date.now()+1000,intervalMs:2,sampleTimeoutMs:100,maxSamples:2,
    sample:async()=>{order.push('sample');return operationSnapshot();},record:row=>records.push(row)});
  assert.equal(actual,result);assert.equal(order[0],'action');assert(order.includes('sample'));
  assert(records.filter(row=>row.stage==='sample').length<=2);assert.equal(records.at(-1).stage,'observer-stopped');
  assert.equal(records.at(-1).drained,true);
});

test('observation failure neither replaces a real rejection nor records its private contents',async()=>{
  const primary=new Error('original operation rejection'),records=[];
  await assert.rejects(observeNativeOperation('initialize',async()=>{await observationDelay(10);throw primary;},{
    deadlineAt:Date.now()+1000,intervalMs:1,sampleTimeoutMs:100,maxSamples:1,
    sample:async()=>{throw Object.assign(new Error('private token and argv'),{code:'EACCES'});},record:row=>records.push(row)}),error=>error===primary);
  assert(records.some(row=>row.stage==='inspection-error'&&row.code==='EACCES'));
  assert(!JSON.stringify(records).includes('private'));assert.equal(records.at(-1).drained,true);
});

test('native observer coalesces pending reads and aborts and drains them before returning',async()=>{
  let active=0,maximum=0,calls=0,aborted=0;const records=[];
  await observeNativeOperation('diagnose',async()=>{await observationDelay(20);return 'unchanged';},{
    deadlineAt:Date.now()+1000,intervalMs:1,sampleTimeoutMs:100,maxSamples:10,
    sample:({signal})=>new Promise(resolve=>{calls++;maximum=Math.max(maximum,++active);
      signal.addEventListener('abort',()=>{aborted++;active--;resolve(operationSnapshot());},{once:true});}),record:row=>records.push(row)});
  assert.equal(maximum,1);assert.equal(calls,1);assert.equal(active,0);assert.equal(aborted,1);
  assert.equal(records.at(-1).drained,true);const count=records.length;
  await observationDelay(10);assert.equal(calls,1);assert.equal(records.length,count);
});

test('late observations cannot qualify a snapshot or extend an expired operation oracle',async()=>{
  const records=[],primary=new Error('original deadline');let finishSample,rejectOperation,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const pending=observeNativeOperation('plan',()=>new Promise((resolve,reject)=>{rejectOperation=reject;}),{
    deadlineAt:Date.now()+1000,intervalMs:1,sampleTimeoutMs:2,maxSamples:1,
    sample:()=>new Promise(resolve=>{finishSample=()=>resolve(operationSnapshot());started();}),record:row=>records.push(row)});
  await entered;rejectOperation(primary);
  await assert.rejects(pending,error=>error===primary);assert.equal(records.at(-1).drained,false);
  finishSample();await new Promise(resolve=>setImmediate(resolve));
  assert(!records.some(row=>row.stage==='sample'));
});

test('a diagnostic sink failure preserves synchronous operation refusal and schedules no observer',async()=>{
  const primary=new Error('original refusal');let sampled=false;
  await assert.rejects(observeNativeOperation('initialize',()=>{throw primary;},{deadlineAt:Date.now()+100,
    sample:async()=>{sampled=true;return operationSnapshot();},record:()=>{throw new Error('sink failed');}}),error=>error===primary);
  assert.equal(sampled,false);
});

const readyLeader={pid:4924,parent:6176,executable:'C:\\Julia\\bin\\julia.exe'};
const readiness={parent:6176,expected:readyLeader.executable,canonical:value=>value.toLowerCase()};

test('READY received during an inventory waits for the next coherent snapshot',async()=>{
  let readyPid,finishInventory,started=false;
  const handshakes=[];
  const observe=snapshot=>{
    if(controllerReadinessObserved({...readiness,readyPid:snapshot.readyPid,started,
      identities:new Map(snapshot.rows.map(row=>[row.pid,row])),live:new Set(snapshot.rows.map(row=>row.pid))})){
      started=true;handshakes.push('OBSERVED\n');
    }
  };
  const first=captureControllerInventory(()=>readyPid,()=>new Promise(resolve=>{finishInventory=resolve;}));
  readyPid=4924;
  const earlierRows=[{pid:6176,parent:6592}];
  finishInventory(earlierRows);
  const initial=await first;
  assert.deepEqual(initial,{readyPid:undefined,rows:earlierRows},'Later stdout cannot qualify an earlier inventory');
  observe(initial);assert.deepEqual(handshakes,[],'The previous inventory cannot send a handshake');
  const currentRows=[...earlierRows,readyLeader];
  const next=await captureControllerInventory(()=>readyPid,async()=>currentRows);
  assert.deepEqual(next,{readyPid:4924,rows:currentRows},'The next inventory binds the received READY to its own rows');
  observe(next);assert.deepEqual(handshakes,['OBSERVED\n']);
  observe(next);assert.equal(handshakes.length,1,'The observed leader starts only once');
});

test('an inventory keeps its initial READY identity and propagates read failures',async()=>{
  let readyPid=4924,finishInventory;
  const pending=captureControllerInventory(()=>readyPid,()=>new Promise(resolve=>{finishInventory=resolve;}));
  readyPid=9000;
  const rows=[{pid:4924,parent:6176}];finishInventory(rows);
  assert.deepEqual(await pending,{readyPid:4924,rows});
  const failure=new Error('CIM inventory failed');
  await assert.rejects(captureControllerInventory(()=>readyPid,async()=>{throw failure;}),error=>error===failure);
});

test('known READY still requires the live PID, original parent and executable',()=>{
  const qualified={...readiness,readyPid:4924,started:false,identities:new Map([[4924,readyLeader]]),live:new Set([4924])};
  assert.equal(controllerReadinessObserved(qualified),true);
  for(const change of [
    {identities:new Map()},
    {live:new Set()},
    ...[{parent:undefined},{parent:9000},{executable:undefined},{executable:'C:\\Other\\julia.exe'}]
      .map(change=>({identities:new Map([[4924,{...readyLeader,...change}]])})),
  ])assert.throws(()=>controllerReadinessObserved({...qualified,...change}),'Missing or changed ownership evidence is still a failure');
});

const project=path.resolve('controller','Project.toml'),coreRoot=path.resolve('packages','PerfChecker','Δ'),httpRoot=path.resolve('packages','HTTP','abc');
const hex=value=>Buffer.from(value).toString('hex'),tree='a'.repeat(40),httpTree='b'.repeat(40);
const fields=['CONTROLLER_IMPORT_RECEIPT_V1','175.935475','HTTPAdvisorExt',hex(project),
  'PerfChecker','1.0.1',hex(coreRoot),hex(path.join(coreRoot,'src','PerfChecker.jl')),tree,tree,
  'HTTP','2.9.0',hex(httpRoot),hex(path.join(httpRoot,'src','HTTP.jl')),httpTree,httpTree];
const parse=value=>parseControllerImportReceipt(value,{project,version:'1.0.1',tree});
const discoveryRoot=path.resolve('fixture'),discovery={schema_version:'perfchecker-native-testitem-discovery/1',
  project,root:discoveryRoot,startedAt:'2026-10-14T07:00:00.000Z',finishedAt:'2026-10-14T07:00:04.000Z',
  elapsedSeconds:4,listingSchema:'perfchecker-testitems/1',listingRoot:discoveryRoot,executed:false,targetPrepared:false,
  item:{name:'Vector reduction',file:'test/performance.jl'},TestItemRunner:{version:'1.3.2',source:path.resolve('packages','TestItemRunner','src','TestItemRunner.jl')}};
const parseDiscovery=value=>parseControllerTestItemDiscoveryReceipt(value,{project,root:discoveryRoot});
const discoveryLine=receipt=>'CONTROLLER_TESTITEM_DISCOVERY_V1 '+JSON.stringify(receipt);
test('actual discovery preparation keeps timestamps, dependency identity and the missing target',()=>{
  assert.deepEqual(parseDiscovery(discoveryLine(discovery)),discovery);
  for(const change of [{project:path.resolve('other','Project.toml')},{root:path.resolve('other')},
    {startedAt:'unknown'},{finishedAt:'2026-10-14T06:59:59.000Z'},{elapsedSeconds:-1},
    {listingSchema:'other'},{listingRoot:'relative'},{executed:true},{targetPrepared:true},{item:{name:'Other',file:'test/performance.jl'}},
    {item:{name:'Vector reduction',file:'different.jl'}},{TestItemRunner:{version:'unknown',source:'relative'}}])
    assert.throws(()=>parseDiscovery(discoveryLine({...discovery,...change})));
  assert.throws(()=>parseDiscovery(''));
  assert.throws(()=>parseDiscovery(discoveryLine(discovery)+'\n'+discoveryLine(discovery)));
});
test('primitive preflight receipt preserves real import time, Unicode paths and both pinned source trees',()=>{
  const value=parse(`CONTROLLER_IMPORT_AFTER HTTP elapsed=175.935475\n${fields.join('\t')}\n`);
  assert.equal(value.elapsedSeconds,175.935475);assert.equal(value.packages[0].root,coreRoot);
  assert.equal(value.packages[1].tree,httpTree);assert.equal(value.activeProject,project);
  assert(!controllerPreflightScript.includes('JSON.print'));assert(controllerPreflightScript.includes('Pkg.GitTools.tree_hash(root)'));
});
test('missing, duplicate, truncated, malformed and mismatched identities fail closed',()=>{
  assert.throws(()=>parse('CONTROLLER_IMPORT_RECEIPT '));
  assert.throws(()=>parse(`${fields.join('\t')}\n${fields.join('\t')}`));
  assert.throws(()=>parse(fields.slice(0,-1).join('\t')));
  for(const [index,value]of [[0,'CONTROLLER_IMPORT_RECEIPT_V2'],[1,'Infinity'],[1,'-1'],[2,'MissingExt'],
    [3,hex(path.resolve('different','Project.toml'))],[5,'1.0.0'],[6,'ff'],[6,'0'],[6,hex('relative')],
    [7,hex(path.join(httpRoot,'src','HTTP.jl'))],[8,'c'.repeat(40)],[10,'Other'],[15,'c'.repeat(40)]]){
    const changed=[...fields];changed[index]=value;assert.throws(()=>parse(changed.join('\t')),`Reject field ${index}: ${value}`);
  }
});
test('failed inspection preserves target, timing and subprocess cause without weakening qualification',()=>{
  const error=Object.assign(new Error('Process survey failed'),{code:1,signal:'SIGTERM',killed:true,stderr:'x'.repeat(4500),stdout:'not requested'});
  const value=controllerInspectionFailure(error,{stage:'survey',pid:123,ownerPid:456});
  assert.equal(value.pid,123);assert.equal(value.ownerPid,456);assert.equal(value.code,1);assert.equal(value.signal,'SIGTERM');
  assert.equal(value.killed,true);assert.equal(value.stderr.length,4000);assert(Number.isFinite(Date.parse(value.observedAt)));
  assert(!('stdout'in value));assert(!('command'in value));assert.equal(controllerInspectionFailure(new Error('unknown'),{stage:'inspect',pid:2,ownerPid:1}).code,null);
});

const incarnation={pid:5280,parent:4607,group:4607,started:'26774',state:'R',executable:path.resolve('julia','bin','julia')};
const missing=code=>Object.assign(new Error('The qualified executable is temporarily unavailable'),{code});
function executableRevalidation({states=[incarnation],images=[incarnation.executable],code='ENOENT',deadlineAt=5000,identity=incarnation}={}){
  let clock=0,stateReads=0,imageReads=0;const history=[];
  const take=(values,index)=>values[Math.min(index,values.length-1)];
  const readCurrent=async()=>{const value=take(states,stateReads++);if(value instanceof Error)throw value;return value;};
  const readExecutable=async()=>{const value=take(images,imageReads++);if(value instanceof Error)throw value;return value;};
  const error=missing(code);
  return {run:()=>revalidateQualifiedLinuxExecutable({identity,error,deadlineAt,readCurrent,readExecutable,
    record:value=>history.push(value),now:()=>clock,wait:async milliseconds=>{clock+=milliseconds;}}),
    history,error,counts:()=>({stateReads,imageReads,elapsed:clock})};
}
test('a qualified executable race resolves only after absence of its original incarnation',async()=>{
  const probe=executableRevalidation({states:[incarnation,incarnation,undefined],images:[missing('ENOENT')]});
  assert.equal(await probe.run(),undefined);assert.equal(probe.history[0].resolution,'proved-absent');
  assert.equal(probe.history[0].errorCode,'ENOENT');assert.equal(probe.history[0].rechecks.length,2);
  assert.equal(probe.history[0].rechecks[0].afterError.started,incarnation.started);
});
for(const state of ['Z','X'])test(`same-birth ${state} after reparenting qualifies extinction without reading an unknown image`,async()=>{
  const probe=executableRevalidation({states:[{...incarnation,state,parent:1}]});
  assert.equal(await probe.run(),undefined);assert.equal(probe.history[0].resolution,'same-incarnation-dead');
  assert.equal(probe.counts().imageReads,0);
});
for(const code of ['ENOENT','ESRCH'])test(`${code} can resolve to the exact image only after two stable reads`,async()=>{
  const probe=executableRevalidation({code});const value=await probe.run();
  assert.deepEqual(value,incarnation);assert.deepEqual(probe.counts(),{stateReads:3,imageReads:2,elapsed:0});
  assert.equal(probe.history[0].resolution,'same-incarnation-stable-image');
});
for(const state of ['R','Z'])test(`a reused PID in state ${state} remains a refusal before any executable read`,async()=>{
  const probe=executableRevalidation({states:[{...incarnation,started:'26775',state}]});
  await assert.rejects(probe.run(),/Reused PID/);assert.equal(probe.counts().imageReads,0);
  assert.equal(probe.history[0].resolution,'refused');
});
test('a changed group does not repair executable uncertainty',async()=>{
  const probe=executableRevalidation({states:[{...incarnation,group:9999}]});
  await assert.rejects(probe.run(),/changed process group/);assert.equal(probe.history[0].resolution,'refused');
});
for(const images of [[path.resolve('other')],[incarnation.executable,path.resolve('other')]])
  test(`a different image on read ${images.length} is not adopted`,async()=>{
    const probe=executableRevalidation({images});await assert.rejects(probe.run(),/different executable/);
    assert.equal(probe.history[0].resolution,'refused');
  });
test('EACCES is never treated as a transient executable disappearance',async()=>{
  const initial=executableRevalidation({code:'EACCES'});await assert.rejects(initial.run(),error=>error===initial.error);
  assert.deepEqual(initial.history,[]);assert.equal(initial.counts().stateReads,0);
  const failure=missing('EACCES'),during=executableRevalidation({images:[failure]});
  await assert.rejects(during.run(),error=>error===failure);assert.equal(during.history[0].resolution,'refused');
});
test('stat inspection failures remain fatal during revalidation',async()=>{
  const failure=missing('EACCES'),probe=executableRevalidation({states:[failure]});
  await assert.rejects(probe.run(),error=>error===failure);assert.equal(probe.history[0].resolution,'refused');
});
for(const [deadlineAt,maximum]of [[5000,1000],[175,175]])
  test(`a live unknown image fails within ${maximum} ms and retains its uncertainty history`,async()=>{
    const probe=executableRevalidation({deadlineAt,images:[missing('ENOENT')]});
    await assert.rejects(probe.run(),error=>error===probe.error);assert.equal(probe.counts().elapsed,maximum);
    assert.equal(probe.history[0].resolution,'refused');assert(probe.history[0].rechecks.length>1);
  });
test('an unqualified process cannot enter executable revalidation',async()=>{
  const probe=executableRevalidation({identity:null});await assert.rejects(probe.run());
  assert.deepEqual(probe.history,[]);assert.deepEqual(probe.counts(),{stateReads:0,imageReads:0,elapsed:0});
});
