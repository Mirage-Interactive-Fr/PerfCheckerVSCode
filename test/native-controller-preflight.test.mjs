import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {controllerPreflightScript,parseControllerImportReceipt,parseControllerTestItemDiscoveryReceipt,controllerInspectionFailure,revalidateQualifiedLinuxExecutable,captureControllerInventory,controllerReadinessObserved} from './native-controller-preflight.mjs';

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
