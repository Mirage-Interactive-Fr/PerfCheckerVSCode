// Real public VSIX controls, real General Julia workers, and disposable CI fixtures only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {clickStudioAction}=require('./native-studio-controls.cjs');
const {createHash} = require('node:crypto');
const {tmpdir} = require('node:os');

const reportNames = {discover: 'discovery', run: 'run', diagnose: 'diagnosis',
  advise: 'advice', compare: 'comparison', tools: 'tools', sync: 'sync', investigate: 'investigation'};

// Test-only, opt-in observations of the existing UI operations. No panel API,
// command, browser request or Julia process is replaced or added.
async function investigationDomSnapshot(frame,page,{deadlineAt,isStopped}) {
  const check=()=>assert(!isStopped()&&Date.now()<deadlineAt,'UI snapshot observation window remains open');check();
  const result={attached:!frame.isDetached(),ancestorVisibility:[]};
  if(!result.attached)return result;
  for(let current=frame,depth=0;current.parentFrame()&&depth<8;current=current.parentFrame(),depth++){
    check();const element=await current.frameElement();
    try{check();result.ancestorVisibility.push(await element.isVisible());check();}finally{await element.dispose();}
  }
  check();
  result.dom=await frame.evaluate(()=>{
    const count=selector=>Math.min(100,document.querySelectorAll(selector).length);
    const visible=selector=>{const node=document.querySelector(selector);if(!node)return false;
      const style=getComputedStyle(node),rect=node.getBoundingClientRect();
      return style.visibility!=='hidden'&&style.display!=='none'&&rect.width>0&&rect.height>0;};
    return{readyState:document.readyState,appCount:count('#app'),appChildren:Math.min(100,document.querySelector('#app')?.children.length||0),
      navCount:count('#app nav[aria-label="Investigation views"]'),navVisible:visible('#app nav[aria-label="Investigation views"]'),
      statusCount:count('#app .status'),busy:!!document.querySelector('#app .status.busy'),error:!!document.querySelector('#app .status.error')};
  });
  check();
  // Private association only: these URLs never enter the projected observation.
  result.scriptUrls=await frame.evaluate(()=>Array.from(document.scripts).slice(0,4).map(script=>script.src.length<=8192?script.src:null));
  check();
  result.hasDialog=await page.evaluate(()=>Array.from(document.querySelectorAll('[role="dialog"],.quick-input-widget')).slice(0,32)
    .some(node=>{const style=getComputedStyle(node),rect=node.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0;}));
  check();return result;
}

