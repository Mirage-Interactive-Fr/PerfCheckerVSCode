// Opt-in real VS Code + Julia test. Only use a sacrificial Git workspace under /tmp.
const vscode=require('vscode'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile),git=async(root,...args)=>(await execute('git',args,{cwd:root})).stdout;
exports.run=async()=>{
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath,checks=[],calls=[];
  assert.ok(root.startsWith('/tmp/perfchecker-chat-host-')); assert.equal(await fs.readFile(path.join(root,'.perfchecker-test-fixture'),'utf8'),'sacrificial\n');
  let behavior='reply';
  const server=http.createServer(async(req,res)=>{
    try {
      let bytes='';for await(const data of req)bytes+=data;const body=bytes?JSON.parse(bytes):{};calls.push(body);
      res.setHeader('Content-Type','application/json');
      if(body.method==='notifications/initialized'){res.statusCode=202;return res.end();}
      let result={};
      if(body.method==='initialize')result={protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'PerfChecker test',version:'1'}};
      if(body.method==='tools/list')result={tools:[{name:'ask',inputSchema:{type:'object',properties:{prompt:{type:'string'}}}},{name:'implement',inputSchema:{type:'object',properties:{prompt:{type:'string'},workspace:{type:'string'}}}}]};
      if(body.method==='tools/call'){
        if(behavior==='slow'){await new Promise(resolve=>setTimeout(resolve,3000));}
        if(body.params.name==='implement'){
          const checkout=body.params.arguments.workspace;assert.notEqual(checkout,root);assert.ok(checkout.startsWith('/tmp/perfchecker-implementation-'));
          await fs.writeFile(path.join(checkout,'source.jl'),'optimized\n');await fs.rm(path.join(checkout,'untracked.txt'));
          await fs.writeFile(path.join(checkout,'new file 😀.jl'),'new\n');
          result={content:[{type:'text',text:'Changed source.jl, preserved API; run the tests.'}]};
        }else result=behavior==='error'?{isError:true,content:[{type:'text',text:'mock tool failed'}]}:{content:[{type:'text',text:'Check allocations. <script>plain text</script>'}]};
      }
      res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const extension=vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');assert.ok(extension);await extension.activate();
    const folder=vscode.workspace.workspaceFolders[0],settings=vscode.workspace.getConfiguration('perfchecker',folder.uri);
    const config={protocol:'mcp_http',endpoint:`http://127.0.0.1:${server.address().port}/mcp`,model:'test',timeout:120,mcp_tool:'ask',mcp_prompt_argument:'prompt',mcp_response:'text',instructions:'Preserve the public API.'};
    await vscode.commands.executeCommand('perfchecker.advisorSetupAction',{action:'save',config});
    await settings.update('advisorImplementationMcpTool','implement',vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand('perfchecker.openChat');
    assert.equal(calls.filter(body=>body.method==='tools/call').length,0);checks.push('opening chat does not call an agent');
    await vscode.commands.executeCommand('perfchecker.chatSend',{question:'How can I reduce allocations?'});
    await vscode.commands.executeCommand('perfchecker.chatSend',{question:'Preserve the public API.'});
    let state=await vscode.commands.executeCommand('perfchecker.chatState');assert.equal(state.messages.length,4);
    const adviceCall=calls.filter(body=>body.method==='tools/call').at(-1);assert.match(adviceCall.params.arguments.prompt,/How can I reduce allocations/);assert.match(adviceCall.params.arguments.prompt,/Preserve the public API/);
    assert.equal(adviceCall.params.arguments.workspace,undefined);assert.ok(!adviceCall.params.arguments.prompt.includes('PRIVATE_NOT_ATTACHED'));checks.push('bounded conversation and instructions sent, no automatic source or secret attachment');
    behavior='error';await assert.rejects(vscode.commands.executeCommand('perfchecker.chatSend',{question:'fail'}));
    assert.equal((await vscode.commands.executeCommand('perfchecker.chatState')).messages.length,4);behavior='reply';checks.push('tool errors preserve previous advice');
    behavior='slow';const previous=calls.filter(body=>body.method==='tools/call').length;
    const pending=vscode.commands.executeCommand('perfchecker.chatSend',{question:'cancel this request'});const rejected=assert.rejects(pending,/cancel/i);
    const deadline=Date.now()+30000;while(calls.filter(body=>body.method==='tools/call').length===previous&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    await vscode.commands.executeCommand('perfchecker.chatCancel');await rejected;assert.equal((await vscode.commands.executeCommand('perfchecker.chatState')).busy,false);behavior='reply';checks.push('actual Julia request cancellation unlocks chat');
    const source=await fs.readFile(path.join(root,'source.jl'),'utf8'),head=await git(root,'rev-parse','HEAD'),index=await fs.readFile(path.join(root,'.git','index'));
    const document=await vscode.workspace.openTextDocument(path.join(root,'source.jl'));
    const edit=new vscode.WorkspaceEdit();edit.insert(document.uri,new vscode.Position(0,0),'# unsaved\n');await vscode.workspace.applyEdit(edit);
    await assert.rejects(vscode.commands.executeCommand('perfchecker.prepareImplementation'),/Save your files/);
    const revert=new vscode.WorkspaceEdit();revert.delete(document.uri,new vscode.Range(0,0,1,0));await vscode.workspace.applyEdit(revert);await document.save();
    await vscode.commands.executeCommand('perfchecker.prepareImplementation');state=await vscode.commands.executeCommand('perfchecker.chatState');
    assert.equal(state.proposal.files.length,3);assert.equal(state.proposal.applied,false);assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),source);
    assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);checks.push('MCP agent edits isolated copy only; dirty/staged/untracked checkpoint and review diff retained');
    await vscode.commands.executeCommand('perfchecker.applyImplementation');assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),'optimized\n');
    await fs.writeFile(path.join(root,'new-user.txt'),'user edit');await assert.rejects(vscode.commands.executeCommand('perfchecker.restoreImplementation'),/Code changed/);await fs.rm(path.join(root,'new-user.txt'));
    await vscode.commands.executeCommand('perfchecker.restoreImplementation');assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),source);
    assert.equal(await fs.readFile(path.join(root,'untracked.txt'),'utf8'),'original untracked\n');await assert.rejects(fs.access(path.join(root,'new file 😀.jl')));
    assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);assert.equal(await git(root,'rev-parse','HEAD'),head);checks.push('reviewed apply and drift-protected restoration preserve staging and branch');
    behavior='slow';const beforeImplementation=calls.filter(body=>body.method==='tools/call').length;
    const cancelledImplementation=vscode.commands.executeCommand('perfchecker.prepareImplementation');const implementationRejected=assert.rejects(cancelledImplementation,/cancel/i);
    const implementationDeadline=Date.now()+30000;while(calls.filter(body=>body.method==='tools/call').length===beforeImplementation&&Date.now()<implementationDeadline)await new Promise(resolve=>setTimeout(resolve,50));
    await vscode.commands.executeCommand('perfchecker.chatCancel');await implementationRejected;behavior='reply';
    assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),source);assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);
    assert.equal((await vscode.commands.executeCommand('perfchecker.chatState')).busy,false);checks.push('implementation cancellation retains checkpoint and previous reviewed proposal without applying partial edits');
    await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify({status:'passed',checks},null,2));
  }catch(error){await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify({status:'failed',checks,error:String(error),stack:error.stack},null,2));throw error;}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
};
