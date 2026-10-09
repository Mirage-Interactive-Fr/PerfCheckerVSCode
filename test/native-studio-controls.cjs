// Exercise the installed public VSIX through its real VS Code webviews in disposable CI profiles.
// No intercepted VS Code API, replaced process, fabricated plan message or model credential is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {createHash}=require('node:crypto');

async function capture(context, name) {
  const file=path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,`native-${process.platform}-vscode-${context.vscode.version}-${name}.png`);
  await context.windowPage.screenshot({path:file});
  if(process.env.PERFCHECKER_NATIVE_VIDEO==='1')await new Promise(resolve=>setTimeout(resolve,2500));
  context.log('native-interface-capture',{interface:name,file:path.basename(file),sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex'),
    vscode:context.vscode.version,extension:process.env.PERFCHECKER_NATIVE_EXPECTED_VERSION,core:context.core,source:'actual-isolated-Electron-workbench'});
}

const studioActions = {
  suite: 'Feature suite', items: 'Existing Julia tests', testing: 'Test Explorer',
  results: 'Plots & results', investigations: 'Investigations', tools: 'Tool catalogue',
  chat: 'Talk to your agent', advisor: 'Connect an advisor', debug: 'Debug Julia code',
  notebook: 'New Pluto notebook', openNotebook: 'Open Pluto notebook',
  terminal: 'PerfChecker terminal', julia: 'Julia extension REPL', tasks: 'Project tasks',
};
const checkTypes = ['BenchmarkTools', 'Chairmarks', 'Line allocations', 'Allocation profile',
  'CPU profile', 'Wall-time profile', 'Network workload', 'Network interface', 'Isolated network'];

async function eventually(read, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; }
    catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}

function assertDisposable(context) {
  assert.equal(process.env.CI, 'true', 'Native control tests run only in disposable CI, never a user VS Code profile');
  assert(path.isAbsolute(context.workspace));
  assert(context.findFrame, 'The real CDP webview finder must be supplied by the native host');
}

async function frame(context, selector) {
  return eventually(async () => {
    const result = await context.findFrame(selector);
    await result.locator(selector).first().waitFor({state: 'visible', timeout: 1000});
    return result;
  }, `Reacquire the current native webview ${selector}`);
}

async function studio(context) {
  await context.vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',
    context.vscode.Uri.file(context.workspace));
  if(!context.openStudioCommandVerified){
    await context.vscode.commands.executeCommand('perfchecker.openStudio',context.vscode.Uri.file(context.workspace));
    const opened=await frame(context,'#studio-root');
    await eventually(async()=>(await opened.locator('.workspace strong').innerText())===context.vscode.workspace.getWorkspaceFolder(context.vscode.Uri.file(context.workspace)).name,'The generic Studio command displays the explicit workspace');
    context.proof('native-open-studio-command',{command:'perfchecker.openStudio',explicitWorkspace:true,currentPanelVisible:true});
    context.openStudioCommandVerified=true;
  }
  return frame(context, '#studio-root');
}

async function clickStudioAction(context, action) {
  const view = await studio(context);
  assert(Object.hasOwn(studioActions, action), `Known Studio action: ${action}`);
  const selector = ['notebook', 'openNotebook', 'terminal', 'julia', 'tasks'].includes(action)
    ? view.getByRole('button', {name: studioActions[action], exact: true})
    : view.locator(`[data-action="${action}"]`);
  context.log('native-ui-action',{surface:'Studio',action:studioActions[action]});
  await selector.click();
}
exports.clickStudioAction = clickStudioAction;

async function selectionCount(view) {
  const match = (await view.locator('#count').innerText()).match(/^(\d+) selected/);
  assert(match, 'The selection counter describes the exact selection');
  return Number(match[1]);
}

async function options(view, selector) {
  return view.locator(`${selector} option`).evaluateAll(items =>
    items.map(item => ({value: item.value, text: item.textContent})).filter(item => item.value));
}

async function designer(context) {
  await clickStudioAction(context, 'suite');
  // An attached empty #cards has no height while the real controller is loading.
  // Its visible owner and generated check-type controls identify a ready plan.
  const view = await context.findFrame('#cards',{allowAttached:true});
  const started=Date.now();
  const observe=async stage=>{
    const state=await view.locator('#cards').evaluate(node=>{const rect=node.getBoundingClientRect();return {cards:node.querySelectorAll('.card').length,
      geometry:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},checkTypes:document.querySelectorAll('#check-types label').length};});
    const file=path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','suite-plan.json');
    const bytes=await fs.readFile(file).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
    const plan=bytes?{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}:null;
    if(bytes){try{plan.runs=JSON.parse(bytes).runs.length;}catch(error){plan.parseIncomplete=true;plan.parseDiagnostic=String(error);}}
    context.log('native-designer-plan-readiness',{stage,elapsedMs:Date.now()-started,state,
      plan});
  };
  await observe('attached');
  try{await eventually(async()=>await view.locator('#check-types label').count()>0,'The controller supplies real check types before any filter gesture',360000);}
  catch(error){try{await observe('failed');}catch(secondary){context.log('native-designer-readiness-diagnostic-error',{message:String(secondary),primary:String(error)});}throw error;}
  await observe('plan-ready');
  await view.locator('#reset-filters').click();
  await eventually(async () => (await view.locator('#cards .card').count()) > 0,
    'General-backed suite plan renders workload cards', 120000);
  return view;
}

async function savedConfiguration(context, view) {
  const settings = context.vscode.workspace.getConfiguration('perfchecker',
    context.vscode.Uri.file(context.workspace));
  const destination = path.resolve(context.workspace, settings.get('uiConfiguration', 'perf/perfchecker-ui.json'));
  const previous = await fs.stat(destination,{bigint:true}).catch(() => undefined);
  await view.locator('#save').click();
  const config = await eventually(async () => {
    const stat = await fs.stat(destination,{bigint:true});
    if (previous && stat.mtimeNs === previous.mtimeNs) return false;
    return JSON.parse(await fs.readFile(destination, 'utf8'));
  }, 'Save configuration writes the native workspace file');
  assert.equal(config.schema_version, 'perfchecker-ui-config/1');
  return {config, destination};
}

async function controllerLaunches() {
  const root=path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'logs');
  const names=(await fs.readdir(root,{recursive:true})).filter(file=>/(?:\d+-)?PerfChecker\.log$/.test(path.basename(file))).sort();
  assert(names.length,'The real PerfChecker output log witnesses controller launches');
  return Promise.all(names.map(async file=>({file,commands:(await fs.readFile(path.join(root,file),'utf8')).split(/\r?\n/).filter(line=>line.startsWith('> '))})));
}

