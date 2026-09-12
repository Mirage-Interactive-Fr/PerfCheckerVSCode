const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async () => {
  // The host initialized its I/O pool already. Bound new Julia child processes.
  process.env.UV_THREADPOOL_SIZE = '1';
  const checks = [];
  const root = process.env.PERFCHECKER_HOST_EVIDENCE;
  const bibliography = process.env.PERFCHECKER_HOST_BIBLIOGRAPHY === '1';
  try {
    const create = vscode.tests.createTestController;
    const controllers = [];
    const passed = [];
    const durations = [];
    vscode.tests.createTestController = (...args) => {
      const controller = create(...args);
      if (args[0].startsWith('perfchecker.testitems.')) {
        const createRun = controller.createTestRun.bind(controller);
        controller.createTestRun = (...runArgs) => {
          const execution = createRun(...runArgs);
          const markPassed = execution.passed.bind(execution);
          execution.passed = (item, duration, ...rest) => { passed.push(item.id); durations.push(duration); return markPassed(item, duration, ...rest); };
          return execution;
        };
        const profile = controller.createRunProfile.bind(controller);
        controller.createRunProfile = (...profileArgs) => {
          controllers.push({controller, run: profileArgs[2]});
          return profile(...profileArgs);
        };
      }
      return controller;
    };
    const extension = vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');
    assert.ok(extension); await extension.activate(); checks.push('real extension activation');
    await vscode.commands.executeCommand('perfchecker.discoverTestItems');
    assert.equal(controllers.length, 1);
    const {controller, run} = controllers[0];
    const items = []; controller.items.forEach(item => items.push(item));
    assert.deepEqual(items.map(item => item.label).sort(), bibliography
      ? ['Bibliography export workload', 'Bibliography format API']
      : ['Only performance', 'Shared assertion']);
    checks.push(bibliography ? 'discovers the shared and perf_only Bibliography items' : 'real TestController discovery excludes test_only');
    const selected = items.find(item => item.label === (bibliography ? 'Bibliography export workload' : 'Shared assertion'));
    const token = new vscode.CancellationTokenSource();
    await run(new vscode.TestRunRequest([selected]), token.token);
    token.dispose();
    const marker = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'calls.txt');
    if (!bibliography) assert.equal(await fs.readFile(marker, 'utf8'), 'shared\n');
    assert.deepEqual(passed, [selected.id]);
    assert.equal(durations.length, 1);
    assert.ok(Number.isFinite(durations[0]) && durations[0] >= 0);
    checks.push(bibliography ? 'actual profile handler measures the selected Bibliography export item' : 'actual profile handler runs one selected item exactly once');
    checks.push('measured duration reaches the native Testing API');
    await fs.writeFile(path.join(root, 'vscode-host-result.json'), JSON.stringify({status:'passed',checks,vscode_version:vscode.version,durations_ms:durations}, null, 2));
    if (process.env.PERFCHECKER_HOST_CAPTURE === '1') {
      await vscode.window.showTextDocument(selected.uri);
      await vscode.commands.executeCommand('workbench.view.testing.focus');
      await fs.writeFile(path.join(root, 'capture-ready.json'), JSON.stringify({status:'ready', labels:items.map(item => item.label)}));
      // Allow a real UI capture without changing or simulating the test outcome.
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        try { await fs.access(path.join(root, 'capture-done')); break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  } catch(error) {
    await fs.writeFile(path.join(root, 'vscode-host-result.json'), JSON.stringify({status:'failed',checks,error:String(error),stack:error.stack},null,2));
    throw error;
  }
};
