import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {nativeVSCodeApplication} from './native-vscode-application.mjs';

async function fixture(run) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-vscode-layout-'));
  const executable=path.join(root,'Code.exe'),cli=path.join(root,'bin','code.cmd');
  const add=async(commit,version='1.141.0',productVersion=version)=>{
    const prefix=commit.slice(0,10),application=path.join(root,prefix,'resources','app');
    await fs.mkdir(path.join(application,'out'),{recursive:true});
    await fs.writeFile(path.join(application,'package.json'),JSON.stringify({version}));
    await fs.writeFile(path.join(application,'product.json'),JSON.stringify({version:productVersion,commit,applicationName:'code'}));
    await fs.writeFile(path.join(application,'out','cli.js'),'export const actualCLI = true;');
    await fs.writeFile(cli,`"%~dp0..\\Code.exe" "%~dp0..\\${prefix}\\resources\\app\\out\\cli.js" %*`);
    return application;
  };
  try{await fs.mkdir(path.dirname(cli));await fs.writeFile(executable,'fixture');await run({root,executable,cli,add});}
  finally{await fs.rm(root,{recursive:true,force:true});}
}

test('versioned Windows metadata and the SDK wrapper identify the same actual application',()=>fixture(async({executable,cli,add})=>{
  const commit='2a59476c9bfcb90b3ddc372c36762471b7dfad1c',application=await add(commit);
  const result=await nativeVSCodeApplication(executable,cli,{platform:'win32',expectedVersion:'1.141.0'});
  assert.equal(result.application,application);assert.equal(result.commit,commit);assert.equal(result.version,'1.141.0');
}));

test('ambiguous complete Windows distributions are rejected before choosing an application',()=>fixture(async({executable,cli,add})=>{
  await add('a'.repeat(40));await add('b'.repeat(40));
  await assert.rejects(nativeVSCodeApplication(executable,cli,{platform:'win32'}),/Exactly one complete/);
}));

test('mismatched product versions and wrappers cannot qualify the versioned application',()=>fixture(async({executable,cli,add})=>{
  await add('a'.repeat(40),'1.141.0','1.140.0');
  await assert.rejects(nativeVSCodeApplication(executable,cli,{platform:'win32'}),/package and product versions agree/);
  await add('a'.repeat(40));await fs.writeFile(cli,'"%~dp0..\\Code.exe" "%~dp0..\\wrong\\out\\cli.js" %*');
  await assert.rejects(nativeVSCodeApplication(executable,cli,{platform:'win32'}),/wrapper routes to the same/);
}));
