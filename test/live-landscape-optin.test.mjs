import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile, unlink, realpath} from 'node:fs/promises';
import path from 'node:path';

// Opt-in integration against the real private game, never a generated provider.
// Prepare a disposable Xvfb DISPLAY, the Landscape v0.1.0 checkout with its 143
// checked-out LFS objects, and a worker Manifest resolving the five SDK v0.1.1
// source archives below. Keep Project.toml byte-identical to the game tag.
// PERFCHECKER_LIVE_WORKSPACE: that disposable game checkout.
// PERFCHECKER_LIVE_CONTROLLER: a separate environment containing PerfChecker.
// PERFCHECKER_LIVE_JULIA: Julia executable (defaults to julia).
// No credentials are copied, printed or prepared by this test. The caller owns
// the display and temporary environments and must remove them after execution.
// Run after compilation: node --test test/live-landscape-optin.test.mjs
const require = createRequire(import.meta.url);
const gameCommit = 'dc8124a0cc35977ca26316450e8b688abd6ab6b8';
const sdk = {
  EtenduContracts: ['0a129097a06ce36b10657e901a6039d2588a8042', 'efc4e7ed302b253142b20b7dbe2f2f592d3ec4cfe8ebf5dfc7ee16608e6bebd0'],
  EtenduNativeArtifacts: ['9ae20356d9205d6c74b70bcb0996752d20c12c6c', 'f59124db09e24551e4dcebb3b9eb6c2e97fc85f8760635290518540369e88979'],
  EtenduRender: ['884493d4fc9ac0188d2399eef1dd77410b423ef3', '5818e9e543b206c54bd7d026ae0a1cbfec10772022c966fa0b85b47cfd939e5f'],
  EtenduRuntime: ['f848c18a144e2cc8cae9c7dcf102de943aad21cc', '9e7021f0d9c1c2d68aeeef1fece7a5cba00ceb5f75c23a0a8c3b1df80470cf09'],
  EtenduSDLGPU: ['d0455b1dcbefcd1cc8b6085f341c18f5a13115c7', '9171345a5675fb750af010dc023f4872fa72dded07fd16c4840a330c14ce9dcc'],
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checkedCommand = (file, args, options = {}) => execFileSync(file, args,
  {encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000, ...options});
const token = () => {
  const listeners = new Set();
  return {isCancellationRequested: false,
    onCancellationRequested(fn) {listeners.add(fn); return {dispose() {listeners.delete(fn);}};},
    cancel() {if (this.isCancellationRequested) return; this.isCancellationRequested = true;
      for (const listener of listeners) listener();}};
};

async function sourceDigest(root, relative = '') {
  const records = [];
  for (const entry of (await readdir(path.join(root, relative), {withFileTypes: true}))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) records.push(...await sourceDigest(root, name));
    else {assert.ok(entry.isFile(), 'SDK source must contain regular files');
      records.push(name + '\0' + digest(await readFile(path.join(root, name))) + '\0');}
  }
  return records;
}

async function proc(pid) {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
  if (!text) return null;
  const fields = text.slice(text.lastIndexOf(') ') + 2).trim().split(/\s+/);
  return {state: fields[0], started: fields[19]};
}

async function trackTree(pid, tracked) {
  const identity = await proc(pid);
  if (!identity) return;
  tracked.set(pid, identity.started);
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => ''))
    .trim().split(/\s+/).filter(Boolean).map(Number);
  for (const child of children) await trackTree(child, tracked);
}

async function livePids(tracked) {
  const found = [];
  for (const [pid, started] of tracked) {
    const current = await proc(pid);
    if (current?.started === started && current.state !== 'Z') found.push(pid);
  }
  return found;
}

async function memFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    if (entry.name === '.git') continue;
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await memFiles(root, name));
    else if (entry.name.endsWith('.mem')) files.push(name);
  }
  return files.sort();
}

