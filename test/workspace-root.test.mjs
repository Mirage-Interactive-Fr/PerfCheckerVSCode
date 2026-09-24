import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {resolveWorkspaceFolder, resolveControllerProject} = require('../dist/workspace-root.js');
const uri = fsPath => ({scheme: 'file', fsPath, toString: () => `file://${fsPath}`});
const folder = fsPath => ({uri: uri(fsPath), name: path.basename(fsPath)});

test('explicit workspace command is discoverable before activation', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.commands.some(item => item.command === 'perfchecker.openDesignerForWorkspace'));
  assert.ok(manifest.activationEvents.includes('onCommand:perfchecker.openDesignerForWorkspace'));
});

test('explicit workspace selection rejects ambiguity and foreign folders', () => {
  const one = folder('/tmp/one');
  const two = folder('/tmp/two');
  assert.equal(resolveWorkspaceFolder([one]), one);
  assert.equal(resolveWorkspaceFolder([one, two], two.uri), two);
  assert.equal(resolveWorkspaceFolder([one, two], two), two);
  assert.throws(() => resolveWorkspaceFolder([one, two]), /explicitly/);
  assert.throws(() => resolveWorkspaceFolder([one, two], uri('/tmp/other')), /not an open/);
  assert.throws(() => resolveWorkspaceFolder([one, two], {scheme: 'https', toString: () => 'https://example.com'}), /local file/);
  assert.throws(() => resolveWorkspaceFolder([one, two], '/tmp/two'), /folder or URI/);
});

test('controller resolution is folder scoped, honors explicit settings, and never selects perf/runner', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'perfchecker-controller-'));
  try {
    const a = path.join(temporary, 'A');
    const b = path.join(temporary, 'B');
    await mkdir(path.join(a, 'perf', 'controller'), {recursive: true});
    await mkdir(path.join(b, 'perf', 'runner'), {recursive: true});
    await writeFile(path.join(a, 'perf', 'controller', 'Project.toml'), 'name = "AController"\n');
    await writeFile(path.join(b, 'perf', 'runner', 'Project.toml'), 'name = "BRunner"\n');
    const settings = (value = 'perf', explicit = false) => ({
      get: () => value,
      inspect: () => explicit ? {workspaceFolderValue: value} : {defaultValue: 'perf'},
    });
    assert.equal(resolveControllerProject(a, settings()).project, path.join(a, 'perf', 'controller'));
    assert.match(resolveControllerProject(a, settings()).reason, /default perf absent/);
    assert.throws(() => resolveControllerProject(b, settings()), /perf[/\\]Project.toml/);
    assert.throws(() => resolveControllerProject(a, settings('perf', true)), /perf[/\\]Project.toml/);
    assert.equal(resolveControllerProject(b, settings('perf/runner', true)).project,
      path.join(b, 'perf', 'runner'));
    await writeFile(path.join(a, 'perf', 'Project.toml'), 'name = "ADefault"\n');
    assert.equal(resolveControllerProject(a, settings()).project, path.join(a, 'perf'));
  } finally { await rm(temporary, {recursive: true, force: true}); }
});

test('multi-root activation does not plan; explicit designer plans only the selected folder', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'perfchecker-root-'));
  try {
    const first = folder(path.join(temporary, 'first'));
    const second = folder(path.join(temporary, 'second'));
    await mkdir(path.join(second.uri.fsPath, 'perf', 'controller'), {recursive: true});
    await writeFile(path.join(second.uri.fsPath, 'perf', 'controller', 'Project.toml'), 'name = "PerfController"\n');
    await writeFile(path.join(second.uri.fsPath, 'perf', 'suite.jl'), 'build_suite() = nothing\n');
    const commands = new Map();
    const spawned = [];
    const configurationScopes = [];
    const vscode = {
      EventEmitter: class { event = () => undefined; fire() {} },
      workspace: {
        workspaceFolders: [first, second],
        getConfiguration: (_section, resource) => {
          configurationScopes.push(resource?.toString());
          return {
          get: (key, fallback) => ({juliaExecutable: 'julia', runnerProject: 'perf', suite: 'perf/suite.jl',
            factory: 'build_suite', profile: 'quick'})[key] ?? fallback,
          inspect: () => undefined,
          update: async () => undefined,
          };
        },
      },
      window: {
        createOutputChannel: () => ({show() {}, append() {}, appendLine() {}}),
        createTreeView: () => ({onDidChangeCheckboxState: () => ({})}),
        withProgress: (_options, callback) => callback(),
      },
      tests: {createTestController: () => ({
        items: {replace() {}}, createRunProfile() {},
      })},
      commands: {registerCommand: (name, callback) => { commands.set(name, callback); return {}; }},
      TestRunProfileKind: {Run: 1},
      ProgressLocation: {Window: 1, Notification: 2},
    };
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function (id, parent, isMain) {
      if (id === 'vscode') return vscode;
      if (id === './investigation') return {registerInvestigations() {}};
      if (id === './testitems') return {registerNativeTestItems() {}};
      if (id === 'node:child_process') return {spawn: (executable, args, options) => {
        spawned.push({executable, args, options});
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stdout.setEncoding = () => undefined;
        child.stderr = new EventEmitter(); child.stderr.setEncoding = () => undefined;
        queueMicrotask(() => child.emit('close', args.includes('using Pkg; Pkg.instantiate()') ? 0 : 2));
        return child;
      }};
      return originalLoad.call(this, id, parent, isMain);
    };
    let extension;
    try { extension = require('../dist/extension.js'); }
    finally { Module._load = originalLoad; }
    extension.activate({subscriptions: [], globalStorageUri: {fsPath: path.join(temporary, 'storage')}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(spawned.length, 0);
    const open = commands.get('perfchecker.openDesigner');
    const explicit = commands.get('perfchecker.openDesignerForWorkspace');
    assert.throws(() => explicit(), /Pass an open workspace folder/);
    await assert.rejects(explicit(uri(path.join(temporary, 'foreign'))), /not an open/);
    await assert.rejects(open(), /explicitly/);
    await assert.rejects(open(uri(path.join(temporary, 'foreign'))), /not an open/);
    assert.equal(spawned.length, 0);
    await assert.rejects(open(first.uri), /controller Project.toml not found/);
    assert.equal(spawned.length, 0);
    await assert.rejects(explicit(second), /plan failed/);
    assert.equal(spawned.length, 2);
    assert.equal(spawned[0].options.cwd, path.join(second.uri.fsPath, 'perf', 'controller'));
    assert.ok(spawned[0].args.includes('using Pkg; Pkg.instantiate()'));
    assert.ok(spawned[0].args.includes(`--project=${path.join(second.uri.fsPath, 'perf', 'controller')}`));
    assert.equal(spawned[1].options.cwd, second.uri.fsPath);
    assert.ok(spawned[1].args.includes(`--project=${path.join(second.uri.fsPath, 'perf', 'controller')}`));
    assert.ok(spawned[1].args.includes(`--suite=${path.join(second.uri.fsPath, 'perf', 'suite.jl')}`));
    assert.ok(spawned[1].args.includes('--factory=build_suite'));
    await assert.rejects(explicit(second), /plan failed/);
    assert.equal(spawned.filter(call => call.args.includes('using Pkg; Pkg.instantiate()')).length, 1);
    assert.ok(configurationScopes.every(scope => scope === second.uri.toString() || scope === first.uri.toString()));
    assert.equal(configurationScopes.at(-1), second.uri.toString());
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
});
