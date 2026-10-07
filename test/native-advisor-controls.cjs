// Actual VS Code controls and Julia HTTP workers. This local protocol fixture
// stores tiny test payloads; it is not an Ollama runtime or an inference model.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

async function eventually(read, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {const result = await read(); if (result) return result;} catch (error) {last = error;}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`${label}${last ? `: ${last.message}` : ''}`);
}

async function startFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perfchecker-native-advisor-'));
  const payload = Buffer.from('PerfChecker native advisor fixture: small protocol payload, not model weights.\n');
  const calls = [], models = new Map(), cancelled = new Set(), errors = [];
  const modelFile = name => path.join(root, createHash('sha256').update(name).digest('hex') + '.fixture');
  const partialFile = name => modelFile(name) + '.partial';
  async function install(name) {
    await fs.writeFile(modelFile(name), payload);
    models.set(name, {name, size: payload.length, digest: createHash('sha256').update(payload).digest('hex'), loaded: true});
  }
  await install('seed:fixture');
  const server = http.createServer(async (request, response) => {
    try {
      let data = '';
      for await (const chunk of request) {
        data += chunk;
        if (data.length > 32000) throw new Error('Fixture request exceeded its bound.');
      }
      const body = data ? JSON.parse(data) : {};
      assert.equal(request.headers.authorization, undefined, 'The protocol fixture requires no human credential');
      calls.push({method: request.method, url: request.url, body,
        session: request.headers['mcp-session-id'], version: request.headers['mcp-protocol-version']});
      response.setHeader('Content-Type', 'application/json');
      const json = value => response.end(JSON.stringify(value));
      if (request.url === '/unavailable/api/tags') {
        response.statusCode = 503; return json({error: 'Declared fixture service unavailable'});
      }
      if (request.method === 'GET' && request.url === '/api/tags') {
        return json({models: [...models.values()].map(({loaded, ...item}) => item)});
      }
      if (request.method === 'POST' && request.url === '/api/pull') {
        assert.equal(body.stream, false);
        if (body.model === 'cancelled:fixture') {
          await fs.writeFile(partialFile(body.model), 'partial test payload\n');
          response.writeHead(200); response.flushHeaders();
          response.once('close', () => {if (!response.writableEnded) cancelled.add(body.model);});
          return; // Keep a real HTTP download active until the Julia worker cancels.
        }
        await install(body.model); return json({status: 'success'});
      }
      if (request.method === 'DELETE' && request.url === '/api/delete') {
        await fs.rm(modelFile(body.model), {force: true}); models.delete(body.model);
        return json({});
      }
      if (request.method === 'POST' && request.url === '/api/generate') {
        assert.equal(body.keep_alive, 0); assert.equal(body.stream, false);
        assert(!Object.hasOwn(body, 'prompt'), 'Unload must not generate an answer');
        assert(models.has(body.model)); models.get(body.model).loaded = false;
        return json({done: true});
      }
      if (request.url === '/v1/models' && request.method === 'GET') {
        return json({data: [{id: 'chat:fixture'}]});
      }
      if (request.url === '/mcp') {
        if (request.method === 'DELETE') {response.statusCode = 204; return response.end();}
        if (body.method === 'notifications/initialized') {response.statusCode = 202; return response.end();}
        const reply = result => json({jsonrpc: '2.0', id: body.id, result});
        if (body.method === 'initialize') {
          response.setHeader('Mcp-Session-Id', 'advisor-native-fixture');
          return reply({protocolVersion: '2025-11-25', capabilities: {tools: {}},
            serverInfo: {name: 'PerfChecker native advisor protocol fixture', version: '1.0.0'}});
        }
        if (body.method === 'tools/list') {
          assert.equal(request.headers['mcp-session-id'], 'advisor-native-fixture');
          assert.equal(request.headers['mcp-protocol-version'], '2025-11-25');
          if (body.params?.cursor === 'second-page') return reply({tools: [{name: 'simple_advice',
            description: 'Second page fixture tool', inputSchema: {type: 'object',
              required: ['prompt'], properties: {prompt: {type: 'string'}}}}]});
          assert.equal(body.params?.cursor, undefined);
          return reply({nextCursor: 'second-page', tools: [{name: 'ask_fixture',
            description: '<b>Literal fixture description</b>', inputSchema: {type: 'object',
              required: ['question', 'context'], properties: {question: {type: 'string'}, context: {type: 'object'}}}}]});
        }
        throw new Error('Discovery must not call an MCP tool.');
      }
      throw new Error(`Unexpected fixture operation: ${request.method} ${request.url}`);
    } catch (error) {
      errors.push(String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end(JSON.stringify({error: 'Protocol fixture rejected an unexpected request'}));
    }
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return {root, calls, models, cancelled, errors, payload, modelFile, partialFile,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, {recursive: true, force: true});}};
}

