import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeCoreContract,GENERAL100_TREE,GENERAL101_TREE} from './native-core-contract.mjs';
const legacy={core:'general100',artifact:'candidate',stage:'focused',group:'general100'};
test('the normal candidate registry minimum remains 1.0.1',()=>{
  assert.deepEqual(nativeCoreContract({artifact:'candidate'}),{mode:'general',version:'1.0.1',registry:'General',tree:GENERAL101_TREE});
  assert.equal(nativeCoreContract({artifact:'public'}).version,'1.0.0');
  for(const override of [{commit:'a'.repeat(40)},{tree:GENERAL101_TREE}])
    assert.throws(()=>nativeCoreContract({artifact:'candidate',...override}),/without Git source overrides/);
});
test('legacy declares an exact registered tree without Git fallback',()=>{
  assert.deepEqual(nativeCoreContract(legacy),{mode:'general100',version:'1.0.0',registry:'General',tree:GENERAL100_TREE});
});
test('legacy cannot enter a full campaign or masquerade as another Core',()=>{
  for(const change of [{artifact:'public'},{stage:'full'},{group:'mcp-stdio'},{commit:'a'.repeat(40)},{tree:GENERAL100_TREE}])
    assert.throws(()=>nativeCoreContract({...legacy,...change}),/restricted/);
  for(const core of ['general','candidate'])assert.throws(()=>nativeCoreContract({...legacy,core}),/explicit registry contract/);
});
test('candidate pins remain mandatory and exact',()=>{
  assert.throws(()=>nativeCoreContract({core:'candidate',artifact:'candidate'}),/immutable/);
  assert.equal(nativeCoreContract({core:'candidate',commit:'a'.repeat(40),tree:'b'.repeat(40)}).tree,'b'.repeat(40));
});
