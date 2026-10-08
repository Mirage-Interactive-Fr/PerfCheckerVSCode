// Actual VS Code webviews and Pluto workers in disposable CI workspaces only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {createHash} = require('node:crypto');
const {execFile}=require('node:child_process');
const execute=require('node:util').promisify(execFile);
const {inflateSync}=require('node:zlib');
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

async function interactiveEditor(context,state,cell,label){
  const errors=[],page=state.frame.page();
  const details=error=>({name:error.name,message:String(error.message).replace(/([?&]secret=)[^&\s"'<>]*/gi,'$1[session secret]').replace(/\b[a-f0-9]{64}\b/gi,'[opaque token]').slice(0,1500)});
  const onError=error=>errors.push(details(error));
  const geometry=()=>cell.evaluate(element=>{
    const rect=node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,visibility:s.visibility};};
    return {classes:element.className,viewport:{width:innerWidth,height:innerHeight},cell:rect(element),inputs:[...element.querySelectorAll('pluto-input .cm-editor')].map(node=>({fake:node.classList.contains('cm-ssr-fake'),geometry:rect(node),contentEditable:node.querySelector('.cm-content')?.getAttribute('contenteditable')}))};
  });
  const observe=async stage=>context.log('pluto-editor-readiness',{label,stage,state:await geometry(),frontendErrors:[...errors]});
  page.on('pageerror',onError);
  try{
    await cell.scrollIntoViewIfNeeded();await observe('before-gesture');
    const shown=cell.locator('pluto-input .cm-editor');
    if(!await shown.isVisible())await cell.locator('.foldcode').click();
    await observe('after-fold-gesture');
    await shown.waitFor({state:'visible'});
    // Pluto replaces the static placeholder with CodeMirror when its input
    // intersects the viewport. Scrolling the cell can leave that input clipped.
    await shown.scrollIntoViewIfNeeded();
    const editor=cell.locator('pluto-input .cm-editor:not(.cm-ssr-fake) .cm-content[contenteditable="true"]');
    await eventually(async()=>await editor.isVisible()&&await editor.isEditable(),'The real UI exposes an interactive CodeMirror input');
    await observe('interactive');return editor;
  }catch(error){
    try{await observe('failed');}catch(diagnosticError){
      try{context.log('pluto-editor-diagnostic-failure',{label,error:details(diagnosticError)});}catch{}
    }
    throw error;
  }
  finally{page.off('pageerror',onError);}
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

let lastWindowsInventory;
async function windowsProcesses(context,stage){
  const {stdout}=await execute('powershell.exe',['-NoProfile','-Command',
    "$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;name=$_.Name;executable=$_.ExecutablePath;createdAt=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null});pidType=$_.ProcessId.GetType().FullName;parentType=$_.ParentProcessId.GetType().FullName} }); $tcp=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | ForEach-Object { @{pid=$_.OwningProcess;port=$_.LocalPort;address=$_.LocalAddress;state=[string]$_.State} }); @{rows=$rows;listeners=$tcp} | ConvertTo-Json -Depth 4 -Compress"]);
  const value=JSON.parse(stdout);assert(Array.isArray(value.rows));assert(Array.isArray(value.listeners));
  const expectedExecutable=await fs.realpath(process.env.PERFCHECKER_NATIVE_JULIA);
  const direct=[];
  for(const row of value.rows.filter(row=>row.parent===process.pid&&/^julia(?:\.exe)?$/i.test(row.name))){
    assert.equal(typeof row.pid,'number');assert.equal(typeof row.parent,'number');assert(typeof row.createdAt==='string'&&/^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.createdAt)&&Number.isFinite(Date.parse(row.createdAt)),
      'The process has a nonempty parseable ISO creation date');
    const canonicalExecutable=await fs.realpath(row.executable);
    if(canonicalExecutable.toLowerCase()===expectedExecutable.toLowerCase())direct.push({...row,canonicalExecutable});
  }
  const owned=new Set(direct.map(row=>row.pid));
  for(let changed=true;changed;){changed=false;for(const row of value.rows)
    if(owned.has(row.parent)&&!owned.has(row.pid)){owned.add(row.pid);changed=true;}}
  const signature=JSON.stringify({direct,descendants:value.rows.filter(row=>owned.has(row.pid)),listeners:value.listeners.filter(row=>owned.has(row.pid))});
  if(signature!==lastWindowsInventory){
    context.log('pluto-windows-process-inventory',{stage,hostPid:process.pid,expectedExecutable,
      direct,descendants:value.rows.filter(row=>owned.has(row.pid)),listeners:value.listeners.filter(row=>owned.has(row.pid)),
      commandArgumentsUnavailableAfterJuliaStartup:true});lastWindowsInventory=signature;
  }
  return {...value,direct,ownedRows:value.rows.filter(row=>owned.has(row.pid))};
}
async function windowsSessionOwner(context,state){
  const endpoint=new URL(state.frame.url());assert.equal(endpoint.hostname,'127.0.0.1');
  const port=Number(endpoint.port);assert(Number.isInteger(port)&&port>0&&port<65536);
  const inventory=await windowsProcesses(context,'running-session');
  const listeners=inventory.listeners.filter(row=>row.port===port&&row.address==='127.0.0.1'&&row.state==='Listen');
  assert.equal(listeners.length,1,'The exact live iframe port has one listening process');
  const owner=inventory.direct.find(row=>row.pid===listeners[0].pid);
  assert(owner,'The actual session listener is the selected Julia directly owned by the extension host');
  assert.doesNotThrow(()=>process.kill(owner.pid,0),'The physical session owner is alive');
  context.log('pluto-windows-session-owner',{port,pid:owner.pid,createdAt:owner.createdAt,parent:owner.parent,
    canonicalExecutable:owner.canonicalExecutable,exactIframeListener:true,credentialsOmitted:true});
  const owned=new Set([owner.pid]);
  for(let changed=true;changed;){changed=false;for(const row of inventory.rows)
    if(owned.has(row.parent)&&!owned.has(row.pid)){owned.add(row.pid);changed=true;}}
  return {...owner,descendants:inventory.rows.filter(row=>owned.has(row.pid))};
}
async function serverPids(context){
  if(process.platform==='win32'){
    return new Set((await windowsProcesses(context,'process-survey')).direct.map(row=>row.pid));
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
  let state=await create(context,file,'investigation');await idle(state.frame);
  const initialOwner=process.platform==='win32'?await windowsSessionOwner(context,state):undefined;
  await stop(context,state);
  if(initialOwner)await eventually(async()=>{
    const actual=await windowsProcesses(context,'after-initial-stop');
    return actual.direct.length===0&&initialOwner.descendants.every(prior=>!actual.rows.some(row=>row.pid===prior.pid&&row.createdAt===prior.createdAt));
  },'Initial Stop leaves no selected-Julia child or observed session descendant before the failed startup');
  const settings=context.vscode.workspace.getConfiguration('perfchecker',context.vscode.Uri.file(context.workspace));
  const previous=settings.get('plutoProject','perf/pluto'),before=await serverPids(context);let startingPids=[];
  const startingIdentities=new Map();
  const remember=inventory=>{
    const parents=new Set([...startingIdentities.values()].filter(prior=>
      inventory.rows.some(row=>row.pid===prior.pid&&row.createdAt===prior.createdAt)).map(row=>row.pid));
    for(let changed=true;changed;){changed=false;for(const row of inventory.rows){
      if(!parents.has(row.parent)||parents.has(row.pid))continue;
      assert(typeof row.createdAt==='string'&&/^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.createdAt)&&Number.isFinite(Date.parse(row.createdAt)),
        'Every observed descendant has a nonempty parseable ISO creation date');
      startingIdentities.set(`${row.pid}:${row.createdAt}`,row);parents.add(row.pid);changed=true;
    }}
  };
  try{
    const parent=await context.findFrame('#pluto-restart');await parent.locator('#pluto-restart').click();
    if(process.platform==='win32'){
      assert.equal(before.size,0,'The failed-startup baseline contains no direct selected-Julia child');
      const inventory=await eventually(async()=>{
        const actual=await windowsProcesses(context,'starting-before-configuration-change');
        return actual.direct.length?actual:false;
      },'Restart starts its real selected-Julia process');
      assert.equal(inventory.direct.length,1,'The owned Restart starts exactly one new Julia leader');
      const leader=inventory.direct[0];assert.doesNotThrow(()=>process.kill(leader.pid,0));
      startingPids=[leader.pid];startingIdentities.set(`${leader.pid}:${leader.createdAt}`,leader);remember(inventory);
      const status=await parent.locator('[role="status"]').innerText();
      assert.match(status,/Starting Pluto/);
      assert.equal(await parent.locator('iframe.perfchecker-pluto-frame').count(),0,
        'The configuration change must occur during actual nonREADY startup');
      context.log('pluto-failed-startup-physical-owner',{leader,descendants:[...startingIdentities.values()],
        status,iframePublished:false,aliveBeforeConfigurationChange:true,
        observedListeners:inventory.listeners.filter(row=>startingPids.includes(row.pid)),listenerScope:'diagnostic only'});
    }else startingPids=await eventually(async()=>{const actual=[...await serverPids(context)].filter(pid=>!before.has(pid));return actual.length?actual:false;},'Restart spawns its real owned Julia server');
    await settings.update('plutoProject','perf/changed-pluto-environment',context.vscode.ConfigurationTarget.WorkspaceFolder);
    await eventually(async()=>{
      if(process.platform==='win32')remember(await windowsProcesses(context,'startup-configuration-change'));
      return /environment changed|Start the action again/.test(await (await context.findFrame('#pluto-restart')).locator('[role="status"]').innerText());
    },'Restart reports a changed environment after starting',240000);
    if(process.platform==='win32')await eventually(async()=>{
      const actual=await windowsProcesses(context,'failed-startup-cleanup');remember(actual);
      return [...startingIdentities.values()].every(prior=>!actual.rows.some(row=>row.pid===prior.pid&&row.createdAt===prior.createdAt));
    },'The failed startup leader and every observed descendant incarnation exit before harness teardown',90000);
    else await eventually(async()=>{const pids=await serverPids(context);return startingPids.every(pid=>!pids.has(pid));},'Every server from the failed Restart exits',90000);
    assert.equal(await (await context.findFrame('#pluto-restart')).locator('iframe').count(),0);
  }catch(error){
    try{
      const parent=await context.findFrame('#pluto-restart'),src=await parent.locator('iframe.perfchecker-pluto-frame').getAttribute('src').catch(()=>undefined);
      const port=src?Number(new URL(src).port):undefined;
      let listeners;
      if(process.platform==='win32'&&port)listeners=JSON.parse((await execute('powershell.exe',['-NoProfile','-Command',
        `@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { @{pid=$_.OwningProcess;port=$_.LocalPort} }) | ConvertTo-Json -Compress`])).stdout.trim()||'[]');
      context.log('pluto-restart-before-cleanup',{primary:String(error),priorPids:[...before],startingPids,
        currentPids:[...await serverPids(context)],status:await parent.locator('[role="status"]').innerText(),
        listener:{port,open:port?await portOpen(port):false,owners:listeners},credentialsOmitted:true});
    }catch(secondary){context.log('pluto-restart-diagnostic-error',{primary:String(error),secondary:String(secondary)});}
    throw error;
  }finally{await settings.update('plutoProject',previous,context.vscode.ConfigurationTarget.WorkspaceFolder);}
  const parent=await context.findFrame('#pluto-restart');await parent.locator('#pluto-restart').click();
  state=await view(context);await idle(state.frame);
  assert(await portOpen(Number(new URL(state.frame.url()).port)),'A later successful Restart remains alive');
  const finalOwner=process.platform==='win32'?await windowsSessionOwner(context,state):undefined;
  await stop(context,state,true);
  if(finalOwner)await eventually(async()=>{
    const actual=await windowsProcesses(context,'after-final-close');
    return finalOwner.descendants.every(prior=>!actual.rows.some(row=>row.pid===prior.pid&&row.createdAt===prior.createdAt));
  },'Final Close stops the exact listening session owner and observed descendants before teardown');
  context.proof('pluto-failed-restart-real-worker-cleanup',{failedPids:startingPids.length,
    failedIdentities:[...startingIdentities.values()].map(row=>({pid:row.pid,createdAt:row.createdAt})),
    nonReadyPhysicalOwnerVerified:process.platform==='win32',exactSuccessfulListenerOwnerVerified:!!finalOwner,
    observedDescendantIdentitiesGoneBeforeHarnessCleanup:!!finalOwner,
    newSessionUnaffected:true,staleIframeAbsent:true,remoteForwardingNotEmulated:true});
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
  const title = 'PerfChecker native reactive qualification';
  const editor = await interactiveEditor(context,state,cell,'investigation reactive title');
  await editor.click(); await editor.press('ControlOrMeta+A');
  context.log('native-ui-action',{surface:'Pluto investigation',action:'Edit reactive cell and evaluate'});
  await editor.pressSequentially(`md"# ${title}: $(4 + 5)"`); await editor.press('ControlOrMeta+Enter');
  await eventually(async () => (await fs.readFile(file, 'utf8')).includes(`md"# ${title}: $(4 + 5)"`), 'Reactive cell is saved as real Julia code');
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
  if(process.env.PERFCHECKER_NATIVE_BROWSER_ORACLE){
    const endpoint=process.env.PERFCHECKER_NATIVE_BROWSER_ORACLE,token=process.env.PERFCHECKER_NATIVE_BROWSER_TOKEN;
    const events=async()=>{const response=await fetch(`${endpoint}/events`,{headers:{authorization:`Bearer ${token}`}});assert.equal(response.status,200);return response.json();};
    const expect=async(kind)=>eventually(async()=>{const values=await events();assert(!values.some(value=>value.failed),JSON.stringify(values));return values.find(value=>value.kind===kind);},`Real default browser completes ${kind}`);
    const editorUrl=state.frame.url();
    await state.frame.locator('#at_the_top button.toggle_export').click();
    await state.frame.locator('#export a[href*="notebookfile?"]').click();
    const julia=await expect('julia-source-browser');assert(julia.editedExpression&&julia.credentialAbsent);
    assert.equal(state.frame.url(),editorUrl,'Julia export leaves the original VS Code editor in place');
    if(!((await state.frame.locator('#pluto-nav').getAttribute('class'))||'').includes('show_export'))await state.frame.locator('#at_the_top button.toggle_export').click();
    await state.frame.locator('#pluto-nav.show_export #export a[href*="notebookexport?"]').click();
    await state.frame.locator('.export-html-dialog .ple-download a[download]').click();
    const html=await expect('html-download');assert(html.embeddedJulia&&html.editedExpression&&html.credentialAbsent);
    assert.equal(state.frame.url(),editorUrl,'HTML export leaves the original VS Code editor in place');
    await state.frame.locator('img#logo-big').locator('..').click();await state.frame.locator('#recent').waitFor();
    await state.frame.locator('#recent li.new a').click({modifiers:['Control']});
    const modified=await expect('new-context-editor');assert.equal(modified.route,'/new');assert(modified.authenticatedWebSocket);
    assert.equal(new URL(state.frame.url()).pathname,'/','Modified New opens a separate real browser editor');
    const originalId=new URL(editorUrl).searchParams.get('id');
    await state.frame.locator(`#recent a[href*="id=${originalId}"]`).click();await state.frame.locator('pluto-notebook').waitFor();
    assert.equal(new URL(state.frame.url()).searchParams.get('id'),originalId,'Normal Recent navigation remains inside VS Code');
    await capture(context,'pluto-browser-exports-completed');
    context.proof('pluto-default-browser-exports',{source:'actual-installed-VSIX-env.openExternal-and-disposable-xdg-default-browser',
      parentOrigin:new URL(state.parent.url()).protocol,ordinaryNavigationInEditor:true,Julia:julia,HTML:html,modifiedNew:modified});
  }else context.log('pluto-default-browser-exports',{status:'skipped',reason:'Representative actual OS default-browser fixture requires disposable Linux stable; no human browser profile changes.'});
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
    let confirmed=false;
    const shutdownElapsed=await assertStopped(state,Number(shutdownInfo[0]),shutdownOwned,false,async()=>{
        await state.frame.locator('img#logo-big').locator('..').click();
        await eventually(()=>new URL(state.frame.url()).pathname==='/'&&state.frame.locator('#recent').isVisible(),'The real Pluto logo opens its authenticated homepage');
        const running=state.frame.locator('#recent li.running').filter({hasText:'ShutdownActiveAllocation.jl'});
        await running.locator('button').first().click();
        const confirmation=state.frame.getByRole('dialog',{name:'Pluto confirmation'});
        await confirmation.waitFor({state:'visible'});
        assert.equal(await confirmation.locator('p').innerText(),'Shut down notebook process?',
          'The real confirmation preserves Pluto 1.0.4\'s exact current translation');
        await capture(context,'pluto-homepage-shutdown-confirmation');
        await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();
        assert.equal(await running.count(),1,'Cancelling the actual confirmation preserves the notebook');
        assert.doesNotThrow(()=>process.kill(Number(shutdownInfo[0]),0),'Cancelling preserves the active allocation worker');
        assert(await fs.stat(shutdownOwned).then(stat=>stat.isDirectory()),'Cancelling preserves the active owned allocation directory');
        await running.locator('button').first().click();await confirmation.waitFor({state:'visible'});
        await confirmation.getByRole('button',{name:'Confirm',exact:true}).click();confirmed=true;
        await eventually(async()=>await running.count()===0,'The native Pluto homepage removes the stopped notebook');
    });
    assert(confirmed,'The actual visible confirmation was accepted through its native button');
    assert(await portOpen(Number(new URL(state.frame.url()).port)),'The homepage shuts down its notebook without stopping the shared Pluto server');
    context.proof('pluto-home-shutdown-active-allocation',{nativeClick:true,realConfirmation:true,cancelPreservedActiveWorker:true,
      inheritedVSCodeSandboxPreserved:true,cleanupMilliseconds:shutdownElapsed,pidTerminated:true,ownedFilesRemoved:true,noNewMem:true,preExistingMemPreserved:true});
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

function renderedPng(png){
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const chunks=[];let width,height,channels;
  for(let at=8;at<png.length;){
    const length=png.readUInt32BE(at),kind=png.toString('ascii',at+4,at+8),data=png.subarray(at+8,at+8+length);at+=length+12;
    if(kind==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);assert([2,6].includes(data[9]));channels=data[9]===6?4:3;assert.equal(data[12],0);}
    if(kind==='IDAT')chunks.push(data);
  }
  const raw=inflateSync(Buffer.concat(chunks)),stride=width*channels;
  assert.equal(raw.length,(stride+1)*height);
  let previous=Buffer.alloc(stride),colored=0,orange=0,orangeX=0,orangeY=0;const colors=new Map();
  const paeth=(a,b,c)=>{const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);return da<=db&&da<=dc?a:db<=dc?b:c;};
  for(let y=0;y<height;y++){
    const mode=raw[y*(stride+1)],row=Buffer.from(raw.subarray(y*(stride+1)+1,(y+1)*(stride+1)));assert(mode<=4);
    for(let x=0;x<stride;x++){const a=x>=channels?row[x-channels]:0,b=previous[x],c=x>=channels?previous[x-channels]:0;row[x]=(row[x]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][mode])&255;}
    for(let x=0;x<stride;x+=channels){const alpha=channels===4?row[x+3]:255;if(alpha===0)continue;const [r,g,b]=row.subarray(x,x+3),key=(r>>4)*256+(g>>4)*16+(b>>4);colors.set(key,(colors.get(key)||0)+1);if(Math.max(r,g,b)-Math.min(r,g,b)>25)colored++;
      // The canonical point inspector draws its highlight in Makie's :orange.
      if(r>=200&&g>=70&&g<=210&&b<=80&&r>g+25){orange++;orangeX+=x/channels;orangeY+=y;}}
    previous=row;
  }
  const channelsOf=key=>[key>>8,(key>>4)&15,key&15];
  const dominant=[...colors.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0],background=channelsOf(dominant||0);
  const highContrastPixels=[...colors.entries()].reduce((count,[key,pixels])=>count+
    (Math.max(...channelsOf(key).map((value,index)=>Math.abs(value-background[index])))>=4?pixels:0),0);
  return {width,height,quantizedColors:colors.size,coloredPixels:colored,highContrastPixels,dominantColorBin:dominant,
    highlight:orange>=10?{pixels:orange,x:orangeX/orange,y:orangeY/orange}:null,sha256:createHash('sha256').update(png).digest('hex')};
}

