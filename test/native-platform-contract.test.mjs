import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import readiness from './native-readiness.cjs';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {assertNativeCampaignSelection,nativePlatformContract,assertNativeJuliaArchitecture,nativeFullCasePartition,nativeFullFunctionalGroups,nativeWorkflowMatrix} from './native-platform-contract.mjs';

const {NATIVE_READINESS_MS,createNativeActivityBudget,waitForNativeAvailability}=readiness;

const historicalCases=['native-all-studio-controls','native-workbench-controls','native-investigation-controls',
  'native-investigation-limits','native-enabled-narrative-protocol','native-advisor-controls',
  'native-mcp-controls','native-pluto-controls','native-discovery-and-sync-after-pluto'];
const historicalPrefix=['controller-visible-in-studio','native-julia-terminal','native-pluto-without-jupyter',
  'native-suite-run-button','native-suite-save-palette','native-run-selection-command',
  'native-testitem-measurement','native-complete-suite-measurements'];

const arm={scope:'arm-bootstrap',event:'workflow_dispatch',artifact:'candidate',stage:'focused',
  group:'bootstrap',core:'general',arch:'arm64',runnerArch:'ARM64',expectedArch:'arm64'};

test('native ARM bootstrap requires the explicit production-General campaign',()=>{
  for(const platform of ['linux','darwin'])
    assert.deepEqual(nativePlatformContract({...arm,platform}),{node:'arm64',julia:'aarch64'});
  for(const change of [{event:'pull_request'},{artifact:'public'},{stage:'full'},
    {group:'pluto'},{core:'candidate'},{core:'general100'}])
    assert.throws(()=>assertNativeCampaignSelection({...arm,...change}));
  assert.throws(()=>nativePlatformContract({...arm,platform:'win32'}),/Linux and Apple Silicon/);
});

test('Rosetta and mismatched Node or runner architecture cannot qualify ARM',()=>{
  for(const change of [{arch:'x64'},{runnerArch:'X64'},{expectedArch:'x64'}])
    assert.throws(()=>nativePlatformContract({...arm,platform:'darwin',...change}));
  const contract=nativePlatformContract({...arm,platform:'linux'});
  for(const label of ['PerfChecker runtime','Official Julia runtime']) {
    assertNativeJuliaArchitecture({arch:'aarch64'},contract,label);
    assert.throws(()=>assertNativeJuliaArchitecture({arch:'x86_64'},contract,label),/native Julia architecture/);
    assert.throws(()=>assertNativeJuliaArchitecture({},contract,label),/native Julia architecture/);
  }
});

test('existing campaigns retain x64 and reject incidental ARM execution',()=>{
  for(const scope of ['all','linux','macos-stable']) {
    assert.deepEqual(nativePlatformContract({scope,platform:'linux',arch:'x64',runnerArch:'X64'}),
      {node:'x64',julia:'x86_64'});
    assert.throws(()=>nativePlatformContract({scope,platform:'linux',arch:'arm64'}),/native Node architecture/);
    assert.throws(()=>nativePlatformContract({scope,platform:'darwin',arch:'arm64',expectedArch:'arm64'}),/x64 contract/);
  }
});

test('seven functional groups preserve every historical case and shared prefix without mixing legacy partitions',()=>{
  assert.deepEqual(nativeFullFunctionalGroups.map(group=>group.id),
    ['studio','workbench','investigation','investigation-limits','narrative','advisor','mcp-pluto']);
  assert.deepEqual(nativeFullFunctionalGroups.flatMap(group=>group.cases),historicalCases);
  assert.equal(new Set(nativeFullFunctionalGroups.flatMap(group=>group.cases)).size,9);
  for(const platform of ['linux','win32','darwin'])for(const group of nativeFullFunctionalGroups){
    const partition=nativeFullCasePartition({partition:group.id,platform,arch:'x64',stage:'full',artifact:'candidate'});
    assert.deepEqual(partition.sharedPrefix,historicalPrefix);assert.deepEqual(partition.cases,group.cases);
  }
  assert.deepEqual(nativeFullFunctionalGroups.at(-1).cases,
    ['native-mcp-controls','native-pluto-controls','native-discovery-and-sync-after-pluto']);
});

