import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

// Exercise the actual native harness observer with controlled kernel reads.
// No signal API is supplied: uncertainty can never cause a process signal.
const source=await readFile(new URL('./native-mcp-controls.cjs',import.meta.url),'utf8');
const observerSource=source.slice(source.indexOf('async function linuxNativeStat('),source.indexOf('const nativeParentObservations='));
const load=new Function('fs','assert','process','delay','Date','execute','path',observerSource+';return nativeIdentity;');
const identity={pid:81,parent:10,group:81,start:'123',executable:'/fixture/node'};
const missing=code=>Object.assign(new Error('controlled executable observation failure'),{code});
function scenario({stats=[],executables=[],fallbackStat={},fallbackExecutable=identity.executable}={}){
  let elapsed=0,statReads=0,executableReads=0;const observations=[];
  const stat=values=>{const fields=['S','10','81',...Array(16).fill('0'),'123'];
    if(values===null)throw missing('ENOENT');
    fields[0]=values.state??'S';fields[1]=String(values.parent??10);fields[2]=String(values.group??81);fields[19]=values.start??'123';
    return '81 (fixture process) '+fields.join(' ');};
  const fs={readFile:async()=>{statReads++;return stat(stats.length?stats.shift():fallbackStat);},
    realpath:async()=>{executableReads++;const value=executables.length?executables.shift():fallbackExecutable;if(value instanceof Error)throw value;return value;}};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[elapsed]));}static now(){return elapsed;}}
  const observe=load(fs,assert,{platform:'linux'},async ms=>{elapsed+=ms;},Clock);
  return{run:()=>observe(identity.pid,identity.executable,row=>observations.push(row),identity),observations,
    snapshot:()=>({elapsed,statReads,executableReads})};
}

test('native identity reobserves the same executable after transient ENOENT within 200ms',async()=>{
  const value=scenario({executables:[missing('ENOENT'),identity.executable]});
  assert.deepEqual(await value.run(),identity);assert.equal(value.snapshot().elapsed,10);
  assert.deepEqual(value.observations.map(row=>row.kind),['unavailable-executable','executable-reobserved']);
  assert.equal(value.observations[0].before.start,identity.start);assert.equal(value.observations[0].current.group,identity.group);
});

for(const [name,terminal]of [['absence',null],['zombie',{state:'Z'}]])test('native identity accepts observed '+name+' after ENOENT',async()=>{
  const value=scenario({stats:[{},{},{},terminal],executables:[missing('ENOENT')]});
  assert.equal(await value.run(),undefined);assert.equal(value.snapshot().elapsed,10);
  assert.equal(value.snapshot().executableReads,1);
});

for(const [name,changed]of [['PID reuse',{start:'124'}],['private group change',{group:82}]])test('native identity rejects '+name+' during ENOENT revalidation',async()=>{
  const value=scenario({stats:[{},{},{},changed],executables:[missing('ENOENT')]});
  await assert.rejects(value.run(),assert.AssertionError);assert.equal(value.snapshot().executableReads,1);
});

test('native identity rejects a different executable after transient ENOENT',async()=>{
  const value=scenario({executables:[missing('ENOENT'),'/foreign/node']});
  await assert.rejects(value.run(),assert.AssertionError);
});

for(const [name,changed]of [['PID reuse',{start:'124'}],['private group change',{group:82}]])test('native identity brackets the recovered executable against '+name,async()=>{
  const value=scenario({stats:[{},{},{},{},changed],executables:[missing('ENOENT'),identity.executable]});
  await assert.rejects(value.run(),assert.AssertionError);assert.equal(value.snapshot().executableReads,2);
});

for(const code of ['EACCES','ESRCH'])test('native identity never retries a live '+code+' executable failure',async()=>{
  const failure=missing(code),value=scenario({executables:[failure]});
  await assert.rejects(value.run(),error=>error===failure);assert.equal(value.snapshot().elapsed,0);
  assert.equal(value.snapshot().executableReads,1);
});

test('native identity fails persistent executable uncertainty at 200ms without accepting it',async()=>{
  const failure=missing('ENOENT'),value=scenario({fallbackExecutable:failure});
  await assert.rejects(value.run(),error=>error===failure);
  assert.equal(value.snapshot().elapsed,200);assert.equal(value.snapshot().executableReads,20);
  assert(value.observations.every(row=>row.kind==='unavailable-executable'&&row.current.start===identity.start));
});

