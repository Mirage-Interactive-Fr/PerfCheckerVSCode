import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,mkdir,realpath as fsRealpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PassThrough} from 'node:stream';
const require=createRequire(import.meta.url),execute=promisify(execFile);
const client=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const product=()=>({
  ...require(path.join(process.env.PERFCHECKER_TEST_EXTENSION_PATH||client,'dist','codexConnector.js')),
  ...require(path.join(process.env.PERFCHECKER_TEST_EXTENSION_PATH||client,'dist','implementation.js')),
});
// Read-only status observations must not refresh Git's index stat cache after restore.
const git=async(root,...args)=>(await execute('git',args,{cwd:root,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;

// Passive test-only observation of the real connector's JSONL. No command,
// assistant text, error body, token, environment or tool argument is retained.
export function observeCodexEvents(stream,identity,record){
  const began=Date.now(),types=new Set(['thread.started','turn.started','turn.completed','turn.failed','item.started','item.updated','item.completed','error']);
  const itemTypes=new Set(['agent_message','reasoning','command_execution','file_change','mcp_tool_call','web_search','todo_list']);
  const statuses=new Set(['in_progress','completed','failed','pending']);
  let pending='',bytes=0,count=0,unknown=false;
  const emit=value=>{if(count<2000){count++;record({...identity,elapsedMs:Date.now()-began,...value});}};
  const uncertain=reason=>{if(!unknown){unknown=true;emit({observation:'unknown',reason});}};
  const consume=line=>{
    if(!line.trim())return;
    let value;try{value=JSON.parse(line);}catch{uncertain('invalid-jsonl');return;}
    if(!value||!types.has(value.type)){uncertain('unrecognized-event-type');return;}
    const item=value.item;
    emit({event:value.type,...(item&&typeof item==='object'?{
      itemType:itemTypes.has(item.type)?item.type:'unknown',
      ...(typeof item.id==='string'&&/^item_\d{1,12}$/.test(item.id)?{itemId:item.id}:{}),
      ...(statuses.has(item.status)?{status:item.status}:{}),
      ...(Number.isSafeInteger(item.exit_code)?{exitCode:item.exit_code}:{})}:{}),
      ...(Number.isSafeInteger(value.error?.code)?{errorCode:value.error.code}:{})});
  };
  const data=chunk=>{
    if(unknown&&bytes>2_000_000)return;
    bytes+=Buffer.byteLength(chunk);
    if(bytes>2_000_000||count>=1999){uncertain('observation-budget');pending='';return;}
    pending+=String(chunk);let newline;
    while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);consume(line);}
    if(pending.length>65536){uncertain('unterminated-event-budget');pending='';}
  };
  const end=()=>{if(pending.trim())consume(pending);pending='';};
  stream.on('data',data);stream.once('end',end);
  return ()=>{stream.off('data',data);stream.off('end',end);if(pending.trim())uncertain('detached-mid-event');pending='';};
}

if(process.env.PERFCHECKER_CODEX_HOST_ONLY!=='1')test('passive CLI observation retains only whitelisted state and preserves the original stream',async()=>{
  const stream=new PassThrough(),events=[],original=[];
  const primary=value=>original.push(value.toString());stream.on('data',primary);
  const stop=observeCodexEvents(stream,{pid:123,start:'456',parent:1},value=>events.push(value));
  const raw=JSON.stringify({type:'item.completed',item:{type:'command_execution',id:'item_7',status:'completed',exit_code:3,
    command:'DO NOT RETAIN secret command',aggregated_output:'DO NOT RETAIN secret output'},token:'DO NOT RETAIN token'})+'\n';
  stream.write(raw.slice(0,10));stream.write(raw.slice(10));
  stream.write(JSON.stringify({type:'item.updated',item:{type:'agent_message',text:'DO NOT RETAIN secret assistant'}})+'\n');
  stream.write('{invalid DO NOT RETAIN secret}\n');
  stop();assert(stream.listeners('data').includes(primary));stream.end('after-detach');
  await new Promise(resolve=>stream.once('end',resolve));
  assert.equal(original[0]+original[1],raw);assert.equal(original.at(-1),'after-detach');
  assert.equal(events[0].exitCode,3);assert.equal(events[0].itemId,'item_7');assert.equal(events[0].pid,123);
  assert.equal(events[1].itemType,'agent_message');assert.equal(events[2].observation,'unknown');
  assert(!JSON.stringify(events).includes('DO NOT RETAIN'));assert(!JSON.stringify(events).includes('secret'));
});

if(process.env.PERFCHECKER_CODEX_HOST_ONLY!=='1')test('passive CLI diagnostic overflows are explicit and bounded',()=>{
  const stream=new PassThrough(),events=[],stop=observeCodexEvents(stream,{pid:1,start:'2'},value=>events.push(value));
  stream.write('x'.repeat(65537));stream.write('x'.repeat(2_000_001));stop();stream.destroy();
  assert.equal(events.length,1);assert.equal(events[0].observation,'unknown');assert.equal(events[0].reason,'unterminated-event-budget');
});

export async function ownedProcessState(pid) {
  try{
    const stat=await readFile(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/);
    return fields[0]==='Z'?undefined:{pid,parent:Number(fields[1]),group:Number(fields[2]),start:fields[19]};
  }catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return undefined;throw error;}
}