test('historical Intel partitions remain separately reproducible with their original ordered union',()=>{
  const campaign={platform:'darwin',arch:'x64',stage:'full',artifact:'candidate'};
  const all=nativeFullCasePartition(campaign);
  const partitions=['measure','investigate','agentic'].map(partition=>nativeFullCasePartition({...campaign,partition}));
  assert.deepEqual(all.cases,historicalCases,'The independently enumerated historical tail must remain complete');
  assert.deepEqual(partitions.flatMap(partition=>partition.cases),historicalCases);
  assert.equal(new Set(all.cases).size,all.cases.length,'No full case is accidentally duplicated or lost');
  for(const partition of partitions)assert.deepEqual(partition.sharedPrefix,all.sharedPrefix);
  assert.deepEqual(partitions[2].cases.slice(-3),['native-mcp-controls','native-pluto-controls','native-discovery-and-sync-after-pluto'],
    'The MCP to Pluto to discovery/sync transition remains in one physical session');
});

test('the real host dispatches every advertised shared-prefix case before its partition',async()=>{
  const source=readFileSync(new URL('./public-vsix-host.cjs',import.meta.url),'utf8');
  const start=source.indexOf("await runCase('controller-visible-in-studio'");
  const end=source.indexOf("if (phase === 'configured'",start);
  assert(start>=0&&end>start,'The common prepared controller/terminal/Pluto path remains present');
  const calls=[],runCase=async name=>{calls.push(name);return true;};
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  // Execute only the actual dispatch path. Native callbacks are deliberately
  // not invoked here; their effects remain the responsibility of native CI.
  await new AsyncFunction('runCase','process',source.slice(start,end))(runCase,{env:{PERFCHECKER_NATIVE_MODE:'candidate'}});
  assert.deepEqual(calls,['controller-visible-in-studio','native-julia-terminal','native-pluto-without-jupyter']);
  const suiteStart=source.indexOf('async function runSuiteCases('),suiteEnd=source.indexOf('async function measureNativeTestItem(',suiteStart);
  assert(suiteStart>=0&&suiteEnd>suiteStart);
  const suite=Function('discoveryDiagnostic','NATIVE_READINESS_MS',`return (${source.slice(suiteStart,suiteEnd).trim()})`)(false,NATIVE_READINESS_MS);
  await suite({vscode:{Uri:{file:value=>value}},workspace:'/disposable-fixture'},runCase,{testItem:true,complete:true});
  assert.deepEqual(calls,historicalPrefix);
  assert.deepEqual(nativeFullCasePartition({artifact:'candidate'}).sharedPrefix,historicalPrefix);
  assert(source.includes("await runSuiteCases(context,runCase,{testItem:true,complete:process.env.PERFCHECKER_NATIVE_STAGE==='full'});"),
    'Every full prepared partition still dispatches both the native test item and the complete suite');
});

test('each real full dispatcher executes eight prefixes followed by only its functional tail in one context',async()=>{
  const source=readFileSync(new URL('./public-vsix-host.cjs',import.meta.url),'utf8');
  const prefixStart=source.indexOf("await runCase('controller-visible-in-studio'"),prefixEnd=source.indexOf("if (phase === 'configured'",prefixStart);
  const suiteStart=source.indexOf('async function runSuiteCases('),suiteEnd=source.indexOf('async function measureNativeTestItem(',suiteStart);
  const tailStart=source.indexOf("if (process.env.PERFCHECKER_NATIVE_STAGE === 'full'&&!discoveryDiagnostic) {");
  assert(prefixStart>=0&&prefixEnd>prefixStart&&suiteStart>=0&&suiteEnd>suiteStart&&tailStart>=0);
  let end=source.indexOf('{',tailStart),depth=1;
  while(depth&&++end<source.length){if(source[end]==='{')depth++;if(source[end]==='}')depth--;}
  assert.equal(depth,0);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const prefix=new AsyncFunction('runCase','process',source.slice(prefixStart,prefixEnd));
  const suite=Function('discoveryDiagnostic','NATIVE_READINESS_MS',`return (${source.slice(suiteStart,suiteEnd).trim()})`)(false,NATIVE_READINESS_MS);
  const tail=new AsyncFunction('process','discoveryDiagnostic','runCase','context','fullCasePartition','assert',
    'controls','workbench','investigations','require','advisor','mcp','pluto','vscode','waitForNativeAvailability',source.slice(tailStart,end+1));
  for(const platform of ['linux','win32','darwin'])for(const group of nativeFullFunctionalGroups){
    const calls=[],effects=[],context={vscode:{Uri:{file:value=>value}},workspace:'/disposable-fixture'};
    const noEffects=async name=>{calls.push(name);return true;};
    await prefix(noEffects,{env:{PERFCHECKER_NATIVE_MODE:'candidate'}});await suite(context,noEffects,{testItem:true,complete:true});
    const effect=name=>async actual=>{assert.equal(actual,context);effects.push(name);};
    const modules={
      './native-investigation-limits.cjs':{run:effect('native-investigation-limits')},
      './native-narrative-controls.cjs':{run:effect('native-enabled-narrative-protocol')}
    };
    const vscode={commands:{executeCommand:async command=>{effects.push(command);}}};
    await tail({env:{PERFCHECKER_NATIVE_STAGE:'full'}},false,async(name,run)=>{calls.push(name);await run();},context,
      nativeFullCasePartition({partition:group.id,platform,arch:'x64',stage:'full',artifact:'candidate'}),assert,
      {run:effect('native-all-studio-controls')},{run:effect('native-workbench-controls')},
      {run:effect('native-investigation-controls')},name=>{assert(Object.hasOwn(modules,name));return modules[name];},
      {run:effect('native-advisor-controls')},{run:effect('native-mcp-controls')},{run:effect('native-pluto-controls')},vscode,waitForNativeAvailability);
    assert.deepEqual(calls,[...historicalPrefix,...group.cases]);
    assert.deepEqual(effects,group.id==='mcp-pluto'?
      ['native-mcp-controls','native-pluto-controls','perfchecker.discoverScenarios','perfchecker.syncScenarios']:group.cases);
  }
});

