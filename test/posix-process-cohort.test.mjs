import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import {runInNewContext} from 'node:vm';

const require = createRequire(import.meta.url);
const filename = new URL('../dist/posixProcessCohort.js', import.meta.url);
const source = await readFile(filename, 'utf8');

// Execute the real compiled module with controlled kernel reads. No process is
// spawned, and the changed final stat is delivered exactly after the first exe.
function fixture(platform, variant) {
  const pid = 41000, parent = 40000, birth = platform === 'linux' ? '123456' : 'Sat Oct 10 18:00:00 2026';
  const image = '/private/test-codex', signals = [], calls = [];
  const initial = {pid, parent, group: pid, session: platform === 'linux' ? pid : 'ffff0001', start: birth, state: 'R'};
  const changed = {...initial};
  if (variant.startsWith('dead')) {changed.state = variant === 'dead-x' ? 'X' : 'Z'; changed.parent = 1; changed.group++; changed.session = platform === 'linux' ? pid + 1 : 'ffff0002';}
  if (variant === 'live-reparent') changed.parent = 1;
  if (variant.includes('reused')) changed.start = platform === 'linux' ? '123457' : 'Sat Oct 10 18:00:01 2026';
  if (variant === 'invalid-parent') changed.parent = 'invalid';
  let statReads = 0, exeReads = 0;
  const unavailable = () => Object.assign(new Error('Controlled unavailable executable.'), {code: 'EACCES'});
  const linuxStat = row => {
    const fields = Array(20).fill('0');
    [fields[0], fields[1], fields[2], fields[3], fields[19]] = [row.state, row.parent, row.group, row.session, row.start];
    return `${pid} (fixture) ${fields.join(' ')}\n`;
  };
  const filesystem = {
    readdir: async () => [String(pid)],
    readFile: async value => {
      assert.equal(value, `/proc/${pid}/stat`); calls.push('stat');
      return linuxStat(++statReads === 1 ? initial : changed);
    },
    realpath: async value => {
      calls.push('exe'); exeReads++;
      assert.equal(value, platform === 'linux' ? `/proc/${pid}/exe` : image);
      if (variant.includes('unavailable')) throw unavailable();
      return variant === 'changed-exe' && exeReads > 1 ? image + '-changed' : image;
    },
  };
  const execFile = () => {throw new Error('No native command is allowed in this deterministic fixture.');};
  execFile[promisify.custom] = async (command, args) => {
    if (command === '/usr/sbin/lsof') {
      calls.push('lsof');
      if (variant.includes('unavailable')) throw unavailable();
      return {stdout: 'n' + image + '\n'};
    }
    assert.equal(command, '/bin/ps'); calls.push('ps');
    if (args.includes('pid=,ppid=,pgid=,sess=,stat=,lstart=')) {
      const row = args[0] === '-axo' ? initial : changed;
      return {stdout: `${pid} ${row.parent} ${row.group} ${row.session} ${row.state} ${row.start}\n`};
    }
    assert.deepEqual(Array.from(args), ['-p', String(pid), '-o', 'pid=,stat=,lstart=']);
    return {stdout: `${pid} ${changed.state} ${changed.start}\n`};
  };
  const sandbox = {exports: {}, process: {pid: parent, platform, kill: (...args) => signals.push(args)},
    require: name => name === 'node:fs/promises' ? filesystem : name === 'node:child_process' ? {execFile} : require(name)};
  runInNewContext(source, sandbox, {filename: filename.pathname});
  const cohort = new sandbox.exports.PosixProcessCohort({pid}, true);
  return {cohort, initial, changed, image, calls, signals};
}

for (const platform of ['linux', 'darwin']) {
  for (const variant of ['dead-z', 'dead-x', 'dead-unavailable']) {
    test(`${platform} observes ${variant} with the same birth before considering reparenting`, async () => {
      const f = fixture(platform, variant);
      assert.equal((await f.cohort.observe(true)).length, 0);
      assert.equal(f.cohort.known.size, 0, 'A dead incarnation is never adopted.');
      assert.equal(f.cohort.groups.size, 0);
      assert.deepEqual(f.signals, []);
      if (variant !== 'dead-unavailable') {
        assert.equal(f.calls.filter(call => call === 'exe').length, 1, 'No second executable read is required after death.');
        if (platform === 'darwin') assert.equal(f.calls.filter(call => call === 'ps').length, 2, 'No third ps recovery read is needed.');
      }
    });
  }
  for (const variant of ['live-reparent', 'live-reused', 'dead-reused', 'live-unavailable', 'dead-reused-unavailable', 'changed-exe', 'invalid-parent']) {
    test(`${platform} refuses ${variant} without acquiring signal authority`, async () => {
      const f = fixture(platform, variant);
      await assert.rejects(f.cohort.observe(true), error => {
        assert.match(error.message, /identity|executable/i);
        if (platform === 'linux' || !variant.includes('unavailable')) {
          assert.equal(error.cause?.kind, 'process-identity');
          assert.equal(error.cause.platform, platform);
          assert.equal(error.cause.initial, true);
          assert.equal(error.cause.expected.pid, f.initial.pid);
          assert.equal(error.cause.expected.start, f.initial.start);
        }
        if (platform === 'linux' && variant === 'live-reparent') {
          assert.equal(error.message, 'Process identity changed while inspecting.', 'UI text stays concise.');
          assert.equal(error.cause.observed.parent, 1);
          assert.equal(error.cause.observed.state, 'R');
          assert.equal(error.cause.executable, f.image);
        }
        return true;
      });
      assert.equal(f.cohort.known.size, 0);
      assert.equal(f.cohort.groups.size, 0);
      assert.deepEqual(f.signals, []);
    });
  }
}

test('passive native refusal observation keeps the original outcome and only safe cause fields', async () => {
  const {observeIdentityRefusals} = require('./codex-vscode-host.cjs');
  const records = [], value = {pid: 42};
  const failure = new Error('Process identity changed while inspecting.', {cause: {
    kind: 'process-identity', platform: 'linux', initial: true,
    expected: {pid: 42, start: '7', secret: 'must not retain'}, observed: {pid: 42, start: '7', state: 'Z'},
    executable: '/private/cli', errno: 'EACCES', token: 'must not retain',
  }});
  class Cohort {child = {spawnargs: ['/private/cli', '--version']}; async identity(reject) {if (reject) throw failure; return value;}}
  const original = Cohort.prototype.identity, stop = observeIdentityRefusals(Cohort, record => records.push(record));
  try {
    assert.equal(await new Cohort().identity(false), value); assert.deepEqual(records, []);
    await assert.rejects(new Cohort().identity(true), error => error === failure);
    assert.equal(records.length, 1); assert.equal(records[0].stage, 'version');
    assert.equal(records[0].cause.observed.state, 'Z');
    assert(!JSON.stringify(records).includes('must not retain'));
  } finally {stop();}
  assert.equal(Cohort.prototype.identity, original);
  const failedObserver = observeIdentityRefusals(Cohort, () => {throw new Error('Controlled observer failure.');});
  try {await assert.rejects(new Cohort().identity(true), error => error === failure); assert.equal(failedObserver.failures.length, 1);}
  finally {failedObserver();}
});