// Failure teardown only. Recorded start times and ancestry protect unrelated processes;
// a private process group is signalled only while its recorded leader still owns it.
export async function stopObservedCodexProcesses(records) {
  const live=async()=>{
    const result=[];for(const record of records)if((await ownedProcessState(record.pid))?.start===record.start)result.push(record);
    return result;
  };
  const signal=async(record,value)=>{
    const current=await ownedProcessState(record.pid);if(current?.start!==record.start)return;
    assert(current.parent===record.parent||(current.parent===1&&!await ownedProcessState(record.parent)),
      'Refuse failure teardown when the observed process ancestry has changed');
    try{process.kill(current.group===record.pid?-record.pid:record.pid,value);}catch(error){if(error.code!=='ESRCH')throw error;}
  };
  for(const record of [...records].reverse())await signal(record,'SIGTERM');
  let until=Date.now()+2000;while((await live()).length&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));
  for(const record of (await live()).reverse())await signal(record,'SIGKILL');
  until=Date.now()+5000;while((await live()).length&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal((await live()).length,0,'Observed owned processes must be dead before deleting the temporary fixture');
}

export async function probeJuliaCodexFixture(directory,julia) {
  const code='include("src/PerfCheckerNativeFixture.jl"); score=PerfCheckerNativeFixture.sum_squares; @assert score(Float64[])==0.0;@assert score([1.0,-2.0,3.0])==14.0;xs=collect(1.0:1000.0);score(xs);@assert score(xs)==333833500.0;println(@allocated score(xs))';
  const bytes=Number((await execute(julia,['--startup-file=no','--history-file=no','-e',code],{cwd:directory,timeout:60000})).stdout.trim());
  assert(Number.isFinite(bytes)&&bytes>=0,'The actual Julia allocation oracle returns bytes');return bytes;
}