test('the real diagnostic host keeps the seventh prefix and explicitly excludes only the following cases',async()=>{
  const source=readFileSync(new URL('./public-vsix-host.cjs',import.meta.url),'utf8');
  const suiteStart=source.indexOf('async function runSuiteCases('),suiteEnd=source.indexOf('async function measureNativeTestItem(',suiteStart);
  assert(suiteStart>=0&&suiteEnd>suiteStart);
  const suite=Function('discoveryDiagnostic','process','NATIVE_READINESS_MS',`return (${source.slice(suiteStart,suiteEnd).trim()})`)
    (true,{env:{PERFCHECKER_NATIVE_PHASE:'prepared'}},NATIVE_READINESS_MS);
  const calls=[],logs=[];
  await suite({vscode:{Uri:{file:value=>value}},workspace:'/disposable-fixture',log:(name,detail)=>logs.push({name,...detail})},
    async name=>{calls.push(name);return true;},{testItem:true,complete:true});
  assert.deepEqual(calls,['native-suite-run-button','native-suite-save-palette','native-run-selection-command','native-testitem-measurement']);
  assert.equal(logs.length,1);assert.equal(logs[0].name,'native-discovery-diagnostic-skipped-after-target');
  assert.deepEqual(logs[0].cases,['native-complete-suite-measurements','native-all-studio-controls','native-workbench-controls']);
  assert.equal(logs[0].qualifiesCanonicalProduct,false);
  const tailStart=source.indexOf("if (process.env.PERFCHECKER_NATIVE_STAGE === 'full'&&!discoveryDiagnostic) {");
  assert(tailStart>=0);let end=source.indexOf('{',tailStart),depth=1;
  while(depth&&++end<source.length){if(source[end]==='{')depth++;if(source[end]==='}')depth--;}
  assert.equal(depth,0);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction('process','discoveryDiagnostic',source.slice(tailStart,end+1))
    ({env:{PERFCHECKER_NATIVE_STAGE:'full'}},true);
});

test('partitions cannot silently replace focused, public, ARM or other platform campaigns',()=>{
  const campaign={partition:'measure',platform:'darwin',arch:'x64',stage:'full',artifact:'candidate'};
  for(const change of [{partition:'unknown'},{platform:'linux'},{platform:'win32'},
    {arch:'arm64'},{stage:'focused'},{stage:'smoke'},{artifact:'public'}])
    assert.throws(()=>nativeFullCasePartition({...campaign,...change}));
  assert(!nativeFullCasePartition({artifact:'public'}).cases.includes('native-pluto-controls'));
  for(const partition of nativeFullFunctionalGroups.map(group=>group.id))for(const change of
    [{partition:'unknown'},{platform:'freebsd'},{arch:'arm64'},{stage:'focused'},{stage:'smoke'},{artifact:'public'}])
    assert.throws(()=>nativeFullCasePartition({...campaign,partition,...change}));
});

