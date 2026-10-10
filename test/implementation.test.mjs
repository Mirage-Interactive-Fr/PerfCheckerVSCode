import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createImplementationCheckout, applyImplementation, recoverImplementationProposal, saveActiveImplementationProposal, recoverActiveImplementationProposal} from '../dist/implementation.js';
const execute=promisify(execFile);
const git=async(root,...args)=>(await execute('git',args,{cwd:root,maxBuffer:32_000_000})).stdout;
async function fixture(run) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-checkpoint-test-'));
  try {
    await git(root,'init','--quiet'); await git(root,'config','user.name','Test'); await git(root,'config','user.email','test@localhost');
    await fs.writeFile(path.join(root,'source.jl'),'original\n'); await fs.writeFile(path.join(root,'.gitignore'),'ignored*\n');
    await git(root,'add','.'); await git(root,'commit','--quiet','-m','base'); await run(root);
  } finally {await fs.rm(root,{recursive:true,force:true});}
}
test('generated report checkpoint retains the complete tree before a single source edit', {
  skip:process.env.PERFCHECKER_TEST_CHECKPOINT_PATHS!=='1',timeout:60000
},async t=>{
  const session=await fs.mkdtemp(path.join(os.tmpdir(),'pc-vsix-')),root=path.join(session,'workspace');
  const output=process.env.PERFCHECKER_TEST_CHECKPOINT_OUTPUT;
  if(output)assert(path.isAbsolute(output),'Diagnostic output is explicitly owned by the runner');
  const receipt={status:'running',platform:process.platform,pid:process.pid,temporaryRoot:os.tmpdir(),
    canonicalTemporaryRoot:await fs.realpath(os.tmpdir()),gitProcesses:[],entries:[]};
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const command=async(directory,...args)=>{
    const pending=execute('git',args,{cwd:directory,timeout:10000,maxBuffer:32_000_000,
      env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
    const observation={pid:pending.child?.pid,operation:args[0]};receipt.gitProcesses.push(observation);
    try{const result=await pending;observation.stderr=result.stderr;return result.stdout;}
    catch(error){observation.stderr=error.stderr;observation.code=error.code;throw error;}
  };
  let checkout;
  const indexes={};
  const snapshot=async(label,directory)=>{
    const index=path.join(directory,'.git','index');
    indexes[label]=await fs.readFile(index);receipt[`${label}IndexSha256`]=hash(indexes[label]);
    receipt[`${label}Status`]=await command(directory,'status','--porcelain=v1','-z','--untracked-files=all');
    receipt[`${label}Stage`]=await command(directory,'ls-files','--stage','-z');
  };
  try{
    await fs.mkdir(path.join(root,'src'),{recursive:true});
    await command(root,'init','--quiet');await command(root,'config','user.name','Test');
    await command(root,'config','user.email','test@localhost');await command(root,'config','commit.gpgsign','false');
    const source='src/PerfCheckerNativeFixture.jl';await fs.writeFile(path.join(root,source),'original\n');
    await command(root,'add','.');await command(root,'commit','--quiet','-m','base');
    const prefix='perf/results/native-limits-native-limits-8ef20f95-6e5d-4bcd-84cd-df5ff86f31a5/';
    // Exact path shapes and lengths of the 26 generated reports in the failed
    // Windows native run. Contents are explicit diagnostic fixture bytes.
    const paths=[
      ...['investigation.json','investigation.md','selection.json'].map(name=>`2026-10-10T04-48-38.977Z-96e8c80a/${name}`),
      ...['artifacts.json','diagnostics.jsonl','integrity.json','manifest.json','measurement-definitions.json','observations.jsonl']
        .map(name=>`2026-10-10T04-48-38.977Z-96e8c80a/experiment-1/6a76d052-1e4d-45d5-8c8f-730afc3908a9/${name}`),
      ...['run.json','run.md','selection.json','advice/advice.json','advice/advice.md'].map(name=>`2026-10-10T04-46-55.003Z-6b326748/${name}`),
      ...['artifacts.json','diagnostics.jsonl','integrity.json','manifest.json','measurement-definitions.json','observations.jsonl']
        .map(name=>`2026-10-10T04-46-55.003Z-6b326748/0c6e5eb4-6bc3-421e-b17b-a14ea5d9784e/${name}`),
      ...['advisor-config.json','investigation.json','investigation.md','selection.json'].map(name=>`2026-10-10T04-46-13.959Z-663bc23b/${name}`),
      ...['discovery.json','discovery.md'].map(name=>`2026-10-10T04-45-42.738Z-62a009b3/${name}`)
    ].map(name=>prefix+name);
    assert.equal(paths.length,26);
    for(const file of paths){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),`fixture ${file}\n`);}
    receipt.original=await fs.realpath(root);receipt.gitVersion=(await command(root,'--version')).trim();receipt.configuration={};
    for(const key of ['core.longpaths','core.fscache','core.autocrlf','core.filemode','core.ignorecase']){
      try{receipt.configuration[key]=(await command(root,'config','--show-origin','--get',key)).trim();}
      catch(error){if(error.code!==1)throw error;receipt.configuration[key]=null;}
    }
    receipt.head=(await command(root,'rev-parse','HEAD')).trim();await snapshot('originalBefore',root);
    checkout=await createImplementationCheckout(root);receipt.suppliedCheckout=checkout.workspace;
    receipt.canonicalCheckout=await fs.realpath(checkout.workspace);receipt.backupRef=checkout.backupRef;
    receipt.checkpoint=(await command(root,'rev-parse',checkout.backupRef)).trim();
    const entries=(await command(root,'ls-tree','-r','-z',checkout.backupRef)).split('\0').filter(Boolean);
    receipt.checkpointTreeEntries=entries;
    assert.equal(entries.length,paths.length+1,'The checkpoint contains every report and the source');
    assert.deepEqual(entries.map(entry=>entry.slice(entry.indexOf('\t')+1)).sort(),[...paths,source].sort());
    await snapshot('privateBefore',checkout.workspace);
    for(const entry of entries){
      const [metadata,file]=entry.split('\t'),[mode,type,oid]=metadata.split(' ');
      assert.equal(type,'blob');assert.equal(mode,'100644');
      const original=await fs.readFile(path.join(root,file)),privateBytes=await fs.readFile(path.join(checkout.workspace,file));
      receipt.entries.push({file,mode,oid,originalPathLength:path.join(receipt.original,file).length,
        privatePathLength:path.join(receipt.canonicalCheckout,file).length,originalSha256:hash(original),privateSha256:hash(privateBytes)});
      assert.deepEqual(privateBytes,original,`The actual private checkout preserves ${file} before provider edits`);
    }
    await fs.writeFile(path.join(checkout.workspace,source),'changed\n');
    const proposal=await checkout.collect();receipt.files=proposal.files;receipt.patchSha256=hash(proposal.patchBytes);
    receipt.patch=proposal.patch;await snapshot('privateAfter',checkout.workspace);await snapshot('originalAfter',root);
    assert.deepEqual(proposal.files,[source],'Collect proposes only the source file actually edited by the provider');
    assert.equal(await fs.readFile(path.join(root,source),'utf8'),'original\n','Collect preserves the original source bytes');
    assert.equal((await command(root,'rev-parse','HEAD')).trim(),receipt.head);
    assert.deepEqual(indexes.originalAfter,indexes.originalBefore,'The original complete index is byte-exact');
    for(const file of paths)assert.equal(await fs.readFile(path.join(root,file),'utf8'),`fixture ${file}\n`);
    receipt.status='passed';
  }catch(error){
    receipt.status='failed';receipt.error={name:error.name,message:error.message,code:error.code};
    for(const [label,directory]of [['originalFailure',root],['privateFailure',checkout?.workspace]])if(directory){
      try{await snapshot(label,directory);}catch(diagnostic){receipt[`${label}Error`]={name:diagnostic.name,code:diagnostic.code,message:diagnostic.message};}
    }
    throw error;
  }finally{
    try{
      if(output){
        await fs.mkdir(output,{recursive:true});
        for(const [label,bytes]of Object.entries(indexes))await fs.writeFile(path.join(output,`${label}.index`),bytes);
        await fs.writeFile(path.join(output,'checkpoint.json'),JSON.stringify(receipt,null,2));
      }
      t.diagnostic(JSON.stringify({status:receipt.status,entries:receipt.entries.length,files:receipt.files,output}));
    }finally{await checkout?.dispose();await fs.rm(session,{recursive:true,force:true});}
  }
});
test('checkpoint, reviewed apply, reload recovery and restore preserve HEAD and byte-identical staging',()=>fixture(async root=>{
  await fs.writeFile(path.join(root,'source.jl'),'staged\n'); await git(root,'add','source.jl');
  await fs.writeFile(path.join(root,'source.jl'),'dirty beyond staged\n');
  await fs.writeFile(path.join(root,'untracked.txt'),'original untracked\n');
  await fs.writeFile(path.join(root,'ignored-staged.txt'),'ignored but explicitly staged\n'); await git(root,'add','-f','ignored-staged.txt');
  await fs.writeFile(path.join(root,'ignored-private.txt'),'not in snapshot');
  const head=await git(root,'rev-parse','HEAD'), index=await fs.readFile(path.join(root,'.git','index'));
  const checkout=await createImplementationCheckout(root);
  let proposal;
  try {
    assert.equal(await fs.readFile(path.join(checkout.workspace,'source.jl'),'utf8'),'dirty beyond staged\n');
    assert.equal(await fs.readFile(path.join(checkout.workspace,'ignored-staged.txt'),'utf8'),'ignored but explicitly staged\n');
    await assert.rejects(fs.access(path.join(checkout.workspace,'ignored-private.txt')));
    await fs.writeFile(path.join(checkout.workspace,'source.jl'),'implemented\n');
    await fs.rm(path.join(checkout.workspace,'untracked.txt'));
    await fs.writeFile(path.join(checkout.workspace,'new file 😀.jl'),'new\n');
    await fs.writeFile(path.join(checkout.workspace,'binary.dat'),Buffer.from([0,255,1,2]));
    proposal=await checkout.collect(); assert.equal(proposal.files.length,4);
    assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),'dirty beyond staged\n');
  } finally {await checkout.dispose();}
  assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);
  await applyImplementation(proposal);
  assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),'implemented\n');
  await assert.rejects(fs.access(path.join(root,'untracked.txt')));
  assert.deepEqual(await fs.readFile(path.join(root,'binary.dat')),Buffer.from([0,255,1,2]));
  assert.equal(await git(root,'rev-parse','HEAD'),head); assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);
  const recovered=await recoverImplementationProposal(root,proposal.backupRef,proposal.candidateRef,false);
  assert.equal(recovered.applied,true); assert.equal(recovered.patch,proposal.patch);
  await saveActiveImplementationProposal(root,proposal);
  assert.equal((await recoverActiveImplementationProposal(root)).applied,true);
  await applyImplementation(recovered,true);
  assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),'dirty beyond staged\n');
  assert.equal(await fs.readFile(path.join(root,'untracked.txt'),'utf8'),'original untracked\n');
  await assert.rejects(fs.access(path.join(root,'new file 😀.jl'))); await assert.rejects(fs.access(path.join(root,'binary.dat')));
  assert.equal(await fs.readFile(path.join(root,'ignored-private.txt'),'utf8'),'not in snapshot');
  assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index); assert.equal(await git(root,'rev-parse','HEAD'),head);
  await saveActiveImplementationProposal(root); assert.equal(await recoverActiveImplementationProposal(root),undefined);
}));
test('apply and restore reject drift and duplicate actions without deleting user edits',()=>fixture(async root=>{
  const checkout=await createImplementationCheckout(root); let proposal;
  try {await fs.writeFile(path.join(checkout.workspace,'source.jl'),'optimized\n'); proposal=await checkout.collect();} finally {await checkout.dispose();}
  await fs.writeFile(path.join(root,'source.jl'),'manual edits\n'); await assert.rejects(applyImplementation(proposal),/Code changed/);
  assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),'manual edits\n');
  await fs.writeFile(path.join(root,'source.jl'),'original\n'); await applyImplementation(proposal);
  await assert.rejects(applyImplementation(proposal),/already applied/);
  await fs.writeFile(path.join(root,'new-user.txt'),'keep'); await assert.rejects(applyImplementation(proposal,true),/Code changed/);
  await fs.rm(path.join(root,'new-user.txt')); await applyImplementation(proposal,true);
  await assert.rejects(applyImplementation(proposal,true),/not been applied/);
}));
test('nested workspace edits outside selection and unsupported links fail safely',()=>fixture(async root=>{
  await fs.mkdir(path.join(root,'selected')); await fs.writeFile(path.join(root,'selected','case.jl'),'case');
  const checkout=await createImplementationCheckout(path.join(root,'selected'));
  try {await fs.writeFile(path.join(checkout.workspace,'..','source.jl'),'outside'); await assert.rejects(checkout.collect(),/outside the selected/);} finally {await checkout.dispose();}
  if (process.platform!=='win32') {
    await fs.symlink('/tmp',path.join(root,'external-link')); await assert.rejects(createImplementationCheckout(root),/symlinks/); await fs.rm(path.join(root,'external-link'));
    const second=await createImplementationCheckout(root);
    try {await fs.symlink('../..',path.join(second.workspace,'escape')); await assert.rejects(second.collect(),/symlinks/);} finally {await second.dispose();}
  }
}));
test('linked worktrees and split index are supported without moving the branch',()=>fixture(async root=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-linked-test-')), linked=path.join(parent,'linked');
  try {
    await git(root,'worktree','add','--quiet','--detach',linked); await git(linked,'update-index','--split-index');
    await fs.writeFile(path.join(linked,'source.jl'),'dirty linked\n');
    const indexPath=path.resolve(linked,(await git(linked,'rev-parse','--git-path','index')).trim()), before=await fs.readFile(indexPath);
    const checkout=await createImplementationCheckout(linked);
    try {assert.equal(await fs.readFile(path.join(checkout.workspace,'source.jl'),'utf8'),'dirty linked\n');} finally {await checkout.dispose();}
    assert.deepEqual(await fs.readFile(indexPath),before);
  } finally {await git(root,'worktree','remove','--force',linked); await fs.rm(parent,{recursive:true,force:true});}
}));
test('partial clone checkpoints preserve original history without hydrating historical blobs',()=>fixture(async source=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-promisor-test-'));
  const origin=path.join(directory,'origin.git'),root=path.join(directory,'partial');
  const previousLazyFetch=process.env.GIT_NO_LAZY_FETCH;
  let checkout;
  try{
    const historical=(await git(source,'rev-parse','HEAD:source.jl')).trim();
    await fs.writeFile(path.join(source,'source.jl'),'current HEAD\n');await git(source,'add','.');await git(source,'commit','--quiet','-m','Current source');
    await git(directory,'clone','--quiet','--bare',source,origin);
    await git(origin,'config','uploadpack.allowFilter','true');
    await execute('git',['clone','--quiet','--no-local','--filter=blob:none',origin,root],
      {cwd:directory,env:{...process.env,GIT_NO_LAZY_FETCH:'0'}});
    process.env.GIT_NO_LAZY_FETCH='1';
    assert.equal((await git(root,'config','remote.origin.promisor')).trim(),'true');
    assert.equal((await git(root,'rev-parse','--is-shallow-repository')).trim(),'false');
    assert((await git(root,'rev-list','--objects','--missing=print','HEAD')).split('\n').includes(`?${historical}`));
    await assert.rejects(git(root,'cat-file','-e',historical));
    await git(root,'fsck','--full','--no-dangling');
    await fs.writeFile(path.join(root,'source.jl'),'staged source\n');await git(root,'add','source.jl');
    await fs.writeFile(path.join(root,'source.jl'),'saved before implementation\n');
    const head=(await git(root,'rev-parse','HEAD')).trim(),index=await fs.readFile(path.join(root,'.git','index'));
    const refs=await git(root,'for-each-ref','--format=%(refname) %(objectname)'),before=await git(root,'status','--porcelain');
    checkout=await createImplementationCheckout(root);
    assert.equal(await fs.readFile(path.join(checkout.workspace,'source.jl'),'utf8'),'saved before implementation\n');
    assert.equal((await git(checkout.workspace,'rev-parse','--is-shallow-repository')).trim(),'true');
    await fs.writeFile(path.join(checkout.workspace,'source.jl'),'reviewed candidate\n');
    const proposal=await checkout.collect();
    assert.deepEqual(proposal.files,['source.jl']);
    assert.equal((await git(root,'rev-parse',`${proposal.base}^`)).trim(),head,'The original checkpoint retains its real parent');
    assert.equal((await git(root,'rev-parse',`${proposal.candidate}^`)).trim(),proposal.base,'The candidate retains the checkpoint parent');
    await checkout.dispose();checkout=undefined;
    await applyImplementation(proposal);
    assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),'reviewed candidate\n');
    const recovered=await recoverImplementationProposal(root,proposal.backupRef,proposal.candidateRef,false);
    assert.equal(recovered.applied,true);assert.equal(recovered.patch,proposal.patch);
    await applyImplementation(recovered,true);
    assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),'saved before implementation\n');
    assert.equal((await git(root,'rev-parse','HEAD')).trim(),head);assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);
    assert.equal(await git(root,'status','--porcelain'),before);
    assert.equal((await git(root,'for-each-ref','--format=%(refname) %(objectname)')).split('\n').filter(line=>!line.startsWith('refs/perfchecker/')).join('\n'),refs);
    assert.equal((await git(root,'rev-parse','--is-shallow-repository')).trim(),'false');
    await assert.rejects(git(root,'cat-file','-e',historical),'No historical blob was hydrated');
    await git(root,'fsck','--full','--no-dangling');
  }finally{
    await checkout?.dispose();
    if(previousLazyFetch===undefined)delete process.env.GIT_NO_LAZY_FETCH;else process.env.GIT_NO_LAZY_FETCH=previousLazyFetch;
    await fs.rm(directory,{recursive:true,force:true});
  }
}));
test('non-UTF8 text patches preserve exact bytes through reviewed apply and restart restoration',()=>fixture(async root=>{
  const original=Buffer.from([99,97,102,233,10]),candidate=Buffer.from([99,97,102,233,32,97,108,116,101,114,233,10]);
  await fs.writeFile(path.join(root,'latin1.txt'),original);await git(root,'add','latin1.txt');
  const checkout=await createImplementationCheckout(root);let proposal;
  try {await fs.writeFile(path.join(checkout.workspace,'latin1.txt'),candidate);proposal=await checkout.collect();}finally{await checkout.dispose();}
  assert.equal(proposal.lossyPreview,true);await applyImplementation(proposal);
  assert.deepEqual(await fs.readFile(path.join(root,'latin1.txt')),candidate);
  const recovered=await recoverImplementationProposal(root,proposal.backupRef,proposal.candidateRef,true);await applyImplementation(recovered,true);
  assert.deepEqual(await fs.readFile(path.join(root,'latin1.txt')),original);
}));
test('submodules and repositories without a first commit cannot create an unsafe proposal',()=>fixture(async root=>{
  const head=(await git(root,'rev-parse','HEAD')).trim();await git(root,'update-index','--add','--cacheinfo',`160000,${head},submodule`);
  await assert.rejects(createImplementationCheckout(root),/submodules/);
  await git(root,'update-index','--force-remove','submodule');
  const nested=path.join(root,'unborn');await fs.mkdir(nested);await git(nested,'init','--quiet');await assert.rejects(createImplementationCheckout(nested));
}));
test('oversized text diff is rejected before any original code change',()=>fixture(async root=>{
  const checkout=await createImplementationCheckout(root);
  try {await fs.writeFile(path.join(checkout.workspace,'large.txt'),Buffer.alloc(33_000_000,65));await assert.rejects(checkout.collect(),/32 MB/);assert.equal(await fs.readFile(path.join(root,'source.jl'),'utf8'),'original\n');await assert.rejects(fs.access(path.join(root,'large.txt')));}finally{await checkout.dispose();}
}));
test('ordinary CRLF conversion preserves original on-disk bytes through apply and restore',()=>fixture(async root=>{
  await git(root,'config','core.autocrlf','true');
  await fs.writeFile(path.join(root,'line-endings.txt'),'original\r\n');await git(root,'add','line-endings.txt');
  const before=await fs.readFile(path.join(root,'line-endings.txt')),checkout=await createImplementationCheckout(root);let proposal;
  try {await fs.writeFile(path.join(checkout.workspace,'line-endings.txt'),'candidate\r\n');proposal=await checkout.collect();}finally{await checkout.dispose();}
  await applyImplementation(proposal);assert.equal(await fs.readFile(path.join(root,'line-endings.txt'),'utf8'),'candidate\r\n');
  await applyImplementation(proposal,true);assert.deepEqual(await fs.readFile(path.join(root,'line-endings.txt')),before);
}));
test('global and local text conversions never change checkpoint, checkout or restored bytes',()=>fixture(async root=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-git-eol-test-'));
  const configuration=path.join(directory,'global-config'), previous=process.env.GIT_CONFIG_GLOBAL;
  try {
    await fs.writeFile(configuration,'[core]\n\tautocrlf = true\n\teol = crlf\n');
    process.env.GIT_CONFIG_GLOBAL=configuration;
    for (const localConversion of ['true','false']) {
      await git(root,'config','core.autocrlf',localConversion);
      for (const attributes of ['', '*.jl text eol=crlf\n', '*.jl text eol=lf\n', '*.jl text=auto\n']) {
      await fs.writeFile(path.join(root,'.gitattributes'),attributes);
      for (const ending of ['\n','\r\n','\r\nsecond line\n']) {
        const original=Buffer.from(`original${ending}`), candidate=Buffer.from(`optimized${ending}`);
        await fs.writeFile(path.join(root,'source.jl'),original);
        const head=await git(root,'rev-parse','HEAD'), index=await fs.readFile(path.join(root,'.git','index'));
        const checkout=await createImplementationCheckout(root);let proposal;
        try {
          assert.deepEqual(await fs.readFile(path.join(checkout.workspace,'source.jl')),original);
          await fs.writeFile(path.join(checkout.workspace,'source.jl'),candidate);proposal=await checkout.collect();
        } finally {await checkout.dispose();}
        await applyImplementation(proposal);assert.deepEqual(await fs.readFile(path.join(root,'source.jl')),candidate);
        const recovered=await recoverImplementationProposal(root,proposal.backupRef,proposal.candidateRef,true);
        await applyImplementation(recovered,true);assert.deepEqual(await fs.readFile(path.join(root,'source.jl')),original);
        assert.equal(await git(root,'rev-parse','HEAD'),head);assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);
      }
      }
    }
  } finally {
    if(previous===undefined)delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL=previous;
    await fs.rm(directory,{recursive:true,force:true});
  }
}));
test('custom content filters and filters introduced by an agent are rejected before execution',()=>fixture(async root=>{
  await fs.writeFile(path.join(root,'.gitattributes'),'*.jl filter=unsafe\n');
  await git(root,'config','filter.unsafe.clean','this-executable-must-not-be-invoked');
  await assert.rejects(createImplementationCheckout(root),/clean\/smudge filters/);await fs.rm(path.join(root,'.gitattributes'));
  const checkout=await createImplementationCheckout(root);
  try {await fs.writeFile(path.join(checkout.workspace,'.gitattributes'),'*.jl filter=lfs\n');await assert.rejects(checkout.collect(),/Git LFS/);}finally{await checkout.dispose();}
}));