async function nativeSuiteWorker(context) {
  if(process.platform==='darwin'&&context.processInventory){
    const inventory=await context.processInventory('suite-active-worker');
    assert(inventory.direct.length<=1,'Exactly one owned suite controller may match the selected real run');
    const row=inventory.direct[0];return row&&{pid:row.pid,parent:row.parent,executable:row.canonicalExecutable,started:row.started};
  }
  const {execFile}=require('node:child_process'),{promisify}=require('node:util'),execute=promisify(execFile);
  const expected=await fs.realpath(process.env.PERFCHECKER_NATIVE_JULIA);
  let rows;
  if(process.platform==='win32'){
    const {stdout}=await execute('powershell.exe',['-NoProfile','-Command',
      `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ParentProcessId -eq ${process.pid} -and $_.Name -like 'julia*' } | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;executable=$_.ExecutablePath;started=$_.CreationDate.ToUniversalTime().ToString('o')} }); ConvertTo-Json -InputObject $rows -Compress`],{timeout:10000});
    rows=JSON.parse(stdout);
  }else{
    const survey=execute('ps',['-eo','pid=,ppid=,args='],{timeout:10000}),observerPid=survey.child.pid;
    const {stdout}=await survey;
    rows=stdout.split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(line);return match?[{pid:Number(match[1]),parent:Number(match[2]),command:match[3]||''}]:[];});
    const observer=rows.find(row=>row.pid===observerPid);if(observer)assert.equal(observer.parent,process.pid);
    rows=rows.filter(row=>row.pid!==observerPid);
  }
  assert(Array.isArray(rows),'The native process inventory returns an actual list');
  const matches=[];
  for(const row of rows.filter(row=>row.parent===process.pid)){
    try{
      let executable,started;
      if(process.platform==='win32'){
        executable=await fs.realpath(row.executable);started=row.started;
        assert(/^\d{4}-\d{2}-\d{2}T.*Z$/.test(started)&&Number.isFinite(Date.parse(started)),'CIM supplies an actual process creation identity');
      }else if(process.platform==='linux'){
        executable=await fs.realpath(`/proc/${row.pid}/exe`);
        const stat=await fs.readFile(`/proc/${row.pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
        if(['Z','X'].includes(fields[0]))continue;
        started=fields[19];assert(/^\d+$/.test(started),'The kernel supplies actual process start ticks');
      }else{
        const {stdout}=await execute('lsof',['-a','-p',String(row.pid),'-d','txt','-Fn'],{timeout:10000});
        const paths=await Promise.all(stdout.split('\n').filter(line=>line.startsWith('n')).map(line=>fs.realpath(line.slice(1)).catch(()=>line.slice(1))));
        if(!paths.includes(expected))continue;
        executable=expected;started=(await execute('ps',['-p',String(row.pid),'-o','lstart='],{timeout:10000})).stdout.trim();
        assert(started&&Number.isFinite(Date.parse(started)),'macOS supplies an actual process start identity');
      }
      if((process.platform==='win32'?executable.toLowerCase()===expected.toLowerCase():executable===expected))matches.push({pid:row.pid,parent:row.parent,executable,started});
    }catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw error;}
  }
  assert(matches.length<=1,'Exactly one owned suite controller may match the selected real run');
  return matches[0];
}

async function output(context) {
  await clickStudioAction(context, 'results');
  return frame(context, 'button[data-report="suite-result.json"]');
}

async function resetDesigner(view) {
  await view.locator('#reset-filters').click();
  await view.locator('#select-visible').click();
  await eventually(async () => (await selectionCount(view)) > 0, 'Restore all suite selections');
}

async function testSuiteSelection(context) {
  let view = await designer(context);
  await resetDesigner(view);
  const plan=JSON.parse(await fs.readFile(path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage',
    'mirage-interactive-fr.perfchecker-vscode','suite-plan.json'),'utf8'));
  assert(plan.runs.every(run=>run.workload),'The real native fixture declares explicit workload identities');
  const groupKey=run=>JSON.stringify([run.package,run.workload,run.version]);
  const renderedGroups=()=>view.locator('#cards .card').evaluateAll(cards=>cards.map(card=>({id:card.dataset.id,
    key:JSON.stringify([card.querySelector('.package').textContent,card.querySelector('strong').textContent,card.querySelector('.version').textContent])})));
  const assertFiltered=async(expected,label)=>{
    const ids=new Set(expected.map(run=>run.id)),keys=[...new Set(expected.map(groupKey))].sort();
    assert(keys.length<=120,'This filter fixture fits entirely within the native page');
    await eventually(async()=>{
      const counter=await view.locator('#count').innerText(),match=/· (\d+)\/(\d+) visible/.exec(counter);
      const groups=await renderedGroups();
      return match&&Number(match[1])===expected.length&&Number(match[2])===plan.runs.length&&
        groups.every(group=>ids.has(group.id))&&groups.length===keys.length&&
        JSON.stringify(groups.map(group=>group.key).sort())===JSON.stringify(keys);
    },`The native ${label} filter displays exactly the matching planned runs`);
    context.log('native-designer-filter-effect',{label,matchingRuns:expected.length,
      renderedGroupIds:await view.locator('#cards .card').evaluateAll(cards=>cards.map(card=>card.dataset.id))});
  };
  const all = await selectionCount(view);
  assert(all > 1, 'The native fixture exercises more than one selectable run');
  const labels = await view.locator('#check-types label span').allTextContents();
  for (const type of checkTypes) {
    assert(labels.some(label => label.startsWith(`${type} ·`)), `Native suite includes ${type}`);
    const input = view.locator('#check-types label').filter({hasText: `${type} ·`}).locator('input');
    await input.uncheck();
    assert((await selectionCount(view)) < all, `${type} removes matching runs, including hidden runs`);
    await input.check();
    assert.equal(await selectionCount(view), all, `${type} re-includes every matching run`);
  }
  for (const unavailable of await view.locator('.check-option.unavailable .check-status').all()) {
    assert((await unavailable.getAttribute('title'))?.trim(), 'An unavailable check explains its prerequisite');
  }
  context.proof('suite-check-types', {types: checkTypes, runs: all, unavailableReasonsChecked: true});

  const targets = await options(view, '#target-filter');
  assert(targets.length >= 2, 'At least two real targets are needed to qualify hidden selections and versions');
  for (const target of targets) {
    await view.locator('#target-filter').selectOption(target.value);
    await assertFiltered(plan.runs.filter(run=>run.version===target.value),`target=${target.value}`);
    assert.equal(await selectionCount(view), all, 'Target filtering preserves hidden selected runs');
  }
  await view.locator('#clear-visible').click();
  const hidden = await selectionCount(view);
  assert(hidden > 0 && hidden < all, 'Clear visible preserves selected runs belonging to other targets');
  assert.match(await view.locator('#count').innerText(), /selected outside filters/);
  await view.locator('#reset-filters').click();
  assert.equal(await selectionCount(view), hidden, 'Reset filters does not secretly replace the selection');
  await view.locator('#select-visible').click();
  assert.equal(await selectionCount(view), all);
  await view.locator('#clear-all').click();
  assert.equal(await selectionCount(view), 0);
  assert(await view.locator('#run').isDisabled(), 'No selection cannot launch a run');
  await view.locator('#select-visible').click();

  await view.locator('#search').fill('a-query-that-matches-no-fixture');
  await eventually(async () => (await view.locator('#cards .card').count()) === 0, 'Empty workload filter');
  assert.match(await view.locator('#cards').innerText(), /No workloads match/);
  assert.equal(await selectionCount(view), all);
  await view.locator('#clear-visible').click();
  assert.equal(await selectionCount(view), all, 'Clearing an empty visible set preserves all hidden selections');
  await view.locator('#reset-filters').click();

  for (const selector of ['#package', '#target-kind']) {
    for (const option of await options(view, selector)) {
      await view.locator(selector).selectOption(option.value);
      const key=selector==='#package'?'package':'target_kind';
      await assertFiltered(plan.runs.filter(run=>run[key]===option.value),`${key}=${option.value}`);
      assert.equal(await selectionCount(view), all);
    }
    await view.locator(selector).selectOption('');
  }
  const releaseTargets = targets.filter(item => /^v?\d+\.\d+\.\d+/.test(item.value));
  if (releaseTargets.length) {
    await view.locator('#from').fill(releaseTargets[0].value);
    await view.locator('#to').fill(releaseTargets.at(-1).value);
    const version=value=>value.replace(/^v/,'').split('.').slice(0,3).map(Number);
    const comparison=(a,b)=>{const x=version(a),y=version(b);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
    await assertFiltered(plan.runs.filter(run=>run.target_kind!=='release'||
      comparison(run.version,releaseTargets[0].value)>=0&&comparison(run.version,releaseTargets.at(-1).value)<=0),'inclusive release bounds');
    assert.equal(await selectionCount(view), all, 'Release bounds preserve selected Git targets');
    await view.locator('#from').fill('999.0.0');
    await view.locator('#to').fill('0.0.0');
    await assertFiltered(plan.runs.filter(run=>run.target_kind!=='release'),'inverted release bounds');
    assert.equal(await selectionCount(view), all, 'Inverted release bounds do not discard hidden selections');
  } else context.log('release-range-prerequisite', 'Fixture has only Git/dev targets; a registered-release fixture is still required');
  await view.locator('#reset-filters').click();
  await view.locator('#sort').selectOption('suite');
  const {config:orderConfiguration}=await savedConfiguration(context,view);
  assert.equal(orderConfiguration.selection.run_ids.length,plan.runs.length,'The real saved order includes every selected fixture run');
  const byId=new Map(plan.runs.map(run=>[run.id,run]));
  const suiteOrder=[...new Set(orderConfiguration.selection.run_ids.map(id=>groupKey(byId.get(id))))];
  assert(suiteOrder.length>=2,'The native ordering fixture includes distinct workload groups');
  // This fixture declares version0.1.0, Example's four release targets and the
  // opaque baseline. An explicit independent order catches category cycles.
  const versionOrder=['dev@0.1.0','0.5.0','0.5.3','0.5.4','0.5.5','baseline'];
  assert.deepEqual([...new Set(plan.runs.map(run=>run.version))].sort(),[...versionOrder].sort(),
    'The mixed native fixture retains every numeric and opaque target');
  const versionRank=new Map(versionOrder.map((value,index)=>[value,index]));
  let previousOrder=(await renderedGroups()).map(group=>group.key),observedSortChange=false;
  for (const sort of ['package', 'feature', 'version', 'suite']) {
    await view.locator('#sort').selectOption(sort);
    let observed=[];
    try{
    await eventually(async()=>{
      const groups=await renderedGroups(),actual=groups.map(group=>group.key);
      observed=groups.map(group=>({id:group.id,key:group.key,value:byId.get(group.id)?.[sort]}));
      if(groups.length!==suiteOrder.length||JSON.stringify([...actual].sort())!==JSON.stringify([...suiteOrder].sort()))return false;
      if(sort==='suite')return JSON.stringify(actual)===JSON.stringify(suiteOrder);
      const values=groups.map(group=>byId.get(group.id)[sort]);
      const compare=(a,b)=>sort==='version'?versionRank.get(a)-versionRank.get(b):a.localeCompare(b);
      return values.every((value,index)=>index===0||value===values[index-1]||compare(values[index-1],value)<=0);
    },`The displayed workload groups follow ${sort} order`);
    }catch(error){context.log('native-designer-sort-before-cleanup',{sort,observed,expectedVersionOrder:versionOrder,
      expectedInventory:suiteOrder,message:String(error.message)});throw error;}
    const groups=await renderedGroups(),actual=groups.map(group=>group.key),changed=JSON.stringify(actual)!==JSON.stringify(previousOrder);
    observedSortChange||=changed;
    context.log('native-designer-sort-effect',{sort,renderedGroups:groups,inventoryPreserved:true,orderChanged:changed,
      distinctPrimaryValues:sort==='suite'?suiteOrder.length:new Set(groups.map(group=>byId.get(group.id)[sort])).size,
      limit:changed?null:'Displayed ordering verified; this transition did not change the previous order'});
    previousOrder=actual;
  }
  assert(observedSortChange,'At least one discriminating native sort gesture changes the displayed group order');
  const group = view.locator('#cards .card').first();
  await group.locator('.pick').uncheck();
  assert((await selectionCount(view)) < all);
  await group.locator('.pick').check();
  await group.locator('.check-option input').first().uncheck();
  assert.equal(await view.locator('.card.partial').count(), 1);
  if(await view.locator('#selection-preview').locator('..').getAttribute('open')===null)
    await view.locator('#selection-summary').click();
  await eventually(async()=>await view.locator('#selection-preview li').count()===Math.min(all-1,80),
    'The native details toggle renders the exact selected runs before their count is read');
  await view.locator('#open-after-run').uncheck();
  await group.locator('.label').evaluate(input => {
    input.value = '#1266aa'; input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await view.locator('#doc-id').fill('native-checks');
  await view.locator('#doc-title').fill('Native control qualification');
  await view.locator('#doc-url').fill('https://example.invalid/qualified-report');
  for (const checkbox of await view.locator('input[name="view"]').all()) await checkbox.check();
  const {config} = await savedConfiguration(context, view);
  assert.equal(config.selection.run_ids.length, all - 1);
  assert.equal(new Set(config.selection.run_ids).size, all - 1);
  assert.equal(config.presentation.open_after_run, false);
  assert(Object.values(config.selection.labels).includes('#1266aa'));
  assert.deepEqual(config.documentation.blocks[0].views,
    ['summary', 'comparison', 'plots', 'observations', 'diagnostics', 'artifacts']);
  assert.equal(config.documentation.blocks[0].interactive_url, 'https://example.invalid/qualified-report');
  await view.locator('#refresh').click();
  await eventually(async () => !(await view.locator('#refresh').isDisabled()), 'Refresh native Julia plan', 120000);
  assert.equal(await selectionCount(view), all - 1, 'Native refresh preserves the saved and current selection');
  context.proof('suite-selection-and-save', {runs: all, selected: all - 1, hiddenSelectionsPreserved: true, views: 6});
  await view.locator('h1').first().scrollIntoViewIfNeeded();
  await capture(context,'suite-designer');

  // Exercise the script button and assert its real editor document, then return to the retained view.
  await view.locator('#cards .card .check-option .open').first().click();
  await eventually(() => context.vscode.window.activeTextEditor?.document.languageId === 'julia', 'Open workload Julia source');
  assert(path.isAbsolute(context.vscode.window.activeTextEditor.document.uri.fsPath));
  await studio(context);
  view = await designer(context);
  await resetDesigner(view);
  context.log('workload-open', context.vscode.window.activeTextEditor?.document.uri.fsPath || 'Julia editor opened');
}

async function testGitTargetsAndComparisons(context) {
  let view = await designer(context);
  // A retained plan can render while the preceding real replan is still running.
  // Git discovery is independent of that worker; wait for its native idle state first.
  const idleState=()=>view.evaluate(()=>({
    controls:Object.fromEntries(['run','refresh','save','add-target','add-comparison'].map(id=>[id,document.getElementById(id).disabled])),
    progressHidden:document.getElementById('progress').hidden,
    progress:document.getElementById('progress').textContent,
    error:document.getElementById('designer-error').textContent,
  }));
  try{
    await eventually(async()=>{
      const state=await idleState();
      return state.progressHidden&&Object.values(state.controls).every(disabled=>!disabled);
    },'The preceding actual plan finishes before Git target gestures',120000);
  }catch(error){
    try{context.log('git-target-idle-timeout',{state:await idleState(),primary:String(error)});}
    catch(secondary){context.log('git-target-idle-diagnostic-error',{message:String(secondary),primary:String(error)});}
    throw error;
  }
  const settings = () => context.vscode.workspace.getConfiguration('perfchecker', context.vscode.Uri.file(context.workspace));
  const previousTargets = settings().inspect('gitTargets')?.workspaceFolderValue;
  const previousPolicies = settings().inspect('comparisonPolicies')?.workspaceFolderValue;
  try {
    await view.locator('#target-package').selectOption('PerfCheckerNativeFixture');
    await eventually(async () => !(await view.locator('#target-reference').isDisabled()), 'Discover real local Git references');
    const groups = await view.locator('#target-reference optgroup').evaluateAll(items => items.map(item => item.label));
    assert(groups.includes('Branches') && groups.includes('Tags') && groups.includes('Recent commits'),
      'Disposable Git fixture contains branch, tag and commit references');
    await context.vscode.commands.executeCommand('workbench.action.closePanel');
    await view.locator('#target-reference').scrollIntoViewIfNeeded();
    await view.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const geometry=()=>view.evaluate(()=>{
      const rect=node=>{const value=node.getBoundingClientRect();return {left:value.left,right:value.right,width:value.width,
        clientWidth:node.clientWidth,scrollWidth:node.scrollWidth};};
      const visible=node=>{const value=node.getBoundingClientRect(),style=getComputedStyle(node);
        return value.width>0&&value.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
      return {viewportWidth:innerWidth,document:rect(document.documentElement),body:rect(document.body),
        controls:[...document.querySelectorAll('.aside-panel select, .aside-panel input:not([type="checkbox"])')].filter(visible)
          .map(node=>({id:node.id,control:rect(node),column:rect(node.closest('label')),aside:rect(node.closest('aside'))})),
        checkboxWidths:[...document.querySelectorAll('.aside-panel input[type="checkbox"]')].filter(visible).map(node=>rect(node).width),
        overflowingElements:[...document.querySelectorAll('body *')].filter(node=>visible(node)&&node.getBoundingClientRect().right>document.documentElement.clientWidth+1)
          .slice(0,20).map(node=>({tag:node.tagName,id:node.id,classes:node.className,...rect(node)}))};
    });
    let layout;
    try{
      layout=await eventually(async()=>{
        const current=await geometry();
        assert(current.controls.some(item=>item.id==='target-reference'),'The real Git inventory selector is visible');
        assert(current.document.scrollWidth<=current.document.clientWidth+1,'The real Designer document has no horizontal overflow');
        assert(current.body.scrollWidth<=current.body.clientWidth+1,'The real Designer body has no horizontal overflow');
        for(const {id,control,column,aside}of current.controls){
          assert(control.width<=column.width+1&&control.left>=column.left-1&&control.right<=column.right+1,`${id} fits its actual field column`);
          assert(control.left>=aside.left-1&&control.right<=aside.right+1,`${id} fits its actual aside`);
          assert(control.left>=-1&&control.right<=current.document.clientWidth+1&&control.right<=current.viewportWidth+1,`${id} fits the actual viewport`);
        }
        assert(current.checkboxWidths.length>0&&current.checkboxWidths.every(width=>width>0&&width<=32),'Visible documentation checkboxes retain compact native geometry');
        return current;
      },'The actual Git controls fit their columns and viewport after discovery');
    }catch(error){
      try{context.log('native-git-reference-geometry-timeout',{state:await geometry(),primary:String(error)});}
      catch(secondary){context.log('native-git-reference-geometry-diagnostic-error',{message:String(secondary),primary:String(error)});}
      throw error;
    }
    await capture(context,'git-reference-column');
    context.proof('native-git-reference-geometry',{...layout,scope:'Actual installed Designer after real Git discovery; no CSS or DOM modification'});
    const refs = await view.locator('#target-reference option[data-commit]').evaluateAll(items =>
      items.map(item => ({ref: item.value, commit: item.dataset.commit, kind: item.dataset.kind})).filter(item => item.ref));
    for (const kind of ['branch', 'tag', 'commit']) {
      const candidate = refs.find(item => item.kind === kind);
      assert(candidate?.commit?.match(/^[a-f0-9]{40}$/), `Pinned ${kind} SHA supplied by actual Git discovery`);
      await view.locator('#target-reference').selectOption(candidate.ref);
      assert(await view.locator('#target-label').inputValue(), 'Automatic display label follows selected reference');
    }
    const chosen = refs.find(item => item.kind === 'branch');
    await view.locator('#target-reference').selectOption(chosen.ref);
    await view.locator('#target-label').fill('native-click-target');
    await view.locator('#add-target').click();
    await eventually(() => settings().get('gitTargets', []).some(item => item.label === 'native-click-target'), 'Persist target from button');
    assert.equal(settings().get('gitTargets', []).find(item => item.label === 'native-click-target').revision, chosen.commit);
    await eventually(async () => !(await view.locator('#add-target').isDisabled()), 'Replan with new Git target', 120000);
    await view.locator('#target-list .target').filter({hasText: 'native-click-target'}).getByRole('button', {name: 'Remove comparison target'}).click();
    await eventually(() => !settings().get('gitTargets', []).some(item => item.label === 'native-click-target'), 'Remove target via native button');
    await eventually(async () => !(await view.locator('#add-target').isDisabled()), 'Replan after target removal', 120000);
    await view.locator('#target-revision').fill('refs/heads/nonexistent-native-fixture');
    await view.locator('#target-label').fill('invalid-native-target');
    await view.locator('#add-target').click();
    await view.locator('#target-error').waitFor({state: 'visible'});
    assert((await view.locator('#target-error').innerText()).trim());
    assert(!settings().get('gitTargets', []).some(item => item.label === 'invalid-native-target'));
    await view.locator('#refresh-targets').click();
    await eventually(async () => !(await view.locator('#target-reference').isDisabled()), 'Refresh actual Git inventory');
    context.proof('git-reference-controls', {groups, pinnedBranch: chosen.commit, addRemove: true, invalidReferenceRejected: true});

    await view.locator('#add-comparison').click();
    await view.locator('#comparison-error').waitFor({state: 'visible'});
    const candidates = await view.locator('#candidate-targets input').evaluateAll(items => items.map(item => item.value));
    assert(candidates.length >= 2, 'Comparison fixture supplies two targets');
    for (const input of await view.locator('#baseline-targets input, #candidate-targets input').all()) await input.uncheck();
    await view.locator('#baseline-targets input').first().check();
    await view.locator('#candidate-targets input').first().check();
    await view.locator('#add-comparison').click();
    assert.match(await view.locator('#comparison-error').innerText(), /different targets/);
    await view.locator('#candidate-targets input').first().uncheck();
    await view.locator('#candidate-targets input').nth(1).check();
    for (const value of ['median', 'mean', 'minimum', 'maximum']) await view.locator('#comparison-aggregation').selectOption(value);
    await view.locator('#comparison-aggregation').selectOption('median');
    await context.vscode.commands.executeCommand('workbench.action.closePanel');
    const matrix=view.locator('.aside-panel').filter({has:view.getByRole('heading',{name:'Comparison matrix',exact:true})});
    await matrix.scrollIntoViewIfNeeded();
    await capture(context,'comparison-matrix');
    const before = settings().get('comparisonPolicies', []).length;
    await view.locator('#add-comparison').click();
    await eventually(() => settings().get('comparisonPolicies', []).length === before + 1, 'Persist comparison from actual button');
    await eventually(async () => !(await view.locator('#add-comparison').isDisabled()), 'Replan after comparison', 120000);
    const policy = settings().get('comparisonPolicies', []).at(-1);
    assert.equal(policy.aggregation, 'median');
    assert.equal(policy.baselines.length, 1); assert.equal(policy.candidates.length, 1);
    await view.locator('#comparison-list .target').last().getByRole('button', {name: 'Remove comparison', exact: true}).click();
    await eventually(() => settings().get('comparisonPolicies', []).length === before, 'Remove comparison via actual button');
    context.proof('comparison-controls', {invalidEmpty: true, overlapRejected: true, aggregationSelections: 4, aggregationsComputed: false, addRemove: true});
  } finally {
    await settings().update('gitTargets', previousTargets, context.vscode.ConfigurationTarget.WorkspaceFolder);
    await settings().update('comparisonPolicies', previousPolicies, context.vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

async function testCancelGitDiscovery(context){
  const sockets=new Set();let requested=false;
  const server=http.createServer((_request,_response)=>{requested=true;/* Keep a real Git HTTP request pending until Cancel. */});
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let view;
  try{
    view=await designer(context);
    await view.locator('#target-package').selectOption('PerfCheckerNativeFixture');
    await eventually(async()=>!(await view.locator('#target-reference').isDisabled()),'Initial local Git inventory finishes');
    const advanced=view.locator('details').filter({hasText:'Advanced target options'});
    if(await advanced.getAttribute('open')===null)await advanced.locator('summary').click();
    await view.locator('#target-source').fill(`http://127.0.0.1:${server.address().port}/qualification.git`);
    await view.locator('#refresh-targets').click();
    await eventually(()=>requested&&sockets.size>0,'The actual Git process reaches its pending HTTP discovery request',30000);
    await view.locator('#cancel-targets').click();
    await eventually(()=>sockets.size===0,'The native Cancel discovery button terminates Git and closes its real connection',30000);
    await eventually(async()=>!(await view.locator('#cancel-targets').isVisible()),'The cancelled Git scan returns to idle');
    assert.match(await view.locator('#target-error').innerText(),/cancel/i);
    await view.locator('#target-source').fill('');await view.locator('#refresh-targets').click();
    await eventually(async()=>await view.locator('#target-reference optgroup[label="Branches"]').count()>0,'A fresh real local Git discovery works after cancellation');
    context.proof('git-cancel-discovery',{nativeClick:true,actualRemoteGitRequest:true,connectionClosedBeforeHarnessCleanup:true,freshScanSucceeded:true});
  }finally{
    if(view){await view.locator('#cancel-targets').click({timeout:1000}).catch(()=>{});await view.locator('#target-source').fill('').catch(()=>{});}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}

async function testFlameControls(context,view) {
  const graphs=view.locator('.flame-view');assert((await graphs.count())>0);
  for(let index=0;index<await graphs.count();index++){
    const graph=graphs.nth(index),model=JSON.parse(await graph.getAttribute('data-flame'));
    assert.equal(await graph.locator('.flame-node').count(),model.frames.length,
      'Every frame from the actual measured profile model remains in the native SVG');
  }
  const graph=graphs.first(),payload=await graph.getAttribute('data-flame'),model=JSON.parse(payload);
  const svg=graph.locator('svg.flame'),indexInput=graph.getByRole('spinbutton',{name:'Inspect frame',exact:true});
  const expectedGeometry=async()=>{
    const actual=await svg.evaluate(svg=>({width:svg.viewBox.baseVal.width,
      from:Number(svg.dataset.currentMin),to:Number(svg.dataset.currentMax),
      frames:[...svg.querySelectorAll('.flame-node')].map(node=>({index:Number(node.dataset.frameIndex),
        x:Number(node.querySelector('rect').getAttribute('x')),width:Number(node.querySelector('rect').getAttribute('width'))}))}));
    for(const frame of actual.frames){const saved=model.frames[frame.index-1],span=actual.to-actual.from;
      assert(Math.abs(frame.x-(saved.x0-actual.from)*actual.width/span)<1e-8);
      assert(Math.abs(frame.width-(saved.x1-saved.x0)*actual.width/span)<1e-8,
        'Frame width must follow its complete measured weight, without a minimum or decorative subtraction');
    }
    return actual;
  };
  const original=await expectedGeometry();
  const narrow=model.frames.reduce((best,frame)=>frame.x1-frame.x0<best.x1-best.x0?frame:best);
  await indexInput.fill(String(narrow.index));await indexInput.press('Tab');
  const detailId=await graph.getAttribute('data-detail-target'),detail=view.locator(`[id="${detailId}"]`);
  await eventually(async()=>(await detail.innerText()).startsWith(`Frame ${narrow.index} /`),'Native frame index updates the real readout');
  const callPath=[];for(let frame=narrow;frame;frame=frame.parent===null?undefined:model.frames[frame.parent-1])callPath.push(frame.name);
  const text=await detail.innerText();assert(text.includes(callPath.reverse().join(' → ')));
  assert(text.includes(`Inclusive weight: ${narrow.value} ${model.unit}`));
  await graph.getByRole('button',{name:'Zoom in flame graph',exact:true}).click();
  await eventually(async()=>Number(await svg.getAttribute('data-current-max'))-Number(await svg.getAttribute('data-current-min'))<1,'Native flame Zoom narrows only the viewport');
  await expectedGeometry();
  const pan=graph.getByRole('button',{name:'Pan flame graph left',exact:true});
  const otherPan=graph.getByRole('button',{name:'Pan flame graph right',exact:true});
  if(await pan.isEnabled())await pan.click();else await otherPan.click();
  await expectedGeometry();await graph.getByRole('button',{name:'Fit all flame frames',exact:true}).click();
  await eventually(async()=>await svg.getAttribute('data-current-min')==='0'&&await svg.getAttribute('data-current-max')==='1','Native flame Fit restores the complete original range');
  const restored=await expectedGeometry();assert.deepEqual(restored,original);
  await graph.locator('.flame-range summary').click();
  const start=graph.locator('[data-flame-bound="min"]'),end=graph.locator('[data-flame-bound="max"]');
  for(const [input,value]of [[start,'-1'],[end,'101'],[start,'100'],[start,'']]){
    await input.fill(value);await input.press('Tab');
    assert.match(await graph.locator('[role="alert"]').innerText(),/from 0 to 100/);
    assert.deepEqual(await expectedGeometry(),original,'Invalid percentage input must not silently move the viewport');
  }
  await start.fill('90');await start.press('Tab');const beforeReversed=await expectedGeometry();
  await end.fill('10');await end.press('Tab');
  assert.match(await graph.locator('[role="alert"]').innerText(),/from 0 to 100/);
  assert.deepEqual(await expectedGeometry(),beforeReversed,'Reversed user bounds leave the previous valid viewport unchanged');
  await graph.getByRole('button',{name:'Fit all flame frames',exact:true}).click();
  await start.fill('10');await end.fill('90');await end.press('Tab');
  // Normalized bounds may differ by a few floating-point ULPs, never by a displayed percentage.
  const rangeTolerance=Number.EPSILON*8;
  const explicitRange=await eventually(async()=>{
    const actual={from:Number(await svg.getAttribute('data-current-min')),to:Number(await svg.getAttribute('data-current-max')),
      start:await start.inputValue(),end:await end.inputValue()};
    assert(Math.abs(actual.from-.1)<=rangeTolerance&&Math.abs(actual.to-.9)<=rangeTolerance,
      `Expected normalized bounds 0.1–0.9 within ${rangeTolerance}; received ${JSON.stringify(actual)}`);
    assert.equal(actual.start,'10',`Start must be readable: ${JSON.stringify(actual)}`);
    assert.equal(actual.end,'90',`End must be readable: ${JSON.stringify(actual)}`);
    return actual;
  },
    'A valid explicit percentage range changes only the viewport');
  await expectedGeometry();await graph.getByRole('button',{name:'Fit all flame frames',exact:true}).click();
  await graph.locator('.flame-range summary').click();
  assert.equal(await graph.getAttribute('data-flame'),payload,'Flame interaction leaves the measured model byte-exact');
  const labels=await svg.evaluate(svg=>[...svg.querySelectorAll('.flame-node text')].filter(text=>text.style.display!=='none').map(text=>{
    const rect=text.parentElement.querySelector('rect'),left=Number(rect.getAttribute('x')),width=Number(rect.getAttribute('width'));
    return {length:text.getComputedTextLength(),available:Math.min(svg.viewBox.baseVal.width,left+width)-Math.max(0,left)-8};
  }));assert(labels.every(label=>label.length<=label.available+1e-6),'Native frame labels fit their visible weighted rectangle');
  context.proof('native-flame-exact-geometry-and-controls',{graphs:await graphs.count(),frames:model.frames.length,
    inspected:narrow.index,fullCallPath:true,exactWeights:true,noFrameWidthFloor:true,nativeZoomPanFit:true,
    modelSha256:createHash('sha256').update(payload).digest('hex'),fittingLabels:labels.length,invalidPercentageRangesRejected:5,
    explicitPercentageRange:{...explicitRange,normalizedTolerance:rangeTolerance}});
  await testFlamePresentation(context,view,graph);
}

async function testFlamePresentation(context,view,graph){
  assertDisposable(context);
  const themes=context.vscode.extensions.getExtension('vscode.theme-defaults')?.packageJSON.contributes.themes;
  assert(Array.isArray(themes),'Read actual built-in theme contributions from this installed VS Code host');
  const workbench=context.vscode.workspace.getConfiguration('workbench');
  const previousTheme=workbench.inspect('colorTheme')?.globalValue;
  const previousViewport=await context.windowPage.evaluate(()=>({width:innerWidth,height:innerHeight}));
  const audits=[];
  const audit=async()=>{
    const presentation=await graph.locator('svg.flame').evaluate(svg=>({
      editorBackground:getComputedStyle(document.documentElement).backgroundColor,
      cardBackground:getComputedStyle(svg.closest('.flame-card')).backgroundColor,
      labels:[...svg.querySelectorAll('.flame-node text')].filter(text=>getComputedStyle(text).display!=='none').map(text=>{
        const rect=text.parentElement.querySelector('rect'),x=Number(rect.getAttribute('x')),width=Number(rect.getAttribute('width'));
        return {name:text.textContent,foreground:getComputedStyle(text).fill,background:getComputedStyle(rect).fill,
          filter:getComputedStyle(rect).filter,length:text.getComputedTextLength(),available:Math.min(svg.viewBox.baseVal.width,x+width)-Math.max(0,x)-8};
      })}));
    const {labels,editorBackground,cardBackground}=presentation;
    assert(labels.length,'Real native profile labels remain visible');
    const rgba=value=>{const match=/^rgba?\(([^)]+)\)$/.exec(value);assert(match,`Inspect actual computed RGB colors: ${value}`);
      const values=match[1].split(',').map(Number);if(values.length===3)values.push(1);
      assert(values.length===4&&values.every(Number.isFinite)&&values.slice(0,3).every(channel=>channel>=0&&channel<=255)&&values[3]>=0&&values[3]<=1,
        `Inspect finite computed RGBA channels: ${value}`);return values;};
    // Independent source-over arithmetic, rather than the production Canvas color sampler.
    const over=(foreground,background)=>foreground.slice(0,3).map((channel,index)=>channel*foreground[3]+background[index]*(1-foreground[3]));
    const editor=rgba(editorBackground);assert.equal(editor[3],1,`The actual editor supplies an opaque base: ${editorBackground}`);
    const card=over(rgba(cardBackground),editor),palettes=new Map();
    const luminance=channels=>channels.map(channel=>channel/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4)
      .reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
    const contrasts=labels.map(label=>{
      assert(label.length<=label.available+1e-6,`Measured label fits its visible frame: ${label.name}`);
      const brightness=label.filter==='none'?1:Number(/^brightness\(([^)]+)\)$/.exec(label.filter)?.[1]);
      assert(Number.isFinite(brightness),'The audit accounts for the actual native hover/focus brightness');
      const frame=rgba(label.background),backgroundRgb=over([...frame.slice(0,3).map(value=>Math.min(255,value*brightness)),frame[3]],card);
      const foregroundRgb=over(rgba(label.foreground),backgroundRgb),background=luminance(backgroundRgb),foreground=luminance(foregroundRgb);
      const ratio=(Math.max(background,foreground)+.05)/(Math.min(background,foreground)+.05);
      const palette={foreground:label.foreground,frame:label.background,filter:label.filter,editorBackground,cardBackground,
        compositedForeground:foregroundRgb,compositedBackground:backgroundRgb,contrast:ratio};
      assert(ratio>=4.5,`Actual rendered label contrast ${ratio}: ${label.name}; ${JSON.stringify(palette)}`);
      palettes.set(JSON.stringify([label.foreground,label.background,label.filter]),palette);return ratio;
    });
    return {visibleLabels:labels.length,minimumContrast:Math.min(...contrasts),measuredWidthsFit:true,palettes:[...palettes.values()]};
  };
  try{
    for(const [uiTheme,kind,bodyClass]of [['vs',context.vscode.ColorThemeKind.Light,'vscode-light'],['vs-dark',context.vscode.ColorThemeKind.Dark,'vscode-dark']]){
      const candidates=themes.filter(theme=>theme.uiTheme===uiTheme),theme=candidates.find(theme=>/Modern/.test(theme.id))||candidates[0];
      assert(theme?.id,'The installed host provides an actual light and dark theme identifier');
      await workbench.update('colorTheme',theme.id,context.vscode.ConfigurationTarget.Global);
      await eventually(async()=>context.vscode.window.activeColorTheme.kind===kind&&await view.locator('body').evaluate((body,name)=>body.classList.contains(name),bodyClass),
        `The real webview receives the ${theme.id} theme`);
      await eventually(audit,'The rendered flame labels update their actual contrast after the theme changes');
      const desktop=await audit();
      await graph.locator('.flame-node').first().focus();const focused=await audit();
      await graph.locator('.flame-node').first().hover();const hovered=await audit();
      const commands=await context.vscode.commands.getCommands(true);
      for(const command of ['workbench.action.closeSidebar','workbench.action.closeAuxiliaryBar','workbench.action.closePanel']){
        if(commands.includes(command))await context.vscode.commands.executeCommand(command);
      }
      await context.windowPage.setViewportSize({width:390,height:844});
      await eventually(async()=>await view.evaluate(()=>innerWidth)<=390,'The actual webview adopts the narrow workbench viewport');
      const geometry=await graph.evaluate(node=>({viewport:innerWidth,width:node.getBoundingClientRect().width,
        scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,
        buttons:[...node.querySelectorAll('.flame-toolbar button')].map(button=>({label:button.getAttribute('aria-label'),height:button.getBoundingClientRect().height}))}));
      assert(geometry.width>=230&&geometry.width<=390,'The narrow qualification uses a readable editor after hiding disposable side panels');assert(geometry.scrollWidth<=geometry.clientWidth);
      assert(geometry.buttons.every(button=>button.height>=44),'The narrow native flame controls retain touch-sized targets');
      const mobile=await audit();
      await graph.getByRole('button',{name:'Zoom in flame graph',exact:true}).click();
      await graph.getByRole('button',{name:'Fit all flame frames',exact:true}).click();
      await graph.locator('.flame-toolbar').scrollIntoViewIfNeeded();
      await capture(context,`flame-mobile-${uiTheme}-controls`);
      await graph.locator('.flame-detail').scrollIntoViewIfNeeded();
      await capture(context,`flame-mobile-${uiTheme}-readout`);
      audits.push({theme:theme.id,desktop,focused,hovered,mobile,geometry});
      await context.windowPage.setViewportSize(previousViewport);
    }
    context.proof('native-flame-theme-and-mobile-presentation',{source:'actual-installed-VSIX-and-built-in-VSCode-themes',audits});
  }finally{
    await context.windowPage.setViewportSize(previousViewport);
    await workbench.update('colorTheme',previousTheme,context.vscode.ConfigurationTarget.Global);
  }
}

async function testResults(context) {
  const commands=await context.vscode.commands.getCommands(true);
  if(commands.includes('workbench.action.closePanel'))await context.vscode.commands.executeCommand('workbench.action.closePanel');
  let view = await output(context);
  assert.match(await view.locator('body').innerText(), /PERFCHECKER OUTPUT/);
  assert.equal(await view.locator('.empty').count(), 0, 'Real suite measurements were supplied to the installed VSIX');
  const total = await view.locator('[data-result-item]').count(); assert(total > 0);
  for (const id of ['package', 'workload', 'backend', 'kind', 'status']) {
    for (const option of await options(view, `#result-${id}`)) {
      const expected=await view.locator('[data-result-item]').evaluateAll((items,{id,value})=>items.filter(item=>item.dataset[id]===value).length,{id,value:option.value});
      await view.locator(`#result-${id}`).selectOption(option.value);
      const visible = view.locator('[data-result-item]:visible');
      assert.equal(await visible.count(),expected,`The ${id}=${option.value} filter shows exactly the matching real results, including an empty status`);
      assert(await visible.evaluateAll((items, {id, value}) => items.every(item => item.dataset[id] === value), {id, value: option.value}));
    }
    await view.locator(`#result-${id}`).selectOption('');
  }
  const resultGroups=()=>view.locator('.result-list,.chart-grid,.flame-grid,tbody').evaluateAll(containers=>containers.map(container=>
    [...container.children].filter(item=>item.matches('[data-result-item]')).map(item=>({kind:item.dataset.kind,package:item.dataset.package,
      workload:item.dataset.workload,backend:item.dataset.backend,version:item.dataset.version,status:item.dataset.status,search:item.dataset.search}))));
  const originalGroups=await resultGroups(),inventory=groups=>groups.map(items=>items.map(item=>JSON.stringify(item)).sort());
  assert(originalGroups.some(items=>items.length>=2),'The real Results fixture contains a group with multiple sortable entries');
  let previousResults=originalGroups,observedResultSortChange=false;
  for (const sort of await options(view, '#result-sort')) {
    await view.locator('#result-sort').selectOption(sort.value);
    const key=sort.value==='name'?'search':sort.value;
    await eventually(async()=>{
      const groups=await resultGroups();
      return JSON.stringify(inventory(groups))===JSON.stringify(inventory(originalGroups))&&groups.every(items=>items.every((item,index)=>index===0||
        (items[index-1][key]||'').localeCompare(item[key]||'',undefined,{numeric:true})<=0));
    },`Each actual Results group follows ${sort.text} order`);
    const groups=await resultGroups(),changed=JSON.stringify(groups)!==JSON.stringify(previousResults);
    observedResultSortChange||=changed;
    context.log('native-results-sort-effect',{sort:sort.value,renderedGroups:groups,inventoryPreserved:true,orderChanged:changed,
      discriminatingGroups:groups.filter(items=>items.length>=2&&new Set(items.map(item=>item[key])).size>=2).length,
      limit:changed?null:'Rendered order and inventory verified; no change from the preceding order observed'});
    previousResults=groups;
  }
  assert(observedResultSortChange,'At least one discriminating Results sort gesture changes a rendered group order');
  await view.locator('#result-search').fill('there-is-no-matching-native-result');
  assert.equal(await view.locator('[data-result-item]:visible').count(), 0);
  await view.locator('#result-search').fill(''); assert.equal(await view.locator('[data-result-item]').count(), total);
  const chartFamilies = {};
  for (const [name, selector] of Object.entries({distribution: '.distribution .sample', allocation: '.pie-slice', normalized: '.normalized-chart .hover-value', flame: '.flame-node', series: '.spark .hover-value'})) {
    const points = view.locator(selector); const count = await points.count(); chartFamilies[name] = count;
    if (!count) {context.log(`plot-prerequisite-${name}`, 'No corresponding observations in this real run; collector fixture must qualify this family separately'); continue;}
    const point = points.first(); await point.focus();
    const target = await point.getAttribute('data-target');
    if (target) assert((await view.locator(`[id="${target}"]`).innerText()).trim(), `${name} keyboard focus shows its evidence`);
  }
  assert(chartFamilies.flame>0,'The actual profile reports render nonempty, focusable flame frames');
  await testFlameControls(context,view);
  const overlay=view.locator('.normalized-plot').first();
  assert.equal(await overlay.count(),1,'Measured version series supplies the real comparison controls');
  const seriesFile=path.join(context.results,'version-series.json'),seriesBytes=await fs.readFile(seriesFile);
  const payload=await overlay.getAttribute('data-normalized'),data=JSON.parse(payload);
  const inspected=overlay.locator('.normalized-chart .hover-value').first();
  const metric=await inspected.getAttribute('data-metric'),detailTarget=await inspected.getAttribute('data-target');
  const beforeCount=await overlay.locator('.normalized-chart .hover-value').count();assert(beforeCount>0);
  await inspected.focus();assert.match(await view.locator(`[id="${detailTarget}"]`).innerText(),/ratio/);
  await overlay.locator(`[data-normalized-metric="${metric}"]`).uncheck();
  assert.equal(await overlay.locator(`[data-metric="${metric}"]`).count(),0);
  assert.match(await view.locator(`[id="${detailTarget}"]`).innerText(),/^Hover or focus/);
  await overlay.getByRole('button',{name:'Reset chart',exact:true}).click();
  assert.equal(await overlay.locator('.normalized-chart .hover-value').count(),beforeCount);
  const retained=await overlay.locator('.normalized-chart .hover-value').evaluateAll((points,versions)=>{
    const point=points.find(point=>versions.indexOf(point.dataset.version)>0);
    return point&&{version:point.dataset.version,metric:point.dataset.metric,y:point.getAttribute('cy'),detail:point.dataset.detail};
  },data.versions);
  assert(retained,'The actual measured series has a finite point beyond its first version');
  const index=String(data.versions.indexOf(retained.version));
  await overlay.locator('[data-normalized-from]').selectOption(index);await overlay.locator('[data-normalized-to]').selectOption(index);
  const filtered=await overlay.locator('.normalized-chart .hover-value').evaluateAll(points=>points.map(point=>({
    version:point.dataset.version,metric:point.dataset.metric,y:point.getAttribute('cy'),detail:point.dataset.detail,
  })));
  assert(filtered.length>0&&filtered.every(point=>point.version===retained.version));
  assert.deepEqual(filtered.find(point=>point.metric===retained.metric),retained,'View filtering preserves the original ratio, raw value and Y');
  assert.equal(await overlay.getAttribute('data-normalized'),payload);
  await overlay.getByRole('button',{name:'Reset chart',exact:true}).click();
  assert.equal(await overlay.locator('[data-normalized-from]').inputValue(),'0');
  assert.equal(await overlay.locator('[data-normalized-to]').inputValue(),String(data.versions.length-1));
  assert.equal(await overlay.locator('.normalized-chart .hover-value').count(),beforeCount);
  assert.match(await view.locator(`[id="${detailTarget}"]`).innerText(),/^Hover or focus/);
  assert.deepEqual(await fs.readFile(seriesFile),seriesBytes,'Comparison gestures do not rewrite measured reports');
  context.proof('native-results-comparison-controls',{actualMeasuredVersions:data.versions.length,visibleMetrics:data.metrics.length,
    metricCheckbox:true,measuredVersionRange:true,reset:true,staleReadoutCleared:true,
    fixedYAndOriginalRatioPreserved:true,measurementFileUnchanged:true});
  context.proof('result-controls', {items: total, filters: 7, chartFamilies});
  const chart=view.locator('.normalized-chart,.distribution,.spark').first();
  if(await chart.count())await chart.scrollIntoViewIfNeeded();
  await capture(context,'measured-results');
  for (const [name, report] of [['Summary', 'suite-report.md'], ['JSON', 'suite-result.json'], ['Comparisons', 'version-comparison.md'], ['Series JSON', 'version-series.json']]) {
    view = await output(context);
    await view.getByRole('button', {name, exact: true}).click();
    const file = path.join(context.results, report);
    const exists = await fs.access(file).then(() => true, () => false);
    if (exists) await eventually(() => context.vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      tab.input?.uri?.fsPath === context.vscode.Uri.file(file).fsPath || (report.endsWith('.md') && tab.label.includes(report)))), `Open actual ${report}`);
    else await eventually(async () => (await context.windowPage.locator('body').innerText()).includes(`PerfChecker has not produced ${report} yet.`), `Missing ${report} explains its prerequisite`);
    context.log(`result-report-${name}`, {exists, openedOrExplained: true});
  }
}