test('the actual package output selects unique functional jobs for every complete candidate host',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/native-vsix.yml',import.meta.url),'utf8');
  const step=workflow.indexOf('id: matrix'),start=workflow.indexOf("node --input-type=module <<'NODE'",step)+"node --input-type=module <<'NODE'".length;
  const end=workflow.indexOf('\n          NODE',start);assert(step>=0&&end>start);
  assert(step<workflow.indexOf('Select the declared archive origin for qualification'));
  const script=workflow.slice(start,end).split('\n').filter(line=>!line.trim().startsWith('import ')).join('\n');
  const matrix=(event,inputs={})=>{let output;
    Function('fs','nativeWorkflowMatrix','process',script)({appendFileSync(file,text){assert.equal(file,'memory-output');assert.equal(output,undefined);output=text;}},
      nativeWorkflowMatrix,{env:{GITHUB_OUTPUT:'memory-output',NATIVE_EVENT:event,NATIVE_SCOPE:inputs.scope,
        NATIVE_VSIX_MODE:inputs.artifact||'candidate',NATIVE_STAGE:inputs.stage,NATIVE_CASE_GROUP:inputs.group,
        NATIVE_CORE:inputs.core||'candidate',NATIVE_DISCOVERY_DIAGNOSTIC:String(inputs.discovery_diagnostic||false)}});
    assert(output.startsWith('matrix=')&&output.endsWith('\n'));return JSON.parse(output.slice(7));};
  assert(workflow.includes('matrix: ${{ steps.matrix.outputs.matrix }}'));
  assert(workflow.includes('include: ${{ fromJSON(needs.package.outputs.matrix) }}'));
  assert(workflow.includes('name: ${{ matrix.name }}'));assert(workflow.includes('name: ${{ matrix.artifactName }}'));
  const full=matrix('pull_request');
  assert.equal(full.length,35);assert.equal(new Set(full.map(lane=>lane.name)).size,35);
  assert.equal(new Set(full.map(lane=>lane.artifactName)).size,35);
  for(const [os,vscode]of [['ubuntu-latest','1.96.0'],['ubuntu-latest','stable'],['windows-latest','1.96.0'],['windows-latest','stable'],['macos-15-intel','stable']]){
    const lanes=full.filter(lane=>lane.os===os&&lane.vscode===vscode);assert.equal(lanes.length,7);
    assert.deepEqual(lanes.map(lane=>lane.partition),['studio','workbench','investigation','investigation-limits','narrative','advisor','mcp-pluto']);
    assert(lanes.every(lane=>lane.name.includes(`VS Code ${vscode}`)&&lane.name.includes(os==='macos-15-intel'?'macOS Intel':'x64')));
  }
  const manual=(scope,stage='full',artifact='candidate',extra={})=>matrix('workflow_dispatch',{scope,stage,artifact,...extra});
  assert.equal(manual('all').length,35);for(const scope of ['linux','windows'])assert.equal(manual(scope).length,14);
  for(const scope of ['linux-stable','windows-stable','macos-stable'])assert.equal(manual(scope).length,7);
  assert.deepEqual(manual('macos-stable','focused').map(({os,vscode})=>({os,vscode})),[{os:'macos-15-intel',vscode:'stable'}]);
  assert.equal(manual('all','full','public').length,5);
  assert(manual('all','full','public').every(lane=>!lane.partition));
  assert.deepEqual(manual('all','full','public').map(({os,vscode})=>({os,vscode})),[
    {os:'ubuntu-latest',vscode:'1.96.0'},{os:'ubuntu-latest',vscode:'stable'},
    {os:'windows-latest',vscode:'1.96.0'},{os:'windows-latest',vscode:'stable'},{os:'macos-15-intel',vscode:'stable'}]);
  for(const stage of ['focused','smoke','targeted','core-external','connector-workers']){
    assert.equal(manual('all',stage).length,5);assert(manual('all',stage).every(lane=>!lane.partition));
  }
  const arm=manual('arm-bootstrap','focused','candidate',{core:'general',group:'bootstrap'});assert.equal(arm.length,4);
  assert(arm.every(lane=>lane.arch==='arm64'&&!lane.partition&&lane.name.includes(lane.os==='macos-15'?'Apple Silicon':'Linux ARM64')&&lane.name.includes('Julia')));
  assert.equal(new Set(arm.map(lane=>lane.name)).size,4);assert.equal(new Set(arm.map(lane=>lane.artifactName)).size,4);
  const diagnostic=manual('macos-stable','full','candidate',{discovery_diagnostic:true});assert.equal(diagnostic.length,1);
  assert.equal(diagnostic[0].partition,'measure');
  assert.equal(diagnostic[0].name,'Diagnostic — macOS Intel — VS Code stable — TestItem discovery — non-qualifying');
  for(const change of [{scope:'unknown'},{artifact:'unknown'},{stage:'unknown'},{event:'unknown'}])
    assert.throws(()=>nativeWorkflowMatrix({event:'workflow_dispatch',...change}));
  for(const change of [{scope:'all'},{stage:'focused'},{artifact:'public'},{core:'general'},{event:'pull_request'}])
    assert.throws(()=>nativeWorkflowMatrix({event:'workflow_dispatch',scope:'macos-stable',stage:'full',artifact:'candidate',core:'candidate',discoveryDiagnostic:true,...change}));
});

