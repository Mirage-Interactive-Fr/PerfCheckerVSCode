// Runs in an actual Electron extension host, using an independently installed VSIX.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const controls = require('./native-studio-controls.cjs');
const mcp = require('./native-mcp-controls.cjs');
const investigations = require('./native-investigation-controls.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {const value = await read(); if (value) return value;} catch (error) {last = error;}
    await delay(150);
  }
  throw new Error(`${description}${last ? `: ${last.message}` : ''}`);
}

exports.run = async () => {
  assert.equal(process.env.CI, 'true', 'Never run this host against a human VS Code installation');
  const phase = process.env.PERFCHECKER_NATIVE_PHASE;
  const workspace = process.env.PERFCHECKER_NATIVE_WORKSPACE;
  const output = process.env.PERFCHECKER_NATIVE_OUTPUT;
  assert(path.isAbsolute(workspace));
  assert(path.basename(path.dirname(workspace)).startsWith('perfchecker-public-vsix-'));
  const checks = [], failures = [];
  let browser, windowPage;
  const log = (name, detail = {}) => {checks.push({name, ...detail}); console.log(`NATIVE_CHECK ${name} ${JSON.stringify(detail)}`);};
  const runCase = async (name, run) => {
    try {await run(); log(name, {status: 'passed'});}
    catch (error) {
      failures.push({name, message: String(error), stack: error.stack});
      console.error(`NATIVE_FAILURE ${name}: ${error.stack || error}`);
      await windowPage?.screenshot({path: path.join(output, `${phase}-${name}.png`)}).catch(() => {});
    }
  };
  try {
    browser = await eventually(() => chromium.connectOverCDP('http://127.0.0.1:9222'), 'Connect to the disposable Electron host');
    windowPage = await eventually(async () => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('workbench')), 'Locate the actual VS Code workbench');
    const findFrame = selector => eventually(async () => {
      for (const context of browser.contexts()) for (const page of context.pages()) for (const frame of page.frames()) {
        if (await frame.locator(selector).first().isVisible().catch(() => false)) return frame;
      }
    }, `Locate the real webview ${selector}`);
    const extension = vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');
    assert(extension, 'The product must come from the separate installed VSIX');
    assert.equal(extension.packageJSON.version, process.env.PERFCHECKER_NATIVE_EXPECTED_VERSION);
    assert(!extension.extensionPath.includes('qualification-host'));
    await extension.activate();
    const registered = new Set(await vscode.commands.getCommands(true));
    const commands = extension.packageJSON.contributes.commands.map(command => command.command);
    for (const command of commands) assert(registered.has(command), `Contributed command is registered: ${command}`);
    log('installed-extension', {version: extension.packageJSON.version, vscode: vscode.version, commands: commands.length,
      settings: Object.keys(extension.packageJSON.contributes.configuration.properties).length, vsixSha256: process.env.PERFCHECKER_NATIVE_SHA});
    const uri = vscode.Uri.file(workspace);
    const context = {vscode, browser, windowPage, workspace,
      controller: process.env.PERFCHECKER_NATIVE_CONTROLLER, target: process.env.PERFCHECKER_NATIVE_TARGET,
      results: path.join(workspace, 'perf', 'results', 'vscode'), log, findFrame};

    if (phase === 'fresh') {
      assert(!vscode.extensions.getExtension('julialang.language-julia'));
      assert(!vscode.extensions.getExtension('ms-toolsai.jupyter'));
      await runCase('first-open-studio', () => controls.runFresh(context));
      await runCase('missing-controller-terminal', async () => {
        await assert.rejects(vscode.commands.executeCommand('perfchecker.openTerminal', uri), /Project\.toml|controller|runnerProject/i);
      });
      await runCase('missing-julia-debug', async () => {
        await assert.rejects(vscode.commands.executeCommand('perfchecker.debugFile', uri), /Install the Julia VS Code extension/i);
      });
      await runCase('missing-controller-initialize', async () => {
        await assert.rejects(vscode.commands.executeCommand('perfchecker.initialize'), /controller Project\.toml not found.*perfchecker\.runnerProject/i);
        log('bootstrap-prerequisite', {controllerAbsent: true, initializeCurrentlyBlocked: true});
      });
    } else {
      const settings = vscode.workspace.getConfiguration('perfchecker', uri);
      for (const [key, value] of Object.entries({juliaExecutable: process.env.PERFCHECKER_NATIVE_JULIA,
        runnerProject: context.controller, scenarioProject: context.controller,
        suite: 'perf/suite.jl', profile: 'quick', reports: 'perf/results/vscode', advisorEnabled: false,
        scenarioSamples: 2, analysisTools: []})) {
        await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
      }
      await runCase('controller-visible-in-studio', async () => {
        await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace', uri);
        const frame = await findFrame('#studio-root');
        await frame.getByText('Workspace environment', {exact: true}).click();
        assert((await frame.locator('details.environment').innerText()).includes(context.controller));
      });
      await runCase('native-julia-terminal', async () => {
        const terminal = await vscode.commands.executeCommand('perfchecker.openTerminal', uri);
        assert(terminal && await terminal.processId, 'Julia runs in the actual integrated terminal');
        const marker = path.join(workspace, 'terminal-version.txt');
        terminal.sendText(`using PerfChecker; write(${JSON.stringify(marker)}, string(Base.pkgversion(PerfChecker)))`);
        await eventually(async () => (await fs.readFile(marker, 'utf8')) === '1.0.0', 'The integrated terminal imports registered PerfChecker 1.0.0', 180000);
        assert.strictEqual(await vscode.commands.executeCommand('perfchecker.openTerminal', uri), terminal, 'The project terminal is reused');
        terminal.dispose();
      });
      if (phase === 'configured') {
        await runCase('notebook-missing-prerequisite', async () => {
          assert(!vscode.extensions.getExtension('ms-toolsai.jupyter'));
          try {
            const notebookUri = await vscode.commands.executeCommand('perfchecker.newNotebook', uri);
            const document = vscode.workspace.notebookDocuments.find(document => document.uri.toString() === notebookUri.toString());
            assert(document, 'The available native serializer opens the actual notebook');
            assert(document.getCells().some(cell => /Select the \*\*Julia\*\* kernel/.test(cell.document.getText())), 'The notebook explains the Julia kernel prerequisite');
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            log('notebook-native-serializer-available', {jupyterInstalled: false, kernelExplained: true});
          } catch (error) {
            assert.match(String(error), /install.*jupyter|jupyter.*install|notebook.*extension/i,
              'Unavailable notebook serialization must explain how to obtain its provider');
          }
        });
      } else {
        await runCase('native-notebook-with-jupyter', async () => {
          assert(vscode.extensions.getExtension('ms-toolsai.jupyter'));
          const notebookUri = await vscode.commands.executeCommand('perfchecker.newNotebook', uri);
          const document = vscode.workspace.notebookDocuments.find(document => document.uri.toString() === notebookUri.toString());
          assert(document && document.cellCount > 0, 'A real investigation notebook was opened');
          assert.equal(document.notebookType, 'jupyter-notebook');
          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        });
        await runCase('native-suite-run-button', async () => {context.results = await controls.runSelection(context);});
        await runCase('native-suite-save-palette', async () => {
          await vscode.commands.executeCommand('perfchecker.openDesignerForWorkspace', uri);
          const frame = await findFrame('#save');
          await frame.locator('#save').click();
          await eventually(() => fs.readFile(path.join(workspace, 'perf', 'perfchecker-ui.json'), 'utf8').then(JSON.parse), 'Native Save button writes the shared configuration');
          const title = `Unsaved palette state ${Date.now()}`;
          await frame.locator('#doc-title').fill(title);
          await vscode.commands.executeCommand('perfchecker.saveConfiguration');
          const saved = JSON.parse(await fs.readFile(path.join(workspace, 'perf', 'perfchecker-ui.json'), 'utf8'));
          assert.equal(saved.documentation.blocks[0].title, title, 'Palette Save persists current unsaved editor state');
        });
        await runCase('native-testitem-measurement', async () => {
          const create = vscode.tests.createTestController;
          let native;
          const passed = [], failed = [];
          vscode.tests.createTestController = (...args) => {
            const controller = create(...args);
            if (args[0].startsWith('perfchecker.testitems.')) {
              const profile = controller.createRunProfile.bind(controller);
              controller.createRunProfile = (...profileArgs) => {
                native = {controller, run: profileArgs[2]}; return profile(...profileArgs);
              };
              const createRun = controller.createTestRun.bind(controller);
              controller.createTestRun = (...runArgs) => {
                const run = createRun(...runArgs);
                for (const method of ['passed', 'failed', 'errored']) {
                  const original = run[method].bind(run);
                  run[method] = (item, value, ...rest) => {
                    (method === 'passed' ? passed : failed).push({id: item.id, value});
                    return original(item, value, ...rest);
                  };
                }
                return run;
              };
            }
            return controller;
          };
          try {
            await vscode.commands.executeCommand('perfchecker.discoverTestItems', uri);
            assert(native, 'The actual native TestController was registered');
            const items = []; native.controller.items.forEach(item => items.push(item));
            assert.deepEqual(items.map(item => item.label), ['Vector reduction']);
            const token = new vscode.CancellationTokenSource();
            try {await native.run(new vscode.TestRunRequest([items[0]]), token.token);} finally {token.dispose();}
            assert.deepEqual(failed, [], 'The actual General-backed worker reports no errors');
            assert.equal(passed.length, 1); assert.equal(passed[0].id, items[0].id);
            assert(Number.isFinite(passed[0].value) && passed[0].value >= 0, 'Measured duration reaches VS Code Testing');
            log('testitem-current-evidence', {items: 1, durationMs: passed[0].value, core: 'General 1.0.0'});
          } finally {vscode.tests.createTestController = create;}
        });
        if (process.env.PERFCHECKER_NATIVE_STAGE === 'full') {
          await runCase('native-all-studio-controls', () => controls.run(context));
          await runCase('native-investigation-controls', () => investigations.run(context));
          await runCase('native-mcp-controls', () => mcp.run(context));
        }
      }
    }
  } catch (error) {failures.push({name: 'host-bootstrap', message: String(error), stack: error.stack});}
  finally {
    await fs.writeFile(path.join(output, `${phase}.json`), JSON.stringify({status: failures.length ? 'failed' : 'passed',
      phase, coverage: 'first-install-and-first-run-smoke', checks, failures}, null, 2));
    await browser?.close().catch(() => {});
  }
  if (failures.length) throw new Error(`${phase}: ${failures.length} native smoke check(s) failed; see the uploaded evidence`);
};
