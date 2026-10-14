import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {discoverGitReferences, resolveGitRevision} from '../dist/gitReferences.js';
import {parseGitReference} from '../dist/model.js';
const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute('git', args, {cwd})).stdout.trim();

test('homonymous branch, annotated tag and two remotes select four actual commit trees', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-git-refs-'));
  try {
    await git(root, 'init', '--quiet'); await git(root, 'config', 'user.name', 'Fixture');
    await git(root, 'config', 'user.email', 'fixture@localhost');
    const expected = new Map();
    for (const [ref, contents] of [['refs/heads/same', 'branch'], ['refs/tags/same', 'tag'],
      ['refs/remotes/origin/same', 'origin'], ['refs/remotes/upstream/same', 'upstream']]) {
      await writeFile(path.join(root, 'target.txt'), contents);
      await git(root, 'add', 'target.txt'); await git(root, 'commit', '--quiet', '-m', contents);
      const sha = await git(root, 'rev-parse', 'HEAD');
      if (ref.startsWith('refs/tags/')) await git(root, 'tag', '-a', 'same', '-m', 'annotated tag', sha);
      else await git(root, 'update-ref', ref, sha);
      expected.set(ref, {sha, contents});
    }
    const catalog = await discoverGitReferences(root, root);
    await git(root,'tag','-a','nested','-m','nested annotated tag','refs/tags/same');
    const nested=(await discoverGitReferences(root,root)).options.find(option=>option.revision==='refs/tags/nested');
    assert.equal(nested.commit,expected.get('refs/tags/same').sha);
    for (const [ref, {sha, contents}] of expected) {
      const entry = catalog.options.find(option => option.revision === ref);
      assert.ok(entry, `${ref} remains separately selectable`); assert.equal(entry.commit, sha);
      const parsed = parseGitReference(ref); assert.equal(parsed.revision, ref);
      const revision = await resolveGitRevision(root, root, parsed.revision); assert.equal(revision, sha);
      // Exercise Git's actual install boundary, rather than comparing parser strings alone.
      const checkout = path.join(root, `selected-${contents}`); await mkdir(checkout);
      await git(checkout, 'init', '--quiet'); await git(checkout, 'fetch', '--quiet', '--no-tags', root, revision);
      await git(checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
      assert.equal(await readFile(path.join(checkout, 'target.txt'), 'utf8'), contents);
    }
    await assert.rejects(resolveGitRevision(root, root, 'same'), /Ambiguous/);
    const treeUrl=parseGitReference('https://github.com/example/Example.jl/tree/same',root);
    await assert.rejects(resolveGitRevision(root,root,treeUrl.revision),/Ambiguous/);
    const tagUrl=parseGitReference('https://github.com/example/Example.jl/releases/tag/same',root);
    assert.equal(await resolveGitRevision(root,root,tagUrl.revision),expected.get('refs/tags/same').sha);
    assert.equal(await resolveGitRevision(root, root, 'origin/same'), expected.get('refs/remotes/origin/same').sha);
    assert.notEqual(await git(root, 'rev-parse', 'refs/tags/same'), expected.get('refs/tags/same').sha,
      'annotated tag object is peeled to its actual commit');
    const selected = catalog.options.find(option => option.revision === 'refs/heads/same').commit;
    await git(root, 'update-ref', 'refs/heads/same', expected.get('refs/remotes/upstream/same').sha);
    assert.equal(await resolveGitRevision(root, root, selected), expected.get('refs/heads/same').sha,
      'a saved discovered commit does not follow a later branch move');
  } finally {await rm(root, {recursive: true, force: true});}
});

async function serverFixture(callback, action) {
  const server = createServer(callback);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {await action(`http://127.0.0.1:${server.address().port}/repository`);}
  finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
}

test('actual remote Git timeout and cancellation close connections and allow a fresh attempt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-git-network-'));
  try {
    await serverFixture((_request, _response) => {}, async source => {
      const start = Date.now();
      await assert.rejects(discoverGitReferences(source, root, {timeoutMs: 350}), /timed out/);
      assert.ok(Date.now() - start < 10000);
      const controller = new AbortController(); const cancelled = discoverGitReferences(source, root, {signal: controller.signal});
      const timer = setTimeout(() => controller.abort(), 350);
      try {await assert.rejects(cancelled, /cancelled/);} finally {clearTimeout(timer);}
    });
    await git(root, 'init', '--quiet'); await git(root, 'config', 'user.name', 'Fixture');
    await git(root, 'config', 'user.email', 'fixture@localhost');
    await writeFile(path.join(root, 'source.txt'), 'recovered'); await git(root, 'add', '.');
    await git(root, 'commit', '--quiet', '-m', 'recovered');
    assert.ok((await discoverGitReferences(root, root)).options.length > 0);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('unauthenticated HTTP Git fails visibly without asking for credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-git-auth-'));
  const keys=['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try {
    // Exercise Git's unauthenticated HTTP path, independently of credential
    // helpers installed in a runner's user/system configuration.
    const configuration=path.join(root,'empty.gitconfig');await writeFile(configuration,'');
    process.env.GIT_CONFIG_GLOBAL=configuration;process.env.GIT_CONFIG_NOSYSTEM='1';
    process.env.GIT_CONFIG_COUNT='0';delete process.env.GIT_CONFIG_PARAMETERS;
    assert(!/credential\.helper\s*=/.test(await git(root,'config','--list')),'The HTTP fixture has no inherited credential helper');
    let challenges=0,authorizationSent=false;
    await serverFixture((request, response) => {
      challenges++;authorizationSent||=Boolean(request.headers.authorization);
      response.writeHead(401, {'WWW-Authenticate': 'Basic realm="Fixture"'}); response.end();
    }, async source => {
      const started = Date.now();
      let rejection;
      await assert.rejects(discoverGitReferences(source, root),error=>{
        rejection=error;return /Authenticate Git outside PerfChecker/.test(String(error));
      });
      assert(challenges>0,'Git reached the actual unauthenticated HTTP server');
      assert.equal(authorizationSent,false,'The unauthenticated fixture must not send credentials');
      const elapsed=Date.now()-started;
      assert.ok(elapsed<10000,`Unauthenticated HTTP rejection took ${elapsed} ms: ${String(rejection)}`);
    });
  } finally {
    for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    await rm(root, {recursive: true, force: true});
  }
});
