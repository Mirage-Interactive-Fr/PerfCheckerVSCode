import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {randomUUID, createHash} from 'node:crypto';

async function git(root: string, args: string[], input?: string | Buffer, environment: NodeJS.ProcessEnv = {}): Promise<string> {
  return (await gitBytes(root, args, input, environment)).toString('utf8');
}
async function gitBytes(root: string, args: string[], input?: string | Buffer, environment: NodeJS.ProcessEnv = {}): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const inherited = {...process.env};
    for (const key of Object.keys(inherited)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete inherited[key];
    // The private checkpoint prefix can push otherwise valid workspace paths
    // beyond MAX_PATH. This override applies only to our Git processes.
    const child = spawn('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=',
      ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []), ...args],
      {cwd: root, windowsHide: true, detached: process.platform !== 'win32',
        env: {...inherited, ...environment, GIT_TERMINAL_PROMPT: '0'}});
    const chunks: Buffer[] = []; let size = 0, error = '', exceeded = false;
    const kill = () => {try {if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL');} catch {child.kill('SIGKILL');}};
    const timer = setTimeout(kill, 60000);
    child.stdout.on('data', data => {
      size += data.length;
      if (size > 32_000_000) {exceeded = true; kill();} else chunks.push(data);
    });
    child.stderr.on('data', data => {error = (error + data.toString()).slice(-4000);});
    child.stdin.on('error', () => {/* early command exit is handled below */});
    child.on('error', value => {clearTimeout(timer); reject(value);});
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || exceeded) reject(new Error(exceeded ? 'Implementation diff exceeds 32 MB.' : error || 'Git operation failed or timed out.'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

async function tree(root: string, directory: string, base?: string): Promise<string> {
  const index = path.join(directory, `index-${randomUUID()}`);
  const environment = {GIT_INDEX_FILE: index};
  try {
    if (base) await git(root, ['read-tree', base], undefined, environment);
    else {
      // A copied index retains force-added ignored files and staging metadata.
      // Git commands then update only this copy, including split-index conversion.
      const source = (await git(root, ['rev-parse', '--git-path', 'index'])).trim();
      try {await fs.copyFile(path.resolve(root, source), index);}
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await git(root, ['read-tree', 'HEAD'], undefined, environment);
      }
      await git(root, ['update-index', '--no-split-index'], undefined, environment);
    }
    // A custom clean/smudge/LFS/encoding driver may not round-trip on-disk code.
    // Reject it before `add` can run a filter, including attributes added by the agent.
    const files = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], undefined, environment);
    const attributes = (await git(root, ['check-attr', '-z', '--stdin', 'filter', 'working-tree-encoding', 'ident'], files, environment)).split('\0');
    for (let index = 0; index + 2 < attributes.length; index += 3) {
      if (!['unspecified', 'unset'].includes(attributes[index + 2])) throw new Error('Implementation does not support Git clean/smudge filters, Git LFS, working-tree encodings or ident expansion. The on-disk backup cannot be guaranteed for these files.');
    }
    await git(root, ['add', '--all', '--', '.'], undefined, environment);
    // A performance checkpoint records the bytes on disk, including LF/CRLF
    // mixtures. Git's normal staging conversions must not change that backup.
    const entries = (await git(root, ['ls-files', '--stage', '-z'], undefined, environment)).split('\0').filter(Boolean);
    const rawEntries: string[] = [];
    for (const entry of entries) {
      const separator = entry.indexOf('\t'), metadata = entry.slice(0, separator).split(' '), file = entry.slice(separator + 1);
      if (metadata[0] === '160000') continue; // The existing submodule guard rejects this tree.
      const location = path.resolve(root, file), stat = await fs.lstat(location);
      const bytes = stat.isSymbolicLink() ? Buffer.from(await fs.readlink(location)) : await fs.readFile(location);
      const blob = (await git(root, ['hash-object', '-w', '--no-filters', '--stdin'], bytes)).trim();
      rawEntries.push(`${metadata[0]} ${blob}\t${file}\0`);
    }
    await git(root, ['update-index', '-z', '--index-info'], rawEntries.join(''), environment);
    return (await git(root, ['write-tree'], undefined, environment)).trim();
  } finally {await fs.rm(index, {force: true}); await fs.rm(`${index}.lock`, {force: true});}
}

/** Overrides are confined to private Git metadata, never to the user's repository. */
async function rawCheckoutAttributes(root: string): Promise<string> {
  const attributes = path.join(root, '.git', 'info', 'attributes');
  await fs.mkdir(path.dirname(attributes), {recursive: true});
  await fs.writeFile(attributes, '* -text -filter -working-tree-encoding -ident\n');
  return attributes;
}
async function commit(root: string, value: string, parent: string, message: string) {
  return (await git(root, ['commit-tree', value, '-p', parent], `${message}\n`, {
    GIT_AUTHOR_NAME: 'PerfChecker', GIT_AUTHOR_EMAIL: 'perfchecker@localhost',
    GIT_COMMITTER_NAME: 'PerfChecker', GIT_COMMITTER_EMAIL: 'perfchecker@localhost'
  })).trim();
}

