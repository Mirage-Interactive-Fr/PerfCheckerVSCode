import test from 'node:test';
import assert from 'node:assert/strict';
import Module,{createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('explicit controller setup targets Core 1.1.0 without rewriting the selected older environment',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-controller-upgrade-'));
  const oldProject=path.join(root,'perf');await fs.mkdir(oldProject);
  const projectBytes='[deps]\n',manifestBytes='# Existing controller is preserved\n';
  await fs.writeFile(path.join(oldProject,'Project.toml'),projectBytes);
  await fs.writeFile(path.join(oldProject,'Manifest.toml'),manifestBytes);
  const uri=file=>({scheme:'file',fsPath:file,toString:()=>`file://${file}`});
  const folder={name:'fixture',uri:uri(root)},disposable=()=>({dispose(){}}),values=new Map(),calls=[],warnings=[],children=[];
  const settings={get:(key,fallback)=>values.has(key)?values.get(key):fallback,inspect:()=>({}),
    update:async(key,value)=>values.set(key,value)};
  const token={isCancellationRequested:false,onCancellationRequested:disposable};
  const vscode={CancellationError:class extends Error{},ProgressLocation:{Notification:1},ConfigurationTarget:{WorkspaceFolder:3},
    workspace:{isTrusted:true,workspaceFolders:[folder],getConfiguration:()=>settings,
      onDidChangeWorkspaceFolders:disposable,onDidChangeConfiguration:disposable},
    window:{withProgress:async(_options,run)=>run({},token),showQuickPick:async choices=>choices.find(choice=>choice.action==='create'),
      showWarningMessage:async message=>{warnings.push(message);return 'Install controller';}}};
  // Exercise the real UI/setup orchestration while capturing Julia's invocation;
  // this fixture does not claim a package installation or run Julia.
  const launch=(executable,args,options)=>{
    calls.push({executable,args,options});
    const child=spawn(process.execPath,['-e',`process.exit(${calls.length===1?1:0})`],
      {stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
    children.push(child);return child;
  };
  const original=Module._load;
  Module._load=function(name,...args){return name==='vscode'?vscode:name==='node:child_process'?{spawn:launch}:original.call(this,name,...args);};
  let prepare;try{const require=createRequire(import.meta.url);delete require.cache[require.resolve('../dist/workspaceSetup.js')];({prepareWorkspaceController:prepare}=require('../dist/workspaceSetup.js'));}finally{Module._load=original;}
  try{
    assert.equal(await prepare(folder,{append(){},appendLine(){}}),true);
    assert.equal(calls.length,2,'A rejected existing controller requires an explicit install choice');
    assert.match(calls[0].args.at(-1),/v"1\.1\.0" <= Base\.pkgversion\(PerfChecker\) < v"2\.0\.0"/);
    assert.match(calls[1].args.at(-1),/Pkg\.add\(PackageSpec\(name="PerfChecker",version="1\.1\.0"\)\)/);
    assert.match(calls[1].args.at(-1),/Base\.pkgversion\(PerfChecker\)==v"1\.1\.0"/);
    assert(!calls[1].args.at(-1).includes('Pkg.develop'),'Stable installation uses the registered package');
    assert(calls[1].args.includes(`--project=${path.join(root,'perf','controller')}`));
    assert.match(warnings[0],/Install PerfChecker 1\.1\.0/);
    assert.equal(values.get('runnerProject'),path.join('perf','controller'));
    assert.equal(values.get('scenarioProject'),path.join('perf','controller'));
    assert.equal(await fs.readFile(path.join(oldProject,'Project.toml'),'utf8'),projectBytes);
    assert.equal(await fs.readFile(path.join(oldProject,'Manifest.toml'),'utf8'),manifestBytes);
    assert(children.every(child=>child.exitCode!==null),'Owned setup invocations finish before return');
  }finally{
    for(const child of children)if(child.exitCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));}
    await fs.rm(root,{recursive:true,force:true});
  }
});

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