const darwinIdentity={...identity,start:'Sat Oct 10 23:42:58 2026',executable:'/fixture/julia'};
function darwinScenario({stats=[],mappings=[],executables=[],fallbackStat={},fallbackMappings='',established=true}={}){
  let elapsed=0,statReads=0,mappingReads=0;const observations=[],timeouts=[];
  const execute=async(command,args,{timeout})=>{
    timeouts.push({command,timeout});let value;
    if(command==='ps'){
      statReads++;value=stats.length?stats.shift():fallbackStat;
      if(value instanceof Error)throw value;
      if(value===null)throw Object.assign(missing(1),{stdout:'',stderr:''});
      return{stdout:`${value.parent??10} ${value.group??81} ${value.state??'S'} ${value.start??darwinIdentity.start}\n`};
    }
    assert.equal(command,'lsof');mappingReads++;value=mappings.length?mappings.shift():fallbackMappings;
    if(value instanceof Error)throw value;return{stdout:value};
  };
  const fs={realpath:async file=>{const value=executables.length?executables.shift():file;if(value instanceof Error)throw value;return value;}};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[elapsed]));}static now(){return elapsed;}}
  const observe=load(fs,assert,{platform:'darwin'},async ms=>{elapsed+=ms;},Clock,execute,path);
  return{run:()=>observe(darwinIdentity.pid,darwinIdentity.executable,row=>observations.push(row),established?darwinIdentity:undefined),observations,
    snapshot:()=>({elapsed,statReads,mappingReads,timeouts})};
}

for(const [name,terminal,resolution]of [['absence',null,'proved-absent'],['zombie',{state:'Z'},'same-incarnation-dead']])
  test('Darwin identity accepts observed '+name+' after an established image disappears',async()=>{
    const value=darwinScenario({stats:[{},{},terminal]});
    assert.equal(await value.run(),undefined);assert.equal(value.snapshot().elapsed,10);
    assert.equal(value.observations[0].kind,'darwin-unavailable-executable');
    assert.equal(value.observations.at(-1).resolution,resolution);
    assert.equal(Date.parse(value.observations[0].deadlineAt),200);
  });

test('Darwin identity reobserves the canonical image without adopting another incarnation',async()=>{
  const value=darwinScenario({mappings:['n/fixture/libjulia.dylib\n','n/fixture/julia\n']});
  assert.deepEqual(await value.run(),darwinIdentity);assert.equal(value.snapshot().elapsed,10);
  assert.equal(value.observations.at(-1).resolution,'same-incarnation-canonical-image');
  assert(value.snapshot().timeouts.slice(3).every(row=>row.timeout>0&&row.timeout<=200));
});

test('Darwin identity treats lsof empty exit 1 as bounded uncertainty only for an established image',async()=>{
  const value=darwinScenario({mappings:[Object.assign(missing(1),{stdout:'',stderr:''}),'n/fixture/julia\n']});
  assert.deepEqual(await value.run(),darwinIdentity);assert.equal(value.snapshot().elapsed,10);
});

for(const [name,changed]of [['PID reuse',{start:'Sat Oct 10 23:42:59 2026'}],['private group change',{group:82}]]){
  test('Darwin identity rejects '+name+' before accepting an initial zombie',async()=>{
    const value=darwinScenario({stats:[{...changed,state:'Z'}]});
    await assert.rejects(value.run(),assert.AssertionError);assert.equal(value.snapshot().mappingReads,0);
  });
  test('Darwin identity rejects '+name+' during revalidation before accepting a zombie',async()=>{
    const value=darwinScenario({stats:[{},{},{...changed,state:'Z'}]});
    await assert.rejects(value.run(),assert.AssertionError);assert.equal(value.snapshot().elapsed,10);
    assert(!value.observations.some(row=>row.resolution));
  });
  test('Darwin identity brackets a canonical image against '+name,async()=>{
    const value=darwinScenario({stats:[{},changed],mappings:['n/fixture/julia\n']});
    await assert.rejects(value.run(),assert.AssertionError);
  });
}

test('Darwin identity immediately refuses a different canonical executable',async()=>{
  const value=darwinScenario({mappings:['n/foreign/julia\n']});
  await assert.rejects(value.run(),assert.AssertionError);assert.equal(value.snapshot().elapsed,0);
});

