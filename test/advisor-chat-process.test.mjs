import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

let reply = '', workerError = '', exitCode = 0, largeChunks = false;
const invocations = [];
const spawn = (executable, args, options) => {
  invocations.push({executable, args, options});
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  setImmediate(() => {
    // Every byte boundary is exercised, including inside accents and emoji.
    if (largeChunks) {
      child.stdout.write(Buffer.from(reply));
      for (let i = 0; i < 32; i++) child.stdout.write(Buffer.alloc(65_536, 120));
      child.stderr.write(Buffer.from(workerError));
    } else {
      for (const byte of Buffer.from(reply)) child.stdout.write(Buffer.from([byte]));
      for (const byte of Buffer.from(workerError)) child.stderr.write(Buffer.from([byte]));
    }
    child.stdout.end(); child.stderr.end(); child.emit('close', exitCode);
  });
  return child;
};
const configuredProjects = {runnerProject: 'perf', scenarioProject: 'perf'};
const settings = {get: (name, fallback) => configuredProjects[name] ?? fallback};
const vscode = {workspace: {getConfiguration: () => settings}};
const original = Module._load, require = createRequire(import.meta.url);
Module._load = function (name, ...args) {
  if (name === 'vscode') return vscode;
  if (name === 'node:child_process') return {spawn};
  return original.call(this, name, ...args);
};
let AdvisorChat, InvestigationController;
try {
  ({AdvisorChat} = require('../dist/advisorChat.js'));
  ({InvestigationController} = require('../dist/investigation.js'));
} finally {Module._load = original;}

test('chat subprocess output preserves Unicode when UTF8 sequences cross chunks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-chat-unicode-'));
  try {
    await mkdir(path.join(root, 'perf'));
    await writeFile(path.join(root, 'perf', 'Project.toml'), '[deps]\n');
    const folder = {name: 'Unicode', uri: {fsPath: root}};
    const chat = new AdvisorChat({}, () => [], async () => {});
    const text = 'Réduis les allocations, préserve le résultat et vérifie 🧪.';
    reply = JSON.stringify({external_review: text}); workerError = ''; exitCode = 0;
    assert.deepEqual(await chat.invoke(folder, {}, {}), {external_review: text});
    reply = ''; workerError = 'Échec contrôlé : configuration à vérifier 🧪.'; exitCode = 1;
    await assert.rejects(chat.invoke(folder, {}, {}), error => error.message === workerError);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('chat and implementation use the controller while measurement keeps its separate worker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-advisor-projects-'));
  const projects = {...configuredProjects};
  try {
    configuredProjects.runnerProject = 'controller'; configuredProjects.scenarioProject = 'measurement';
    await mkdir(path.join(root, 'controller'));
    await mkdir(path.join(root, 'measurement'));
    await writeFile(path.join(root, 'controller', 'Project.toml'), '[deps]\nPerfChecker="6309bf6b-a531-4b08-891e-8ee981e5c424"\nHTTP="cd3eb016-35fb-5094-929b-558a96fad6f3"\n');
    await writeFile(path.join(root, 'measurement', 'Project.toml'), '[deps]\nBenchmarkTools="6e4b80f9-dd63-53aa-95a3-0cdb28fa8baf"\n');
    const folder = {name: 'Separate projects', uri: {fsPath: root}};
    const chat = new AdvisorChat({}, () => [], async () => {});
    reply = '{}'; workerError = ''; exitCode = 0;
    for (const command of ['chat', 'implement']) {
      await chat.invoke(folder, {}, {}, command);
      const {args} = invocations.at(-1), controller = path.join(root, 'controller');
      assert.equal(args[1], `--project=${controller}`);
      assert.ok(args.includes(command));
      assert.equal(args.at(-1), `--project=${controller}`);
      assert.ok(!args.includes(`--project=${path.join(root, 'measurement')}`));
    }
    const controller = Object.create(InvestigationController.prototype);
    controller.root = () => root; controller.folder = () => folder;
    controller.setting = (name, fallback) => configuredProjects[name] ?? fallback;
    controller.output = {append() {}, appendLine() {}};
    await controller.invoke('run', [`--project=${path.join(root, 'measurement')}`], root);
    const {args} = invocations.at(-1);
    assert.equal(args[1], `--project=${path.join(root, 'controller')}`);
    assert.ok(args.includes(`--project=${path.join(root, 'measurement')}`));
    assert.deepEqual(configuredProjects, {runnerProject: 'controller', scenarioProject: 'measurement'});
  } finally {
    Object.assign(configuredProjects, projects);
    await rm(root, {recursive: true, force: true});
  }
});

test('investigation subprocess preserves Unicode evidence and logs across byte chunks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-investigation-unicode-'));
  try {
    await mkdir(path.join(root, 'perf'));
    await writeFile(path.join(root, 'perf', 'Project.toml'), '[deps]\n');
    const controller = Object.create(InvestigationController.prototype);
    controller.root = () => root; controller.folder = () => ({uri: {fsPath: root}});
    controller.setting = (_name, fallback) => fallback;
    let display = '';
    controller.output = {append: text => {display += text;}, appendLine() {}};
    reply = JSON.stringify({id: 'scénario 🧪', message: 'Mesure vérifiée'});
    workerError = 'Diagnostic complémentaire é'; exitCode = 0;
    const result = await controller.invoke('discover', [], root);
    assert.deepEqual(JSON.parse(result.stdout), {id: 'scénario 🧪', message: 'Mesure vérifiée'});
    assert.ok(display.includes(workerError)); assert.ok(display.includes('scénario 🧪'));
    assert.equal(await readFile(path.join(root, 'worker.log'), 'utf8'), reply + workerError);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('output overflow stays bounded while final cleanup errors remain visible', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-investigation-overflow-'));
  try {
    await mkdir(path.join(root, 'perf'));
    await writeFile(path.join(root, 'perf', 'Project.toml'), '[deps]\n');
    const controller = Object.create(InvestigationController.prototype);
    controller.root = () => root; controller.folder = () => ({uri: {fsPath: root}});
    controller.setting = (_name, fallback) => fallback;
    let display = '', cancellations = 0;
    controller.output = {append: text => {display += text;}, appendLine: text => {display += text;}};
    controller.cancel = () => {cancellations++;};
    reply = 'x'.repeat(32_000_001); workerError = 'x'.repeat(200_000) + '\nCleanup incomplete; retained at /private/inventory\n';
    exitCode = 2; largeChunks = true;
    await assert.rejects(controller.invoke('run', [], root), /exceeded 32 MB/);
    assert.equal(cancellations, 1);
    assert.ok(display.length < 70_000);
    assert.match(display, /retained at \/private\/inventory/);
    const log = await readFile(path.join(root, 'worker.log'), 'utf8');
    assert.ok(log.length <= 65_536);
    assert.match(log, /retained at \/private\/inventory/);
  } finally {largeChunks = false; await rm(root, {recursive: true, force: true});}
});