test('functional splitting preserves all three phases under the shared one-hour availability policy',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/native-vsix.yml',import.meta.url),'utf8');
  const driver=readFileSync(new URL('./run-public-vsix-host.mjs',import.meta.url),'utf8');
  assert(workflow.includes("timeout-minutes: 360"));
  assert(workflow.includes("PERFCHECKER_NATIVE_ACTIVITY_STARTED_AT=$(( $(date +%s) * 1000 ))"));
  assert(driver.includes("const completeCampaign=['smoke','full'].includes(stage);"));
  assert(driver.includes("if(completeCampaign||bootstrapOnly)await launch('fresh');"));
  assert(driver.includes("if(completeCampaign)await launch('configured');"));
  assert(driver.includes("else await launch('prepared');"));
  assert(driver.includes("const remainingActivityMs=nativeActivity.remaining(),activationWindowMs=Math.min(NATIVE_READINESS_MS,remainingActivityMs);"));
  assert(driver.includes("PERFCHECKER_NATIVE_ACTIVITY_DEADLINE_AT:String(nativeActivity.deadlineAt)"));
  assert(driver.includes("Historical discovery diagnostics retain their original branch and explicit contract"));
  assert(workflow.includes("if: runner.os == 'Linux' && matrix.vscode == 'stable' && (env.PERFCHECKER_NATIVE_STAGE == 'full' || env.PERFCHECKER_NATIVE_CASE_GROUP == 'mcp-pluto')"),
    'Every complete group preserves the actual host prerequisite condition without a partition exception');
});

test('preparation and successive phases consume one activity deadline, leaving the technical reserve',()=>{
  let now=1000;
  const budget=createNativeActivityBudget({startedAt:now,now:()=>now});
  const deadline=budget.deadlineAt;
  now+=75*60000; // Installation and preparation are already part of the job.
  assert.equal(budget.remaining(),255*60000);
  assert.equal(budget.timeout(),3600000);
  now+=220*60000; // Fresh/configured/prepared never renew the activity window.
  assert.equal(budget.deadlineAt,deadline);
  assert.equal(budget.timeout(),35*60000);
  assert.equal(budget.timeout(3000),3000,'Short inspections are never expanded');
  now=deadline;
  assert.throws(()=>budget.timeout(),{code:'NATIVE_INFRASTRUCTURE_ACTIVITY_LIMIT'});
  assert.throws(()=>budget.remaining(),{code:'NATIVE_INFRASTRUCTURE_ACTIVITY_LIMIT'});
  assert.equal(readiness.nativeReadinessPolicy.jobMinutes-readiness.nativeReadinessPolicy.activityMinutes,30);
});

function actualFunction(file,name,bindings,exposeRetention=false){
  const source=readFileSync(new URL(file,import.meta.url),'utf8');
  const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const node=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
  assert(node,`The real ${name} implementation remains present`);
  const body=exposeRetention?`let sessionSafeToRemove=true; return {run:(${node.getText(tree)}),retained:()=>!sessionSafeToRemove}`:
    `return (${node.getText(tree)})`;
  return Function(...Object.keys(bindings),body)(...Object.values(bindings));
}