for(const [name,failure]of [['permission',missing('EACCES')],['stderr',Object.assign(missing(1),{stdout:'',stderr:'permission denied'})]])
  test('Darwin identity preserves '+name+' failures without retry',async()=>{
    const value=darwinScenario({mappings:[failure]});
    await assert.rejects(value.run(),error=>error===failure);assert.equal(value.snapshot().elapsed,0);
    assert.equal(value.snapshot().mappingReads,1);
  });

test('Darwin identity refuses permission failure in a revalidation process read',async()=>{
  const failure=missing('EACCES'),value=darwinScenario({stats:[{},{},failure]});
  await assert.rejects(value.run(),error=>error===failure);assert(!value.observations.some(row=>row.resolution));
});

test('Darwin identity fails persistent missing-image uncertainty at 200ms',async()=>{
  const value=darwinScenario();
  await assert.rejects(value.run(),/remained unavailable during bounded revalidation/);
  assert.equal(value.snapshot().elapsed,200);assert.equal(value.snapshot().mappingReads,20);
  assert(value.observations.every(row=>row.kind==='darwin-unavailable-executable'&&row.current.start===darwinIdentity.start));
});

test('Darwin identity cannot use missing-image revalidation to establish a new identity',async()=>{
  const value=darwinScenario({established:false});
  await assert.rejects(value.run(),assert.AssertionError);assert.equal(value.snapshot().elapsed,0);
  assert.equal(value.observations.length,0);
});

// Use the real Pluto ownership closure: a recycled ParentProcessId does not prove
// that a pre-existing Windows process descends from a new session incarnation.
const plutoSource=await readFile(new URL('./native-pluto-controls.cjs',import.meta.url),'utf8');
const ownershipSource=plutoSource.slice(plutoSource.indexOf('function processBirth('),plutoSource.indexOf('function plutoDescendants('));
const descendants=new Function('assert',ownershipSource+';return ownedProcessDescendants;')(assert);
const born=(pid,parent,createdAt)=>({pid,parent,createdAt});
const leader=born(7112,9816,'2026-10-11T00:28:24.0735210Z');
const consoleProcess=born(3016,7112,'2026-10-11T00:28:24.0772920Z');

test('Pluto ownership excludes an impossible reused parent PID and its foreign subtree',()=>{
  const foreign=born(6572,3016,'2026-10-10T22:20:47.0320540Z');
  const child=born(4624,7112,'2026-10-11T00:28:32.7424170Z'),rejected=[];
  const rows=[born(6080,6572,'2026-10-10T22:20:47.1019820Z'),foreign,consoleProcess,child,leader];
  assert.deepEqual(new Set(descendants(rows,[leader],row=>rejected.push(row)).map(row=>row.pid)),new Set([7112,3016,4624]));
  assert(rejected.length>0&&rejected.every(row=>row.pid===6572&&row.parentCreatedAt===consoleProcess.createdAt));
});

test('Pluto ownership preserves submillisecond birth ordering and allows equal timestamps',()=>{
  const parent=born(81,10,'2026-10-11T00:28:24.0735210Z');
  const earlier=born(82,81,'2026-10-11T00:28:24.0735209Z');
  const same=born(83,81,parent.createdAt),later=born(84,81,'2026-10-11T00:28:24.0735211Z');
  assert.deepEqual(descendants([parent,earlier,same,later],[parent]).map(row=>row.pid),[81,83,84]);
});

test('Pluto ownership does not adopt a recycled root incarnation or its children',()=>{
  const recycled={...leader,createdAt:'2026-10-11T00:29:24.0735210Z'};
  assert.deepEqual(descendants([recycled,born(90,7112,'2026-10-11T00:30:00Z')],[leader]),[]);
});

for(const [name,createdAt]of [['missing',null],['malformed','not-a-date'],['invalid calendar','2026-02-30T00:28:24Z']]){
  test('Pluto ownership rejects the '+name+' descendant creation date',()=>{
    assert.throws(()=>descendants([leader,born(90,leader.pid,createdAt)],[leader]),assert.AssertionError);
  });
  test('Pluto ownership rejects the '+name+' current root creation date',()=>{
    assert.throws(()=>descendants([{...leader,createdAt}],[leader]),assert.AssertionError);
  });
}

test('Pluto ownership cannot adopt grandchildren through a reused known parent incarnation',()=>{
  const recycled={...consoleProcess,createdAt:'2026-10-11T00:29:00Z'};
  assert.deepEqual(descendants([recycled,born(90,3016,'2026-10-11T00:30:00Z')],[consoleProcess]),[]);
});