// Opt-in real-package oracle. Every process loads the requested checkout itself;
// none of its expectations are generated by the proposed implementation.
export async function probeBibliographyCodexFixture(directory,julia,{prepare=false,signal}={}) {
  const project=path.join(directory,'perf','episode-05a','worker');
  const code=`using Pkg, TOML, SHA, Base64
    ${prepare?'Pkg.instantiate(;update_registry=false,allow_autoprecomp=false)':''}
    using Bibliography, BenchmarkTools, Chairmarks, BibInternal, BibParser
    expected=realpath(pwd())
    @assert realpath(pkgdir(Bibliography))==expected
    @assert realpath(pathof(Bibliography))==realpath(joinpath(expected,"src","Bibliography.jl"))
    @assert Base.pkgversion(BenchmarkTools)==v"1.7.0"
    @assert Base.pkgversion(Chairmarks)==v"1.3.1"
    manifest=TOML.parsefile(joinpath(dirname(Base.active_project()),"Manifest.toml"))["deps"]
    @assert only(manifest["BibInternal"])["repo-rev"]=="792d8c709169505f998f7d70bfa092551dd4089f"
    @assert only(manifest["BibParser"])["repo-rev"]=="cf1eb4446b986a23ed444963dcdb4c6ecc2da90f"
    include("perf/episode-05a/correctness.jl")
    include("perf/media/export-workload.jl")
    state=perf_setup(); output=perf_workload(state)
    @assert perf_oracle(state,output)["status"]=="passed"
    name=Bibliography.BibInternal.Name("von","Neumann","Jr","John","Ludwig")
    Bibliography.name_to_string(name)
    bytes=@allocated Bibliography.name_to_string(name)
    graph=sort!([join([name,get(dep,"uuid",""),get(dep,"version",""),get(dep,"git-tree-sha1",""),get(dep,"repo-rev","")],"|") for (name,entries) in manifest for dep in entries])
    fields=[expected,realpath(pathof(Bibliography)),string(bytes),string(Base.pkgversion(BenchmarkTools)),string(Base.pkgversion(Chairmarks)),
      only(manifest["BibInternal"])["repo-rev"],only(manifest["BibParser"])["repo-rev"],bytes2hex(sha256(join(graph,"\\n"))),
      bytes2hex(sha256(read("perf/episode-05a/correctness.jl"))),bytes2hex(sha256(read("perf/media/export-workload.jl"))),
      bytes2hex(sha256(read("src/bibtex.jl"))),bytes2hex(sha256(read(Base.active_project()))),
      bytes2hex(sha256(read(joinpath(dirname(Base.active_project()),"Manifest.toml"))))]
    println("PERFCHECKER_BIBLIOGRAPHY_ORACLE/1\\t",join(base64encode.(fields),"\\t"))`;
  const {stdout}=await execute(julia,['--startup-file=no','--history-file=no','--threads=2','--gcthreads=1',`--project=${project}`,'-e',code],
    {cwd:directory,timeout:180000,maxBuffer:4_000_000,signal});
  const marker=stdout.split('\n').find(line=>line.startsWith('PERFCHECKER_BIBLIOGRAPHY_ORACLE/1\t'));
  assert(marker,'The independent real-package oracle must emit its source and dependency identities');
  const fields=marker.split('\t').slice(1).map(value=>Buffer.from(value,'base64').toString('utf8'));
  assert.equal(fields.length,13);assert.equal(fields[0],await fsRealpath(directory));
  const [root,entrypoint,allocationBytes,benchmarkTools,chairmarks,bibInternalRevision,bibParserRevision,dependencyGraphSha256,
    correctnessSha256,workloadSha256,sourceSha256,projectSha256,manifestSha256]=fields;
  assert(Number.isFinite(Number(allocationBytes))&&Number(allocationBytes)>=0);
  return {root,entrypoint,allocationBytes:Number(allocationBytes),benchmarkTools,chairmarks,bibInternalRevision,bibParserRevision,
    dependencyGraphSha256,correctnessSha256,workloadSha256,sourceSha256,projectSha256,manifestSha256,independentNameCases:10,
    independentExportChecks:true,historicalOraclePassed:true};
}

