import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module, {createRequire} from 'node:module';
import {mkdtemp, mkdir, writeFile, readFile, open, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {promises as hostFs} from 'node:fs';
import {EventEmitter} from 'node:events';
import {parseInvestigation, parseDiagnosticReport, reportSummary, selectedScenarios, scenarioKey, workspacePath, draftCase, scenarioToml, nativeItemDuration} from '../dist/investigationModel.js';

const nativeInvestigation=createRequire(import.meta.url)('./native-investigation-controls.cjs');
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
function uiDiagnosticFixture(options={}){
  const page=new EventEmitter(),events=[];
  const frame={page:()=>page,isDetached:()=>false,locator:()=>({waitFor:async()=>{}})};
  const context={windowPage:page,log:(name,detail)=>events.push({name,...detail})};
  const diagnostic=nativeInvestigation.createInvestigationViewDiagnostic(context,{scriptPath:'/installed/media/investigation.js',
    readSnapshot:async()=>({attached:true,ancestorVisibility:[false],hasDialog:true,
      dom:{readyState:'complete',appCount:1,appChildren:0,navCount:0,navVisible:false,statusCount:0,busy:false,error:false},
      privateText:'never publish',scriptUrls:[]}),...options});
  return{page,frame,context,diagnostic,events};
}

test('UI diagnostic delegates the real acquisition once and preserves its result and original failures',async()=>{
  const f=uiDiagnosticFixture();let resolve,calls=0,finds=0;
  const command=new Promise(value=>{resolve=value;});
  const context={...f.context,investigationViewDiagnostic:f.diagnostic,
    vscode:{commands:{executeCommand(name){calls++;assert.equal(name,'perfchecker.openInvestigations');return command;}}},
    findFrame:async selector=>{finds++;assert.equal(selector,'#app nav[aria-label="Investigation views"]');return f.frame;}};
  const pending=nativeInvestigation.investigationDiagnosticControls.view(context,'report-after-view');
  assert.equal(calls,1);assert.equal(finds,0);assert.equal(f.events.length,0,'Observation I/O is deferred until after the command is delegated');
  resolve();assert.equal(await pending,f.frame);assert.equal(finds,1);
  const original=new Error('private command failure');context.vscode.commands.executeCommand=()=>{throw original;};
  await assert.rejects(nativeInvestigation.investigationDiagnosticControls.view(context,'measurement-findings-view'),error=>error===original);
  await nextTurn();await f.diagnostic.finish();
  assert(f.events.some(event=>event.purpose==='measurement-findings-view'&&event.stage==='failed'));
  assert(!JSON.stringify(f.events).includes('private command failure'));
});

test('reportAfter and Findings reacquisition failures have distinct actual callsites',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'pc-investigation-view-'));
  try{
    await mkdir(path.join(root,'job'));await writeFile(path.join(root,'job','run.json'),JSON.stringify({schema_version:'perfchecker-scenario-run/1',runs:[]}));
    const marks=[],failure=new Error('original acquisition'),context={workspace:root,
      vscode:{Uri:{file:value=>value},workspace:{getConfiguration:()=>({get:()=>'.'})},commands:{executeCommand:async()=>{}}},
      findFrame:async()=>{throw failure;},investigationViewDiagnostic:{mark:(purpose,stage)=>marks.push({purpose,stage}),report:()=>marks.push({report:true})}};
    await assert.rejects(nativeInvestigation.investigationDiagnosticControls.reportAfter(context,new Set(),'run'),error=>error===failure);
    assert(marks[0].report);assert(marks.some(mark=>mark.purpose==='report-after-view'&&mark.stage==='failed'));
    await assert.rejects(nativeInvestigation.investigationDiagnosticControls.tab(context,'Findings & advice','measurement-findings-view'),error=>error===failure);
    assert(marks.some(mark=>mark.purpose==='measurement-findings-view'&&mark.stage==='failed'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('only the first acquisition failure uses a bounded snapshot; private DOM fields never escape',async()=>{
  let reads=0;const f=uiDiagnosticFixture({readSnapshot:async()=>{reads++;return{attached:true,ancestorVisibility:[false],hasDialog:true,
    dom:{readyState:'complete',appCount:1,appChildren:0,navCount:0,navVisible:false,statusCount:0,busy:false,error:false,html:'PRIVATE'},privateText:'PRIVATE'};}});
  f.diagnostic.mark('view','acquired',f.frame);await nextTurn();assert.equal(reads,0);
  f.diagnostic.group('measure-real-shared-factory');f.diagnostic.mark('report-after-view','failed');
  for(let count=0;count<10;count++)f.diagnostic.mark('measurement-findings-view','failed');
  await nextTurn();await f.diagnostic.finish();assert.equal(reads,1);
  const snapshot=f.events.find(event=>event.event==='snapshot');assert.equal(snapshot.purpose,'report-after-view');
  assert.deepEqual(snapshot.ancestorVisibility,[false]);assert.equal(snapshot.hasDialog,true);assert.equal(snapshot.dom.navCount,0);
  assert(!JSON.stringify(f.events).includes('PRIVATE'));assert.equal(f.events.at(-1).drained,true);
});

test('the real compact DOM reader observes hidden ancestry and empty app without reading text',async()=>{
  const savedDocument=globalThis.document,savedStyle=globalThis.getComputedStyle;let disposed=0;
  const app={children:[],getBoundingClientRect:()=>({width:10,height:10})},dialog={getBoundingClientRect:()=>({width:10,height:10})};
  const parent={parentFrame:()=>null},page={evaluate:async callback=>callback()};
  const frame={isDetached:()=>false,parentFrame:()=>parent,frameElement:async()=>({isVisible:async()=>false,dispose:async()=>{disposed++;}}),
    evaluate:async callback=>callback()};
  globalThis.document={readyState:'complete',scripts:[],querySelector:selector=>selector==='#app'?app:null,
    querySelectorAll:selector=>selector==='#app'?[app]:selector.includes('dialog')?[dialog]:[]};
  globalThis.getComputedStyle=()=>({display:'block',visibility:'visible'});
  try{
    const value=await nativeInvestigation.investigationDiagnosticControls.readSnapshot(frame,page,{deadlineAt:Date.now()+2000,isStopped:()=>false});
    assert.equal(value.dom.appCount,1);assert.equal(value.dom.appChildren,0);assert.equal(value.dom.navCount,0);
    assert.deepEqual(value.ancestorVisibility,[false]);assert.equal(value.hasDialog,true);assert.equal(disposed,1);
    await assert.rejects(nativeInvestigation.investigationDiagnosticControls.readSnapshot(frame,page,{deadlineAt:Date.now()+2000,isStopped:()=>true}),/window remains open/);
    assert.equal(disposed,1,'Retired readers perform no additional frame operation');
  }finally{globalThis.document=savedDocument;globalThis.getComputedStyle=savedStyle;}
});

test('frame navigation invalidates the acquired document and prevents stale script attribution',async()=>{
  const url='https://file+.vscode-resource.vscode-cdn.net/installed/media/investigation.js';
  const f=uiDiagnosticFixture({readSnapshot:async()=>({attached:true,scriptUrls:[url]})});
  const request={url:()=>url,frame:()=>f.frame,failure:()=>({errorText:'PRIVATE DNS'})};
  f.page.emit('request',request);f.page.emit('requestfailed',request);
  f.diagnostic.mark('view','acquired',f.frame);f.diagnostic.mark('report-after-view','failed');await nextTurn();
  const error=new TypeError('PRIVATE error');error.stack=`TypeError: PRIVATE\n at ${url}:42:7`;
  f.page.emit('pageerror',error);await nextTurn();
  assert(f.events.some(event=>event.event==='script-error'&&event.line===42&&event.column===7));
  assert(f.events.some(event=>event.event==='script-request-failed'&&event.historical===true));
  f.page.emit('framenavigated',f.frame);f.page.emit('pageerror',error);await nextTurn();await f.diagnostic.finish();
  assert.equal(f.events.filter(event=>event.event==='script-error').length,1);
  assert(f.events.some(event=>event.event==='framenavigated'&&event.documentAssociation==='invalidated'&&event.panelDisposed==='unknown'));
  assert.equal(f.events.at(-1).inconclusiveScriptErrors,1);assert(!JSON.stringify(f.events).includes('PRIVATE'));
  assert(!JSON.stringify(f.events).includes(url));
});

test('a cited script URL without an exact stack entry remains inconclusive',async()=>{
  const url='https://file+.vscode-resource.vscode-cdn.net/installed/media/investigation.js';
  const f=uiDiagnosticFixture({readSnapshot:async()=>({attached:true,scriptUrls:[url]})});
  f.page.emit('request',{url:()=>url,frame:()=>f.frame});f.diagnostic.mark('view','acquired',f.frame);
  f.diagnostic.mark('report-after-view','failed');await nextTurn();
  for(const stack of [`Error: URL cited ${url}:42:7`,
    `Error: URL cited ${url}:42:7\n at foreign (https://foreign.invalid/other.js:1:2)`,
    `Error: unrelated\n at foreign (https://foreign.invalid/other.js:1:2) citing ${url}:42:7`]){
    const error=new Error('private');error.stack=stack;f.page.emit('pageerror',error);
  }
  await nextTurn();await f.diagnostic.finish();assert(!f.events.some(event=>event.event==='script-error'));
  assert.equal(f.events.at(-1).inconclusiveScriptErrors,3);
});

test('pre-acquisition script candidates are refused across navigation or detachment',async()=>{
  const url='https://file+.vscode-resource.vscode-cdn.net/installed/media/investigation.js';
  for(const invalidation of ['framenavigated','framedetached']){
    const f=uiDiagnosticFixture({readSnapshot:async()=>({attached:true,scriptUrls:[url]})});
    const request={url:()=>url,frame:()=>f.frame,failure:()=>({errorText:'private'})};
    f.page.emit('request',request);f.page.emit('requestfailed',request);f.page.emit(invalidation,f.frame);
    f.diagnostic.mark('view','acquired',f.frame);f.diagnostic.mark('report-after-view','failed');await nextTurn();
    const error=new Error('private');error.stack=`Error: private\n at ${url}:42:7`;f.page.emit('pageerror',error);
    await nextTurn();await f.diagnostic.finish();
    assert(!f.events.some(event=>['script-error','script-request-failed'].includes(event.event)));
    assert.equal(f.events.at(-1).unassociatedScriptRequests,1);assert.equal(f.events.at(-1).inconclusiveScriptErrors,1);
  }
});

test('the latest script generation remains observable after eight candidates and evicted requests stay inactive',async()=>{
  const base='https://file+.vscode-resource.vscode-cdn.net/installed/media/investigation.js';
  const current=base+'?generation=10';
  const f=uiDiagnosticFixture({readSnapshot:async()=>({attached:true,scriptUrls:[current]})});
  const requests=[];
  for(let generation=0;generation<=10;generation++){
    if(generation)f.page.emit('framenavigated',f.frame);
    const url=base+'?generation='+generation,request={url:()=>url,frame:()=>f.frame,failure:()=>({errorText:'private'})};
    requests.push(request);f.page.emit('request',request);
  }
  f.diagnostic.mark('view','acquired',f.frame);f.diagnostic.mark('report-after-view','failed');await nextTurn();
  f.page.emit('requestfailed',requests[0]);f.page.emit('requestfailed',requests[10]);
  const oldError=new Error('private');oldError.stack=`Error: private\n at ${base}?generation=0:42:7`;
  const currentError=new Error('private');currentError.stack=`Error: private\n at ${current}:43:8`;
  f.page.emit('pageerror',oldError);f.page.emit('pageerror',currentError);await nextTurn();await f.diagnostic.finish();
  assert.equal(f.events.filter(event=>event.event==='script-request-failed').length,1);
  assert.deepEqual(f.events.filter(event=>event.event==='script-error').map(event=>[event.line,event.column]),[[43,8]]);
  assert.equal(f.events.at(-1).evictedScriptRequests,3);assert.equal(f.events.at(-1).inconclusiveScriptErrors,1);
  assert(!JSON.stringify(f.events).includes(base));
});

test('retirement drains a pending snapshot once and rejects every late observation',async()=>{
  let release,reads=0;const gate=new Promise(resolve=>{release=resolve;});
  const f=uiDiagnosticFixture({readSnapshot:()=>{reads++;return gate;}});f.diagnostic.mark('view','acquired',f.frame);
  f.diagnostic.mark('report-after-view','failed');await nextTurn();assert.equal(reads,1);
  const retired=f.diagnostic.finish();assert.equal(f.diagnostic.finish(),retired);
  release({attached:true});await retired;const count=f.events.length;
  f.diagnostic.mark('measurement-findings-view','failed');f.page.emit('framedetached',f.frame);await nextTurn();
  assert.equal(f.events.length,count);assert.equal(f.events.at(-1).drained,true);assert(!f.events.some(event=>event.event==='snapshot'));
  for(const event of ['request','requestfailed','pageerror','framenavigated','framedetached'])assert.equal(f.page.listenerCount(event),0);
});

test('uncertain drain is explicitly nonpassing without publishing a late snapshot',async()=>{
  let release;const f=uiDiagnosticFixture({drainMs:5,readSnapshot:()=>new Promise(resolve=>{release=resolve;})});
  f.diagnostic.mark('view','acquired',f.frame);f.diagnostic.mark('report-after-view','failed');await nextTurn();
  await assert.rejects(f.diagnostic.finish(),/retirement failed/);assert.equal(f.events.at(-1).drained,false);
  release({attached:true});await nextTurn();assert(!f.events.some(event=>event.event==='snapshot'));
});

test('diagnostic retirement keeps the original failure directly first and removes its listeners',async()=>{
  const page=new EventEmitter(),original=new Error('original read failure'),sink=new Error('sink failure'),read=hostFs.readFile;
  const context={workspace:'/diagnostic-fixture',windowPage:page,extension:{extensionPath:'/installed'},investigationObservation:{},
    log(){throw sink;},vscode:{Uri:{file:value=>value},workspace:{getConfiguration:()=>({inspect:()=>({}),get:()=> 'perf/scenarios.toml'})}}};
  const ci=process.env.CI;process.env.CI='true';hostFs.readFile=async name=>{if(name==='/diagnostic-fixture/perf/scenarios.toml')throw original;return read(name);};
  try{await assert.rejects(nativeInvestigation.run(context),error=>error instanceof AggregateError&&error.errors[0]===original&&error.errors[1] instanceof AggregateError);
    assert.equal(page.listenerCount('pageerror'),0);
  }finally{hostFs.readFile=read;if(ci===undefined)delete process.env.CI;else process.env.CI=ci;}
});

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
    assert.equal(imported.path,await realpath(filename));assert.equal(imported.sha256,createHash('sha256').update(text).digest('hex'));
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
    const canonicalGrowing=await realpath(growing);
    const originalOpen=hostFs.open;
    hostFs.open=async function(name,...args){
      const handle=await originalOpen.call(this,name,...args);
      if(name===canonicalGrowing){const originalStat=handle.stat.bind(handle);handle.stat=async()=>{
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
    assert.equal(controller.importedDiagnostic.path,await realpath(filename),'A Remote SSH file is read on its matching extension host');
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
