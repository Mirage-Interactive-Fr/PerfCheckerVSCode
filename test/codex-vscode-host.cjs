// Opt-in real VS Code + Julia + named Codex CLI qualification in a sacrificial Git workspace.
const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs/promises');
const path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile);
exports.run=async()=>{
  const folder=vscode.workspace.workspaceFolders[0],root=folder.uri.fsPath,checks=[];
  assert.ok(path.basename(path.dirname(root)).startsWith('perfchecker-codex-host-'));
  assert.equal(await fs.readFile(path.join(root,'.perfchecker-test-fixture'),'utf8'),'sacrificial\n');
  const settings=vscode.workspace.getConfiguration('perfchecker',folder.uri);
  const configFile=path.join(root,'perf','advisor.json'),saved=await fs.readFile(configFile);
  const source=await fs.readFile(path.join(root,'source.cjs'),'utf8'),index=await fs.readFile(path.join(root,'.git','index'));
  const git=async(...args)=>(await execute('git',args,{cwd:root})).stdout;
  const head=await git('rev-parse','HEAD');
  const verify=()=>execute(process.env.PERFCHECKER_TEST_NODE,['-e',"const assert=require('node:assert/strict'),{sumSquares}=require('./source.cjs');assert.equal(sumSquares([]),0);assert.equal(sumSquares([1,2,3]),14);assert.equal(sumSquares([-2,3]),13);"],{cwd:root});
  try{
    const extension=vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');assert.ok(extension);await extension.activate();
    const connected=await vscode.commands.executeCommand('perfchecker.connectCodex');assert.ok(connected.connected);
    await vscode.commands.executeCommand('perfchecker.openChat');
    let state=await vscode.commands.executeCommand('perfchecker.chatState');assert.ok(state.connection);assert.equal(state.implementation.tool,'implement_perfchecker');
    assert.equal(settings.get('advisorEnabled'),false);assert.equal(settings.get('advisorImplementationMcpTool'),'previous_agent');
    await assert.rejects(vscode.commands.executeCommand('perfchecker.advisorSetupAction',{action:'save',config:{}}),/must not be saved/);
    await vscode.commands.executeCommand('perfchecker.chatSend',{question:`Give concise advice to eliminate the intermediate array in source.cjs while preserving numeric results and empty arrays. Advice only: no tools, commands or file edits. Here is the source: ${source}. When I later request implementation, change source.cjs only, run only ${process.env.PERFCHECKER_TEST_NODE} for tests, and do not run Julia, install anything or create other files.`});
    assert.equal(await fs.readFile(path.join(root,'source.cjs'),'utf8'),source);assert.deepEqual(await fs.readFile(configFile),saved);
    checks.push('actual VS Code commands connect authenticated CLI despite disabled saved provider; actual Julia MCP advice preserves source/config');
    await vscode.commands.executeCommand('perfchecker.prepareImplementation');state=await vscode.commands.executeCommand('perfchecker.chatState');
    assert.deepEqual(state.proposal.files,['source.cjs']);assert.equal(state.proposal.applied,false);
    assert.equal(await fs.readFile(path.join(root,'source.cjs'),'utf8'),source);assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);
    checks.push('actual Codex isolated implementation returns a diff without changing workspace or staging');
    await vscode.commands.executeCommand('perfchecker.applyImplementation');await verify();assert.notEqual(await fs.readFile(path.join(root,'source.cjs'),'utf8'),source);
    await vscode.commands.executeCommand('perfchecker.restoreImplementation');await verify();
    assert.equal(await fs.readFile(path.join(root,'source.cjs'),'utf8'),source);assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);assert.equal(await git('rev-parse','HEAD'),head);
    checks.push('reviewed apply passes Node semantic assertions; restore preserves exact source/index/HEAD');
    await vscode.commands.executeCommand('perfchecker.disconnectCodex');state=await vscode.commands.executeCommand('perfchecker.chatState');
    assert.equal(state.connection,undefined);assert.equal(state.implementation.tool,'previous_agent');assert.deepEqual(await fs.readFile(configFile),saved);assert.equal(settings.get('advisorEnabled'),false);
    assert.equal((await vscode.commands.executeCommand('perfchecker.codexConnectionState')).connected,false);
    checks.push('disconnect restores saved file/tool/disabled state; no ephemeral endpoint is persisted');
    await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify({status:'passed',agent:connected.label,checks},null,2));
  }catch(error){await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify({status:'failed',checks,error:String(error),stack:error.stack},null,2));throw error;}
  finally{await vscode.commands.executeCommand('perfchecker.disconnectCodex').catch(()=>{});}
};