export async function prepareBibliographyCodexFixture(root,{julia,project,coreTree,signal}) {
  const probe=await probeBibliographyCodexFixture(root,julia,{prepare:true,signal});
  const fixtureGit=(...args)=>execute('git',args,{cwd:root,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},timeout:60000,signal});
  await fixtureGit('config','user.name','PerfChecker qualification');await fixtureGit('config','user.email','qualification@example.invalid');
  await fixtureGit('add','.');await fixtureGit('commit','-m','Private Bibliography MCP qualification fixture');
  const core=JSON.parse((await execute(julia,['--startup-file=no',`--project=${project}`,'-e',
    `using PerfChecker,Pkg,HTTP,SHA
    info=Pkg.dependencies()[Base.PkgId(PerfChecker).uuid]
    project=realpath(Base.active_project()); manifest=realpath(joinpath(dirname(project),"Manifest.toml"))
    PerfChecker.JSON.print(Dict("uuid"=>string(Base.PkgId(PerfChecker).uuid),"version"=>string(Base.pkgversion(PerfChecker)),
      "tree"=>bytes2hex(Pkg.GitTools.tree_hash(pkgdir(PerfChecker))),"registered"=>info.is_tracking_registry,"http"=>string(Base.pkgversion(HTTP)),
      "project"=>project,"root"=>realpath(pkgdir(PerfChecker)),"entrypoint"=>realpath(pathof(PerfChecker)),"manifest"=>manifest,
      "projectSha256"=>bytes2hex(sha256(read(project))),"manifestSha256"=>bytes2hex(sha256(read(manifest)))))`],{timeout:60000,signal})).stdout);
  assert.equal(core.uuid,'6309bf6b-a531-4b08-891e-8ee981e5c424');assert.equal(core.version,'1.0.1');assert.equal(core.tree,coreTree);
  assert.equal(core.registered,true,'The real-package demo loads published General Core, without a Git or path override');
  assert.equal(core.project,await fsRealpath(path.join(project,'Project.toml')),'Probe the requested dedicated controller');
  assert.equal(core.manifest,await fsRealpath(path.join(project,'Manifest.toml')));
  assert.equal(core.entrypoint,await fsRealpath(path.join(core.root,'src','PerfChecker.jl')),'The loaded module belongs to the tree-hashed Core');
  for(const [file,expected] of [[core.project,core.projectSha256],[core.manifest,core.manifestSha256]])
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),expected,'Retain hashes of the actual controller dependency files');
  return {kind:'bibliography',relative:'src/bibtex.jl',core,baselineBytes:probe.allocationBytes,probe};
}

// Shared by the CLI and installed-VSIX hosts: the same real Julia source and oracle.
export async function prepareJuliaCodexFixture(root,{julia,project,coreTree,coreVersion='1.0.0'}) {
  const relative='src/PerfCheckerNativeFixture.jl',file=path.join(root,relative);
  const source='module PerfCheckerNativeFixture\nBase.@noinline sum_squares(xs) = sum(xs .^ 2)\nend\n';
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);
  await git(root,'init');await git(root,'config','user.name','PerfChecker qualification');await git(root,'config','user.email','qualification@example.invalid');
  await git(root,'add','.');await git(root,'commit','-m','Sacrificial Julia allocation fixture');
  const index=await readFile(path.join(root,'.git','index')),head=await git(root,'rev-parse','HEAD');
  const probe=directory=>probeJuliaCodexFixture(directory,julia);
  const baselineBytes=await probe(root);assert(baselineBytes>0);
  const core=JSON.parse((await execute(julia,['--startup-file=no',`--project=${project}`,'-e','using PerfChecker,Pkg; info=Pkg.dependencies()[Base.PkgId(PerfChecker).uuid]; PerfChecker.JSON.print(Dict("uuid"=>string(Base.PkgId(PerfChecker).uuid),"version"=>string(Base.pkgversion(PerfChecker)),"tree"=>bytes2hex(Pkg.GitTools.tree_hash(pkgdir(PerfChecker))),"registered"=>info.is_tracking_registry))'],{timeout:60000})).stdout);
  assert.equal(core.uuid,'6309bf6b-a531-4b08-891e-8ee981e5c424');assert.equal(core.version,coreVersion);
  assert.equal(core.tree,coreTree??'7af0cc74194b953c5e998efd7523f0c5f455e395');
  if(!coreTree)assert.equal(core.registered,true);
  return {relative,file,source,index,head,probe,baselineBytes,core};
}

