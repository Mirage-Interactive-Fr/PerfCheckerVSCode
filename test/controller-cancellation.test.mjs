import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {cancellableJulia, controllerCancellation} from '../dist/controllerCancellation.js';

const julia = process.env.PERFCHECKER_TEST_JULIA;
test('portable stdin cancellation unwinds Julia cleanup, preserves failure and bounds forced stop', {skip: !julia}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'perfchecker-stdin-cancel-'));
  try {
    for (const mode of ['clean', 'failure', 'forced']) {
      const ready = path.join(root, `${mode}-ready`), cleaned = path.join(root, `${mode}-cleaned`);
      const quote = value => JSON.stringify(value).replaceAll('$', '\\$');
      const operation = mode === 'forced' ? 'while true; nothing; end' : 'sleep(120)';
      const code = `write(${quote(ready)}, "ready"); try; ${operation}; finally; write(${quote(cleaned)}, "cleanup"); ${mode === 'failure' ? 'error("real cleanup failure")' : ''}; end`;
      const child = spawn(julia, ['--startup-file=no', '-e', cancellableJulia(code)], {detached: process.platform !== 'win32'});
      let stderr = ''; child.stderr.on('data', bytes => {stderr += bytes;});
      child.stdout.resume();
      const closed = new Promise((resolve, reject) => {child.once('close', (code, signal) => resolve({code, signal})); child.once('error', reject);});
      const notices = [], stop = controllerCancellation(child, (message, forced) => notices.push({message, forced}), mode === 'forced' ? 100 : 10000);
      try {
        const deadline = Date.now() + 30000;
        while (!(await stat(ready).catch(() => undefined))) {
          if (Date.now() > deadline) throw new Error(`Julia did not start: ${stderr}`);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        stop.request(); stop.request();
        const result = await closed;
        if (mode === 'forced') {assert.equal(stop.forced, true); assert.ok(notices.some(item => item.forced));}
        else {
          assert.equal(stop.forced, false);
          assert.equal(await readFile(cleaned, 'utf8'), 'cleanup');
          assert.equal(result.code, mode === 'clean' ? 130 : 1);
          if (mode === 'failure') assert.match(stderr, /real cleanup failure/);
        }
        assert.equal(notices.filter(item => item.message.startsWith('Cancelling')).length, 1);
      } finally {stop.dispose(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed;}
    }
  } finally {await rm(root, {recursive: true, force: true});}
});
