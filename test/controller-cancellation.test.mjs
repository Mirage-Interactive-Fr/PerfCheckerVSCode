import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {cancellableJulia, controllerCancellation, shutdownControllerProcesses} from '../dist/controllerCancellation.js';

test('deactivation requests and awaits every owned controller cleanup',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'perfchecker-deactivate-')),children=[];
  try{
    for(let i=0;i<2;i++){
      const child=spawn(process.execPath,['-e','process.stdin.setEncoding("utf8");process.stdout.write("ready\\n");process.stdin.on("data",text=>{if(text.includes("PERFCHECKER_CANCEL/1"))setTimeout(()=>{require("fs").writeFileSync(process.argv[1],"cleaned");process.exit(0);},30);});',path.join(root,String(i))],{detached:process.platform!=='win32'});
      children.push(child);child.stderr.resume();controllerCancellation(child,()=>{},10000);
      await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
    }
    await shutdownControllerProcesses();
    assert.deepEqual(await Promise.all([0,1].map(i=>readFile(path.join(root,String(i)),'utf8'))),['cleaned','cleaned']);
    assert(children.every(child=>child.exitCode===0),'Shutdown finishes after child exit, not after sending a request');
  }finally{for(const child of children)if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});

const julia = process.env.PERFCHECKER_TEST_JULIA;
test('portable stdin cancellation unwinds Julia cleanup, preserves failure and bounds forced stop', {skip: !julia}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'perfchecker-stdin-cancel-'));
  try {
    for (const mode of ['clean', 'failure', 'forced','eof-clean','eof-failure','normal']) {
      const ready = path.join(root, `${mode}-ready`), cleaned = path.join(root, `${mode}-cleaned`);
      const quote = value => JSON.stringify(value).replaceAll('$', '\\$');
      const operation = mode === 'forced' ? 'while true; nothing; end' : mode==='normal'?'sleep(0.1)':'sleep(120)';
      const code = `write(${quote(ready)}, "ready"); try; ${operation}; finally; write(${quote(cleaned)}, "cleanup"); ${mode.endsWith('failure') ? 'error("real cleanup failure")' : ''}; end`;
      const child = spawn(julia, ['--startup-file=no', '-e', cancellableJulia(code)], {detached: process.platform !== 'win32'});
      let stderr = ''; child.stderr.on('data', bytes => {stderr += bytes;});
      child.stdout.resume();
      const closed = new Promise((resolve, reject) => {child.once('close', (code, signal) => resolve({code, signal})); child.once('error', reject);});
      const notices = [], stop = controllerCancellation(child, (message, forced) => notices.push({message, forced}), mode === 'forced' ? 100 : 10000);
      try {
        const deadline = Date.now() + 30000;
        while (!(await stat(ready).catch(() => undefined))) {
          if (Date.now() > deadline) throw new Error(`Julia did not start: ${stderr}`);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        if(mode.startsWith('eof-'))child.stdin.end();
        else if(mode!=='normal'){stop.request();stop.request();}
        const result = await Promise.race([closed,new Promise((_,reject)=>{const timeout=setTimeout(()=>reject(new Error(`${mode}: owned Julia did not stop after its control input`)),20000);closed.then(()=>clearTimeout(timeout));})]);
        if (mode === 'forced') {assert.equal(stop.forced, true); assert.ok(notices.some(item => item.forced));}
        else {
          assert.equal(stop.forced, false);
          assert.equal(await readFile(cleaned, 'utf8'), 'cleanup');
          assert.equal(result.code,mode==='normal'?0:mode.endsWith('failure')?1:130);
          if (mode.endsWith('failure')) assert.match(stderr, /real cleanup failure/);
        }
        assert.equal(notices.filter(item => item.message.startsWith('Cancelling')).length,mode.startsWith('eof-')||mode==='normal'?0:1);
      } finally {stop.dispose(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed;}
    }
  } finally {await rm(root, {recursive: true, force: true});}
});
