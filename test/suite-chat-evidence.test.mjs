import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,rm,truncate,rename,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

const require=createRequire(import.meta.url),{SuiteChatEvidence,validateSuiteChatSource}=require('../dist/suiteChatEvidence.js');
const runId='12345678-1234-4234-8234-123456789abc';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(root) {
  const reports=path.join(root,'perf/results/vscode'),directory=path.join(reports,'bundles','run-'+runId);
  await mkdir(directory,{recursive:true});
  const identity={suite:'saved-suite',profile:'quick',started_at:'2026-10-09T00:00:00',finished_at:'2026-10-09T00:01:00'};
  await writeFile(path.join(reports,'suite-result.json'),JSON.stringify({schema_version:'perfchecker-suite-result/1',...identity,runs:[]}));
  await writeFile(path.join(reports,'version-series.json'),JSON.stringify({schema_version:'perfchecker-version-series/1',run_id:runId,series:[],plots:[]}));
  const files={
    'manifest.json':JSON.stringify({schema_version:'perfchecker-run-bundle/1',run_id:runId,...identity,state:'complete'}),
    'measurement-definitions.json':'[]','observations.jsonl':'','diagnostics.jsonl':'','artifacts.json':'[]',
  };
  for(const [name,bytes]of Object.entries(files))await writeFile(path.join(directory,name),bytes);
  await writeFile(path.join(directory,'integrity.json'),JSON.stringify({schema_version:'perfchecker-bundle-integrity/1',algorithm:'sha256',
    files:Object.entries(files).map(([name,bytes])=>({path:name,bytes:Buffer.byteLength(bytes),sha256:hash(bytes)}))}));
  const physicalRoot=await realpath(root),physicalReports=await realpath(reports),physicalDirectory=await realpath(directory);
  return {root:physicalRoot,reports:physicalReports,directory:physicalDirectory,workspace:pathToFileURL(physicalRoot).href};
}

test('suite picker retains an explicit workspace/run identity and never selects a newer unrelated bundle',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-suite-picker-'));
  try {
    const a=await fixture(path.join(root,'a')),b=await fixture(path.join(root,'b')),inventory=new SuiteChatEvidence();
    await mkdir(path.join(a.reports,'bundles/run-newer-unrelated'));
    await inventory.refresh(a.workspace,a.root,'perf/results/vscode');await inventory.refresh(b.workspace,b.root,'perf/results/vscode');
    const entry=inventory.options(a.workspace)[0],source=await inventory.read(entry.id,a.workspace);
    assert.match(entry.id,/^suite:/);const identity=JSON.parse(entry.id.slice('suite:'.length));
    assert.equal(identity.length,3);assert.equal(identity[0],a.workspace);assert.equal(identity[1],runId);assert.match(identity[2],/^[a-f0-9]{64}$/);
    assert.equal(source.directory,a.directory);assert.equal(source.runId,runId);assert.equal(entry.unavailable,undefined);
    await assert.rejects(inventory.read(entry.id,b.workspace),/workspace/);
    const before=await readFile(path.join(a.reports,'suite-result.json'));
    await writeFile(path.join(a.reports,'suite-result.json'),Buffer.concat([before,Buffer.from(' ')]));
    await assert.rejects(inventory.read(entry.id,a.workspace),/changed/);
    await inventory.refresh(a.workspace,a.root,'perf/results/vscode');
    await assert.rejects(inventory.read(entry.id,a.workspace),/workspace/,'Old typed IDs cannot refer to a refreshed report');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('suite Send verifies actual protocol bytes while the picker remains read-only metadata',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-suite-integrity-'));
  try {
    const value=await fixture(root),inventory=new SuiteChatEvidence();await inventory.refresh(value.workspace,root,'perf/results/vscode');
    const source=await inventory.read(inventory.options(value.workspace)[0].id,value.workspace);
    await validateSuiteChatSource(source,true);
    await writeFile(path.join(value.directory,'observations.jsonl'),'tampered saved bytes\n');
    await assert.rejects(validateSuiteChatSource(source,true),/byte integrity/);
  } finally {await rm(root,{recursive:true,force:true});}
});

for(const mode of ['no-run-reference','missing-integrity','wrong-suite','wrong-time','oversized-observations','outside-bundle'])
test(`suite picker keeps Investigation usable but rejects ${mode}`,async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-suite-refusal-'));
  try {
    const value=await fixture(path.join(root,'workspace')),inventory=new SuiteChatEvidence();
    if(mode==='no-run-reference')await writeFile(path.join(value.reports,'version-series.json'),JSON.stringify({schema_version:'perfchecker-version-series/1'}));
    if(mode==='missing-integrity')await rm(path.join(value.directory,'integrity.json'));
    if(mode==='wrong-suite'||mode==='wrong-time'){
      const file=path.join(value.directory,'manifest.json'),data=JSON.parse(await readFile(file));
      data[mode==='wrong-suite'?'suite':'finished_at']='different';await writeFile(file,JSON.stringify(data));
    }
    if(mode==='oversized-observations')await truncate(path.join(value.directory,'observations.jsonl'),32_000_001);
    if(mode==='outside-bundle'){
      const outside=path.join(root,'outside');await rename(value.directory,outside);
      await symlink(outside,value.directory,process.platform==='win32'?'junction':'dir');
    }
    await inventory.refresh(value.workspace,value.root,'perf/results/vscode');
    const entry=inventory.options(value.workspace)[0];assert.equal(entry.unavailable,true);assert.match(entry.label,/unavailable/i);
    await assert.rejects(inventory.read(entry.id,value.workspace),/no longer available/);
  } finally {await rm(root,{recursive:true,force:true});}
});

