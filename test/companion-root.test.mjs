import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const uri = name => ({scheme: 'file', fsPath: `/tmp/perfchecker-${name}`, toString: () => `file:///tmp/perfchecker-${name}`});
const first = {uri: uri('A'), name: 'A'};
const second = {uri: uri('B'), name: 'B'};

test('investigation and advisor commands fail closed, then use the selected B folder', async () => {
  const commands = new Map();
  const scopes = [];
  const updates = [];
  const vscode = {
    workspace: {
      workspaceFolders: [first, second], isTrusted: true,
      textDocuments: [],
      onDidChangeTextDocument: () => ({dispose() {}}),
      getConfiguration: (_section, resource) => {
        scopes.push(resource?.toString());
        return {get: (_key, fallback) => fallback, update: async (key, value, target) => updates.push({key, value, target})};
      },
    },
    window: {
      createOutputChannel: () => ({show() {}, appendLine() {}, dispose() {}}),
      createTreeView: () => ({dispose() {}}),
      showErrorMessage: () => undefined,
      createWebviewPanel: () => ({
        webview: {asWebviewUri: value => value, onDidReceiveMessage: () => ({}), postMessage: async () => undefined},
        onDidDispose: () => ({}), reveal() {}, dispose() {},
      }),
    },
    languages: {
      createDiagnosticCollection: () => ({clear() {}, dispose() {}}),
      registerCodeLensProvider: () => ({}), registerCodeActionsProvider: () => ({}),
    },
    tests: {createTestController: () => ({
      items: {replace() {}}, createRunProfile() {}, dispose() {},
    })},
    commands: {registerCommand: (name, callback) => {commands.set(name, callback); return {}; }},
    Uri: {joinPath: (root, name) => `${root}/${name}`},
    ViewColumn: {One: 1}, CodeActionKind: {QuickFix: {}}, TestRunProfileKind: {Run: 1},
    ConfigurationTarget: {WorkspaceFolder: 6},
    EventEmitter: class {event = () => undefined; fire() {} dispose() {}},
  };
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (id, parent, isMain) {
    if (id === 'vscode') return vscode;
    if (id === './advisorSetup') return {registerAdvisorSetup() {}};
    if (id === 'node:child_process') return {spawn: () => {throw new Error('Julia must not run in this test');}};
    return originalLoad.call(this, id, parent, isMain);
  };
  let investigation, advisor, roots;
  try {
    investigation = require('../dist/investigation.js');
    advisor = require('../dist/advisorSetup.js');
    roots = require('../dist/workspace-root.js');
  } finally {Module._load = originalLoad;}
  const context = {subscriptions: [], extensionUri: 'extension', workspaceState: {get: () => []}};
  investigation.registerInvestigations(context);
  advisor.registerAdvisorSetup(context);
  await assert.rejects(commands.get('perfchecker.openInvestigations')(), /explicitly/);
  await assert.rejects(commands.get('perfchecker.configureAdvisor')(), /explicitly/);
  assert.equal(scopes.length, 0);
  roots.selectWorkspaceFolder([first, second], second.uri);
  await commands.get('perfchecker.openInvestigations')();
  await commands.get('perfchecker.advisorSetupAction')({action: 'save', config: null});
  assert.ok(scopes.length > 0);
  assert.ok(scopes.every(scope => scope === second.uri.toString()));
  assert.deepEqual(updates.map(item => item.key), ['advisorEnabled', 'advisorInvestigates']);
  assert.ok(updates.every(item => item.target === vscode.ConfigurationTarget.WorkspaceFolder));
});
