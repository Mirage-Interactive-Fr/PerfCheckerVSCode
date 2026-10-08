// A real untrusted workspace in the runner's private VS Code profile.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const execute=require('node:util').promisify(execFile);
async function ownedJuliaProcesses(){
  // Observe the host's actual descendants without inspecting command arguments.
  const {stdout}=await execute('ps',['-eo','pid=,ppid=,comm=']);
  const rows=stdout.split('\n').map(line=>{
    const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match?{pid:Number(match[1]),parent:Number(match[2]),name:match[3]}:undefined;
  }).filter(Boolean);
  const descendants=new Set([process.pid]);
  for(let changed=true;changed;){changed=false;for(const row of rows)
    if(descendants.has(row.parent)&&!descendants.has(row.pid)){descendants.add(row.pid);changed=true;}}
  return rows.filter(row=>descendants.has(row.pid)&&/^julia(?:$|[.-])/i.test(path.basename(row.name)));
}

exports.run=async({vscode,windowPage,workspace,log,proof,eventually})=>{
  assert.equal(process.env.CI,'true');
  assert.equal(process.platform,'linux','This representative trust qualification uses a private Linux host');
  assert.equal(process.env.PERFCHECKER_NATIVE_PHASE,'restricted');
  const output=process.env.PERFCHECKER_NATIVE_OUTPUT;
  const before=await ownedJuliaProcesses();
  log('native-restricted-process-inventory',{stage:'before-refusal',extensionHost:process.pid,julia:before});
  assert.deepEqual(before,[],'No Julia worker is owned by the untrusted product host');
  const extensions=path.join(process.env.PERFCHECKER_NATIVE_SESSION,'extensions');
  const installed=[];
  for(const entry of await fs.readdir(extensions,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    const manifest=JSON.parse(await fs.readFile(path.join(extensions,entry.name,'package.json')));
    if(manifest.publisher==='mirage-interactive-fr'&&manifest.name==='perfchecker-vscode')installed.push(manifest);
  }
  assert.equal(installed.length,1,'The private profile has exactly one installed product');
  const manifest=installed[0],id=`${manifest.publisher}.${manifest.name}`;
  assert.equal(manifest.version,process.env.PERFCHECKER_NATIVE_EXPECTED_VERSION);
  const inactive=()=>!vscode.extensions.getExtension(id)?.isActive;
  const project=await fs.readFile(path.join(workspace,'Project.toml'));
  const settings=await fs.readFile(path.join(workspace,'.vscode','settings.json'));
  const prompt=windowPage.getByRole('button',{name:"No, I don't trust the authors",exact:true});
  await prompt.waitFor({state:'visible',timeout:180000});
  await windowPage.screenshot({path:path.join(output,'native-restricted-trust-prompt.png')});
  log('native-ui-action',{surface:'Workspace Trust',action:"No, I don't trust the authors"});
  await prompt.click();
  await prompt.waitFor({state:'hidden'});
  await eventually(()=>vscode.workspace.isTrusted===false,'The real workspace remains untrusted');
  const indicator=windowPage.locator('[id="status.workspaceTrust"]');
  await indicator.waitFor({state:'visible'});
  assert.match(await indicator.innerText(),/Restricted Mode/);
  assert(inactive(),'VS Code has not activated the installed product');
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported,false);
  const commands=await vscode.commands.getCommands(true);
  const contributed=manifest.contributes.commands.map(item=>item.command);
  log('native-restricted-contributed-commands',{present:commands.filter(command=>contributed.includes(command)),
    scope:'VS Code may retain contribution placeholders while the product is inactive'});
  await vscode.commands.executeCommand('workbench.extensions.action.showExtensionsWithIds',[id]);
  const row=windowPage.locator('.monaco-list-row').filter({has:windowPage.locator('.name').filter({hasText:/^PerfChecker$/})});
  await row.first().click();
  const status=windowPage.locator('.extension-editor .actions-status-container .status');
  await status.waitFor({state:'visible'});
  await eventually(async()=>(await status.innerText()).trim()===manifest.capabilities.untrustedWorkspaces.description,
    'The actual installed-extension UI explains its Workspace Trust requirement');
  assert(await status.locator('.codicon-extension-workspace-trust').count()>0,
    'The official extension status displays the Workspace Trust restriction icon');
  assert(inactive());
  const after=await ownedJuliaProcesses();
  log('native-restricted-process-inventory',{stage:'after-ui-inspection',extensionHost:process.pid,julia:after});
  assert.deepEqual(after,[],'No Julia worker appears before the private host teardown');
  assert.deepEqual(await fs.readFile(path.join(workspace,'Project.toml')),project);
  assert.deepEqual(await fs.readFile(path.join(workspace,'.vscode','settings.json')),settings);
  await assert.rejects(fs.access(path.join(workspace,'perf','results')),error=>error.code==='ENOENT');
  await windowPage.screenshot({path:path.join(output,'native-restricted-installed-extension.png')});
  proof('native-restricted-mode',{nativeTrustRefusal:true,workspaceTrusted:false,restrictedStatusVisible:true,
    installedProductInactive:true,contributedCommandPlaceholdersObserved:true,visibleTrustRequirement:true,
    noOwnedJuliaProcessesBeforeTeardown:true,platformScope:'Linux stable private-profile representative',
    workspaceProjectAndSettingsUnchanged:true,noProductReports:true,
    source:'Installed VSIX blocked by actual VS Code Workspace Trust in a disposable profile; no product activation forced'});
};
