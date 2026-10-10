import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Exercise the actual native harness observer with controlled kernel reads.
// No signal API is supplied: uncertainty can never cause a process signal.
const source=await readFile(new URL('./native-mcp-controls.cjs',import.meta.url),'utf8');
const observerSource=source.slice(source.indexOf('async function linuxNativeStat('),source.indexOf('const nativeParentObservations='));
const load=new Function('fs','assert','process','delay','Date',observerSource+';return nativeIdentity;');
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