async function panel(context) {
  await context.vscode.commands.executeCommand('perfchecker.configureAdvisor');
  return context.findFrame('#advisor-root');
}
const row = (frame, name) => frame.locator('section[aria-label="Available models and tools"] article').filter({has: frame.getByRole('heading', {name, exact: true})});
async function finished(frame, message) {
  try{
    await eventually(async () => await frame.locator('#advisor-root').getAttribute('aria-busy') === 'false' &&
      message.test(await frame.getByRole('status').innerText()), `Advisor action finishes: ${message}`);
  }catch(error){
    const actual={busy:await frame.locator('#advisor-root').getAttribute('aria-busy'),status:await frame.getByRole('status').innerText(),
      mode:await frame.locator('#advisor-protocol').inputValue(),model:await frame.locator('#advisor-model').inputValue()};
    throw new Error(`${error.message}; actual declared fixture UI: ${JSON.stringify(actual)}`);
  }
}
async function click(frame, label) {await frame.getByRole('button', {name: label, exact: true}).click();}
async function confirm(frame, label) {await click(frame, label); await click(frame, 'Confirm');}

async function ollama(context, fixture, configFile) {
  const frame = await panel(context), initialRequests = fixture.calls.length;
  assert.equal(await frame.getByRole('button', {name: 'Cancel operation', exact: true}).isDisabled(), true);
  assert.equal(fixture.calls.length, initialRequests, 'Opening Advisor performs no provider request');
  await frame.locator('#advisor-protocol').selectOption('ollama');
  await frame.locator('#advisor-endpoint').fill(`${fixture.base}/api/chat`);
  await frame.locator('#advisor-model').fill('missing:fixture');
  await frame.locator('#advisor-timeout').fill('120');
  await frame.locator('#advisor-instructions').fill('Protocol fixture only; preserve the public API.');
  await click(frame, 'Test connection / discover');
  await finished(frame, /configured model \/ tool is missing/);
  assert(fixture.calls.some(call => call.method === 'GET' && call.url === '/api/tags'));
  assert.equal(await row(frame, 'seed:fixture').count(), 1);
  await row(frame, 'seed:fixture').getByRole('button', {name: 'Use', exact: true}).click();
  assert.equal(await frame.locator('#advisor-model').inputValue(), 'seed:fixture');
  const beforeSave = fixture.calls.length;
  await click(frame, 'Save configuration'); await finished(frame, /Configuration saved/);
  const saved = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(saved.protocol, 'ollama'); assert.equal(saved.endpoint, `${fixture.base}/api/chat`);
  assert.equal(saved.model, 'seed:fixture'); assert.equal(saved.instructions, 'Protocol fixture only; preserve the public API.');
  assert.equal(fixture.calls.length, beforeSave, 'Saving validates the draft without generation or discovery');
  const savedBytes = await fs.readFile(configFile);
  await click(frame, 'Refresh models'); await finished(frame, /Ollama connected/);
  const original = await fs.readFile(fixture.modelFile('seed:fixture'));
  const beforeUnload = fixture.calls.length;
  await row(frame, 'seed:fixture').getByRole('button', {name: 'Unload from memory…', exact: true}).click();
  assert.equal(fixture.calls.length, beforeUnload, 'Mutation waits for the explicit confirmation');
  await click(frame, 'Back'); assert.equal(fixture.calls.length, beforeUnload);
  await row(frame, 'seed:fixture').getByRole('button', {name: 'Unload from memory…', exact: true}).click();
  await click(frame, 'Confirm'); await finished(frame, /unloaded from memory/);
  assert.equal(fixture.models.get('seed:fixture').loaded, false);
  assert.deepEqual(await fs.readFile(fixture.modelFile('seed:fixture')), original);
  await frame.locator('#advisor-download-model').fill('downloaded:fixture');
  const beforePull = fixture.calls.length;
  await click(frame, 'Download this model…');
  assert.equal(fixture.calls.length, beforePull); assert.equal(fixture.models.has('downloaded:fixture'), false);
  await click(frame, 'Confirm'); await finished(frame, /Download completed/);
  assert.deepEqual(await fs.readFile(fixture.modelFile('downloaded:fixture')), fixture.payload);
  assert(fixture.calls.some(call => call.method === 'POST' && call.url === '/api/pull' && call.body.model === 'downloaded:fixture' && call.body.stream === false));
  await click(frame, 'Refresh models'); await finished(frame, /Ollama connected/);
  assert.equal(await row(frame, 'downloaded:fixture').count(), 1);
  await row(frame, 'downloaded:fixture').getByRole('button', {name: 'Delete from disk…', exact: true}).click();
  const beforeDelete = fixture.calls.length;
  await click(frame, 'Confirm'); await finished(frame, /Model removed/);
  assert.equal(fixture.models.has('downloaded:fixture'), false);
  await assert.rejects(fs.stat(fixture.modelFile('downloaded:fixture')), {code: 'ENOENT'});
  assert.equal(fixture.calls[beforeDelete].method, 'DELETE');
  await click(frame, 'Refresh models'); await finished(frame, /Ollama connected/);
  assert.equal(await row(frame, 'downloaded:fixture').count(), 0);
  await frame.locator('#advisor-download-model').fill('cancelled:fixture');
  await confirm(frame, 'Download this model…');
  await eventually(() => fs.stat(fixture.partialFile('cancelled:fixture')).then(() => true).catch(() => false), 'The real fixture receives the active download');
  assert.equal(await frame.getByRole('button', {name: 'Cancel operation', exact: true}).isEnabled(), true);
  await click(frame, 'Cancel operation'); await finished(frame, /Operation cancelled/);
  await eventually(() => fixture.cancelled.has('cancelled:fixture'), 'Cancellation closes the real Julia HTTP connection');
  assert.equal(fixture.models.has('cancelled:fixture'), false);
  assert.equal(await fs.readFile(fixture.partialFile('cancelled:fixture'), 'utf8'), 'partial test payload\n');
  assert.deepEqual(await fs.readFile(configFile), savedBytes, 'Cancelled download does not modify the saved provider');
  await click(frame, 'Refresh models'); await finished(frame, /Ollama connected/);
  assert.equal(await row(frame, 'cancelled:fixture').count(), 0);
  await frame.locator('#advisor-endpoint').fill(`${fixture.base}/unavailable/api/chat`);
  await click(frame, 'Test connection / discover'); await finished(frame, /HTTP 503/);
  assert.equal(await frame.getByRole('button', {name: 'Test connection / discover', exact: true}).isEnabled(), true);
  assert.deepEqual(await fs.readFile(configFile), savedBytes, 'Provider errors preserve the saved configuration');
  context.proof('advisor-native-model-management', {protocolFixture: true, inferenceModelDownloaded: false,
    payloadBytes: fixture.payload.length, selectionSaved: true, confirmedPullDeleteUnload: true,
    cancelledConnectionClosed: true, serverPartialFileExplicitlyRetained: true, providerErrorVisible: true});
}

