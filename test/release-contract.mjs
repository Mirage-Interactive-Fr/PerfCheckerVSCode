import assert from 'node:assert/strict';

export function assertQualifiedArchive({version,tag,packageVersion,runId,candidateName,expectedSha,actualSha,provenance,originRun,originTree,changed}) {
  assert(/^\d+\.\d+\.\d+$/.test(version),'A stable numeric version is required');
  assert.equal(tag,`v${version}`);assert.equal(packageVersion,version);
  assert(/^\d+$/.test(String(runId)));assert(/^native-candidate-[a-f0-9]{40}$/.test(candidateName));
  assert(/^[a-f0-9]{64}$/.test(expectedSha));assert.equal(actualSha,expectedSha);
  assert.equal(provenance.sha256,expectedSha);assert.equal(provenance.version,version);
  assert.equal(String(provenance.run),String(runId));assert.equal(candidateName,`native-candidate-${provenance.commit}`);
  assert(/^[a-f0-9]{40}$/.test(provenance.tree));assert.equal(provenance.tree,originTree);
  assert.equal(originRun.head_sha,provenance.commit);assert.equal(String(originRun.id),String(runId));
  assert.equal(originRun.path,'.github/workflows/native-vsix.yml');
  assert.equal(originRun.status,'completed');assert.equal(originRun.conclusion,'success');
  assert(Array.isArray(changed));
  assert.deepEqual(changed.filter(file=>!file.startsWith('test/')&&!['.github/workflows/ci.yml','.github/workflows/native-vsix.yml'].includes(file)),[],
    'Product inputs changed after qualification; create and test a new archive');
  return {version,tag,filename:`perfchecker-vscode-${version}.vsix`,sha256:expectedSha};
}

/** A previous green run must not hide a newer failed, cancelled or active run. */
export function assertGreenReleaseRuns(runs,commit) {
  for(const workflow of ['.github/workflows/ci.yml','.github/workflows/native-vsix.yml']) {
    const latest=runs.filter(run=>run.head_sha===commit&&run.path?.split('@')[0]===workflow).sort((a,b)=>b.id-a.id)[0];
    assert(latest,`Missing qualification: ${workflow}`);
    assert.equal(latest.status,'completed',`Qualification is still active: ${workflow}`);
    assert.equal(latest.conclusion,'success',`Qualification did not pass: ${workflow}`);
  }
}