exports.createInvestigationViewDiagnostic=function(context,{scriptPath,deadlineAt=Date.now()+130*60000,
  readSnapshot=investigationDomSnapshot,snapshotMs=2000,drainMs=2500}={}){
  assert(path.isAbsolute(scriptPath));assert(Number.isFinite(deadlineAt));assert(snapshotMs>0&&snapshotMs<=2000&&drainMs>0&&drainMs<=2500);
  const frames=new WeakMap(),requests=new WeakMap(),listeners=[],pending=new Set(),scriptBindings=[],outbox=[];let nextFrame=0,events=0,snapshots=0;
  let stopped=false,active=false,lastFrame,group,finishPromise,sinkError,firstFailure=false,inconclusiveScriptErrors=0,evictedScriptRequests=0;
  const fixedPurposes=new Set(['view','report-after-view','measurement-findings-view','teardown-view']);
  const fixedStages=new Set(['before-command','command-returned','before-find-frame','frame-acquired','acquired','failed','report-assertions-complete','cleanup-confirmed']);
  const fixedGroups=new Set(['read-only-saved-diagnostic-import','discovery-selection-proposals','adopt-real-shared-factory',
    'reject-invalid-and-duplicate-adoption','measure-real-shared-factory','measure-shared-collectors-profiles','diagnose-real-analyzers',
    'advise-from-saved-evidence','compare-real-measurements','bounded-investigation','sync-tools-history','cancel-active-scenario-worker']);
  const digest=value=>createHash('sha256').update(String(value).slice(0,16384)).digest('hex');
  const flush=()=>{for(const detail of outbox.splice(0))try{context.log('native-investigation-ui-observation',detail);}catch(error){sinkError??=error;}};
  const emit=detail=>{const reserved=detail.event?.startsWith('snapshot')||detail.event==='acquisition'&&detail.stage==='failed'&&!firstFailure;
    if(stopped||events>=(reserved?264:256))return;events++;
    outbox.push({observedAt:new Date().toISOString(),group:fixedGroups.has(group)?group:'unlisted',...detail});queueMicrotask(()=>{if(!stopped)flush();});};
  const track=frame=>{let identity=frames.get(frame);if(!identity){identity={id:++nextFrame,generation:0,valid:false,everAcquired:false};frames.set(frame,identity);}
    return identity;};
  const acquired=frame=>{const identity=track(frame);identity.valid=true;identity.everAcquired=true;lastFrame=frame;return identity;};
  const expectedScript=value=>{try{const url=new URL(value);return ['https:','vscode-webview-resource:','vscode-file:'].includes(url.protocol)
    &&decodeURIComponent(url.pathname).replaceAll('\\','/')===scriptPath.replaceAll('\\','/');}catch{return false;}};
  const safeError=error=>({errorClass:['Error','TypeError','ReferenceError','SyntaxError','TimeoutError'].includes(error?.name)?error.name:'unlisted',
    errorSha256:digest(`${error?.name||''}\n${error?.message||''}\n${error?.stack||''}`),errorHashScope:'first-16KiB'});
  const listen=(emitter,event,callback)=>{const safe=(...args)=>{if(stopped||Date.now()>=deadlineAt)return;try{callback(...args);}catch(error){emit({event:'observer-unknown',stage:'event',...safeError(error)});}};
    emitter.on(event,safe);listeners.push(()=>emitter.off(event,safe));};
  for(const page of new Set([context.windowPage,...(context.browser?.contexts().flatMap(value=>value.pages())||[])])){
    listen(page,'request',request=>{if(!expectedScript(request.url()))return;
      const frame=request.frame();if(!frame)return;const identity=track(frame);
      const binding={page,frame:request.frame(),generation:identity.generation,url:request.url(),verified:false,active:true};requests.set(request,binding);
      if(scriptBindings.length===8){scriptBindings.shift().active=false;evictedScriptRequests=Math.min(1000,evictedScriptRequests+1);}
      scriptBindings.push(binding);
    });
    listen(page,'requestfailed',request=>{const binding=requests.get(request),identity=binding&&frames.get(binding.frame);
      if(!binding?.active||!identity||identity.generation!==binding.generation||request.url()!==binding.url)return;
      binding.failureSha256=digest(request.failure()?.errorText||'');binding.failedAt=new Date().toISOString();
      if(binding.verified&&identity.valid)emit({event:'script-request-failed',frame:identity.id,generation:identity.generation,
        script:'investigation.js',failureSha256:binding.failureSha256});});
    listen(page,'pageerror',error=>{const stack=String(error.stack||'').slice(0,16384);
      // Only complete V8 stack entries are eligible, never the message/header
      // or an arbitrary URL citation inside a foreign frame.
      const positions=stack.split('\n').slice(1,65).map(line=>/^\s+at ([^\s()]+):([1-9]\d{0,6}):([1-9]\d{0,6})$/.exec(line)
        ||/^\s+at [^()\r\n]{1,160} \(([^\s()]+):([1-9]\d{0,6}):([1-9]\d{0,6})\)$/.exec(line)).filter(Boolean);
      const matches=scriptBindings.filter(binding=>binding.page===page&&binding.verified&&frames.get(binding.frame)?.valid
        &&frames.get(binding.frame).generation===binding.generation&&positions.some(position=>position[1]===binding.url));
      const unique=matches.filter((binding,index)=>matches.findIndex(other=>other.frame===binding.frame&&other.generation===binding.generation&&other.url===binding.url)===index);
      if(unique.length!==1){inconclusiveScriptErrors=Math.min(100,inconclusiveScriptErrors+1);return;}
      const binding=unique[0],identity=frames.get(binding.frame),position=positions.find(position=>position[1]===binding.url);
      emit({event:'script-error',frame:identity.id,generation:identity.generation,script:'investigation.js',line:Number(position[2]),column:Number(position[3]),...safeError(error)});});
    for(const event of ['framenavigated','framedetached'])listen(page,event,frame=>{const identity=frames.get(frame);if(!identity)return;
      identity.generation++;identity.valid=false;if(identity.everAcquired)emit({event,frame:identity.id,generation:identity.generation,documentAssociation:'invalidated',panelDisposed:'unknown'});});
  }
  const project=value=>{
    const result={attached:typeof value?.attached==='boolean'?value.attached:null,
      ancestorVisibility:Array.isArray(value?.ancestorVisibility)?value.ancestorVisibility.slice(0,8).map(item=>typeof item==='boolean'?item:null):[],
      hasDialog:typeof value?.hasDialog==='boolean'?value.hasDialog:null};
    if(value?.dom){result.dom={readyState:['loading','interactive','complete'].includes(value.dom.readyState)?value.dom.readyState:'unknown'};
      for(const key of ['appCount','appChildren','navCount','statusCount'])result.dom[key]=Number.isInteger(value.dom[key])&&value.dom[key]>=0&&value.dom[key]<=100?value.dom[key]:null;
      for(const key of ['navVisible','busy','error'])result.dom[key]=typeof value.dom[key]==='boolean'?value.dom[key]:null;}
    return result;
  };
  const capture=(purpose,stage,frame)=>{
    if(stopped||Date.now()>=deadlineAt||snapshots>=4)return;
    if(active)return;active=true;snapshots++;
    const identity=frame&&frames.get(frame),generation=identity?.generation,valid=identity?.valid;
    const sequence=snapshots,until=Math.min(deadlineAt,Date.now()+snapshotMs);
    const operation=Promise.resolve().then(()=>valid?readSnapshot(frame,frame.page(),{deadlineAt:until,isStopped:()=>stopped}):{attached:frame?!frame.isDetached():null});pending.add(operation);
    let timer;Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Snapshot deadline')),Math.max(0,until-Date.now()));})])
      .then(value=>{if(!stopped&&Date.now()<until&&(!identity||identity.generation===generation&&identity.valid===valid)){
          if(valid)for(const binding of scriptBindings.filter(binding=>binding.frame===frame&&binding.generation===generation)){
            binding.verified=Array.isArray(value.scriptUrls)&&value.scriptUrls.slice(0,4).some(url=>url===binding.url&&expectedScript(url));
            if(binding.verified&&binding.failureSha256)emit({event:'script-request-failed',frame:identity.id,generation,
              script:'investigation.js',failureSha256:binding.failureSha256,failedAt:binding.failedAt,historical:true});
          }
          emit({event:'snapshot',sequence,purpose,stage,frame:identity?.id||null,generation:generation??null,
            documentAssociation:valid?'previously-acquired':'unknown-or-invalidated',...project(value)});
        }
        else emit({event:'snapshot-unknown',sequence,purpose,stage,reason:'deadline'});},error=>emit({event:'snapshot-unknown',sequence,purpose,stage,...safeError(error)}))
      .catch(error=>emit({event:'snapshot-unknown',sequence,purpose,stage,...safeError(error)})).finally(()=>clearTimeout(timer));
    void operation.then(()=>{},()=>{}).finally(()=>{pending.delete(operation);active=false;});
  };
  return{
    group(name){group=name;},
    mark(purpose,stage,frame,error){if(stopped||Date.now()>=deadlineAt)return;purpose=fixedPurposes.has(purpose)?purpose:'view';
      stage=fixedStages.has(stage)?stage:'unlisted';
      if(frame)acquired(frame);
      emit({event:'acquisition',purpose,stage,frame:frame?frames.get(frame).id:null,
        generation:frame?frames.get(frame).generation:null,...(stage==='failed'?safeError(error):{})});
      if(stage==='failed'&&!firstFailure){firstFailure=true;capture(purpose,stage,frame||lastFrame);}
    },
    report(action,report){emit({event:'report-read',action:Object.hasOwn(reportNames,action)?action:'unlisted',
      schema:report?.schema_version==='perfchecker-scenario-run/1'?report.schema_version:'other',
      runs:Array.isArray(report?.runs)?Math.min(report.runs.length,100):null});},
    finish(){if(finishPromise)return finishPromise;flush();stopped=true;
      finishPromise=(async()=>{const errors=[];for(const remove of listeners)try{remove();}catch(error){errors.push(error);}
        let timer;const drained=await Promise.race([Promise.allSettled([...pending]).then(()=>true),
          new Promise(resolve=>{timer=setTimeout(()=>resolve(false),drainMs);})]);clearTimeout(timer);
        try{context.log('native-investigation-ui-retired',{observedAt:new Date().toISOString(),snapshots,events,drained,
          listenersRemoved:errors.length===0,inconclusiveScriptErrors,unassociatedScriptRequests:scriptBindings.filter(binding=>!binding.verified).length,
          evictedScriptRequests,eventLimitReached:events>=256,
          qualifiesCanonicalProduct:false,perturbing:true});}catch(error){errors.push(error);}
        if(!drained)errors.push(new Error('Investigation diagnostic drain inconclusive'));if(sinkError)errors.push(sinkError);
        if(errors.length)throw new AggregateError(errors,'Investigation diagnostic retirement failed');})();return finishPromise;}
  };
};

