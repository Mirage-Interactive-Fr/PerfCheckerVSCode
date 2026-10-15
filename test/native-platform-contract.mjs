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

export function assertNativeInvestigationDiagnostic({enabled=false,discoveryDiagnostic=false,event,artifact,stage,scope,core,
  partition='investigation',backendJulia,originRun,originName,originSha,coreCommit,coreTree,newOrigin=false,platform,arch}) {
  assert(!(enabled&&discoveryDiagnostic),'Investigation and discovery diagnostics are mutually exclusive');
  if(!enabled)return;
  assert.equal(event,'workflow_dispatch');assert.equal(artifact,'candidate');assert.equal(stage,'full');
  assert.equal(scope,'macos-stable');assert.equal(core,'candidate');assert.equal(partition,'investigation');
  assert.equal(backendJulia,'1');assert.equal(newOrigin,false);
  assert.equal(String(originRun),'38653410110');
  assert.equal(originName,'native-candidate-73b99deb87efaf45bd5e96036f755e42c748bdab');
  assert.equal(originSha,'bc61f9fa172069c61722e0691900d3ddf8a39ce143fd9d553b252304dbc55850');
  assert.equal(coreCommit,'d079efd5c24c3dcac5b7550781822038e0ff780f');
  assert.equal(coreTree,'749f8eac351ed2a1f0bc110456f2eb37a3bc08ee');
  if(platform!==undefined)assert.equal(platform,'darwin');if(arch!==undefined)assert.equal(arch,'x64');
}

// Historical Intel partitions remain available for reproduction and the
// explicit discovery diagnostic; they are not part of the new group union.
const legacyFullCasePartitions=Object.freeze({
  measure:Object.freeze(['native-all-studio-controls','native-workbench-controls']),
  investigate:Object.freeze(['native-investigation-controls','native-investigation-limits']),
  agentic:Object.freeze(['native-enabled-narrative-protocol','native-advisor-controls',
    'native-mcp-controls','native-pluto-controls','native-discovery-and-sync-after-pluto'])
});

export const nativeFullFunctionalGroups=Object.freeze([
  {id:'studio',label:'Studio & suites',cases:['native-all-studio-controls']},
  {id:'workbench',label:'Julia workbench',cases:['native-workbench-controls']},
  {id:'investigation',label:'Investigations & reports',cases:['native-investigation-controls']},
  {id:'investigation-limits',label:'Budgets & deadlines',cases:['native-investigation-limits']},
  {id:'narrative',label:'Narrative & HTTP lifecycle',cases:['native-enabled-narrative-protocol']},
  {id:'advisor',label:'Providers & model setup',cases:['native-advisor-controls']},
  {id:'mcp-pluto',label:'MCP + Pluto + discovery',cases:['native-mcp-controls','native-pluto-controls','native-discovery-and-sync-after-pluto']}
].map(group=>Object.freeze({...group,cases:Object.freeze(group.cases)})));

const nativeHostConfigurations=Object.freeze([
  {os:'ubuntu-latest',vscode:'1.96.0'},{os:'ubuntu-latest',vscode:'stable'},
  {os:'windows-latest',vscode:'1.96.0'},{os:'windows-latest',vscode:'stable'},
  {os:'macos-15-intel',vscode:'stable'}
].map(Object.freeze));