function frame(display) {
  const tree = checkedCommand('xwininfo', ['-display', display, '-root', '-tree'], {timeout: 5000});
  const window = tree.match(/(0x[0-9a-f]+) "Beautiful Landscape/);
  if (!window) return null;
  const dump = checkedCommand('xwd', ['-display', display, '-id', window[1], '-silent'],
    {encoding: 'buffer', maxBuffer: 5_000_000, timeout: 5000});
  const header = Array.from({length: 25}, (_, i) => dump.readUInt32BE(4 * i));
  assert.equal(header[1], 7); assert.equal(header[4], 960); assert.equal(header[5], 540);
  assert.equal(header[11], 32);
  const pixels = dump.subarray(header[0] + 12 * header[19]);
  const colors = new Set();
  for (let i = 0; i + 4 <= pixels.length; i += 4 * 13)
    colors.add((header[7] === 0 ? pixels.readUInt32LE(i) : pixels.readUInt32BE(i)) & 0xffffff);
  return colors.size < 100 ? null : {sha256: digest(pixels), sampledColors: colors.size};
}

test('real Landscape bridge completes, then cancels active rendering without orphaned workers',
  {skip: !process.env.PERFCHECKER_LIVE_WORKSPACE, timeout: 360_000}, async () => {
    assert.equal(process.platform, 'linux', 'This opt-in oracle uses Linux process and X11 inspection');
    const root = await realpath(process.env.PERFCHECKER_LIVE_WORKSPACE);
    assert.ok(root.startsWith('/tmp/'), 'Use a disposable game checkout, not a user source tree');
    const controller = await realpath(process.env.PERFCHECKER_LIVE_CONTROLLER);
    const julia = process.env.PERFCHECKER_LIVE_JULIA || 'julia';
    const display = process.env.DISPLAY;
    assert.match(display || '', /^:\d+(?:\.\d+)?$/, 'Prepare an isolated Xvfb DISPLAY');
    const git = args => checkedCommand('git', args, {cwd: root}).trim();
    assert.equal(git(['rev-parse', 'HEAD']), gameCommit);
    assert.equal(git(['diff', '--name-only', gameCommit, '--', 'Project.toml', 'EtenduGame.toml',
      'src', 'content/scenes', 'config/quality.toml', 'perf/live_provider.jl', 'perf/live_measure.jl']), '');
    const lfs = JSON.parse(git(['lfs', 'ls-files', '--json'])).files;
    assert.equal(lfs.length, 143);
    let lfsBytes = 0;
    for (const item of lfs) {
      const bytes = await readFile(path.join(root, item.name));
      assert.equal(bytes.length, item.size); assert.equal(digest(bytes), item.oid);
      lfsBytes += bytes.length;
    }
    assert.equal(lfsBytes, 384_633_618);

    const workerCode = `using EtenduBeautifulLandscape, EtenduContracts, EtenduNativeArtifacts,
EtenduRender, EtenduRuntime, EtenduSDLGPU, JSON3
println("LIVE_WORKER " * JSON3.write([Dict("name"=>string(nameof(m)),
"version"=>string(Base.pkgversion(m)), "root"=>pkgdir(m)) for m in
(EtenduContracts,EtenduNativeArtifacts,EtenduRender,EtenduRuntime,EtenduSDLGPU)]))`;
    const workerOutput = checkedCommand(julia, ['--startup-file=no', '--history-file=no',
      `--project=${root}`, '-e', workerCode]);
    const resolved = JSON.parse(workerOutput.match(/^LIVE_WORKER (.+)$/m)[1]);
    assert.equal(resolved.length, 5);
    for (const dependency of resolved) {
      assert.equal(dependency.version, '0.1.1'); assert.ok(sdk[dependency.name]);
      assert.equal(digest((await sourceDigest(dependency.root)).join('')), sdk[dependency.name][1],
        `SDK source differs from tag ${sdk[dependency.name][0]}`);
    }
    const coreCode = `using PerfChecker, SHA
println("LIVE_CORE " * string(Base.pkgversion(PerfChecker)) * " " *
bytes2hex(sha256(read(joinpath(pkgdir(PerfChecker),"src","protocol.jl")))))`;
    const core = checkedCommand(julia, ['--startup-file=no', '--history-file=no',
      `--project=${controller}`, '-e', coreCode]).match(/^LIVE_CORE (\S+) ([0-9a-f]{64})$/m);
    assert.ok(core, 'Record the actual core version and external-provider source');
    const icd = '/usr/share/vulkan/icd.d/lvp_icd.json';
    process.env.VK_ICD_FILENAMES = icd; process.env.SDL_VIDEODRIVER = 'x11';
    process.env.SDL_GPU_DRIVER = 'vulkan'; process.env.JULIA_NUM_THREADS = '1';
    const vulkan = checkedCommand('vulkaninfo', ['--summary']);
    assert.match(vulkan, /PHYSICAL_DEVICE_TYPE_CPU/); assert.match(vulkan, /llvmpipe/);
    const live = require('../dist/live-provider.js');
    const prepared = await live.prepareLiveProvider(root, 'mobile-leger');
    const scenePath = path.join(root, 'content/scenes/beautiful_landscape.toml');
    const sceneSha256 = digest(await readFile(scenePath));
    const input = {...prepared, controller, julia, reports: path.join(root, 'perf/results/live')};
    const beforeMem = await memFiles(root);
    const events = [];
    const originalSpawn = childProcess.spawn;
    let owned;
    const tracked = new Map();
    childProcess.spawn = (file, args, options) => {
      const child = originalSpawn(file, args, options);
      if (file === julia && args.includes('-e')) owned = child;
      return child;
    };
    const tracker = setInterval(() => {if (owned) void trackTree(owned.pid, tracked);}, 100);
    const output = text => {events.push(text); if (events.length > 2000) events.shift();};
    let cancellation;
    const sentinel = path.join(root, `unrelated-${process.pid}.mem`);
    try {
      const positiveToken = token();
      const deadline = setTimeout(() => positiveToken.cancel(), 180_000);
      let directory;
      try {directory = await live.executeLiveProvider(input, positiveToken, output);}
      finally {clearTimeout(deadline);}
      const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
      const integrity = JSON.parse(await readFile(path.join(directory, 'integrity.json'), 'utf8'));
      assert.equal(integrity.schema_version, 'perfchecker-bundle-integrity/1');
      assert.equal(integrity.algorithm, 'sha256');
      assert.equal(integrity.files.length, 5);
      assert.deepEqual(new Set(integrity.files.map(file => file.path)), new Set([
        'manifest.json', 'measurement-definitions.json', 'observations.jsonl', 'diagnostics.jsonl', 'artifacts.json']));
      for (const file of integrity.files) {
        const bytes = await readFile(path.join(directory, file.path));
        assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.sha256);
      }
      const observations = (await readFile(path.join(directory, 'observations.jsonl'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line));
      assert.equal(manifest.state, 'complete');
      assert.equal(manifest.suite, 'etendu-beautiful-landscape-live');
      const environment = manifest.environment;
      assert.equal(environment.quality_profile, 'mobile-leger');
      assert.equal(environment.width, 960); assert.equal(environment.height, 540);
      assert.equal(environment.requested_frames, 60); assert.equal(environment.warmup_frames, 20);
      assert.equal(environment.measured_submissions, 40);
      assert.equal(environment.scene_sha256, sceneSha256);
      assert.equal(environment.scene_file_changed_during_run, false);
      assert.equal(environment.hardware.gpu_driver, 'vulkan');
      assert.equal(environment.gpu_timing, 'unavailable');
      assert.equal(environment.physical_presentation, 'unavailable');
      assert.equal(observations.length, 6);
      assert.deepEqual(new Set(observations.map(o => o.metric)), new Set(['cpu', 'submit_interval']
        .flatMap(kind => ['median', 'p95', 'p99'].map(statistic => `landscape.${kind}.${statistic}`))));
      for (const observation of observations) {
        assert.equal(observation.unit, 'ms'); assert.ok(Number.isFinite(observation.value) && observation.value >= 0);
      }
      assert.equal(digest(await readFile(path.join(root, 'config/quality.toml'))), prepared.qualityDigest);
      assert.equal(digest(await readFile(scenePath)), sceneSha256);
      assert.deepEqual(await memFiles(root), beforeMem);
      assert.deepEqual(await livePids(tracked), []);
      const reports = await readdir(input.reports);
      await writeFile(sentinel, 'unrelated trace must survive cancellation\n', {flag: 'wx'});
      const sentinelDigest = digest(await readFile(sentinel));
      tracked.clear(); owned = undefined; cancellation = token();
      const settled = live.executeLiveProvider(input, cancellation, output)
        .then(directory => ({ok: true, directory}), error => ({ok: false, error: String(error)}));
      let first, changed;
      for (let attempt = 0; attempt < 150; attempt++) {
        await sleep(500);
        if (owned) await trackTree(owned.pid, tracked);
        const current = frame(display);
        if (!current) continue;
        if (!first) first = current;
        else if (current.sha256 !== first.sha256) {changed = current; break;}
      }
      assert.ok(changed, 'Cancellation needs two different actual rendered scene buffers');
      assert.ok(tracked.size >= 2, 'Observe both controller and real rendering provider');
      const cancelledAt = new Date().toISOString(); cancellation.cancel();
      const outcome = await settled;
      assert.equal(outcome.ok, false); assert.match(outcome.error, /cancelled/i);
      for (let i = 0; i < 30 && (await livePids(tracked)).length; i++) await sleep(100);
      const remaining = await livePids(tracked);
      const cancelledReportsUnchanged = JSON.stringify(await readdir(input.reports)) === JSON.stringify(reports);
      const unrelatedMemPreserved = digest(await readFile(sentinel)) === sentinelDigest;
      console.log(JSON.stringify({scope: 'software bridge, no native command-click or physical GPU claim',
        gameCommit, lfsFiles: lfs.length, lfsBytes, coreVersion: core[1], protocolSha256: core[2],
        sdk: resolved.map(d => ({name: d.name, tagCommit: sdk[d.name][0]})), sceneSha256,
        qualitySha256: prepared.qualityDigest, measuredSubmissions: environment.measured_submissions,
        observations, cancelledAt, inspectedAt: new Date().toISOString(),
        changedSceneBuffers: true, sampledColors: changed.sampledColors,
        bundleIntegrityDocuments: integrity.files.length, cancelledReportsUnchanged, unrelatedMemPreserved,
        pids: [...tracked.keys()], aliveBeforeDisplayShutdown: remaining,
        controllerOutputTail: events.join('').slice(-1600)}));
      assert.deepEqual(remaining, [], 'Rendering provider must exit before the caller closes Xvfb');
      assert.equal(cancelledReportsUnchanged, true, 'Cancelled work must not publish completed evidence');
      assert.equal(unrelatedMemPreserved, true);
      await unlink(sentinel);
      assert.deepEqual(await memFiles(root), beforeMem);
    } finally {
      clearInterval(tracker); cancellation?.cancel(); childProcess.spawn = originalSpawn;
      const leftovers = await livePids(tracked);
      for (const pid of leftovers) {try {process.kill(pid, 'SIGTERM');} catch {}}
      if (leftovers.length) await sleep(2000);
      for (const pid of await livePids(tracked)) {try {process.kill(pid, 'SIGKILL');} catch {}}
      await unlink(sentinel).catch(error => {if (error.code !== 'ENOENT') throw error;});
      console.log(JSON.stringify({bankCleanupAt: new Date().toISOString(), terminatedOwnedPids: leftovers,
        survivingOwnedPids: await livePids(tracked)}));
    }
  });
