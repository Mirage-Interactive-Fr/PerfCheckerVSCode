import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url), original = Module._load;
const {CodexConnector, shutdownCodexPreflights} = require('../dist/codexConnector.js');
const {localAdvisorConnection} = require('../dist/advisorConnection.js');
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
let gate, ready, connector, folderChanged;
const commands = new Map(), notices = [];
const vscode = {workspace: {isTrusted: true, workspaceFolders: [],
  getConfiguration: () => ({get: (_key, fallback) => fallback}),
  onDidChangeWorkspaceFolders: listener => {folderChanged = listener; return {dispose() {folderChanged = undefined;}};}
}, commands: {registerCommand: (name, run) => {commands.set(name, run); return {dispose() {commands.delete(name);}};}},
window: {showInformationMessage: value => notices.push(value), showErrorMessage() {}}};
class DelayedConnector extends CodexConnector {
  async start() {await super.start(); connector = this; ready.resolve(); await gate.promise; return this;}
}
Module._load = function(name, ...args) {
  if (name === 'vscode') return vscode;
  // Only CLI preflight is replaced; startup, token lifetime and HTTP disposal are real.
  if (name === './codexConnector') return {CodexConnector: DelayedConnector, inspectCodex: async () => 'qualified fixture CLI', shutdownCodexPreflights};
  return original.call(this, name, ...args);
};
let registerCodexConnections, shutdownCodexConnections;
try {({registerCodexConnections, shutdownCodexConnections} = require('../dist/codexIntegration.js'));}
finally {Module._load = original;}

for (const mode of ['removed', 'removed then reopened', 'replaced', 'trust revoked', 'extension disposed']) {
  test(`connector startup releases its real HTTP endpoint and token when ${mode}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-codex-lifecycle-'));
    const folder = {uri: {scheme: 'file', fsPath: root, toString: () => `file://${root}`}}, key = folder.uri.toString();
    const context = {subscriptions: []}; gate = deferred(); ready = deferred(); notices.length = 0;
    vscode.workspace.workspaceFolders = [folder]; vscode.workspace.isTrusted = true;
    registerCodexConnections(context, () => false, () => {});
    const pending = commands.get('perfchecker.connectCodex')();
    const outcome = pending.catch(error => error);
    try {
      await ready.promise;
      assert.equal((await fetch(connector.endpoint, {method: 'POST'})).status, 401);
      assert.equal(process.env[connector.keyEnvironment], connector.token);
      if (mode === 'removed') {vscode.workspace.workspaceFolders = []; folderChanged({removed: [folder]});}
      if (mode === 'removed then reopened') {folderChanged({removed: [folder]}); vscode.workspace.workspaceFolders = [folder];}
      if (mode === 'replaced') vscode.workspace.workspaceFolders = [{uri: {scheme: 'file', fsPath: root, toString: () => `${key}/other`}}];
      if (mode === 'trust revoked') vscode.workspace.isTrusted = false;
      if (mode === 'extension disposed') for (const subscription of context.subscriptions) subscription.dispose();
      gate.resolve();
      assert.match(String(await outcome), /Workspace changed before Codex connected/);
      assert.equal(localAdvisorConnection(key), undefined);
      assert.equal(process.env[connector.keyEnvironment], undefined);
      await assert.rejects(fetch(connector.endpoint));
      assert.deepEqual(notices, []);
    } finally {
      gate.resolve(); await outcome;
      for (const subscription of context.subscriptions) subscription.dispose();
      await shutdownCodexConnections();
      vscode.workspace.isTrusted = true; await rm(root, {recursive: true, force: true});
    }
  });
}


test('extension shutdown reports failed cleanup and retains the live endpoint and disconnect handle for retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-codex-shutdown-'));
  const folder = {uri: {scheme: 'file', fsPath: root, toString: () => `file://${root}`}}, key = folder.uri.toString();
  const context = {subscriptions: []}; gate = deferred(); ready = deferred(); gate.resolve();
  vscode.workspace.workspaceFolders = [folder]; vscode.workspace.isTrusted = true;
  registerCodexConnections(context, () => false, () => {});
  await commands.get('perfchecker.connectCodex')();
  const live = connector, dispose = live.dispose.bind(live); let fail = true, attempts = 0;
  live.dispose = async () => {attempts++; if (fail) throw new Error('Controlled physical cleanup unavailable'); await dispose();};
  try {
    await assert.rejects(shutdownCodexConnections(), error => {
      assert(error instanceof AggregateError); assert.match(error.message, /cleanup is incomplete/);
      assert(error.errors.some(cause => /Controlled physical cleanup unavailable/.test(String(cause)))); return true;
    });
    assert.equal(localAdvisorConnection(key)?.kind, 'codex');
    assert.equal(process.env[live.keyEnvironment], live.token);
    assert.equal((await fetch(live.endpoint, {method: 'POST'})).status, 401, 'No false extinction while cleanup is rejected');
    fail = false; await shutdownCodexConnections();
    assert.equal(attempts, 2); assert.equal(localAdvisorConnection(key), undefined);
    assert.equal(process.env[live.keyEnvironment], undefined); await assert.rejects(fetch(live.endpoint));
  } finally {
    fail = false; await shutdownCodexConnections();
    for (const subscription of context.subscriptions) subscription.dispose();
    await shutdownCodexConnections(); await rm(root, {recursive: true, force: true});
  }
});
