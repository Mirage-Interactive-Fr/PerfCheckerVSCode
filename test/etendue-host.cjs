const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const resultPath = process.env.PERFCHECKER_HOST_RESULT;

exports.run = async () => {
  const checks = [];
  try {
    const extension = vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');
    await extension.activate();
    const discovery = await vscode.commands.executeCommand('perfchecker.discoverScenarios');
    assert.equal(discovery.declared.length, 5);
    assert.ok(['gc', 'memory', 'heap', 'locks'].every(id => discovery.analyzers.some(a => a.tool === id)));
    checks.push('Étendue discovery and dynamic analyzer capabilities');
    const keys = discovery.declared.filter(s => s.id === 'geometry-translation')
      .map(s => JSON.stringify([s.id, s.implementation]));
    const measurements = await vscode.commands.executeCommand('perfchecker.measureScenarios', keys);
    assert.equal(measurements.runs.length, 2);
    assert.ok(measurements.runs.every(r => r.qualification.correctness === 'passed'));
    checks.push('Geometry allocating and in-place implementations measured and verified from VS Code');
    const config = vscode.workspace.getConfiguration('perfchecker');
    await config.update('analysisTools', ['memory', 'gc', 'locks', 'heap'], vscode.ConfigurationTarget.Workspace);
    const diagnosis = await vscode.commands.executeCommand('perfchecker.diagnoseScenarios', [keys[1]]);
    assert.equal(diagnosis.records.length, 4);
    assert.ok(diagnosis.records.every(r => r.status === 'complete' && r.correctness === 'passed'));
    assert.ok(diagnosis.records.every(r => typeof r.summary === 'string' && r.summary.length > 20));
    checks.push('Four new diagnostics launched through the extension');
    const artifact = diagnosis.records.flatMap(r => r.artifacts ?? [])[0];
    assert.equal(artifact.kind, 'heap_snapshot');
    assert.ok(artifact.redacted && (await fs.stat(artifact.path)).size > 0);
    await vscode.commands.executeCommand('perfchecker.openEvidenceArtifact', artifact.path);
    checks.push('Recorded heap snapshot opened in VS Code');
    await assert.rejects(vscode.commands.executeCommand('perfchecker.openEvidenceArtifact',
      path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'cases.jl')));
    checks.push('Artifact opening rejects paths absent from the evidence');
    await fs.appendFile(artifact.path, '\nmodified after diagnosis');
    await assert.rejects(vscode.commands.executeCommand('perfchecker.openEvidenceArtifact', artifact.path));
    checks.push('Artifact opening rejects a modified snapshot');
    await fs.writeFile(resultPath, JSON.stringify({status: 'passed', checks}, null, 2));
  } catch (error) {
    await fs.writeFile(resultPath, JSON.stringify({status: 'failed', checks, error: String(error), stack: error.stack}, null, 2));
    throw error;
  }
};