async function testComputedAggregations(context){
  const uri=context.vscode.Uri.file(context.workspace);
  const settings=()=>context.vscode.workspace.getConfiguration('perfchecker',uri);
  const previous={reports:settings().inspect('reports')?.workspaceFolderValue,policies:settings().inspect('comparisonPolicies')?.workspaceFolderValue};
  const configFile=path.resolve(context.workspace,settings().get('uiConfiguration','perf/perfchecker-ui.json'));
  const saved=await fs.readFile(configFile).catch(()=>undefined);
  const baselines=['0.5.0','0.5.3','0.5.4'],candidate='0.5.5';
  try{
    for(const aggregation of ['median','mean','minimum','maximum']){
      await settings().update('comparisonPolicies',[],context.vscode.ConfigurationTarget.WorkspaceFolder);
      const reports=path.join(context.workspace,'perf','results','aggregations',aggregation);
      await settings().update('reports',reports,context.vscode.ConfigurationTarget.WorkspaceFolder);
      let view=await designer(context);
      await view.locator('#comparison-package').selectOption('Example');
      await view.locator('#comparison-feature').selectOption('hello');
      for(const input of await view.locator('#baseline-targets input,#candidate-targets input').all())await input.uncheck();
      for(const version of baselines)await view.locator(`#baseline-targets input[value="${version}"]`).check();
      await view.locator(`#candidate-targets input[value="${candidate}"]`).check();
      await view.locator('#comparison-aggregation').selectOption(aggregation);
      await view.locator('#add-comparison').click();
      await eventually(()=>settings().get('comparisonPolicies',[]).length===1,`The native ${aggregation} comparison policy is persisted`);
      await eventually(async()=>!(await view.locator('#run').isDisabled()),'The policy replan finishes',120000);
      await view.locator('#reset-filters').click();await view.locator('#clear-all').click();
      await view.locator('#package').selectOption('Example');await view.locator('#select-visible').click();
      assert.equal(await selectionCount(view),4,'Three registered references and a registered candidate are really measured');
      await view.locator('#open-after-run').uncheck();context.log('native-ui-action',{surface:'Suite designer',action:'Run comparison',aggregation});await view.locator('#run').click();
      const comparison=await eventually(async()=>{
        const suite=JSON.parse(await fs.readFile(path.join(reports,'suite-result.json'),'utf8'));
        if(suite.runs.length!==4)return false;
        assert(suite.runs.every(run=>run.status==='pass'&&run.qualification.correctness.status==='passed'));
        return JSON.parse(await fs.readFile(path.join(reports,'version-comparison.json'),'utf8'));
      },`Actual benchmark reports complete for ${aggregation}`,360000);
      await eventually(async()=>!(await view.locator('#run').isDisabled()),'The measured comparison returns to idle');
      const records=comparison.records.filter(record=>record.package==='Example'&&record.candidate_version===candidate);
      assert(records.length>0,'The measured policy produces comparisons, rather than merely saving an option');
      for(const record of records){
        assert.deepEqual(record.baseline_versions,baselines);
        const series=comparison.series.find(series=>series.series_id===record.series_id);assert(series);
        const values=baselines.map(version=>{
          const point=series.points.find(point=>point.version===version);assert(point);
          return point.statistics?.[record.sample_statistic]??point.median;
        });
        assert(values.every(Number.isFinite));
        const sorted=[...values].sort((a,b)=>a-b);
        const expected=aggregation==='minimum'?sorted[0]:aggregation==='maximum'?sorted.at(-1):aggregation==='mean'?values.reduce((a,b)=>a+b,0)/values.length:sorted[1];
        assert(Math.abs(record.baseline_value-expected)<=Math.max(1,Math.abs(expected))*1e-12,`${aggregation} is computed from those real reference measurements`);
      }
      context.proof('computed-reference-aggregation',{aggregation,nativeAddAndRunClicks:true,baselines,candidate,measuredRuns:4,records:records.length,report:path.relative(context.workspace,path.join(reports,'version-comparison.json'))});
    }
  }finally{
    if(saved)await fs.writeFile(configFile,saved);else await fs.rm(configFile,{force:true});
    await settings().update('reports',previous.reports,context.vscode.ConfigurationTarget.WorkspaceFolder);
    await settings().update('comparisonPolicies',previous.policies,context.vscode.ConfigurationTarget.WorkspaceFolder);
    await context.vscode.commands.executeCommand('perfchecker.openDesignerForWorkspace',uri);
  }
}

