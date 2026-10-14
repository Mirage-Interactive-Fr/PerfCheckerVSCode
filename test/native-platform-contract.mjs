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
