import test from 'node:test';
import assert from 'node:assert/strict';
import {testOutcome} from '../dist/model.js';
import {scenarioOutcome, selectedTestItems} from '../dist/investigationModel.js';

test('only current, unambiguous, oracle-validated suite results pass', () => {
  const plan = {package:'Example', feature:'sort', version:'dev', target_kind:'working_tree', comparison_key:'sort', status:'ready'};
  const result = {...plan, status:'pass', qualification:{verdict:'validated'}};
  assert.equal(testOutcome(plan, [result]).state, 'passed');
  assert.equal(testOutcome(plan, undefined).state, 'errored');
  assert.equal(testOutcome(plan, [result, result]).state, 'errored');
  assert.equal(testOutcome(plan, [{...result, qualification:{verdict:'executed'}}]).state, 'skipped');
  assert.equal(testOutcome(plan, [{...result, status:'invalid', qualification:{verdict:'invalid'}}]).state, 'failed');
  assert.equal(testOutcome(plan, [{...result, feature:'different'}]).state, 'errored');
});

test('exclusions compare identities, empty selection stays empty, overlapping selection executes once', () => {
  const a = {id:'a'}, b = {id:'b'};
  assert.deepEqual(selectedTestItems([a,b]), [a,b]);
  assert.deepEqual(selectedTestItems([a,b], undefined, [{id:'a'}]), [b]);
  assert.deepEqual(selectedTestItems([a,b], []), []);
  assert.deepEqual(selectedTestItems([a,b], [a,a,b]), [a,b]);
  assert.deepEqual(selectedTestItems([a,b], [a], [{id:'a'}]), []);
});

test('partial or duplicated collector results cannot qualify a performance item', () => {
  const scenario = {id:'sort', implementation:'cpu', collectors:['benchmark','profile']};
  const row = collector => ({scenario, collector, qualification:{availability:'complete', correctness:'passed'}});
  const report = runs => ({schema_version:'perfchecker-scenario-run/1', runs});
  assert.equal(scenarioOutcome(scenario, report([row('benchmark'), row('profile')])), 'passed');
  assert.equal(scenarioOutcome(scenario, report([row('benchmark')])), 'errored');
  assert.equal(scenarioOutcome(scenario, report([row('benchmark'), row('benchmark')])), 'errored');
  assert.equal(scenarioOutcome(scenario, report([{...row('benchmark'), qualification:{correctness:'failed'}},row('profile')])), 'failed');
  assert.equal(scenarioOutcome(scenario), 'errored');
});
