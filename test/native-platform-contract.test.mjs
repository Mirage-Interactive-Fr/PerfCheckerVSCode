import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNativeCampaignSelection,nativePlatformContract,assertNativeJuliaArchitecture} from './native-platform-contract.mjs';

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
