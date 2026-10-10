import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const uri = fsPath => ({scheme:'file', fsPath, toString:() => `file://${fsPath}`});
const folder = fsPath => ({uri:uri(fsPath), name:path.basename(fsPath)});

test('explicit live command keeps multi-root quality and bundle separate from the CPU suite', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'perfchecker-live-command-'));
  const first = folder(path.join(temporary,'other'));
  const second = folder(path.join(temporary,'landscape'));
  const bundle = path.join(second.uri.fsPath,'perf','results','live','run-00000000-0000-4000-8000-000000000001');
  const commands = new Map(), opened = [], invoked = [], scopes = [];
  let changed = false, preparedQuality, preparationCount=0;
  try {
    await mkdir(path.join(second.uri.fsPath,'perf','controller'),{recursive:true});
    await mkdir(bundle,{recursive:true});
    await writeFile(path.join(second.uri.fsPath,'perf','controller','Project.toml'),'name = "Controller"\n');
    await writeFile(path.join(bundle,'manifest.json'),JSON.stringify({
      schema_version:'perfchecker-run-bundle/1',state:'complete',
      environment:{quality_profile:'desktop-natif'}}));
    const workspace = {onDidChangeWorkspaceFolders:()=>({dispose(){}}),onDidChangeConfiguration:()=>({dispose(){}}),isTrusted:true,workspaceFolders:[first,second],
      openTextDocument:async value=>value,
      getConfiguration: (_name,resource) => {scopes.push(resource.toString());return {
        get:(key,fallback) => ({runnerProject:'perf',juliaExecutable:'julia'})[key]??fallback,
        inspect:()=>undefined};}};
    const vscode = {
      EventEmitter: class {event=()=>undefined;fire(){}},workspace,
      Uri:{file:fsPath=>uri(fsPath)},
      window: {
        onDidCloseTerminal: () => ({dispose() {}}),
        onDidChangeActiveTextEditor: () => ({dispose() {}}),
        createOutputChannel:()=>({append(){},appendLine(){}}),
        createTreeView:()=>({onDidChangeCheckboxState:()=>({})}),
        withProgress:(_options,callback)=>callback({}, {
          isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})}),
        showTextDocument:async value=>{opened.push(value.fsPath);},
        showInformationMessage:()=>undefined,
      },
      tests:{createTestController:()=>({items:{replace(){}},createRunProfile(){}})},
      commands:{registerCommand:(name,callback)=>{commands.set(name,callback);return {};}},
      TestRunProfileKind:{Run:1},ProgressLocation:{Notification:2},
    };
    const Module = require('node:module'), originalLoad = Module._load;
    Module._load = function (id,parent,isMain) {
      if (id==='vscode') return vscode;
      if (id==='./investigation') return {registerInvestigations(){}};
      if (id==='./testitems') return {registerNativeTestItems(){}};
      if (id==='./live-provider') return {
        prepareLiveProvider:async (_root,quality)=>{
          preparedQuality=quality;
          if (quality!=='desktop-natif') throw new Error('quality missing');
          return {root:second.uri.fsPath,provider:path.join(second.uri.fsPath,'perf','live_provider.jl'),
            quality,qualityDigest:changed && ++preparationCount>1?'new':'old'};},
        executeLiveProvider:async input=>{invoked.push(input);return bundle;},
      };
      return originalLoad.call(this,id,parent,isMain);
    };
    try {
      const extension = require('../dist/extension.js');
      extension.activate({subscriptions:[],globalStorageUri:{fsPath:path.join(temporary,'storage')}});
    } finally {Module._load=originalLoad;}
    const run = commands.get('perfchecker.runLandscapeLiveForWorkspace');
    assert.equal(typeof run,'function');
    await assert.rejects(run(), /Pass an open workspace folder/);
    await assert.rejects(run(uri(path.join(temporary,'foreign')),'desktop-natif'), /not an open/);
    await assert.rejects(run(second.uri,'mobile-leger'), /quality missing/);
    assert.equal(invoked.length,0);
    assert.equal(await run(second.uri,'desktop-natif'),bundle);
    assert.equal(preparedQuality,'desktop-natif');
    assert.equal(invoked[0].root,second.uri.fsPath);
    assert.equal(invoked[0].reports,path.join(second.uri.fsPath,'perf','results','live'));
    assert.deepEqual(opened,[path.join(bundle,'manifest.json')]);
    assert.ok(scopes.every(scope=>scope===second.uri.toString()));
    changed=true;preparationCount=0;
    await assert.rejects(run(second.uri,'desktop-natif'), /quality changed/);
    assert.equal(invoked.length,1);
    changed=false;
    workspace.workspaceFolders=[first];
    await assert.rejects(run(second.uri,'desktop-natif'), /not an open/);
    assert.equal(invoked.length,1);
  } finally {await rm(temporary,{recursive:true,force:true});}
});
