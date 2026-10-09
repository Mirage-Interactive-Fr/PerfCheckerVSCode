import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {mkdtemp, open, rm, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {readProfileObservations, readProfileObservationStream} from '../dist/observation-reader.js';

const selected=[{package:'Example',feature:'route',version:'v1'}];
const row=(extra={})=>({record_type:'observation',case_id:'route',target_id:'v1',metric:'julia.profile.samples',
  measurement_definition:'profile',unit:'1',value:1,attributes:{package:'Example',feature:'route',stack:['entry','route']},...extra});

test('the real file reader retains observations beyond 250000, including spaced JSON',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'perfchecker-observation-reader-'));
  const source=path.join(directory,'observations.jsonl'),count=250_003;
  try{
    const file=await open(source,'w');
    try{
      const line=JSON.stringify(row())+'\n',chunk=line.repeat(1000);
      for(let index=0;index<250;index++)await file.writeFile(chunk);
      await file.writeFile(JSON.stringify(row({case_id:'after-former-cap'}))+'\n');
      await file.writeFile(JSON.stringify(row({case_id:'spaced-json'})).replaceAll(':',': ').replaceAll(',',', ')+'\n');
      await file.writeFile(JSON.stringify(row({case_id:'attribute-version',target_id:'alternate',
        attributes:{...row().attributes,version:'v1'}}))+'\n');
      await file.writeFile('{malformed diagnostic}\nnull\n[]\n'+JSON.stringify({...row(),record_type:'diagnostic'})+'\n'+
        JSON.stringify(row({attributes:{...row().attributes,feature:'not-selected'}}))+'\n');
    }finally{await file.close();}
    const started=performance.now(),rows=await readProfileObservations(source,selected),elapsedMs=performance.now()-started;
    assert.equal(rows.length,count);
    assert.deepEqual(rows.slice(-3).map(item=>item.case_id),['after-former-cap','spaced-json','attribute-version']);
    const bytes=(await stat(source)).size;
    t.diagnostic(JSON.stringify({source:'actual-JSONL-file',observations:rows.length,bytes,elapsedMs}));
    assert(bytes<90_000_000,'The boundary fixture remains bounded in size');
    assert(elapsedMs<60_000,'The complete real reader finishes within the CI budget');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('actual file streams are closed after success and I/O errors',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'perfchecker-observation-close-'));
  try{
    const source=path.join(directory,'observations.jsonl');await writeFile(source,JSON.stringify(row())+'\n');
    const stream=createReadStream(source,{encoding:'utf8'});
    assert.equal((await readProfileObservationStream(stream,selected)).length,1);
    assert(stream.closed&&stream.destroyed,'Successful reads release the real file descriptor before resolving');
    const missing=createReadStream(path.join(directory,'missing.jsonl'),{encoding:'utf8'});
    await assert.rejects(readProfileObservationStream(missing,selected),{code:'ENOENT'});
    assert(missing.closed&&missing.destroyed,'An actual filesystem error releases the stream before rejecting');
  }finally{await rm(directory,{recursive:true,force:true});}
});
