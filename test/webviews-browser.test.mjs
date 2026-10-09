import assert from 'node:assert/strict';
import test from 'node:test';
import Module, {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Opt in with an installed Playwright and browser; the extension has no browser runtime dependency.
test('real webviews preserve full selection, handle Git targets and render interactive plots under their CSP',{
  skip: !process.env.PERFCHECKER_BROWSER_TESTS,
},async()=>{
  const require=createRequire(import.meta.url);
  const {chromium}=require(process.env.PERFCHECKER_PLAYWRIGHT || 'playwright');
  const temporary=await mkdtemp(path.join(tmpdir(),'perfchecker-webviews-'));
  const root=path.join(temporary,'workspace'),reports=path.join(root,'perf','results','vscode');
  const uri=fsPath=>({scheme:'file',fsPath,toString:()=>`file://${fsPath}`});
  const folder={name:'Example',uri:uri(root)};
  const commands=new Map(),panels=[],spawned=[];
  let heldPlan;
  const disposable=()=>({dispose(){}});
  const items=()=>({add(){},replace(){},forEach(){}});
  const backends=['benchmark','chairmark','alloc','profile_alloc','profile','wall_profile','network','network_interface','network_isolated'];
  const runs=backends.flatMap(backend=>['1.0.0','1.1.0','dev@fast-sort'].map((version,index)=>({
    id:`${backend}-${version}`,package:'Example',package_id:'example-id',feature:'sort',workload:'sort',description:'Sort realistic data',backend,
    entrypoint:path.join(root,'perf','checks','sort.jl'),version,target_kind:index===2?'git':'release',target_revision:index===2?'feature/fast-sort':null,
    comparison_key:`sort::${backend}`,status:backend==='network_isolated'?'unavailable':'ready',reason:backend==='network_isolated'?'Isolated network runner unavailable':'',
  })));
  const plan={schema_version:'perfchecker-suite-plan/1',suite:'Example',description:'Performance explorer',profile:'quick',plan_revision:'fixture',runs};
  const vscode={EventEmitter:class{event=()=>disposable();fire(){}dispose(){}},Uri:{file:uri,joinPath:(value,...parts)=>uri(path.join(value.fsPath,...parts))},
    TestTag:class{constructor(id){this.id=id;}},TestRunProfileKind:{Run:1},ProgressLocation:{Window:1,Notification:2},ViewColumn:{One:1},
    workspace:{onDidChangeWorkspaceFolders:()=>disposable(),onDidChangeConfiguration:()=>disposable(),isTrusted:true,workspaceFolders:[folder],getConfiguration:()=>({get:(key,fallback)=>({juliaExecutable:'julia',runnerProject:'perf',suite:'perf/suite.jl',
      factory:'build_suite',profile:'quick',reports:'perf/results/vscode',uiConfiguration:'perf/perfchecker-ui.json'})[key]??fallback,inspect:()=>undefined}),
      textDocuments:[],getWorkspaceFolder:()=>folder,asRelativePath:value=>path.relative(root,value)},
    window:{onDidCloseTerminal:()=>disposable(),onDidChangeActiveTextEditor:()=>disposable(),
      createOutputChannel:()=>({...disposable(),show(){},append(){},appendLine(){}}),
      createTreeView:()=>({...disposable(),onDidChangeCheckboxState:()=>disposable()}),
      withProgress:(_options,callback)=>callback({report(){}}),showErrorMessage:()=>undefined,showInformationMessage:()=>undefined,
      createWebviewPanel:(type,title,column,options)=>{
        const panel={type,title,column,options,messages:[],webview:{cspSource:'http://perfchecker.test',asWebviewUri:value=>`http://perfchecker.test/media/${path.basename(value.fsPath)}`,
          onDidReceiveMessage:callback=>{panel.receive=callback;return disposable();},postMessage:async message=>panel.messages.push(message)},onDidDispose:callback=>{panel.close=callback;return disposable();},reveal(){},dispose(){this.disposed=true;this.close?.();}};
        panels.push(panel);return panel;
      }},
    tests:{createTestController:()=>({...disposable(),items:items(),createRunProfile(){},createTestItem:(id,label)=>({id,label,children:items()})})},
    commands:{registerCommand:(name,callback)=>{commands.set(name,callback);return disposable();}},
    extensions:{getExtension:()=>undefined},
  };
  const spawn=(_executable,args)=>{
    spawned.push(args);
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    void(async()=>{
      await new Promise(resolve=>setImmediate(resolve));
      if(heldPlan&&args.includes('plan')){const held=heldPlan;heldPlan=undefined;held.started();await held.finished;}
      const destination=args.find(arg=>arg.startsWith('--output='));
      if(destination)await writeFile(destination.slice(9),JSON.stringify(plan));
      child.stdout.end();child.stderr.end();child.emit('close',0);
    })().catch(error=>child.emit('error',error));return child;
  };
  let browser;
  try{
    await mkdir(path.join(root,'perf','controller'),{recursive:true});await mkdir(reports,{recursive:true});
    await writeFile(path.join(root,'perf','controller','Project.toml'),'name="Controller"\n');await writeFile(path.join(root,'perf','suite.jl'),'build_suite() = nothing\n');
    await writeFile(path.join(reports,'suite-result.json'),JSON.stringify({schema_version:'perfchecker-suite-result/1',suite:'Example',profile:'quick',finished_at:'2026-10-03',runs:runs.map(run=>({...run,status:'pass',elapsed_seconds:.02,summary:{median_time:120,memory_bytes:64},message:''}))}));
    const overlay={kind:'normalized_metrics',title:'Time and allocations',description:'Minimum of each metric = 1',options:{package:'Example',feature:'sort',workload:'sort',collector:'benchmarktools-v1',versions:['1.0.0','1.1.0'],reference_version:'minimum'},
      data:['julia.wall.time','julia.alloc.bytes'].flatMap(metric=>[{version:'1.0.0',metric,value:20,unit:'ns',ratio:2,normalization_status:'ratio'},{version:'1.1.0',metric,value:10,unit:'ns',ratio:1,normalization_status:'ratio'}])};
    // Nine synthetic versions qualify the real viewer's controls; these are not measured media data.
    const versionFixture=Array.from({length:9},(_,index)=>String(index+1).repeat(40));
    versionFixture[8]='<img src=x onerror=alert(1)>';
    const metricFixture=['julia.wall.time','julia.<script>alert(1)</script>'];
    const interactive={...overlay,title:'Nine-version control fixture',options:{...overlay.options,versions:versionFixture},
      data:metricFixture.flatMap((metric,metricIndex)=>versionFixture.map((version,index)=>({version,metric,value:index+1,unit:'ns',ratio:metricIndex===1&&index===4?null:index+1,normalization_status:metricIndex===1&&index===4?'unavailable':'ratio'})))};
    await writeFile(path.join(reports,'version-series.json'),JSON.stringify({schema_version:'perfchecker-version-series/1',series:[{package:'Example',feature:'sort',workload:'sort',metric:'julia.wall.time',unit:'ns',measurement_definition:'julia.wall.time/benchmarktools-v1',points:[{version:'1.0.0',median:20,samples:10},{version:'1.1.0',median:10,samples:10}]}],plots:[overlay,interactive]}));
    const base={record_type:'observation',case_id:'sort|with-pipe',target_id:'1.0.0',attributes:{package:'Example',feature:'sort',workload:'sort',version:'1.0.0'}};
    const numeric=(value,extra={})=>({...base,comparison_key:'sort/v1',metric:'julia.wall.time',measurement_definition:'julia.wall.time/benchmarktools-v1',unit:'ns',value,...extra});
    const observations=[...[10,11,12,20].map(value=>numeric(value)),
      ...[20,30,40,...Array(321).fill(25)].map(value=>numeric(value,{case_id:'sort|compatible-variant',target_id:'1.1.0',attributes:{...base.attributes,version:'1.1.0'}})),
      ...[20,200].map(value=>numeric(value,{comparison_key:'different-implementation'})),
      ...[20,100].map(value=>numeric(value,{measurement_definition:'julia.wall.time/chairmarks-v1'})),
      ...[20,50].map(value=>numeric(value,{metric:'other.metric'})),
      ...[20,60].map(value=>numeric(value,{unit:'s'})),
      ...[...Array.from({length:10000},(_,index)=>index),1e9].map(value=>numeric(value,{comparison_key:'huge-separate-series'})),
      {...base,metric:'julia.alloc.bytes',measurement_definition:'julia.alloc.bytes/profile-allocs-v1',unit:'By',value:64,attributes:{...base.attributes,source_file:'sort.jl',source_line:12,stack:['sort','allocate']}},
      {...base,metric:'julia.cpu.samples',measurement_definition:'julia.cpu.samples/profile-v1',unit:'1',value:3,attributes:{...base.attributes,stack:['sort','partition'],runtime_dispatch:[false,true]}},
    ];
    await mkdir(path.join(reports,'bundles','run-fixture'),{recursive:true});
    const observationFile=path.join(reports,'bundles','run-fixture','observations.jsonl'),observationBytes=observations.map(value=>JSON.stringify(value)).join('\n');
    await writeFile(observationFile,observationBytes);
    const original=Module._load;Module._load=function(name,...args){return name==='vscode'?vscode:name==='./investigation'?{registerInvestigations(){}}:name==='./testitems'?{registerNativeTestItems(){}}:name==='node:child_process'?{...original.call(this,name,...args),spawn}:original.call(this,name,...args);};
    try{require('../dist/extension.js').activate({subscriptions:[],extensionUri:uri(path.resolve('.')),globalStorageUri:uri(path.join(temporary,'storage'))});}finally{Module._load=original;}
    await commands.get('perfchecker.openDesignerForWorkspace')(folder.uri);
    await commands.get('perfchecker.openOutput')();
    await commands.get('perfchecker.openStudioForWorkspace')(folder.uri);
    browser=await chromium.launch({...(process.env.PERFCHECKER_BROWSER ? {executablePath:process.env.PERFCHECKER_BROWSER} : {}),headless:true,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.addInitScript(()=>{
      window.messages=[];window.acquireVsCodeApi=()=>({postMessage:message=>window.messages.push(message)});
      document.addEventListener('DOMContentLoaded',()=>{
        for(const [name,value]of Object.entries({
          'font-family':'system-ui','foreground':'#d8e2ef','editor-foreground':'#d8e2ef','editor-background':'#0b1120','sideBar-background':'#111a29',
          'descriptionForeground':'#94a3b8','panel-border':'#334155','input-background':'#111b2a','input-foreground':'#e7effa','input-border':'#425775',
          'button-background':'#6853b8','button-foreground':'#ffffff','button-secondaryBackground':'#263951','button-secondaryForeground':'#e0eaff',
          'badge-background':'#243248','badge-foreground':'#d8e2ef','focusBorder':'#a78bfa','textLink-foreground':'#b19afb','errorForeground':'#f87171',
          'list-activeSelectionBackground':'#253857','list-activeSelectionForeground':'#edf2ff','progressBar-background':'#6751ae',
          'textCodeBlock-background':'#091120','charts-blue':'#71b5fc','charts-purple':'#ad87e6','charts-red':'#f87171','charts-orange':'#fbb55d',
        }))document.documentElement.style.setProperty(`--vscode-${name}`,value);
      });
    });
    let html='';await page.route('http://perfchecker.test/**',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname==='/view')return route.fulfill({contentType:'text/html',body:html});
      const name=path.basename(pathname);const contentType=name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/png';
      await route.fulfill({contentType,body:await readFile(path.resolve('media',name))});
    });
    const load=async type=>{html=panels.find(panel=>panel.type===type).webview.html;await page.goto('http://perfchecker.test/view');};
    const send=message=>page.evaluate(value=>{
      if(value.type==='targetOptions' && value.requestId===undefined)value.requestId=window.messages.findLast(item=>item.type==='discoverTargets').requestId;
      window.dispatchEvent(new MessageEvent('message',{data:value}));
    },message);
    const designer=panels.find(panel=>panel.type==='perfchecker.designer');
    const hydrateDesigner=async()=>{
      const requests=await page.evaluate(()=>window.messages.filter(message=>message.type==='designerReady'));
      assert.equal(requests.length,1,'Each real document load requests its own current host state');
      designer.messages.length=0;await designer.receive(requests[0]);
      for(const message of designer.messages)await send(message);
    };
    await load('perfchecker.designer');await hydrateDesigner();
    await page.waitForFunction(()=>document.querySelectorAll('.check-type').length===9);
    assert.equal(await page.locator('#cards .card').count(),3);
    assert.match(await page.locator('#count').innerText(),/27 selected/);
    await page.locator('#target-filter').selectOption('1.0.0');await page.waitForFunction(()=>document.querySelectorAll('#cards .card').length===1);
    assert.match(await page.locator('#count').innerText(),/18 selected outside filters/);
    await page.locator('#clear-visible').click();assert.match(await page.locator('#count').innerText(),/18 selected/);
    await page.locator('#reset-filters').click();assert.equal(await page.locator('.card.partial').count(),0);assert.equal(await page.locator('.card:not(.selected)').count(),1);
    await page.locator('#select-visible').click();assert.match(await page.locator('#count').innerText(),/27 selected/);
    await page.locator('#cards .card').first().locator('.check-option input').first().uncheck();assert.equal(await page.locator('.card.partial').count(),1);
    await send({type:'plan',workspace:folder.uri.toString(),plan});assert.match(await page.locator('#count').innerText(),/26 selected/);
    await page.locator('#target-kind').selectOption('git');await page.waitForFunction(()=>document.querySelectorAll('#cards .card').length===1);
    await page.locator('#selection-summary').click();await page.waitForFunction(()=>document.querySelectorAll('#selection-preview li').length===26);assert.equal(await page.locator('#selection-preview li').count(),26);
    await page.locator('#run').click();const runMessage=await page.evaluate(()=>window.messages.findLast(message=>message.type==='run'));
    assert.equal(runMessage.ids.length,26);assert.equal(new Set(runMessage.ids).size,26);
    await send({type:'targetOptions',package:'Example',repository:root,options:[{kind:'branch',label:'feature/fast-sort',revision:'feature/fast-sort'},{kind:'tag',label:'v1.1.0',revision:'v1.1.0'},{kind:'commit',label:'abc123',revision:'abc123',detail:'Improve sort'}]});
    assert.equal(await page.locator('#target-reference optgroup').count(),3);
    await page.locator('#target-reference').selectOption('feature/fast-sort');assert.equal(await page.locator('#target-label').inputValue(),'feature/fast-sort');
    await page.locator('#target-reference').selectOption('v1.1.0');assert.equal(await page.locator('#target-label').inputValue(),'v1.1.0');
    await page.locator('#target-reference').selectOption('abc123');
    await page.locator('#add-target').click();const targetMessage=await page.evaluate(()=>window.messages.findLast(message=>message.type==='addTarget'));
    assert.equal(targetMessage.target.reference,'abc123');assert.equal(targetMessage.target.label,'abc123');
    const sha1='1'.repeat(40),sha2='2'.repeat(40),sha3='3'.repeat(40),sha4='4'.repeat(40);
    await send({type:'targetOptions',package:'Example',repository:root,options:[
      {kind:'branch',label:'branch: same',revision:'refs/heads/same',commit:sha1},
      {kind:'tag',label:'tag: same',revision:'refs/tags/same',commit:sha2},
      {kind:'remote',label:'remote: origin/same',revision:'refs/remotes/origin/same',commit:sha3},
      {kind:'remote',label:'remote: upstream/same',revision:'refs/remotes/upstream/same',commit:sha4},
    ]});
    for(const [ref,sha]of [['refs/heads/same',sha1],['refs/tags/same',sha2],['refs/remotes/origin/same',sha3],['refs/remotes/upstream/same',sha4]]){
      await page.locator('#target-reference').selectOption(ref);await page.locator('#add-target').click();
      const selected=await page.evaluate(()=>window.messages.findLast(message=>message.type==='addTarget').target);
      assert.equal(selected.reference,sha);assert.equal(selected.source,root);
    }
    await page.locator('#refresh-targets').click();const lastRequest=await page.evaluate(()=>window.messages.findLast(message=>message.type==='discoverTargets'));
    await send({type:'targetOptions',requestId:lastRequest.requestId-1,package:'Example',repository:'stale',options:[],error:'stale failure'});
    assert.equal(await page.locator('#target-error').isVisible(),false);
    await page.locator('#cancel-targets').click();assert.equal((await page.evaluate(()=>window.messages.at(-1))).type,'cancelTargets');
    await send({type:'targetOptions',requestId:lastRequest.requestId,package:'Example',repository:'',options:[],error:'Git discovery cancelled. Refresh to try again.'});
    assert.match(await page.locator('#target-error').innerText(),/cancelled/);assert.equal(await page.locator('#cancel-targets').isVisible(),false);
    await page.locator('#target-revision').fill('https://github.com/example/Example.jl/tree/fast');assert.equal(await page.locator('#target-label').inputValue(),'');await page.locator('#add-target').click();
    assert.match((await page.evaluate(()=>window.messages.findLast(message=>message.type==='addTarget'))).target.reference,/github/);
    await page.locator('#add-comparison').click();assert.equal(await page.locator('#comparison-error').isVisible(),true);
    await page.locator('#baseline-targets input[value="1.0.0"]').check();await page.locator('#baseline-targets input[value="1.1.0"]').check();
    await page.locator('#add-comparison').click();const comparison=await page.evaluate(()=>window.messages.findLast(message=>message.type==='comparisons'));
    assert.deepEqual(comparison.comparisons[0].baselines,['1.0.0','1.1.0']);assert.deepEqual(comparison.comparisons[0].candidates,['dev@fast-sort']);
    await page.locator('#baseline-targets input[value="dev@fast-sort"]').check();await page.locator('#add-comparison').click();assert.match(await page.locator('#comparison-error').innerText(),/different targets/);
    await send({type:'designerBusy',busy:true});assert.equal(await page.locator('#run').isDisabled(),true);await send({type:'designerBusy',busy:false});
    await page.locator('#reset-filters').click();
    await page.locator('#cards .card').first().locator('input.label').fill('#1266aa');
    await page.locator('#save').click();
    const savedMessage=await page.evaluate(()=>window.messages.findLast(message=>message.type==='save'));
    await designer.receive(savedMessage);
    const savedConfiguration=JSON.parse(await readFile(path.join(root,'perf','perfchecker-ui.json'),'utf8'));
    assert.equal(savedConfiguration.selection.run_ids.length,26);
    assert(Object.values(savedConfiguration.selection.labels).includes('#1266aa'));
    const beforeReload=spawned.length;
    await page.reload();await hydrateDesigner();
    assert.equal(spawned.length,beforeReload,'Reload requests the cached plan without another Julia worker');
    await page.locator('#save').click();
    assert.deepEqual((await page.evaluate(()=>window.messages.findLast(message=>message.type==='save'))).configuration.selection,
      savedConfiguration.selection,'A real page reload restores exact saved labels, selected IDs and order');
    let planStarted,releasePlan;
    const started=new Promise(resolve=>{planStarted=resolve;});
    heldPlan={started:planStarted,finished:new Promise(resolve=>{releasePlan=resolve;})};
    const refreshing=designer.receive({type:'refresh'});await started;
    const beforeBusyReload=spawned.length;
    try{
      await page.reload();await hydrateDesigner();
      assert.equal(spawned.length,beforeBusyReload,'Reload during an existing action starts no extra worker');
      assert.equal(await page.locator('#run').isDisabled(),true,'Reload reflects the current host busy state');
    }finally{releasePlan();await refreshing;}
    await send(designer.messages.findLast(message=>message.type==='designerBusy'));
    assert.equal(await page.locator('#run').isDisabled(),false);
    if(process.env.PERFCHECKER_QA_DIR){await mkdir(process.env.PERFCHECKER_QA_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PERFCHECKER_QA_DIR,'designer.png'),fullPage:true});}
    const mixedLabels=['baseline','0.5.0','dev@0.1.0','4eec7f3','0.5.0-rc.2','0.5.0-rc.10','v0.5.0','0.5.0+build.7','dev'];
    const expectedVersions=['dev@0.1.0','0.5.0-rc.2','0.5.0-rc.10','0.5.0','0.5.0+build.7','v0.5.0','4eec7f3','baseline','dev'];
    const mixedRuns=mixedLabels.map((version,index)=>({...runs[0],id:`mixed-${index}`,version,
      target_kind:/^v?0\.5\./.test(version)?'release':'git'}));
    let permutation=0;
    for(const first of ['baseline','0.5.0','dev@0.1.0'])for(const second of ['baseline','0.5.0','dev@0.1.0'].filter(value=>value!==first)){
      const third=['baseline','0.5.0','dev@0.1.0'].find(value=>value!==first&&value!==second);
      const versions=[first,second,third,...mixedLabels.filter(value=>![first,second,third].includes(value))];
      await send({type:'plan',workspace:`mixed-version-order-${permutation++}`,plan:{...plan,runs:versions.map(version=>mixedRuns.find(run=>run.version===version))}});
      await page.locator('#reset-filters').click();await page.locator('#sort').selectOption('version');
      await page.waitForFunction(expected=>JSON.stringify([...document.querySelectorAll('#cards .card .version')].map(node=>node.textContent))===JSON.stringify(expected),expectedVersions);
      assert.deepEqual(await page.locator('#cards .card').evaluateAll(nodes=>nodes.map(node=>node.dataset.id)),
        expectedVersions.map(version=>mixedRuns.find(run=>run.version===version).id));
      assert.deepEqual(await page.locator('#target-filter option').evaluateAll(nodes=>nodes.map(node=>node.value)),['',...expectedVersions]);
      assert.deepEqual(await page.locator('#versions option').evaluateAll(nodes=>nodes.map(node=>node.value)),expectedVersions);
      assert.match(await page.locator('#count').innerText(),/9 selected · 9\/9 visible/);
    }
    await page.locator('#from').fill('0.5.0-rc.10');await page.locator('#to').fill('0.5.0');
    const bounded=expectedVersions.filter(version=>version!=='0.5.0-rc.2');
    await page.waitForFunction(expected=>JSON.stringify([...document.querySelectorAll('#cards .card .version')].map(node=>node.textContent))===JSON.stringify(expected),bounded);
    assert.match(await page.locator('#count').innerText(),/9 selected · 8\/9 visible · 1 selected outside filters/);
    await page.locator('#from').fill('0.5.0');await page.locator('#to').fill('0.5.0');
    const exactBounded=expectedVersions.filter(version=>!version.includes('-rc.'));
    await page.waitForFunction(expected=>JSON.stringify([...document.querySelectorAll('#cards .card .version')].map(node=>node.textContent))===JSON.stringify(expected),exactBounded);
    assert.match(await page.locator('#count').innerText(),/9 selected · 7\/9 visible · 2 selected outside filters/);
    await page.locator('#target-filter').selectOption('4eec7f3');
    await page.waitForFunction(()=>document.querySelectorAll('#cards .card').length===1);
    assert.deepEqual(await page.locator('#cards .card .version').allTextContents(),['4eec7f3']);
    assert.match(await page.locator('#count').innerText(),/9 selected · 1\/9 visible · 8 selected outside filters/);
    await page.locator('#reset-filters').click();
    assert.deepEqual(await page.locator('#cards .card .version').allTextContents(),expectedVersions);
    assert.match(await page.locator('#count').innerText(),/9 selected · 9\/9 visible/);
    const large={...plan,runs:Array.from({length:1000},(_,index)=>({...runs[0],id:`large-${index}`,feature:`work-${index}`,workload:`work-${index}`}))};
    await send({type:'plan',workspace:'new-workspace',plan:large});await page.locator('#reset-filters').click();
    assert.equal(await page.locator('#cards .card').count(),120);await page.locator('#clear-all').click();assert.equal(await page.locator('#run').isDisabled(),true);
    await page.locator('#select-visible').click();assert.match(await page.locator('#count').innerText(),/1000 selected/);await page.locator('#show-more').click();assert.equal(await page.locator('#cards .card').count(),240);
    await page.locator('#sort').selectOption('suite');
    const dragIds=await page.locator('#cards .card').evaluateAll(cards=>cards.slice(0,3).map(card=>card.dataset.id));
    await page.locator('#cards').evaluate(element=>{
      element.nativeDragEvents=[];
      for(const type of ['dragstart','dragover','drop'])element.addEventListener(type,event=>element.nativeDragEvents.push({type,id:event.target.closest('.card')?.dataset.id}));
    });
    await page.locator('#cards .card').first().locator('.feature-heading strong').dragTo(page.locator('#cards .card').nth(2).locator('.feature-heading strong'));
    const nativeDragEvents=await page.locator('#cards').evaluate(element=>element.nativeDragEvents);
    assert(nativeDragEvents.some(event=>event.type==='dragstart'),'A real pointer gesture starts the draggable card');
    assert(nativeDragEvents.some(event=>event.type==='drop'),'The browser delivers a real drop to the destination card');
    await page.locator('#save').click();
    const dragConfiguration=await page.evaluate(()=>window.messages.findLast(message=>message.type==='save').configuration);
    assert.deepEqual(dragConfiguration.selection.run_ids.slice(0,3),[dragIds[1],dragIds[0],dragIds[2]],'The saved order reflects the real browser drop');
    assert.equal(dragConfiguration.selection.run_ids.length,1000);
    await page.setViewportSize({width:420,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await load('perfchecker.output');assert.equal(await page.locator('.distribution .sample').count(),848);assert.equal(await page.locator('.pie-slice').count(),1);
    assert.equal(await page.locator('.pie-slice').getAttribute('fill'),'#4f8cff');assert.match(await page.locator('.pie-slice').getAttribute('d'),/A82 82 0 1 1 100 182/);
    await page.locator('.pie-slice').focus();assert.match(await page.locator('#allocation-0').innerText(),/64 B · 100.00%/);
    const charts=page.locator('.normalized-plot'),firstChart=charts.nth(0),chart=charts.nth(1);
    assert.equal(await firstChart.locator('.hover-value').count(),4);await firstChart.locator('.hover-value').first().focus();assert.match(await page.locator('#normalized-0').innerText(),/ratio 2/);
    assert.equal(await chart.locator('.hover-value').count(),17);assert.equal(await chart.locator('img,script').count(),0);
    assert.equal(await chart.locator('.normalized-labels text').first().getAttribute('aria-label'),versionFixture[0]);
    assert.match(await chart.locator('.normalized-labels text').first().textContent(),/1111111$/);
    const point=chart.locator('[data-metric="0"][data-version="'+versionFixture[2]+'"]');
    const originalY=await point.getAttribute('cy');
    await chart.locator('[data-normalized-from]').selectOption('2');await chart.locator('[data-normalized-to]').selectOption('6');
    assert.equal(await chart.locator('.hover-value').count(),9);assert.equal(await point.getAttribute('cy'),originalY,'Filtering never renormalizes or changes Y');
    assert.equal(await chart.locator('.normalized-series path').count(),3,'The missing ratio still splits its metric into two paths');
    assert.match(await point.getAttribute('data-detail'),/ratio 3/);
    assert.equal(await firstChart.locator('.hover-value').count(),4,'Each chart has independent controls');
    await point.focus();await chart.locator('[data-normalized-metric="0"]').uncheck();
    assert.match(await chart.locator('.plot-detail').innerText(),/^Hover or focus/,'Hiding the inspected metric clears stale detail');
    assert.equal(await chart.locator('.hover-value').count(),4);
    // A redraw with point focus retains focus when possible and falls back to its metric control otherwise.
    await chart.locator('[data-metric="1"]').first().focus();
    await chart.locator('[data-normalized-to]').evaluate(control=>{control.value='5';control.dispatchEvent(new Event('change',{bubbles:true}));});
    assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-metric')),'1');
    await chart.locator('[data-normalized-from]').evaluate(control=>{control.value='5';control.dispatchEvent(new Event('change',{bubbles:true}));});
    assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-normalized-metric')),'1');
    assert.equal(await chart.locator('.normalized-chart .hover-value').first().getAttribute('cx'),'465','A single selected version is centered');
    await chart.locator('[data-normalized-reset]').click();
    assert.equal(await chart.locator('.hover-value').count(),17);assert.equal(await chart.locator('[data-normalized-from]').inputValue(),'0');assert.equal(await chart.locator('[data-normalized-to]').inputValue(),'8');
    assert.match(await chart.locator('.plot-detail').innerText(),/^Hover or focus/);
    assert.equal(await chart.locator('img,script').count(),0,'Escaped labels remain inert after reconstruction');
    const distributions=await page.locator('.distribution').evaluateAll(svgs=>svgs.map(svg=>({
      values:[...svg.querySelectorAll('.sample')].map(node=>Number(node.dataset.value)),
      ranks:[...svg.querySelectorAll('.sample')].map(node=>Number(node.dataset.rank)),
      x20:svg.querySelector('[data-value="20"]')?.getAttribute('cx'),scale:svg.parentElement.querySelector('.distribution-scale').textContent,
      sampling:svg.parentElement.querySelector('.distribution-sampling')?.textContent,
    })));
    const baseline=distributions.find(row=>row.values.includes(11)),candidate=distributions.find(row=>row.values.length===324);
    assert(baseline&&candidate,'Every sample remains present above the former 320-point sampling threshold');
    assert.equal(baseline.x20,candidate.x20,'The same sample has the same X in compatible versions');
    for(const row of distributions.filter(row=>row!==baseline&&row!==candidate))assert.notEqual(row.x20,baseline.x20,'Different identity, collector, metric or unit retains a separate scale');
    assert.match(baseline.scale,/10 ns.*40 ns.*\(ns\)/);assert.deepEqual(baseline.values,[10,11,12,20]);
    assert.equal(candidate.values.filter(value=>value===40).length,1,'The largest outlier is retained');
    assert.equal(baseline.sampling,undefined);assert.equal(candidate.sampling,undefined,'Ordinary sample sets remain fully visible');
    const largeDistribution=distributions.find(row=>row.values.includes(1e9));assert(largeDistribution);
    assert.equal(largeDistribution.values.length,512,'Large distributions have a bounded SVG point count');
    assert.deepEqual(largeDistribution.ranks,Array.from({length:512},(_,index)=>Math.round(index*10000/511)+1));
    assert.equal(largeDistribution.values[0],0);assert.equal(largeDistribution.values.at(-1),1e9);
    assert.equal(largeDistribution.sampling,'512 of 10001 samples plotted; all samples in JSON.');
    const outlier=page.locator('.distribution .sample[data-value="1000000000"]');await outlier.focus();
    assert.match(await page.locator('#'+await outlier.getAttribute('data-target')).innerText(),/sorted sample 10001\/10001/);
    assert.equal(await readFile(observationFile,'utf8'),observationBytes,'Presentation preserves every original JSON sample');
    await page.setViewportSize({width:390,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.locator('.flame-node.dynamic').focus();assert.match(await page.locator('#flame-1').innerText(),/Runtime dispatch detected/);
    await page.locator('#result-kind').selectOption('allocation');assert.equal(await page.locator('[data-result-item]:visible').count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.setViewportSize({width:1440,height:1100});await load('perfchecker.studio');await send({type:'studioState',workspace:'Example',project:'/example/perf/controller',trusted:true,juliaAvailable:true});
    assert.equal(await page.locator('.card').count(),9);assert.equal(await page.locator('.hero img').evaluate(image=>image.complete&&image.naturalWidth>0),true);
    await page.locator('[data-action="chat"]').focus();await page.keyboard.press('Enter');assert.equal((await page.evaluate(()=>window.messages.at(-1))).action,'chat');
    if(process.env.PERFCHECKER_QA_DIR)await page.screenshot({path:path.join(process.env.PERFCHECKER_QA_DIR,'studio.png'),fullPage:true});
    await page.setViewportSize({width:420,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    assert.deepEqual(errors,[]);
    const other={name:'other',uri:uri(path.join(temporary,'other'))};vscode.workspace.workspaceFolders.push(other);
    await commands.get('perfchecker.openStudioForWorkspace')(other.uri);
    const oldDesigner=panels.find(panel=>panel.type==='perfchecker.designer');
    await oldDesigner.receive({type:'save',configuration:{unexpected:'late message'}});
    assert.match(oldDesigner.messages.at(-1).error,/folder changed/);
    await assert.rejects(access(path.join(other.uri.fsPath,'perf','perfchecker-ui.json')));
    await assert.rejects(commands.get('perfchecker.openOutput')(),/controller Project.toml not found/);
    assert.equal(panels.find(panel=>panel.type==='perfchecker.output').disposed,true);
    assert.equal(panels.find(panel=>panel.type==='perfchecker.designer').disposed,true);
  }finally{await browser?.close();await rm(temporary,{recursive:true,force:true});}
});
