// Real HTTP MCP transport and Julia workers, driven through the installed webview.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {if (await read()) return; await delay(100);}
  throw new Error(label);
}

exports.run = async context => {
  assert.equal(process.env.CI, 'true');
  const {vscode, workspace, findFrame, log} = context;
  const uri = vscode.Uri.file(workspace);
  const settings = () => vscode.workspace.getConfiguration('perfchecker', uri);
  const source = path.join(workspace, 'src', 'PerfCheckerNativeFixture.jl');
  const original = await fs.readFile(source, 'utf8');
  const proposed = original.replace('sum(xs .^ 2)', 'sum((x * x for x in xs); init=zero(eltype(xs)))');
  assert.notEqual(proposed, original);
  const git = async (...args) => (await execute('git', args, {cwd: workspace,
    env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}, windowsHide: true})).stdout;
  const head = await git('rev-parse', 'HEAD');
  const index = await fs.readFile(path.join(workspace, '.git', 'index'));
  const probe = async root => {
    const code = 'include("src/PerfCheckerNativeFixture.jl"); score=PerfCheckerNativeFixture.sum_squares; @assert score(Float64[]) == 0.0; @assert score([1.0,-2.0,3.0]) == 14.0; xs=collect(1.0:1000.0); score(xs); @assert score(xs)==333833500.0; println(@allocated score(xs))';
    return Number((await execute(process.env.PERFCHECKER_NATIVE_JULIA,
      ['--startup-file=no', '-e', code], {cwd: root, windowsHide: true,
        env: {...process.env, UV_THREADPOOL_SIZE: '1'}})).stdout.trim());
  };
  const baselineBytes = await probe(workspace);
  const calls = [], pending = new Set();
  let implementationBytes;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'DELETE') {res.writeHead(204); res.end(); return;}
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      res.setHeader('Content-Type', 'application/json');
      if (body.method === 'notifications/initialized') {res.writeHead(202); res.end(); return;}
      let result = {};
      if (body.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'native-deterministic-provider');
        result = {protocolVersion: body.params.protocolVersion, capabilities: {tools: {}},
          serverInfo: {name: 'Deterministic native qualification provider', version: '1'}};
      }
      if (body.method === 'tools/list') result = {tools: ['ask_perfchecker', 'implement_perfchecker'].map(name => ({name,
        inputSchema: {type: 'object', properties: {prompt: {type: 'string'}, workspace: {type: 'string'}},
          required: name.startsWith('implement') ? ['prompt', 'workspace'] : ['prompt']}}))};
      if (body.method === 'tools/call') {
        assert.equal(req.headers['mcp-protocol-version'], '2026-07-28');
        const {name, arguments: args} = body.params;
        assert.equal(typeof args.prompt, 'string');
        calls.push({name, prompt: args.prompt});
        let answer = 'Consider a generator to remove the intermediate squared array. Verify empty inputs and signed floating-point values, then measure allocations; speed is not yet qualified.';
        if (args.prompt.includes('native cancellation probe')) {
          pending.add(res); res.on('close', () => pending.delete(res)); return;
        }
        if (name === 'implement_perfchecker') {
          const root = await fs.realpath(args.workspace);
          assert.notEqual(root, await fs.realpath(workspace));
          assert(path.relative(os.tmpdir(), root).split(path.sep)[0] !== '..', 'Only the supplied disposable checkout is edited');
          const file = path.join(root, 'src', 'PerfCheckerNativeFixture.jl');
          assert.equal(await fs.readFile(file, 'utf8'), original);
          await fs.writeFile(file, proposed);
          implementationBytes = await probe(root);
          assert(implementationBytes < baselineBytes);
          answer = 'The generator was implemented and the empty, signed and Float64 oracles passed in the supplied isolated copy. Review the diff before applying.';
        }
        result = {content: [{type: 'text', text: answer}]};
      }
      res.end(JSON.stringify({jsonrpc: '2.0', id: body.id, result}));
    } catch (error) {res.writeHead(500); res.end(JSON.stringify({error: String(error)}));}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const values = {advisorEnabled: true, advisorProtocol: 'mcp_http',
    advisorEndpoint: `http://127.0.0.1:${server.address().port}/mcp`, advisorModel: 'native-fixture',
    advisorMcpTool: 'ask_perfchecker', advisorMcpResponse: 'text', advisorMcpVersion: '2026-07-28',
    advisorImplementationMcpTool: 'implement_perfchecker', advisorTimeout: 180,
    codexExecutable: path.join(workspace, 'not-installed-codex')};
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, settings().inspect(key)?.workspaceFolderValue]));
  const state = () => vscode.commands.executeCommand('perfchecker.chatState');
  try {
    for (const [key, value] of Object.entries(values)) await settings().update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    const configuredPath=settings().get('advisorConfig','perf/advisor.json');
    const configuredFile=path.resolve(workspace,configuredPath);
    const savedConfig=await fs.readFile(configuredFile).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
    await vscode.commands.executeCommand('perfchecker.openChat');
    let view = await findFrame('#chat-root');
    await view.getByRole('button', {name: 'Connect Codex CLI', exact: true}).click();
    await eventually(async () => /ENOENT|executable|could not|launch/i.test(await view.locator('[role="status"]').innerText()), 'Missing Codex explains its executable prerequisite');
    assert.equal((await vscode.commands.executeCommand('perfchecker.codexConnectionState')).connected, false);
    log('codex-missing-native-prerequisite',{command:'perfchecker.connectCodex',status:'prerequisite',reason:'Codex executable absent from disposable CI; no human credentials are transferred.'});
    assert.deepEqual(await vscode.commands.executeCommand('perfchecker.disconnectCodex'),{connected:false});
    assert.equal((await vscode.commands.executeCommand('perfchecker.codexConnectionState')).connected,false);
    assert.equal(settings().get('advisorConfig','perf/advisor.json'),configuredPath);
    assert.deepEqual(await fs.readFile(configuredFile).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;}),savedConfig,'The failed temporary CLI connection and explicit disconnect preserve the saved provider bytes');
    log('codex-disconnected-command',{command:'perfchecker.disconnectCodex',returnValueVerified:true,alreadyDisconnected:true,savedConfigurationPreserved:true,activeAuthenticatedDisconnection:false});
    await view.getByRole('button', {name: 'New conversation', exact: true}).click();
    const send = async (question, count) => {
      await view.locator('#chat-question').fill(question);
      log('native-ui-action',{surface:'MCP conversation',action:'Send question',turn:count/2});
      await view.getByRole('button', {name: 'Send question', exact: true}).click();
      await eventually(async () => {const value = await state(); return !value.busy && value.messages.length === count;}, 'Actual registered Julia MCP worker returns the conversation');
    };
    await send('Inspect the intermediate allocation in sum_squares without editing. What should I verify?', 2);
    await send('Continue this conversation: how should empty inputs and signed Float64 values be checked?', 4);
    assert.equal(await fs.readFile(source, 'utf8'), original);
    assert(calls[1].prompt.includes('Inspect the intermediate allocation') && calls[1].prompt.includes('signed Float64'), 'The second real MCP call contains the bounded conversation');
    assert.equal(await view.locator('.message.assistant').count(), 2);
    await context.windowPage.screenshot({path:path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,
      `native-${process.env.PERFCHECKER_NATIVE_EXPECTED_VERSION}-${process.platform}-${vscode.version}-mcp-controlled-provider.png`)});
    await view.getByRole('tab', {name: '02 · Implementation', exact: true}).click();
    assert.match(await view.locator('.warning').innerText(), /Git checkpoint.*isolated copy.*diff review/);
    await view.getByText('Configure the MCP implementation tool', {exact: true}).click();
    await view.getByRole('textbox', {name: 'Implementation tool name', exact: true}).fill('implement_perfchecker');
    await view.getByRole('button', {name: 'Save implementation tool', exact: true}).click();
    await eventually(async () => /Implementation tool saved/.test((await state()).status), 'The native tool configuration is saved');
    log('native-ui-action',{surface:'MCP implementation',action:'Prepare implementation after review'});
    await view.getByRole('button', {name: 'I reviewed the advice · Prepare implementation', exact: true}).click();
    await eventually(async () => {const value = await state(); return !value.busy && value.proposal?.files.includes('src/PerfCheckerNativeFixture.jl');}, 'The real implementation worker returns its Git proposal', 240000);
    assert.equal(await fs.readFile(source, 'utf8'), original);
    assert.match((await state()).backupRef, /^refs\/perfchecker\/checkpoints\//);
    log('native-ui-action',{surface:'MCP implementation',action:'Open full diff'});
    await view.getByRole('button', {name: 'Open full diff', exact: true}).click();
    await eventually(() => vscode.workspace.textDocuments.some(document => document.languageId === 'diff' && document.getText().includes('init=zero')), 'The actual diff editor opens');
    await vscode.commands.executeCommand('perfchecker.openChat'); view = await findFrame('#chat-root');
    log('native-ui-action',{surface:'MCP implementation',action:'Apply reviewed changes'});
    await view.getByRole('button', {name: 'Apply reviewed changes', exact: true}).click();
    await eventually(async () => !((await state()).busy) && (await fs.readFile(source, 'utf8')) === proposed, 'Apply changes the original only after the native user click');
    assert.equal(await probe(workspace), implementationBytes);
    log('native-ui-action',{surface:'MCP implementation',action:'Restore previous code'});
    await view.getByRole('button', {name: 'Restore previous code', exact: true}).click();
    await eventually(async () => !((await state()).busy) && (await fs.readFile(source, 'utf8')) === original, 'Restore returns the exact original bytes');
    assert.deepEqual(await fs.readFile(path.join(workspace, '.git', 'index')), index);
    assert.equal(await git('rev-parse', 'HEAD'), head);
    await view.getByRole('button', {name: 'Discard proposal', exact: true}).click();
    await eventually(async () => !(await state()).proposal, 'Discard closes the recovery proposal');
    await view.getByRole('tab', {name: '01 · Advice', exact: true}).click();
    await view.locator('#chat-question').fill('native cancellation probe');
    await view.getByRole('button', {name: 'Send question', exact: true}).click();
    await eventually(() => pending.size > 0, 'The actual MCP request reached the provider');
    await view.getByRole('button', {name: 'Cancel request', exact: true}).click();
    await eventually(async () => !(await state()).busy, 'Cancel stops the real local Julia worker', 60000);
    assert.equal(await fs.readFile(source, 'utf8'), original);
    await view.getByRole('button', {name: 'New conversation', exact: true}).click();
    await eventually(async () => (await state()).messages.length === 0, 'The native clear command removes the conversation');
    log('native-mcp-advice-implementation-restore', {provider: 'deterministic real HTTP MCP server; no model credentials',
      adviceTurns: 2, checkpoint: true, diffEditor: true, apply: true, exactRestore: true, cancellation: true,
      allocationBaselineBytes: baselineBytes, allocationCandidateBytes: implementationBytes});
  } finally {
    for (const response of pending) response.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) await settings().update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  }
};
