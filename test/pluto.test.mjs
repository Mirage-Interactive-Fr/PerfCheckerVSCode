import assert from 'node:assert/strict';
import test from 'node:test';
import Module, {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';

test('Pluto requires explicit installation, a trusted workspace and a native notebook',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'perfchecker-pluto-boundaries-'));
  const uri=file=>({scheme:'file',fsPath:file,toString:()=>`file://${file}`});
  const folder={name:'fixture',uri:uri(root)},messages=[],scopes=[];
  const disposable=()=>({dispose(){}});
  const vscode={workspace:{isTrusted:true,workspaceFolders:[folder],getWorkspaceFolder:source=>source.fsPath.startsWith(root+path.sep)?folder:undefined,
    getConfiguration:(_name,scope)=>{scopes.push(scope);return{get:(_key,fallback)=>fallback};},onDidChangeWorkspaceFolders:disposable},
    Uri:{file:uri,joinPath:(base,...pieces)=>uri(path.join(base.fsPath,...pieces))},
    window:{createOutputChannel:()=>({append(){},appendLine(){},dispose(){}}),
      showWarningMessage:async message=>{messages.push(message);return undefined;}},
  };
  const original=Module._load;
  Module._load=function(name,...args){return name==='vscode'?vscode:original.call(this,name,...args);};
  let PlutoNotebooks;try{({PlutoNotebooks}=createRequire(import.meta.url)('../dist/plutoNotebook.js'));}finally{Module._load=original;}
  const context={subscriptions:[],extensionUri:uri(root)},pluto=new PlutoNotebooks(context);
  try{
    const notebook=uri(path.join(root,'perf','notebooks','case.jl'));
    assert.equal(await pluto.create(notebook,{kind:'suite'}),undefined);
    assert.equal(messages.length,1,'No package manager runs before the installation choice');
    assert.match(messages[0],/own Julia environment.*perf.*pluto/);
    assert.deepEqual(await readdir(root),[],'Declining setup creates neither an environment nor a notebook');
    vscode.workspace.isTrusted=false;
    await assert.rejects(pluto.create(notebook,{kind:'suite'}),/Trust/);
    assert.equal(messages.length,1);
    vscode.workspace.isTrusted=true;
    await assert.rejects(pluto.create(uri(path.join(os.tmpdir(),'foreign.pluto.jl')),{kind:'suite'}),/inside an open workspace/);
    await assert.rejects(pluto.create(notebook,{kind:'unknown'}),/Choose a suite or investigation/);
    await mkdir(path.join(root,'perf'),{recursive:true});
    await writeFile(path.join(root,'perf','ordinary.jl'),'println("Julia source")\n');
    await assert.rejects(pluto.open(uri(path.join(root,'perf','ordinary.jl'))),/Choose a Pluto .jl notebook/);
    await writeFile(path.join(root,'perf','existing.jl'),'### A Pluto.jl notebook ###\n');
    await assert.rejects(pluto.create(uri(path.join(root,'perf','existing.jl')),{kind:'suite'}),/already exists/);
    assert.equal(messages.length,1,'Invalid files never start environment setup');
    assert(scopes.every(scope=>scope.toString()===folder.uri.toString()));
    const server=createServer((request,response)=>{
      const query=new URL(request.url,'http://localhost').searchParams;
      response.statusCode=query.get('secret')==='isolated-test-secret' ? 200 : 403;
      response.end();
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const address=server.address(),url=`http://127.0.0.1:${address.port}/edit?id=test-notebook&secret=isolated-test-secret`;
      // This is VS Code URI's documented serialization of a query component.
      const forwarded={toString:skipEncoding=>skipEncoding?url:`http://127.0.0.1:${address.port}/edit?${encodeURIComponent('id=test-notebook&secret=isolated-test-secret')}`};
      assert.equal((await fetch(forwarded.toString())).status,403,'The previous URI encoding loses authenticated query parameters');
      const panel={webview:{}};
      pluto.render({panel},forwarded);
      const source=/src="([^"]+)"/.exec(panel.webview.html)[1].replaceAll('&amp;','&');
      assert.equal((await fetch(source)).status,200,'The rendered iframe carries the original authentication parameters');
      assert.equal(new URL(source).searchParams.get('id'),'test-notebook');
    }finally{await new Promise(resolve=>server.close(resolve));}
  }finally{pluto.dispose();context.subscriptions.forEach(item=>item.dispose());await rm(root,{recursive:true,force:true});}
});