async function inventories(context, fixture, configFile) {
  const frame = await panel(context);
  await frame.locator('#advisor-protocol').selectOption('chat_completions');
  await frame.locator('#advisor-endpoint').fill(`${fixture.base}/v1/chat/completions`);
  await frame.locator('#advisor-model').fill('chat:fixture');
  await click(frame, 'Test connection / discover'); await finished(frame, /Model inventory connected/);
  await row(frame, 'chat:fixture').getByRole('button', {name: 'Use', exact: true}).click();
  assert.equal(await frame.locator('#advisor-model').inputValue(), 'chat:fixture');
  await frame.locator('#advisor-protocol').selectOption('mcp_http');
  await frame.locator('#advisor-endpoint').fill(`${fixture.base}/mcp`);
  await frame.locator('#advisor-mcp_version').selectOption('2025-11-25');
  await frame.locator('#advisor-mcp_tool').fill('');
  await click(frame, 'Test connection / discover'); await finished(frame, /MCP connected/);
  assert.equal(await row(frame, 'ask_fixture').count(), 1); assert.equal(await row(frame, 'simple_advice').count(), 1);
  assert.equal(await frame.locator('#advisor-root b').count(), 0, 'Tool descriptions remain literal text');
  await row(frame, 'ask_fixture').getByText('Required arguments and tool schema', {exact: true}).click();
  assert.match(await row(frame, 'ask_fixture').locator('pre').innerText(), /"context"/);
  await row(frame, 'ask_fixture').getByRole('button', {name: 'Use', exact: true}).click();
  assert.equal(await frame.locator('#advisor-mcp_tool').inputValue(), 'ask_fixture');
  assert.equal(await frame.locator('#advisor-mcp_prompt_argument').inputValue(), 'question');
  await frame.locator('#advisor-mcp_arguments').fill('{"context":{"fixture":true}}');
  await click(frame, 'Save configuration'); await finished(frame, /Configuration saved/);
  const saved = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(saved.mcp_tool, 'ask_fixture'); assert.equal(saved.mcp_prompt_argument, 'question');
  assert.deepEqual(saved.mcp_arguments, {context: {fixture: true}});
  const calls = fixture.calls.filter(call => call.url === '/mcp');
  assert(calls.some(call => call.body.method === 'initialize'));
  assert(calls.some(call => call.body.method === 'notifications/initialized'));
  assert.equal(calls.filter(call => call.body.method === 'tools/list').length, 2);
  assert(calls.some(call => call.body.params?.cursor === 'second-page'));
  assert(calls.some(call => call.method === 'DELETE'));
  assert.equal(fixture.calls.filter(call => call.body.method === 'tools/call').length, 0);
  assert.equal(fixture.calls.filter(call => /chat\/completions|api\/chat/.test(call.url)).length, 0);
  await frame.locator('#advisor-protocol').selectOption('none');
  await click(frame, 'Save configuration'); await finished(frame, /Rule-based advice only/);
  assert.equal(context.vscode.workspace.getConfiguration('perfchecker', context.vscode.Uri.file(context.workspace)).get('advisorEnabled'), false);
  assert.deepEqual(await fs.readFile(fixture.modelFile('seed:fixture')), fixture.payload);
  context.proof('advisor-native-provider-and-tool-discovery', {chatInventory: true, mcpHandshake: true,
    paginatedTools: 2, schemaAndArguments: true, toolCalls: 0, generationRequests: 0, ruleBasedModeSaved: true});
}