// Opt-in named-agent qualification; it uses the user's existing CLI account and model quota.
if(process.env.PERFCHECKER_CODEX_HOST_ONLY!=='1')test('real authenticated Codex through local MCP: two advice turns, isolated edits, verified diff, apply, restore, cancel and disconnect',
  {skip:!process.env.PERFCHECKER_TEST_CODEX,timeout:300000},async()=>{
    const {CodexConnector,inspectCodex,createImplementationCheckout,applyImplementation}=product();
    const root=await mkdtemp(path.join(tmpdir(),'perfchecker-codex-real-'));
    const requests=await mkdtemp(path.join(tmpdir(),'perfchecker-codex-requests-'));
    let connector,checkout;
    try{
      await git(root,'init');await git(root,'config','user.name','PerfChecker qualification');await git(root,'config','user.email','qualification@example.invalid');
      const source='exports.sumSquares = values => values.map(value => value * value).reduce((sum, value) => sum + value, 0);\n';
      await writeFile(path.join(root,'source.cjs'),source);await git(root,'add','.');await git(root,'commit','-m','Sacrificial allocation fixture');
      const index=await readFile(path.join(root,'.git','index')),head=await git(root,'rev-parse','HEAD');
      const version=await inspectCodex(process.env.PERFCHECKER_TEST_CODEX,root);
      connector=await new CodexConnector({cli:process.env.PERFCHECKER_TEST_CODEX,root,timeoutMs:120000}).start();
      const call=async(method,params,signal)=>{
        const response=await fetch(connector.endpoint,{method:'POST',signal,headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',
          Authorization:`Bearer ${connector.token}`,'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':params.name}:{})},
          body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28',
            'io.modelcontextprotocol/clientInfo':{name:'PerfChecker authenticated qualification',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
        const result=(await response.json()).result;assert.ok(!result.isError,result.content?.[0]?.text);return result;
      };
      assert((await call('server/discover')).supportedVersions.includes('2026-07-28'));assert.equal((await call('tools/list')).tools.length,2);
      const juliaProject=process.env.PERFCHECKER_TEST_JULIA_PROJECT;
      const julia=process.env.PERFCHECKER_TEST_JULIA||'julia';
      const juliaEnvironment={...process.env,PERFCHECKER_UUID:'6309bf6b-a531-4b08-891e-8ee981e5c424'};
      let coreVersion;
      if(juliaProject){
        const metadata=JSON.parse((await execute(julia,['--startup-file=no',`--project=${juliaProject}`,'-e',
          'using PerfChecker, Pkg; PerfChecker.JSON.print(Dict("version"=>string(Base.pkgversion(PerfChecker)),"tree"=>bytes2hex(Pkg.GitTools.tree_hash(dirname(dirname(pathof(PerfChecker)))))))'],{env:juliaEnvironment})).stdout);
        assert.equal(metadata.version,'1.0.0');assert.equal(metadata.tree,'7af0cc74194b953c5e998efd7523f0c5f455e395');coreVersion=metadata.version;
      }
      const invoke=async(command,messages,workspace)=>{
        const sourceFile=path.join(requests,'request.json'),configFile=path.join(requests,'advisor.json');
        await writeFile(sourceFile,JSON.stringify({messages,...(workspace?{workspace}:{})}),{mode:0o600});
        await writeFile(configFile,JSON.stringify({protocol:'mcp_http',endpoint:connector.endpoint,model:'Codex CLI',timeout:120,
          mcp_tool:command==='implement'?'implement_perfchecker':'ask_perfchecker',mcp_prompt_argument:'prompt',mcp_arguments:{},mcp_response:'text',
          mcp_version:'2026-07-28',api_key_env:connector.keyEnvironment,allow_remote:false}),{mode:0o600});
        const output=await execute(julia,['--startup-file=no',`--project=${juliaProject}`,'-e','using PerfChecker; exit(perfchecker_main(ARGS))','--',
          command,`--source=${sourceFile}`,`--advisor-config=${configFile}`,`--project=${juliaProject}`],{cwd:root,env:juliaEnvironment,timeout:180000,maxBuffer:2000000});
        const result=JSON.parse(output.stdout);assert.equal(result.status,'complete');
        assert.equal(result.message_count,messages.length);assert.equal(result.advisor_mode,command==='implement'?'implementation':'advice');
        if(command==='implement')assert.equal(result.implementation_status,'requires_diff_review');
        return {content:[{type:'text',text:result.external_review}]};
      };
      const question=`No tools or commands. Give concise advice for removing the intermediate array from this JavaScript function while preserving empty-array behavior and numeric results: ${source}`;
      const conversation=[{role:'user',content:question}];
      const advice=juliaProject?await invoke('chat',conversation):await call('tools/call',{name:'ask_perfchecker',arguments:{prompt:question}});
      assert.ok(advice.content[0].text.length>10);assert.equal(await readFile(path.join(root,'source.cjs'),'utf8'),source);assert.equal(await git(root,'status','--porcelain'),'');
      const followupQuestion='Before implementing, what correctness checks should I run for empty inputs, negative numbers, floating-point numbers, NaN, Infinity and sparse arrays? Distinguish a possible allocation reduction from an unmeasured speedup. No tools, commands or file changes.';
      conversation.push({role:'assistant',content:advice.content[0].text},{role:'user',content:followupQuestion});
      const followup=juliaProject?await invoke('chat',conversation):await call('tools/call',{name:'ask_perfchecker',arguments:{prompt:`Continue this bounded advice conversation without tools, commands or file changes. User: ${question}\nAssistant: ${advice.content[0].text}\nUser: ${followupQuestion}`}});
      assert.ok(followup.content[0].text.length>10);assert.equal(await readFile(path.join(root,'source.cjs'),'utf8'),source);assert.equal(await git(root,'status','--porcelain'),'');
      checkout=await createImplementationCheckout(root);
      const implementationQuestion=`Implement this reviewed advice in source.cjs only: remove the intermediate map array from sumSquares. Preserve CommonJS exports and JavaScript Array semantics, including skipping sparse holes. You may use only file editing and the Node executable ${process.execPath} for tests. Do not run Julia, install dependencies, create extra files or invoke external services. Test empty, positive, negative and floating-point values, NaN, Infinity and sparse arrays. Leave the source change for review.`;
      conversation.push({role:'assistant',content:followup.content[0].text},{role:'user',content:implementationQuestion});
      const summary=juliaProject?await invoke('implement',conversation,checkout.workspace):await call('tools/call',{name:'implement_perfchecker',arguments:{workspace:checkout.workspace,
        prompt:`${implementationQuestion} Advice: ${advice.content[0].text}. Reviewed validation: ${followup.content[0].text}.`}});
      const proposal=await checkout.collect();assert.deepEqual(proposal.files,['source.cjs']);assert.ok(proposal.patch);
      const verify=async(directory)=>execute(process.execPath,['-e',`const assert=require('node:assert/strict'),{sumSquares}=require('./source.cjs');const baseline=values=>values.map(value=>value*value).reduce((sum,value)=>sum+value,0);for(const values of [[],[1,2,3],[-2,3],[.5,-1.25],[-0],[NaN],[Infinity],Array(3),[,,2]])assert(Object.is(sumSquares(values),baseline(values)),JSON.stringify(values));`],{cwd:directory});
      await verify(checkout.workspace);
      assert.equal(await readFile(path.join(root,'source.cjs'),'utf8'),source);assert.deepEqual(await readFile(path.join(root,'.git','index')),index);
      await applyImplementation(proposal);await verify(root);assert.notEqual(await readFile(path.join(root,'source.cjs'),'utf8'),source);
      await applyImplementation(proposal,true);assert.equal(await readFile(path.join(root,'source.cjs'),'utf8'),source);assert.deepEqual(await readFile(path.join(root,'.git','index')),index);assert.equal(await git(root,'rev-parse','HEAD'),head);
      const controller=new AbortController();const cancelled=call('tools/call',{name:'ask_perfchecker',arguments:{prompt:'No tools. Explain how to validate an allocation improvement in detail.'}},controller.signal);
      const rejected=assert.rejects(cancelled,/abort|cancel|fetch/i);
      const deadline=Date.now()+10000;while(!connector.children.size&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
      assert.ok(connector.children.size);const child=[...connector.children][0];
      let events='';child.stdout.on('data',chunk=>{events+=chunk;});
      const turnDeadline=Date.now()+20000;while(!events.includes('turn.started')&&Date.now()<turnDeadline)await new Promise(resolve=>setTimeout(resolve,20));
      assert.ok(events.includes('turn.started'),'A real Codex turn must start before cancellation is qualified.');
      const endpoint=connector.endpoint;
      controller.abort();await rejected;await connector.dispose();connector=undefined;
      assert.ok(child.exitCode!==null||child.signalCode!==null);assert.equal(await readFile(path.join(root,'source.cjs'),'utf8'),source);
      await assert.rejects(fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(5000),body:'{}'}),/fetch|connect|abort/i);
      assert.equal(await git(root,'status','--porcelain'),'');assert.deepEqual(await readFile(path.join(root,'.git','index')),index);assert.equal(await git(root,'rev-parse','HEAD'),head);
      console.log(JSON.stringify({status:'passed',agent:version,transport:'MCP HTTP loopback',...(coreVersion?{coreVersion,worker:'registered PerfChecker Julia CLI'}:{}),checks:['two contextual advice turns leave source unchanged','isolated source edit','empty/signed/float/NaN/Infinity/sparse oracle','diff review','apply','restore bytes/index/HEAD','cancel live process','disconnect endpoint'],adviceCharacters:[advice.content[0].text.length,followup.content[0].text.length],summaryCharacters:summary.content[0].text.length,changedFiles:proposal.files}));
    }finally{await connector?.dispose();await checkout?.dispose();await rm(root,{recursive:true,force:true});await rm(requests,{recursive:true,force:true});}
  });