async function testAdvisorAndTools(context) {
  await clickStudioAction(context, 'advisor');
  let view = await frame(context, '#advisor-root');
  for (const mode of ['none', 'ollama', 'chat_completions', 'chat_completions_schema', 'mcp_http']) {
    await view.locator('#advisor-protocol').selectOption(mode);
    assert.equal(await view.getByRole('button', {name: 'Test connection / discover', exact: true}).isDisabled(), mode === 'none');
    assert.equal(await view.locator('#advisor-mcp_tool').isVisible(), mode === 'mcp_http');
    assert.equal(await view.locator('#advisor-download-model').isVisible(), mode === 'ollama');
  }
  await view.locator('#advisor-mcp_arguments').fill('{ invalid JSON');
  await view.getByRole('button', {name: 'Save configuration', exact: true}).click();
  assert.match(await view.locator('[role="status"]').innerText(), /JSON|property|Unexpected/i);
  await view.locator('#advisor-mcp_arguments').fill('{}');
  await view.locator('#advisor-investigates').check();
  assert(await view.locator('#advisor-max_experiments').isVisible());
  await view.getByRole('button', {name: 'Save configuration', exact: true}).click();
  assert.match(await view.locator('[role="status"]').innerText(), /structured response/);
  await view.locator('#advisor-investigates').uncheck();
  assert(await view.getByRole('button', {name: 'Cancel operation', exact: true}).isDisabled());
  context.proof('provider-controls', {modes: 5, malformedArgumentsRejected: true, textInvestigationRejected: true, noNetworkRequest: true});

  await clickStudioAction(context, 'tools');
  view = await frame(context, '#app');
  await view.getByRole('button', {name: 'Findings & advice', exact: true}).click();
  await view.getByRole('heading', {name: 'Tool catalogue', exact: true}).waitFor({timeout: 120000});
  const search = view.getByRole('searchbox', {name: 'Search tool catalogue'});
  await search.fill('nonexistent-native-catalogue-tool');
  const catalogueContainer = search.locator('..');
  assert.equal(await catalogueContainer.locator('article.card').count(), 0);
  await search.fill(''); assert((await catalogueContainer.locator('article.card').count()) > 0);
  for (const tab of ['Scenarios', 'Findings & advice', 'Before / after', 'Saved evidence']) {
    await view.getByRole('button', {name: tab, exact: true}).click();
    assert.equal(await view.getByRole('button', {name: tab, exact: true}).getAttribute('aria-current'), 'page');
  }
  await view.getByRole('button', {name: 'Worker log', exact: true}).click();
  context.proof('native-tool-catalogue', {backend: context.core, filter: true, investigationTabs: 4, workerLog: true});
}

