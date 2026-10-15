import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertNativeCampaignSelection,nativePlatformContract,assertNativeJuliaArchitecture,nativeFullCasePartition,nativeFullFunctionalGroups,nativeWorkflowMatrix} from './native-platform-contract.mjs';

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
  const suite=Function('discoveryDiagnostic',`return (${source.slice(suiteStart,suiteEnd).trim()})`)(false);
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
  const suite=Function('discoveryDiagnostic',`return (${source.slice(suiteStart,suiteEnd).trim()})`)(false);
  const tail=new AsyncFunction('process','discoveryDiagnostic','runCase','context','fullCasePartition','assert',
    'controls','workbench','investigations','require','advisor','mcp','pluto','vscode',source.slice(tailStart,end+1));
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
      {run:effect('native-advisor-controls')},{run:effect('native-mcp-controls')},{run:effect('native-pluto-controls')},vscode);
    assert.deepEqual(calls,[...historicalPrefix,...group.cases]);
    assert.deepEqual(effects,group.id==='mcp-pluto'?
      ['native-mcp-controls','native-pluto-controls','perfchecker.discoverScenarios','perfchecker.syncScenarios']:group.cases);
  }
});

test('the real diagnostic host keeps the seventh prefix and explicitly excludes only the following cases',async()=>{
  const source=readFileSync(new URL('./public-vsix-host.cjs',import.meta.url),'utf8');
  const suiteStart=source.indexOf('async function runSuiteCases('),suiteEnd=source.indexOf('async function measureNativeTestItem(',suiteStart);
  assert(suiteStart>=0&&suiteEnd>suiteStart);
  const suite=Function('discoveryDiagnostic','process',`return (${source.slice(suiteStart,suiteEnd).trim()})`)
    (true,{env:{PERFCHECKER_NATIVE_PHASE:'prepared'}});
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

test('functional splitting preserves the real three-phase preparation and all existing time limits',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/native-vsix.yml',import.meta.url),'utf8');
  const driver=readFileSync(new URL('./run-public-vsix-host.mjs',import.meta.url),'utf8');
  assert(workflow.includes("timeout-minutes: ${{ (github.event_name != 'workflow_dispatch' || inputs.stage == 'full') && 180 || 150 }}"));
  assert(driver.includes("const completeCampaign=['smoke','full'].includes(stage);"));
  assert(driver.includes("if(completeCampaign||bootstrapOnly)await launch('fresh');"));
  assert(driver.includes("if(completeCampaign)await launch('configured');"));
  assert(driver.includes("else await launch('prepared');"));
  assert(driver.includes("phase==='prepared'&&environment.PERFCHECKER_NATIVE_STAGE==='full'?130"));
  assert(workflow.includes("if: runner.os == 'Linux' && matrix.vscode == 'stable' && (env.PERFCHECKER_NATIVE_STAGE == 'full' || env.PERFCHECKER_NATIVE_CASE_GROUP == 'mcp-pluto')"),
    'Every complete group preserves the actual host prerequisite condition without a partition exception');
});