export function nativeWorkflowMatrix({event,scope='all',artifact='candidate',stage='full',group='narrative',core='general',
  discoveryDiagnostic=false,investigationDiagnostic=false}={}){
  assert(['pull_request','workflow_dispatch'].includes(event),'Unknown native workflow event');
  assert(['all','linux','linux-stable','windows','windows-stable','macos-stable','arm-bootstrap'].includes(scope),'Unknown native scope');
  assert(['candidate','public'].includes(artifact),'Unknown native archive mode');
  assert(['smoke','full','targeted','focused','core-external','connector-workers'].includes(stage),'Unknown native stage');
  const named=(lane,label)=>{const platform=lane.os.startsWith('ubuntu')?`Linux ${lane.arch==='arm64'?'ARM64':'x64'}`:
    lane.os.startsWith('windows')?'Windows x64':lane.os==='macos-15'?'Apple Silicon':'macOS Intel';
    return{...lane,name:`Native — ${platform} — VS Code ${lane.vscode}${lane.julia?` — Julia ${lane.julia==='1'?'stable':lane.julia}`:''} — ${label}`,
      artifactName:`native-workflows-${lane.os}-${lane.vscode}${lane.julia?`-julia-${lane.julia}`:''}${lane.partition?`-${lane.partition}`:''}`};};
  assert(!(discoveryDiagnostic&&investigationDiagnostic),'Diagnostics are mutually exclusive');
  if(investigationDiagnostic){
    assert.equal(event,'workflow_dispatch');assert.equal(scope,'macos-stable');assert.equal(artifact,'candidate');
    assert.equal(stage,'full');assert.equal(core,'candidate');
    return[{...named({os:'macos-15-intel',vscode:'stable',partition:'investigation'},'Investigations UI'),
      name:'DIAG — macOS Intel — Investigations UI'}];
  }
  if(discoveryDiagnostic){
    assert.equal(event,'workflow_dispatch');assert.equal(scope,'macos-stable');assert.equal(artifact,'candidate');
    assert.equal(stage,'full');assert.equal(core,'candidate');
    return[{...named({os:'macos-15-intel',vscode:'stable',partition:'measure'},'TestItem discovery'),
      name:'Diagnostic — macOS Intel — VS Code stable — TestItem discovery — non-qualifying'}];
  }
  assertNativeCampaignSelection({scope,event,artifact,stage,group,core});
  if(scope==='arm-bootstrap')return[
    {os:'ubuntu-24.04-arm',vscode:'stable',arch:'arm64',julia:'1.10'},
    {os:'ubuntu-24.04-arm',vscode:'stable',arch:'arm64',julia:'1'},
    {os:'macos-15',vscode:'stable',arch:'arm64',julia:'1.10'},
    {os:'macos-15',vscode:'stable',arch:'arm64',julia:'1'}
  ].map(lane=>named(lane,'Fresh bootstrap'));
  const selected=event==='pull_request'?nativeHostConfigurations:nativeHostConfigurations.filter(lane=>
    scope==='all'||scope==='linux'&&lane.os.startsWith('ubuntu')||scope==='windows'&&lane.os.startsWith('windows')||
    scope==='linux-stable'&&lane.os==='ubuntu-latest'&&lane.vscode==='stable'||
    scope==='windows-stable'&&lane.os==='windows-latest'&&lane.vscode==='stable'||scope==='macos-stable'&&lane.os==='macos-15-intel');
  if(event==='pull_request'||artifact==='candidate'&&stage==='full')
    return selected.flatMap(lane=>nativeFullFunctionalGroups.map(group=>named({...lane,partition:group.id},group.label)));
  return selected.map(lane=>named(lane,stage==='focused'?`Focused ${group}`:stage));
}

export function nativeFullCasePartition({partition='all',platform=process.platform,
  arch=process.arch,stage,artifact}) {
  const functional=nativeFullFunctionalGroups.find(group=>group.id===partition),legacy=Object.hasOwn(legacyFullCasePartitions,partition);
  assert(partition==='all'||functional||legacy,'Unknown full native case partition');
  if(partition!=='all') {
    if(legacy)assert.equal(platform,'darwin','Historical full partitions are restricted to Intel macOS');
    else assert(['linux','win32','darwin'].includes(platform),'Functional groups require a supported native host');
    assert.equal(arch,'x64','Full partitions require native x64');
    assert.equal(stage,'full','Partitions retain the complete native campaign');
    assert.equal(artifact,'candidate','Historical public campaigns remain unchanged');
  }
  const all=Object.values(legacyFullCasePartitions).flat().filter(name=>artifact==='candidate'||name!=='native-pluto-controls');
  return {name:partition,...(functional?{label:functional.label}:{}),cases:partition==='all'?all:[...(functional?.cases||legacyFullCasePartitions[partition])],
    sharedPrefix:['controller-visible-in-studio','native-julia-terminal',
      artifact==='candidate'?'native-pluto-without-jupyter':'native-notebook-with-jupyter',
      'native-suite-run-button','native-suite-save-palette','native-run-selection-command',
      'native-testitem-measurement','native-complete-suite-measurements']};
}
