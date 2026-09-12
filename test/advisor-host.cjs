// Run with --extensionTestsPath against an isolated, prepared Julia fixture workspace.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async () => {
  const checks = [], calls = [];
  const server = http.createServer(async (req, res) => {
    let bytes = ''; for await (const data of req) bytes += data;
    const body = bytes ? JSON.parse(bytes) : {};
    calls.push({url: req.url, body});
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({models: [{name: 'tiny:latest', size: 523000000}]}));
    if (req.url !== '/mcp') {res.statusCode = 404; return res.end('{}');}
    const result = body.method === 'tools/list' ? {tools: [{name: 'ask', description: 'Performance advice', inputSchema: {type: 'object', required: ['question'], properties: {question: {type: 'string'}}}}]} :
      {content: [{type: 'text', text: 'Vérifie les allocations puis compare les deux implémentations. <script>not executable</script>'}]};
    res.end(JSON.stringify({jsonrpc: '2.0', id: body.id, result}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const extension = vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');
    assert.ok(extension); await extension.activate();
    await vscode.commands.executeCommand('perfchecker.configureAdvisor'); checks.push('configuration webview opened in actual VS Code host');
    const config = {protocol: 'mcp_http', endpoint: `http://127.0.0.1:${port}/mcp`, model: 'mock MCP', timeout: 120,
      mcp_tool: '', instructions: 'Préserver l’API publique.', mcp_response: 'text', mcp_prompt_argument: 'question'};
    const probe = await vscode.commands.executeCommand('perfchecker.advisorSetupAction', {action: 'probe', config});
    assert.equal(probe.status, 'complete'); assert.equal(probe.tools[0].name, 'ask');
    assert.equal(calls.filter(c => c.body.method === 'tools/call').length, 0); checks.push('MCP discovery through real isolated Julia worker without tool invocation');
    config.mcp_tool = 'ask';
    const saved = await vscode.commands.executeCommand('perfchecker.advisorSetupAction', {action: 'save', config});
    assert.equal(saved.status, 'complete');
    const settings = vscode.workspace.getConfiguration('perfchecker');
    const file = path.resolve(vscode.workspace.workspaceFolders[0].uri.fsPath, settings.get('advisorConfig'));
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).instructions, config.instructions); checks.push('configuration saved and selected for investigations');
    const ollama = await vscode.commands.executeCommand('perfchecker.advisorSetupAction', {action: 'models', config: {protocol: 'ollama', endpoint: `http://127.0.0.1:${port}/api/chat`, model: 'tiny:latest', timeout: 120}});
    assert.equal(ollama.models[0].size_bytes, 523000000); checks.push('local model inventory and disk-size data');
    const discovery = await vscode.commands.executeCommand('perfchecker.discoverScenarios');
    const dynamic = discovery.declared.find(s => s.id === 'dynamic-ui'); assert.ok(dynamic);
    const diagnosis = await vscode.commands.executeCommand('perfchecker.diagnoseScenarios', [JSON.stringify([dynamic.id, dynamic.implementation])]);
    assert.ok(diagnosis.records[0].findings.length); checks.push('real JET evidence obtained from fixture');
    const report = await vscode.commands.executeCommand('perfchecker.narrateAdvice');
    assert.equal(report.status, 'complete'); assert.equal(report.reference_status, 'unstructured_not_verified');
    assert.ok(report.external_review.includes('allocations')); assert.equal(report.cards.length, 0);
    const toolCall = calls.find(c => c.body.method === 'tools/call');
    assert.ok(toolCall.body.params.arguments.question.includes(config.instructions)); checks.push('saved evidence and custom prompt sent to MCP, free advice kept unverified');
    await vscode.commands.executeCommand('perfchecker.advisorSetupAction', {action: 'save', config: null});
    assert.equal(vscode.workspace.getConfiguration('perfchecker').get('advisorEnabled'), false); checks.push('deterministic-only mode persists without deleting model files');
    await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT, JSON.stringify({status: 'passed', checks}, null, 2));
  } catch (error) {
    await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT, JSON.stringify({status: 'failed', checks, error: String(error), stack: error.stack}, null, 2));
    throw error;
  } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
};
