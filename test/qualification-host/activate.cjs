// This disposable CI extension is activated normally. An extensionTestsPath
// host refuses real VS Code dialogs, so it cannot qualify installation prompts.
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.activate = async () => {
  if (process.env.CI !== 'true') throw new Error('The qualification host is restricted to disposable CI.');
  const phase=process.env.PERFCHECKER_NATIVE_PHASE;
  const output=process.env.PERFCHECKER_NATIVE_OUTPUT;
  const invocation=process.env.PERFCHECKER_NATIVE_INVOCATION;
  const journal=path.join(output,`${phase}-activations.jsonl`);
  const previous=(await fs.readFile(journal,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  await fs.appendFile(journal,JSON.stringify({invocation,pid:process.pid,observedAt:new Date().toISOString(),vscode:vscode.version})+'\n');
  console.log(`NATIVE_HOST_ACTIVATED ${phase} VSCode ${vscode.version}`);
  await fs.writeFile(path.join(output,`${phase}-bootstrap.json`),JSON.stringify({phase,invocation,pid:process.pid,status:'activated',vscode:vscode.version}));
  let error;
  try {
    if(previous.some(item=>item.invocation===invocation)){
      if(phase==='reload')await require('../native-reload-host.cjs').validateHandoff(previous);
      else if(phase==='mcp-stdio')await require('../native-mcp-controls.cjs').validateStdioReloadHandoff(previous);
      else throw new Error('The disposable extension host restarted during this campaign. Earlier evidence was preserved; the harness will not rerun actions against partially mutated fixtures. Inspect retained host logs.');
    }
    await require('../public-vsix-host.cjs').run();
  }
  catch (failure) {error=String(failure);console.error(`NATIVE_HOST_FAILED ${phase}: ${error}`);}
  finally {
    await fs.writeFile(path.join(output,`${phase}-finished.json`),JSON.stringify({phase,status:error?'failed':'passed',error}));
    await vscode.commands.executeCommand('workbench.action.quit');
  }
};
