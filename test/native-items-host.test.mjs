import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('native item controller preserves selection, exclusions, cancellation and trusted workspace', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-native-'));
  const calls=[],controllers=[],commands=new Map(),disposable=()=>({dispose(){}});
  class Items {values=[];replace(values){this.values=values;}forEach(fn){this.values.forEach(fn);}}
  const uri=p=>({fsPath:p,toString:()=>`file://${p}`});
  const folder={name:'demo',uri:uri(root)};
  const mock={Uri:{file:uri},TestTag:class {constructor(id){this.id=id;}},TestMessage:class {},
    TestRunProfileKind:{Run:1},workspace:{isTrusted:true,workspaceFolders:[folder],textDocuments:[],
      getWorkspaceFolder:()=>folder,getConfiguration:()=>({get:(_key,fallback)=>fallback})},
    window:{createOutputChannel:()=>({...disposable(),append(){},appendLine(){},show(){}})},
    commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return disposable();}},
    tests:{createTestController:()=>{
      const c={items:new Items(),...disposable(),createTestItem:(id,label,uri)=>({id,label,uri}),
        createRunProfile:(_name,_kind,fn)=>{c.handler=fn;},
        createTestRun:()=>{const r={events:[],end(){this.ended=true;},appendOutput(){}};
          for(const key of ['enqueued','started','passed','failed','errored','skipped'])r[key]=item=>r.events.push([key,item.id]);
          c.lastRun=r;return r;}};controllers.push(c);return c;
    }}};
  const rows=['a','b'].map(id=>({id,name:id,file:'items.jl',tags:[],source_sha256:'fixture'}));
  let exitCode = 0;
  const spawn=(_exe,args,options)=>{
    calls.push({args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.exitCode=null;child.signalCode=null;
    void(async()=>{
      const destination=args.find(v=>v.startsWith('--output=')).slice(9);
      const itemId=args.find(v=>v.startsWith('--item-id='))?.slice(10);
      const payload=args.includes('--list')?{schema_version:'perfchecker-testitems/1',items:rows}:
        {schema_version:'perfchecker-testitem-run/1',passed:true,runs:[{item:{id:itemId},status:'validated',samples:[{status:'complete',correctness:'passed',seconds:0.25}]}]};
      await fs.writeFile(destination,JSON.stringify(payload));child.stdout.end();child.stderr.end();child.exitCode=exitCode;child.emit('close',exitCode);
    })().catch(e=>child.emit('error',e));return child;
  };
  const original=Module._load,require=createRequire(import.meta.url);
  Module._load=function(name,...args){return name==='vscode'?mock:name==='node:child_process'?{spawn}:original.call(this,name,...args);};
  let register;try {({registerNativeTestItems:register}=require('../dist/testitems.js'));} finally {Module._load=original;}
  const token={isCancellationRequested:false,onCancellationRequested:()=>disposable()};
  try {
    register({subscriptions:[],globalStorageUri:uri(path.join(root,'storage'))});
    assert.equal(calls.length,0);
    await commands.get('perfchecker.discoverTestItems')();
    const c=controllers[0];assert.equal(c.items.values.length,2);
    await c.handler({include:[c.items.values[0],c.items.values[0]],exclude:[]},token);
    assert.deepEqual(c.lastRun.events.filter(e=>e[0]==='passed'),[['passed','a']]);assert.equal(c.lastRun.ended,true);
    assert.deepEqual(calls.filter(c=>!c.args.includes('--list')).map(c=>c.args.find(v=>v.startsWith('--item-id='))),['--item-id=a']);
    assert.ok(calls[1].args.includes('--samples=1'));
    assert.equal(calls[1].options.env.JULIA_PROJECT,undefined);
    assert.equal(calls[1].options.env.JULIA_LOAD_PATH,['@','@stdlib'].join(path.delimiter));
    const count=calls.length;
    await c.handler({include:[]},token);assert.equal(calls.length,count);
    await c.handler({include:[c.items.values[0]],exclude:[{id:'a'}]},token);assert.equal(calls.length,count);
    await c.handler({}, {...token,isCancellationRequested:true});assert.equal(calls.length,count);
    exitCode = 2;
    await c.handler({include:[c.items.values[0]]},token);
    assert.deepEqual(c.lastRun.events.filter(e=>e[0]==='passed'),[]);
    assert.deepEqual(c.lastRun.events.filter(e=>e[0]==='errored'),[['errored','a']]);
    const afterFailure = calls.length;
    mock.workspace.isTrusted=false;
    await assert.rejects(commands.get('perfchecker.discoverTestItems')(),/trusted workspace/);
    assert.equal(calls.length,afterFailure);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
