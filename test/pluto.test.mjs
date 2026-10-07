import assert from 'node:assert/strict';
import test from 'node:test';
import Module, {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';

test('Pluto requires explicit installation, a trusted workspace and a native notebook',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'perfchecker-pluto-boundaries-'));
  const uri=file=>({scheme:'file',fsPath:file,toString:()=>`file://${file}`});
  const folder={name:'fixture',uri:uri(root)},messages=[],scopes=[],values=new Map();
  const disposable=()=>({dispose(){}});
  const vscode={workspace:{isTrusted:true,workspaceFolders:[folder],getWorkspaceFolder:source=>source.fsPath.startsWith(root+path.sep)?folder:undefined,
    getConfiguration:(_name,scope)=>{scopes.push(scope);return{get:(key,fallback)=>values.has(key)?values.get(key):fallback};},onDidChangeWorkspaceFolders:disposable},
    Uri:{file:uri,joinPath:(base,...pieces)=>uri(path.join(base.fsPath,...pieces))},ViewColumn:{One:1},
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

    const project=path.join(root,'perf','pluto'),suite=path.join(root,'perf','suite.jl');
    await writeFile(suite,'using PerfChecker\n');
    const originalEnsure=pluto.ensureEnvironment,originalCommand=pluto.command,originalOpen=pluto.openFile;
    // Isolate the asynchronous file/settings boundary; the native campaign tests
    // the real generator/server separately rather than claiming that here.
    pluto.ensureEnvironment=async()=>project;
    pluto.command=async()=>`PERFCHECKER_PLUTO_NOTEBOOK ${Buffer.from('### A Pluto.jl notebook ###\n').toString('base64')}\n`;
    pluto.openFile=async(_folder,file)=>uri(file);
    const nativeFs=createRequire(import.meta.url)('node:fs').promises,originalStat=nativeFs.stat;
    let changed=false;
    nativeFs.stat=async(file,...args)=>{
      const result=await originalStat(file,...args);
      if(file===suite&&!changed){changed=true;values.set('profile','changed-during-generation');}
      return result;
    };
    const stale=path.join(root,'perf','notebooks','stale.jl');
    try{
      await assert.rejects(pluto.create(uri(stale),{kind:'suite'}),/settings changed|configuration changed/i);
      assert.equal(await originalStat(stale).then(()=>true).catch(()=>false),false,'Stale generation cannot leave a notebook on disk');
    }finally{nativeFs.stat=originalStat;pluto.ensureEnvironment=originalEnsure;pluto.command=originalCommand;pluto.openFile=originalOpen;}

    // Stop owns the old session even after a user selects another environment.
    // Exercise the real dedicated pipe and process exit, not a mocked stop().
    const {controllerCancellation}=createRequire(import.meta.url)('../dist/controllerCancellation.js');
    const marker=path.join(root,'stopped-session.json');
    let messageHandler,owned;const originalStart=pluto.start;
    const panel={webview:{onDidReceiveMessage:handler=>{messageHandler=handler;return disposable();}},onDidDispose:disposable,reveal(){},dispose(){}};
    vscode.window.createWebviewPanel=()=>panel;
    pluto.start=async session=>{
      owned=session;
      const child=spawn(process.execPath,['-e',`process.stdout.write('ready\\n');process.stdin.on('data',async input=>{if(input.toString().includes('PERFCHECKER_CANCEL/1')){require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,cleaned:true}));process.exit(0);}});`,marker],{stdio:['pipe','pipe','pipe']});
      session.child=child;session.cancel=controllerCancellation(child,()=>{});
      session.stopped=once(child,'close').then(()=>{});
      await once(child.stdout,'data');
    };
    try{
      await pluto.openFile(folder,path.join(root,'perf','existing.jl'),project);
      const oldPid=owned.child.pid;
      values.set('plutoProject','perf/another-pluto');
      await messageHandler({type:'plutoStop'});
      const cleaned=await readFile(marker,'utf8').then(JSON.parse).catch(()=>undefined);
      assert.equal(cleaned?.cleaned,true,'Changing plutoProject must not disable the old session Stop button');
      assert.equal(cleaned.pid,oldPid);
      assert.equal(owned.child.exitCode,0,'The owned process finished before fixture cleanup');
      assert.match(panel.webview.html,/Session stopped/);
      await messageHandler({type:'plutoRestart'});
      assert.match(panel.webview.html,/environment changed/i,'Restart still validates the configured environment');
    }finally{
      owned?.cancel?.request();await owned?.stopped;
      values.delete('plutoProject');pluto.start=originalStart;
    }
  }finally{pluto.dispose();context.subscriptions.forEach(item=>item.dispose());await rm(root,{recursive:true,force:true});}
});
