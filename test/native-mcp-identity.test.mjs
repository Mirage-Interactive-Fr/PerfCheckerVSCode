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
