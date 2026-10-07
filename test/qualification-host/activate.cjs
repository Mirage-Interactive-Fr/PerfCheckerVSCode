// This disposable CI extension is activated normally. An extensionTestsPath
// host refuses real VS Code dialogs, so it cannot qualify installation prompts.
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.activate = async () => {
  if (process.env.CI !== 'true') throw new Error('The qualification host is restricted to disposable CI.');
  const phase=process.env.PERFCHECKER_NATIVE_PHASE;
  const output=process.env.PERFCHECKER_NATIVE_OUTPUT;
  console.log(`NATIVE_HOST_ACTIVATED ${phase} VSCode ${vscode.version}`);
  await fs.writeFile(path.join(output,`${phase}-bootstrap.json`),JSON.stringify({phase,status:'activated',vscode:vscode.version}));
  let error;
  try {await require('../public-vsix-host.cjs').run();}
  catch (failure) {error=String(failure);console.error(`NATIVE_HOST_FAILED ${phase}: ${error}`);}
  finally {
    await fs.writeFile(path.join(output,`${phase}-finished.json`),JSON.stringify({phase,status:error?'failed':'passed',error}));
    await vscode.commands.executeCommand('workbench.action.quit');
  }
};