test('the real host availability helper waits beyond the former bound while explicit cancellation stays short',async()=>{
  let now=0,polls=0;
  const eventually=actualFunction('./public-vsix-host.cjs','eventually',{
    NATIVE_READINESS_MS,Date:{now:()=>now},delay:async milliseconds=>{
      assert.equal(milliseconds,150,'The existing polling interval is retained');
      now+=30*60000;polls++;
    }
  });
  assert.equal(await eventually(()=>now>=30*60000&&'ready','Positive readiness'),'ready');
  assert.equal(polls,1);
  now=0;
  await assert.rejects(eventually(()=>false,'Protected cancellation',120000),/Protected cancellation/);
  assert.equal(polls,2,'The explicit short cancellation bound does not become an hour');
});

test('real Testing availability delegates both UI actions once and preserves its failure before RunTest',async()=>{
  const primary=new Error('controlled row availability failure'),actions=[],waits=[];
  const measure=actualFunction('./public-vsix-host.cjs','measureNativeTestItemBody',{
    NATIVE_READINESS_MS,discoveryDiagnostic:false,controls:{clickStudioAction:async(_,action)=>actions.push(action)},
    process:{env:{}},redact:value=>value,assert
  });
  const row={waitFor:async options=>{waits.push(options);throw primary;}};
  const context={vscode:{commands:{executeCommand:()=>assert.fail('RunTest must not execute after the availability failure')}},
    windowPage:{locator:()=>({filter:()=>({first:()=>row})})},workspace:'/fixture'};
  await assert.rejects(measure(context,true),error=>error===primary);
  assert.deepEqual(actions,['items','testing']);
  assert.deepEqual(waits,[{state:'visible',timeout:3600000}]);
});

test('native operation observation preserves results and errors, and expiry neither retries nor stops the operation',async()=>{
  const timers=new Map();let sequence=0,delegations=0,complete;
  const wait=actualFunction('./native-readiness.cjs','waitForNativeAvailability',{
    NATIVE_READINESS_MS,setTimeout:(callback,milliseconds)=>{
      assert.equal(milliseconds,3600000);const id=++sequence;timers.set(id,callback);return id;
    },clearTimeout:id=>timers.delete(id)
  });
  const result={original:true},primary=new Error('original command failure');
  assert.equal(await wait(Promise.resolve(result),'Ready command'),result);
  await assert.rejects(wait(Promise.reject(primary),'Failed command'),error=>error===primary);
  assert.equal(timers.size,0);
  const operation=()=>{delegations++;return new Promise(resolve=>{complete=resolve;});};
  const pending=wait(operation(),'Slow command');
  const rejected=assert.rejects(pending,{code:'NATIVE_AVAILABILITY_LIMIT'});
  [...timers.values()][0]();await rejected;
  assert.equal(delegations,1);
  complete(result);await Promise.resolve();
  assert.equal(timers.size,0,'The still-owned original command may settle later without a retry or unhandled rejection');
});

test('real preparation execution clips activity but permits bounded technical teardown after exhaustion',async()=>{
  let now=1000;
  const nativeActivity=createNativeActivityBudget({startedAt:now,now:()=>now}),calls=[];
  const execute=actualFunction('./run-public-vsix-host.mjs','execute',{
    NATIVE_READINESS_MS,nativeActivity,runnerEnvironment:{fixture:true},landscapeOnly:false,landscapeAbort:{},
    path:{basename:value=>value},process:{stdout:{write(){}},stderr:{write(){}}},
    spawn:(file,args,options)=>{calls.push({file,args,options});const child=new EventEmitter();
      child.stdout=new EventEmitter();child.stderr=new EventEmitter();queueMicrotask(()=>child.emit('close',0));return child;}
  });
  now=nativeActivity.deadlineAt-2500;
  await execute('prepare',['fixture']);
  assert.equal(calls[0].options.timeout,2500);
  now=nativeActivity.deadlineAt;
  await assert.rejects(execute('prepare-again',[]),{code:'NATIVE_INFRASTRUCTURE_ACTIVITY_LIMIT'});
  assert.equal(calls.length,1,'An expired positive preparation cannot spawn');
  await execute('technical-drain',[],{technical:true,timeout:10000});
  assert.equal(calls[1].options.timeout,10000);
  assert(!Object.hasOwn(calls[1].options,'technical'),'The internal phase flag is not passed to spawn');
});

