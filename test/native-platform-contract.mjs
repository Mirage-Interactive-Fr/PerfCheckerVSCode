import assert from 'node:assert/strict';

export function assertNativeCampaignSelection({scope='all',event,artifact,stage,group,core}) {
  if(scope!=='arm-bootstrap')return;
  assert.equal(event,'workflow_dispatch','ARM bootstrap is an explicit manual campaign');
  assert.equal(artifact,'candidate','ARM bootstrap requires the immutable candidate VSIX');
  assert.equal(stage,'focused','ARM bootstrap is restricted to focused native controls');
  assert.equal(group,'bootstrap','ARM bootstrap exercises the production installers');
  assert.equal(core,'general','ARM bootstrap requires registered Core, without Git overrides');
}

export function nativePlatformContract({scope='all',event,artifact,stage,group,core,
  platform=process.platform,arch=process.arch,runnerArch='',expectedArch='x64'}) {
  assertNativeCampaignSelection({scope,event,artifact,stage,group,core});
  if(scope==='arm-bootstrap') {
    assert(['linux','darwin'].includes(platform),'ARM bootstrap supports Linux and Apple Silicon');
    assert.equal(expectedArch,'arm64','ARM bootstrap explicitly requests native ARM64');
  }else assert.equal(expectedArch,'x64','Other native campaigns retain their x64 contract');
  assert.equal(arch,expectedArch,'The qualification driver must use the native Node architecture');
  if(runnerArch)assert.equal(runnerArch.toLowerCase(),expectedArch,'Node must match the actual runner architecture');
  return {node:expectedArch,julia:expectedArch==='arm64'?'aarch64':'x86_64'};
}

export function assertNativeJuliaArchitecture(runtime,contract,label) {
  assert.equal(runtime.arch,contract.julia,`${label} must use the native Julia architecture`);
}

// Every partition retains fresh/configured and the complete prepared suite
// prefix. Only this ordered tail is divided between isolated Intel Mac jobs.
const fullCasePartitions=Object.freeze({
  measure:Object.freeze(['native-all-studio-controls','native-workbench-controls']),
  investigate:Object.freeze(['native-investigation-controls','native-investigation-limits']),
  agentic:Object.freeze(['native-enabled-narrative-protocol','native-advisor-controls',
    'native-mcp-controls','native-pluto-controls','native-discovery-and-sync-after-pluto'])
});

export function nativeFullCasePartition({partition='all',platform=process.platform,
  arch=process.arch,stage,artifact}) {
  assert(partition==='all'||Object.hasOwn(fullCasePartitions,partition),'Unknown full native case partition');
  if(partition!=='all') {
    assert.equal(platform,'darwin','Full partitions are restricted to Intel macOS');
    assert.equal(arch,'x64','Full partitions require native Intel macOS');
    assert.equal(stage,'full','Partitions retain the complete native campaign');
    assert.equal(artifact,'candidate','Historical public campaigns remain unchanged');
  }
  const all=Object.values(fullCasePartitions).flat().filter(name=>artifact==='candidate'||name!=='native-pluto-controls');
  return {name:partition,cases:partition==='all'?all:[...fullCasePartitions[partition]],
    sharedPrefix:['controller-visible-in-studio','native-julia-terminal',
      artifact==='candidate'?'native-pluto-without-jupyter':'native-notebook-with-jupyter',
      'native-suite-run-button','native-suite-save-palette','native-run-selection-command',
      'native-testitem-measurement','native-complete-suite-measurements']};
}