async function eventually(read, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {const result = await read(); if (result) return result;} catch (error) {last = error;}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}

function configuration(context) {
  return context.vscode.workspace.getConfiguration('perfchecker', context.vscode.Uri.file(context.workspace));
}

async function view(context,purpose='view') {
  const diagnostic=context.investigationViewDiagnostic;
  diagnostic?.mark(purpose,'before-command');
  try{
    const command=context.vscode.commands.executeCommand('perfchecker.openInvestigations');
    diagnostic?.mark(purpose,'command-returned');await command;
    diagnostic?.mark(purpose,'before-find-frame');
    const result = await context.findFrame('#app nav[aria-label="Investigation views"]');
    diagnostic?.mark(purpose,'frame-acquired',result);
    await result.locator('#app p.status').waitFor({state: 'visible'});
    diagnostic?.mark(purpose,'acquired',result);return result;
  }catch(error){diagnostic?.mark(purpose,'failed',undefined,error);throw error;}
}

async function tab(context, name,purpose='view') {
  const result = await view(context,purpose);
  await result.getByRole('button', {name, exact: true}).click();
  await eventually(async () => (await result.getByRole('button', {name, exact: true}).getAttribute('aria-current')) === 'page', `${name} investigation view`);
  return result;
}

async function directories(root) {
  return new Set(await fs.readdir(root).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  }));
}

function reportRoot(context) {
  return path.resolve(context.workspace, configuration(context).get('investigationReports', 'perf/results/investigations'));
}

async function reportAfter(context, before, action, timeout = 360000) {
  const root = reportRoot(context);
  const observationStarted=Date.now(),observationDeadline=observationStarted+timeout;let nextObservation=0;
  if(action==='diagnose')context.log('investigation-diagnosis-observation-budget',{
    timeoutMilliseconds:timeout,startedAt:new Date(observationStarted).toISOString(),deadlineAt:new Date(observationDeadline).toISOString(),
    scope:'Native test observation only; analyzer and investigation execution budgets are unchanged'});
  let reportObserved=false,cleanupConfirmed=false,reportObservedAt,cleanupConfirmedAt;
  try{
  const found = await eventually(async () => {
    if(action==='diagnose'&&context.observeDiagnosisRequest&&Date.now()>=nextObservation){
      nextObservation=Date.now()+2000;
      await context.observeDiagnosisRequest('awaiting-final-diagnosis-report',observationDeadline);
      assert(Date.now()<observationDeadline,'A diagnosis observation never accepts a report after its existing deadline');
    }
    for (const name of await directories(root)) {
      if (before.has(name)) continue;
      const location = path.join(root, name, `${reportNames[action]}.json`);
      try {const report=JSON.parse(await fs.readFile(location, 'utf8'));
        if(action==='diagnose'&&context.observeDiagnosisRequest)assert(Date.now()<observationDeadline,'The diagnosis scan never accepts a final report after its existing deadline');
        return {report, location, directory: path.dirname(location)};}
      catch (error) {if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;}
    }
    return false;
  }, `real Julia ${action} report`, timeout);
  reportObserved=true;
  reportObservedAt=new Date().toISOString();
  context.investigationViewDiagnostic?.report(action,found.report);
  const current = await view(context,'report-after-view');
  await eventually(async () => !(await current.locator('#app .status').getAttribute('class')).includes('busy'), `${action} controller completes cleanup`, Math.min(timeout,360000));
  assert.equal(await current.getByRole('button', {name: 'Cancel', exact: true}).isDisabled(), true);
  cleanupConfirmed=true;
  cleanupConfirmedAt=new Date().toISOString();
  context.investigationViewDiagnostic?.mark('report-after-view','cleanup-confirmed',current);
  return found;
  }finally{
    if(action==='diagnose')context.log('investigation-diagnosis-observation-result',{
      timeoutMilliseconds:timeout,finishedAt:new Date().toISOString(),elapsedMilliseconds:Date.now()-observationStarted,
      reportObserved,reportObservedAt,cleanupConfirmed,cleanupConfirmedAt});
  }
}

async function action(context, label, name, timeout = 360000) {
  if(name==='diagnose'&&context.observeOperation)return context.observeOperation('diagnose',()=>performAction(context,label,name,timeout),Date.now()+timeout);
  return performAction(context,label,name,timeout);
}

async function performAction(context, label, name, timeout) {
  const before = await directories(reportRoot(context));
  const current = await view(context);
  await context.observeWork?.(`investigation-${name}-before-action`);
  await current.getByRole('button', {name: label, exact: true}).click();
  const result=await reportAfter(context, before, name, timeout);
  await context.observeWork?.(`investigation-${name}-completed-before-teardown`);
  return result;
}

async function quickPick(context, title, choice = 0) {
  const widget = context.windowPage.locator('.quick-input-widget');
  await widget.waitFor({state: 'visible', timeout: 30000});
  await eventually(async () => (await widget.innerText()).includes(title), `native quick pick ${title}`, 30000);
  const choices = widget.locator('.monaco-list-row[role="option"]');
  if (typeof choice === 'string') {
    const selected = choices.filter({hasText: choice});
    await eventually(async () => (await selected.count()) === 1, `saved evidence ${choice}`, 30000);
    await selected.click();
  } else {
    await eventually(async () => (await choices.count()) > choice, `saved evidence choice ${choice}`, 30000);
    await choices.nth(choice).click();
  }
}

async function selectScenario(context, id, implementation) {
  const current = await tab(context, 'Scenarios');
  await current.getByRole('button', {name: 'Clear selection', exact: true}).click();
  const cards = current.locator('article.card').filter({has: current.locator('.scenario-title strong', {hasText: id})});
  const card = cards.filter({has: current.locator('.implementation', {hasText: implementation})}).first();
  await card.locator('.scenario-title input').check();
  assert.match(await current.locator('#app').innerText(), /1 selected/);
  return current;
}