test('real failed or interrupted preparations retain their session without claiming descendant shutdown',async()=>{
  for(const event of ['error','signal']){
    const primary=Object.assign(new Error('original spawn/abort failure'),{name:'AbortError'}),logs=[];
    const execution=actualFunction('./run-public-vsix-host.mjs','execute',{
      NATIVE_READINESS_MS,nativeActivity:{timeout:value=>value},runnerEnvironment:{},landscapeOnly:false,landscapeAbort:{},
      path:{basename:value=>value},process:{stdout:{write(){}},stderr:{write(){}}},console:{error:value=>logs.push(value)},
      spawn:()=>{const child=new EventEmitter();child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
        queueMicrotask(()=>event==='error'?child.emit('error',primary):child.emit('close',null,'SIGTERM'));return child;}
    },true);
    assert.equal(execution.retained(),false);
    await assert.rejects(execution.run('julia',[],{timeout:10}),error=>event==='error'?error===primary:
      error.exitCode===null&&error.message==='julia exited null\n');
    assert.equal(execution.retained(),true);
    const report=JSON.parse(logs[0].slice(logs[0].indexOf('{')));
    assert.equal(report.treeCleanupQualified,false);
    assert.equal(report.physicalCloseObserved,event==='signal');
    assert.equal(report.ownerPid,123);
  }
});

test('real VS Code preparation has an absolute clipped wait despite continued download progress',async()=>{
  for(const remaining of [3600000,2500]){
    let now=1000,complete,delegations=0,progress=0;const timers=new Map(),logs=[];
    const wait=actualFunction('./native-readiness.cjs','waitForNativeAvailability',{
      NATIVE_READINESS_MS,setTimeout:(callback,milliseconds)=>{timers.set(1,{callback,at:now+milliseconds});return 1;},
      clearTimeout:id=>timers.delete(id)
    });
    const download=actualFunction('./run-public-vsix-host.mjs','downloadNativeVSCode',{
      nativeActivity:{timeout:()=>remaining},waitForNativeAvailability:wait,console:{error:value=>logs.push(value)},
      downloadAndUnzipVSCode:options=>{delegations++;assert.equal(options.timeout,remaining);
        return new Promise(resolve=>{complete=resolve;});}
    },true);
    const result=download.run({version:'stable'});
    const rejected=assert.rejects(result,{code:'NATIVE_AVAILABILITY_LIMIT'});
    const deadline=timers.get(1).at;
    for(let index=0;index<5;index++){progress++;now+=Math.floor(remaining/6);assert.equal(timers.get(1).at,deadline);}
    now=deadline;timers.get(1).callback();await rejected;
    assert.equal(progress,5);assert.equal(delegations,1);assert.equal(download.retained(),true);
    assert.equal(JSON.parse(logs[0].slice(logs[0].indexOf('{'))).physicalCloseObserved,false);
    complete('/late-extraction');await Promise.resolve();
    assert.equal(download.retained(),true,'A late resolved download does not retroactively qualify teardown or change the failure');
  }
});

test('the real Advisor Cancel callsite keeps its short click, completion and internal read bounds',async()=>{
  const waits=[],clicks=[],reads=[];let status='Ready';
  const frame={getByRole:role=>({click:async options=>clicks.push(options.timeout),
    innerText:async options=>{reads.push(options.timeout);return status;}}),
    locator:()=>({getAttribute:async(_,options)=>{reads.push(options.timeout);return 'false';}})};
  const finished=actualFunction('./native-advisor-controls.cjs','finished',{
    NATIVE_READINESS_MS,eventually:async(read,_,timeout)=>{waits.push(timeout);assert(await read());}
  });
  const click=actualFunction('./native-advisor-controls.cjs','click',{NATIVE_READINESS_MS});
  await finished(frame,/Ready/);
  assert.deepEqual(reads,[3600000,3600000]);reads.length=0;status='Operation cancelled';
  const source=readFileSync(new URL('./native-advisor-controls.cjs',import.meta.url),'utf8');
  const start=source.indexOf("await click(frame, 'Cancel operation'");
  const end=source.indexOf('\n',start);assert(start>=0&&end>start);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction('frame','click','finished',source.slice(start,end))(frame,click,finished);
  assert.deepEqual(clicks,[30000]);assert.deepEqual(waits,[3600000,180000]);assert.deepEqual(reads,[30000,30000]);
});