async function testSavePalette(context) {
  const view = await designer(context);
  const {destination} = await savedConfiguration(context, view);
  assert((await fs.stat(destination)).size > 0, 'Editor Save works before testing the independent palette command');
  const title = `Unsaved palette qualification ${Date.now()}`;
  await view.locator('#doc-title').fill(title);
  await view.locator('#cards .card .check-option input').first().uncheck();
  const count = await selectionCount(view);
  await view.locator('#cards .card .label').first().evaluate(input => {
    input.value = '#a12655'; input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await assert.doesNotReject(context.vscode.commands.executeCommand('perfchecker.saveConfiguration'),
    'The contributed Save shared UI configuration command must save the open editor instead of rejecting a missing internal payload');
  const saved = JSON.parse(await fs.readFile(destination, 'utf8'));
  assert.equal(saved.documentation.blocks[0].title, title);
  assert.equal(saved.selection.run_ids.length, count);
  assert(Object.values(saved.selection.labels).includes('#a12655'));
  context.proof('save-palette-command', {native: true, unsavedTitleSelectionColor: true, destination});
}

async function testLargePlanAndOrdering(context) {
  const uri=context.vscode.Uri.file(context.workspace);
  const settings=()=>context.vscode.workspace.getConfiguration('perfchecker',uri);
  const previous=settings().inspect('suite')?.workspaceFolderValue;
  const configFile=path.resolve(context.workspace,settings().get('uiConfiguration','perf/perfchecker-ui.json'));
  const saved=await fs.readFile(configFile).catch(()=>undefined);
  try{
    await fs.rm(configFile,{force:true});
    await settings().update('suite','perf/large-suite.jl',context.vscode.ConfigurationTarget.WorkspaceFolder);
    await context.vscode.commands.executeCommand('perfchecker.refresh');
    await context.vscode.commands.executeCommand('perfchecker.openDesignerForWorkspace',uri);
    let view=await frame(context,'#cards');
    await eventually(async()=>/Showing 120 of 125 workload groups/.test(await view.locator('#rendered-count').innerText()),'The real large plan paginates 125 workload groups',120000);
    assert.equal(await view.locator('#cards .card').count(),120);
    await view.locator('#reset-filters').click();
    await view.locator('#select-visible').click();
    assert.equal(await selectionCount(view),125,'Bulk selection includes the five groups not rendered yet');
    await view.locator('#show-more').click();
    assert.equal(await view.locator('#cards .card').count(),125);
    assert(!await view.locator('#show-more').isVisible());
    await view.locator('#sort').selectOption('suite');
    const before=await savedConfiguration(context,view);
    const first=before.config.selection.run_ids[0];
    // Start on the workload title rather than a checkbox/color input in the card's
    // center. Retain observed native drag events to distinguish routing from order.
    await view.locator('#cards').evaluate(element=>{
      element.nativeDragEvents=[];
      for(const type of ['pointerdown','mousedown','dragstart','dragover','drop','dragend'])element.addEventListener(type,event=>{
        if(element.nativeDragEvents.length<40)element.nativeDragEvents.push({type,id:event.target.closest('.card')?.dataset.id,target:event.target.tagName,
          x:event.clientX,y:event.clientY,data:event.dataTransfer?.getData('text/plain')});
      });
    });
    await view.locator('#cards .card').first().locator('.feature-heading strong').dragTo(view.locator('#cards .card').nth(2).locator('.feature-heading strong'));
    const initialEvents=await view.locator('#cards').evaluate(element=>element.nativeDragEvents);
    context.log('large-plan-title-drag-events',{events:initialEvents});
    if(!initialEvents.some(event=>event.type==='drop')){
      // Electron's nested webview may not deliver Playwright's dragTo gesture.
      // Move the real workbench mouse across visible draggable card borders;
      // never synthesize DragEvents, DataTransfer, configuration or postMessage.
      const source=view.locator('#cards .card').first(),target=view.locator('#cards .card').nth(2);
      await source.evaluate(element=>element.scrollIntoView({block:'start'}));
      const from=await source.boundingBox(),to=await target.boundingBox();
      assert(from&&to,'Both native draggable cards have real screen coordinates');
      context.log('large-plan-pointer-drag-coordinates',{from,to,viewport:context.windowPage.viewportSize(),
        dom:await view.locator('#cards .card').evaluateAll(cards=>cards.slice(0,3).map(card=>({id:card.dataset.id,draggable:card.draggable,
          title:card.querySelector('strong')?.textContent,rect:card.getBoundingClientRect().toJSON()})))});
      await context.windowPage.mouse.move(from.x+4,from.y+8);
      await context.windowPage.mouse.down();
      try{
        await context.windowPage.mouse.move(from.x+20,from.y+12,{steps:5});
        await context.windowPage.mouse.move(to.x+16,to.y+20,{steps:20});
        await context.windowPage.mouse.move(to.x+20,to.y+24,{steps:3});
      }finally{await context.windowPage.mouse.up();}
    }
    const after=await savedConfiguration(context,view);
    const events=await view.locator('#cards').evaluate(element=>element.nativeDragEvents);
    context.log('large-plan-native-drag-observation',{events,before:before.config.selection.run_ids.slice(0,4),after:after.config.selection.run_ids.slice(0,4)});
    assert(events.some(event=>event.type==='dragstart')&&events.some(event=>event.type==='drop'),'The real webview receives native dragstart and drop before checking order');
    assert.notEqual(after.config.selection.run_ids[0],first,'Native drag changes the persisted execution order');
    assert.deepEqual(new Set(after.config.selection.run_ids),new Set(before.config.selection.run_ids));
    await view.locator('#search').fill('workload_125');
    await eventually(async()=>await view.locator('#cards .card').count()===1,'The debounced workload search has rendered the one matching group');
    await view.locator('#clear-visible').click();
    await eventually(async()=>await selectionCount(view)===124,'Clearing the one filtered group preserves all124hidden selections');
    context.proof('large-plan-pagination-and-drag',{groups:125,initiallyRendered:120,bulkIncludesHidden:true,nativeDrag:true,executionsRequested:0});
  }catch(error){
    const view=await frame(context,'#cards');
    context.log('large-plan-before-restore-failure',{message:String(error),rendered:await view.locator('#cards .card').count(),
      state:await view.locator('#cards').evaluate(element=>({events:element.nativeDragEvents,cards:[...element.children].slice(0,4).map(card=>({id:card.dataset.id,draggable:card.draggable,text:card.querySelector('strong')?.textContent}))}))});
    await capture(context,'large-plan-before-restore-failure');
    throw error;
  }finally{
    if(saved)await fs.writeFile(configFile,saved);else await fs.rm(configFile,{force:true});
    await settings().update('suite',previous,context.vscode.ConfigurationTarget.WorkspaceFolder);
    await context.vscode.commands.executeCommand('perfchecker.refresh');
    await context.vscode.commands.executeCommand('perfchecker.openDesignerForWorkspace',uri);
    const view=await frame(context,'#cards');
    await eventually(async()=>!(await view.locator('#show-more').isVisible())&&!/workload_125/.test(await view.locator('#cards').innerText()),'Restore the real measurement suite after plan-only pagination',120000);
  }
}

exports.runOrdering = async context => {
  assertDisposable(context);
  await designer(context);
  await testLargePlanAndOrdering(context);
};

exports.runColour = async context => {
  assertDisposable(context);
  assert.equal(process.platform,'linux','The real colour-picker gesture is scoped to Linux/X11');
  assert(process.env.DISPLAY&&process.env.PERFCHECKER_NATIVE_PHASE==='studio-color',
    'Use only the separately selected disposable Xvfb colour campaign');
  const {execFile}=require('node:child_process'),{promisify}=require('node:util');
  const execute=promisify(execFile),xdotool=process.env.PERFCHECKER_TEST_XDOTOOL||'xdotool';
  const native=async args=>(await execute(xdotool,args,{timeout:10000})).stdout.trim();
  const windows=async()=>{
    const {stdout}=await execute('xwininfo',['-root','-tree'],{timeout:10000});
    return stdout.split('\n').flatMap(line=>{
      const match=/^\s+(0x[\da-f]+).*?\s(\d+)x(\d+)[+-]\d+[+-]\d+\s+([+-]\d+)([+-]\d+)\s*$/i.exec(line);
      return match?[{id:match[1],width:Number(match[2]),height:Number(match[3]),x:Number(match[4]),y:Number(match[5])}]:[];
    });
  };
  let view=await designer(context);await resetDesigner(view);
  const before=await savedConfiguration(context,view);
  const planFile=path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage',
    'mirage-interactive-fr.perfchecker-vscode','suite-plan.json');
  const planBytes=await fs.readFile(planFile),plan=JSON.parse(planBytes);
  const group=view.locator('#cards .card').first(),leader=await group.getAttribute('data-id');
  const first=plan.runs.find(run=>run.id===leader);assert(first,'The visible group belongs to the real controller plan');
  const ids=plan.runs.filter(run=>run.package===first.package&&run.workload===first.workload&&run.version===first.version).map(run=>run.id);
  assert(ids.length>1,'The picker labels a real group of multiple checks');
  const colours=async()=>view.locator('#cards .card').evaluateAll(cards=>cards.map(card=>({id:card.dataset.id,
    colour:card.querySelector('input.label').value,border:getComputedStyle(card).borderLeftColor})));
  const idle=async()=>view.evaluate(()=>({controls:Object.fromEntries(['run','refresh','save','add-target','add-comparison']
    .map(id=>[id,document.getElementById(id).disabled])),progressHidden:document.getElementById('progress').hidden,
    cards:[...document.querySelectorAll('#cards .card')].map(card=>card.dataset.id),checkTypes:document.querySelectorAll('#check-types label').length}));
  const captureGroup=async name=>{
    await context.vscode.commands.executeCommand('workbench.action.closePanel');
    await view.locator(`#cards .card[data-id="${leader}"]`).scrollIntoViewIfNeeded();
    await capture(context,name);
  };
  await context.vscode.commands.executeCommand('workbench.action.closePanel');
  await group.locator('input.label').scrollIntoViewIfNeeded();
  const previous=await eventually(async()=>{
    const cards=await colours();assert(cards.length>0,'The real plan has visible groups');
    for(const card of cards){
      assert.match(card.colour,/^#[a-f0-9]{6}$/i);
      const rgb=[1,3,5].map(offset=>parseInt(card.colour.slice(offset,offset+2),16));
      assert.equal(card.border,`rgb(${rgb.join(', ')})`,'Every initial group border renders its actual colour');
    }
    return cards;
  },'The real initial group borders are ready before the colour gesture');
  context.log('native-colour-initial-borders',{cards:previous});
  const windowIds=new Set((await windows()).map(window=>window.id));
  context.log('native-ui-action',{surface:'Suite designer',action:'Open real colour picker'});
  await group.locator('input.label').click();
  const popup=await eventually(async()=>{
    const opened=(await windows()).filter(window=>!windowIds.has(window.id)&&window.width>=220&&window.width<=260&&window.height>=240&&window.height<=280);
    return opened.length===1&&opened[0];
  },'The trusted colour click creates its actual X11 picker popup',10000);
  const output=process.env.PERFCHECKER_NATIVE_OUTPUT,temporary=path.join(output,'native-colour-popup.xwd');
  const image=path.join(output,`native-${process.platform}-vscode-${context.vscode.version}-colour-picker.png`);
  let painted;
  try{await eventually(async()=>{
      await execute('xwd',['-screen','-id',popup.id,'-silent','-out',temporary],{timeout:10000});
      await execute('convert',[temporary,image],{timeout:10000});
      painted=Number((await execute('identify',['-format','%k',image],{timeout:10000})).stdout.trim());
      return painted>20;
    },'The actual OS picker is painted before its review capture',10000);}
  finally{await fs.rm(temporary,{force:true});}
  context.log('native-colour-picker-before-input',{popup,paintedColors:painted,file:path.basename(image),
    sha256:createHash('sha256').update(await fs.readFile(image)).digest('hex')});
  // Click the actual RGB field in the native popup, then use real X11 keys.
  // The prepared Chromium probe demonstrates this layout; VSIX assertions
  // below independently require the chosen colour and all persisted effects.
  await native(['mousemove','--window',popup.id,'50',String(popup.height-52),'click','1']);
  for(const [index,value]of ['18','102','170'].entries()){
    if(index)await native(['key','--clearmodifiers','Tab']);
    await native(['key','--clearmodifiers','ctrl+a']);
    await native(['type','--clearmodifiers',value]);
  }
  await native(['key','--clearmodifiers','Return']);
  await eventually(async()=>!(await windows()).some(window=>window.id===popup.id),'Return dismisses the real colour picker',10000);
  const verify=async()=>{
    const current=await colours(),changed=current.find(card=>card.id===leader);
    assert.equal(changed.colour,'#1266aa');assert.equal(changed.border,'rgb(18, 102, 170)');
    assert.deepEqual(current.filter(card=>card.id!==leader),previous.filter(card=>card.id!==leader),
      'Other visible groups retain exactly their previous colours');
  };
  await eventually(async()=>{await verify();return true;},'The real picker updates the visible group border');
  await captureGroup('native-colour-group-border');
  const after=await savedConfiguration(context,view);
  assert.deepEqual(after.config.selection.run_ids,before.config.selection.run_ids,'Colouring preserves exact selection and execution order');
  assert.deepEqual(after.config.selection.labels,{...before.config.selection.labels,...Object.fromEntries(ids.map(id=>[id,'#1266aa']))},
    'Every real run of this group gets the colour and no other label changes');
  const command='workbench.action.webview.reloadWebviewAction';
  assert((await context.vscode.commands.getCommands(true)).includes(command),'The actual VS Code reload-webviews command is available');
  const beforeReload=await eventually(async()=>{
    const state=await idle();assert(Object.values(state.controls).every(disabled=>!disabled));assert(state.progressHidden);return state;
  },'The saved real Designer is idle before its official reload');
  const beforeLaunches=await controllerLaunches(),beforePlan=await fs.stat(planFile,{bigint:true});
  assert(beforeLaunches.some(item=>item.commands.length),'Controller launch commands are present before comparing the real log');
  await context.vscode.commands.executeCommand(command);
  view=await frame(context,'#cards');
  await eventually(async()=>{await verify();return true;},'A real webview reload restores the saved group colour');
  await eventually(async()=>{assert.deepEqual(await idle(),beforeReload);return true;},'Official reload restores the exact real card inventory, check types and idle controls');
  const reloaded=await savedConfiguration(context,view);
  assert.deepEqual(reloaded.config.selection,after.config.selection,'Reload preserves exact labels, selected IDs and order');
  await eventually(async()=>{assert.deepEqual(await idle(),beforeReload);return true;},'Saving after reload returns the real Designer to its idle state');
  await captureGroup('native-colour-reloaded-border');
  assert.deepEqual(await fs.readFile(planFile),planBytes,'Official reload keeps the exact canonical controller plan bytes');
  assert.equal((await fs.stat(planFile,{bigint:true})).mtimeNs,beforePlan.mtimeNs,'Reload does not regenerate the real controller plan');
  const afterLaunches=await controllerLaunches();assert.deepEqual(afterLaunches,beforeLaunches,'Official reload and configuration save launch no additional Julia controller');
  context.log('native-designer-idle-reload',{command,planSha256:createHash('sha256').update(planBytes).digest('hex'),
    planRuns:plan.runs.length,planUnchanged:true,planMtimeUnchanged:true,before:beforeReload,after:await idle(),
    controllerLaunches:beforeLaunches.reduce((sum,item)=>sum+item.commands.length,0),noAdditionalControllerLaunch:true,
    scope:'Real native idle reload; active busy hydration is qualified separately'});
  context.proof('native-colour-picker-save-reload',{colour:'#1266aa',groupRunIds:ids,nativeX11ClickAndKeys:true,
    actualPopup:true,visibleBorderVerified:true,exactOtherLabelsPreserved:true,exactSelectionPreserved:true,
    savedAndReloaded:true,scope:'Linux stable isolated Xvfb; group/card labels only'});
};

exports.runSelection = async context => {
  assertDisposable(context);
  let view = await designer(context);
  await view.locator('#results').click();
  const empty = await frame(context, 'button[data-report="suite-result.json"]');
  assert.match(await empty.locator('.empty').innerText(), /No persisted output yet/);
  context.log('empty-result-controls', {native: true, noFabricatedEvidence: true});
  view = await designer(context);
  await view.locator('#reset-filters').click();
  await view.locator('#clear-all').click();
  const ready = view.locator('.check-option.ready').filter({hasText: 'BenchmarkTools'}).first();
  assert.equal(await ready.count(), 1, 'A real runnable benchmark is in the fixture');
  await ready.locator('input').check();
  assert.equal(await selectionCount(view), 1, 'The Run button receives exactly one selected run');
  await view.locator('#open-after-run').uncheck();
  const settings = context.vscode.workspace.getConfiguration('perfchecker', context.vscode.Uri.file(context.workspace));
  const reports = path.resolve(context.workspace, settings.get('reports', 'perf/results/vscode'));
  const reportPath = path.join(reports, 'suite-result.json');
  const old = await fs.readFile(reportPath, 'utf8').catch(() => undefined);
  const saved=await savedConfiguration(context,view);
  assert.equal(saved.config.selection.run_ids.length,1,'The actual run selection and order are saved before reloading its working panel');
  const planFile=path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','suite-plan.json');
  const planBytes=await fs.readFile(planFile),planStat=await fs.stat(planFile,{bigint:true});
  const state=async()=>view.evaluate(()=>({controls:Object.fromEntries(['run','refresh','save','add-target','add-comparison']
    .map(id=>[id,document.getElementById(id).disabled])),inventory:[...document.querySelectorAll('#cards .card')].map(card=>({id:card.dataset.id,
      colour:card.querySelector('input.label').value,checks:[...card.querySelectorAll('.check-option')].map(check=>({name:check.querySelector('.check-name').textContent,selected:check.querySelector('input').checked}))})),
    count:document.getElementById('count').textContent,sort:document.getElementById('sort').value,openAfterRun:document.getElementById('open-after-run').checked}));
  await eventually(async()=>Object.values((await state()).controls).every(disabled=>!disabled),'The saved real run panel returns to idle before launching');
  const idleState=await state(),beforeLaunches=await controllerLaunches();
  const launchCount=entries=>entries.reduce((sum,item)=>sum+item.commands.length,0);
  context.log('native-ui-action',{surface:'Suite designer',action:'Run selected check'});
  await view.locator('#run').click();
  const freshReport=async()=>{
    try{const text=await fs.readFile(reportPath,'utf8');if(text===old)return false;const value=JSON.parse(text);
      return value.schema_version==='perfchecker-suite-result/1'&&value.runs.length===1&&value.runs[0].status==='pass'&&value;
    }catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return false;throw error;}
  };
  const active=await eventually(async()=>{
    const worker=await nativeSuiteWorker(context),snapshot=await state();
    if(worker&&Object.values(snapshot.controls).every(Boolean))return {worker,snapshot};
    if(await freshReport())return {finished:true};return false;
  },'The existing selected suite has an owned active controller and busy controls, or completes with fresh real evidence',30000);
  const runningLaunches=await eventually(async()=>{
    const value=await controllerLaunches();return launchCount(value)===launchCount(beforeLaunches)+1&&value;
  },'The real output log witnesses exactly the intended suite launch');
  const reload='workbench.action.webview.reloadWebviewAction';
  await context.vscode.commands.executeCommand(reload);
  view=await frame(context,'#cards');
  let activeBusyHydrationQualified=false;
  await eventually(async()=>{
    const worker=await nativeSuiteWorker(context),snapshot=await state();
    if(worker&&active.worker){
      assert.deepEqual(worker,active.worker,'The reloaded panel keeps the same actual owned Julia controller identity');
      assert.deepEqual(snapshot,active.snapshot);activeBusyHydrationQualified=true;return true;
    }
    if(await freshReport()){
      assert.deepEqual(snapshot,idleState,'A run that naturally finishes during reload restores its exact idle controls and inventory');return true;
    }
    return false;
  },'Official reload preserves active busy hydration or the same run completes naturally with fresh real evidence');
  assert.deepEqual(await controllerLaunches(),runningLaunches,'Official reload does not launch another controller during the active run');
  context.log('native-designer-active-reload',{command:reload,workerPid:active.worker?.pid,workerParent:active.worker?.parent,
    processStarted:active.worker?.started,activeBusyHydrationQualified,nativeProcessIdentityPreserved:activeBusyHydrationQualified,
    busyControlsPreserved:activeBusyHydrationQualified,naturallyCompletedDuringReload:!activeBusyHydrationQualified,inventorySelectionOrderPreserved:true,
    intendedLaunches:1,additionalLaunches:0,source:'Existing real selected-suite worker; no additional workload or injected busy state'});
  context.log('native-designer-layout',await view.evaluate(()=>{
    const root=document.documentElement,width=root.clientWidth;
    const geometry=node=>{const rect=node.getBoundingClientRect();return {tag:node.tagName,id:node.id,
      classes:typeof node.className==='string'?node.className:'',left:rect.left,right:rect.right,width:rect.width,
      clientWidth:node.clientWidth,scrollWidth:node.scrollWidth};};
    return {viewportWidth:window.innerWidth,document:geometry(root),body:geometry(document.body),
      scrollX:window.scrollX,overflowingElements:[...document.body.querySelectorAll('*')].map(geometry)
        .filter(item=>item.width>0&&(item.right>width+1||item.left < -1)).sort((a,b)=>b.right-a.right).slice(0,20),
      scope:'Read-only geometry of the actual reloaded Designer document; no layout modification'};
  }));
  const report = await eventually(async () => {
    const text = await fs.readFile(reportPath, 'utf8');
    if (text === old) return false;
    const value = JSON.parse(text);
    if (value.schema_version !== 'perfchecker-suite-result/1' || value.runs.length !== 1) return false;
    return value;
  }, 'The native Run button completes the registered Julia backend and writes current evidence', 240000);
  assert.equal(report.runs[0].status, 'pass', 'Actual correctness-checked benchmark succeeds');
  await eventually(async () => !(await view.locator('#run').isDisabled()), 'Run control returns to idle');
  assert.deepEqual(await state(),idleState,'The same reloaded run finishes with the original exact idle controls and inventory');
  assert.deepEqual(await controllerLaunches(),runningLaunches,'No additional controller launches occur through completion of the same selected run');
  assert.deepEqual(await fs.readFile(planFile),planBytes,'Active reload preserves the exact canonical real plan');
  assert.equal((await fs.stat(planFile,{bigint:true})).mtimeNs,planStat.mtimeNs,'Active reload does not regenerate the real plan');
  context.proof('native-designer-active-reload-completed',{workerPid:active.worker?.pid,sameRunCompleted:true,activeBusyHydrationQualified,
    planSha256:createHash('sha256').update(planBytes).digest('hex'),planUnchanged:true,idleControlsRestored:true,
    inventorySelectionOrderPreserved:true,additionalControllerLaunches:0});
  await view.locator('#results').click();
  const result = await frame(context, 'button[data-report="suite-result.json"]');
  assert.equal(await result.locator('.empty').count(), 0);
  assert((await result.locator('[data-result-item]').count()) > 0);
  context.proof('native-run-selection', {runs: 1, status: report.runs[0].status, reportPath, nativeClick: true});
  return reports;
};

exports.run = async context => {
  assertDisposable(context);
  const view = await studio(context);
  assert.equal(await view.locator('.card').count(), 9);
  assert.equal(await view.locator('.lab button').count(), 5);
  assert(await view.locator('.hero img').evaluate(image => image.complete && image.naturalWidth > 0));
  const environment=view.locator('details.environment');
  if(await environment.getAttribute('open')===null)await environment.locator('summary').click();
  await eventually(async()=>(await environment.locator('p').innerText()).includes(context.controller),'Studio displays the selected controller after its state arrives');
  context.proof('studio-inventory', {cards: 9, workbenchButtons: 5, controllerShown: true});
  const failures = [];
  for (const [name, run] of [['suite-selection', testSuiteSelection], ['git-and-comparisons', testGitTargetsAndComparisons],['git-cancel-discovery',testCancelGitDiscovery],
    ['results', testResults], ['provider-and-tools', testAdvisorAndTools], ['save-palette', testSavePalette],
    ['large-plan-pagination-and-drag',testLargePlanAndOrdering],['computed-reference-aggregations',testComputedAggregations]]) {
    const commands=await context.vscode.commands.getCommands(true);
    if(commands.includes('notifications.clearAll'))await context.vscode.commands.executeCommand('notifications.clearAll');
    try {await run(context);}
    catch (error) {
      await capture(context,`${name}-failure`).catch(()=>{});
      failures.push(error);
      context.log(`${name}-failure`, {message: String(error), stack: error.stack});
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} native control group(s) failed; remaining groups were still attempted`);
};

exports.runFresh = async context => {
  assertDisposable(context);
  const view = await studio(context);
  assert.equal(await view.locator('.card').count(), 9);
  assert.match(await view.locator('.status').innerText(), /Install the Julia extension/);
  await clickStudioAction(context, 'suite');
  const missingSetup = /suite file not found.*perfchecker\.suite|controller Project\.toml not found.*perfchecker\.runnerProject/i;
  await eventually(async () => missingSetup.test(await (await frame(context, '#studio-root')).locator('.status').innerText()) ||
    missingSetup.test(await context.windowPage.locator('body').innerText()),
    'Fresh install explains the missing controller or suite file');
  await clickStudioAction(context, 'results');
  await eventually(async () => missingSetup.test(await (await frame(context, '#studio-root')).locator('.status').innerText()) ||
    missingSetup.test(await context.windowPage.locator('body').innerText()),
    'Fresh results explain the missing controller or suite file');
  await clickStudioAction(context, 'advisor');
  const advisor = await frame(context, '#advisor-root');
  assert(await advisor.locator('#advisor-protocol').isVisible());
  await advisor.locator('#advisor-protocol').selectOption('none');
  assert(await advisor.getByRole('button', {name: 'Test connection / discover', exact: true}).isDisabled());
  context.proof('fresh-studio-and-advisor', {visibleControls: 14, exercisedActions:['suite','results','advisor'], missingSuiteExplained: true, noJuliaExplained: true, ruleBasedAvailable: true});
};
