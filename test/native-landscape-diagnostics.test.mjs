import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nativeLandscape from './native-landscape-controls.cjs';

// Exercise the error serializer used by the actual native Landscape harness.
const detail=nativeLandscape.nativeFailureDetail;

test('native Landscape diagnostics retain the primary subprocess and nested cleanup errors',()=>{
  const primary=Object.assign(new Error('SDK import interrupted'),{code:null,signal:'SIGTERM',killed:true,
    cmd:'julia --project=/private/game -e using-SDK',stdout:'before import',stderr:'compiling SDK'});
  const cleanup=new Error('owned child remained alive',{cause:new Error('identity could not be observed')});
  const actual=detail(new AggregateError([primary,cleanup],'native qualification failed'));
  assert.equal(actual.errors[0].message,primary.message);
  assert.equal(actual.errors[0].code,null);assert.equal(actual.errors[0].signal,'SIGTERM');
  assert.equal(actual.errors[0].killed,true);assert.equal(actual.errors[0].cmd,primary.cmd);
  assert.equal(actual.errors[0].stdout,primary.stdout);assert.equal(actual.errors[0].stderr,primary.stderr);
  assert.equal(actual.errors[1].message,cleanup.message);
  assert.equal(actual.errors[1].cause.message,cleanup.cause.message);
  assert.equal(primary.stderr,'compiling SDK','Serialization leaves the original failure intact');
});

test('native Landscape subprocess output is bounded and retains its beginning and end',()=>{
  const error=Object.assign(new Error('import failed'),{stdout:'BEGIN'+'x'.repeat(50000)+'END',
    stderr:Buffer.from('FIRST'+'y'.repeat(50000)+'LAST')});
  const actual=detail(error,{maxFieldChars:100});
  for(const key of ['stdout','stderr']){
    assert(actual[key].length<160);assert.match(actual[key],/\[truncated \d+ characters\]/);
  }
  assert(actual.stdout.startsWith('BEGIN')&&actual.stdout.endsWith('END'));
  assert(actual.stderr.startsWith('FIRST')&&actual.stderr.endsWith('LAST'));
});

test('native Landscape diagnostics terminate on circular causes and nested aggregate limits',()=>{
  const circular=new Error('circular');circular.cause=circular;
  assert.deepEqual(detail(circular).cause,{truncated:'repeated-error'});
  const nested=new Error('outer',{cause:new Error('inner',{cause:new Error('deep')})});
  assert.deepEqual(detail(nested,{maxDepth:1}).cause.cause,{truncated:'depth-limit'});
  const many=new AggregateError(Array.from({length:1000},(_,i)=>new Error('failure '+i)),'many');
  const actual=detail(many,{maxNodes:3});
  assert.equal(actual.errors.length,8);assert.equal(actual.omittedErrors,992);
  assert.equal(actual.errors[1].message,'failure 1');
  assert.deepEqual(actual.errors[2],{truncated:'node-limit'});
});

test('Landscape process diagnostics refuse PID reuse, unknown births and changed groups before terminal states',()=>{
  const expected={pid:7,started:'123',group:7};
  assert.equal(nativeLandscape.sameOwnedIdentity(expected,null),null);
  assert.equal(nativeLandscape.sameOwnedIdentity(expected,{...expected,state:'Z'}),null);
  assert.throws(()=>nativeLandscape.sameOwnedIdentity(expected,{...expected,started:'124',state:'Z'}),/reused PID/);
  assert.throws(()=>nativeLandscape.sameOwnedIdentity(expected,{...expected,group:8,state:'X'}),/process group/);
  assert.throws(()=>nativeLandscape.sameOwnedIdentity({...expected,started:undefined},{...expected,state:'R'}),/established incarnation/);
});

test('Landscape argument diagnostics preserve private paths and useful flags without credentials or inline code',()=>{
  const root='/private/runner',executable='/official/julia';
  const hexSecret='a1'.repeat(32);
  const result=nativeLandscape.diagnosticArguments([executable,'--startup-file=no','--project='+root+'/game','-e',
    'using Package; token="do-not-print"','--',root+'/game/perf/live_provider.jl','--quality=mobile-leger',
    '--token','secret-value','https://provider.invalid/?api_key=another-secret','/human/profile','--token',hexSecret],root,executable);
  assert.equal(result[0],executable);assert.equal(result[2],'--project='+root+'/game');
  assert.match(result[4],/^\[Julia code sha256:[0-9a-f]{64}\]$/);
  assert.equal(result[6],root+'/game/perf/live_provider.jl');assert.equal(result[7],'--quality=mobile-leger');
  for(const secret of ['do-not-print','secret-value','another-secret','/human/profile',hexSecret])assert(!JSON.stringify(result).includes(secret));
  assert.equal(nativeLandscape.diagnosticArguments(Array(100).fill('secret'),root,executable).length,32);
});

test('Unavailable diagnostic samples return a bounded reason without changing functional error handling',async()=>{
  const failure=new Error('The owned rendering window disappeared between observations');
  const observation=await nativeLandscape.diagnosticObservation(async()=>{throw failure;});
  assert.equal(observation.status,'unavailable');assert.equal(observation.error.message,failure.message);
  assert.deepEqual(await nativeLandscape.diagnosticObservation(async()=>null),{status:'available',value:null});
});

test('Landscape transport observation bounds content and refuses escapes, symlinks and hard links',
  {skip:process.platform!=='linux'},async()=>{
    const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'pc-landscape-diagnostics-'));
    try{
      const root=await fs.realpath(temporary),owned=path.join(root,'owned');await fs.mkdir(owned);
      const outside=path.join(root,'foreign.json'),file=path.join(owned,'result.json');
      await fs.writeFile(outside,'outside-secret-never-read');
      await assert.rejects(nativeLandscape.readOwnedTransport(owned,outside),/inside its private/);
      assert.deepEqual(await nativeLandscape.readOwnedTransport(owned,file),{status:'absent'});
      await fs.symlink(outside,file);
      await assert.rejects(nativeLandscape.readOwnedTransport(owned,file),/symlinks/);await fs.unlink(file);
      await fs.symlink(root,path.join(owned,'escape'));
      await assert.rejects(nativeLandscape.readOwnedTransport(owned,path.join(owned,'escape','foreign.json')),/symlinks/);
      const unavailable=await nativeLandscape.diagnosticObservation(()=>nativeLandscape.readOwnedTransport(owned,path.join(owned,'escape','foreign.json')));
      assert.equal(unavailable.status,'unavailable');assert.match(unavailable.error.message,/symlinks/);
      assert(!JSON.stringify(unavailable).includes('outside-secret-never-read'));
      await fs.link(outside,file);
      await assert.rejects(nativeLandscape.readOwnedTransport(owned,file),/singly linked/);await fs.unlink(file);
      await fs.writeFile(file,JSON.stringify({schema_version:'perfchecker-provider-result/1',state:'complete',observations:[{}],secret:'never print'}));
      const result=await nativeLandscape.readOwnedTransport(owned,file);
      assert.equal(result.summary.state,'complete');assert.equal(result.summary.observations,1);
      assert(!JSON.stringify(result).includes('never print'));
      await fs.writeFile(file,'x'.repeat(40000));
      assert.deepEqual(await nativeLandscape.readOwnedTransport(owned,file),{status:'present',bytes:40000,contentOmitted:'32768-byte limit'});
    }finally{await fs.rm(temporary,{recursive:true,force:true});}
  });
