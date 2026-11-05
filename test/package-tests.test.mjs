import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {spawn as nativeSpawn} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const require=createRequire(import.meta.url),original=Module._load,calls=[];
Module._load=function(name,...args){
  if(name==='node:child_process')return {spawn:(cli,argv,options)=>{
    calls.push({cli,argv,options});
    const code=cli==='controlled-cancel' ?
      'process.stdout.write("ready\\n");process.stdin.on("data",()=>setTimeout(()=>process.exit(130),40));' :
      `process.stdout.write("Package test output.\\n");process.exit(${cli==='controlled-pass'?0:1});`;
    return nativeSpawn(process.execPath,['-e',code],options);
  }};
  return original.call(this,name,...args);
};
let runPackageTests;try{({runPackageTests}=require('../dist/packageTests.js'));}finally{Module._load=original;}

test('package verification runs fixed Pkg.test with one thread and reports the process outcome',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-package-tests-'));
  try {
    await assert.rejects(runPackageTests(root,'controlled-pass',new AbortController().signal),/Julia package/);
    await writeFile(path.join(root,'Project.toml'),'name = "Example"\n');
    for(const status of ['pass','fail']){
      const report=await runPackageTests(root,`controlled-${status}`,new AbortController().signal);
      assert.equal(report.status,status==='pass'?'passed':'failed');assert.match(report.output,/Package test output/);
      const call=calls.at(-1);assert.equal(call.options.env.JULIA_NUM_THREADS,'1');assert.equal(call.options.env.JULIA_NUM_PRECOMPILE_TASKS,'1');
      assert.match(call.argv.at(-1),/Pkg.test\(; julia_args=\["--threads=1"\]\)/);
      assert.match(call.argv.at(-1),/PERFCHECKER_CANCEL\/1/,'The package tests use the controller cancellation reader');
      assert.equal(call.argv[1],`--project=${root}`);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('package-test cancellation awaits the actual child close',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-package-cancel-')),abort=new AbortController();
  try {
    await writeFile(path.join(root,'Project.toml'),'name = "Example"\n');
    let cancelAt=0;
    const result=await runPackageTests(root,'controlled-cancel',abort.signal,text=>{if(text.includes('ready')){cancelAt=Date.now();abort.abort();}});
    assert.equal(result.status,'cancelled');assert.equal(result.exitCode,130);assert(Date.now()-cancelAt>=30);
  } finally {await rm(root,{recursive:true,force:true});}
});