let folder,values={};
const vscode={workspace:{isTrusted:true,get workspaceFolders(){return [folder];},getConfiguration:()=>({get:(key,fallback)=>values[key]??fallback})}};
const original=Module._load;Module._load=function(name,...args){return name==='vscode'?vscode:original.call(this,name,...args);};
let AdvisorChat;try{({AdvisorChat}=require('../dist/advisorChat.js'));}finally{Module._load=original;}
const context={workspaceState:{get:()=>undefined,update:async()=>{}}};
const select=value=>{folder={name:'Saved suite',uri:{scheme:'file',fsPath:value.root,toString:()=>value.workspace}};
  require('../dist/workspace-root.js').selectWorkspaceFolder([folder],folder);};

test('suite Send rejects a real legacy-shaped projection before any provider request and preserves source bytes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-suite-legacy-'));
  let chat;
  try {
    const value=await fixture(root),inventory=new SuiteChatEvidence();select(value);
    await inventory.refresh(value.workspace,root,'perf/results/vscode');const id=inventory.options(value.workspace)[0].id;
    values={advisorConfig:'',advisorEnabled:true,advisorProtocol:'mcp_http',advisorMcpTool:'ask',advisorMcpResponse:'text'};
    chat=new AdvisorChat(context,()=>inventory.options(value.workspace),key=>inventory.read(key,value.workspace));
    chat.recoverProposal=async()=>{};
    const calls=[],before=await readFile(path.join(value.directory,'integrity.json'));
    chat.invoke=async(_folder,config,request,command,bundle)=>{
      calls.push({config,request,command,bundle});assert.equal(chat.state().busy,true);
      // Core1.0.0 really returns this shape; it has no canonical measurement summaries.
      return {schema_version:'perfchecker-advice/1',recommendations:[],authority:'advisory_only',rules_version:'1'};
    };
    chat.clear(id);assert.deepEqual(calls,[],'Selecting saved evidence launches no worker or provider');
    await assert.rejects(chat.send('Explain the saved suite.',id),/Core 1\.0\.0.*No measurements were sent/);
    assert.equal(calls.length,1);assert.equal(calls[0].command,'advise');assert.equal(calls[0].bundle,value.directory);
    assert.deepEqual(calls[0].config,{});assert.equal(calls[0].request,undefined);
    assert.equal(chat.state().busy,false);assert.deepEqual(chat.state().messages,[]);
    assert.deepEqual(await readFile(path.join(value.directory,'integrity.json')),before);
  } finally {chat?.dispose();await rm(root,{recursive:true,force:true});}
});

