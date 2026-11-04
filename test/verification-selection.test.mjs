import test from 'node:test';
import assert from 'node:assert/strict';
import {verificationSelection} from '../dist/verificationSelection.js';
const run=(id,feature,version,kind)=>({id,package:'Example',feature,version,target_kind:kind});
const plan=[run('reference','push_benchmark','commit-a','candidate'),run('trial','push_benchmark','dev@1.0.0','dev'),run('other','pop_benchmark','dev@1.0.0','dev')];
test('verification adds the actual working tree to checks selected on an immutable reference',()=>{
  const selected=verificationSelection(plan,[{package:'Example',feature:'push_benchmark',version:'commit-a'}]);
  assert.deepEqual(selected.runs.map(run=>run.id),['reference','trial']);assert.deepEqual(selected.trialRuns.map(run=>run.id),['trial']);
  assert.deepEqual(verificationSelection(plan,[{package:'Example',feature:'push_benchmark',version:'dev@1.0.0'}]).runs.map(run=>run.id),['trial']);
  assert.deepEqual(verificationSelection(plan).runs.map(run=>run.id),['trial','other']);
});
test('verification refuses absent, ambiguous and stale working-tree targets before measuring',()=>{
  const selection=[{package:'Example',feature:'push_benchmark',version:'commit-a'}];
  assert.throws(()=>verificationSelection(plan.slice(0,1),selection),/working-tree dev/);
  assert.throws(()=>verificationSelection([...plan,{...plan[1],id:'duplicate'}],selection),/working-tree dev/);
  assert.throws(()=>verificationSelection(plan,[{...selection[0],version:'missing'}]),/original checks changed/);
  assert.throws(()=>verificationSelection(plan,[]),/No checks/);
});
