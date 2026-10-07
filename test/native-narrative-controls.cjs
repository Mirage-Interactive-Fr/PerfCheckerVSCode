// Native installed-VSIX clicks and real Julia evidence; HTTP replies are a declared protocol fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {createHash} = require('node:crypto');

const marker = 'Controlled protocol fixture: collect more comparable samples before drawing a performance conclusion.';
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

async function fixtureServer() {
  const state = {mode: 'respond', requests: [], errors: [], sockets: new Set(), blocked: undefined};
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, undefined, 'The fixture does not request or receive human authentication');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {size += chunk.length; assert(size < 1_000_000); chunks.push(chunk);}
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, 'perfchecker-native-narrative-fixture');
      assert.equal(body.stream, false);
      assert.equal(body.response_format.type, 'json_schema');
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
  const fixture = await fixtureServer();
  const settings = {scenarioSamples: 2, analysisTimeout: 180, advisorEnabled: true, advisorConfig: '',
    advisorProtocol: 'chat_completions_schema', advisorEndpoint: fixture.endpoint,
    advisorModel: 'perfchecker-native-narrative-fixture', advisorKeyEnvironment: '', advisorAllowRemote: false,
    advisorTimeout: 180, advisorInstructions: ''};
  const previous = new Map(Object.keys(settings).map(key => [key, cfg.inspect(key)?.workspaceFolderValue]));
  const catalog = path.resolve(context.workspace, cfg.get('scenarioCatalog', 'perf/scenarios.toml'));
  const catalogBytes = await fs.readFile(catalog);
  const sourceBytes = await fs.readFile(path.join(context.workspace, 'perf', 'cases.jl'));
  try {
    for (const [key, value] of Object.entries(settings)) await cfg.update(key, value, context.vscode.ConfigurationTarget.WorkspaceFolder);
    const discovery = await action(context, root, 'Discover tests', 'discover');
    assert.equal(discovery.report.schema_version, 'perfchecker-discovery/1');
    assert(discovery.report.declared.some(item => item.id === 'sum_squares' && item.implementation === 'allocating'));
    let frame = await tab(context, 'Scenarios');
    await frame.getByRole('button', {name: 'Clear selection', exact: true}).click();
    const card = frame.locator('article.card').filter({has: frame.locator('.scenario-title strong', {hasText: 'sum_squares'})})
      .filter({has: frame.locator('.implementation', {hasText: 'allocating'})}).first();
    await card.locator('.scenario-title input').check();
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
      for (const [key, value] of previous) await cfg.update(key, value, context.vscode.ConfigurationTarget.WorkspaceFolder);
      for (const [key, value] of previous) assert.deepEqual(configuration(context).inspect(key)?.workspaceFolderValue, value);
    }
  }
};
