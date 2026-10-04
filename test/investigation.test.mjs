import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {parseInvestigation, reportSummary, selectedScenarios, scenarioKey, workspacePath, draftCase, scenarioToml, nativeItemDuration} from '../dist/investigationModel.js';

test('native item duration requires complete passing measurements', () => {
  const sample = {status:'complete', correctness:'passed', seconds:0.25};
  assert.equal(nativeItemDuration([sample],1),250);
  assert.equal(nativeItemDuration([sample,sample],2),500);
  for (const samples of [undefined, [], [sample,sample], [null], [{...sample,status:'invalid'}],
    [{...sample,correctness:'not_passed'}], [{...sample,seconds:-1}], [{...sample,seconds:Infinity}]]) {
    assert.throws(() => nativeItemDuration(samples,1), /native item measurement/);
  }
});

const scenario = {id: 'sort', implementation: 'mutable', source: path.resolve('test/cases.jl'), factory: 'Cases.sorting', collectors: ['benchmark']};
test('MCP text advice stays separate from evidence cards and rejects malformed text', () => {
  const report = parseInvestigation({schema_version:'perfchecker-narrative/1',status:'complete',cards:[],external_review:'Inspect allocations.'});
  assert.match(reportSummary(report), /text remains unverified/);
  assert.deepEqual(report.cards, []);
  assert.throws(() => parseInvestigation({...report,external_review:{code:'bad'}}), /Invalid external/);
  assert.throws(() => parseInvestigation({...report,external_review:'x'.repeat(16001)}), /Invalid external/);
});
test('optional models, bounded experiments and CI proposals retain availability', () => {
  const narrative=parseInvestigation({schema_version:'perfchecker-narrative/1',status:'unavailable',cards:[]});
  assert.match(reportSummary(narrative),/unavailable/);
  const sync=parseInvestigation({schema_version:'perfchecker-scenario-sync/1',declared:[],proposals:[],changes:[],warnings:[],coverage:[]});
  assert.match(reportSummary(sync),/none automatically qualified/);
  const agent=parseInvestigation({schema_version:'perfchecker-investigation/1',status:'budget_exhausted',experiments:[],unexecuted:[{id:'x'}],records:[],runs:[]});
  assert.match(reportSummary(agent),/1 not executed/);
  assert.match(scenarioToml({...scenario,requirements:['CUDA']},path.resolve('perf')),/requirements = \["CUDA"\]/);
});
test('unknown report versions and malformed record lists are rejected', () => {
  assert.throws(() => parseInvestigation({schema_version: 'perfchecker-diagnosis/2', records: []}), /Unsupported/);
  assert.throws(() => parseInvestigation({schema_version: 'perfchecker-diagnosis/1', records: [null]}), /Invalid/);
  assert.equal(parseInvestigation({schema_version: 'perfchecker-diagnosis/1', records: [], additive: true}).additive, true);
});
test('selection keeps implementation identities separate and rejects inferred/stale cases', () => {
  const other = {...scenario, implementation: 'copy'};
  assert.deepEqual(selectedScenarios([scenario, other], [scenarioKey(other)]), [other]);
  assert.throws(() => selectedScenarios([scenario], ['test/proposal']), /stale/);
  assert.throws(() => selectedScenarios([scenario], [scenarioKey(scenario), scenarioKey(scenario)]), /stale/);
});
test('workspace writes cannot escape the selected project', () => {
  const root = path.resolve('workspace');
  assert.equal(workspacePath(root, 'perf/scenarios.toml'), path.join(root, 'perf/scenarios.toml'));
  assert.throws(() => workspacePath(root, '../another-project/cases.jl'), /inside/);
});
test('proposal code remains commented and draft oracle cannot pass by default', () => {
  const draft = draftCase({origin: {file: 'test/cases.jl', line: 4}, operation_candidate: 'run(`danger`)\nexit()', oracle_candidate: '@test true'});
  assert.ok(draft.includes('# run(`danger`)\n# exit()'));
  assert.ok(draft.includes('verify = (state, result) -> false'));
  assert.ok(draft.includes('prepare = () -> error('));
});
test('adoption appends ordinary TOML declarations with escaped paths', () => {
  const toml = scenarioToml(scenario, path.resolve('perf'));
  assert.ok(toml.includes('[[scenarios]]'));
  assert.ok(toml.includes('source = "../test/cases.jl"'));
  assert.ok(toml.includes('factory = "Cases.sorting"'));
  assert.throws(() => scenarioToml({...scenario, factory: 'eval(1)'}, path.resolve('perf')), /factory/);
  assert.throws(() => scenarioToml({...scenario, collectors: ['unknown']}, path.resolve('perf')), /collector/);
  assert.ok(scenarioToml({...scenario, parameters: {n: 10, names: ['a', 'b'], nested: {enabled: true}}}, path.resolve('perf')).includes('"nested" = { "enabled" = true }'));
  assert.throws(() => scenarioToml({...scenario, parameters: {n: null}}, path.resolve('perf')), /null/);
});