test('real reactive Cancel refresh retains its ninety-second window across nested auto waits',async()=>{
  let now=0;const calls=[];
  const refresh=actualFunction('./native-pluto-controls.cjs','refresh',{
    NATIVE_READINESS_MS,Date:{now:()=>now},assert,idle:async(_,timeout)=>{calls.push(['idle',timeout]);now+=90000;}
  });
  const frame={getByRole:()=>({click:async options=>calls.push(['click',options.timeout])}),
    locator:()=>({innerText:()=>assert.fail('An exhausted Cancel window cannot start another auto wait')})};
  await assert.rejects(refresh(frame,'Refresh','status',/cancelled/,90000),/existing reactive-result window/);
  assert.deepEqual(calls,[['click',90000],['idle',90000]]);
});

test('real active-reload baseline keeps the validated idle snapshot across adversarial UI reads',async()=>{
  const source=readFileSync(new URL('./native-studio-controls.cjs',import.meta.url),'utf8');
  const tree=ts.createSourceFile('native-studio-controls.cjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const selection=tree.statements.find(node=>ts.isExpressionStatement(node)&&
    ts.isBinaryExpression(node.expression)&&node.expression.left.getText(tree)==='exports.runSelection');
  assert(selection&&ts.isArrowFunction(selection.expression.right),'The real runSelection implementation remains present');
  const statements=selection.expression.right.body.statements;
  const declarationIndex=name=>statements.findIndex(node=>ts.isVariableStatement(node)&&
    node.declarationList.declarations.some(declaration=>declaration.name.getText(tree)===name));
  const start=declarationIndex('state'),end=declarationIndex('launchCount');
  assert(start>=0&&end>start,'The actual baseline capture remains between state and launchCount');
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const capture=new AsyncFunction('state','eventually','controllerLaunches',
    statements.slice(start+1,end).map(node=>node.getText(tree)).join('\n')+'\nreturn {idleState,beforeLaunches};');
  for(const initiallyBusy of [false,true]){
    let now=0,polls=0;
    const eventually=actualFunction('./native-studio-controls.cjs','eventually',{
      NATIVE_READINESS_MS,Date:{now:()=>now},setTimeout:(resolve,milliseconds)=>{
        assert.equal(milliseconds,100,'The real polling interval remains unchanged');
        assert(polls<4,'The simulated scheduler has a finite polling budget');
        polls++;now+=NATIVE_READINESS_MS/4;resolve();
      }
    });
    const idle={controls:{run:false,refresh:false,save:false,'add-target':false,'add-comparison':false},
      inventory:[{id:'one',checks:[{name:'smoke',selected:true}]}],count:'1 selected',sort:'name',openAfterRun:false};
    const busy=structuredClone(idle);busy.controls.run=busy.controls.refresh=busy.controls.save=true;
    const observations=initiallyBusy?[busy,idle,busy]:[idle,busy];
    let reads=0,launchReads=0;const launches=[{commands:['existing launch']}];
    const result=await capture(async()=>{assert(reads<observations.length);return observations[reads++];},
      eventually,async()=>{launchReads++;return launches;});
    assert.equal(result.idleState,idle,'The baseline is the exact snapshot accepted by the real readiness callback');
    assert.equal(reads,initiallyBusy?2:1,'There is no unvalidated read after readiness succeeds');
    assert.equal(polls,initiallyBusy?1:0,'Only the simulated busy observation schedules a poll');
    assert.equal(result.beforeLaunches,launches);assert.equal(launchReads,1);
  }
});

test('native browser callbacks never capture the Node-only readiness constant',()=>{
  for(const file of ['public-vsix-host.cjs','native-workbench-controls.cjs','native-studio-controls.cjs',
    'native-pluto-controls.cjs','native-advisor-controls.cjs','native-investigation-controls.cjs',
    'native-mcp-controls.cjs','native-narrative-controls.cjs']){
    const source=readFileSync(new URL('./'+file,import.meta.url),'utf8');
    const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const inspect=node=>{
      if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&/^evaluate(All)?$/.test(node.expression.name.text)){
        assert(!/\bNATIVE_READINESS_MS\b/.test(node.arguments[0]?.getText(tree)||''),`${file}: browser callbacks have no Node scope`);
      }
      ts.forEachChild(node,inspect);
    };
    inspect(tree);
  }
});
