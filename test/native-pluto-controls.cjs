// Actual VS Code webviews and Pluto workers in disposable CI workspaces only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {createHash} = require('node:crypto');
const {execFile}=require('node:child_process');
const execute=require('node:util').promisify(execFile);
const {clickStudioAction}=require('./native-studio-controls.cjs');

async function eventually(read, name, timeout = 180000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {const result = await read(); if (result) return result;} catch (error) {if(error.name==='PlutoReactiveError')throw error;last = error;}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${name}${last ? `: ${last.message}` : ''}`);
}

async function files(directory) {
  const result = [];
  for (const item of await fs.readdir(directory, {withFileTypes: true}).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await files(file)); else result.push(file);
  }
  return result;
}

async function capture(context, name) {
  const file=path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,`native-${process.platform}-vscode-${context.vscode.version}-${name}.png`);
  await context.windowPage.screenshot({path:file});
  if(process.env.PERFCHECKER_NATIVE_VIDEO==='1')await new Promise(resolve=>setTimeout(resolve,2500));
  context.log('native-interface-capture',{interface:name,file:path.basename(file),sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex'),
    vscode:context.vscode.version,extension:process.env.PERFCHECKER_NATIVE_EXPECTED_VERSION,core:context.core,source:'actual-isolated-Electron-workbench'});
}

async function fingerprint(directory) {
  const result = {};
  for (const file of (await files(directory)).sort()) {
    result[path.relative(directory, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  }
  return result;
}

async function view(context) {
  const parent = await context.findFrame('iframe.perfchecker-pluto-frame');
  const element = await parent.locator('iframe.perfchecker-pluto-frame').elementHandle();
  const frame = await element.contentFrame();
  assert(frame, 'The notebook must be an interactive Pluto iframe');
  await frame.locator('pluto-notebook').waitFor({state: 'visible', timeout: 180000});
  return {parent, frame};
}

function cellId(source, fragment) {
  const cells = [...source.matchAll(/^# ╔═╡ ([a-f0-9-]{36})\r?\n([\s\S]*?)(?=^# ╔═╡ |$(?![\s\S]))/gm)];
  const matches = cells.filter(cell => cell[2].includes(fragment));
  assert.equal(matches.length, 1, `The official generator exposes one cell: ${fragment}`);
  return matches[0][1];
}

async function idle(frame) {
  await eventually(async () => await frame.locator('pluto-cell.running, pluto-cell.queued').count() === 0,
    'Pluto reactive cells finish');
}

async function ready(frame, button) {
  // Cell count precedes reactive evaluation. Wait for the real rendered control,
  // not merely for the generator's cells to have arrived over the WebSocket.
  await eventually(async () => {
    const errors = await frame.locator('pluto-cell.errored pluto-output').allTextContents();
    if (errors.length) throw Object.assign(new Error(`Pluto reactive errors: ${errors.join('\n').slice(0, 4000)}`),{name:'PlutoReactiveError'});
    return await frame.getByRole('button', {name: button, exact: true}).isVisible() &&
      await frame.locator('pluto-editor.loading, pluto-editor.disconnected, pluto-cell.running, pluto-cell.queued').count() === 0;
  }, `The connected notebook finishes evaluation and renders ${button}`, 240000);
}

async function refresh(frame, button, selector, expected, timeout = 360000) {
  const until = Date.now() + timeout;
  let last = '';
  while (Date.now() < until) {
    await frame.getByRole('button', {name: button, exact: true}).click();
    await idle(frame);
    last = await frame.locator(selector).innerText();
    if (expected.test(last)) return last;
    if (/"status"\s+"(?:error|failed|timeout)"|Status:\s*(?:failed|timeout)/.test(last)) {
      throw new Error(`Pluto worker failed: ${last.slice(0, 1500)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error(`Pluto status did not reach ${expected}: ${last.slice(0, 1500)}`);
}

const portOpen = port => new Promise(resolve => {
  const socket = net.createConnection({host: '127.0.0.1', port});
  socket.setTimeout(1000);
  socket.once('connect', () => {socket.destroy(); resolve(true);});
  socket.once('error', () => resolve(false));
  socket.once('timeout', () => {socket.destroy(); resolve(false);});
});

async function stop(context, state, closePanel = false) {
  const port = Number(new URL(state.frame.url()).port);
  assert(port > 0, 'This disposable desktop test has a real loopback Pluto server');
  context.log('native-ui-action',{surface:'Pluto session',action:closePanel?'Close notebook view':'Stop session'});
  if (closePanel) await context.vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  else await state.parent.locator('#pluto-stop').click();
  await eventually(async () => !await portOpen(port), 'Closing Pluto also closes its server and workers', 45000);
  if(!closePanel)await eventually(async()=>{
    const parent=await context.findFrame('#pluto-restart');
    return await parent.locator('iframe.perfchecker-pluto-frame').count()===0&&
      /session stopped/i.test(await parent.locator('[role="status"]').innerText());
  },'The explicit Stop transition finishes before another session action');
}

async function create(context, file, kind) {
  const uri = await context.vscode.commands.executeCommand('perfchecker.newNotebook', context.vscode.Uri.file(file), {kind});
  assert.equal(uri.fsPath, context.vscode.Uri.file(file).fsPath);
  const source = await fs.readFile(file, 'utf8');
  assert(source.startsWith('### A Pluto.jl notebook ###'));
  assert(!source.includes('jupyter-notebook'));
  const state = {source, ...await view(context)};
  await ready(state.frame, kind === 'suite' ? 'Launch selected checks' : 'Launch selected action');
  return state;
}

async function serverPids(){
  if(process.platform==='win32'){
    const {stdout}=await execute('powershell.exe',['-NoProfile','-Command','@(Get-CimInstance Win32_Process | Where-Object { $_.Name -like "julia*" -and $_.CommandLine -match "PERFCHECKER_PLUTO_READY" } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress']);
    const value=stdout.trim()?JSON.parse(stdout):[];return new Set((Array.isArray(value)?value:[value]).map(Number));
  }
  const {stdout}=await execute('ps',['-eo','pid=,args=']);
  return new Set(stdout.split('\n').filter(line=>line.includes('PERFCHECKER_PLUTO_READY')&&/julia/i.test(line)).map(line=>Number(line.trim().split(/\s+/,1)[0])));
}

async function studioNotebookButtons(context,directory){
  const file=path.join(directory,'StudioButtons.jl');
  const settings=context.vscode.workspace.getConfiguration('files',context.vscode.Uri.file(context.workspace));
  const previous=settings.inspect('simpleDialog.enable')?.globalValue;
  try{
    // VS Code declares this as application scope. Only the disposable profile is changed.
    await settings.update('simpleDialog.enable',true,context.vscode.ConfigurationTarget.Global);
    await clickStudioAction(context,'notebook');
    let picker=context.windowPage.locator('.quick-input-widget');await picker.waitFor({state:'visible'});
    let input=picker.locator('input[type="text"]');await input.fill(file);await new Promise(resolve=>setTimeout(resolve,300));await input.press('Enter');
    await picker.locator('.monaco-list-row').filter({hasText:'Investigation'}).first().waitFor();
    await picker.locator('.monaco-list-row').filter({hasText:'Investigation'}).first().click();
    const state=await view(context);await idle(state.frame);
    assert((await fs.readFile(file,'utf8')).startsWith('### A Pluto.jl notebook ###'));
    await stop(context,state,true);
    await clickStudioAction(context,'openNotebook');
    picker=context.windowPage.locator('.quick-input-widget');await picker.waitFor({state:'visible'});
    input=picker.locator('input[type="text"]');await input.fill(file);await new Promise(resolve=>setTimeout(resolve,300));await input.press('Enter');
    await stop(context,await view(context),true);
    context.proof('pluto-studio-file-dialog-buttons',{nativeNewClick:true,nativeOpenClick:true,realFileDialog:true,file:path.basename(file),jupyter:false});
  }finally{await settings.update('simpleDialog.enable',previous,context.vscode.ConfigurationTarget.Global);}
}

async function restartFailureCleanup(context,directory){
  const file=path.join(directory,'RestartCleanup.jl');
  let state=await create(context,file,'investigation');await idle(state.frame);await stop(context,state);
  const settings=context.vscode.workspace.getConfiguration('perfchecker',context.vscode.Uri.file(context.workspace));
  const previous=settings.get('plutoProject','perf/pluto'),before=await serverPids();let startingPids=[];
  try{
    const parent=await context.findFrame('#pluto-restart');await parent.locator('#pluto-restart').click();
    startingPids=await eventually(async()=>{const actual=[...await serverPids()].filter(pid=>!before.has(pid));return actual.length?actual:false;},'Restart spawns its real owned Julia server');
    await settings.update('plutoProject','perf/changed-pluto-environment',context.vscode.ConfigurationTarget.WorkspaceFolder);
    await eventually(async()=>/environment changed|Start the action again/.test(await (await context.findFrame('#pluto-restart')).locator('[role="status"]').innerText()),'Restart reports a changed environment after starting',240000);
    await eventually(async()=>{const pids=await serverPids();return startingPids.every(pid=>!pids.has(pid));},'Every server from the failed Restart exits',90000);
    assert.equal(await (await context.findFrame('#pluto-restart')).locator('iframe').count(),0);
  }finally{await settings.update('plutoProject',previous,context.vscode.ConfigurationTarget.WorkspaceFolder);}
  const parent=await context.findFrame('#pluto-restart');await parent.locator('#pluto-restart').click();
  state=await view(context);await idle(state.frame);
  assert(await portOpen(Number(new URL(state.frame.url()).port)),'A later successful Restart remains alive');
  await stop(context,state,true);
  context.proof('pluto-failed-restart-real-worker-cleanup',{failedPids:startingPids.length,newSessionUnaffected:true,staleIframeAbsent:true,remoteForwardingNotEmulated:true});
}

async function investigation(context, directory) {
  const file = path.join(directory, 'NativeInvestigation.jl');
  const reportRoot = path.join(context.workspace, 'perf', 'results', 'notebook');
  const before = await fingerprint(reportRoot);
  let state = await create(context, file, 'investigation');
  await eventually(async()=>await state.frame.locator('pluto-cell').count()===63,'The actual official investigation dashboard is loaded');
  for (const name of ['Launch selected action', 'Cancel active investigation', 'Refresh status and evidence',
    'Execute selected setup action', 'Cancel advisor setup', 'Refresh advisor setup / model inventory', 'Compare saved measurements']) {
    assert(await state.frame.getByRole('button', {name, exact: true}).isVisible(), `Real Pluto control: ${name}`);
  }
  await state.frame.locator('bond[def="action"] select').selectOption('run');
  await state.frame.locator('bond[def="selected"] select').selectOption({label:'sampled_sum_squares / sampled'});
  await idle(state.frame);
  assert.deepEqual(await fingerprint(reportRoot), before, 'Opening and selecting cannot execute measurements');
  context.log('native-ui-action',{surface:'Pluto investigation',action:'Launch selected action'});
  await state.frame.getByRole('button', {name: 'Launch selected action', exact: true}).click();
  const report = await eventually(async () => {
    for (const name of await files(reportRoot)) {
      if (!name.endsWith(`${path.sep}run.json`) || before[path.relative(reportRoot, name)]) continue;
      return JSON.parse(await fs.readFile(name, 'utf8'));
    }
  }, 'Launch writes a real scenario report', 360000);
  assert.equal(report.schema_version, 'perfchecker-scenario-run/1');
  assert.deepEqual(new Set(report.runs.map(run => run.collector)), new Set(['benchmark', 'chairmark', 'profile', 'profile_alloc']));
  for (const run of report.runs) {
    assert.equal(run.qualification.availability, 'complete');
    assert.equal(run.qualification.correctness, 'passed');
    assert(run.summaries.length || run.profile.samples > 0, 'A completed collector contains actual observations');
    if(run.collector==='profile')assert(run.profile.stacks.length>0,'Pluto CPU profiling retains actual sampled stacks');
    if(run.collector==='profile_alloc')assert(run.profile.allocation_sites.length>0,'Pluto allocation profiling retains actual sampled allocation sites');
  }
  const snapshot = `pluto-cell[id="${cellId(state.source, 'snapshot = (refresh_click;')}"] pluto-output`;
  await refresh(state.frame, 'Refresh status and evidence', snapshot, /\bcomplete\b/);
  await capture(context,'pluto-investigation');
  const completed = await fingerprint(reportRoot);
  await state.frame.locator('bond[def="action"] select').selectOption('tools');
  await idle(state.frame);
  assert.deepEqual(await fingerprint(reportRoot), completed, 'Changing selectors after completion cannot rerun the check');
  context.proof('pluto-investigation-real-run', {collectors: [...new Set(report.runs.map(run => run.collector))], core: context.core});

  // Use the real CodeMirror editor, reactive evaluation and Pluto's on-disk autosave.
  const id = cellId(state.source, '# PerfChecker investigations');
  const cell = state.frame.locator(`pluto-cell[id="${id}"]`);
  await cell.scrollIntoViewIfNeeded();
  const title = 'PerfChecker native reactive qualification';
  const editor = cell.locator('pluto-input .cm-editor:not(.cm-ssr-fake) .cm-content[contenteditable="true"]');
  if (!await editor.isVisible()) await cell.locator('.foldcode').click();
  await eventually(async()=>!((await cell.getAttribute('class'))||'').split(/\s+/).includes('code_folded')&&await editor.isVisible(),
    'The real unfold gesture finishes and exposes the interactive CodeMirror input');
  await editor.click(); await editor.press('ControlOrMeta+A');
  context.log('native-ui-action',{surface:'Pluto investigation',action:'Edit reactive cell and evaluate'});
  await editor.pressSequentially(`md"# ${title}"`); await editor.press('ControlOrMeta+Enter');
  await eventually(async () => (await fs.readFile(file, 'utf8')).includes(`md"# ${title}"`), 'Reactive cell is saved as real Julia code');
  await eventually(async () => (await cell.locator('pluto-output').innerText()).includes(title), 'Reactive output changes');
  await state.frame.goto(state.frame.url());
  state = await view(context);
  await eventually(async () => (await state.frame.locator(`pluto-cell[id="${id}"] pluto-output`).innerText()).includes(title), 'Saved cell survives a real iframe reload');
  await state.parent.locator('#pluto-source').click();
  await eventually(() => context.vscode.window.activeTextEditor?.document.uri.fsPath === context.vscode.Uri.file(file).fsPath, 'Open source opens the actual generated .jl');
  const saved = await fs.readFile(file);
  await context.vscode.commands.executeCommand('perfchecker.openNotebook', context.vscode.Uri.file(file));
  state = await view(context);
  assert.deepEqual(await fs.readFile(file), saved, 'Open reuses the saved notebook without regeneration');
  const port = Number(new URL(state.frame.url()).port);
  await context.vscode.commands.executeCommand('perfchecker.openNotebook', context.vscode.Uri.file(file));
  assert.equal(Number(new URL((await view(context)).frame.url()).port), port, 'Reopening reuses the same server');
  await stop(context, state);
  const stopped = await context.findFrame('#pluto-restart');
  await stopped.locator('#pluto-restart').click();
  state = await view(context);
  await eventually(async () => (await state.frame.locator(`pluto-cell[id="${id}"] pluto-output`).innerText()).includes(title), 'Restart retains saved cells');
  assert.deepEqual(await fingerprint(reportRoot), completed, 'Restart is not a measurement request');
  await stop(context, state, true);
  context.proof('pluto-reactive-save-reload-close', {source: path.basename(file), workersClosed: true});
}

async function cancellation(context, directory) {
  const settings = context.vscode.workspace.getConfiguration('perfchecker', context.vscode.Uri.file(context.workspace));
  const previous = settings.get('scenarioCatalog', 'perf/scenarios.toml');
  const catalog = path.join(directory, 'NativeCancellation.toml'), marker = path.join(directory, 'worker-running.marker');
  await fs.writeFile(catalog, 'schema_version="perfchecker-scenario-catalog/1"\nroot=".."\n[[scenarios]]\nid="pluto_cancel"\nimplementation="active-worker"\nsource=' + JSON.stringify(path.join(context.workspace,'perf','cases.jl')) + '\nfactory="make_cancel_case"\ncollectors=["benchmark"]\n[scenarios.parameters]\nmarker=' + JSON.stringify(marker) + '\n');
  try {
    await settings.update('scenarioCatalog', catalog, context.vscode.ConfigurationTarget.WorkspaceFolder);
    const state = await create(context, path.join(directory, 'NativeCancellation.jl'), 'investigation');
    await state.frame.locator('bond[def="action"] select').selectOption('run');
    await idle(state.frame);
    assert.equal(await fs.stat(marker).then(() => true).catch(() => false), false);
    await state.frame.getByRole('button', {name: 'Launch selected action', exact: true}).click();
    await eventually(() => fs.readFile(marker, 'utf8').then(value => value === 'running'), 'An actual measured workload reaches its active-worker marker', 360000);
    await state.frame.getByRole('button', {name: 'Cancel active investigation', exact: true}).click();
    const snapshot = `pluto-cell[id="${cellId(state.source, 'snapshot = (refresh_click;')}"] pluto-output`;
    await refresh(state.frame, 'Refresh status and evidence', snapshot, /\bcancelled\b/, 90000);
    await stop(context, state, true);
    context.proof('pluto-cancel-active-worker', {workerReached: true, cancelled: true, serverClosed: true});
  } finally {
    await context.vscode.commands.executeCommand('perfchecker.stopNotebookSession', context.vscode.Uri.file(context.workspace));
    await settings.update('scenarioCatalog', previous, context.vscode.ConfigurationTarget.WorkspaceFolder);
    await fs.unlink(marker).catch(error => {if (error.code !== 'ENOENT') throw error;});
  }
}

async function ownedWorkerClose(context,directory){
  const settings=context.vscode.workspace.getConfiguration('perfchecker',context.vscode.Uri.file(context.workspace));
  const previous={suite:settings.get('suite','perf/suite.jl'),catalog:settings.get('scenarioCatalog','perf/scenarios.toml'),pluto:settings.get('plutoProject','perf/pluto')};
  const marker=path.join(directory,'owned-worker.marker'),cleaned=path.join(directory,'owned-worker-cleaned.marker');
  const catalog=path.join(directory,'OwnedWorker.toml');
  const preserved=path.join(context.workspace,'perf','owned-cancel.jl.999.mem');
  const sentinel=Buffer.from('pre-existing allocation inventory retained exactly\n');
  await fs.writeFile(preserved,sentinel);
  await fs.writeFile(catalog,'schema_version="perfchecker-scenario-catalog/1"\nroot=".."\n[[scenarios]]\nid="owned_worker"\nimplementation="stop-before-server-close"\nsource='+JSON.stringify(path.join(context.workspace,'perf','cases.jl'))+'\nfactory="make_owned_cancel_case"\ncollectors=["benchmark"]\n[scenarios.parameters]\nmarker='+JSON.stringify(marker)+'\ncleaned='+JSON.stringify(cleaned)+'\n');
  const beforeMem=new Set((await files(context.workspace)).filter(file=>file.endsWith('.mem')));
  let fixtureUserDirectory,fixtureWorkerPid;
  const allocationOwned=async info=>{
    const environment=info[1],privateCheck=path.dirname(environment),pid=Number(info[0]);
    assert(path.basename(privateCheck).startsWith('perfchecker-check-'),'The measured allocation runs in a real Core-owned private environment');
    assert(await fs.stat(path.join(environment,'owned.tmp')));
    const journal=await fs.readFile(path.join(privateCheck,'allocation-artifacts'));
    assert(journal.includes(Buffer.from(`.${pid}.mem`)),'The physical allocation journal identifies this measured worker');
    return privateCheck;
  };
  const assertStopped=async(state,pid,owned,closePanel,action)=>{
    const alive=()=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
    assert(alive(),'The measured process must really be alive before Stop/Close');
    const start=Date.now();if(action)await action();else await stop(context,state,closePanel);
    await eventually(()=>!alive(),'The detached measurement worker terminates before the 120-second workload could finish',45000);
    await eventually(async()=>!await fs.stat(owned).then(()=>true).catch(()=>false),'The worker cleanup removes its owned temporary directory',45000);
    assert(Date.now()-start<90000,'Cleanup is cooperative rather than waiting for the complete workload');
    assert.deepEqual(await fs.readFile(preserved),sentinel,'Existing .mem evidence is never removed');
    assert.deepEqual(new Set((await files(context.workspace)).filter(file=>file.endsWith('.mem'))),beforeMem,'Only allocation files created by the session are cleaned');
    return Date.now()-start;
  };
  try{
    await settings.update('scenarioCatalog',catalog,context.vscode.ConfigurationTarget.WorkspaceFolder);
    let state=await create(context,path.join(directory,'StopActiveInvestigation.jl'),'investigation');
    await state.frame.locator('bond[def="action"] select').selectOption('run');await idle(state.frame);
    await state.frame.getByRole('button',{name:'Launch selected action',exact:true}).click();
    const info=await eventually(async()=>{const lines=(await fs.readFile(marker,'utf8')).split('\n');return lines.length===3?lines:false;},'The detached investigation reaches its real PID and private controller-directory marker',360000);
    const [pid,userDirectory,controllerDirectory]=info;
    fixtureWorkerPid=Number(pid);fixtureUserDirectory=userDirectory;
    for(const name of ['request.toml','worker.log'])assert(await fs.stat(path.join(controllerDirectory,name)).then(stat=>stat.isFile()),
      `The active investigation has its own physical ${name}`);
    await settings.update('plutoProject','perf/changed-after-launch',context.vscode.ConfigurationTarget.WorkspaceFolder);
    const elapsed=await assertStopped(state,Number(pid),controllerDirectory,false);
    const callbackCompleted=await fs.readFile(cleaned,'utf8').then(value=>value==='cleaned').catch(error=>{if(error.code==='ENOENT')return false;throw error;});
    context.log('pluto-forced-scenario-callback-limitation',{callbackCompleted,
      contract:'Forced worker termination does not guarantee arbitrary Julia cleanup callbacks. The fixture-owned directory is removed only after PID death.'});
    // This directory was created by this fixture's user callback, not inventoried
    // by Core. Its removal belongs to the test after the strong worker oracle.
    assert(path.basename(userDirectory).startsWith('jl_'));
    await fs.rm(userDirectory,{recursive:true,force:true});
    fixtureUserDirectory=undefined;
    await settings.update('plutoProject',previous.pluto,context.vscode.ConfigurationTarget.WorkspaceFolder);
    await context.vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    context.proof('pluto-stop-active-owned-worker',{kind:'InvestigationJob',cleanupMilliseconds:elapsed,pidTerminated:true,ownedFilesRemoved:true,
      coreRequestAndWorkerLogRemoved:true,arbitraryUserCleanupCallbackGuaranteed:false,callbackCompleted,
      fixtureDirectoryRemovedAfterWorkerDeath:true,preExistingMemPreserved:true,environmentChangedWhileRunning:true});

    await settings.update('suite','perf/owned-suite.jl',context.vscode.ConfigurationTarget.WorkspaceFolder);
    const suiteMarker=path.join(context.workspace,'perf','owned-suite-worker.marker');
    await fs.rm(suiteMarker,{force:true});
    state=await create(context,path.join(directory,'CancelActiveAllocation.jl'),'suite');
    await state.frame.locator('bond[def="selected_collector"] select').selectOption('alloc');await idle(state.frame);
    await state.frame.getByRole('button',{name:'Launch selected checks',exact:true}).click();
    const cancelInfo=await eventually(async()=>{const lines=(await fs.readFile(suiteMarker,'utf8')).split('\n');return lines.length===2?lines:false;},'The Suite Cancel test reaches its active allocation worker',360000);
    const cancelOwned=await allocationOwned(cancelInfo);
    await state.frame.getByRole('button',{name:'Cancel active job',exact:true}).click();
    let workerAliveBeforeSecondClick;
    try{process.kill(Number(cancelInfo[0]),0);workerAliveBeforeSecondClick=true;}catch(error){if(error.code!=='ESRCH')throw error;workerAliveBeforeSecondClick=false;}
    await state.frame.getByRole('button',{name:'Cancel active job',exact:true}).click();
    await refresh(state.frame,'Refresh status','[data-suite-state]',/\bcancelled\b/,90000);
    await eventually(()=>{try{process.kill(Number(cancelInfo[0]),0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}},'The actual Suite Cancel button terminates the detached allocation worker');
    await eventually(()=>fs.stat(cancelOwned).then(()=>false).catch(error=>{if(error.code==='ENOENT')return true;throw error;}),'Suite Cancel cleans the actual private allocation environment and its journal',45000);
    assert.deepEqual(await fs.readFile(preserved),sentinel);
    assert.deepEqual(new Set((await files(context.workspace)).filter(file=>file.endsWith('.mem'))),beforeMem);
    await stop(context,state,true);
    context.proof('pluto-suite-cancel-active-allocation',{nativeClick:true,nativeCancelClicks:2,workerAliveBeforeSecondClick,secondNativeCancelDuringCleanup:'not-observed; the Core regression separately forces cancellation during cleanup',workerTerminated:true,ownedDirectoryRemoved:true,noNewMem:true,preExistingMemPreserved:true});
    await fs.rm(suiteMarker,{force:true});
    state=await create(context,path.join(directory,'CloseActiveAllocation.jl'),'suite');
    await state.frame.locator('bond[def="selected_collector"] select').selectOption('alloc');await idle(state.frame);
    await state.frame.getByRole('button',{name:'Launch selected checks',exact:true}).click();
    const suiteInfo=await eventually(async()=>{const lines=(await fs.readFile(suiteMarker,'utf8')).split('\n');return lines.length===2?lines:false;},'The allocation worker reaches its real PID marker',360000);
    const suiteOwned=await allocationOwned(suiteInfo);
    const suiteElapsed=await assertStopped(state,Number(suiteInfo[0]),suiteOwned,true);
    context.proof('pluto-close-active-allocation-worker',{kind:'SuiteJob',cleanupMilliseconds:suiteElapsed,pidTerminated:true,ownedFilesRemoved:true,preExistingMemPreserved:true,noNewMem:true});

    await fs.rm(suiteMarker,{force:true});
    state=await create(context,path.join(directory,'ShutdownActiveAllocation.jl'),'suite');
    await state.frame.locator('bond[def="selected_collector"] select').selectOption('alloc');await idle(state.frame);
    await state.frame.getByRole('button',{name:'Launch selected checks',exact:true}).click();
    const shutdownInfo=await eventually(async()=>{const lines=(await fs.readFile(suiteMarker,'utf8')).split('\n');return lines.length===2?lines:false;},'The Pluto homepage Shutdown test reaches its active allocation worker',360000);
    const shutdownOwned=await allocationOwned(shutdownInfo);
    const page=state.frame.page();let confirmed=false;
    const confirm=async dialog=>{
      if(dialog.type()==='confirm' && /shut down|close.*notebook/i.test(dialog.message())){confirmed=true;await dialog.accept();}
      else await dialog.dismiss();
    };
    page.on('dialog',confirm);
    let shutdownElapsed;
    try{
      shutdownElapsed=await assertStopped(state,Number(shutdownInfo[0]),shutdownOwned,false,async()=>{
        await state.frame.locator('img#logo-big').locator('..').click();
        await eventually(()=>new URL(state.frame.url()).pathname==='/'&&state.frame.locator('#recent').isVisible(),'The real Pluto logo opens its authenticated homepage');
        const running=state.frame.locator('#recent li.running').filter({hasText:'ShutdownActiveAllocation.jl'});
        await running.locator('button.session').click();
        await eventually(async()=>await running.count()===0,'The native Pluto homepage removes the stopped notebook');
      });
    }finally{page.off('dialog',confirm);}
    assert(confirmed,'The actual browser confirmation was accepted, rather than suppressing or mocking it');
    assert(await portOpen(Number(new URL(state.frame.url()).port)),'The homepage shuts down its notebook without stopping the shared Pluto server');
    context.proof('pluto-home-shutdown-active-allocation',{nativeClick:true,realConfirmation:true,cleanupMilliseconds:shutdownElapsed,pidTerminated:true,ownedFilesRemoved:true,noNewMem:true,preExistingMemPreserved:true});
    await context.vscode.commands.executeCommand('perfchecker.stopNotebookSession',context.vscode.Uri.file(context.workspace));
    await context.vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }finally{
    await context.vscode.commands.executeCommand('perfchecker.stopNotebookSession',context.vscode.Uri.file(context.workspace));
    if(fixtureUserDirectory){
      let running;try{process.kill(fixtureWorkerPid,0);running=true;}catch(error){if(error.code!=='ESRCH')throw error;running=false;}
      if(!running){assert(path.basename(fixtureUserDirectory).startsWith('jl_'));
        await fs.rm(fixtureUserDirectory,{recursive:true,force:true});}
      else context.log('pluto-failure-fixture-cleanup-pending',{worker:fixtureWorkerPid,
        reason:'The fixture callback directory is retained while its measured process still owns it.'});
    }
    await settings.update('suite',previous.suite,context.vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('scenarioCatalog',previous.catalog,context.vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('plutoProject',previous.pluto,context.vscode.ConfigurationTarget.WorkspaceFolder);
    for(const file of [marker,cleaned,preserved])await fs.rm(file,{force:true});
  }
}

async function suite(context, directory) {
  const root = path.resolve(context.workspace, context.vscode.workspace.getConfiguration('perfchecker',
    context.vscode.Uri.file(context.workspace)).get('reports', 'perf/results/vscode'));
  const before = await fingerprint(root);
  const state = await create(context, path.join(directory, 'NativeSuite.jl'), 'suite');
  for (const name of ['Launch selected checks', 'Cancel active job', 'Refresh status', 'Save completed reports']) {
    assert(await state.frame.getByRole('button', {name, exact: true}).isVisible(), `Real suite control: ${name}`);
  }
  await state.frame.locator('bond[def="selected_collector"] select').selectOption('benchmark');
  await state.frame.locator('bond[def="selected_package"] select').selectOption('PerfCheckerNativeFixture');
  await state.frame.locator('bond[def="selected_workload"] select').selectOption('sum_squares');
  await state.frame.locator('bond[def="selected_target"] select').selectOption('baseline');
  await state.frame.locator('bond[def="samples"] input').fill('2');
  await state.frame.locator('bond[def="samples"] input').press('Tab');
  await state.frame.locator('bond[def="seconds"] input').fill('0.1');
  await state.frame.locator('bond[def="seconds"] input').press('Tab');
  await idle(state.frame);
  assert.deepEqual(await fingerprint(root), before, 'Suite selectors and sample inputs do not execute workers');
  context.log('native-ui-action',{surface:'Pluto suite',action:'Launch selected checks'});
  await state.frame.getByRole('button', {name: 'Launch selected checks', exact: true}).click();
  await refresh(state.frame, 'Refresh status', '[data-suite-state]', /\bcomplete\b/);
  assert.deepEqual(await fingerprint(root), before, 'Reports are saved only on the explicit Save action');
  context.log('native-ui-action',{surface:'Pluto suite',action:'Save completed reports'});
  await state.frame.getByRole('button', {name: 'Save completed reports', exact: true}).click();
  const saved = await eventually(async () => {
    for (const name of await files(root)) {
      if (!name.endsWith(`${path.sep}suite-result.json`) || before[path.relative(root, name)]) continue;
      return {file: name, data: JSON.parse(await fs.readFile(name, 'utf8'))};
    }
  }, 'Save completed reports writes an actual measured bundle');
  const savedOutput=state.frame.locator(`pluto-cell[id="${cellId(state.source,'saved_reports = begin')}"] pluto-output`);
  await eventually(async()=>/Last saved reports:/.test(await savedOutput.innerText()),
    'The Save cell finishes writing every report format');
  await idle(state.frame);
  for(const name of ['version-series.json','version-comparison.json','version-comparison.md'])
    assert(await fs.stat(path.join(path.dirname(saved.file),name)).then(stat=>stat.isFile()),`The completed Save includes ${name}`);
  assert.equal(saved.data.schema_version, 'perfchecker-suite-result/1');
  assert.equal(saved.data.runs.length, 1, 'Package/workload/collector/target filters determine the measured plan');
  assert.equal(saved.data.runs[0].status, 'pass');
  assert.equal(saved.data.runs[0].qualification.correctness.status, 'passed');
  await capture(context,'pluto-suite');
  const plots = state.frame.locator('bond[def="selected_plot"] select');
  const choices = await plots.locator('option').allTextContents();
  assert(choices.length > 0 && !choices.includes('No completed measurements'), 'Actual measured values feed the Pluto plot catalogue');
  const plotted = await state.frame.locator('pluto-cell').filter({hasText: 'Install PerfCheckerMakie and WGLMakie'}).count();
  if (plotted) {
    context.log('pluto-plot-prerequisite', {available: false, reason: 'Install PerfCheckerMakie and WGLMakie in the separate notebook environment'});
  } else {
    assert(await state.frame.locator('canvas').count() > 0, 'An available WGLMakie provider renders an actual plot');
    context.log('pluto-rendered-plot', {available: true, canvas: true});
  }
  const completed = await fingerprint(root);
  await state.frame.locator('bond[def="samples"] input').fill('3');
  await state.frame.locator('bond[def="samples"] input').press('Tab');
  await idle(state.frame);
  assert.deepEqual(await fingerprint(root), completed, 'Changing a completed suite does not rerun or resave results');
  await stop(context, state, true);
  context.proof('pluto-suite-select-launch-save', {checks: saved.data.runs.length, report: path.relative(context.workspace, saved.file)});
}

exports.run = async context => {
  assert.equal(process.env.CI, 'true', 'Never use a human VS Code installation');
  const session=process.env.PERFCHECKER_NATIVE_SESSION;
  assert(session&&path.isAbsolute(session),'The runner identifies the disposable session');
  assert.equal(await fs.realpath(context.workspace),path.join(await fs.realpath(session),'workspace'),
    'Only the exact workspace created by this qualification runner may be changed');
  const directory = path.join(context.workspace, 'perf', 'notebooks');
  await fs.mkdir(directory, {recursive: true});
  const failures = [];
  for (const [name, test] of [['studio-file-dialogs',studioNotebookButtons],['failed-restart-cleanup',restartFailureCleanup],
    ['investigation', investigation], ['cancellation', cancellation], ['suite', suite],['stop-close-active-worker',ownedWorkerClose]]) {
    try {await test(context, directory);}
    catch (error) {
      const message = error.message.replace(/([?&]secret=)[^&\s"<>]+/g, '$1[redacted]');
      failures.push(new Error(`${name}: ${message}`));
      context.log(`pluto-${name}`, {status: 'failed', message});
      try {
        const state = await view(context);
        const reactive = await state.frame.locator('pluto-cell.errored pluto-output').allTextContents();
        context.log('pluto-failure-before-stop', {case:name,reactiveErrors:reactive.map(value=>value.slice(0,3000)),
          renderedLaunch:await state.frame.getByRole('button',{name:/Launch selected/}).count(),
          cellCount:await state.frame.locator('pluto-cell').count(),
          editorStatus:await state.frame.locator('pluto-editor').getAttribute('class')});
      } catch (diagnostic) {context.log('pluto-failure-view-unavailable',{case:name,message:String(diagnostic).replace(/([?&]secret=)[^&\s"<>]+/g,'$1[redacted]')});}
      await capture(context,`pluto-${name}-failed-before-stop`).catch(()=>{});
    }
    finally {await context.vscode.commands.executeCommand('perfchecker.stopNotebookSession', context.vscode.Uri.file(context.workspace));}
  }
  if (failures.length) throw new AggregateError(failures, 'Actual Pluto controls failed');
};
