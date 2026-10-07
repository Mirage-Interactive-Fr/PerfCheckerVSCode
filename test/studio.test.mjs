import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import Module from 'node:module';
import {mkdtemp, mkdir, readdir, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require=createRequire(import.meta.url);
const uri=fsPath=>({scheme:'file',fsPath,toString:()=>`file://${fsPath}`});
const disposable=()=>({dispose(){}});

test('Studio is side effect free and scopes notebooks, terminals and Julia debugging to an explicit workspace',async()=>{
  const temporary=await mkdtemp(path.join(tmpdir(),'perfchecker-studio-'));
  const first={name:'first',uri:uri(path.join(temporary,'first'))};
  const second={name:'second',uri:uri(path.join(temporary,process.platform === 'win32' ? "second $workspace 'quotes'" : 'second $workspace "quotes"'))};
  const commands=new Map(),panels=[],terminals=[],notebooks=[],debugged=[],invocations=[],scopes=[];
  let closeTerminal,changeEditor,chosen,hasJulia=false;
  const vscode={
    Uri:{joinPath:(root,...pieces)=>uri(path.join(root.fsPath,...pieces))},ThemeIcon:class{constructor(id){this.id=id;}},
    ViewColumn:{One:1},NotebookCellKind:{Markup:1,Code:2},
    NotebookCellData:class{constructor(kind,value,languageId){Object.assign(this,{kind,value,languageId});}},
    NotebookData:class{constructor(cells){this.cells=cells;}},
    workspace:{isTrusted:true,workspaceFolders:[first,second],getWorkspaceFolder:source=>source.fsPath.startsWith(second.uri.fsPath)?second:first,
      getConfiguration:(_name,resource)=>{scopes.push(resource.toString());return{get:(_key,fallback)=>fallback,inspect:()=>undefined};},
      openNotebookDocument:async(type,data)=>{notebooks.push({type,data});return{uri:{scheme:'untitled'},getCells:()=>data.cells};},
      openTextDocument:async source=>({uri:source,languageId:'julia',isDirty:false}),
    },
    window:{activeTextEditor:undefined,showErrorMessage:()=>undefined,
      onDidCloseTerminal:callback=>{closeTerminal=callback;return disposable();},
      onDidChangeActiveTextEditor:callback=>{changeEditor=callback;return disposable();},
      showQuickPick:async items=>items[1],showOpenDialog:async()=>chosen,
      showNotebookDocument:async()=>undefined,showTextDocument:async()=>undefined,
      createWebviewPanel:(type,title,column,options)=>{
        const messages=[];let receive,close;
        const panel={type,title,column,options,messages,webview:{cspSource:'vscode-webview://test',asWebviewUri:value=>value.toString(),
          onDidReceiveMessage:callback=>{receive=callback;return disposable();},postMessage:async message=>messages.push(message)},
          onDidDispose:callback=>{close=callback;return disposable();},reveal(){this.revealed=true;},dispose(){this.disposed=true;close?.();},
          send:message=>receive(message)};panels.push(panel);return panel;
      },
      createTerminal:options=>{const terminal={options,show(){this.visible=true;},dispose(){this.disposed=true;}};terminals.push(terminal);return terminal;},
    },
    commands:{registerCommand:(name,callback)=>{commands.set(name,callback);return disposable();},executeCommand:async(...args)=>invocations.push(args)},
    extensions:{getExtension:()=>hasJulia?{activate:async()=>undefined}:undefined},
    debug:{startDebugging:async(folder,configuration)=>{debugged.push({folder,configuration});return true;}},
  };
  try{
    await mkdir(path.join(second.uri.fsPath,'perf','controller'),{recursive:true});
    await writeFile(path.join(second.uri.fsPath,'perf','controller','Project.toml'),'name="Controller"\n');
    const original=Module._load;
    Module._load=function(name,...args){return name==='vscode'?vscode:original.call(this,name,...args);};
    const plutoCalls=[];const PlutoNotebooks=class{create(folder,options){plutoCalls.push({action:'create',folder,options});return Promise.resolve(undefined);}open(folder){plutoCalls.push({action:'open',folder});}stopWorkspace(folder){plutoCalls.push({action:'stop',folder});}dispose(){}};
    Module._load=function(name,...args){if(name==='./plutoNotebook')return{PlutoNotebooks};return name==='vscode'?vscode:original.call(this,name,...args);};
    let register;try{({registerStudio:register}=require('../dist/studio.js'));}finally{Module._load=original;}
    const context={subscriptions:[],extensionUri:uri(path.resolve('media','..'))};register(context);
    assert.equal(panels.length,0);assert.equal(terminals.length,0);assert.equal(notebooks.length,0);assert.equal(scopes.length,0);
    await assert.rejects(commands.get('perfchecker.openStudioForWorkspace')(),/Pass an open workspace/);
    await assert.rejects(commands.get('perfchecker.openTerminal')(),/explicitly/);
    await assert.rejects(commands.get('perfchecker.openStudio')(uri('/foreign')),/not an open/);
    await commands.get('perfchecker.openStudio')();
    assert.equal(panels.length,1);assert.equal(panels[0].column,1);assert.equal(panels[0].options.retainContextWhenHidden,true);
    assert.match(panels[0].webview.html,/img-src vscode-webview:\/\/test/);
    await panels[0].send({type:'studioReady'});
    assert.equal(panels[0].messages.at(-1).workspace,'second');
    assert.equal(panels[0].messages.at(-1).project,path.join(second.uri.fsPath,'perf','controller'));
    await panels[0].send({type:'studioAction',action:'notebook'});
    assert.equal(invocations.at(-1)[0],'perfchecker.newNotebook');assert.equal(invocations.at(-1)[1],second.uri);
    await panels[0].send({type:'studioAction',action:'__proto__'});assert.equal(invocations.length,1);
    await panels[0].send({type:'studioAction',action:'testing'});
    assert.equal(invocations.at(-1)[0],'workbench.view.extension.test','Testing opens its supported view container command');
    await panels[0].send({type:'studioAction',action:'julia'});assert.match(panels[0].messages.at(-1).message,/Julia VS Code extension/);
    await commands.get('perfchecker.newNotebook')(second.uri);
    assert.deepEqual(plutoCalls,[{action:'create',folder:second.uri,options:undefined}]);
    assert.equal(notebooks.length,0,'The primary notebook route delegates to Pluto, without a Jupyter document');
    assert.deepEqual(await readdir(second.uri.fsPath),['perf']);
    const terminal=await commands.get('perfchecker.openTerminal')(second.uri);
    assert.equal(terminal.options.cwd,second.uri);
    assert.deepEqual(terminal.options.shellArgs,['--startup-file=no',`--project=${path.join(second.uri.fsPath,'perf','controller')}`,'-i']);
    await commands.get('perfchecker.openTerminal')(second.uri);assert.equal(terminals.length,1);
    closeTerminal(terminal);await commands.get('perfchecker.openTerminal')(second.uri);assert.equal(terminals.length,2);
    vscode.workspace.isTrusted=false;await assert.rejects(commands.get('perfchecker.openTerminal')(second.uri),/Trust/);
    await assert.rejects(commands.get('perfchecker.debugFile')(second.uri),/Trust/);vscode.workspace.isTrusted=true;
    await assert.rejects(commands.get('perfchecker.debugFile')(second.uri),/Julia VS Code extension/);
    hasJulia=true;chosen=[uri(path.join(second.uri.fsPath,'case.jl'))];
    assert.equal(await commands.get('perfchecker.debugFile')(second.uri),true);
    assert.equal(debugged[0].configuration.project,path.join(second.uri.fsPath,'perf','controller'),
      'The official Julia debugger reads project; juliaEnv is ignored and would select the active workspace instead');
    assert.equal(debugged[0].configuration.program,chosen[0].fsPath);
    assert.equal(debugged[0].configuration.stopOnEntry,true);
    changeEditor({document:{uri:chosen[0],languageId:'julia'}});chosen=undefined;
    await commands.get('perfchecker.debugFile')(second.uri);assert.equal(debugged.length,2);
    vscode.window.activeTextEditor={document:{uri:uri('/outside.jl'),languageId:'julia',isDirty:false}};
    await assert.rejects(commands.get('perfchecker.debugFile')(second.uri),/inside the selected/);
    vscode.window.activeTextEditor={document:{uri:uri(path.join(second.uri.fsPath,'dirty.jl')),languageId:'julia',isDirty:true}};
    await assert.rejects(commands.get('perfchecker.debugFile')(second.uri),/Save the Julia/);
    await commands.get('perfchecker.openStudioForWorkspace')(first.uri);assert.equal(panels[0].disposed,true);
    assert.equal(panels.length,2);await panels[1].send({type:'studioReady'});assert.match(panels[1].messages.at(-1).problem,/Project.toml not found/);
    assert.equal(terminals.length,2);assert.equal(notebooks.length,0);
    assert.ok(scopes.every(scope=>[first.uri.toString(),second.uri.toString()].includes(scope)));
    context.subscriptions.forEach(item=>item.dispose());
  }finally{await rm(temporary,{recursive:true,force:true});}
});

test('public workbench commands and every folder-sensitive setting are discoverable',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  for(const name of ['openStudio','openStudioForWorkspace','openTerminal','newNotebook','openNotebook','debugFile','openChat']){
    assert.ok(manifest.contributes.commands.some(item=>item.command===`perfchecker.${name}`));
  }
  assert.ok(manifest.activationEvents.includes('onCommand:perfchecker.openStudioForWorkspace'));
  for(const [name,configuration]of Object.entries(manifest.contributes.configuration.properties))assert.equal(configuration.scope,'resource',name);
});
