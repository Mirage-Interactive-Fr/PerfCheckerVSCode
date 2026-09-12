const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const resultPath = process.env.PERFCHECKER_HOST_RESULT || path.join(__dirname, '..', '.lab', 'host-result.json');
exports.run = async () => {
  const checks = [];
  try {
    const extension = vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');
    assert.ok(extension); await extension.activate(); checks.push('extension activation');
    const discovery = await vscode.commands.executeCommand('perfchecker.discoverScenarios');
    assert.equal(discovery.declared.length, 5); checks.push('real CLI discovery and webview');
    const inventory=await vscode.commands.executeCommand('perfchecker.catalogTools');
    assert.ok(inventory.tools.length>=40); checks.push('tool catalogue from public CLI');
    const sync=await vscode.commands.executeCommand('perfchecker.syncScenarios');
    assert.equal(sync.authority,'proposal_only'); checks.push('CI and scenario synchronization');
    const source = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'cases.jl');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source));
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', vscode.Uri.file(source));
    assert.ok(lenses.some(l => l.command?.command === 'perfchecker.diagnoseScenarios')); checks.push('Julia editor CodeLens');
    const first = discovery.declared.find(s => s.id === 'sort-values');
    const key = JSON.stringify([first.id, first.implementation]);
    await vscode.workspace.getConfiguration('perfchecker').update('investigationMaxExperiments',1,vscode.ConfigurationTarget.Workspace);
    const investigated=await vscode.commands.executeCommand('perfchecker.investigateScenarios',[key]);
    assert.equal(investigated.experiments.length,1); assert.ok(investigated.unexecuted.length>0);
    assert.equal(investigated.code_modified,false); checks.push('bounded investigation and retained unexecuted cases');
    const measurements = await vscode.commands.executeCommand('perfchecker.measureScenarios', [key]);
    assert.equal(measurements.runs.length, 3);
    assert.ok(measurements.runs.every(r => r.qualification.correctness === 'passed')); checks.push('real measurements through extension');
    const dynamic = discovery.declared.find(s => s.id === 'dynamic-ui');
    const diagnosis = await vscode.commands.executeCommand('perfchecker.diagnoseScenarios', [JSON.stringify([dynamic.id, dynamic.implementation])]);
    assert.equal(diagnosis.records[0].status, 'complete');
    assert.ok(diagnosis.records[0].findings.length > 0); checks.push('real JET diagnosis and automatic saved-evidence advice');
    const problems = vscode.languages.getDiagnostics().flatMap(([uri, ds]) => ds.filter(d => d.source === 'PerfChecker').map(d => ({uri, d})));
    assert.ok(problems.length > 0); checks.push('Problems source diagnostics');
    const problemDocument = await vscode.workspace.openTextDocument(problems[0].uri);
    await vscode.window.showTextDocument(problemDocument);
    const row = Math.min(problemDocument.lineCount - 1, problems[0].d.range.start.line);
    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', problems[0].uri,
      new vscode.Range(row, 0, row, 1), vscode.CodeActionKind.QuickFix.value);
    assert.ok(actions.some(a => a.command?.command === 'perfchecker.openInvestigations')); checks.push('evidence code action');
    const started = Date.now();
    const slow = vscode.commands.executeCommand('perfchecker.measureScenarios', [JSON.stringify(['slow-ui', 'default'])]);
    setTimeout(() => void vscode.commands.executeCommand('perfchecker.cancelInvestigation'), 2000);
    await slow; assert.ok(Date.now() - started < 15000); checks.push('cancellation of isolated process tree');
    await fs.writeFile(resultPath, JSON.stringify({status: 'passed', checks}, null, 2));
  } catch (error) {
    await fs.writeFile(resultPath, JSON.stringify({status: 'failed', checks, error: String(error), stack: error.stack}, null, 2));
    throw error;
  }
};
