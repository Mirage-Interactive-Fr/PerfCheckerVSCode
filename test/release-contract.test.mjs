import test from 'node:test';
import assert from 'node:assert/strict';
import {assertQualifiedArchive,assertGreenReleaseRuns} from './release-contract.mjs';
const commit='a'.repeat(40),tree='b'.repeat(40),sha='c'.repeat(64);
const valid={version:'1.1.0',tag:'v1.1.0',packageVersion:'1.1.0',runId:'123',candidateName:`native-candidate-${commit}`,expectedSha:sha,actualSha:sha,
  provenance:{version:'1.1.0',commit,tree,sha256:sha,run:'123'},originTree:tree,
  originRun:{id:123,head_sha:commit,path:'.github/workflows/native-vsix.yml',status:'completed',conclusion:'success'},changed:['test/qualification.cjs','.github/workflows/native-vsix.yml']};

test('release validation retains the exact qualified bytes and refuses changed or foreign product inputs',()=>{
  assert.equal(assertQualifiedArchive(valid).filename,'perfchecker-vscode-1.1.0.vsix');
  for(const change of [{version:'1.1.0; echo unsafe'},{actualSha:'d'.repeat(64)},{tag:'v1.0.3'},
    {provenance:{...valid.provenance,version:'1.0.3'}},{originTree:commit},{changed:['src/extension.ts']},
    {originRun:{...valid.originRun,conclusion:'failure'}},{originRun:{...valid.originRun,head_sha:tree}}])
    assert.throws(()=>assertQualifiedArchive({...valid,...change}));
});
test('release gates require current successful CI and native qualification for the tagged commit',()=>{
  const runs=['ci','native-vsix'].map((name,index)=>({id:index+1,head_sha:commit,event:'pull_request',path:`.github/workflows/${name}.yml`,status:'completed',conclusion:'success'}));
  assertGreenReleaseRuns(runs,commit);
  for(const conclusion of ['failure','cancelled','skipped'])assert.throws(()=>assertGreenReleaseRuns([...runs,{...runs[0],id:3,conclusion}],commit));
  assert.throws(()=>assertGreenReleaseRuns([...runs,{...runs[0],id:3,status:'in_progress'}],commit));
  assert.throws(()=>assertGreenReleaseRuns(runs,tree));
  assert.throws(()=>assertGreenReleaseRuns(runs.slice(0,1),commit));
  const focused={...runs[1],id:10,event:'workflow_dispatch'};
  assert.throws(()=>assertGreenReleaseRuns([runs[0],focused],commit),'A focused manual run cannot replace the full native matrix');
  assert.throws(()=>assertGreenReleaseRuns([runs[0],{...runs[1],conclusion:'failure'},focused],commit));
  assertGreenReleaseRuns([...runs,{...focused,conclusion:'failure'}],commit);
});