async function selectTools(context, names) {
  let current = await tab(context, 'Scenarios');
  const fieldset = current.locator('fieldset').filter({has: current.getByText('Diagnostic tools', {exact: true})});
  const tools = await fieldset.locator('label span').allTextContents();
  for (const text of tools) {
    const tool = text.split(' · ')[0];
    const input = fieldset.locator('label').filter({hasText: text}).locator('input');
    if (names.includes(tool)) await input.check(); else await input.uncheck();
  }
  for (const name of names) assert(tools.some(text => text.startsWith(`${name} ·`)), `${name} analyzer is declared by General controller`);
  return current;
}

async function discover(context) {
  const result = await action(context, 'Discover tests', 'discover');
  assert.equal(result.report.schema_version, 'perfchecker-discovery/1');
  assert(result.report.declared.some(item => item.id === 'sum_squares' && item.implementation === 'allocating'));
  assert(result.report.declared.some(item => item.id === 'wait_task'));
  assert(result.report.candidates.length, 'The real Julia test fixture produces discoverable proposals');
  assert(result.report.analyzers.some(item => item.tool === 'jet'));
  const current = await tab(context, 'Scenarios');
  for (const name of ['Scenarios', 'Findings & advice', 'Before / after', 'Saved evidence']) {
    await current.getByRole('button', {name, exact: true}).click();
    assert.equal(await current.getByRole('button', {name, exact: true}).getAttribute('aria-current'), 'page');
  }
  await current.getByRole('button', {name: 'Scenarios', exact: true}).click();
  await current.getByRole('button', {name: 'Select all declared', exact: true}).click();
  const selected = result.report.declared.length;
  assert.match(await current.locator('#app').innerText(), new RegExp(`${selected} selected`));
  await current.getByRole('searchbox', {name: 'Filter scenarios'}).fill('absent-native-fixture');
  await current.getByRole('searchbox', {name: 'Filter scenarios'}).press('Tab');
  assert.equal(await current.locator('.scenario-title').count(), 0);
  assert.match(await current.locator('#app').innerText(), new RegExp(`${selected} selected`));
  await current.getByRole('button', {name: 'Clear selection', exact: true}).click();
  assert.equal(await current.getByRole('button', {name: 'Measure selected', exact: true}).isDisabled(), true);
  await current.getByRole('searchbox', {name: 'Filter scenarios'}).fill('');
  await current.getByRole('searchbox', {name: 'Filter scenarios'}).press('Tab');
  await selectScenario(context, 'sum_squares', 'allocating');
  await selectTools(context, []);
  assert.equal(await current.getByRole('button', {name: 'Diagnose selected', exact: true}).isDisabled(), true);
  assert.equal(await current.getByRole('button', {name: 'Investigate selected', exact: true}).isDisabled(), true);
  await selectTools(context, ['jet', 'alloccheck', 'latency']);

  const candidate = result.report.candidates[0];
  await current.locator('article.proposal').first().getByRole('button', {name: 'Prepare shared case', exact: true}).click();
  await eventually(() => context.vscode.window.activeTextEditor?.document.isUntitled, 'Prepare shared case opens a real untitled Julia draft');
  assert(context.vscode.window.activeTextEditor.document.getText().includes('prepare'));
  const source = result.report.declared.find(item => item.id === 'sum_squares').source;
  await context.vscode.commands.executeCommand('perfchecker.openInvestigationSource', source, 1);
  assert.equal(context.vscode.window.activeTextEditor.document.uri.fsPath, context.vscode.Uri.file(path.resolve(context.workspace, source)).fsPath);
  const lenses = await context.vscode.commands.executeCommand('vscode.executeCodeLensProvider', context.vscode.Uri.file(path.resolve(context.workspace, source)));
  assert(lenses.some(lens => lens.command?.command === 'perfchecker.diagnoseScenarios'), 'Declared factory has a real Julia diagnosis CodeLens');
  context.proof('investigation-discovery-selection-source-draft', {declared: selected, proposals: result.report.candidates.length, preparedProposal: candidate.id, hiddenSelections: true, codeLens: true});
  return result;
}

async function adopt(context, id, factory, parameters = {}) {
  const current = await tab(context, 'Scenarios');
  const form = current.locator('details.card').filter({has: current.locator('summary', {hasText: 'Adopt a shared factory into the catalogue'})});
  await form.locator('summary').click();
  await form.locator('input[name="id"]').fill(id);
  await form.locator('input[name="source"]').fill('perf/cases.jl');
  await form.locator('input[name="factory"]').fill(factory);
  await form.locator('input[name="implementation"]').fill('ui');
  await form.locator('textarea').nth(0).fill('{ invalid');
  await form.getByRole('button', {name: 'Add declaration', exact: true}).click();
  assert.match(await form.getByRole('alert').innerText(), /Invalid input/);
  await form.locator('textarea').nth(0).fill(JSON.stringify(parameters));
  const before = await directories(reportRoot(context));
  await form.getByRole('button', {name: 'Add declaration', exact: true}).click();
  const result = await reportAfter(context, before, 'discover');
  assert(result.report.declared.some(item => item.id === id && item.factory === factory));
  const catalog = path.resolve(context.workspace, configuration(context).get('scenarioCatalog', 'perf/scenarios.toml'));
  assert((await fs.readFile(catalog, 'utf8')).includes(`id = "${id}"`));
  context.proof('investigation-adoption', {id, factory, invalidJsonRejected: true, realCatalog: catalog});
  return result;
}

async function rejectAdoption(context) {
  const catalog = path.resolve(context.workspace, configuration(context).get('scenarioCatalog', 'perf/scenarios.toml'));
  const before = await fs.readFile(catalog);
  const cases = [
    {id: 'ui_invalid_parameters', parameters: '[]', fixtures: '[]', error: /Parameters must be a JSON object/},
    {id: 'ui_invalid_fixture', parameters: '{}', fixtures: '{}', error: /Provide an array of at most 128 fixture paths/},
    {id: 'ui_adopted', parameters: '{}', fixtures: '[]', error: /already declared/},
  ];
  for (const testCase of cases) {
    const current = await tab(context, 'Scenarios');
    const form = current.locator('details.card').filter({has: current.locator('summary', {hasText: 'Adopt a shared factory into the catalogue'})});
    if ((await form.getAttribute('open')) === null) await form.locator('summary').click();
    await form.locator('input[name="id"]').fill(testCase.id);
    await form.locator('input[name="source"]').fill('perf/cases.jl');
    await form.locator('input[name="factory"]').fill('make_sum_case');
    await form.locator('input[name="implementation"]').fill('ui');
    await form.locator('textarea').nth(0).fill(testCase.parameters);
    await form.locator('textarea').nth(1).fill(testCase.fixtures);
    await form.getByRole('button', {name: 'Add declaration', exact: true}).click();
    await eventually(async () => testCase.error.test(await current.locator('#app .status').innerText()), `Invalid or duplicate declaration ${testCase.id} is rejected`);
    assert.deepEqual(await fs.readFile(catalog), before, 'Invalid input does not alter the actual catalogue');
  }
  context.proof('investigation-adoption-types-and-duplicate-rejected', {parametersArray: true, fixturesObject: true, duplicate: true, catalogUnchanged: true});
}

