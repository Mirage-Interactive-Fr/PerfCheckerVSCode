import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

let reply = '', workerError = '', exitCode = 0;
const spawn = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  setImmediate(() => {
    // Every byte boundary is exercised, including inside accents and emoji.
    for (const byte of Buffer.from(reply)) child.stdout.write(Buffer.from([byte]));
    for (const byte of Buffer.from(workerError)) child.stderr.write(Buffer.from([byte]));
    child.stdout.end(); child.stderr.end(); child.emit('close', exitCode);
  });
  return child;
};
const settings = {get: (name, fallback) => ({runnerProject: 'perf', scenarioProject: 'perf'})[name] ?? fallback};
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
