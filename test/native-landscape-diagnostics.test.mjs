import test from 'node:test';
import assert from 'node:assert/strict';
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