async function measure(context) {
  await selectScenario(context, 'ui_adopted', 'ui');
  const result = await action(context, 'Measure selected', 'run');
  assert.equal(result.report.schema_version, 'perfchecker-scenario-run/1');
  assert.equal(result.report.runs.length, 1);
  const run = result.report.runs[0];
  assert.equal(run.collector, 'benchmark');
  assert.equal(run.qualification.availability, 'complete');
  assert.equal(run.qualification.correctness, 'passed');
  assert(run.summaries.some(summary => summary.metric === 'julia.wall.time' && summary.samples >= 2));
  context.investigationViewDiagnostic?.mark('measurement-findings-view','report-assertions-complete');
  const current = await tab(context, 'Findings & advice','measurement-findings-view');
  const chart = current.locator('svg.sample-chart');
  assert(await chart.count(), 'Actual measured observations produce a sample chart');
  await chart.locator('circle').first().focus();
  assert.match(await chart.locator('circle').first().getAttribute('aria-label'), /Displayed sample/);
  await current.getByText('Qualification and measurement evidence', {exact: true}).click();
  assert.match(await current.locator('#app').innerText(), /passed/);
  context.proof('investigation-real-measurement', {scenario: run.scenario.id, collector: run.collector, correctness: run.qualification.correctness, samples: run.summaries[0]?.samples, report: result.location});
  context.investigationFirstRun ||= result;
  return result;
}

async function diagnose(context) {
  await selectScenario(context, 'ui_adopted', 'ui');
  const tools = ['jet', 'aqua', 'alloccheck', 'snoopcompile', 'latency', 'gc', 'memory', 'heap', 'locks'];
  await selectTools(context, tools);
  // Nine real analyzers can outlive six minutes on a cold macOS CI host.
  // This observation allowance leaves every execution limit and assertion intact.
  const result = await action(context, 'Diagnose selected', 'diagnose', process.platform==='darwin'?900000:360000);
  assert.equal(result.report.schema_version, 'perfchecker-diagnosis/1');
  context.log('investigation-diagnosis-record-statuses',{records:result.report.records.slice(0,16).map(record=>({
    tool:tools.includes(record.tool)?record.tool:'unlisted',
    status:['complete','unavailable','timeout','cancelled','error','failed','invalid_evidence'].includes(record.status)?record.status:'unlisted',
    ...(Number.isFinite(record.elapsed_seconds??record.worker_elapsed_seconds)?{elapsedSeconds:record.elapsed_seconds??record.worker_elapsed_seconds}:{})}))});
  for (const tool of tools) {
    const records = result.report.records.filter(record => record.tool === tool);
    assert.equal(records.length, 1, `${tool} has one actual worker result`);
    const record = records[0];
    assert(['complete', 'unavailable'].includes(record.status), `${tool} does not hide errors, invalid evidence, timeout or cancellation as a prerequisite`);
    if (record.status === 'complete') {
      // Aqua assesses package quality; it does not run the scenario's oracle.
      // Its real adapter separates that assessment from runtime correctness.
      if (tool === 'aqua') {
        assert.equal(record.correctness, 'not_checked');
        assert(['passed', 'failed'].includes(record.quality), 'Aqua returns a real package-quality assessment');
      } else assert.equal(record.correctness, 'passed', `${tool} execution returns valid diagnosis evidence`);
    }
    if (record.status === 'unavailable') assert(String(record.message || '').trim(), `${tool} unavailable status explains its prerequisite`);
    if (['latency', 'gc', 'memory'].includes(tool)) assert.equal(record.status, 'complete', `${tool} built-in worker actually executes`);
    if (['investigation','diagnosis'].includes(process.env.PERFCHECKER_NATIVE_PHASE) && ['aqua', 'snoopcompile'].includes(tool))
      assert.equal(record.status, 'complete', `${tool} is explicitly installed for this positive optional-analyzer campaign`);
    if (['heap','locks'].includes(tool) && record.status === 'unavailable') assert.match(String(record.message), tool === 'heap' ? /snapshot|redact|unsupported|not supported|runtime/i : /counter|1\.11|not exposed|unsupported|runtime/i, `${tool} has a concrete runtime prerequisite`);
    context.proof(`investigation-analyzer-${tool}`, {status: record.status, correctness: record.correctness, quality: record.quality, version: record.tool_version, prerequisite: record.status === 'complete' ? undefined : record.message});
  }
  const current = await tab(context, 'Findings & advice');
  const artifactRecord = result.report.records.find(record => record.artifacts?.length);
  if (artifactRecord) {
    const artifact = artifactRecord.artifacts[0];
    const bytes = await fs.readFile(artifact.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    const cardFor = frame => frame.locator('article.card').filter({has: frame.getByRole('heading', {name: `${artifactRecord.scenario} · ${artifactRecord.implementation} · ${artifactRecord.tool}`, exact: true})});
    const recordCard = cardFor(current);
    await recordCard.getByRole('button', {name: `Open ${artifact.kind}`, exact: true}).first().click();
    const artifactUri=context.vscode.Uri.file(artifact.path);
    await eventually(() => context.vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.isActive&&tab.input?.uri?.fsPath===artifactUri.fsPath)), 'Evidence artifact opens in the actual native text or custom editor');
    const opened=context.vscode.window.tabGroups.all.flatMap(group=>group.tabs).find(tab=>tab.isActive&&tab.input?.uri?.fsPath===artifactUri.fsPath);
    context.log('investigation-artifact-native-editor',{kind:artifact.kind,editor:opened.input.constructor.name,uri:path.basename(artifact.path)});
    await fs.writeFile(artifact.path, Buffer.concat([bytes, Buffer.from('\nchanged by isolated integrity test\n')]));
    try {
      // Opening a native editor hides and unloads this non-retained webview.
      const reopened = await tab(context, 'Findings & advice');
      await cardFor(reopened).getByRole('button', {name: `Open ${artifact.kind}`, exact: true}).first().click();
      await eventually(async () => /Artifact changed/.test(await reopened.locator('#app .status').innerText()), 'Changed artifact is rejected by digest');
    } finally {await fs.writeFile(artifact.path, bytes);}
    context.proof('investigation-native-artifact-and-integrity', {kind: artifact.kind, sha256: artifact.sha256});
  } else context.log('investigation-artifact-prerequisite-gap', {reason: 'The real analyzers returned no evidence artifacts; artifact execution is not qualified by this run.'});
  return result;
}