export interface ImplementationProposal {
  repository: string; workspace: string; backupRef: string; candidateRef: string;
  base: string; candidate: string; patch: string; patchBytes: Buffer; lossyPreview: boolean; files: string[]; applied: boolean;
}

function activeReference(workspace: string): string {return `refs/perfchecker/active/${createHash('sha256').update(workspace).digest('hex')}`;}

/** Retain an active recovery pointer even if VS Code's workspace storage is lost. */
export async function saveActiveImplementationProposal(workspace: string, proposal?: ImplementationProposal): Promise<void> {
  workspace = await fs.realpath(workspace);
  let repository: string;
  try {repository = (await git(workspace, ['rev-parse', '--show-toplevel'])).trim();}
  catch (error) {if (!proposal) return; throw error;}
  if (proposal) await git(repository, ['update-ref', activeReference(workspace), proposal.candidate]);
  else await git(repository, ['update-ref', '-d', activeReference(workspace)]);
}

export async function recoverActiveImplementationProposal(workspace: string): Promise<ImplementationProposal | undefined> {
  workspace = await fs.realpath(workspace);
  let repository: string, candidate: string;
  try {
    repository = (await git(workspace, ['rev-parse', '--show-toplevel'])).trim();
    candidate = (await git(repository, ['rev-parse', '--verify', activeReference(workspace)])).trim();
  } catch {return undefined;}
  const refs = (await git(repository, ['for-each-ref', '--format=%(refname)', '--points-at', candidate, 'refs/perfchecker/proposals/'])).trim().split('\n');
  if (!refs[0]) throw new Error('The active implementation proposal reference is missing.');
  return await recoverImplementationProposal(workspace, refs[0].replace('/proposals/', '/checkpoints/'), refs[0], false);
}

/** Rebuild a reviewed proposal after editor restart without storing source or chat text. */
export async function recoverImplementationProposal(workspace: string, backupRef: string, candidateRef: string, applied: boolean): Promise<ImplementationProposal> {
  const id = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (!new RegExp(`^refs/perfchecker/checkpoints/${id}$`).test(backupRef) || candidateRef !== backupRef.replace('/checkpoints/', '/proposals/')) throw new Error('Invalid implementation recovery reference.');
  workspace = await fs.realpath(workspace);
  const repository = await fs.realpath((await git(workspace, ['rev-parse', '--show-toplevel'])).trim());
  const base = (await git(repository, ['rev-parse', '--verify', `${backupRef}^{commit}`])).trim();
  const candidate = (await git(repository, ['rev-parse', '--verify', `${candidateRef}^{commit}`])).trim();
  await validateLinks(repository, candidate);
  const files = (await git(repository, ['diff', '--name-only', '-z', base, candidate])).split('\0').filter(Boolean);
  if (files.some(file => !inside(workspace, path.resolve(repository, file)))) throw new Error('Recovered changes are outside the selected workspace.');
  const patchBytes = await gitBytes(repository, ['diff', '--no-ext-diff', '--no-textconv', '--binary', base, candidate]);
  const patch = patchBytes.toString('utf8'), lossyPreview = !Buffer.from(patch).equals(patchBytes);
  // The editor may have stopped between apply and metadata persistence.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'perfchecker-recovery-'));
  try {
    const current = await tree(repository, directory, applied ? candidate : base);
    if (current === (await git(repository, ['rev-parse', `${base}^{tree}`])).trim()) applied = false;
    else if (current === (await git(repository, ['rev-parse', `${candidate}^{tree}`])).trim()) applied = true;
  } finally {await fs.rm(directory, {recursive: true, force: true});}
  return {repository, workspace, backupRef, candidateRef, base, candidate, patch, patchBytes, lossyPreview, files, applied};
}