// Exercise the actual Results document wait, including its native click boundary.
const studioSource=await readFile(new URL('./native-studio-controls.cjs',import.meta.url),'utf8');
const resultsSource=studioSource.slice(studioSource.indexOf('async function resultDocuments('),studioSource.indexOf('async function resetDesigner('));
function resultsScenario({snapshots=[],fallback=[],clickError,readError,detached=false}={}){
  let elapsed=0,clicks=0,reads=0;const observations=[];
  const frame=(nonce,visible=true)=>({nonce,isDetached:()=>detached,parentFrame:()=>null,
    locator:selector=>selector.startsWith('button')?{count:async()=>{if(readError)throw readError;return 1;},first:()=>({isVisible:async()=>visible})}:
      {evaluate:async evaluate=>evaluate({nonce})}});
  const frames=()=>{reads++;const value=snapshots.length?snapshots.shift():fallback;return value.map(row=>frame(...row));};
  const context={browser:{contexts:()=>[{pages:()=>[{frames}]}]},log:(name,value)=>observations.push({name,...value})};
  class Clock extends Date{static now(){return elapsed;}}
  const output=new Function('assert','clickStudioAction','Date','setTimeout',resultsSource+';return output;')(
    assert,async(_,action)=>{assert.equal(action,'results');clicks++;if(clickError)throw clickError;},Clock,(resolve,ms)=>{elapsed+=ms;resolve();});
  return{run:()=>output(context),observations,snapshot:()=>({elapsed,clicks,reads})};
}

test('Results waits for the document produced by one click instead of its retained visible predecessor',async()=>{
  const value=resultsScenario({snapshots:[[['old',false]],[['old',true]],[['old',true]],[['new',true]]]});
  assert.equal((await value.run()).nonce,'new');assert.equal(value.snapshot().clicks,1);assert.equal(value.snapshot().elapsed,200);
  assert.deepEqual(value.observations[0].previousNonces,['old']);assert.equal(value.observations[0].newDocumentObserved,true);
});

test('Results does not accept an unseen new document until it becomes visible',async()=>{
  const value=resultsScenario({snapshots:[[['old',true]],[['new',false]],[['new',true]]]});
  assert.equal((await value.run()).nonce,'new');assert.equal(value.snapshot().clicks,1);assert.equal(value.snapshot().elapsed,100);
});

test('Results times out after 60 seconds without replaying its native click',async()=>{
  const value=resultsScenario({fallback:[['old',true]]});
  await assert.rejects(value.run(),/single Results click renders its new visible document/);
  assert.equal(value.snapshot().elapsed,60000);assert.equal(value.snapshot().clicks,1);
});

test('Results preserves a native click failure instead of retrying the action',async()=>{
  const failure=new Error('native action failed'),value=resultsScenario({clickError:failure});
  await assert.rejects(value.run(),error=>error===failure);assert.equal(value.snapshot().clicks,1);assert.equal(value.snapshot().elapsed,0);
});

test('Results preserves an inspection failure on an attached document',async()=>{
  const failure=new Error('inspection unavailable'),value=resultsScenario({fallback:[['old',true]],readError:failure});
  await assert.rejects(value.run(),error=>error===failure);assert.equal(value.snapshot().clicks,0);
});

test('Results records detached reads and never treats them as a completed action',async()=>{
  const value=resultsScenario({snapshots:[[['old',true]]],readError:new Error('Frame was detached'),detached:true});
  await assert.rejects(value.run(),/single Results click renders its new visible document/);
  assert.equal(value.snapshot().clicks,1);assert(value.observations.every(row=>row.name==='native-results-document-observation-invalidated'));
});

test('Results accepts its first newly rendered document when no predecessor exists',async()=>{
  const value=resultsScenario({snapshots:[[],[['new',true]]]});
  assert.equal((await value.run()).nonce,'new');assert.equal(value.snapshot().clicks,1);
});

test('Results rejects two unexpected newly visible documents without repeating the click',async()=>{
  const value=resultsScenario({snapshots:[[],[['new',true],['other',true]]]});
  await assert.rejects(value.run(),assert.AssertionError);assert.equal(value.snapshot().clicks,1);
});

test('Results fails a document without an observable nonce',async()=>{
  const value=resultsScenario({snapshots:[[],[['',true]]]});
  await assert.rejects(value.run(),assert.AssertionError);assert.equal(value.snapshot().clicks,1);
});