test('Cancel retires the real suite projection worker before any MCP request',{timeout:10000},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-suite-cancel-'));
  let chat,child,request,started;
  const ready=new Promise(resolve=>{started=resolve;}),executions=[];
  const source=require.resolve('../dist/advisorChat.js'),cached=require.cache[source];delete require.cache[source];
  try {
    const value=await fixture(root),inventory=new SuiteChatEvidence();select(value);
    await writeFile(path.join(root,'Project.toml'),'name="SuiteProjectionFixture"\n');
    await inventory.refresh(value.workspace,root,'perf/results/vscode');
    values={juliaExecutable:'suite-projection-fixture',runnerProject:root,advisorConfig:'',advisorEnabled:true,
      advisorProtocol:'mcp_http',advisorMcpTool:'ask',advisorMcpResponse:'text'};
    const load=Module._load;Module._load=function(name,...args){
      if(name==='vscode')return vscode;
      if(name==='node:child_process')return {...require('child_process'),spawn:(executable,argv,options)=>{
        if(executable!=='suite-projection-fixture')return spawn(executable,argv,options);
        executions.push(argv);assert(argv.includes('advise'));assert(argv.includes('--source='+value.directory));
        assert(!argv.some(arg=>arg.startsWith('--advisor-config=')),'A local projection receives no provider configuration');
        child=spawn(process.execPath,['-e','process.stdin.setEncoding("utf8");process.stdin.on("data",text=>{if(text.includes("PERFCHECKER_CANCEL/1"))setTimeout(()=>process.exit(130),20);});process.stdout.write("ready\\n");setInterval(()=>{},1000)'],options);
        child.stdout.once('data',started);return child;
      }};
      return load.call(this,name,...args);
    };
    let ProjectionChat;try{({AdvisorChat:ProjectionChat}=require('../dist/advisorChat.js'));}finally{Module._load=load;}
    chat=new ProjectionChat(context,()=>inventory.options(value.workspace),id=>inventory.read(id,value.workspace));chat.recoverProposal=async()=>{};
    const id=inventory.options(value.workspace)[0].id;chat.clear(id);
    request=chat.send('Cancel before any measurement is sent.',id);
    const outcome=request.then(()=>({passed:true}),error=>({error}));
    await Promise.race([ready,outcome.then(value=>{throw value.error??new Error('Projection must remain active until Cancel');})]);
    assert.equal(chat.state().busy,true);process.kill(child.pid,0);
    chat.cancel();const result=await outcome;
    assert.match(result.error?.message??'',/cancelled after local worker cleanup/i);
    assert.equal(child.exitCode,130);assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
    assert.equal(executions.length,1,'No chat/provider worker follows the cancelled local projection');
    assert.equal(chat.state().busy,false);assert.deepEqual(chat.state().messages,[]);
  } finally {
    chat?.dispose();await request?.catch(()=>{});
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));}
    if(cached)require.cache[source]=cached;else delete require.cache[source];
    await rm(root,{recursive:true,force:true});
  }
});

