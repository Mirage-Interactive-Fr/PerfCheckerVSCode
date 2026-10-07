// Real public VSIX controls, real General Julia workers, and disposable CI fixtures only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {clickStudioAction}=require('./native-studio-controls.cjs');
const {createHash} = require('node:crypto');

const reportNames = {discover: 'discovery', run: 'run', diagnose: 'diagnosis',
  advise: 'advice', compare: 'comparison', tools: 'tools', sync: 'sync', investigate: 'investigation'};

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

async function view(context) {
  await context.vscode.commands.executeCommand('perfchecker.openInvestigations');
  const result = await context.findFrame('#app nav[aria-label="Investigation views"]');
  await result.locator('#app .status').waitFor({state: 'visible'});
  return result;
}

async function tab(context, name) {
  const result = await view(context);
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
  const found = await eventually(async () => {
    for (const name of await directories(root)) {
      if (before.has(name)) continue;
      const location = path.join(root, name, `${reportNames[action]}.json`);
      try {return {report: JSON.parse(await fs.readFile(location, 'utf8')), location, directory: path.dirname(location)};}
      catch (error) {if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;}
    }
    return false;
  }, `real Julia ${action} report`, timeout);
  const current = await view(context);
  await eventually(async () => !(await current.locator('#app .status').getAttribute('class')).includes('busy'), `${action} controller completes cleanup`, timeout);
  assert.equal(await current.getByRole('button', {name: 'Cancel', exact: true}).isDisabled(), true);
  return found;
}

async function action(context, label, name) {
  const before = await directories(reportRoot(context));
  const current = await view(context);
  await current.getByRole('button', {name: label, exact: true}).click();
  return reportAfter(context, before, name);
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
  const current = await tab(context, 'Findings & advice');
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
  const result = await action(context, 'Diagnose selected', 'diagnose');
  assert.equal(result.report.schema_version, 'perfchecker-diagnosis/1');
  for (const tool of tools) {
    const records = result.report.records.filter(record => record.tool === tool);
    assert.equal(records.length, 1, `${tool} has one actual worker result`);
    const record = records[0];
    assert(['complete', 'unavailable'].includes(record.status), `${tool} does not hide errors, invalid evidence, timeout or cancellation as a prerequisite`);
    if (record.status === 'complete') assert.equal(record.correctness, 'passed', `${tool} execution returns valid diagnosis evidence`);
    if (record.status === 'unavailable') assert(String(record.message || '').trim(), `${tool} unavailable status explains its prerequisite`);
    if (['latency', 'gc', 'memory'].includes(tool)) assert.equal(record.status, 'complete', `${tool} built-in worker actually executes`);
    if (['heap','locks'].includes(tool) && record.status === 'unavailable') assert.match(String(record.message), tool === 'heap' ? /snapshot|redact|unsupported|not supported|runtime/i : /counter|1\.11|not exposed|unsupported|runtime/i, `${tool} has a concrete runtime prerequisite`);
    context.proof(`investigation-analyzer-${tool}`, {status: record.status, correctness: record.correctness, version: record.tool_version, prerequisite: record.status === 'complete' ? undefined : record.message});
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

exports.run = async context => {
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
    for (const [name, callback] of [
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
    ]) {
      try {await callback();}
      catch (error) {failures.push(new Error(`${name}: ${error.message}`, {cause: error})); context.log(`investigation-${name}-failed`, {message: error.message});}
    }
  } finally {
    await context.vscode.commands.executeCommand('perfchecker.cancelInvestigation').catch(() => {});
    try {
      const current = await view(context);
      await eventually(async () => !(await current.locator('#app .status').getAttribute('class')).includes('busy'), 'Investigation teardown waits for worker cleanup', 120000);
    } catch (error) {failures.push(new Error(`investigation-teardown: ${error.message}`, {cause: error}));}
    await fs.writeFile(catalog, originalCatalog);
    await fs.rm(path.join(context.workspace, 'perf', 'native-investigation-running.marker'), {force: true});
    for (const key of keys) await configuration(context).update(key, previous[key], context.vscode.ConfigurationTarget.WorkspaceFolder);
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} real investigation control groups failed`);
};