exports.run = async context => {
  const fixture = await startFixture(), folder = context.vscode.Uri.file(context.workspace);
  const settings = context.vscode.workspace.getConfiguration('perfchecker', folder);
  const keys = ['advisorConfig', 'advisorEnabled', 'advisorInvestigates', 'investigationMaxExperiments', 'investigationBudgetSeconds'];
  const previous = Object.fromEntries(keys.map(key => [key, settings.inspect(key)?.workspaceFolderValue]));
  const relative = `perf/native-advisor-${randomUUID()}/configuration.json`, configFile = path.join(context.workspace, relative);
  try {
    // Earlier Studio controls intentionally leave their unsaved provider form
    // open. Close that real editor so this independently configured fixture
    // starts from its own on-disk configuration, instead of stale draft fields.
    await panel(context);
    await context.vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await settings.update('advisorConfig', relative, context.vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('advisorEnabled', true, context.vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('advisorInvestigates', false, context.vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('investigationMaxExperiments', 4, context.vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('investigationBudgetSeconds', 300, context.vscode.ConfigurationTarget.WorkspaceFolder);
    // initial() reads this real file, while all subsequent actions still go
    // through actual webview callbacks and the isolated Julia CLI backend.
    await fs.mkdir(path.dirname(configFile), {recursive: true});
    await fs.writeFile(configFile, JSON.stringify({protocol: 'ollama', endpoint: `${fixture.base}/api/chat`, model: 'seed:fixture', timeout: 120}));
    await ollama(context, fixture, configFile);
    await inventories(context, fixture, configFile);
    assert.deepEqual(fixture.errors, []);
  }catch(error){
    context.log('advisor-native-protocol-failure',{assertionsCompleted:false,error:String(error),
      requests:fixture.calls,fixtureErrors:fixture.errors});
    await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,
      `${process.env.PERFCHECKER_NATIVE_PHASE}-advisor-before-teardown.png`)}).catch(()=>{});
    throw error;
  } finally {
    await context.vscode.commands.executeCommand('perfchecker.cancelAdvisorSetup').catch(() => {});
    const frame = await context.findFrame('#advisor-root').catch(() => undefined);
    if (frame) await context.vscode.commands.executeCommand('workbench.action.closeActiveEditor').catch(() => {});
    for (const key of keys) await settings.update(key, previous[key], context.vscode.ConfigurationTarget.WorkspaceFolder);
    await fixture.close(); await fs.rm(path.dirname(configFile), {recursive: true, force: true});
  }
};
exports.startFixture = startFixture;
