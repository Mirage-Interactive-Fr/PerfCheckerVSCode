import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {prepareLiveProvider, liveJuliaArguments, executeLiveProvider} = require('../dist/live-provider.js');
const manifest = 'schema = "etendu-game/1"\nid = "etendu.beautifullandscape"\nentrypoint = "scripts/play.jl"\n';
const qualities = 'schema = "beautiful-landscape-quality/1"\n[profiles.desktop-natif]\nwidth = 1280\nheight = 720\n';
const token = {isCancellationRequested: false, onCancellationRequested: () => ({dispose() {}})};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-live-'));
  await mkdir(path.join(root, 'config'));
  await mkdir(path.join(root, 'perf'));
  await writeFile(path.join(root, 'EtenduGame.toml'), manifest);
  await writeFile(path.join(root, 'config', 'quality.toml'), qualities);
  await writeFile(path.join(root, 'perf', 'live_provider.jl'), 'exit(1)\n');
  return root;
}

test('live provider requires the exact workspace quality and an owned provider', async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'perfchecker-live-other-'));
  try {
    const prepared = await prepareLiveProvider(root, 'desktop-natif');
    assert.equal(prepared.root, root);
    assert.equal(prepared.quality, 'desktop-natif');
    assert.match(prepared.qualityDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(liveJuliaArguments({...prepared, controller:'/controller',
      julia:'julia', reports:'/reports'}).slice(-6),
      [root, prepared.provider, 'desktop-natif', '/reports', prepared.qualityDigest, 'julia']);
    await assert.rejects(prepareLiveProvider(root, '../other'), /quality slug/);
    await assert.rejects(prepareLiveProvider(root, 'mobile-leger'), /missing or duplicated/);
    await writeFile(path.join(root, 'config', 'quality.toml'), qualities + '[profiles.desktop-natif]\n');
    await assert.rejects(prepareLiveProvider(root, 'desktop-natif'), /missing or duplicated/);
    await writeFile(path.join(root, 'config', 'quality.toml'), qualities);
    await rm(path.join(root, 'perf', 'live_provider.jl'));
    await writeFile(path.join(outside, 'provider.jl'), 'exit(1)\n');
    const {symlink} = await import('node:fs/promises');
    await symlink(path.join(outside, 'provider.jl'), path.join(root, 'perf', 'live_provider.jl'));
    await assert.rejects(prepareLiveProvider(root, 'desktop-natif'), /escapes its workspace/);
    await writeFile(path.join(root, 'EtenduGame.toml'), manifest.replace('etendu.beautifullandscape','other.game'));
    await assert.rejects(prepareLiveProvider(root, 'desktop-natif'), /does not declare/);
  } finally {
    await rm(root, {recursive:true, force:true});
    await rm(outside, {recursive:true, force:true});
  }
});

test('live provider archives a real RC bundle without a GPU', {
  skip: !process.env.PERFCHECKER_TEST_CONTROLLER,
}, async () => {
  const root = await fixture();
  const reports = path.join(root, 'perf', 'results', 'live');
  const payload = quality => ({
    schema_version: 'perfchecker-provider-result/1',
    suite: 'etendu-beautiful-landscape-live', case_id: 'summit-views',
    started_at: '2026-09-27T10:00:00Z', finished_at: '2026-09-27T10:01:00Z',
    runtime: {language: 'julia', version: '1.13.0'},
    environment: {quality_profile: quality, width: 1280, height: 720,
      resolution_source: 'fixed', hardware: {cpu_name: 'fixture CPU', gpu_name: 'unavailable'},
      gpu_timing: 'unavailable', physical_presentation: 'unavailable',
      timing_boundary: 'after SDL_SubmitGPUCommandBuffer; not physical display scanout',
      scene_sha256: 'a'.repeat(64),
      scene_file_changed_during_run: false},
    measurement_definitions: [
      {id:'landscape.cpu.p95/live-v1', metric:'landscape.cpu.p95', unit:'ms'},
      {id:'landscape.submit_interval.p95/live-v1', metric:'landscape.submit_interval.p95', unit:'ms'},
    ],
    observations: [
      {metric:'landscape.cpu.p95', measurement_definition:'landscape.cpu.p95/live-v1', unit:'ms', value:16.2},
      {metric:'landscape.submit_interval.p95', measurement_definition:'landscape.submit_interval.p95/live-v1', unit:'ms', value:16.8},
    ],
  });
  try {
    const prepared = await prepareLiveProvider(root, 'desktop-natif');
    const valid = JSON.stringify(payload('desktop-natif'));
    await writeFile(prepared.provider,
      `write(ENV["PERFCHECKER_OUTPUT"], ${JSON.stringify(valid)})\n`);
    const input = {...prepared, controller:process.env.PERFCHECKER_TEST_CONTROLLER,
      julia:process.env.PERFCHECKER_TEST_JULIA ?? 'julia', reports};
    const directory = await executeLiveProvider(input, token, () => {});
    assert.match(directory, /\/perf\/results\/live\/run-[0-9a-f-]{36}$/);
    const bundled = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    assert.equal(bundled.state, 'complete');
    assert.equal(bundled.environment.quality_profile, 'desktop-natif');
    assert.equal(bundled.environment.hardware.gpu_name, 'unavailable');
    assert.equal(bundled.environment.physical_presentation, 'unavailable');
    assert.equal((await readdir(reports)).length, 1);
    const observations = await readFile(path.join(directory, 'observations.jsonl'), 'utf8');
    assert.match(observations, /landscape\.cpu\.p95/);
    assert.match(observations, /landscape\.submit_interval\.p95/);
    assert.doesNotMatch(observations, /fps|gpu\.time/i);
    await writeFile(prepared.provider, 'exit(1)\n');
    await assert.rejects(executeLiveProvider(input, token, () => {}), /failed/);
    assert.equal((await readdir(reports)).length, 1);
    await assert.rejects(executeLiveProvider(input, {...token, isCancellationRequested:true}, () => {}), /cancelled/);
    assert.equal((await readdir(reports)).length, 1);
    await writeFile(prepared.provider, 'sleep(30)\n');
    const cancellation = new EventEmitter();
    const duringRun = {isCancellationRequested:false,
      onCancellationRequested:listener => {
        cancellation.on('cancel', listener);
        return {dispose:()=>cancellation.off('cancel', listener)};
      }};
    const interrupted = executeLiveProvider(input, duringRun, () => {});
    setTimeout(() => {duringRun.isCancellationRequested=true;cancellation.emit('cancel');}, 300);
    await assert.rejects(interrupted, /cancelled/);
    assert.equal((await readdir(reports)).length, 1);
    await writeFile(prepared.provider, `write(ENV["PERFCHECKER_OUTPUT"], ${JSON.stringify(JSON.stringify(payload('mobile-leger')))})\n`);
    await assert.rejects(executeLiveProvider(input, token, () => {}), /quality mismatch/);
    assert.equal((await readdir(reports)).length, 1);
    await writeFile(path.join(root, 'config', 'quality.toml'), qualities + '\n# changed\n');
    await assert.rejects(executeLiveProvider(input, token, () => {}), /render quality changed/);
    assert.equal((await readdir(reports)).length, 1);
  } finally { await rm(root, {recursive:true, force:true}); }
});
