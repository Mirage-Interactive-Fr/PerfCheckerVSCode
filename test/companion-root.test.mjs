import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

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
      onDidChangeWorkspaceFolders: () => ({dispose() {}}),
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
  const nativeChildProcess = require('node:child_process');
  const originalLoad = Module._load;
  Module._load = function (id, parent, isMain) {
    if (id === 'vscode') return vscode;
    if (id === './advisorSetup') return {registerAdvisorSetup() {}};
    if (id === 'node:child_process') return {...nativeChildProcess, spawn: () => {throw new Error('Julia must not run in this test');}};
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

  const directory=await mkdtemp(path.join(os.tmpdir(),'perfchecker-adoption-trust-'));
  const temporary={name:'temporary',uri:{scheme:'file',fsPath:directory,toString:()=>`file://${directory}`}};
  const controller=new investigation.InvestigationController(context);
  try{
    vscode.workspace.workspaceFolders=[temporary];roots.selectWorkspaceFolder([temporary],temporary.uri);
    await mkdir(path.join(directory,'perf'));await writeFile(path.join(directory,'perf','case.jl'),'make_case(p)=nothing\n');
    const catalog=path.join(directory,'perf','scenarios.toml'),before=Buffer.from('schema_version="perfchecker-scenario-catalog/1"\nroot=".."\n');
    await writeFile(catalog,before);
    controller.discovery={declared:[],fingerprints:{'perf/scenarios.toml':createHash('sha256').update(before).digest('hex')}};
    vscode.workspace.isTrusted=false;
    let failure;
    try{await controller.adopt({id:'untrusted',implementation:'case',factory:'make_case',source:'perf/case.jl'});}catch(error){failure=error;}
    assert.deepEqual(await readFile(catalog),before,'A webview retained after trust revocation cannot append a scenario');
    assert.match(failure?.message??'',/Trust the workspace/);
  }finally{controller.dispose();await rm(directory,{recursive:true,force:true});}
});