async function advise(context) {
  const current = await tab(context, 'Findings & advice');
  const before = await directories(reportRoot(context));
  await current.getByRole('button', {name: 'Advise from saved evidence', exact: true}).click();
  await quickPick(context, 'Choose saved evidence', 0);
  const result = await reportAfter(context, before, 'advise');
  assert.equal(result.report.schema_version, 'perfchecker-advice/1');
  assert(Array.isArray(result.report.recommendations));
  assert(await (await view(context)).getByRole('heading', {name: 'Recommendations', exact: true}).isVisible());
  await (await view(context)).getByRole('button', {name: 'Explain with configured model', exact: true}).click();
  await eventually(async () => /Optional advisor is disabled/.test(await current.locator('#app .status').innerText()), 'Unconfigured model explains the prerequisite without making a generation request');
  context.proof('investigation-saved-advice-and-disabled-model', {recommendations: result.report.recommendations.length, modelPrerequisiteExplained: true});
}

async function compare(context) {
  const candidate = await measure(context);
  const baseline = context.investigationFirstRun;
  assert(baseline && baseline.directory !== candidate.directory, 'Compare requires two distinct real measurements of the same scenario');
  // History.created is captured after filesystem setup; it is not the directory ID's
  // earlier timestamp. Read the actual picker labels and require one nearby entry.
  const timestamp = directory => path.basename(directory).slice(0, 24).replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  const pickMeasurement = async (title, directory) => {
    const widget = context.windowPage.locator('.quick-input-widget');
    await widget.waitFor({state:'visible',timeout:30000});
    await eventually(async()=>(await widget.innerText()).includes(title),`native quick pick ${title}`,30000);
    const target = Date.parse(timestamp(directory));
    const rows = widget.locator('.monaco-list-row[role="option"]');
    const labels = await rows.allTextContents();
    const matches = labels.map((label,index)=>({label,index,date:label.match(/run · (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)/)?.[1]}))
      .filter(item=>item.date&&Math.abs(Date.parse(item.date)-target)<10000);
    assert.equal(matches.length,1,`One actual saved measurement corresponds to ${timestamp(directory)}: ${JSON.stringify(labels)}`);
    context.log('investigation-native-measurement-picker',{title,directory:path.basename(directory),displayedTimestamp:matches[0].date});
    await rows.nth(matches[0].index).click();
  };
  const current = await tab(context, 'Before / after');
  const before = await directories(reportRoot(context));
  await current.getByRole('button', {name: 'Choose baseline and candidate', exact: true}).click();
  await pickMeasurement('Choose the baseline measurement', baseline.directory);
  await pickMeasurement('Choose the candidate measurement', candidate.directory);
  const result = await reportAfter(context, before, 'compare');
  assert.equal(result.report.schema_version, 'perfchecker-scenario-comparison/1');
  assert(result.report.configurations.some(item => item.scenario === 'ui_adopted' && item.implementation === 'ui'));
  assert.match(await (await tab(context, 'Before / after')).locator('#app').innerText(), /ui_adopted/);
  context.proof('investigation-real-baseline-candidate', {configurations: result.report.configurations.length, report: result.location});
}

async function bounded(context) {
  await selectScenario(context, 'ui_adopted', 'ui');
  await selectTools(context, ['latency']);
  const result = await action(context, 'Investigate selected', 'investigate');
  assert.equal(result.report.schema_version, 'perfchecker-investigation/1');
  assert(result.report.experiments.length <= 1, 'Actual investigation honors the one-experiment budget');
  assert(Array.isArray(result.report.unexecuted));
  assert(Array.isArray(result.report.decisions));
  const current = await tab(context, 'Findings & advice');
  assert.match(await current.locator('#app').innerText(), /Bounded investigation/);
  await current.getByText('Limits', {exact: true}).click();
  await current.getByText('Experiments not executed', {exact: true}).click();
  await current.getByText('Optional model decisions', {exact: true}).click();
  context.proof('investigation-real-bounded-work', {status: result.report.status, experiments: result.report.experiments.length, limits: result.report.limits});
}

async function syncAndHistory(context) {
  await tab(context, 'Scenarios');
  const sync = await action(context, 'Compare catalogue with CI', 'sync');
  assert.equal(sync.report.schema_version, 'perfchecker-scenario-sync/1');
  assert(Array.isArray(sync.report.coverage));
  await tab(context, 'Scenarios');
  const catalog = await action(context, 'Browse tool catalogue', 'tools');
  assert.equal(catalog.report.schema_version, 'perfchecker-tool-catalog/1');
  const current = await tab(context, 'Findings & advice');
  const search = current.getByRole('searchbox', {name: 'Search tool catalogue'});
  await search.fill('jet');
  assert.match(await current.locator('#app').innerText(), /JET/i);
  await search.fill('no-native-tool-matches');
  assert.equal(await current.locator('article.card').count(), 0);
  await search.fill('');
  let history = await tab(context, 'Saved evidence');
  const cardFor = frame => frame.locator('article.card').filter({has: frame.getByRole('heading', {name: /^run ·/})}).first();
  for (const format of ['JSON', 'Markdown']) {
    await cardFor(history).getByRole('button', {name: format, exact: true}).click();
    await eventually(() => context.vscode.window.activeTextEditor?.document.uri.fsPath.endsWith(format === 'JSON' ? 'run.json' : 'run.md'), `Native ${format} saved evidence export`);
    history = await tab(context, 'Saved evidence');
  }
  await cardFor(history).getByRole('button', {name: 'Open evidence', exact: true}).click();
  await eventually(async () => /Saved evidence/.test(await history.locator('#app .status').innerText()), 'History reloads actual evidence without starting a worker');
  await (await view(context)).getByRole('button', {name: 'Worker log', exact: true}).click();
  await eventually(async () => /PerfChecker investigations/.test(await context.windowPage.locator('body').innerText()), 'Investigation output channel is displayed');
  context.proof('investigation-sync-tools-history-native-exports', {coverage: sync.report.coverage.length, tools: catalog.report.tools.length, formats: ['JSON', 'Markdown'], historyReload: true});
}

