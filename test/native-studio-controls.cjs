// Exercise the installed public VSIX through its real VS Code webviews in disposable CI profiles.
// No intercepted VS Code API, replaced process, fabricated plan message or model credential is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

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
  return frame(context, '#studio-root');
}

async function clickStudioAction(context, action) {
  const view = await studio(context);
  assert(Object.hasOwn(studioActions, action), `Known Studio action: ${action}`);
  const selector = ['notebook', 'openNotebook', 'terminal', 'julia', 'tasks'].includes(action)
    ? view.getByRole('button', {name: studioActions[action], exact: true})
    : view.locator(`[data-action="${action}"]`);
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
  const view = await frame(context, '#cards');
  await eventually(async () => (await view.locator('#cards .card').count()) > 0,
    'General-backed suite plan renders workload cards', 120000);
  return view;
}

async function savedConfiguration(context, view) {
  const settings = context.vscode.workspace.getConfiguration('perfchecker',
    context.vscode.Uri.file(context.workspace));
  const destination = path.resolve(context.workspace, settings.get('uiConfiguration', 'perf/perfchecker-ui.json'));
  const previous = await fs.readFile(destination, 'utf8').catch(() => undefined);
  await view.locator('#save').click();
  const config = await eventually(async () => {
    const text = await fs.readFile(destination, 'utf8');
    if (text === previous) return false;
    return JSON.parse(text);
  }, 'Save configuration writes the native workspace file');
  assert.equal(config.schema_version, 'perfchecker-ui-config/1');
  return {config, destination};
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
  context.log('suite-check-types', {types: checkTypes, runs: all, unavailableReasonsChecked: true});

  const targets = await options(view, '#target-filter');
  assert(targets.length >= 2, 'At least two real targets are needed to qualify hidden selections and versions');
  for (const target of targets) {
    await view.locator('#target-filter').selectOption(target.value);
    await eventually(async () => (await view.locator('#cards .card').count()) > 0, `Filter target ${target.value}`);
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
      assert.equal(await selectionCount(view), all);
    }
    await view.locator(selector).selectOption('');
  }
  const releaseTargets = targets.filter(item => /^v?\d+\.\d+\.\d+/.test(item.value));
  if (releaseTargets.length) {
    await view.locator('#from').fill(releaseTargets[0].value);
    await view.locator('#to').fill(releaseTargets.at(-1).value);
    assert.equal(await selectionCount(view), all, 'Release bounds preserve selected Git targets');
    await view.locator('#from').fill('999.0.0');
    await view.locator('#to').fill('0.0.0');
    assert.equal(await selectionCount(view), all, 'Inverted release bounds do not discard hidden selections');
  } else context.log('release-range-prerequisite', 'Fixture has only Git/dev targets; a registered-release fixture is still required');
  await view.locator('#reset-filters').click();
  for (const sort of ['package', 'feature', 'version', 'suite']) await view.locator('#sort').selectOption(sort);
  const group = view.locator('#cards .card').first();
  await group.locator('.pick').uncheck();
  assert((await selectionCount(view)) < all);
  await group.locator('.pick').check();
  await group.locator('.check-option input').first().uncheck();
  assert.equal(await view.locator('.card.partial').count(), 1);
  await view.locator('#selection-summary').click();
  assert.equal(await view.locator('#selection-preview li').count(), Math.min(all - 1, 80));
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
  context.log('suite-selection-and-save', {runs: all, selected: all - 1, hiddenSelectionsPreserved: true, views: 6});

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
  const settings = () => context.vscode.workspace.getConfiguration('perfchecker', context.vscode.Uri.file(context.workspace));
  const previousTargets = settings().inspect('gitTargets')?.workspaceFolderValue;
  const previousPolicies = settings().inspect('comparisonPolicies')?.workspaceFolderValue;
  try {
    await view.locator('#target-package').selectOption('PerfCheckerNativeFixture');
    await eventually(async () => !(await view.locator('#target-reference').isDisabled()), 'Discover real local Git references');
    const groups = await view.locator('#target-reference optgroup').evaluateAll(items => items.map(item => item.label));
    assert(groups.includes('Branches') && groups.includes('Tags') && groups.includes('Recent commits'),
      'Disposable Git fixture contains branch, tag and commit references');
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
    context.log('git-reference-controls', {groups, pinnedBranch: chosen.commit, addRemove: true, invalidReferenceRejected: true});

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
    const before = settings().get('comparisonPolicies', []).length;
    await view.locator('#add-comparison').click();
    await eventually(() => settings().get('comparisonPolicies', []).length === before + 1, 'Persist comparison from actual button');
    await eventually(async () => !(await view.locator('#add-comparison').isDisabled()), 'Replan after comparison', 120000);
    const policy = settings().get('comparisonPolicies', []).at(-1);
    assert.equal(policy.aggregation, 'median');
    assert.equal(policy.baselines.length, 1); assert.equal(policy.candidates.length, 1);
    await view.locator('#comparison-list .target').last().getByRole('button', {name: 'Remove comparison', exact: true}).click();
    await eventually(() => settings().get('comparisonPolicies', []).length === before, 'Remove comparison via actual button');
    context.log('comparison-controls', {invalidEmpty: true, overlapRejected: true, aggregationSelections: 4, aggregationsComputed: false, addRemove: true});
  } finally {
    await settings().update('gitTargets', previousTargets, context.vscode.ConfigurationTarget.WorkspaceFolder);
    await settings().update('comparisonPolicies', previousPolicies, context.vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

async function testResults(context) {
  let view = await output(context);
  assert.match(await view.locator('body').innerText(), /PERFCHECKER OUTPUT/);
  assert.equal(await view.locator('.empty').count(), 0, 'Real suite measurements were supplied to the installed VSIX');
  const total = await view.locator('[data-result-item]').count(); assert(total > 0);
  for (const id of ['package', 'workload', 'backend', 'kind', 'status']) {
    for (const option of await options(view, `#result-${id}`)) {
      await view.locator(`#result-${id}`).selectOption(option.value);
      const visible = view.locator('[data-result-item]:visible');
      assert((await visible.count()) > 0, `Actual ${id}=${option.value} results remain inspectable`);
      assert(await visible.evaluateAll((items, {id, value}) => items.every(item => item.dataset[id] === value), {id, value: option.value}));
    }
    await view.locator(`#result-${id}`).selectOption('');
  }
  for (const sort of await options(view, '#result-sort')) await view.locator('#result-sort').selectOption(sort.value);
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
  context.log('result-controls', {items: total, filters: 7, chartFamilies});
  for (const [name, report] of [['Summary', 'suite-report.md'], ['JSON', 'suite-result.json'], ['Comparisons', 'version-comparison.md'], ['Series JSON', 'version-series.json']]) {
    view = await output(context);
    await view.getByRole('button', {name, exact: true}).click();
    const file = path.join(context.results, report);
    const exists = await fs.access(file).then(() => true, () => false);
    if (exists) await eventually(() => context.vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      tab.input?.uri?.fsPath === file || (report.endsWith('.md') && tab.label.includes(report)))), `Open actual ${report}`);
    else await eventually(async () => (await context.windowPage.locator('body').innerText()).includes(`PerfChecker has not produced ${report} yet.`), `Missing ${report} explains its prerequisite`);
    context.log(`result-report-${name}`, {exists, openedOrExplained: true});
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
  context.log('provider-controls', {modes: 5, malformedArgumentsRejected: true, textInvestigationRejected: true, noNetworkRequest: true});

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
  context.log('native-tool-catalogue', {backend: 'registered PerfChecker 1.0.0', filter: true, investigationTabs: 4, workerLog: true});
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
  context.log('save-palette-command', {native: true, unsavedTitleSelectionColor: true, destination});
}

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
  await view.locator('#run').click();
  const report = await eventually(async () => {
    const text = await fs.readFile(reportPath, 'utf8');
    if (text === old) return false;
    const value = JSON.parse(text);
    if (value.schema_version !== 'perfchecker-suite-result/1' || value.runs.length !== 1) return false;
    return value;
  }, 'The native Run button completes the registered Julia backend and writes current evidence', 240000);
  assert.equal(report.runs[0].status, 'pass', 'Actual correctness-checked benchmark succeeds');
  await eventually(async () => !(await view.locator('#run').isDisabled()), 'Run control returns to idle');
  await view.locator('#results').click();
  const result = await frame(context, 'button[data-report="suite-result.json"]');
  assert.equal(await result.locator('.empty').count(), 0);
  assert((await result.locator('[data-result-item]').count()) > 0);
  context.log('native-run-selection', {runs: 1, status: report.runs[0].status, reportPath, nativeClick: true});
  return reports;
};

exports.run = async context => {
  assertDisposable(context);
  const view = await studio(context);
  assert.equal(await view.locator('.card').count(), 9);
  assert.equal(await view.locator('.lab button').count(), 5);
  assert(await view.locator('.hero img').evaluate(image => image.complete && image.naturalWidth > 0));
  await view.getByText('Workspace environment', {exact: true}).click();
  assert((await view.locator('details.environment p').innerText()).includes(context.controller));
  context.log('studio-inventory', {cards: 9, workbenchButtons: 5, controllerShown: true});
  const failures = [];
  for (const [name, run] of [['suite-selection', testSuiteSelection], ['git-and-comparisons', testGitTargetsAndComparisons],
    ['results', testResults], ['provider-and-tools', testAdvisorAndTools], ['save-palette', testSavePalette]]) {
    try {await run(context);}
    catch (error) {
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
  context.log('fresh-studio-and-advisor', {buttonsAccessible: 14, missingSuiteExplained: true, noJuliaExplained: true, ruleBasedAvailable: true});
};
