import test from 'node:test';
import assert from 'node:assert/strict';
import {trialComparisons} from '../dist/trialComparison.js';

const row = {case_id:'suite/Example/push_benchmark', target_id:'dev', metric:'julia.wall.time', unit:'ns',
  measurement_definition:'julia.wall.time/benchmarktools-v1', scope:'whole_operation', aggregation:'sample',
  comparison_fingerprint:'matching-workload', collector:'benchmark', record_semantics:'operation_measurement',
  correctness:'passed', median:100, record_count:1000};
const result={package:'Example',feature:'push_benchmark',target:'dev',targetKind:'dev'};
const before={runId:'reference-run',results:[result]}, after={runId:'trial-run',results:[result]};

test('trial comparison retains execution provenance and compares matching operation medians',()=>{
  const [comparison]=trialComparisons([row],[{...row,median:80}],before,after);
  assert.equal(comparison.relative_delta,-0.2);
  assert.equal(comparison.baseline_version,'dev · run reference-run');
  assert.equal(comparison.candidate_version,'dev · run trial-run');
  assert.match(comparison.interpretation,/not a statistical/);
  assert.equal(trialComparisons([{...row,median:0}],[row],before,after)[0].relative_delta,null);
});

test('a selected immutable reference is compared with the measured dev trial, never with a rerun of the immutable reference',()=>{
  const reference={...before,results:[{...result,target:'commit-a',targetKind:'candidate'}]};
  const comparisons=trialComparisons([{...row,target_id:'commit-a'}],[{...row,median:80},{...row,target_id:'commit-a',median:99}],reference,after);
  assert.equal(comparisons.length,1);assert.match(comparisons[0].baseline_version,/commit-a/);assert.match(comparisons[0].candidate_version,/dev/);
  assert.equal(comparisons[0].candidate_median,80);
  assert.deepEqual(trialComparisons([{...row,target_id:'commit-a'}],[{...row,target_id:'commit-a'}],reference,reference),[]);
});

test('changed workloads, units, scopes, duplicate quantities and profile weights never become trial speedups',()=>{
  for(const change of [{comparison_fingerprint:'different'},{unit:'s'},{scope:'workload'}, {record_semantics:'profile_frame'},
    {record_semantics:'allocation_profile_record'},{correctness:'failed'},{median:null}])
    assert.deepEqual(trialComparisons([row],[{...row,...change}],before,after),[]);
  assert.deepEqual(trialComparisons([row,row],[row],before,after),[]);
  assert.deepEqual(trialComparisons([row],[row,row],before,after),[]);
});
