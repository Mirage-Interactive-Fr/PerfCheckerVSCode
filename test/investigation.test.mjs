import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module, {createRequire} from 'node:module';
import {mkdtemp, mkdir, writeFile, readFile, open, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {promises as hostFs} from 'node:fs';
import {parseInvestigation, parseDiagnosticReport, reportSummary, selectedScenarios, scenarioKey, workspacePath, draftCase, scenarioToml, nativeItemDuration} from '../dist/investigationModel.js';

const diagnosticFixture = () => ({schema_version:'perfchecker-diagnosis/1',records:[{
  scenario:'oxygen-heap',implementation:'oxygen',tool:'latency',status:'complete',correctness:'passed',
  summary:'',measurements:{load_seconds:7.331050373,first_case_seconds:0.822117922,warm_case_seconds:0.000143314},
  measurement_scope:'fresh process; source loading; full lifecycle including preparation and verification',
  findings:[],configuration:{project:'/recorded/oxygen-1.10.2',threads:1},
}]});

test('diagnostic import validates claimed complete measurements and preserves unavailable evidence',()=>{
  const report=diagnosticFixture();assert.equal(parseDiagnosticReport(report),report);
  const memory={...report.records[0],tool:'memory',measurements:{samples:Array.from({length:5},()=>({state_before_bytes:1304,state_after_bytes:2294,state_and_result_bytes:2310}))}};
  assert.equal(parseDiagnosticReport({...report,records:[memory]}).records[0],memory);
  for(const value of [null,Infinity,NaN,-1,'0.1',undefined]){
    assert.throws(()=>parseDiagnosticReport({...report,records:[{...report.records[0],measurements:{...report.records[0].measurements,load_seconds:value}}]}),/finite/);
    assert.throws(()=>parseDiagnosticReport({...report,records:[{...memory,measurements:{samples:[{state_before_bytes:value,state_after_bytes:2,state_and_result_bytes:3}]}}]}),/finite|safe integer/);
  }
  for(const value of [0.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>parseDiagnosticReport({...report,records:[{...memory,measurements:{samples:[{state_before_bytes:value,state_after_bytes:2,state_and_result_bytes:3}]}}]}),/safe integer/);
  for(const status of ['unavailable','failed','timeout']){
    const unavailable={scenario:'missing',implementation:'baseline',tool:'latency',status,message:'not measured'};
    assert.equal(parseDiagnosticReport({...report,records:[unavailable]}).records[0],unavailable);
    assert.equal(unavailable.measurements,undefined);
  }
  assert.throws(()=>parseDiagnosticReport({schema_version:'perfchecker-advice/1',recommendations:[]}),/diagnostic report/);
  for(const changed of [{scenario:''},{status:null},{measurements:[]},{findings:[null]},{limitations:'not an array'},{configuration:{project:{path:'wrong'}}}]){
    assert.throws(()=>parseDiagnosticReport({...report,records:[{...report.records[0],...changed}]}),/Invalid|finite/);
  }
  assert.throws(()=>parseDiagnosticReport({...report,records:[{...memory,measurements:{samples:memory.measurements.samples,process_observations:{rss:Infinity}}}]}),/finite/);
});

test('public diagnostic import reads original external bytes without histories, workers, source actions or writes',async()=>{
  const temporary=await mkdtemp(path.join(tmpdir(),'perfchecker-diagnostic-import-'));
  const root=path.join(temporary,'workspace'),filename=path.join(temporary,'external-diagnosis.json');
  await mkdir(root);const text=JSON.stringify(diagnosticFixture(),null,2)+'\n';await writeFile(filename,text);
  const uri=(fsPath,scheme='file',authority='')=>({scheme,authority,fsPath,toString:()=>`${scheme}://${authority}${fsPath}`});
  const folder={name:'current',uri:uri(root)},messages=[],documents=[];
  let selected=[uri(filename)],dialogCalls=0,workerCalls=0;
  const disposable=()=>({dispose(){}}),items={replace(){},forEach(){}};
  const vscode={
    Uri:{file:uri,joinPath:(base,...pieces)=>uri(path.join(base.fsPath,...pieces))},TestRunProfileKind:{Run:1},ViewColumn:{One:1},
    EventEmitter:class{event=()=>disposable();fire(){}dispose(){}},
    workspace:{isTrusted:true,workspaceFolders:[folder],textDocuments:[],onDidChangeTextDocument:()=>disposable(),
      getConfiguration:()=>({get:(_key,fallback)=>fallback}),
      openTextDocument:async options=>{documents.push(options);return {getText:()=>options.content};}},
    languages:{createDiagnosticCollection:()=>({clear(){},dispose(){}})},
    tests:{createTestController:()=>({items,createRunProfile(){},dispose(){}})},
    commands:{executeCommand(){throw new Error('Import must not execute a command.');}},
    window:{createOutputChannel:()=>({dispose(){}}),
      showOpenDialog:async()=>{dialogCalls++;return selected;},showTextDocument:async()=>{},
      createWebviewPanel:()=>({webview:{cspSource:'test',asWebviewUri:value=>value.toString(),onDidReceiveMessage:()=>disposable(),postMessage:value=>messages.push(value)},
        onDidDispose:()=>disposable(),reveal(){},dispose(){}})},
  };
  const require=createRequire(import.meta.url),load=Module._load;
  const key=require.resolve('../dist/investigation.js'),cached=require.cache[key];delete require.cache[key];
  Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};
  let InvestigationController;
  try{({InvestigationController}=require(key));}finally{Module._load=load;}
  const history=[{id:'actual-earlier-job',action:'diagnose',report:filename,directory:temporary,status:'complete',created:'earlier'}];
  const context={subscriptions:[],extensionUri:uri(path.resolve('.')),workspaceState:{get:(_key,fallback)=>_key.startsWith('investigationHistory:')?history:fallback,
    update(){throw new Error('Import must not write workspace history.');}}};
  const controller=new InvestigationController(context);controller.invoke=async()=>{workerCalls++;throw new Error('No worker during import.');};
  try{
    await controller.openDiagnosticReport();
    const imported=controller.importedDiagnostic,report=controller.report;
    assert.equal(imported.path,filename);assert.equal(imported.sha256,createHash('sha256').update(text).digest('hex'));
    assert.equal(imported.text,text);assert.deepEqual(controller.history,history);assert.equal(workerCalls,0);
    assert.match(messages.at(-1).message,/not measured or independently verified/);
    assert.equal(messages.at(-1).importedDiagnostic.text,undefined,'Original bytes stay in the host, not every webview state message');
    assert.equal(await readFile(filename,'utf8'),text);
    await assert.rejects(controller.execute('advise'),/read-only/);await assert.rejects(controller.execute('narrate'),/read-only/);
    await assert.rejects(controller.execute('run',[]),/Select an explicitly declared scenario/);assert.equal(controller.importedDiagnostic,imported);
    await assert.rejects(controller.openArtifact(filename),/not opened/);await assert.rejects(controller.openSource(filename),/not opened/);
    selected=undefined;await controller.openDiagnosticReport();assert.equal(controller.importedDiagnostic,imported);
    for(const invalid of [Buffer.from([255]),Buffer.from('{"schema_version":"not-diagnosis"}'),Buffer.from(JSON.stringify({...diagnosticFixture(),records:[{tool:'latency'}]}))]){
      await writeFile(filename,invalid);selected=[uri(filename)];await assert.rejects(controller.openDiagnosticReport());
      assert.equal(controller.importedDiagnostic,imported);assert.equal(controller.report,report);
    }
    const oversized=path.join(temporary,'oversized.json');const file=await open(oversized,'w');
    try{await file.truncate(32*1024*1024+1);}finally{await file.close();}
    selected=[uri(oversized)];await assert.rejects(controller.openDiagnosticReport(),/32 MiB/);assert.equal(controller.importedDiagnostic,imported);
    const growing=path.join(temporary,'growing.json');await writeFile(growing,text);
    const originalOpen=hostFs.open;
    hostFs.open=async function(name,...args){
      const handle=await originalOpen.call(this,name,...args);
      if(name===growing){const originalStat=handle.stat.bind(handle);handle.stat=async()=>{
        const prior=await originalStat(),writer=await originalOpen.call(hostFs,growing,'r+');
        try{await writer.truncate(32*1024*1024+1);}finally{await writer.close();}
        return prior;
      };}
      return handle;
    };
    try{selected=[uri(growing)];await assert.rejects(controller.openDiagnosticReport(),/exceeds the 32 MiB/);}
    finally{hostFs.open=originalOpen;}
    assert.equal(controller.importedDiagnostic,imported,'A file growing after fstat still has a strict bounded read');
    controller.busy=true;const before=dialogCalls;await assert.rejects(controller.openDiagnosticReport(),/active investigation/);assert.equal(dialogCalls,before);controller.busy=false;
    await controller.openImportedDiagnosticJson();assert.deepEqual(documents.at(-1),{language:'json',content:text},'The snapshot remains the original loaded bytes after the external file changes');
    await writeFile(filename,text);await controller.loadHistory('actual-earlier-job');assert.equal(controller.importedDiagnostic,undefined);
    selected=[uri(filename)];await controller.openDiagnosticReport();
    vscode.workspace.workspaceFolders=[{name:'other',uri:uri(path.join(temporary,'other-workspace'))}];controller.folder();
    assert.equal(controller.importedDiagnostic,undefined);assert.equal(workerCalls,0);
    vscode.workspace.workspaceFolders=[{name:'SSH workspace',uri:uri(root,'vscode-remote','ssh-remote+fixture')}];
    selected=[uri(filename,'vscode-remote','ssh-remote+fixture')];await controller.openDiagnosticReport();
    assert.equal(controller.importedDiagnostic.path,filename,'A Remote SSH file is read on its matching extension host');
    selected=[uri(filename,'vscode-remote','ssh-remote+different-host')];await assert.rejects(controller.openDiagnosticReport(),/extension host/);
    assert.equal(workerCalls,0);
  }finally{
    controller.dispose();delete require.cache[key];if(cached)require.cache[key]=cached;await rm(temporary,{recursive:true,force:true});
  }
});

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