function assertDrawnFigure(pixels){
  assert(pixels.width>=300&&pixels.height>=200,'The native figure has a visible viewport');
  assert(pixels.highContrastPixels>1000&&pixels.coloredPixels>=10,
    'The canvas contains contrasted plotted ink and a chromatic marker, beyond blank, flat or monochrome axes');
}

function assertMovedHighlight(before,after){
  assert.equal(after.width,before.width);assert.equal(after.height,before.height);
  assert(before.highlight&&after.highlight,'Both actual screenshots contain the canonical orange point highlight');
  assert.notEqual(after.sha256,before.sha256,'A distinct measured point changes the actual canvas');
  assert(Math.hypot(after.highlight.x-before.highlight.x,after.highlight.y-before.highlight.y)>1,
    'The orange point changes position, rather than merely changing a readout or drawing a spinner');
}

function distinctMeasuredPoint(data){
  let selected=-1,distance=0;
  for(let index=1;index<data.values.length;index++){
    const next=data.versions[index]!==data.versions[0]?Infinity:Math.abs(data.values[index]-data.values[0]);
    if(next>distance){selected=index;distance=next;}
  }
  return selected;
}

async function drawnCanvas(context,canvas,label,movedFrom){
  let previousSha,pixels;
  return eventually(async()=>{
    const png=await canvas.screenshot(),sha=createHash('sha256').update(png).digest('hex');
    if(sha!==previousSha){
      const file=`native-${process.platform}-vscode-${context.vscode.version}-pluto-canvas-${label}-${sha.slice(0,16)}.png`;
      await fs.writeFile(path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,file),png);
      pixels=renderedPng(png);
      context.log('pluto-canvas-pixels-before-assertion',{label,file,pixels});
      previousSha=sha;
    }
    assertDrawnFigure(pixels);
    if(movedFrom)assertMovedHighlight(movedFrom,pixels);
    return pixels;
  },`The native ${label} WebGL figure draws measured evidence`,180000);
}

