import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('retained plot documents cannot analyze a replacement selection or open another execution',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-view-scope-'));
  const uri=fsPath=>({scheme:'file',fsPath,toString:()=>`file://${fsPath}`});
  const folder={name:'Fixture',uri:uri(root)},calls=[],documents=[],errors=[],rendered=[];
  const disposable=()=>({dispose(){}});let panel;
  const vscode={TreeItem:class{},EventEmitter:class{},ThemeIcon:class{},ViewColumn:{One:1},
    Uri:{joinPath:(base,...parts)=>uri(path.join(base.fsPath,...parts))},workspace:{workspaceFolders:[folder],
      openTextDocument:async document=>document},
    commands:{executeCommand:async(...args)=>{calls.push(args);}},
    window:{showErrorMessage:message=>{errors.push(message);},showWarningMessage:message=>{errors.push(message);},
      showTextDocument:async document=>{documents.push(document);},createWebviewPanel:()=>{
        panel={webview:{onDidReceiveMessage:callback=>{panel.receive=callback;return disposable();}},
          onDidDispose:()=>disposable(),reveal(){}};return panel;
      }}};
  try{
    const filename=fileURLToPath(new URL('../dist/extension.js',import.meta.url));
    const loaded=new Module(filename);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
    const original=Module._load;
    try{Module._load=function(id,...args){return id==='vscode'?vscode:original.call(this,id,...args);};
      loaded._compile((await readFile(filename,'utf8'))+'\nmodule.exports.TestController=Controller;',filename);
    }finally{Module._load=original;}
    const controller=Object.create(loaded.exports.TestController.prototype);
    controller.context={extensionUri:uri(root)};controller.folder=()=>folder;
    controller.resultPage=(...args)=>{rendered.push(args.at(-1));return 'A controlled document; renderer behavior has browser coverage.';};
    const reference={id:'reference',package:'Fixture',feature:'sum_benchmark',version:'commit-a',target_revision:'a'.repeat(40)};
    const dev={...reference,id:'dev',version:'dev@0.1.0',target_revision:'b'.repeat(40)};
    const source=async id=>{
      const directory=path.join(root,id);await mkdir(directory);
      await writeFile(path.join(directory,'manifest.json'),JSON.stringify({plan:{runs:[reference,dev]}}));
      return {kind:'suite-bundle',workspace:folder.uri.toString(),root,directory,runId:id,
        snapshot:{suite:JSON.stringify({run_id:id}),series:JSON.stringify({run_id:id})}};
    };
    const first=await source('first'),second=await source('second');
    await controller.showResults('Reference',[reference],undefined,undefined,undefined,[],first);
    const oldView=rendered.at(-1);
    await controller.showResults('Dev',[dev],undefined,undefined,undefined,[],first);
    const currentView=rendered.at(-1);assert.notEqual(oldView,currentView);
    await panel.receive({type:'analyze',index:0,viewToken:oldView});
    await panel.receive({type:'analyze',index:0});
    assert.deepEqual(calls,[],'Old or unbound row indexes cannot select a different current check');
    assert.equal(errors.length,2);assert(errors.every(message=>message.includes('Results were refreshed')));
    await panel.receive({type:'analyze',index:0,viewToken:currentView});
    assert.equal(calls.length,1);assert.equal(calls[0][0],'perfchecker.analyzeSelectedResults');
    assert.equal(calls[0][1].source.runId,'first');
    assert.deepEqual(calls[0][1].selections,[{package:'Fixture',feature:'sum_benchmark',version:'dev@0.1.0'}]);
    await controller.showResults('Another execution',[reference],undefined,undefined,undefined,[],second);
    await panel.receive({type:'report',name:'suite-result.json',viewToken:currentView});
    assert.deepEqual(documents,[],'A retained report button cannot open a replacement execution');
    await panel.receive({type:'report',name:'suite-result.json',viewToken:rendered.at(-1)});
    assert.equal(documents.length,1);assert.deepEqual(JSON.parse(documents[0].content),{run_id:'second'});
  }finally{await rm(root,{recursive:true,force:true});}
});
