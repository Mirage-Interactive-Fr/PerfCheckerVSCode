// Native installed-VSIX clicks and real Julia evidence; HTTP replies are a declared protocol fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {createHash, randomUUID} = require('node:crypto');

const marker = 'Controlled protocol fixture: collect more comparable samples before drawing a performance conclusion.';
const customInstructions = 'Native qualification instruction: distinguish measured allocation evidence from hypotheses.';
const names = {discover: 'discovery', run: 'run', narrate: 'narrative'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(read, description, timeout = 180000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {const result = await read(); if (result) return result;} catch (error) {last = error;}
    await sleep(100);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}

function configuration(context) {
  return context.vscode.workspace.getConfiguration('perfchecker', context.vscode.Uri.file(context.workspace));
}

async function view(context) {
  await context.vscode.commands.executeCommand('perfchecker.openInvestigations');
  return context.findFrame('#app nav[aria-label="Investigation views"]');
}

async function tab(context, name) {
  const frame = await view(context);
  await frame.getByRole('button', {name, exact: true}).click();
  await eventually(async () => await frame.getByRole('button', {name, exact: true}).getAttribute('aria-current') === 'page', name);
  return frame;
}

async function directories(root) {
  return new Set(await fs.readdir(root).catch(error => {if (error.code === 'ENOENT') return []; throw error;}));
}

async function idle(context) {
  const frame = await view(context);
  await eventually(async () => !(await frame.locator('#app .status').getAttribute('class')).includes('busy'), 'native controller finishes cleanup', 240000);
  assert(await frame.getByRole('button', {name: 'Cancel', exact: true}).isDisabled());
  return frame;
}

async function reportAfter(context, root, before, action) {
  const result = await eventually(async () => {
    for (const id of await directories(root)) {
      if (before.has(id)) continue;
      const location = path.join(root, id, `${names[action]}.json`);
      try {return {id, directory: path.dirname(location), location, report: JSON.parse(await fs.readFile(location, 'utf8'))};}
      catch (error) {if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;}
    }
    return false;
  }, `real Julia ${action} report`, 360000);
  await idle(context);
  return result;
}

async function action(context, root, label, name) {
  const before = await directories(root);
  const frame = await view(context);
  await frame.getByRole('button', {name: label, exact: true}).click();
  return reportAfter(context, root, before, name);
}

async function fixtureServer(token) {
  const state = {mode: 'respond', requests: [], errors: [], sockets: new Set(), blocked: undefined};
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${token}`, 'Only the sacrificial environment token reaches the owned fixture');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {size += chunk.length; assert(size < 1_000_000); chunks.push(chunk);}
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, 'perfchecker-native-narrative-fixture');
      assert.equal(body.stream, false);
      assert.equal(body.response_format.type, 'json_schema');
      assert(body.messages.find(message => message.role === 'system')?.content.startsWith(customInstructions + '\n\n'),
        'The actual Julia HTTP request prepends the configured nonempty instruction');
      const user = body.messages.find(message => message.role === 'user');
      assert(user && typeof user.content === 'string');
      const projection = JSON.parse(user.content);
      assert(projection.evidence.length > 0, 'Narration must receive real deterministic evidence');
      assert.deepEqual(projection.allowed_experiments, []);
      const ids = projection.evidence.map(row => row.id);
      assert(ids.every(id => typeof id === 'string' && id.length));
      assert.deepEqual(body.response_format.json_schema.schema.properties.cards.items.properties.evidence_id.enum, ids);
      const record = {body, projection, ids, mode: state.mode};
      state.requests.push(record);
      if (state.mode === 'hold') {
        record.socket = request.socket;
        record.closed = false;
        request.socket.once('close', () => {record.closed = true;});
        state.blocked = record;
        return; // Cancellation must close this real generation socket before fixture teardown.
      }
      record.content = JSON.stringify({cards: [{evidence_id: ids[0], explanation: marker}], experiment_id: 'stop'});
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({choices: [{message: {content: record.content}}], usage: {prompt_tokens: 23, completion_tokens: 19, total_tokens: 42}}));
    } catch (error) {
      state.errors.push(String(error));
      response.writeHead(400, {'content-type': 'application/json'});
      response.end(JSON.stringify({error: 'Invalid protocol fixture request'}));
    }
  });
  server.on('connection', socket => {state.sockets.add(socket); socket.once('close', () => state.sockets.delete(socket));});
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  state.endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  state.close = async () => {
    for (const socket of state.sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  };
  return state;
}

async function remoteConfiguration(context, fixture, settings, keyEnvironment, token) {
  const relative = `perf/native-narrative-settings-${randomUUID()}/configuration.json`;
  const file = path.join(context.workspace, relative);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, JSON.stringify({protocol: 'chat_completions_schema', endpoint: fixture.endpoint,
    model: 'perfchecker-native-narrative-fixture', timeout: 180, instructions: customInstructions,
    api_key_env: keyEnvironment, allow_remote: false}));
  try {
    await settings.update('advisorConfig', relative, context.vscode.ConfigurationTarget.WorkspaceFolder);
    // Discard any earlier unsaved provider editor, then load the owned draft.
    await context.vscode.commands.executeCommand('perfchecker.configureAdvisor');
    await context.vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await context.vscode.commands.executeCommand('perfchecker.configureAdvisor');
    let frame = await context.findFrame('#advisor-root');
    assert.equal(await frame.locator('#advisor-allow_remote').isChecked(), false);
    assert.equal(await frame.locator('#advisor-instructions').inputValue(), customInstructions);
    assert.equal(await frame.locator('#advisor-api_key_env').inputValue(), keyEnvironment);
    const original = await fs.readFile(file), calls = fixture.requests.length;
    const save = async expression => {
      await frame.getByRole('button', {name: 'Save configuration', exact: true}).click();
      await eventually(async () => await frame.locator('#advisor-root').getAttribute('aria-busy') === 'false' &&
        expression.test(await frame.getByRole('status').innerText()), 'The native remote configuration action finishes');
    };
    await frame.locator('#advisor-endpoint').fill('https://perfchecker-native-fixture.invalid/v1/chat/completions');
    await save(/remote evidence transmission requires allow_remote=true and HTTPS/);
    assert.deepEqual(await fs.readFile(file), original, 'Refused remote configuration preserves the saved local provider');
    await frame.locator('#advisor-allow_remote').check();
    await frame.locator('#advisor-endpoint').fill('http://perfchecker-native-fixture.invalid/v1/chat/completions');
    await save(/remote evidence transmission requires allow_remote=true and HTTPS/);
    assert.deepEqual(await fs.readFile(file), original, 'Opt-in still refuses unencrypted remote HTTP');
    await frame.locator('#advisor-endpoint').fill('https://perfchecker-native-fixture.invalid/v1/chat/completions');
    await save(/Configuration saved/);
    const saved = await fs.readFile(file, 'utf8'), config = JSON.parse(saved);
    assert.equal(config.allow_remote, true); assert.equal(config.instructions, customInstructions);
    assert.equal(config.api_key_env, keyEnvironment); assert(!saved.includes(token));
    assert.equal(config.endpoint, 'https://perfchecker-native-fixture.invalid/v1/chat/completions');
    await context.vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await context.vscode.commands.executeCommand('perfchecker.configureAdvisor');
    frame = await context.findFrame('#advisor-root');
    assert.equal(await frame.locator('#advisor-allow_remote').isChecked(), true);
    assert.equal(await frame.locator('#advisor-endpoint').inputValue(), config.endpoint);
    assert.equal(fixture.requests.length, calls, 'Validation and saving make no generation request');
    context.proof('native-advisor-remote-opt-in-contract', {nativeUncheckedRefusal: true, nativeHttpOptInRefusal: true,
      explicitHttpsOptInSavedAndReopened: true, noGenerationRequests: true, credentialValueNotPersisted: true,
      scope: 'Actual native UI and Julia validation; no external remote connection or credentials'});
  } finally {
    await context.vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await settings.update('advisorConfig', '', context.vscode.ConfigurationTarget.WorkspaceFolder);
    await fs.rm(path.dirname(file), {recursive: true, force: true});
  }
}

async function exportAndVerify(context, result) {
  const original = await fs.readFile(result.location);
  const markdown = await fs.readFile(result.location.replace(/\.json$/, '.md'), 'utf8');
  assert(markdown.includes(marker));
  for (const [label, extension] of [['JSON', 'json'], ['Markdown', 'md']]) {
    // Opening an export hides and destroys this non-retained webview. Reacquire
    // its real frame and current card for each click, including the next export.
    const frame = await tab(context, 'Saved evidence');
    const card = frame.locator('article.card').filter({has: frame.getByRole('heading', {name: /^narrate ·/})}).first();
    await card.getByRole('button', {name: label, exact: true}).click({timeout: 30000});
    const expected = result.location.replace(/\.json$/, `.${extension}`);
    await eventually(() => context.vscode.window.activeTextEditor?.document.uri.fsPath === context.vscode.Uri.file(expected).fsPath, `${label} export opens in the actual native editor`);
    assert(context.vscode.window.activeTextEditor.document.getText().includes(marker));
  }
  assert.deepEqual(await fs.readFile(result.location), original, 'Export does not rewrite evidence');
}

exports.run = async context => {
  const cfg = configuration(context);
  const root = path.resolve(context.workspace, cfg.get('investigationReports', 'perf/results/investigations'));
  const token = `synthetic-native-only-${randomUUID()}`, keyEnvironment = `PERFCHECKER_NATIVE_FIXTURE_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  const previousToken = process.env[keyEnvironment]; process.env[keyEnvironment] = token;
  const fixture = await fixtureServer(token);
  const settings = {scenarioSamples: 2, analysisTimeout: 180, advisorEnabled: true, advisorConfig: '',
    advisorProtocol: 'chat_completions_schema', advisorEndpoint: fixture.endpoint,
    advisorModel: 'perfchecker-native-narrative-fixture', advisorKeyEnvironment: keyEnvironment, advisorAllowRemote: false,
    advisorTimeout: 180, advisorInstructions: customInstructions};
  const previous = new Map(Object.keys(settings).map(key => [key, cfg.inspect(key)?.workspaceFolderValue]));
  const catalog = path.resolve(context.workspace, cfg.get('scenarioCatalog', 'perf/scenarios.toml'));
  const catalogBytes = await fs.readFile(catalog);
  const sourceBytes = await fs.readFile(path.join(context.workspace, 'perf', 'cases.jl'));
  try {
    for (const [key, value] of Object.entries(settings)) await cfg.update(key, value, context.vscode.ConfigurationTarget.WorkspaceFolder);
    await remoteConfiguration(context, fixture, cfg, keyEnvironment, token);
    const discovery = await action(context, root, 'Discover tests', 'discover');
    assert.equal(discovery.report.schema_version, 'perfchecker-discovery/1');
    const installed=context.vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');
    assert(installed,'Canonical scenario keys come from the actual installed VSIX');
    const {scenarioKey,selectedScenarios}=require(path.join(installed.extensionPath,'dist','investigationModel.js'));
    const wanted={id:'sum_squares',implementation:'allocating'},wantedKey=scenarioKey(wanted);
    const declared=discovery.report.declared.filter(item=>scenarioKey(item)===wantedKey);
    assert.equal(declared.length,1,'Discovery identifies one exact narrative scenario');
    assert.equal(declared[0].catalog,'perf/scenarios.toml');
    assert.deepEqual(declared[0].collectors,['benchmark','chairmark','profile','profile_alloc']);
    assert.equal(await fs.realpath(declared[0].source),await fs.realpath(path.join(context.workspace,'perf','cases.jl')));
    assert.deepEqual(selectedScenarios(discovery.report.declared,[wantedKey]),declared);
    let frame = await tab(context, 'Scenarios');
    await frame.getByRole('button', {name: 'Clear selection', exact: true}).click();
    const card = frame.locator('article.card').filter({has: frame.locator('.scenario-title strong', {hasText: /^sum_squares$/})})
      .filter({has: frame.locator('.implementation', {hasText: /^allocating$/})});
    assert.equal(await card.count(),1,'Only the exact narrative scenario card is selected');
    await card.locator('.scenario-title input').check();
    const selected=await frame.locator('article.card').evaluateAll(cards=>cards.filter(card=>card.querySelector('.scenario-title input')?.checked)
      .map(card=>({id:card.querySelector('.scenario-title strong')?.textContent,implementation:card.querySelector('.implementation')?.textContent})));
    assert.deepEqual(selected.map(scenarioKey),[wantedKey],'The native checkbox selects exactly the canonical narrative scenario');
    context.proof('native-narrative-exact-scenario-selection',{scenarioKey:wantedKey,catalog:declared[0].catalog,source:declared[0].source,
      collectors:declared[0].collectors,selectedKeys:selected.map(scenarioKey),assertedBeforeMeasurement:true});
    const measured = await action(context, root, 'Measure selected', 'run');
    assert.equal(measured.report.schema_version, 'perfchecker-scenario-run/1');
    assert(measured.report.runs.length > 0);
    for (const run of measured.report.runs) {
      assert.equal(run.scenario.id, 'sum_squares');
      assert.equal(run.qualification.availability, 'complete');
      assert.equal(run.qualification.correctness, 'passed');
    }
    const advice = JSON.parse(await fs.readFile(path.join(measured.directory, 'advice', 'advice.json'), 'utf8'));
    assert(advice.recommendations.some(item => item.rule_id === 'evidence.samples'), 'Two real samples trigger the deterministic ten-sample policy');
    const runBytes = await fs.readFile(measured.location);
    frame = await tab(context, 'Findings & advice');
    assert.equal(await frame.getByRole('button', {name: 'Explain with configured model', exact: true}).isEnabled(), true);
    const narrative = await action(context, root, 'Explain with configured model', 'narrate');
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.requests.length, 1);
    const request = fixture.requests[0];
    assert.equal(narrative.report.schema_version, 'perfchecker-narrative/1');
    assert.equal(narrative.report.status, 'complete');
    assert.equal(narrative.report.authority, 'unverified_narrative');
    assert.equal(narrative.report.verdict_source, 'deterministic_evidence');
    assert.equal(narrative.report.model, settings.advisorModel);
    assert.deepEqual(narrative.report.fallback, advice);
    assert.deepEqual(narrative.report.evidence_ids, request.ids);
    assert.deepEqual(narrative.report.cards, [{evidence_id: request.ids[0], explanation: marker}]);
    assert.equal(narrative.report.response_sha256, createHash('sha256').update(request.content).digest('hex'));
    assert.equal(narrative.report.usage.total_tokens, 42);
    assert(!JSON.stringify(narrative.report).includes(token), 'The synthetic credential is never copied into narrative evidence');
    const actualConfig = await fs.readFile(path.join(narrative.directory, 'advisor-config.json'), 'utf8');
    assert.equal(JSON.parse(actualConfig).api_key_env, keyEnvironment); assert(!actualConfig.includes(token));
    context.proof('native-narrative-custom-instruction-and-environment-key', {outboundSystemInstructionExact: true,
      outboundSyntheticBearerExact: true, realJuliaWorkerEnvironment: true, credentialValueNotPersisted: true,
      scope: 'Owned loopback fixture only; synthetic token, no human authentication or inference'});
    frame = await tab(context, 'Findings & advice');
    await frame.getByRole('heading', {name: 'Optional model explanation', exact: true}).waitFor();
    assert((await frame.locator('#app').innerText()).includes(marker));
    assert((await frame.locator('#app').innerText()).includes('Generated prose needs review'));
    context.proof('native-narrative-controlled-response-visible', {provider: 'local controlled HTTP protocol fixture; no inference or human authentication',
      protocol: settings.advisorProtocol, requests: fixture.requests.length, scenario: 'sum_squares', evidenceIds: request.ids,
      samples: 2, status: narrative.report.status, authority: narrative.report.authority, visible: true, exportsStillRequired: true});
    await exportAndVerify(context, narrative);
    assert.deepEqual(await fs.readFile(measured.location), runBytes, 'Explanation does not replace measured results');
    context.proof('native-narrative-controlled-response', {provider: 'local controlled HTTP protocol fixture; no inference or human authentication',
      protocol: settings.advisorProtocol, requests: fixture.requests.length, scenario: 'sum_squares', evidenceIds: request.ids,
      samples: 2, status: narrative.report.status, authority: narrative.report.authority, visible: true, jsonAndMarkdown: true});

    // Reload the real saved measurement so no QuickPick or synthetic history is needed for another explanation.
    frame = await tab(context, 'Saved evidence');
    await frame.locator('article.card').filter({has: frame.getByRole('heading', {name: /^run ·/})}).first()
      .getByRole('button', {name: 'Open evidence', exact: true}).click();
    frame = await tab(context, 'Findings & advice');
    fixture.mode = 'hold';
    const before = await directories(root);
    await frame.getByRole('button', {name: 'Explain with configured model', exact: true}).click();
    await eventually(() => fixture.blocked, 'second actual HTTP generation request arrives', 240000);
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.blocked.closed, false, 'Generation is actually in flight when Cancel is clicked');
    assert.equal(await frame.getByRole('button', {name: 'Cancel', exact: true}).isEnabled(), true);
    await frame.getByRole('button', {name: 'Cancel', exact: true}).click();
    await eventually(() => fixture.blocked.closed, 'cancellation closes the active model HTTP socket before fixture teardown', 180000);
    frame = await idle(context);
    assert.match(await frame.locator('#app .status').innerText(), /Cancelled after controller cleanup/);
    assert.deepEqual(fixture.errors, []);
    const added = [...await directories(root)].filter(id => !before.has(id));
    assert.equal(added.length, 1);
    const cancelledDirectory = path.join(root, added[0]);
    await fs.stat(path.join(cancelledDirectory, 'worker.log'));
    const storedConfiguration = JSON.parse(await fs.readFile(path.join(cancelledDirectory, 'advisor-config.json'), 'utf8'));
    assert.equal(storedConfiguration.endpoint, fixture.endpoint);
    assert.equal(storedConfiguration.model, settings.advisorModel);
    for (const [key, value] of Object.entries(settings)) assert.deepEqual(configuration(context).get(key), value, `Cancel preserves ${key}`);
    assert.deepEqual(await fs.readFile(catalog), catalogBytes);
    assert.deepEqual(await fs.readFile(path.join(context.workspace, 'perf', 'cases.jl')), sourceBytes);
    assert.deepEqual(await fs.readFile(measured.location), runBytes);
    context.proof('native-narrative-cancel-active-http', {activeRequestReceived: true, socketClosedBeforeFixtureCleanup: true,
      controllerCleanupComplete: true, configurationPreserved: true, sourceAndMeasurementUnchanged: true, retainedLog: true});

    await configuration(context).update('advisorTimeout', 45, context.vscode.ConfigurationTarget.WorkspaceFolder);
    fixture.blocked = undefined;
    const timeoutBefore = await directories(root);
    frame = await tab(context, 'Saved evidence');
    await frame.locator('article.card').filter({has: frame.getByRole('heading', {name: /^run ·/})}).first()
      .getByRole('button', {name: 'Open evidence', exact: true}).click();
    frame = await tab(context, 'Findings & advice');
    await frame.getByRole('button', {name: 'Explain with configured model', exact: true}).click();
    await eventually(() => fixture.blocked, 'The real third HTTP request reaches the deadline fixture', 180000);
    const held = fixture.blocked; assert.equal(held.closed, false);
    const expired = await reportAfter(context, root, timeoutBefore, 'narrate');
    assert.equal(expired.report.status, 'timeout', 'The Core request deadline expires without a Cancel click');
    await eventually(() => held.closed, 'The expired model socket closes before fixture teardown');
    assert.equal(configuration(context).get('advisorTimeout'), 45);
    frame = await tab(context, 'Findings & advice');
    assert.match(await frame.locator('#app').innerText(), /timeout|timed out|isolated worker stopped/i);
    assert.deepEqual(await fs.readFile(measured.location), runBytes);
    context.proof('native-narrative-configured-deadline', {configuredSeconds: 45, requestReachedOwnedFixture: true,
      noCancelClick: true, coreStatus: expired.report.status, socketClosedBeforeFixtureCleanup: true,
      nativeOutcomeVisible: true, measuredEvidencePreserved: true});
  } finally {
    // Only the sacrificial workspace-folder settings are restored; global/user configuration is never written.
    try {
      const frame = await view(context);
      if (await frame.getByRole('button', {name: 'Cancel', exact: true}).isEnabled()) {
        await frame.getByRole('button', {name: 'Cancel', exact: true}).click();
        await idle(context);
      }
    } finally {
      await fixture.close();
      if (previousToken === undefined) delete process.env[keyEnvironment]; else process.env[keyEnvironment] = previousToken;
      for (const [key, value] of previous) await cfg.update(key, value, context.vscode.ConfigurationTarget.WorkspaceFolder);
      for (const [key, value] of previous) assert.deepEqual(configuration(context).inspect(key)?.workspaceFolderValue, value);
    }
  }
};