async function profiles(context) {
  await selectScenario(context, 'sampled_sum_squares', 'sampled');
  const result = await action(context, 'Measure selected', 'run');
  assert.equal(result.report.runs.length, 4);
  for (const collector of ['benchmark', 'chairmark', 'profile', 'profile_alloc']) {
    const runs = result.report.runs.filter(item => item.collector === collector);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].qualification.availability, 'complete');
    assert.equal(runs[0].qualification.correctness, 'passed');
  }
  const current = await tab(context, 'Findings & advice');
  const profiles = current.locator('details:has(> summary:text-is("Explore sampled stacks and allocations"))');
  assert.equal(await profiles.count(), result.report.runs.filter(run=>run.profile).length, 'Every actual profile payload has its own native disclosure');
  for(const collector of ['profile','profile_alloc']){
    const run=result.report.runs.find(run=>run.collector===collector);
    const sampled=collector==='profile'?run.profile.stacks:run.profile.allocation_sites;
    assert(sampled.length>0,`${collector} has nonempty actual sampled evidence, rather than an empty disclosure`);
  }
  for (let index = 0; index < await profiles.count(); index++) {
    const profile = profiles.nth(index);
    await profile.locator('summary').first().click();
    const filter = profile.getByRole('searchbox', {name: 'Filter profile stacks'});
    await filter.fill('no-stack-matches-native-test');
    assert.match(await profile.innerText(), /0 \/ 0 matching|No samples were collected/);
    await filter.fill('');
    await profile.getByText('Raw profile', {exact: true}).click();
  }
  context.proof('investigation-real-collectors-and-profile-controls', {collectors: result.report.runs.map(item => item.collector), profileFilter: true, fullRawEvidence: true});
}

async function cancel(context) {
  const marker = path.join(context.workspace, 'perf', 'native-investigation-running.marker');
  await fs.rm(marker, {force: true});
  await adopt(context, 'ui_cancel', 'make_cancel_case', {marker});
  const current = await selectScenario(context, 'ui_cancel', 'ui');
  await current.getByRole('button', {name: 'Measure selected', exact: true}).click();
  await eventually(async () => (await fs.readFile(marker, 'utf8')) === 'running', 'Actual isolated scenario operation starts before cancellation', 180000);
  await (await view(context)).getByRole('button', {name: 'Cancel', exact: true}).click();
  await eventually(async () => /Cancelled after controller cleanup/.test(await current.locator('#app .status').innerText()), 'Cancel waits for actual controller and worker cleanup', 120000);
  const history = await tab(context, 'Saved evidence');
  const first = history.locator('article.card').first();
  assert.match(await first.innerText(), /cancelled/);
  assert.equal(await first.getByRole('button', {name: 'Open evidence', exact: true}).isDisabled(), true);
  await fs.rm(marker, {force: true});
  context.proof('investigation-cancel-active-julia-worker', {workerStarted: true, cleanupCompleted: true, remainingConfigurationsQualified: false});
}

async function savedImport(context) {
  const temporary=await fs.mkdtemp(path.join(tmpdir(),'perfchecker-native-diagnostic-import-'));
  const filename=path.join(temporary,'saved-diagnosis.json'),invalid=path.join(temporary,'invalid.json');
  const base={scenario:'saved-diagnostic-control',implementation:'fixture',status:'complete',correctness:'passed',summary:'',findings:[],
    configuration:{project:'Recorded control fixture; no workload was executed'},measurement_scope:'Synthetic data qualifies the saved-report viewer only'};
  const report={schema_version:'perfchecker-diagnosis/1',records:[
    {...base,tool:'latency',measurements:{load_seconds:1.25,first_case_seconds:2.5,warm_case_seconds:0.125}},
    {...base,tool:'memory',measurements:{samples:Array.from({length:5},()=>({state_before_bytes:10,state_after_bytes:20,state_and_result_bytes:30}))}},
    {scenario:'missing-control',implementation:'fixture',tool:'latency',status:'unavailable',message:'Not measured in this fixture'},
  ]};
  const text=JSON.stringify(report,null,2)+'\n',sha256=createHash('sha256').update(text).digest('hex');
  await fs.writeFile(filename,text);await fs.writeFile(invalid,'{"schema_version":"perfchecker-diagnosis/1","records":[{"tool":"latency"}]}');
  const files=context.vscode.workspace.getConfiguration('files',context.vscode.Uri.file(context.workspace));
  const previous=files.inspect('simpleDialog.enable')?.globalValue;
  const beforeDirectories=await directories(reportRoot(context));
  const beforeHistory=await (await tab(context,'Saved evidence')).locator('article.card').allTextContents();
  const choose=async file=>{
    const picker=context.windowPage.locator('.quick-input-widget');await picker.waitFor({state:'visible',timeout:30000});
    const input=picker.locator('input[type="text"]');await input.fill(file);await input.press('Enter');
    await picker.waitFor({state:'hidden',timeout:30000});
  };
  try{
    await files.update('simpleDialog.enable',true,context.vscode.ConfigurationTarget.Global);
    const pending=context.vscode.commands.executeCommand('perfchecker.openDiagnosticReport');await choose(filename);await pending;
    let current=await view(context);
    const banner=current.locator('.imported-diagnostic');await banner.waitFor({state:'visible'});
    assert.match(await banner.innerText(),/not measured or independently verified in this editor session/);
    assert((await banner.innerText()).includes(sha256));assert((await banner.innerText()).includes(await fs.realpath(filename)));
    assert.deepEqual(await current.locator('.diagnostic-values dd').allTextContents(),['1.25 s','2.5 s','0.125 s']);
    assert.equal(await current.locator('.diagnostic-memory tbody tr').count(),5);
    assert.match(await current.locator('article.card').last().innerText(),/Availability: unavailable/);
    for(const name of ['Advise from saved evidence','Explain with configured model'])assert.equal(await current.getByRole('button',{name,exact:true}).isDisabled(),true);
    await current.getByRole('button',{name:'Open imported JSON snapshot',exact:true}).click();
    await eventually(()=>context.vscode.window.activeTextEditor?.document.isUntitled,'Imported JSON opens an unsaved snapshot');
    assert.equal(context.vscode.window.activeTextEditor.document.getText(),text);
    await context.vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    current=await view(context);
    await current.getByRole('button',{name:'Open saved diagnostic report',exact:true}).click();
    const picker=context.windowPage.locator('.quick-input-widget');await picker.waitFor({state:'visible'});await picker.locator('input[type="text"]').press('Escape');
    await picker.waitFor({state:'hidden'});assert((await current.locator('.imported-diagnostic').innerText()).includes(sha256));
    await current.getByRole('button',{name:'Open saved diagnostic report',exact:true}).click();await choose(invalid);
    await eventually(async()=>/Invalid diagnostic record/.test(await current.locator('#app > .status').innerText()),'Invalid saved JSON is refused without replacing the snapshot');
    assert((await current.locator('.imported-diagnostic').innerText()).includes(sha256));
    assert.deepEqual(await current.locator('.diagnostic-values dd').allTextContents(),['1.25 s','2.5 s','0.125 s']);
    assert.equal(await fs.readFile(filename,'utf8'),text);
    assert.deepEqual(await directories(reportRoot(context)),beforeDirectories);
    assert.deepEqual(await (await tab(context,'Saved evidence')).locator('article.card').allTextContents(),beforeHistory);
    context.proof('native-saved-diagnostic-import',{fixture:'synthetic viewer control, not measured evidence',sourceSha256:sha256,sourceBytesUnchanged:true,
      commandDialog:true,buttonDialog:true,cancelPreservesSnapshot:true,invalidPreservesSnapshot:true,unsavedOriginalJson:true,
      displayedLatencySeconds:[1.25,2.5,0.125],displayedMemorySamples:5,unavailablePreserved:true,historyViewUnchanged:true,reportDirectoriesUnchanged:true});
  }finally{
    await files.update('simpleDialog.enable',previous,context.vscode.ConfigurationTarget.Global);
    await fs.rm(temporary,{recursive:true,force:true});
  }
}
exports.runSavedImport=savedImport;