// Actual candidate Core + controlled HTTP MCP integration, supplied explicitly
// by qualification. Use the real Oxygen 1.10.2/1.11.0 plain_benchmark reports at
// outputs/perfchecker-oxygen-plain-live-0LSgpU, with their original bundle. This
// test never measures or writes them; the HTTP reply is not an agent dialogue.
const julia=process.env.PERFCHECKER_TEST_JULIA,project=process.env.PERFCHECKER_TEST_JULIA_PROJECT;
const suiteWorkspace=process.env.PERFCHECKER_TEST_SUITE_WORKSPACE,suiteReports=process.env.PERFCHECKER_TEST_SUITE_REPORTS;
test('real candidate Core projects the original Oxygen suite bundle into controlled HTTP MCP',
  {skip:!julia||!project||!suiteWorkspace||!suiteReports,timeout:240000},async t=>{
    const value={root:suiteWorkspace,workspace:pathToFileURL(suiteWorkspace).href};select(value);
    const inventory=new SuiteChatEvidence();await inventory.refresh(value.workspace,value.root,suiteReports);
    const entry=inventory.options(value.workspace)[0];assert(entry&&!entry.unavailable,'Qualification supplies a real saved suite bundle');
    const source=await inventory.read(entry.id,value.workspace);
    const manifest=JSON.parse(await readFile(path.join(source.directory,'manifest.json')));
    assert.equal(manifest.suite,'oxygen_http_features');
    const suite=JSON.parse(await readFile(path.join(source.reports,'suite-result.json')));
    assert.deepEqual(suite.runs.map(run=>[run.feature,run.version]).sort(),
      [['plain_benchmark','1.10.2'],['plain_benchmark','1.11.0']]);
    const documents=['manifest.json','measurement-definitions.json','observations.jsonl','diagnostics.jsonl','artifacts.json','integrity.json'];
    const sourceHashes=async()=>Promise.all(documents.map(async name=>[name,hash(await readFile(path.join(source.directory,name)))]));
    const before=await sourceHashes();
    const calls=[],providerErrors=[],sockets=new Set();let projection,chat;
    const server=http.createServer(async(request,response)=>{
      try {
        let bytes='';for await(const data of request)bytes+=data;
        const body=JSON.parse(bytes);calls.push(body);response.setHeader('content-type','application/json');
        if(body.method==='notifications/initialized'){response.writeHead(202);response.end();return;}
        let result={};
        if(body.method==='initialize')result={protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'Controlled suite evidence qualification',version:'1'}};
        if(body.method==='tools/list')result={tools:[{name:'ask',inputSchema:{type:'object',properties:{prompt:{type:'string'}},required:['prompt']}}]};
        if(body.method==='tools/call'){
          const payload=JSON.parse(body.params.arguments.prompt.split('\n\nPerfChecker evidence:\n').at(-1));
          assert(projection,'The local projection finished before any provider call');
          const measurements=payload.evidence.filter(row=>row.kind==='measurement');assert(measurements.length>0);
          assert.deepEqual([...new Set(projection.measurement_summaries.map(row=>row.unit))].sort(),['1','By','ns']);
          for(const row of measurements){
            const saved=projection.measurement_summaries.find(item=>item.id===row.id);assert(saved);
            for(const [key,value]of Object.entries(row))assert.deepEqual(value,saved[key],`Canonical ${key} is preserved`);
            for(const key of ['metric','unit','measurement_definition','collector','scope','aggregation','correctness','bundle_status'])
              assert.equal(row[key],saved[key],`Canonical qualification ${key} is present`);
          }
          assert.equal([...JSON.stringify(payload.evidence)].length<=12000,true);
          assert(!body.params.arguments.prompt.includes(source.directory),'No bundle path or raw source is sent');
          result={content:[{type:'text',text:'Controlled transport reply; no inference or measured improvement claimed.'}]};
        }
        response.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
      } catch(error){providerErrors.push(error);response.statusCode=500;response.end(JSON.stringify({error:String(error)}));}
    });
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      values={juliaExecutable:julia,runnerProject:project,advisorConfig:'',advisorEnabled:true,advisorProtocol:'mcp_http',
        advisorMcpTool:'ask',advisorMcpResponse:'text',advisorEndpoint:`http://127.0.0.1:${server.address().port}/mcp`,advisorTimeout:120};
      chat=new AdvisorChat(context,()=>inventory.options(value.workspace),id=>inventory.read(id,value.workspace));chat.recoverProposal=async()=>{};
      const invoke=chat.invoke.bind(chat);chat.invoke=async(...args)=>{const result=await invoke(...args);if(args[3]==='advise')projection=result;return result;};
      chat.clear(entry.id);assert.deepEqual(calls,[]);
      await chat.send('Compare only these saved quantities and explain their qualification.',entry.id);
      assert.deepEqual(providerErrors,[]);
      assert.equal(calls.filter(call=>call.method==='tools/call').length,1);
      assert.equal(chat.state().busy,false);assert.equal(chat.state().messages.length,2);
      assert.deepEqual(await sourceHashes(),before,'All original protocol documents remain byte-exact');
      t.diagnostic(JSON.stringify({runId:source.runId,measurementSummaries:projection.measurement_summaries.length,
        actualMcpCall:true,noRemeasurement:true,provider:'controlled HTTP fixture; no inference',allProtocolBytesUnchanged:true}));
    } finally {chat?.dispose();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
  });

