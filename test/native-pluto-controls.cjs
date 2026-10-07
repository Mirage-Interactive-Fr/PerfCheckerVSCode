// Actual VS Code webviews and Pluto workers in disposable CI workspaces only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {createHash} = require('node:crypto');

async function eventually(read, name, timeout = 180000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {const result = await read(); if (result) return result;} catch (error) {last = error;}
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
  if (closePanel) await context.vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  else await state.parent.locator('#pluto-stop').click();
  await eventually(async () => !await portOpen(port), 'Closing Pluto also closes its server and workers', 45000);
}

async function create(context, file, kind) {
  const uri = await context.vscode.commands.executeCommand('perfchecker.newNotebook', context.vscode.Uri.file(file), {kind});
  assert.equal(uri.fsPath, file);
  const source = await fs.readFile(file, 'utf8');
  assert(source.startsWith('### A Pluto.jl notebook ###'));
  assert(!source.includes('jupyter-notebook'));
  return {source, ...await view(context)};
}

async function investigation(context, directory) {
  const file = path.join(directory, 'NativeInvestigation.jl');
  const reportRoot = path.join(context.workspace, 'perf', 'results', 'notebook');
  const before = await fingerprint(reportRoot);
  let state = await create(context, file, 'investigation');
  assert.equal(await state.frame.locator('pluto-cell').count(), 63, 'The actual official investigation dashboard is loaded');
  for (const name of ['Launch selected action', 'Cancel active investigation', 'Refresh status and evidence',
    'Execute selected setup action', 'Cancel advisor setup', 'Refresh advisor setup / model inventory', 'Compare saved measurements']) {
    assert(await state.frame.getByRole('button', {name, exact: true}).isVisible(), `Real Pluto control: ${name}`);
  }
  await state.frame.locator('bond[def="action"] select').selectOption('run');
  await state.frame.locator('bond[def="selected"] select').selectOption('1');
  await idle(state.frame);
  assert.deepEqual(await fingerprint(reportRoot), before, 'Opening and selecting cannot execute measurements');
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
  }
  const snapshot = `pluto-cell[id="${cellId(state.source, 'snapshot = (refresh_click;')}"] pluto-output`;
  await refresh(state.frame, 'Refresh status and evidence', snapshot, /\bcomplete\b/);
  const completed = await fingerprint(reportRoot);
  await state.frame.locator('bond[def="action"] select').selectOption('tools');
  await idle(state.frame);
  assert.deepEqual(await fingerprint(reportRoot), completed, 'Changing selectors after completion cannot rerun the check');
  context.log('pluto-investigation-real-run', {collectors: [...new Set(report.runs.map(run => run.collector))], core: 'General 1.0.0'});

  // Use the real CodeMirror editor, reactive evaluation and Pluto's on-disk autosave.
  const id = cellId(state.source, '# PerfChecker investigations');
  const cell = state.frame.locator(`pluto-cell[id="${id}"]`);
  await cell.scrollIntoViewIfNeeded();
  const title = 'PerfChecker native reactive qualification';
  const editor = cell.locator('.cm-content[contenteditable="true"]');
  if (!await editor.isVisible()) await cell.locator('.foldcode').click();
  await editor.click(); await editor.press('ControlOrMeta+A');
  await editor.pressSequentially(`md"# ${title}"`); await editor.press('ControlOrMeta+Enter');
  await eventually(async () => (await fs.readFile(file, 'utf8')).includes(`md"# ${title}"`), 'Reactive cell is saved as real Julia code');
  await eventually(async () => (await cell.locator('pluto-output').innerText()).includes(title), 'Reactive output changes');
  await state.frame.goto(state.frame.url());
  state = await view(context);
  await eventually(async () => (await state.frame.locator(`pluto-cell[id="${id}"] pluto-output`).innerText()).includes(title), 'Saved cell survives a real iframe reload');
  await state.parent.locator('#pluto-source').click();
  await eventually(() => context.vscode.window.activeTextEditor?.document.uri.fsPath === file, 'Open source opens the actual generated .jl');
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
  context.log('pluto-reactive-save-reload-close', {source: path.basename(file), workersClosed: true});
}

async function cancellation(context, directory) {
  const settings = context.vscode.workspace.getConfiguration('perfchecker', context.vscode.Uri.file(context.workspace));
  const previous = settings.get('scenarioCatalog', 'perf/scenarios.toml');
  const catalog = path.join(directory, 'NativeCancellation.toml'), marker = path.join(directory, 'worker-running.marker');
  await fs.writeFile(catalog, 'schema_version="perfchecker-scenario-catalog/1"\nroot=".."\n[[scenarios]]\nid="pluto_cancel"\nimplementation="active-worker"\nsource="cases.jl"\nfactory="make_cancel_case"\ncollectors=["benchmark"]\n[scenarios.parameters]\nmarker=' + JSON.stringify(marker) + '\n');
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
    context.log('pluto-cancel-active-worker', {workerReached: true, cancelled: true, serverClosed: true});
  } finally {
    await context.vscode.commands.executeCommand('perfchecker.stopNotebookSession', context.vscode.Uri.file(context.workspace));
    await settings.update('scenarioCatalog', previous, context.vscode.ConfigurationTarget.WorkspaceFolder);
    await fs.unlink(marker).catch(error => {if (error.code !== 'ENOENT') throw error;});
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
  await state.frame.getByRole('button', {name: 'Launch selected checks', exact: true}).click();
  await refresh(state.frame, 'Refresh status', '[data-suite-state]', /\bcomplete\b/);
  assert.deepEqual(await fingerprint(root), before, 'Reports are saved only on the explicit Save action');
  await state.frame.getByRole('button', {name: 'Save completed reports', exact: true}).click();
  const saved = await eventually(async () => {
    for (const name of await files(root)) {
      if (!name.endsWith(`${path.sep}suite-result.json`) || before[path.relative(root, name)]) continue;
      return {file: name, data: JSON.parse(await fs.readFile(name, 'utf8'))};
    }
  }, 'Save completed reports writes an actual measured bundle');
  assert.equal(saved.data.schema_version, 'perfchecker-suite-result/1');
  assert.equal(saved.data.runs.length, 1, 'Package/workload/collector/target filters determine the measured plan');
  assert.equal(saved.data.runs[0].status, 'pass');
  assert.equal(saved.data.runs[0].qualification.correctness.status, 'passed');
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
  context.log('pluto-suite-select-launch-save', {checks: saved.data.runs.length, report: path.relative(context.workspace, saved.file)});
}

exports.run = async context => {
  assert.equal(process.env.CI, 'true', 'Never use a human VS Code installation');
  assert(path.basename(path.dirname(context.workspace)).startsWith('perfchecker-public-vsix-'));
  const directory = path.join(context.workspace, 'perf', 'notebooks');
  await fs.mkdir(directory, {recursive: true});
  const failures = [];
  for (const [name, test] of [['investigation', investigation], ['cancellation', cancellation], ['suite', suite]]) {
    try {await test(context, directory);}
    catch (error) {
      const message = error.message.replace(/([?&]secret=)[^&\s"<>]+/g, '$1[redacted]');
      failures.push(new Error(`${name}: ${message}`));
      context.log(`pluto-${name}`, {status: 'failed', message});
    }
    finally {await context.vscode.commands.executeCommand('perfchecker.stopNotebookSession', context.vscode.Uri.file(context.workspace));}
  }
  if (failures.length) throw new AggregateError(failures, 'Actual Pluto controls failed');
};
