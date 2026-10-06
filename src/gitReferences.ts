import {spawn} from 'node:child_process';
import {stat} from 'node:fs/promises';
import * as path from 'node:path';

export interface GitReferenceOption {
  kind: 'branch' | 'remote' | 'tag' | 'commit';
  label: string; revision: string; commit: string; detail: string;
}
export interface GitDiscoveryOptions {signal?: AbortSignal; timeoutMs?: number}
const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const remoteSource = /^(?:https?|ssh|git):\/\/|^git@[^:]+:/i;

/** Discovery never opens an authentication dialog and always has a deadline. */
export async function gitReferenceCommand(args: string[], cwd: string, options: GitDiscoveryOptions = {}): Promise<string> {
  if (options.signal?.aborted) throw new Error('Git discovery cancelled. Refresh to try again.');
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['-c', 'credential.interactive=never', ...args], {cwd, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never',
        GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND || 'ssh'} -o BatchMode=yes -o ConnectTimeout=10`}});
    let output = '', error = '', stopped: Error | undefined;
    const stop = (reason: Error) => {
      if (stopped || child.exitCode !== null || child.signalCode !== null) return;
      stopped = reason;
      if (!child.pid) return;
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true})
        .on('error', () => child.kill('SIGKILL'));
      else {try {process.kill(-child.pid, 'SIGKILL');} catch {child.kill('SIGKILL');}}
    };
    const abort = () => stop(new Error('Git discovery cancelled. Refresh to try again.'));
    const timer = setTimeout(() => stop(new Error('Git discovery timed out. Check repository access, then refresh to retry.')),
      options.timeoutMs ?? 15000);
    options.signal?.addEventListener('abort', abort, {once: true});
    const finish = () => {clearTimeout(timer); options.signal?.removeEventListener('abort', abort);};
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => {
      output += value;
      if (Buffer.byteLength(output) > 4_000_000) stop(new Error('Git discovery exceeded 4 MB. Use an explicit commit instead.'));
    });
    child.stderr.on('data', value => {error = (error + value).slice(-8000);});
    child.once('error', value => {finish(); reject(value);});
    child.once('close', code => {
      finish();
      if (stopped) reject(stopped);
      else if (code === 0) resolve(output);
      else reject(new Error(`${error.trim() || `Git discovery failed (exit ${code}).`} Authenticate Git outside PerfChecker, then refresh.`));
    });
    if (options.signal?.aborted) abort();
  });
}

export async function discoverGitReferences(source: string, cwd: string, options: GitDiscoveryOptions = {}): Promise<{
  repository: string; options: GitReferenceOption[];
}> {
  const entries: GitReferenceOption[] = [];
  const deadline = Date.now() + (options.timeoutMs ?? 15000);
  const run = (args: string[], root: string) => gitReferenceCommand(args, root,
    {...options, timeoutMs: Math.max(1, deadline - Date.now())});
  if (remoteSource.test(source)) {
    const output = await run(['ls-remote', '--heads', '--tags', '--', source], cwd);
    const refs = new Map(output.split(/\r?\n/).map(line => line.trim().split(/\s+/, 2)).filter(([sha, ref]) => objectId.test(sha) && ref).map(([sha, ref]) => [ref, sha]));
    for (const [ref, sha] of refs) {
      const match = ref.match(/^refs\/(heads|tags)\/(.+?)(\^\{\})?$/);
      if (!match || match[3]) continue;
      const kind = match[1] === 'heads' ? 'branch' : 'tag', commit = refs.get(`${ref}^{}`) ?? sha;
      entries.push({kind, label: `${kind}: ${match[2]}`, revision: ref, commit, detail: commit.slice(0, 12)});
    }
    return {repository: source, options: entries};
  }
  const local = path.resolve(cwd, source), info = await stat(local);
  const repository = (await run(['rev-parse', '--show-toplevel'], info.isDirectory() ? local : path.dirname(local))).trim();
  const refs = await run(['for-each-ref', '--sort=-committerdate',
    '--format=%(refname)%09%(objectname)%09%(*objectname)%09%(objecttype)%09%(*objecttype)%09%(symref)%09%(subject)',
    'refs/heads', 'refs/remotes', 'refs/tags'], repository);
  for (const line of refs.split(/\r?\n/)) {
    const [ref, sha, peeled, type, peeledType, symbolic, ...subject] = line.split('\t');
    const match = ref?.match(/^refs\/(heads|remotes|tags)\/(.+)$/);
    if (!match || symbolic || !objectId.test(sha)) continue;
    const commit = type === 'tag' && peeledType === 'tag' ?
      (await run(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], repository)).trim() :
      type === 'tag' && peeledType === 'commit' ? peeled : type === 'commit' ? sha : '';
    if (!objectId.test(commit)) continue;
    const kind = match[1] === 'heads' ? 'branch' : match[1] === 'tags' ? 'tag' : 'remote';
    entries.push({kind, label: `${kind}: ${match[2]}`, revision: ref, commit,
      detail: [commit.slice(0, 12), subject.join('\t')].filter(Boolean).join(' · ')});
  }
  const commits = await run(['log', '-25', '--pretty=format:%H%x09%h%x09%s'], repository);
  for (const line of commits.split(/\r?\n/)) {
    const [commit, short, ...subject] = line.split('\t');
    if (objectId.test(commit)) entries.push({kind: 'commit', label: short, revision: commit, commit, detail: subject.join('\t')});
  }
  return {repository, options: entries};
}

/** Resolve exact namespaces before saving; ambiguous short names cannot silently change the target. */
export async function resolveGitRevision(source: string, cwd: string, revision: string, options: GitDiscoveryOptions = {}): Promise<string> {
  if (objectId.test(revision)) return revision;
  const catalog = await discoverGitReferences(source, cwd, options);
  const matching = catalog.options.filter(entry => entry.revision === revision ||
    (!revision.startsWith('refs/') && entry.revision.replace(/^refs\/(?:heads|tags|remotes)\//, '') === revision));
  if (matching.length > 1) throw new Error(`Ambiguous Git reference ${revision}. Choose the complete branch, tag or remote reference.`);
  if (matching.length === 1) return matching[0].commit;
  if (remoteSource.test(source)) throw new Error('Git reference not advertised by this repository. Choose a discovered reference or an explicit full commit.');
  return (await gitReferenceCommand(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], catalog.repository, options)).trim();
}
