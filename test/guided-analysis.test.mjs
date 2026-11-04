import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisContextKey, selectedAnalysisContext, analysisRequest, parseGuidedAnalysis,
  implementationRequest, selectedMeasurementEvidence, createChecksRequest} from '../dist/guidedAnalysis.js';

const result = (id, target) => ({id, package:'Example', feature:'insert_benchmark', target, status:'pass', summary:{min_time:10}});
const context = {evidenceId:'saved-run',runId:'run-1',fingerprint:'bytes-1',label:'Selected execution',results:[result('baseline','commit-a'),result('dev','dev')]};
const reply = {schema_version:'perfchecker-guided-analysis/1',summary:'Compare the measured cases.',
  findings:[{id:'observed',title:'A measured difference',detail:'This result needs replication.',resultIds:['dev']}],
  suggestions:[{id:'try-one',title:'Try one change',rationale:'Test the hypothesis.',change:'Adjust the implementation.',checks:['Run package tests and repeat the selected checks.'],resultIds:['baseline','dev']},
    {id:'other',title:'An alternative',rationale:'A different approach.',change:'A separate change.',checks:['Repeat the selected checks.'],resultIds:['dev']}]};

test('result selection binds analysis to the chosen run, targets and exact bytes',()=>{
  const selected=selectedAnalysisContext(context,['dev']);
  assert.deepEqual(selected.results.map(r=>r.target),['dev']);
  assert.notEqual(analysisContextKey(context),analysisContextKey(selected));
  assert.notEqual(analysisContextKey(context),analysisContextKey({...context,fingerprint:'changed'}));
  assert.throws(()=>selectedAnalysisContext(context,['missing']),/no longer available/);
  assert.throws(()=>selectedAnalysisContext(context,[]),/Select/);
  assert.throws(()=>selectedAnalysisContext(context,['dev','dev']),/Select/);
});

test('analysis and trial requests are built from interface choices, and trial implements only one suggestion',()=>{
  const prompt=analysisRequest(context,['timing','suggestions'],'Please preserve the public API.');
  assert.match(prompt,/Please preserve the public API/);assert.match(prompt,/commit-a/);
  const measured=JSON.parse(analysisRequest(context,['timing'],undefined,{measurements:[{median:10}]}).split('\n').at(-1));
  assert.equal(measured.evidence.measurements[0].median,10);assert.equal(measured.previousTrial,undefined,'Initial measurements are not labelled as a previous trial');
  const analysis=parseGuidedAnalysis(JSON.stringify(reply),context);
  const implementation=implementationRequest(analysis,'try-one',context);
  assert.match(implementation,/Adjust the implementation/);
  assert.doesNotMatch(implementation,/A separate change/);
  assert.throws(()=>implementationRequest(analysis,'not-selected',context),/Choose a suggestion/);
  assert.match(createChecksRequest('Focus on insertion.'),/Keep package implementation unchanged/);
});

test('agent prose, foreign evidence, duplicate identities and suggestions without checks cannot authorize edits',()=>{
  assert.throws(()=>parseGuidedAnalysis('Just optimize everything.',context),/selectable suggestions/);
  assert.throws(()=>parseGuidedAnalysis(JSON.stringify({...reply,suggestions:[{...reply.suggestions[0],resultIds:['foreign-run']}]}),context),/outside/);
  assert.throws(()=>parseGuidedAnalysis(JSON.stringify({...reply,suggestions:[{...reply.suggestions[0],checks:[]}]}),context),/verification/);
  assert.throws(()=>parseGuidedAnalysis(JSON.stringify({...reply,suggestions:[{...reply.suggestions[0],id:'observed'}]}),context),/duplicate/);
  assert.deepEqual(parseGuidedAnalysis(JSON.stringify({...reply,findings:[],suggestions:[]}),context).suggestions,[]);
});

test('canonical evidence is filtered before sending, including when a selected failed check has no quantities',()=>{
  const selected=selectedAnalysisContext(context,['dev']);
  const advice={schema_version:'perfchecker-advice/1',measurement_summaries:[
    {case_id:'suite/Example/insert_benchmark',target_id:'dev',median:10},
    {case_id:'suite/Example/insert_benchmark',target_id:'commit-a',median:20},
    {case_id:'suite/Other/insert_benchmark',target_id:'dev',median:100}],
    recommendations:[{scenario:'suite/Example/insert_benchmark',implementation:'dev'}, {scenario:'unrelated',implementation:'dev'}]};
  const scoped=selectedMeasurementEvidence(advice,selected);
  assert.equal(scoped.measurement_summaries.length,1);assert.equal(scoped.measurement_summaries[0].target_id,'dev');
  assert.equal(scoped.recommendations.length,1);
  assert.equal(advice.measurement_summaries.length,3,'The stored execution remains immutable.');
  assert.deepEqual(selectedMeasurementEvidence({...advice,measurement_summaries:[]},selected).measurement_summaries,[]);
});
