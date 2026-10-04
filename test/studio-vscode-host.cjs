// Run through VS Code --extensionTestsPath in a disposable fixture, never in a user workspace.
const vscode=require('vscode'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const timeout=(promise,label,milliseconds=60000)=>{
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out: ${label}`)),milliseconds);})]).finally(()=>clearTimeout(timer));
};
exports.run=async()=>{
  const folder=vscode.workspace.workspaceFolders[0],root=folder.uri.fsPath,checks=[];
  assert.ok(root.startsWith('/tmp/perfchecker-studio-host-'));assert.equal(await fs.readFile(path.join(root,'.perfchecker-test-fixture'),'utf8'),'sacrificial\n');
  const snapshot=async directory=>{
    const entries=await fs.readdir(directory,{withFileTypes:true});let files=[];
    for(const entry of entries){const file=path.join(directory,entry.name);files=files.concat(entry.isDirectory()?await snapshot(file):[path.relative(root,file)]);}
    return files.sort();
  };
  let terminal,session,tracker;
  try{
    const extension=vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');assert.ok(extension);await extension.activate();
    const before=await snapshot(root);
    await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',folder.uri);
    assert.deepEqual(await snapshot(root),before);checks.push('Studio opens a full editor tab without creating workspace files');
    const notebookUri=await vscode.commands.executeCommand('perfchecker.newNotebook',folder.uri);
    const notebook=vscode.workspace.notebookDocuments.find(item=>item.uri.toString()===notebookUri.toString());
    assert.ok(notebook);assert.equal(notebook.notebookType,'jupyter-notebook');assert.equal(notebook.isUntitled,true);
    assert.equal(notebook.cellCount,8);assert.equal(notebook.cellAt(1).document.languageId,'julia');
    const data=new vscode.NotebookData(notebook.getCells().map(cell=>new vscode.NotebookCellData(cell.kind,cell.document.getText(),cell.document.languageId)));
    data.metadata=notebook.metadata;
    const bytes=await vscode.commands.executeCommand('vscode.executeNotebookToData','jupyter-notebook',data);
    const serialized=JSON.parse(Buffer.from(bytes).toString('utf8'));
    assert.equal(serialized.nbformat,4);assert.equal(serialized.metadata.kernelspec.language,'julia');assert.equal(serialized.metadata.language_info.name,'julia');
    assert.equal(serialized.cells[1].cell_type,'code');assert.match(serialized.cells[1].source.join(''),/Pkg.activate/);
    assert.deepEqual(await snapshot(root),before);checks.push('Native notebook stays untitled and the built-in ipynb serializer preserves Julia kernel metadata');
    terminal=await vscode.commands.executeCommand('perfchecker.openTerminal',folder.uri);
    assert.equal(terminal.creationOptions.cwd.toString(),folder.uri.toString());
    assert.equal(await vscode.commands.executeCommand('perfchecker.openTerminal',folder.uri),terminal);
    const pid=await timeout(terminal.processId,'dedicated Julia terminal PID');assert.ok(pid);
    const commandline=await fs.readFile(`/proc/${pid}/cmdline`,'utf8');
    assert.match(commandline,/--startup-file=no/);assert.ok(commandline.includes(`--project=${process.env.PERFCHECKER_TEST_CONTROLLER}`));
    assert.equal(await fs.readlink(`/proc/${pid}/cwd`),root);terminal.dispose();terminal=undefined;
    checks.push('Dedicated terminal really launches Julia with the selected controller and workspace cwd, then reuses the same terminal');
    if(process.env.PERFCHECKER_TEST_JULIA_DEBUG){
      assert.ok(vscode.extensions.getExtension('julialang.language-julia'));
      const source=path.join(root,'debug-case.jl');await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source));
      await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',folder.uri);
      let onStopped;const stopped=new Promise(resolve=>{onStopped=resolve;});
      tracker=vscode.debug.registerDebugAdapterTrackerFactory('julia',{createDebugAdapterTracker:current=>{
        if(!current.configuration.name.startsWith('PerfChecker'))return;
        session=current;return{onDidSendMessage:message=>{if(message.type==='event'&&message.event==='stopped')onStopped(message.body);}};
      }});
      assert.equal(await vscode.commands.executeCommand('perfchecker.debugFile',folder.uri),true);
      const stop=await timeout(stopped,'Julia debugger pauses on the saved fixture',90000);
      const stack=await session.customRequest('stackTrace',{threadId:stop.threadId,startFrame:0,levels:10});
      assert.ok(stack.stackFrames.some(frame=>frame.source?.path===source));
      assert.equal(session.configuration.cwd,root);assert.equal(session.configuration.juliaEnv,process.env.PERFCHECKER_TEST_CONTROLLER);
      await vscode.debug.stopDebugging(session);session=undefined;
      checks.push('Actual Julia debugger launches the last source behind Studio, pauses on it and uses the selected scenario environment');
    }
    assert.deepEqual(await snapshot(root),before);checks.push('Workbench and debugger leave workspace source files unchanged');
    await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify({status:'passed',checks},null,2));
  }catch(error){await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify({status:'failed',checks,error:String(error),stack:error.stack},null,2));throw error;}
  finally{tracker?.dispose();terminal?.dispose();if(session)await vscode.debug.stopDebugging(session);}
};
