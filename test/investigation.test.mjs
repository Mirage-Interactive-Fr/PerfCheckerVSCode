import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module, {createRequire} from 'node:module';
import {parseInvestigation, reportSummary, selectedScenarios, scenarioKey, workspacePath, draftCase, scenarioToml, nativeItemDuration} from '../dist/investigationModel.js';

test('editor callbacks do not reuse the previous folder discovery after another workspace is selected',async t=>{
  const uri=fsPath=>({scheme:'file',fsPath,toString:()=>`file://${fsPath}`});
  const first={name:'first',uri:uri(path.resolve('first-workspace'))};
  const second={name:'second',uri:uri(path.resolve('second-workspace'))};
  const folders=[first,second],published=[];
  let changed;
  const disposable=()=>({dispose(){}});
  const vscode={
    Uri:{file:uri},Range:class{constructor(...values){this.values=values;}},
    CodeLens:class{constructor(range,command){Object.assign(this,{range,command});}},
    Diagnostic:class{constructor(range,message,severity){Object.assign(this,{range,message,severity});}},
    DiagnosticSeverity:{Warning:1},TestRunProfileKind:{Run:1},
    EventEmitter:class{event=()=>disposable();fire(){}dispose(){}},
    workspace:{workspaceFolders:folders,onDidChangeTextDocument:callback=>{changed=callback;return disposable();},
      getWorkspaceFolder:source=>folders.find(folder=>source.fsPath===folder.uri.fsPath||source.fsPath.startsWith(folder.uri.fsPath+path.sep))},
    languages:{createDiagnosticCollection:()=>({clear(){published.length=0;},delete(){},set(file,items){published.push({file,items});},dispose(){}})},
    tests:{createTestController:()=>({items:{replace(){}},createRunProfile(){},dispose(){}})},
    window:{createOutputChannel:()=>({appendLine(){},dispose(){}})},
  };
  const require=createRequire(import.meta.url),load=Module._load;
  Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};
  let InvestigationController;
  try{({InvestigationController}=require('../dist/investigation.js'));}finally{Module._load=load;}
  const {selectWorkspaceFolder}=require('../dist/workspace-root.js');
  const context={subscriptions:[],workspaceState:{get:(_key,fallback)=>fallback}};
  const controller=new InvestigationController(context);
  const source=path.join(first.uri.fsPath,'perf','cases.jl');
  const discovery=()=>({declared:[{id:'same_id',implementation:'baseline',source,collectors:['benchmark']}],
    candidates:[],fingerprints:{'perf/cases.jl':'previous-source'}});
  const document={uri:uri(source),lineCount:5};
  try{
    await t.test('actual TextDocument callback',()=>{
      selectWorkspaceFolder(folders,first.uri);controller.folder();controller.discovery=discovery();
      selectWorkspaceFolder(folders,second.uri);
      assert.doesNotThrow(()=>changed({document,contentChanges:[{text:'changed'}]}),
        'A real TextDocument callback must not dereference discovery cleared by resolving the newly selected folder');
    });
    await t.test('native CodeLens provider ownership',()=>{
      selectWorkspaceFolder(folders,first.uri);controller.folder();controller.discovery=discovery();
      assert.equal(controller.provideCodeLenses(document).length,1);
      selectWorkspaceFolder(folders,second.uri);
      assert.deepEqual(controller.provideCodeLenses(document),[],
        'A discovery captured before folder resolution must not emit an old-folder lens under the second folder');
    });
    await t.test('stale CodeLens arguments cannot execute identical IDs in a different folder',async()=>{
      selectWorkspaceFolder(folders,first.uri);controller.folder();controller.discovery=discovery();
      const firstLens=controller.provideCodeLenses(document)[0];
      assert.equal(firstLens.command.arguments[1],first.uri.toString());
      selectWorkspaceFolder(folders,second.uri);controller.folder();controller.discovery=discovery();
      assert.equal(controller.discovery.declared[0].id,'same_id');
      await assert.rejects(controller.execute('diagnose',firstLens.command.arguments[0],undefined,firstLens.command.arguments[1]),
        /another workspace/,'An old editor action must reject before invoking a worker or using the second-folder settings');
      controller.discovery.candidates=[{id:'same_proposal'}];
      await assert.rejects(controller.prepare('same_proposal',first.uri.toString()),/another workspace/);
      selectWorkspaceFolder(folders,first.uri);
      await assert.rejects(controller.prepare('same_proposal'),/stale/,
        'Preparing without an editor owner still resolves the folder before reading discovery');
    });
    await t.test('diagnostic report ownership',()=>{
      selectWorkspaceFolder(folders,first.uri);controller.folder();controller.discovery=discovery();
      selectWorkspaceFolder(folders,second.uri);
      controller.publishDiagnostics({records:[{tool:'jet',scenario:'same_id',implementation:'baseline',findings:[{
        message:'Actual first-folder location',rule_id:'inference.runtime_dispatch',location:{file:source,line:2}}]}]});
      assert.equal(published.length,0,'An old-folder report cannot publish diagnostics after its owner has changed');
    });
  }finally{controller.dispose();selectWorkspaceFolder(folders,first.uri);}
});

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
