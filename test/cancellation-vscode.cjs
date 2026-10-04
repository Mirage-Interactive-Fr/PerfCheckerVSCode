const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const wait = async predicate => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100));}
  throw new Error('Cancellation fixture never reached measurement');
};
exports.run = async () => {
  process.env.UV_THREADPOOL_SIZE = '1';
  const checks = [], root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const messages = [], profiles = [], output = [];
  let progressToken;
  const originalProgress = vscode.window.withProgress, originalInfo = vscode.window.showInformationMessage;
  const originalController = vscode.tests.createTestController;
  const originalOutput = vscode.window.createOutputChannel;
  vscode.window.createOutputChannel = (...args) => {
    const channel = originalOutput(...args);
    for (const method of ['append', 'appendLine']) {
      const append = channel[method].bind(channel);
      channel[method] = value => {output.push(value); return append(value);};
    }
    return channel;
  };
  vscode.window.showInformationMessage = (...args) => {messages.push(args[0]); return originalInfo(...args);};
  vscode.window.withProgress = (options, task) => originalProgress(options, (progress, originalToken) => {
    if (!options.title?.match(/run\(s\)/)) return task(progress, originalToken);
    assert.equal(options.cancellable, true);
    progressToken = new vscode.CancellationTokenSource();
    return task(progress, progressToken.token).finally(() => progressToken.dispose());
  });
  vscode.tests.createTestController = (...args) => {
    const controller = originalController(...args), original = controller.createRunProfile.bind(controller);
    controller.createRunProfile = (...profile) => {if (profile[0] === 'Run') profiles.push({controller, run: profile[2]}); return original(...profile);};
    return controller;
  };
  try {
    const extension = vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');
    assert.ok(extension); await extension.activate();
    await vscode.commands.executeCommand('perfchecker.refresh');
    const modes = process.env.PERFCHECKER_CANCEL_CASE ? [process.env.PERFCHECKER_CANCEL_CASE] : ['notification', 'testing', 'cleanup-failure'];
    for (const mode of modes) {
      const marker = path.join(root, 'measuring'); await fs.rm(marker, {force: true});
      if (mode === 'cleanup-failure') await fs.writeFile(path.join(root, 'fail-cleanup'), 'fail');
      let cancellation, running;
      if (mode !== 'testing') running = vscode.commands.executeCommand('perfchecker.runAll');
      else {
        cancellation = new vscode.CancellationTokenSource();
        assert.equal(profiles.length, 1);
        running = profiles[0].run(new vscode.TestRunRequest(), cancellation.token);
      }
      let earlyFailure;
      running.catch(error => {earlyFailure = error;});
      await wait(async () => earlyFailure || !!(await fs.stat(marker).catch(() => undefined)));
      if (earlyFailure) throw earlyFailure;
      const pid = Number(await fs.readFile(marker, 'utf8'));
      const started = Date.now();
      (cancellation || progressToken).cancel();
      await assert.rejects(vscode.commands.executeCommand('perfchecker.runAll'), /active suite|cleanup/);
      if (mode === 'cleanup-failure') await assert.rejects(running, /code 2|cleanup/);
      else await running;
      assert.ok(Date.now() - started < 60000);
      assert.throws(() => process.kill(pid, 0));
      const previous = path.join(root, 'src', `operation.jl.${pid}.mem`);
      if (mode === 'cleanup-failure') {
        const retained = output.join('\n').match(/private inventories retained at ([^;\r\n]+)/)?.[1];
        assert.ok(retained); assert.ok(path.basename(retained).startsWith('perfchecker-check-'));
        await fs.rm(previous, {recursive: true});
        const settings = vscode.workspace.getConfiguration('perfchecker');
        const quoted = JSON.stringify(retained).replaceAll('$', '\\$');
        await promisify(execFile)(settings.get('juliaExecutable'), ['--startup-file=no', `--project=${settings.get('runnerProject')}`, '-e',
          `using PerfChecker,TOML; root=${quoted}; d=TOML.parsefile(joinpath(root,"allocation-inventory.toml")); a=PerfChecker.AllocationArtifacts(d["worker_pid"],String.(d["roots"]),Dict{String,PerfChecker.AllocationSnapshot}(),joinpath(root,d["journal"])); PerfChecker._cleanup_allocation_artifacts!(a); rm(root;recursive=true)`]);
        checks.push('cleanup failure after real cancellation stays failed; retained inventory remains visible and restores original bytes');
      }
      assert.equal(await fs.readFile(previous, 'utf8'), 'previous bytes\r\n');
      assert.equal(await fs.readFile(path.join(root, 'src', 'operation.jl.987654321.mem'), 'utf8'), 'foreign trace\r\n');
      assert.equal(await fs.readFile(path.join(root, 'src', 'notes.mem'), 'utf8'), 'user notes\n');
      assert.equal((await fs.readdir(path.join(root, 'src'))).filter(name => name.endsWith('.mem')).length, 3);
      assert.ok(!messages.includes('PerfChecker run completed.'));
      await fs.rm(previous); cancellation?.dispose();
      checks.push(`${mode}: actual suite alloc cancelled after worker exit, exact restoration, foreign files preserved, no success toast and no concurrent next run`);
    }
    await fs.writeFile(process.env.PERFCHECKER_CANCEL_RESULT, JSON.stringify({status: 'passed', vscode: vscode.version, platform: process.platform, checks}));
  } catch (error) {
    await fs.writeFile(process.env.PERFCHECKER_CANCEL_RESULT, JSON.stringify({status: 'failed', checks, error: String(error), stack: error.stack}));
    throw error;
  } finally {
    vscode.window.withProgress = originalProgress; vscode.window.showInformationMessage = originalInfo;
    vscode.tests.createTestController = originalController;
    vscode.window.createOutputChannel = originalOutput;
  }
};
