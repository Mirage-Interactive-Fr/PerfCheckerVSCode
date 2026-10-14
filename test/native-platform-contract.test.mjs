import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertNativeCampaignSelection,nativePlatformContract,assertNativeJuliaArchitecture,nativeFullCasePartition} from './native-platform-contract.mjs';

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

test('Intel partitions preserve the full ordered case union and every shared prefix',()=>{
  const campaign={platform:'darwin',arch:'x64',stage:'full',artifact:'candidate'};
  const all=nativeFullCasePartition(campaign);
  const partitions=['measure','investigate','agentic'].map(partition=>nativeFullCasePartition({...campaign,partition}));
  const historical=['native-all-studio-controls','native-workbench-controls','native-investigation-controls',
    'native-investigation-limits','native-enabled-narrative-protocol','native-advisor-controls',
    'native-mcp-controls','native-pluto-controls','native-discovery-and-sync-after-pluto'];
  assert.deepEqual(all.cases,historical,'The independently enumerated historical tail must remain complete');
  assert.deepEqual(partitions.flatMap(partition=>partition.cases),historical);
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
  const suite=Function(`return (${source.slice(suiteStart,suiteEnd).trim()})`)();
  await suite({vscode:{Uri:{file:value=>value}},workspace:'/disposable-fixture'},runCase,{testItem:true,complete:true});
  const historicalPrefix=['controller-visible-in-studio','native-julia-terminal','native-pluto-without-jupyter',
    'native-suite-run-button','native-suite-save-palette','native-run-selection-command',
    'native-testitem-measurement','native-complete-suite-measurements'];
  assert.deepEqual(calls,historicalPrefix);
  assert.deepEqual(nativeFullCasePartition({artifact:'candidate'}).sharedPrefix,historicalPrefix);
  assert(source.includes("await runSuiteCases(context,runCase,{testItem:true,complete:process.env.PERFCHECKER_NATIVE_STAGE==='full'});"),
    'Every full prepared partition still dispatches both the native test item and the complete suite');
});

test('partitions cannot silently replace focused, public, ARM or other platform campaigns',()=>{
  const campaign={partition:'measure',platform:'darwin',arch:'x64',stage:'full',artifact:'candidate'};
  for(const change of [{partition:'unknown'},{platform:'linux'},{platform:'win32'},
    {arch:'arm64'},{stage:'focused'},{stage:'smoke'},{artifact:'public'}])
    assert.throws(()=>nativeFullCasePartition({...campaign,...change}));
  assert(!nativeFullCasePartition({artifact:'public'}).cases.includes('native-pluto-controls'));
});

test('the actual workflow partitions only complete candidate Intel jobs and keeps every other lane',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/native-vsix.yml',import.meta.url),'utf8');
  const expression=workflow.split('\n').find(line=>line.includes('include: ${{ fromJSON(')).split('${{ ')[1].split(' }}')[0];
  const matrix=(event,inputs={})=>Function('github','inputs','fromJSON',`return ${expression}`)({event_name:event},inputs,JSON.parse);
  const full=matrix('pull_request');
  assert.deepEqual(full.filter(lane=>lane.os!=='macos-15-intel'),[
    {os:'ubuntu-latest',vscode:'1.96.0'},{os:'ubuntu-latest',vscode:'stable'},
    {os:'windows-latest',vscode:'1.96.0'},{os:'windows-latest',vscode:'stable'}]);
  assert.deepEqual(full.filter(lane=>lane.os==='macos-15-intel').map(lane=>lane.partition),['measure','investigate','agentic']);
  const manual=(scope,stage='full',artifact='candidate')=>matrix('workflow_dispatch',{scope,stage,artifact});
  assert.equal(manual('macos-stable').length,3);
  assert.deepEqual(manual('macos-stable','focused'),[{os:'macos-15-intel',vscode:'stable'}]);
  assert.equal(manual('all','full','public').length,5);
  assert(manual('all','full','public').every(lane=>!lane.partition));
  assert.equal(manual('all','focused').length,5);
  assert.equal(manual('arm-bootstrap','focused').length,4);
  assert(manual('arm-bootstrap','focused').every(lane=>lane.arch==='arm64'&&!lane.partition));
  assert.deepEqual(manual('windows-stable'),[{os:'windows-latest',vscode:'stable'}]);
});
