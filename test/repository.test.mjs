import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('Marketplace identity remains stable after repository extraction', () => {
  assert.equal(manifest.publisher, 'mirage-interactive-fr');
  assert.equal(manifest.name, 'perfchecker-vscode');
});

test('repository metadata targets the standalone extension repository', () => {
  assert.equal(manifest.repository.url,
    'https://github.com/Mirage-Interactive-Fr/PerfCheckerVSCode.git');
  assert.equal(manifest.repository.directory, undefined);
});
