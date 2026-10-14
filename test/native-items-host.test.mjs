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
  await fs.mkdir(path.join(root,'perf','controller'),{recursive:true});
  await fs.writeFile(path.join(root,'perf','controller','Project.toml'),'name = "PerfController"\n');
  const calls=[],controllers=[],commands=new Map(),disposable=()=>({dispose(){}});
  class Items {values=[];replace(values){this.values=values;}forEach(fn){this.values.forEach(fn);}}
  const uri=p=>({scheme:'file',fsPath:p,toString:()=>`file://${p}`});
  const folder={name:'demo',uri:uri(root)};
  const mock={Uri:{file:uri},TestTag:class {constructor(id){this.id=id;}},TestMessage:class {},
    TestRunProfileKind:{Run:1},workspace:{isTrusted:true,workspaceFolders:[folder],textDocuments:[],
      getWorkspaceFolder:()=>folder,getConfiguration:()=>({get:(_key,fallback)=>fallback})},
    window:{createOutputChannel:()=>({...disposable(),append(){},appendLine(){},show(){}})},
    commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return disposable();}},
    tests:{createTestController:(id,label)=>{
      const c={id,label,items:new Items(),...disposable(),createTestItem:(id,label,uri)=>({id,label,uri}),
        createRunProfile:(name,_kind,fn)=>{c.profileName=name;c.handler=fn;},
        createTestRun:()=>{const r={events:[],outputs:[],end(){this.ended=true;},appendOutput(text,_location,item){this.outputs.push({text,item:item?.id});}};
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
    assert.equal(controllers.length,0);
    await commands.get('perfchecker.discoverTestItems')();
    assert.equal(controllers.length,1);
    assert.equal(controllers[0].id,`perfchecker.testitems.${folder.uri.toString()}`);
    assert.equal(controllers[0].label,'PerfChecker — measures · demo');
    assert.equal(controllers[0].profileName,'PerfChecker — measures');
    assert.ok(calls[0].args.includes(`--project=${path.join(root,'perf','controller')}`));
    await commands.get('perfchecker.discoverTestItems')(folder.uri);
    assert.equal(calls.length,2);
    await assert.rejects(commands.get('perfchecker.discoverTestItems')(uri(path.join(root,'other'))),/not an open/);
    const c=controllers[0];assert.equal(c.items.values.length,2);
    await c.handler({include:[c.items.values[0],c.items.values[0]],exclude:[]},token);
    assert.deepEqual(c.lastRun.events.filter(e=>e[0]==='passed'),[['passed','a']]);assert.equal(c.lastRun.ended,true);
    assert.deepEqual(calls.filter(c=>!c.args.includes('--list')).map(c=>c.args.find(v=>v.startsWith('--item-id='))),['--item-id=a']);
    assert.ok(calls[2].args.includes('--samples=1'));
    assert.equal(calls[2].options.env.JULIA_PROJECT,undefined);
    assert.equal(calls[2].options.env.JULIA_LOAD_PATH,['@','@stdlib'].join(path.delimiter));
    const count=calls.length;
    await c.handler({include:[]},token);assert.equal(calls.length,count);
    await c.handler({include:[c.items.values[0]],exclude:[{id:'a'}]},token);assert.equal(calls.length,count);
    await c.handler({}, {...token,isCancellationRequested:true});assert.equal(calls.length,count);
    exitCode = 2;
    await c.handler({include:[c.items.values[0]]},token);
    assert.deepEqual(c.lastRun.events.filter(e=>e[0]==='passed'),[]);
    assert.deepEqual(c.lastRun.events.filter(e=>e[0]==='errored'),[['errored','a']]);
    assert.equal(c.lastRun.outputs.length,1,'Failed items expose their diagnostic in the native Testing output');
    assert.equal(c.lastRun.outputs[0].item,'a');
    assert.match(c.lastRun.outputs[0].text,/package under test and its test dependencies/);
    assert.match(c.lastRun.outputs[0].text,/Controller setup installs PerfChecker and collectors only/);
    assert.match(c.lastRun.outputs[0].text,/\r\n/);
    const afterFailure = calls.length;
    mock.workspace.isTrusted=false;
    await assert.rejects(commands.get('perfchecker.discoverTestItems')(),/trusted workspace/);
    assert.equal(calls.length,afterFailure);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('native discovery shares equivalent callbacks and only publishes the latest requested selection', {timeout:10000}, async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-discovery-'));
  const uri=p=>({scheme:'file',fsPath:p,toString:()=>`file://${p}`});
  const folders=['one','two'].map(name=>({name,uri:uri(path.join(root,name))}));
  for(const folder of folders)for(const name of ['controller-a','controller-b']){
    await fs.mkdir(path.join(folder.uri.fsPath,name),{recursive:true});
    await fs.writeFile(path.join(folder.uri.fsPath,name,'Project.toml'),'name = "Controller"\n');
  }
  const calls=[],controllers=[],commands=new Map(),requests=[],spawned=new EventEmitter();
  const disposable=()=>({dispose(){}}),base=()=>({runnerProject:'controller-a',juliaExecutable:'julia-a',testItemTags:['a'],testItemExcludeTags:['excluded-a']});
  let settings=base(),finishing=false,holdMkdir=false;
  const heldDirectories=[];
  const mkdir=async(directory,options)=>{
    await fs.mkdir(directory,options);
    if(holdMkdir&&directory.startsWith(path.join(root,'storage','native-testitems')+path.sep))
      await new Promise(resolve=>{heldDirectories.push(resolve);spawned.emit('mkdir');});
  };
  class Items {values=[];replace(values){this.values=values;}forEach(fn){this.values.forEach(fn);}}
  const mock={Uri:{file:uri},TestTag:class {constructor(id){this.id=id;}},TestRunProfileKind:{Run:1},
    workspace:{isTrusted:true,workspaceFolders:folders,textDocuments:[],getConfiguration:()=>({get:(key,fallback)=>settings[key]??fallback})},
    window:{createOutputChannel:()=>({...disposable(),append(){},appendLine(){},show(){}})},
    commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return disposable();}},
    tests:{createTestController:(id,label)=>{
      const c={id,label,items:new Items(),...disposable(),createTestItem:(id,label,uri)=>({id,label,uri}),createRunProfile(){}};
      controllers.push(c);return c;
    }}};
  const close=(call,code)=>{call.child.exitCode=code;call.child.stdout.end();call.child.stderr.end();call.child.emit('close',code);};
  const spawn=(executable,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.signalCode=null;
    const call={executable,args,options,child};calls.push(call);spawned.emit('spawn');
    if(finishing)queueMicrotask(()=>close(call,2));
    return child;
  };
  const track=promise=>{requests.push(promise);void promise.catch(()=>{});return promise;};
  const waitForCalls=count=>calls.length>=count?Promise.resolve():new Promise(resolve=>{
    const next=()=>{if(calls.length>=count){spawned.off('spawn',next);resolve();}};spawned.on('spawn',next);
  });
  const complete=async(call,id)=>{
    await fs.writeFile(call.args.find(a=>a.startsWith('--output=')).slice(9),JSON.stringify({schema_version:'perfchecker-testitems/1',items:[{id,name:id,file:'items.jl',tags:[],source_sha256:'fixture'}]}));
    close(call,0);
  };
  const original=Module._load,require=createRequire(import.meta.url),modulePath=require.resolve('../dist/testitems.js');
  delete require.cache[modulePath];
  Module._load=function(name,...args){return name==='vscode'?mock:name==='node:child_process'?{spawn}:
    name==='node:fs'?{...original.call(this,name,...args),promises:{...fs,mkdir}}:original.call(this,name,...args);};
  let register;try {({registerNativeTestItems:register}=require(modulePath));} finally {Module._load=original;}
  try {
    register({subscriptions:[],globalStorageUri:uri(path.join(root,'storage'))});
    const command=commands.get('perfchecker.discoverTestItems');
    const tags=settings.testItemTags,excluded=settings.testItemExcludeTags;
    const first=track(command(folders[0].uri)),controller=controllers[0];
    const resolved=track(controller.resolveHandler()),refreshed=track(controller.refreshHandler());
    assert.equal(resolved,refreshed,'Resolve and Refresh share the actual in-flight promise');
    tags.push('changed-after-request');excluded.push('changed-after-request');
    settings={runnerProject:'controller-b',juliaExecutable:'julia-b',testItemTags:['b'],testItemExcludeTags:['excluded-b']};
    const middle=track(command(folders[0].uri));
    settings=base();
    const latest=track(controller.resolveHandler());
    assert.equal(latest,resolved,'A → B → A joins the existing A invocation');
    await waitForCalls(2);
    const a=calls.find(c=>c.executable==='julia-a'),b=calls.find(c=>c.executable==='julia-b');
    assert.equal(a.executable,'julia-a');assert.equal(b.executable,'julia-b');
    assert(a.args.includes(`--project=${path.join(folders[0].uri.fsPath,'controller-a')}`));
    assert(b.args.includes(`--project=${path.join(folders[0].uri.fsPath,'controller-b')}`));
    assert(a.args.includes('--tags=a'));assert(a.args.includes('--exclude-tags=excluded-a'));
    assert(b.args.includes('--tags=b'));assert(b.args.includes('--exclude-tags=excluded-b'));
    assert.equal(a.options.cwd,folders[0].uri.fsPath);assert(a.args.includes(`--root=${folders[0].uri.fsPath}`));
    assert(a.args.includes('--list'));assert.equal(a.options.env.JULIA_PROJECT,undefined);
    await complete(a,'latest-a');await Promise.all([first,resolved,refreshed,latest]);
    await complete(b,'obsolete-b');await middle;
    assert.equal(calls.length,2);assert.deepEqual(controller.items.values.map(i=>i.id),['latest-a']);

    for(const [change,label] of [[{runnerProject:'controller-b'},'project'],[{juliaExecutable:'julia-b'},'executable'],
      [{testItemTags:['b']},'tags'],[{testItemExcludeTags:['excluded-b']},'exclusions']]){
      const before=calls.length;settings=base();const older=track(controller.resolveHandler());
      settings={...base(),...change};const newer=track(controller.refreshHandler());
      assert.notEqual(older,newer,`${label} changes require a distinct invocation`);
      await waitForCalls(before+2);
      const pair=calls.slice(before),newCall=pair.find(c=>label==='project'?c.args.includes(`--project=${path.join(folders[0].uri.fsPath,'controller-b')}`):
        label==='executable'?c.executable==='julia-b':c.args.includes(label==='tags'?'--tags=b':'--exclude-tags=excluded-b'));
      await complete(newCall,label);await newer;
      await complete(pair.find(c=>c!==newCall),`obsolete-${label}`);await older;
      assert.equal(calls.length,before+2);assert.deepEqual(controller.items.values.map(i=>i.id),[label]);
    }

    settings=base();let before=calls.length;
    const failedCommand=track(command(folders[0].uri)),failedResolve=track(controller.resolveHandler()),failedRefresh=track(controller.refreshHandler());
    assert.equal(failedResolve,failedRefresh);
    const originalError=new Error('owned discovery spawn failed');
    const failures=[failedCommand,failedResolve,failedRefresh].map(p=>assert.rejects(p,error=>error===originalError));
    await waitForCalls(before+1);calls[before].child.emit('error',originalError);close(calls[before],2);
    await Promise.all(failures);assert.equal(calls.length,before+1);
    before=calls.length;const recovery=track(controller.resolveHandler());
    await waitForCalls(before+1);await complete(calls[before],'recovered');await recovery;
    assert.deepEqual(controller.items.values.map(i=>i.id),['recovered']);

    before=calls.length;const superseded=track(controller.resolveHandler());
    settings={...base(),runnerProject:'missing-controller'};
    await assert.rejects(controller.refreshHandler(),/controller Project.toml not found/);
    settings=base();await waitForCalls(before+1);await complete(calls[before],'obsolete-after-refusal');await superseded;
    assert.equal(calls.length,before+1);assert.deepEqual(controller.items.values.map(i=>i.id),['recovered']);

    for(const change of ['settings','trust','folder']){
      before=calls.length;const obsolete=track(controller.resolveHandler());await waitForCalls(before+1);
      if(change==='settings')settings={...base(),testItemTags:['changed-without-refresh']};
      else if(change==='trust')mock.workspace.isTrusted=false;
      else mock.workspace.workspaceFolders=[folders[1]];
      await complete(calls[before],`obsolete-after-${change}`);await obsolete;
      assert.deepEqual(controller.items.values.map(i=>i.id),['recovered'],`${change} changes without Refresh prevent stale publication`);
      settings=base();mock.workspace.isTrusted=true;mock.workspace.workspaceFolders=folders;
    }

    for(const change of ['trust','folder']){
      before=calls.length;holdMkdir=true;
      const entered=new Promise(resolve=>spawned.once('mkdir',resolve));
      const refused=track(controller.resolveHandler());await entered;
      if(change==='trust')mock.workspace.isTrusted=false;
      else mock.workspace.workspaceFolders=[folders[1]];
      const rejected=assert.rejects(refused,/trusted workspace/);
      holdMkdir=false;heldDirectories.shift()();await rejected;
      assert.equal(calls.length,before,`${change} revoked during directory preparation prevents spawn`);
      mock.workspace.isTrusted=true;mock.workspace.workspaceFolders=folders;
    }

    before=calls.length;
    const own=track(controller.resolveHandler()),other=track(command(folders[1].uri));
    mock.workspace.isTrusted=false;
    await assert.rejects(command(folders[0].uri),/trusted workspace/);
    mock.workspace.isTrusted=true;
    await waitForCalls(before+2);
    assert.notEqual(calls[before].options.cwd,calls[before+1].options.cwd);
    for(const call of calls.slice(before))await complete(call,call.options.cwd===folders[0].uri.fsPath?'one':'two');
    await Promise.all([own,other]);assert.equal(controllers.length,2);
    assert.deepEqual(controllers.map(c=>c.items.values.map(i=>i.id)),[['recovered'],['two']],
      'The refused newer request invalidates folder one only');
    mock.workspace.isTrusted=false;
    await assert.rejects(command(folders[0].uri),/trusted workspace/);
    assert.equal(calls.length,before+2,'Untrusted discovery never starts or joins an invocation');
  } finally {
    finishing=true;holdMkdir=false;for(const release of heldDirectories.splice(0))release();
    for(const call of calls)if(call.child.exitCode===null)close(call,2);
    await Promise.allSettled(requests);spawned.removeAllListeners();delete require.cache[modulePath];
    await fs.rm(root,{recursive:true,force:true});
  }
});