// This separate integration uses an explicitly supplied, already resolved
// General1.0.0 controller. It is not native-host coverage and installs nothing.
const legacyProject=process.env.PERFCHECKER_TEST_LEGACY_JULIA_PROJECT;
test('real registered Core1.0.0 refuses the original Oxygen suite before any provider request',
  {skip:!julia||!legacyProject||!suiteWorkspace||!suiteReports,timeout:240000},async t=>{
    const value={root:suiteWorkspace,workspace:pathToFileURL(suiteWorkspace).href};select(value);
    const inventory=new SuiteChatEvidence();await inventory.refresh(value.workspace,value.root,suiteReports);
    const entry=inventory.options(value.workspace)[0];assert(entry&&!entry.unavailable);
    const source=await inventory.read(entry.id,value.workspace);
    assert.equal(JSON.parse(await readFile(path.join(source.directory,'manifest.json'))).suite,'oxygen_http_features');
    const suite=JSON.parse(await readFile(path.join(source.reports,'suite-result.json')));
    assert.deepEqual(suite.runs.map(run=>[run.feature,run.version]).sort(),[['plain_benchmark','1.10.2'],['plain_benchmark','1.11.0']]);
    const documents=['manifest.json','measurement-definitions.json','observations.jsonl','diagnostics.jsonl','artifacts.json','integrity.json'];
    const sourceHashes=async()=>Promise.all(documents.map(async name=>[name,hash(await readFile(path.join(source.directory,name)))]));
    const controllerHashes=async()=>Promise.all(['Project.toml','Manifest.toml'].map(async name=>[name,hash(await readFile(path.join(legacyProject,name)))]));
    const before=await sourceHashes(),controllerBefore=await controllerHashes();
    const actual=await promisify(execFile)(julia,['--startup-file=no',`--project=${legacyProject}`,'-e',
      'using PerfChecker,Pkg; info=Pkg.dependencies()[Base.PkgId(PerfChecker).uuid]; PerfChecker.JSON.print(Dict("version"=>string(Base.pkgversion(PerfChecker)),"tree"=>string(info.tree_hash),"registered"=>info.is_tracking_registry))'],
      {windowsHide:true,timeout:180000,env:{...process.env,JULIA_LOAD_PATH:'@'+path.delimiter+'@stdlib'}});
    const provenance=JSON.parse(actual.stdout);
    assert.deepEqual(provenance,{version:'1.0.0',tree:'7af0cc74194b953c5e998efd7523f0c5f455e395',registered:true});
    // An actual endpoint catches even initialization/discovery, not just tools/call.
    const requests=[],sockets=new Set();let chat,projection;const commands=[];
    const server=http.createServer((request,response)=>{requests.push(request.url);request.resume();response.writeHead(500);response.end('No provider contact is permitted for this legacy projection.');});
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      values={juliaExecutable:julia,runnerProject:legacyProject,advisorConfig:'',advisorEnabled:true,advisorProtocol:'mcp_http',
        advisorMcpTool:'ask',advisorMcpResponse:'text',advisorEndpoint:`http://127.0.0.1:${server.address().port}/mcp`,advisorTimeout:120};
      chat=new AdvisorChat(context,()=>inventory.options(value.workspace),id=>inventory.read(id,value.workspace));chat.recoverProposal=async()=>{};
      const invoke=chat.invoke.bind(chat);chat.invoke=async(...args)=>{
        commands.push(args[3]);assert.equal(args[3],'advise','No chat/provider worker is launched');
        assert.deepEqual(args[1],{});assert.equal(args[2],undefined);assert.equal(args[4],source.directory);
        projection=await invoke(...args);return projection;
      };
      chat.clear(entry.id);assert.deepEqual(commands,[]);assert.deepEqual(requests,[]);
      await assert.rejects(chat.send('Explain only this unchanged saved Oxygen suite.',entry.id),/Core 1\.0\.0.*No measurements were sent/);
      assert.deepEqual(commands,['advise']);assert.equal(projection.schema_version,'perfchecker-advice/1');
      assert(Array.isArray(projection.recommendations));assert.equal(Object.hasOwn(projection,'measurement_summaries'),false);
      assert.deepEqual(requests,[]);assert.equal(chat.state().busy,false);assert.deepEqual(chat.state().messages,[]);
      assert.deepEqual(await sourceHashes(),before);assert.deepEqual(await controllerHashes(),controllerBefore);
      t.diagnostic(JSON.stringify({core:provenance,runId:source.runId,realCliAdvise:true,canonicalSummariesAvailable:false,
        explicitRefusalBeforeProvider:true,providerRequests:0,originalProtocolBytesUnchanged:true,controllerBytesUnchanged:true,
        scope:'CLI integration; not native-host coverage or successful measurement transmission'}));
    }finally{chat?.dispose();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
  });