async function plotDocument(state,previous){
  const element=await eventually(async()=>{
    const frames=state.frame.locator('pluto-output iframe[data-perfchecker-plot-frame]');
    if(await frames.count()!==1)return false;
    const handle=await frames.elementHandle();
    const token=await handle.getAttribute('data-perfchecker-plot-frame');
    if(previous&&token===previous.token){await handle.dispose();return false;}
    return handle;
  },'The actual generator displays one fresh SuitePlotFrame document');
  const attributes=await element.evaluate(node=>({token:node.getAttribute('data-perfchecker-plot-frame'),id:node.id,
    title:node.title,sandbox:node.getAttribute('sandbox'),srcdoc:node.getAttribute('srcdoc')}));
  assert(attributes.token&&attributes.id===attributes.token,'The real frame carries its generator identity');
  assert(attributes.title.startsWith('Performance plot: '),'The generator provides an accessible plot title');
  assert.equal(attributes.sandbox,'allow-scripts','The real plot frame keeps its opaque origin sandbox');
  assert(attributes.srcdoc&&/<html[\s>]/i.test(attributes.srcdoc),'The frame contains the complete canonical standalone export');
  const frame=await element.contentFrame();assert(frame,'The actual srcdoc has its own browser document');
  assert.equal(frame.parentFrame(),state.frame);
  if(previous){
    assert.notEqual(frame,previous.frame,'Selecting another plot creates a different child document');
    await eventually(()=>previous.frame.isDetached(),'Pluto removes the previous plot document');
  }
  const canvas=frame.locator('#offline-figure canvas');
  await canvas.waitFor({state:'visible',timeout:360000});await canvas.scrollIntoViewIfNeeded();
  return {frame,canvas,token:attributes.token,title:attributes.title,
    htmlSha256:createHash('sha256').update(attributes.srcdoc).digest('hex')};
}

