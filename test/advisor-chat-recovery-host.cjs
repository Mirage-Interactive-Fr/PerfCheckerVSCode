// Run after advisor-chat-host.cjs with the same isolated profile and sacrificial workspace.
// This second VS Code process proves the Git-only recovery survives extension reload.
const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
exports.run=async()=>{
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath,checks=[];
  assert.ok(root.startsWith('/tmp/perfchecker-chat-host-'));
  try {
    await vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode').activate();
    await vscode.commands.executeCommand('perfchecker.openChat');
    let state=await vscode.commands.executeCommand('perfchecker.chatState');
    assert.deepEqual(state.messages,[]);assert.ok(state.proposal.patch);assert.equal(state.proposal.applied,false);assert.match(state.backupRef,/^refs\/perfchecker\/checkpoints\//);
    checks.push('fresh extension host restores Git proposal metadata, without restoring conversation or contacting MCP');
    const source=await fs.readFile(path.join(root,'source.jl')),index=await fs.readFile(path.join(root,'.git','index'));
    await vscode.commands.executeCommand('perfchecker.applyImplementation');
    assert.equal((await vscode.commands.executeCommand('perfchecker.chatState')).proposal.applied,true);
    await vscode.commands.executeCommand('perfchecker.restoreImplementation');
    assert.deepEqual(await fs.readFile(path.join(root,'source.jl')),source);assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);
    checks.push('recovered diff supports reviewed apply and byte-identical restore with preserved staging');
    await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify({status:'passed',checks},null,2));
  }catch(error){await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify({status:'failed',checks,error:String(error),stack:error.stack},null,2));throw error;}
};