function inside(root: string, location: string): boolean {
  const relative = path.relative(root, location);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** A checkout must not inherit links that allow ordinary file edits outside it. */
async function validateLinks(root: string, value: string): Promise<void> {
  const entries = (await git(root, ['ls-tree', '-r', '-z', value])).split('\0').filter(Boolean);
  for (const entry of entries) {
    const separator = entry.indexOf('\t'), metadata = entry.slice(0, separator).split(' '), file = entry.slice(separator + 1);
    if (metadata[0] === '160000') throw new Error('Implementation checkpoints do not yet support Git submodules.');
    if (metadata[0] !== '120000') continue;
    const target = await git(root, ['cat-file', 'blob', metadata[2]]);
    if (path.isAbsolute(target) || !inside(root, path.resolve(root, path.dirname(file), target))) throw new Error('Implementation does not support absolute symlinks or symlinks pointing outside the isolated repository.');
  }
}

/** Snapshot dirty and non-ignored untracked files without touching HEAD or the real index. */
export async function createImplementationCheckout(workspace: string) {
  workspace = await fs.realpath(workspace);
  const repository = await fs.realpath((await git(workspace, ['rev-parse', '--show-toplevel'])).trim());
  if (!inside(repository, workspace)) throw new Error('The selected workspace is outside its Git repository.');
  const baseHead = (await git(repository, ['rev-parse', '--verify', 'HEAD'])).trim();
  if ((await git(repository, ['ls-files', '--unmerged'])).trim()) throw new Error('Resolve Git conflicts before asking for implementation.');
  if ((await git(repository, ['ls-files', '--stage'])).split('\n').some(line => line.startsWith('160000 '))) {
    throw new Error('Implementation checkpoints do not yet support Git submodules.');
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'perfchecker-implementation-'));
  const id = randomUUID();
  const backupRef = `refs/perfchecker/checkpoints/${id}`, candidateRef = `refs/perfchecker/proposals/${id}`;
  try {
    const baseTree = await tree(repository, directory);
    await validateLinks(repository, baseTree);
    const base = await commit(repository, baseTree, baseHead, 'PerfChecker checkpoint before MCP implementation');
    await git(repository, ['update-ref', backupRef, base]);
    const checkout = path.join(directory, 'checkout'); await fs.mkdir(checkout);
    await git(checkout, ['init', '--quiet']);
    await git(checkout, ['config', 'core.hooksPath', path.join(directory, 'disabled-hooks')]);
    await git(checkout, ['config', 'core.autocrlf', 'false']);
    // tree() materializes every checkpoint blob. Its private copy needs this
    // commit, not historical promised blobs from a partial-clone ancestor.
    // The original checkpoint still retains its full parent/history.
    await git(checkout, ['fetch', '--quiet', '--no-tags', '--depth=1', repository, backupRef]);
    const attributes = await rawCheckoutAttributes(checkout);
    try {
      await git(checkout, ['checkout', '--quiet', '--detach', base]);
      // Check the private working tree while raw attributes still disable text
      // conversions. An exit-zero checkout must not become a deletion proposal.
      try {await git(checkout, ['diff', '--quiet', '--no-ext-diff', '--no-textconv', base, '--']);}
      catch (error) {throw new Error(`The isolated checkout does not match its saved Git checkpoint. No agent request was started. Recovery checkpoint: ${backupRef}.`, {cause: error});}
    }
    finally {await fs.rm(attributes, {force: true});}
    const relative = path.relative(repository, workspace);
    const isolatedWorkspace = path.join(checkout, relative);
    const dispose = () => fs.rm(directory, {recursive: true, force: true});
    return {workspace: isolatedWorkspace, backupRef, dispose,
      async collect(): Promise<ImplementationProposal> {
        const candidateTree = await tree(checkout, directory, base);
        await validateLinks(checkout, candidateTree);
        const candidate = await commit(checkout, candidateTree, base, 'PerfChecker MCP implementation proposal');
        await git(checkout, ['update-ref', candidateRef, candidate]);
        const files = (await git(checkout, ['diff', '--name-only', '-z', base, candidate])).split('\0').filter(Boolean);
        for (const file of files) {
          if (!inside(isolatedWorkspace, path.resolve(checkout, file))) throw new Error('The agent changed files outside the selected workspace.');
        }
        const patchBytes = await gitBytes(checkout, ['diff', '--no-ext-diff', '--no-textconv', '--binary', base, candidate]);
        const patch = patchBytes.toString('utf8'), lossyPreview = !Buffer.from(patch).equals(patchBytes);
        await git(repository, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', checkout, `${candidateRef}:${candidateRef}`]);
        return {repository, workspace, backupRef, candidateRef, base, candidate, patch, patchBytes, lossyPreview, files, applied: false};
      }};
  } catch (error) {await fs.rm(directory, {recursive: true, force: true}); throw error;}
}

/** Reject drift during review; apply/restore only the reviewed patch, preserving staging. */
export async function applyImplementation(proposal: ImplementationProposal, restore = false): Promise<void> {
  if (!proposal.patch) throw new Error('The agent produced no code changes.');
  if (restore !== proposal.applied) throw new Error(restore ? 'This proposal has not been applied.' : 'This proposal is already applied.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'perfchecker-apply-'));
  try {
    const expected = restore ? proposal.candidate : proposal.base;
    const current = await tree(proposal.repository, directory, expected);
    const expectedTree = (await git(proposal.repository, ['rev-parse', `${expected}^{tree}`])).trim();
    if (current !== expectedTree) throw new Error('Code changed since the proposal was prepared. Review those edits before applying or restoring. The Git checkpoint is retained.');
    // Apply the raw diff through private Git metadata so global/local text/eol
    // attributes cannot silently rewrite bytes in the user's working tree.
    const patchRepository = path.join(directory, 'patch'); await fs.mkdir(patchRepository);
    await git(patchRepository, ['init', '--quiet']);
    await git(patchRepository, ['config', 'core.autocrlf', 'false']);
    await rawCheckoutAttributes(patchRepository);
    const args = [`--git-dir=${path.join(patchRepository, '.git')}`, `--work-tree=${proposal.repository}`,
      'apply', '--binary', '--whitespace=nowarn', ...(restore ? ['--reverse'] : [])];
    await git(proposal.repository, [...args, '--check', '-'], proposal.patchBytes);
    await git(proposal.repository, [...args, '-'], proposal.patchBytes);
    proposal.applied = !restore;
  } finally {await fs.rm(directory, {recursive: true, force: true});}
}