function observePlotFrontend(context,state){
  const page=state.frame.page(),events=[];
  const clean=value=>String(value).replace(/data:[^\s)]+/gi,'[inline module]')
    .replace(/([?&]secret=)[^&\s"'<>]*/gi,'$1[session secret]')
    .replace(/\b[a-f0-9]{64}\b/gi,'[opaque token]').slice(0,2000);
  const record=(kind,message)=>{if(events.length<80){const item={kind,message:clean(message)};events.push(item);context.log('pluto-plot-frontend-event',item);}};
  const onError=error=>record('pageerror',error.stack||error.message);
  const onConsole=message=>{if(['warning','error'].includes(message.type()))record(message.type(),message.text());};
  const onRequest=request=>{try{const url=new URL(request.url());if(url.origin===new URL(state.frame.url()).origin)
    record('requestfailed',`${url.pathname}: ${request.failure()?.errorText||'unknown'}`);}catch{}};
  page.on('pageerror',onError);page.on('console',onConsole);page.on('requestfailed',onRequest);
  return {
    snapshot:async stage=>{
      let timeout;
      try{
      const detail=await Promise.race([(async()=>{
      const inspect=()=>{
        const ids=[...document.querySelectorAll('[data-jscall-id]')].map(node=>node.getAttribute('data-jscall-id'));
        const counts=new Map();for(const id of ids)counts.set(id,(counts.get(id)||0)+1);
        const sessions=window.Bonito?.Sessions,queue=window.Bonito?.OBJECT_FREEING_LOCK;
        return {readyState:document.readyState,viewport:{width:innerWidth,height:innerHeight},bonitoLoaded:!!window.Bonito,queue:queue?{size:queue.size,pending:queue.pending,isPaused:queue.isPaused}:null,
          sessions:sessions?Object.entries(sessions.SESSIONS||{}).slice(0,80).map(([id,tuple])=>{
            const objects=Array.isArray(tuple)?tuple[0]:null,status=Array.isArray(tuple)?tuple[1]:null;
            return {id,status:['string','boolean'].includes(typeof status)?status:null,validTuple:Array.isArray(tuple),
              objects:objects&&typeof objects.size==='number'?objects.size:null,inDocument:!!document.getElementById(id)};
          }):[],
          objects:sessions?{total:Object.keys(sessions.GLOBAL_OBJECT_CACHE||{}).length,promises:Object.values(sessions.GLOBAL_OBJECT_CACHE||{}).filter(value=>value instanceof Promise).length}:null,
          jscallNodes:ids.length,duplicateJscallIds:[...counts].filter(([,count])=>count>1).slice(0,40),
          figures:document.querySelectorAll('#offline-figure').length,readouts:document.querySelectorAll('#point-readout').length,
          canvases:[...document.querySelectorAll('#offline-figure canvas')].map(node=>({width:node.width,height:node.height,connected:node.isConnected})),
          scripts:[...document.querySelectorAll('script')].map(node=>({type:node.type,inlineBytes:node.textContent.length,external:!!node.src})).slice(0,80)};
      };
      const notebook=await state.frame.evaluate(inspect),documents=[];
      for(const element of await state.frame.locator('iframe[data-perfchecker-plot-frame]').elementHandles()){
        const token=await element.getAttribute('data-perfchecker-plot-frame'),frame=await element.contentFrame();
        if(frame&&!frame.isDetached())documents.push({token,...await frame.evaluate(inspect)});
      }
      return {notebook,documents};
      })(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Read-only frontend diagnostic exceeded 2.5 seconds')),2500);})]);
      context.log('pluto-plot-frontend-state',{stage,...detail,events:[...events]});
      }catch(error){try{context.log('pluto-plot-frontend-diagnostic-failure',{stage,message:clean(error.message)});}catch{}}
      finally{clearTimeout(timeout);}
    },
    stop:()=>{page.off('pageerror',onError);page.off('console',onConsole);page.off('requestfailed',onRequest);}
  };
}

async function renderedPlots(context,state,selector,completedRoot){
  assert(state.source.includes('SuitePlotFrame(performance_plot_html(plot),'),
    'The installed companion generates the real isolated renderer; the driver does not wrap an older export');
  const frontend=observePlotFrontend(context,state);
  try{
  await frontend.snapshot('before-selection');
  const reportsBefore=await fingerprint(completedRoot);
  const options=await selector.locator('option').evaluateAll(nodes=>nodes.map(node=>({value:node.value,label:node.textContent})));
  context.log('pluto-plot-catalog-ui',{options});
  // PlutoUI may encode the DOM value as puiselect-N; its bond maps that
  // opaque value back to the real Julia catalogue ID.
  const distribution=options.find(option=>option.label.endsWith(' · Sample distribution'));
  const trajectory=options.find(option=>option.label.endsWith(' · Version trajectory'));
  assert(distribution&&trajectory,'Real measured samples provide distribution and version-series entries');
  await selector.selectOption(distribution.value);await idle(state.frame);
  // Inspect the actual running notebook through a user-edited diagnostic cell.
  // The generated rendering cell and measured bundle remain untouched.
  const cell=state.frame.locator(`pluto-cell[id="${cellId(state.source,'## Performance curves')}"]`);
  const editor=await interactiveEditor(context,state,cell,'measured plot diagnostic');
  const diagnostic=`let p = performance_plot(plot_bundle, selected_plot), modules = Dict(k.name => m for (k,m) in Base.loaded_modules)
    @assert all(haskey(modules,n) for n in ("PerfCheckerMakie","WGLMakie","Makie","Bonito"))
    @assert Base.get_extension(modules["PerfCheckerMakie"],:WGLMakieExt) !== nothing
    f = performance_figure(p)
    @assert f isa getfield(modules["Makie"],:Figure)
    entry = only(filter(entry -> entry["id"] == selected_plot, plot_entries))
    info = Dict("selected"=>selected_plot,"selectedLabel"=>entry["title"] * " · " * entry["label"],"kind"=>string(p.kind),"values"=>[row["value"] for row in p.data],"versions"=>[row["version"] for row in p.data],"unit"=>p.options["unit"],"figure"=>string(typeof(f)),"extension"=>true,"providers"=>Dict(n=>Dict("version"=>string(Base.pkgversion(modules[n])),"source"=>pathof(modules[n])) for n in ("PerfCheckerMakie","WGLMakie","Makie","Bonito")))
    HTML("<pre id=\\"native-plot-evidence\\" hidden>" * replace(sprint(PerfChecker.JSON.print,info),"&"=>"&amp;","<"=>"&lt;",">"=>"&gt;") * "</pre>")
end`;
  await editor.click();await editor.press('ControlOrMeta+A');await editor.pressSequentially(diagnostic);await editor.press('ControlOrMeta+Enter');
  await ready(state.frame,'Launch selected checks');
  const evidence=async()=>eventually(async()=>{const raw=await cell.locator('#native-plot-evidence').textContent();return raw&&JSON.parse(raw);},'The real Pluto worker exposes loaded providers and measured plot data',360000);
  const data=await evidence();assert.equal(data.kind,'distribution');assert(data.selected.startsWith('distribution-'));assert.equal(data.selectedLabel,distribution.label);assert(data.values.length>=2);
  for(const [name,version] of Object.entries({PerfCheckerMakie:'1.0.0',WGLMakie:'0.13.15',Makie:'0.24.15',Bonito:'4.2.0'}))assert.equal(data.providers[name].version,version);
  const firstDocument=await plotDocument(state),canvas=firstDocument.canvas;
  const gpu=await canvas.evaluate(node=>{const gl=node.getContext('webgl2')||node.getContext('webgl');if(!gl||gl.isContextLost())return null;const debug=gl.getExtension('WEBGL_debug_renderer_info');return {version:gl.getParameter(gl.VERSION),renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};});
  assert(gpu,'The rendered native canvas has a live WebGL context');
  const before=await drawnCanvas(context,canvas,'distribution');
  await frontend.snapshot('distribution-drawn');
  const slider=firstDocument.frame.getByRole('slider',{name:'Inspect measured point'});
  const distinct=distinctMeasuredPoint(data);
  const selectedIndex=distinct<0?1:distinct;
  await slider.focus();for(let step=0;step<selectedIndex;step++)await slider.press('ArrowRight');
  const expected=`Point ${selectedIndex+1}: ${data.values[selectedIndex]} ${data.unit} · ${data.versions[selectedIndex]}`;
  await eventually(async()=>await firstDocument.frame.locator('#point-readout').innerText()===expected,'A real native slider gesture inspects the chosen measured sample');
  const after=await drawnCanvas(context,canvas,'highlight',distinct<0?undefined:before);
  await frontend.snapshot('distribution-point-inspected');
  await capture(context,'pluto-rendered-distribution');
  await selector.selectOption(trajectory.value);await ready(state.frame,'Launch selected checks');
  const second=await eventually(async()=>{const current=await evidence();return current.selectedLabel===trajectory.label&&current;},'The real plot selector regenerates the version-series figure');
  assert.equal(second.kind,'version_series');assert(second.selected.startsWith('version-series-'));
  const secondDocument=await plotDocument(state,firstDocument);
  await eventually(async()=>{
    const text=await secondDocument.frame.locator('#point-readout').innerText(),match=/^Point 1: (\S+) (.*?) · (.*)$/.exec(text);
    return match&&Number(match[1])===second.values[0]&&match[2]===second.unit&&match[3]===second.versions[0];
  },'The newly rendered trajectory inspector identifies its actual measured value');
  await frontend.snapshot('trajectory-readout-ready');
  const trajectoryPixels=await drawnCanvas(context,secondDocument.canvas,'trajectory');
  await capture(context,'pluto-rendered-version-series');
  await selector.selectOption(distribution.value);await ready(state.frame,'Launch selected checks');
  const returned=await eventually(async()=>{const current=await evidence();return current.selectedLabel===distribution.label&&current;},'The real selector returns to the original measured distribution');
  assert.deepEqual(returned.values,data.values);assert.deepEqual(returned.versions,data.versions);
  const returnedDocument=await plotDocument(state,secondDocument);
  assert.notEqual(returnedDocument.token,firstDocument.token,'Even a cached plot creates a new document identity');
  assert.equal(returnedDocument.htmlSha256,firstDocument.htmlSha256,'The unchanged cached HTML is reused without patching queues or providers');
  await eventually(async()=>await returnedDocument.frame.locator('#point-readout').innerText()===`Point 1: ${data.values[0]} ${data.unit} · ${data.versions[0]}`,
    'The returned document starts with its own initial inspector state');
  const returnedPixels=await drawnCanvas(context,returnedDocument.canvas,'distribution-returned');
  await frontend.snapshot('distribution-returned');
  // Keep the allocation plot, including legitimate coincident samples. A
  // separately measured wall-time series can qualify actual marker movement.
  const timing=options.find(option=>option.label.includes(' · julia.wall.time · ')&&option.label.endsWith(' · Sample distribution'));
  assert(timing,'Interactive plot qualification requires the real measured wall-time distribution');
  let temporalInteraction;
  {
    await selector.selectOption(timing.value);await ready(state.frame,'Launch selected checks');
    const temporal=await eventually(async()=>{const current=await evidence();return current.selectedLabel===timing.label&&current;},'The actual measured wall-time distribution is selected');
    assert.equal(temporal.kind,'distribution');assert(temporal.selected.startsWith('distribution-'));assert(temporal.values.length>=2);
    const temporalDocument=await plotDocument(state,returnedDocument),temporalCanvas=temporalDocument.canvas;
    const initial=await drawnCanvas(context,temporalCanvas,'wall-time');
    const point=distinctMeasuredPoint(temporal);
    assert(point>=0,'The measured wall-time coordinates coincide; required pixel movement cannot be qualified');
    const index=point;
    const temporalSlider=temporalDocument.frame.getByRole('slider',{name:'Inspect measured point'});
    await temporalSlider.focus();for(let step=0;step<index;step++)await temporalSlider.press('ArrowRight');
    const readout=`Point ${index+1}: ${temporal.values[index]} ${temporal.unit} · ${temporal.versions[index]}`;
    await eventually(async()=>await temporalDocument.frame.locator('#point-readout').innerText()===readout,'A native gesture inspects the actual wall-time sample');
    const moved=await drawnCanvas(context,temporalCanvas,'wall-time-highlight',initial);
    await capture(context,'pluto-rendered-wall-time-highlight');
    temporalInteraction={available:true,selected:temporal.selected,measuredSamples:temporal.values.length,nativeKeyboard:true,
      observedReadout:readout,selectedSample:index+1,canvasMovementQualified:true,document:{token:temporalDocument.token,htmlSha256:temporalDocument.htmlSha256},pixels:{initial,highlight:moved}};
  }
  assert.deepEqual(await fingerprint(completedRoot),reportsBefore,'Plotting and point inspection do not rerun measurements or save reports');
  context.proof('pluto-rendered-measured-plots',{providerVersions:Object.fromEntries(Object.entries(data.providers).map(([name,item])=>[name,item.version])),extensionLoaded:data.extension,figureType:data.figure,actualMeasuredSamples:data.values.length,selectedKinds:[data.kind,second.kind,returned.kind],
    documents:[firstDocument,secondDocument,returnedDocument].map(item=>({token:item.token,title:item.title,htmlSha256:item.htmlSha256})),previousDocumentsDetached:true,cachedExportReused:true,
    webgl:gpu,pixels:{distribution:before,highlight:after,trajectory:trajectoryPixels,returnedDistribution:returnedPixels},pointInteraction:{nativeKeyboard:true,observedReadout:expected,selectedSample:selectedIndex+1,distinctPosition:distinct>=0,canvasMovementQualified:distinct>=0,coincidentSamples:distinct<0?'All (version,value) coordinates coincide; readout verified, no movement claimed':null},temporalInteraction,reportsUnchanged:true,source:'Actual installed VSIX, generated SuitePlotFrame srcdoc, real Julia measurement and native Pluto WebGL; software renderer only'});
  }finally{
    await frontend.snapshot('before-cleanup');
    frontend.stop();
  }
}

async function suite(context, directory, requirePlots=false) {
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
  if(requirePlots){
    assert.equal(plotted,0,'The positive qualification requires the real plot provider');
    await renderedPlots(context,state,plots,root);
  }else if (plotted) {
    context.log('pluto-plot-prerequisite', {available: false, reason: 'Install PerfCheckerMakie and WGLMakie in the separate notebook environment'});
  } else {
    const document=await plotDocument(state);
    assert(await document.canvas.count() > 0, 'An available WGLMakie provider renders inside its actual plot document');
    context.log('pluto-rendered-plot', {available: true, canvas: true,documentToken:document.token});
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

exports.runPlots = async context => {
  assert.equal(process.env.CI,'true','Never use a human VS Code installation');
  const session=process.env.PERFCHECKER_NATIVE_SESSION;
  assert(session&&path.isAbsolute(session));
  assert.equal(await fs.realpath(context.workspace),path.join(await fs.realpath(session),'workspace'));
  const directory=path.join(context.workspace,'perf','notebooks');await fs.mkdir(directory,{recursive:true});
  try{await suite(context,directory,true);}
  catch(error){await capture(context,'pluto-rendered-plots-failed');throw error;}
  finally{await context.vscode.commands.executeCommand('perfchecker.stopNotebookSession',context.vscode.Uri.file(context.workspace));}
};