// Separate Julia-source proof: the earlier JavaScript test remains useful, but
// cannot qualify an agent's Julia edits or their actual allocation measurements.
if(process.env.PERFCHECKER_CODEX_HOST_ONLY!=='1')test('real Codex Julia implementation: measured sum_squares, contextual advice, isolated patch, oracles, apply and exact restore',
  {skip:!process.env.PERFCHECKER_TEST_CODEX_JULIA||!process.env.PERFCHECKER_TEST_CODEX||!process.env.PERFCHECKER_TEST_JULIA_PROJECT,timeout:360000},async()=>{
    const {CodexConnector,inspectCodex,createImplementationCheckout,applyImplementation}=product();
    const root=await mkdtemp(path.join(tmpdir(),'perfchecker-codex-julia-real-'));
    const requests=await mkdtemp(path.join(tmpdir(),'perfchecker-codex-julia-requests-'));
    const julia=process.env.PERFCHECKER_TEST_JULIA||'julia',project=process.env.PERFCHECKER_TEST_JULIA_PROJECT;
    let connector,checkout;
    try{
      const {relative,file,source,index,head,probe,baselineBytes,core}=await prepareJuliaCodexFixture(root,{julia,project,
        coreTree:process.env.PERFCHECKER_TEST_CORE_TREE,coreVersion:process.env.PERFCHECKER_TEST_CORE_VERSION||'1.0.0'});
      const version=await inspectCodex(process.env.PERFCHECKER_TEST_CODEX,root);
      connector=await new CodexConnector({cli:process.env.PERFCHECKER_TEST_CODEX,root,timeoutMs:150000}).start();
      const invoke=async(command,messages,workspace)=>{
        const request=path.join(requests,'request.json'),config=path.join(requests,'advisor.json');
        await writeFile(request,JSON.stringify({messages,...(workspace?{workspace}:{})}),{mode:0o600});
        await writeFile(config,JSON.stringify({protocol:'mcp_http',endpoint:connector.endpoint,model:'Codex CLI',timeout:150,mcp_tool:command==='implement'?'implement_perfchecker':'ask_perfchecker',
          mcp_prompt_argument:'prompt',mcp_arguments:{},mcp_response:'text',mcp_version:'2026-07-28',api_key_env:connector.keyEnvironment,allow_remote:false}),{mode:0o600});
        const result=JSON.parse((await execute(julia,['--startup-file=no',`--project=${project}`,'-e','using PerfChecker;exit(perfchecker_main(ARGS))','--',command,
          `--source=${request}`,`--advisor-config=${config}`,`--project=${project}`],{cwd:root,env:{...process.env,PERFCHECKER_UUID:'6309bf6b-a531-4b08-891e-8ee981e5c424'},timeout:210000,maxBuffer:2000000})).stdout);
        assert.equal(result.status,'complete');assert.equal(result.message_count,messages.length);
        if(command==='implement')assert.equal(result.implementation_status,'requires_diff_review');
        return result.external_review;
      };
      const messages=[{role:'user',content:`Give advice only, no commands or file changes. This Julia function was measured after warming on1000 Float64 inputs: ${baselineBytes} allocation bytes. What might remove the intermediate squared array, and what remains unmeasured? ${source}`}];
      const first=await invoke('chat',messages);assert(first.length>10);
      assert.equal(await readFile(file,'utf8'),source);assert.equal(await git(root,'status','--porcelain'),'');
      messages.push({role:'assistant',content:first},{role:'user',content:'Continue the same conversation. Specify checks for empty Float64 input, [1,-2,3], and1:1000. Expected results are0,14 and333833500. Distinguish an allocation reduction from a speed claim. Advice only, no tools or editing.'});
      const second=await invoke('chat',messages);assert(second.length>10);assert.equal(await readFile(file,'utf8'),source);
      checkout=await createImplementationCheckout(root);
      messages.push({role:'assistant',content:second},{role:'user',content:`Implement the reviewed allocation change ONLY in ${relative}, preserving its Julia module and @noinline API. Do not create extra files, install anything or call external services. Use the existing Julia executable ${julia} with --startup-file=no and -e to check empty Float64 input==0, [1.0,-2.0,3.0]==14 and collect(1.0:1000.0)==333833500. Warm the function then measure @allocated on1000 inputs. Leave the edit for diff review; do not claim timing improved.`});
      const summary=await invoke('implement',messages,checkout.workspace);assert(summary.length>10);
      const proposal=await checkout.collect();assert.deepEqual(proposal.files,[relative]);assert(proposal.patch.length>0);
      const candidateBytes=await probe(checkout.workspace);assert(candidateBytes<baselineBytes,'The actual Julia candidate reduces measured allocations');
      assert.equal(await readFile(file,'utf8'),source);assert.deepEqual(await readFile(path.join(root,'.git','index')),index);
      await applyImplementation(proposal);assert.equal(await probe(root),candidateBytes);assert.notEqual(await readFile(file,'utf8'),source);
      await applyImplementation(proposal,true);assert.equal(await readFile(file,'utf8'),source);assert.deepEqual(await readFile(path.join(root,'.git','index')),index);assert.equal(await git(root,'rev-parse','HEAD'),head);
      const abort=new AbortController();
      const pending=fetch(connector.endpoint,{method:'POST',signal:abort.signal,headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',
        Authorization:`Bearer ${connector.token}`,'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':'ask_perfchecker'},
        body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ask_perfchecker',arguments:{prompt:'Advice only, no tools: discuss the remaining uncertainty in this Julia sum_squares optimization in detail.'},
          _meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})});
      const rejected=assert.rejects(pending,/abort|cancel|fetch/i);
      const until=Date.now()+20000;while(!connector.children.size&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
      assert(connector.children.size>0);const child=[...connector.children][0];let events='';child.stdout.on('data',chunk=>events+=chunk);
      const turnDeadline=Date.now()+20000;while(!events.includes('turn.started')&&Date.now()<turnDeadline)await new Promise(resolve=>setTimeout(resolve,20));
      assert(events.includes('turn.started'),'Cancellation follows a real authenticated Codex turn');
      const endpoint=connector.endpoint;abort.abort();await rejected;await connector.dispose();connector=undefined;
      assert(child.exitCode!==null||child.signalCode!==null);await assert.rejects(fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(5000),body:'{}'}));
      assert.equal(await readFile(file,'utf8'),source);assert.deepEqual(await readFile(path.join(root,'.git','index')),index);assert.equal(await git(root,'rev-parse','HEAD'),head);assert.equal(await git(root,'status','--porcelain'),'');
      console.log(JSON.stringify({status:'passed',agent:version,core,source:'real Julia source through Core chat/implement and local MCP',adviceTurns:2,
        oracle:{empty:0,signed:14,range1000:333833500},allocationBaselineBytes:baselineBytes,allocationCandidateBytes:candidateBytes,
        isolatedDiff:true,apply:true,exactRestore:true,cancelRealTurn:true,disconnected:true,changedFiles:proposal.files}));
    }finally{await connector?.dispose();await checkout?.dispose();await rm(root,{recursive:true,force:true});await rm(requests,{recursive:true,force:true});}
  });
