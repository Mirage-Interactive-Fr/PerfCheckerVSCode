// Opt-in qualification with a real agent answering MCP requests through a temporary bridge.
// The responding agent reads request-N.json, edits only its supplied checkout for implementation,
// then writes response-N.json containing {text:"its actual reply"}. No canned implementation.
const vscode=require('vscode'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile);
exports.run=async()=>{
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath,bridge=process.env.PERFCHECKER_AGENT_BRIDGE_DIR,checks=[];
  assert.ok(root.startsWith('/tmp/perfchecker-agent-host-'));assert.ok(bridge?.startsWith('/tmp/perfchecker-agent-bridge-'));
  assert.equal(await fs.readFile(path.join(root,'.perfchecker-test-fixture'),'utf8'),'sacrificial\n');
  let count=0;
  const server=http.createServer(async(req,res)=>{
    try {
      let bytes='';for await(const data of req)bytes+=data;const body=bytes?JSON.parse(bytes):{};
      res.setHeader('Content-Type','application/json');let result={};
      if(body.method==='notifications/initialized'){res.statusCode=202;return res.end();}
      if(body.method==='initialize')result={protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'PerfChecker real agent bridge',version:'1'}};
      if(body.method==='tools/list')result={tools:[{name:'ask_perfchecker',inputSchema:{type:'object',properties:{prompt:{type:'string'}}}},{name:'implement_perfchecker',inputSchema:{type:'object',properties:{prompt:{type:'string'},workspace:{type:'string'}}}}]};
      if(body.method==='tools/call'){
        const id=++count;
        await fs.writeFile(path.join(bridge,`request-${id}.json`),JSON.stringify({id,tool:body.params.name,arguments:body.params.arguments},null,2),{flag:'wx',mode:0o600});
        let response;const deadline=Date.now()+590000;
        while(Date.now()<deadline){
          try{response=JSON.parse(await fs.readFile(path.join(bridge,`response-${id}.json`),'utf8'));break;}
          catch(error){if(error.code!=='ENOENT')throw error;await new Promise(resolve=>setTimeout(resolve,250));}
        }
        assert.ok(response?.text?.trim(),'Real agent response missing or empty');
        result={content:[{type:'text',text:response.text}]};
      }
      res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const extension=vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');assert.ok(extension);await extension.activate();
    const folder=vscode.workspace.workspaceFolders[0],settings=vscode.workspace.getConfiguration('perfchecker',folder.uri);
    const config={protocol:'mcp_http',endpoint:`http://127.0.0.1:${server.address().port}/mcp`,model:'real Codex agent bridge',timeout:600,mcp_tool:'ask_perfchecker',mcp_prompt_argument:'prompt',mcp_response:'text',instructions:'Preserve the score(xs) API and exact result. For implementation, edit only the supplied isolated checkout, run a meaningful Julia correctness and allocation check, and report its result.'};
    await vscode.commands.executeCommand('perfchecker.advisorSetupAction',{action:'save',config});
    await settings.update('advisorImplementationMcpTool','implement_perfchecker',vscode.ConfigurationTarget.WorkspaceFolder);
    const source=await fs.readFile(path.join(root,'source.jl'),'utf8');
    const probe=async()=>{
      const code='include("source.jl"); xs=collect(1.0:1000.0); score(xs); result=score(xs); bytes=@allocated score(xs); println(result); println(bytes);';
      const output=(await execute(settings.get('juliaExecutable','julia'),['--startup-file=no','-e',code],{cwd:root})).stdout.trim().split('\n');
      return {value:Number(output.at(-2)),allocated:Number(output.at(-1))};
    };
    const baseline=await probe();assert.ok(baseline.allocated>0);
    await vscode.commands.executeCommand('perfchecker.openChat');
    await fs.writeFile(path.join(bridge,'ready.json'),JSON.stringify({root,baseline}),{flag:'wx',mode:0o600});
    await vscode.commands.executeCommand('perfchecker.chatSend',{question:`Please advise how to remove the intermediate array allocation from this Julia code while preserving score(xs):\n${source}\nWarm baseline for Float64 vector 1:1000: value=${baseline.value}, allocated=${baseline.allocated} bytes. Do not edit anything in advice mode.`});
    assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),source);checks.push('actual agent advice through MCP, with no code edit');
    const advice=(await vscode.commands.executeCommand('perfchecker.chatState')).messages.at(-1).content;assert.ok(advice.trim());
    await vscode.commands.executeCommand('perfchecker.prepareImplementation');
    const state=await vscode.commands.executeCommand('perfchecker.chatState');assert.ok(state.proposal.files.includes('source.jl'));assert.equal(state.proposal.applied,false);
    assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),source);checks.push('actual agent edits supplied isolated checkout and returns reviewed proposal');
    await vscode.commands.executeCommand('perfchecker.applyImplementation');
    const candidate=await probe();assert.equal(candidate.value,baseline.value);assert.ok(candidate.allocated<baseline.allocated);
    checks.push('reviewed apply preserves Julia result and reduces measured warm allocation');
    await vscode.commands.executeCommand('perfchecker.restoreImplementation');assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),source);
    assert.deepEqual(await probe(),baseline);checks.push('restore returns code and measured allocation to checkpoint');
    await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify({status:'passed',checks,baseline,candidate,advice,implementationSummary:state.implementationSummary},null,2));
  }catch(error){await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify({status:'failed',checks,error:String(error),stack:error.stack},null,2));throw error;}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
};