async function runControls(context,options={}) {
  assert.equal(process.env.CI, 'true', 'Use disposable remote CI profiles, never the user VS Code');
  assert(path.isAbsolute(context.workspace));
  const settings = configuration(context);
  const keys = ['scenarioSamples', 'analysisTimeout', 'investigationMaxExperiments', 'investigationBudgetSeconds', 'advisorEnabled', 'advisorInvestigates'];
  const previous = Object.fromEntries(keys.map(key => [key, settings.inspect(key)?.workspaceFolderValue]));
  const values = {scenarioSamples: 2, analysisTimeout: 180, investigationMaxExperiments: 1, investigationBudgetSeconds: 120, advisorEnabled: false, advisorInvestigates: false};
  const catalog = path.resolve(context.workspace, settings.get('scenarioCatalog', 'perf/scenarios.toml'));
  const originalCatalog = await fs.readFile(catalog);
  const failures = [];
  try {
    for (const key of keys) await settings.update(key, values[key], context.vscode.ConfigurationTarget.WorkspaceFolder);
    await clickStudioAction(context,'investigations');
    const cases=[
      ['read-only-saved-diagnostic-import', () => savedImport(context)],
      ['discovery-selection-proposals', () => discover(context)],
      ['adopt-real-shared-factory', () => adopt(context, 'ui_adopted', 'make_sum_case')],
      ['reject-invalid-and-duplicate-adoption', () => rejectAdoption(context)],
      ['measure-real-shared-factory', () => measure(context)],
      ['measure-shared-collectors-profiles', () => profiles(context)],
      ['diagnose-real-analyzers', () => diagnose(context)],
      ['advise-from-saved-evidence', () => advise(context)],
      ['compare-real-measurements', () => compare(context)],
      ['bounded-investigation', () => bounded(context)],
      ['sync-tools-history', () => syncAndHistory(context)],
      ['cancel-active-scenario-worker', () => cancel(context)],
    ];
    let blockedBy;
    for (const [name, callback] of cases.filter(([name])=>!options.diagnosisOnly||['discovery-selection-proposals','adopt-real-shared-factory','diagnose-real-analyzers'].includes(name))) {
      context.investigationViewDiagnostic?.group(name);
      if(options.diagnosisOnly&&blockedBy){
        failures.push(new Error(`${name}: Blocked by ${blockedBy}`));
        context.log(`investigation-${name}-blocked`,{status:'blocked',blockedBy});continue;
      }
      try {await callback();}
      catch (error) {failures.push(new Error(`${name}: ${error.message}`, {cause: error})); context.log(`investigation-${name}-failed`, {message: error.message});blockedBy=name;await context.observeWork?.(`investigation-${name}-failed-before-cleanup`);}
    }
  } finally {
    await context.vscode.commands.executeCommand('perfchecker.cancelInvestigation').catch(() => {});
    try {
      const current = await view(context,'teardown-view');
      await eventually(async () => !(await current.locator('#app .status').getAttribute('class')).includes('busy'), 'Investigation teardown waits for worker cleanup', 120000);
    } catch (error) {failures.push(new Error(`investigation-teardown: ${error.message}`, {cause: error}));}
    await fs.writeFile(catalog, originalCatalog);
    await fs.rm(path.join(context.workspace, 'perf', 'native-investigation-running.marker'), {force: true});
    for (const key of keys) await configuration(context).update(key, previous[key], context.vscode.ConfigurationTarget.WorkspaceFolder);
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} real investigation control groups failed`);
}
exports.run=async(context,options={})=>{
  if(!context.investigationObservation)return runControls(context,options);
  const diagnostic=exports.createInvestigationViewDiagnostic(context,{scriptPath:path.join(context.extension.extensionPath,'media','investigation.js'),
    ...(context.investigationObservation.phaseDeadlineAt?{deadlineAt:Date.parse(context.investigationObservation.phaseDeadlineAt)}:{})});
  let result,originalFailure,retirementFailure;
  try{result=await runControls({...context,investigationViewDiagnostic:diagnostic},options);}catch(error){originalFailure=error;}
  try{await diagnostic.finish();}catch(error){retirementFailure=error;}
  if(retirementFailure)throw new AggregateError([...(originalFailure?[originalFailure]:[]),retirementFailure],'Investigation UI diagnostic failed');
  if(originalFailure)throw originalFailure;return result;
};
exports.investigationDiagnosticControls={view,tab,reportAfter,readSnapshot:investigationDomSnapshot};
exports.runDiagnosis=context=>exports.run(context,{diagnosisOnly:true});
