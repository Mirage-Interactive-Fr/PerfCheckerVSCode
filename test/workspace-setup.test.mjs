import test from 'node:test';
import assert from 'node:assert/strict';
import Module,{createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

for(const status of [130,2])test(status===130?'cancelling controller verification ends setup without reopening the install wizard':'controller cancellation failures remain visible without opening the install wizard',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-controller-cancel-'));
  const project=path.join(root,'perf'),marker=path.join(root,'cancelled.txt');
  await fs.mkdir(project);await fs.writeFile(path.join(project,'Project.toml'),'[deps]\n');
  const uri=file=>({scheme:'file',fsPath:file,toString:()=>`file://${file}`});
  const folder={name:'fixture',uri:uri(root)},disposable=()=>({dispose(){}});
  const token={isCancellationRequested:false,onCancellationRequested(listener){
    const timer=setTimeout(()=>{token.isCancellationRequested=true;listener();},50);
    return {dispose(){clearTimeout(timer);}};
  }};
  let picks=0,updates=0,child;
  const vscode={CancellationError:class extends Error{},ProgressLocation:{Notification:1},
    workspace:{isTrusted:true,workspaceFolders:[folder],getConfiguration:()=>({get:(_key,fallback)=>fallback,update:async()=>updates++}),
      onDidChangeWorkspaceFolders:disposable,onDidChangeConfiguration:disposable},
    window:{withProgress:async(_options,run)=>run({},token),showQuickPick:async()=>{picks++;return undefined;}}};
  const launch=()=>child=spawn(process.execPath,['-e',
    `const fs=require('node:fs');process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.includes('PERFCHECKER_CANCEL/1')){fs.writeFileSync(${JSON.stringify(marker)},'cancelled');process.exit(${status});}});setInterval(()=>{},1000);`],
    {stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
  const original=Module._load;
  Module._load=function(name,...args){return name==='vscode'?vscode:name==='node:child_process'?{spawn:launch}:original.call(this,name,...args);};
  let prepare;try{const require=createRequire(import.meta.url);delete require.cache[require.resolve('../dist/workspaceSetup.js')];({prepareWorkspaceController:prepare}=require('../dist/workspaceSetup.js'));}finally{Module._load=original;}
  try{
    if(status===130)assert.equal(await prepare(folder,{append(){},appendLine(){}}),false);
    else await assert.rejects(prepare(folder,{append(){},appendLine(){}}),/cancellation failed.*cleanup errors/);
    assert.equal(await fs.readFile(marker,'utf8'),'cancelled','The owned controller exits before the action returns');
    assert.equal(child.exitCode,status);
    assert.equal(picks,0,'Cancellation is not a missing prerequisite and must not reopen setup');
    assert.equal(updates,0,'Cancellation never changes controller settings');
  }finally{
    if(child&&child.exitCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));}
    await fs.rm(root,{recursive:true,force:true});
  }
});
