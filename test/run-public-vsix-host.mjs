import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath} from '@vscode/test-electron';
import {nativeVSCodeApplication} from './native-vscode-application.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(repository, 'native-qualification-results');
// Darwin's TMPDIR is long; per-phase profiles otherwise exceed its 103-byte
// Unix-domain socket limit before VS Code can start. This remains a disposable
// OS temporary directory, independent of any real VS Code profile.
const session = await fs.mkdtemp(path.join(process.platform==='darwin'?'/tmp':os.tmpdir(), 'pc-vsix-'));
let julia = process.env.PERFCHECKER_TEST_JULIA || 'julia';
const mode = process.env.PERFCHECKER_VSIX_MODE || 'public';
const coreMode=process.env.PERFCHECKER_NATIVE_CORE || 'general';
// A registered release can contain subsequent documentation-only changes.
// Candidate inputs apply only to Git candidates, never to General's tree.
const coreCommit=coreMode==='candidate'?(process.env.PERFCHECKER_NATIVE_CORE_COMMIT || ''):'';
const coreTree=coreMode==='candidate'?(process.env.PERFCHECKER_NATIVE_CORE_TREE || ''):'';
if(!['general','candidate'].includes(coreMode))throw new Error('Choose the registered or explicitly pinned candidate Core.');
if(coreMode==='candidate' && ![coreCommit,coreTree].every(value=>/^[a-f0-9]{40}$/.test(value)))throw new Error('Core candidate mode requires an immutable commit and expected Git tree.');
const expectedCoreVersion=coreMode==='candidate'||mode==='candidate'?'1.0.1':'1.0.0';
const coreProvenance={mode:coreMode,version:expectedCoreVersion,...(coreMode==='candidate'?{commit:coreCommit,tree:coreTree}:{registry:'General'})};
const installCore=coreMode==='candidate'?'Pkg.add(Pkg.PackageSpec(url="https://github.com/Mirage-Interactive-Fr/PerfChecker.jl",rev=ARGS[2]))':`Pkg.add(Pkg.PackageSpec(name="PerfChecker",version="${expectedCoreVersion}"))`;
const version = process.env.PERFCHECKER_VSCODE_VERSION || 'stable';
const stage=process.env.PERFCHECKER_NATIVE_STAGE||'smoke';
if(!['smoke','full','targeted','focused','core-external'].includes(stage))throw new Error('Choose smoke, full, targeted lifecycle/protocol, focused native controls, or the explicit Core-only external-process regression.');
const caseGroup=process.env.PERFCHECKER_NATIVE_CASE_GROUP||'narrative';
if(stage==='focused'&&!['narrative','mcp','mcp-pluto','pluto-plots','workbench','advisor','investigation','investigation-limits','studio','studio-ordering','editor','testitems','restricted','landscape','studio-color'].includes(caseGroup))throw new Error('Choose one of the explicit native-control groups.');
const landscapeOnly=stage==='focused'&&caseGroup==='landscape';
// The real game and SDKs are immutable fixtures, never development checkouts.
// A trailing delimiter expands only Julia's system depots, excluding the human depot.
const runnerEnvironment=landscapeOnly?{...process.env,JULIA_DEPOT_PATH:path.join(session,'landscape-depot')+path.delimiter,
  JULIA_LOAD_PATH:'@:@stdlib',JULIA_PKG_PRECOMPILE_AUTO:'0',JULIA_NUM_THREADS:'1',JULIA_NUM_PRECOMPILE_TASKS:'1',
  JULIA_PKG_SERVER:'https://pkg.julialang.org',JULIA_PKG_OFFLINE:'false',XDG_RUNTIME_DIR:path.join(session,'runtime'),
  JULIA_NUM_GC_THREADS:'1',OPENBLAS_NUM_THREADS:'1',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}:process.env;
if(landscapeOnly)for(const key of ['DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS',
  'ETENDUE_SDL3_LIBRARY','ETENDUE_SDL3_DLSS_LIBRARY','ETENDUE_JOLTC_LIBRARY'])delete runnerEnvironment[key];
let landscapeFixture,landscapeObserver,landscapePrimaryError;
const landscapeProcesses=new Map(),landscapeObserverErrors=[];
const landscapeAbort=new AbortController();
const abortLandscape=()=>landscapeAbort.abort(new Error('The private Landscape runner was interrupted'));
const completeCampaign=['smoke','full'].includes(stage);
const phaseFailures = [];
const publicSha = 'c4123271e71e4c4d148fe0e613ba260f4aeea6f28445338cab11d3fb9513df09';
if (!['public', 'candidate'].includes(mode)) throw new Error('Choose public or candidate VSIX explicitly.');

async function execute(executable, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {windowsHide: true, env:runnerEnvironment,
      ...(landscapeOnly?{signal:landscapeAbort.signal}:{}), ...options});
    let text = '';
    child.stdout?.on('data', chunk => {text += chunk; process.stdout.write(chunk);});
    child.stderr?.on('data', chunk => {text += chunk; process.stderr.write(chunk);});
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(text) : reject(Object.assign(new Error(`${path.basename(executable)} exited ${code}\n${text.slice(-5000)}`), {commandOutput: text, exitCode: code})));
  });
}

async function landscapeIdentity(pid){
  const text=await fs.readFile(`/proc/${pid}/stat`,'utf8').catch(error=>{if(['ENOENT','ESRCH'].includes(error.code))return null;throw error;});
  if(!text)return null;const fields=text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/);
  return {pid,parent:Number(fields[1]),started:fields[19],state:fields[0]};
}
async function landscapeChildren(pid,started){
  const tasks=await fs.readdir(`/proc/${pid}/task`).catch(error=>{if(['ENOENT','ESRCH'].includes(error.code))return [];throw error;});
  const found=new Set();
  for(const tid of tasks.filter(name=>/^\d+$/.test(name))){
    const text=await fs.readFile(`/proc/${pid}/task/${tid}/children`,'utf8').catch(error=>{if(['ENOENT','ESRCH'].includes(error.code))return '';throw error;});
    for(const child of text.trim().split(/\s+/).filter(Boolean).map(Number))found.add(child);
  }
  const after=await landscapeIdentity(pid);return after?.started===started&&after.state!=='Z'?[...found]:[];
}
async function observeLandscapeChildren(pid=process.pid,parent){
  const current=await landscapeIdentity(pid);if(!current||current.state==='Z')return;
  if(parent!==undefined&&current.parent!==parent)return;
  if(pid!==process.pid){const old=landscapeProcesses.get(pid);assert(!old||old.started===current.started,'An owned PID retains its start identity');landscapeProcesses.set(pid,current);}
  for(const child of await landscapeChildren(pid,current.started))await observeLandscapeChildren(child,pid);
}
async function livingLandscapeProcesses(){
  const alive=[];
  for(const record of landscapeProcesses.values()){const current=await landscapeIdentity(record.pid);if(current?.started===record.started&&current.state!=='Z')alive.push(current);}
  return alive;
}

async function prepareLandscapeFixture(runtime){
  assert.equal(process.platform,'linux','The native Landscape fixture requires Linux/X11');
  assert(/^1\.(?:1[3-9]|[2-9]\d)\./.test(runtime.version),'The real game requires Julia 1.13 or later');
  const input=process.env.PERFCHECKER_NATIVE_LANDSCAPE_SOURCE_ROOT;
  assert(input&&path.isAbsolute(input),'Supply the existing read-only game/SDK source root explicitly');
  const sourceRoot=await fs.realpath(input),gameCommit='dc8124a0cc35977ca26316450e8b688abd6ab6b8';
  const pins={
    EtenduContracts:['0a129097a06ce36b10657e901a6039d2588a8042','efc4e7ed302b253142b20b7dbe2f2f592d3ec4cfe8ebf5dfc7ee16608e6bebd0'],
    EtenduNativeArtifacts:['9ae20356d9205d6c74b70bcb0996752d20c12c6c','f59124db09e24551e4dcebb3b9eb6c2e97fc85f8760635290518540369e88979'],
    EtenduRender:['884493d4fc9ac0188d2399eef1dd77410b423ef3','5818e9e543b206c54bd7d026ae0a1cbfec10772022c966fa0b85b47cfd939e5f'],
    EtenduRuntime:['f848c18a144e2cc8cae9c7dcf102de943aad21cc','9e7021f0d9c1c2d68aeeef1fece7a5cba00ceb5f75c23a0a8c3b1df80470cf09'],
    EtenduSDLGPU:['d0455b1dcbefcd1cc8b6085f341c18f5a13115c7','9171345a5675fb750af010dc023f4872fa72dded07fd16c4840a330c14ce9dcc'],
  };
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const git=(source,args)=>execute('git',['-C',source,...args]);
  const sourceSnapshot=async source=>({head:(await git(source,['rev-parse','HEAD'])).trim(),status:await git(source,['status','--porcelain','--untracked-files=no','--','Project.toml','Manifest.toml','src','perf','config','content/scenes','EtenduGame.toml']),
    projects:await Promise.all(['Project.toml','Manifest.toml'].map(async name=>[name,await fs.readFile(path.join(source,name)).then(hash).catch(error=>{if(error.code==='ENOENT')return null;throw error;})]))});
  const archiveInto=async(source,commit,destination)=>{
    await fs.mkdir(destination,{recursive:true});
    const archive=spawn('git',['-C',source,'archive','--format=tar',commit],{env:runnerEnvironment,signal:landscapeAbort.signal,stdio:['ignore','pipe','pipe']});
    // GNU tar must consume the entire producer stream, including trailing archive padding.
    const unpack=spawn('tar',['--ignore-zeros','-xf','-','-C',destination],{env:runnerEnvironment,signal:landscapeAbort.signal,stdio:['pipe','ignore','pipe']});
    let errors='';for(const child of [archive,unpack])child.stderr.on('data',data=>{errors=(errors+data.toString()).slice(-5000);});
    const exits=[archive,unpack].map(child=>new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`Immutable source archive failed (${code}): ${errors}`)));}));
    const timer=setTimeout(()=>{archive.kill('SIGKILL');unpack.kill('SIGKILL');},120000);
    try{await Promise.all([...exits,pipeline(archive.stdout,unpack.stdin)]);}
    finally{clearTimeout(timer);for(const child of [archive,unpack])if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await Promise.allSettled(exits);}
  };
  const sourceDigest=async(root,relative='')=>{
    const records=[];
    for(const entry of (await fs.readdir(path.join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
      const name=path.posix.join(relative,entry.name);assert(entry.isDirectory()||entry.isFile(),'SDK archives contain only regular files/directories');
      if(entry.isDirectory())records.push(...await sourceDigest(root,name));else records.push(name+'\0'+hash(await fs.readFile(path.join(root,name)))+'\0');
    }return records;
  };
  const sourceGame=await fs.realpath(path.join(sourceRoot,'EtenduBeautifulLandscape'));
  const snapshots=new Map([[sourceGame,await sourceSnapshot(sourceGame)]]);
  assert.equal((await git(sourceGame,['rev-parse','v0.1.0^{commit}'])).trim(),gameCommit);
  const root=path.join(session,'landscape');await archiveInto(sourceGame,gameCommit,root);
  const lfs=JSON.parse(await git(sourceGame,['lfs','ls-files','--json',gameCommit])).files;
  assert.equal(lfs.length,143);let lfsBytes=0;
  for(const item of lfs){
    const original=await fs.realpath(path.join(sourceGame,item.name)),relative=path.relative(sourceGame,original);
    assert(relative&&!path.isAbsolute(relative)&&relative.split(path.sep)[0]!=='..','Each LFS source is inside the existing game tree');
    const bytes=await fs.readFile(original);assert.equal(bytes.length,item.size);assert.equal(hash(bytes),item.oid);
    await fs.writeFile(path.join(root,item.name),bytes);lfsBytes+=bytes.length;
  }assert.equal(lfsBytes,384633618);
  // Fetch immutable objects locally without checking out, changing, or recording a remote on the human repository.
  await git(root,['init']);await git(root,['fetch','--depth=1','--no-tags','--no-write-fetch-head',sourceGame,gameCommit]);
  await git(root,['update-ref','refs/heads/immutable-fixture',gameCommit]);await git(root,['symbolic-ref','HEAD','refs/heads/immutable-fixture']);await git(root,['read-tree',gameCommit]);
  const sdk=[];
  for(const [name,[commit,sha256]]of Object.entries(pins)){
    const original=await fs.realpath(path.join(sourceRoot,name));snapshots.set(original,await sourceSnapshot(original));
    assert.equal((await git(original,['rev-parse','v0.1.1^{commit}'])).trim(),commit);
    const directory=path.join(session,'landscape-sdk',name);await archiveInto(original,commit,directory);
    assert.equal(hash((await sourceDigest(directory)).join('')),sha256);sdk.push({name,commit,sha256,directory});
  }
  const project=await fs.readFile(path.join(root,'Project.toml'));
  await execute(julia,['--startup-file=no','-e',
    `using Pkg,TOML
root=ARGS[1];file=joinpath(root,"Project.toml");original=read(file)
Pkg.activate(root);Pkg.develop([PackageSpec(path=p) for p in ARGS[2:end]]);Pkg.instantiate()
include(joinpath(ARGS[3],"scripts","stage-sdl3.jl"))
@assert Pkg.Artifacts.verify_artifact(Base.SHA1("cebc6cb7720a4cfff9f5ec5fb85ab539d1368231");honor_overrides=true)
# Pkg 1.13 records path dependencies in [sources]. Only this temporary game's
# five SDK source entries may differ; restore the exact tag before measurement.
actual=TOML.parsefile(file);sources=pop!(actual,"sources",Dict{String,Any}())
@assert actual==TOML.parse(String(copy(original)))
names=[TOML.parsefile(joinpath(p,"Project.toml"))["name"] for p in ARGS[2:end]]
@assert Set(keys(sources))==Set(names)
for (name,directory) in zip(names,ARGS[2:end]);@assert normpath(joinpath(root,sources[name]["path"]))==directory;end
write(file,original)
env=Pkg.Types.EnvCache(file);env.manifest.other["project_hash"]=Pkg.Types.workspace_resolve_hash(env)
Pkg.Types.write_manifest(env.manifest,env.manifest_file)
`,root,...sdk.map(item=>item.directory)],{timeout:900000});
  assert.deepEqual(await fs.readFile(path.join(root,'Project.toml')),project,'Pkg preparation preserves the game tag Project.toml');
  for(const item of sdk)assert.equal(hash((await sourceDigest(item.directory)).join('')),item.sha256,'SDK runtime source remains identical to its archived tag');
  for(const [source,before]of snapshots)assert.deepEqual(await sourceSnapshot(source),before,'The human HEAD, status and project files remain unchanged');
  const executable=await fs.realpath(process.env.PERFCHECKER_TEST_XVFB||'/usr/bin/Xvfb');
  const tools=Object.fromEntries(await Promise.all(['xwd','xwininfo','vulkaninfo'].map(async name=>[name,await fs.realpath(`/usr/bin/${name}`)])));
  const displayChild=spawn(executable,['-displayfd','3','-screen','0','1920x1080x24','-nolisten','tcp','-ac'],{env:runnerEnvironment,stdio:['ignore','ignore','pipe','pipe']});
  const displayExit=new Promise(resolve=>{displayChild.once('close',resolve);displayChild.once('error',()=>resolve(-1));});
  landscapeFixture={root,displayChild,displayExit};displayChild.stderr.resume();
  const display=await new Promise((resolve,reject)=>{
    let text='';const timer=setTimeout(()=>reject(new Error('The owned Xvfb did not reserve a private display')),15000);
    const finish=(error,value)=>{clearTimeout(timer);error?reject(error):resolve(value);};
    displayChild.once('error',error=>finish(error));displayChild.once('close',()=>finish(new Error('The owned Xvfb exited before native launch')));
    displayChild.stdio[3].on('data',bytes=>{text+=bytes;const match=text.match(/^(\d+)\s*$/);if(match)finish(undefined,`:${match[1]}`);});
  });
  const icd=await fs.realpath(process.env.PERFCHECKER_NATIVE_LANDSCAPE_ICD||'/usr/share/vulkan/icd.d/lvp_icd.json');
  assert.match(icd,/\/lvp_icd(?:\.x86_64)?\.json$/);
  const environment={DISPLAY:display,XAUTHORITY:'',SDL_VIDEODRIVER:'x11',SDL_GPU_DRIVER:'vulkan',VK_ICD_FILENAMES:icd,PATH:'/usr/bin:'+runnerEnvironment.PATH,
    PERFCHECKER_NATIVE_LANDSCAPE_WORKSPACE:root};
  const xwdVersion=(await execute(tools.xwd,['-version'],{env:{...runnerEnvironment,...environment},timeout:10000})).trim();
  const windowIdentity=await execute(tools.xwininfo,['-display',display,'-root'],{env:{...runnerEnvironment,...environment},timeout:10000});
  const vulkan=await execute(tools.vulkaninfo,['--summary'],{env:{...runnerEnvironment,...environment},timeout:30000});
  assert.match(vulkan,/llvmpipe/);assert.match(vulkan,/PHYSICAL_DEVICE_TYPE_CPU/);
  return Object.assign(landscapeFixture,{environment,provenance:{gameCommit,lfsFiles:lfs.length,lfsBytes,sdk:sdk.map(({directory,...pin})=>pin),
    manifestSha256:hash(await fs.readFile(path.join(root,'Manifest.toml'))),privateDepot:path.join(session,'landscape-depot'),
    display:{pid:displayChild.pid,name:display,private:true,rootIdentity:windowIdentity.trim(),executable,sha256:hash(await fs.readFile(executable))},
    tools:await Promise.all(Object.entries(tools).map(async([name,file])=>({name,path:file,sha256:hash(await fs.readFile(file)),...(name==='xwd'?{version:xwdVersion}:{})}))),
    icd:{path:icd,sha256:hash(await fs.readFile(icd))},
    scope:'Real SDL/Vulkan llvmpipe software rendering; no physical GPU timing or physical presentation claim'}});
}

try {
  await fs.mkdir(output, {recursive: true});
  assertCI();
  if(landscapeOnly){
    assert.equal(process.platform,'linux');await fs.mkdir(runnerEnvironment.XDG_RUNTIME_DIR,{mode:0o700});let pending=Promise.resolve();
    process.on('SIGINT',abortLandscape);process.on('SIGTERM',abortLandscape);
    const inspect=async()=>{await observeLandscapeChildren();for(const record of [...landscapeProcesses.values()]){
      const current=await landscapeIdentity(record.pid);if(current?.started===record.started&&current.state!=='Z')await observeLandscapeChildren(record.pid);
    }};
    const sample=()=>pending=pending.then(inspect).catch(error=>{landscapeObserverErrors.push(error);});
    landscapeObserver=setInterval(sample,100);
    landscapeObserver.sample=sample;
    landscapeObserver.drain=()=>pending;
  }
  if(stage==='core-external'){
    if(coreMode!=='candidate')throw new Error('The focused Core regression requires an immutable candidate commit/tree.');
    const runtime=JSON.parse((await execute(julia,['--startup-file=no','-e','print("{\\\"executable\\\":", repr(joinpath(Sys.BINDIR, Base.julia_exename())), ",\\\"version\\\":", repr(string(VERSION)), "}")'])).trim());
    const record={stage,scope:'Core-only; no VS Code/Electron or VSIX installation',core:coreProvenance,runtime,platform:process.platform,arch:process.arch,
      testItem:'External providers stop their owned process tree before returning',startedAt:new Date().toISOString()};
    const result=path.join(output,'core-external-result.json');
    try{
      const project=path.join(session,'core-external-controller');
      const isolated={env:{...process.env,JULIA_LOAD_PATH:process.platform==='win32'?'@;@stdlib':'@:@stdlib'}};
      const workerOutput=await execute(julia,['--startup-file=no','-e',`using Pkg;Pkg.activate(ARGS[1]);${installCore};Pkg.add(PackageSpec(name="TestItemRunner",version="1.3.2"));using PerfChecker,TestItemRunner;@assert Base.pkgversion(PerfChecker)==VersionNumber(ARGS[4]);@assert string(Pkg.dependencies()[Base.PkgId(PerfChecker).uuid].tree_hash)==ARGS[3];println("CORE_ONLY_PROVENANCE ",Base.pkgversion(PerfChecker)," TREE=",ARGS[3]," SOURCE=",pathof(PerfChecker));TestItemRunner.run_tests(pkgdir(PerfChecker);filter=ti->ti.name=="External providers stop their owned process tree before returning")`,project,coreCommit,coreTree,expectedCoreVersion],isolated);
      await fs.writeFile(path.join(output,'core-external-worker.log'),workerOutput);
      await fs.writeFile(result,JSON.stringify({...record,status:'passed',finishedAt:new Date().toISOString()},null,2));
    }catch(error){if(error.commandOutput)await fs.writeFile(path.join(output,'core-external-worker.log'),error.commandOutput);await fs.writeFile(result,JSON.stringify({...record,status:'failed',error:String(error),finishedAt:new Date().toISOString()},null,2));throw error;}
  }else{
  const runtime = JSON.parse((await execute(julia, ['--startup-file=no', '-e',
    'print("{\\\"executable\\\":", repr(joinpath(Sys.BINDIR, Base.julia_exename())), ",\\\"version\\\":", repr(string(VERSION)), "}")'])).trim());
  julia = runtime.executable;
  const officialRuntime=JSON.parse((await execute(process.env.PERFCHECKER_NATIVE_OFFICIAL_JULIA||julia,['--startup-file=no','-e',
    'print("{\\\"executable\\\":", repr(joinpath(Sys.BINDIR, Base.julia_exename())), ",\\\"version\\\":", repr(string(VERSION)), "}")'])).trim());
  const expectedVersion = mode === 'public' ? '1.0.0' : JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')).version;
  const vscode = await downloadAndUnzipVSCode({version, cachePath: path.join(session, 'vscode')});
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscode, {reuseMachineInstall: true});
  const application=await nativeVSCodeApplication(vscode,cli,{expectedVersion:version});
  const hostVersion=application.version,cliSource=application.cliSource;
  console.log('NATIVE_VSCODE_APPLICATION '+JSON.stringify({version:hostVersion,commit:application.commit,
    applicationName:application.applicationName,relativePath:path.relative(path.dirname(vscode),application.application),cli:path.relative(path.dirname(vscode),cli)}));
  const privateDirectoryFlags=['shared-data-dir','agent-plugins-dir','agents-user-data-dir','agents-extensions-dir']
    .filter(flag=>cliSource.includes(`"${flag}":`));
  const [hostMajor,hostMinor]=hostVersion.split('.').map(Number);
  if(hostMajor>1||hostMajor===1&&hostMinor>=141)assert.equal(privateDirectoryFlags.length,4,'The actual host CLI must support all four isolated shared/agent directories');
  const extensions = path.join(session, 'extensions');
  const profile = path.join(session, 'profile');
  // Exercise real VS Code dialogs through CDP instead of invisible OS-native modals.
  // This application-scoped preference belongs only to the disposable CI profile.
  await fs.mkdir(path.join(profile,'User'),{recursive:true});
  await fs.writeFile(path.join(profile,'User','settings.json'),JSON.stringify({'window.dialogStyle':'custom','telemetry.telemetryLevel':'off'}));
  const workspace = path.join(session, 'workspace');
  const workspaceFile = path.join(session,'qualification.code-workspace');
  const controller = path.join(session, 'controller');
  const target = path.join(workspace, 'worker-environment');
  await fs.mkdir(path.join(workspace, 'src'), {recursive: true});
  await fs.mkdir(path.join(workspace, 'test'));
  await fs.writeFile(path.join(workspace, 'Project.toml'), 'name = "PerfCheckerNativeFixture"\nuuid = "6af56806-e0b1-4f34-88bf-fde69d8a8679"\nversion = "0.1.0"\n');
  // Keep actual workload frames in the target package, rather than inlining them
  // into an external perf script. Both workloads allocate inside their own source.
  await fs.writeFile(path.join(workspace, 'src', 'PerfCheckerNativeFixture.jl'), 'module PerfCheckerNativeFixture\nBase.@noinline sum_squares(xs) = sum(xs .^ 2)\nBase.@noinline wait_task(x) = (values=fill(x,1_000_000); sleep(0.005); values[1])\nend\n');
  await fs.writeFile(path.join(workspace, 'test', 'performance.jl'), 'using TestItems\n@testitem "Vector reduction" tags=[:performance] begin\n data=collect(1:10_000)\n @test sum(data)==50_005_000\nend\n');
  const vsix = path.join(session, 'perfchecker.vsix');
  if (mode === 'public') {
    const response = await fetch('https://github.com/Mirage-Interactive-Fr/PerfCheckerVSCode/releases/download/v1.0.0/perfchecker-vscode-1.0.0.vsix');
    if (!response.ok) throw new Error(`Public VSIX download failed: ${response.status}`);
    await fs.writeFile(vsix, Buffer.from(await response.arrayBuffer()));
  } else await fs.copyFile(path.join(repository, 'candidate.vsix'), vsix);
  const sha = createHash('sha256').update(await fs.readFile(vsix)).digest('hex');
  if (mode === 'public' && sha !== publicSha) throw new Error('Public VSIX SHA256 differs from the published qualification.');
  if (mode === 'candidate' && (!/^[a-f0-9]{64}$/.test(process.env.PERFCHECKER_NATIVE_CANDIDATE_SHA||'')||sha!==process.env.PERFCHECKER_NATIVE_CANDIDATE_SHA))
    throw new Error('The installed candidate must match the canonical package shared by every qualification host.');
  const retainedVsix=`perfchecker-vscode-${expectedVersion}.vsix`;
  await fs.copyFile(vsix,path.join(output,retainedVsix));
  if(createHash('sha256').update(await fs.readFile(path.join(output,retainedVsix))).digest('hex')!==sha)
    throw new Error('The retained release artifact differs from the actual installed VSIX.');
  let packageProvenance;
  if(mode==='candidate'){
    packageProvenance=JSON.parse(await fs.readFile(path.join(repository,'candidate.provenance.json'),'utf8'));
    if(packageProvenance.sha256!==sha||packageProvenance.version!==expectedVersion)throw new Error('The candidate package provenance differs from the installed archive.');
    await fs.writeFile(path.join(output,'candidate.provenance.json'),JSON.stringify(packageProvenance,null,2));
  }
  const privateProfile=async root=>{
    const directories=privateDirectoryFlags.map(flag=>[flag,path.join(root,flag)]);
    await Promise.all(directories.map(([,directory])=>fs.mkdir(directory,{recursive:true})));
    return [`--user-data-dir=${root}`,`--extensions-dir=${extensions}`,...directories.map(([flag,directory])=>`--${flag}=${directory}`)];
  };
  const cliProfile = await privateProfile(profile);
  await execute(cli, [...cliArgs, ...cliProfile, '--install-extension', vsix, '--force'], {shell: process.platform === 'win32' && cli.endsWith('.cmd')});
  const artifactRecord={mode,retainedVsix,sha256: sha,vscodeRequested: version,core:coreProvenance,packageProvenance,
    runtimes:{perfchecker:runtime,officialJulia:officialRuntime},hostPreferences:{scope:'disposable-application-profile',dialogStyle:'custom',dialogAPI:'real-VS-Code-no-interception',actualVersion:hostVersion,
      actualCommit:application.commit,applicationName:application.applicationName,applicationRelativePath:path.relative(path.dirname(vscode),application.application),
      cliRelativePath:path.relative(path.dirname(vscode),cli),privateDirectoryFlags}};
  await fs.writeFile(path.join(output, 'artifact.json'), JSON.stringify(artifactRecord, null, 2));
  const minimumResponse=await fetch('https://raw.githubusercontent.com/JuliaRegistries/General/master/P/PerfChecker/Versions.toml');
  if(!minimumResponse.ok)throw new Error(`Cannot verify the production minimum in General: ${minimumResponse.status}`);
  const minimumAvailable=/^\["1\.0\.1"\]$/m.test(await minimumResponse.text());
  await fs.writeFile(path.join(output,'production-bootstrap-gate.json'),JSON.stringify({minimum:'1.0.1',registry:'General',available:minimumAvailable,
    status:minimumAvailable?'native-positive-test-required':'awaiting-human-registration',candidateFunctions:coreProvenance},null,2));

  const launch = async phase => {
    let recording,recorded,videoStartedAt,recordingError='',externalBrowser;
    // Each independently launched phase has its own disposable profile. Reusing
    // the reload phase's persisted window state restores two windows and starts
    // two driver activations before either can test the next protocol.
    const phaseProfile=path.join(profile,phase);
    await fs.mkdir(path.join(phaseProfile,'User'),{recursive:true});
    await fs.copyFile(path.join(profile,'User','settings.json'),path.join(phaseProfile,'User','settings.json'));
    if(phase==='restricted'){
      const settingsFile=path.join(phaseProfile,'User','settings.json');
      await fs.writeFile(settingsFile,JSON.stringify({...JSON.parse(await fs.readFile(settingsFile,'utf8')),'security.workspace.trust.startupPrompt':'always'}));
    }
    const phaseCliProfile=await privateProfile(phaseProfile);
    const video=path.join(output,`native-${process.platform}-vscode-${version}-${expectedVersion}-${phase}.mp4`);
    const display=phase==='landscape'?landscapeFixture.environment.DISPLAY:process.env.DISPLAY;
    const retainHostLogs=async()=>{
      const origin=path.join(phaseProfile,'logs'),destination=path.join(output,'host-startup-logs',phase);
      for(const relative of await fs.readdir(origin,{recursive:true}).catch(()=>[])){
        const source=path.join(origin,relative),stat=await fs.stat(source).catch(()=>undefined);
        if(!stat?.isFile()||stat.size>2000000||!relative.endsWith('.log'))continue;
        const target=path.join(destination,relative);await fs.mkdir(path.dirname(target),{recursive:true});
        const text=(await fs.readFile(source,'utf8')).replace(/([?&]secret=)[^&\s"'<>]*/gi,'$1[session secret]')
          .replace(/(secret%3D)[^%\s"'<>]*/gi,'$1[session secret]');
        await fs.writeFile(target,text);
      }
    };
    try {
      if(process.platform==='linux'&&version==='stable'&&(phase==='prepared'&&stage==='full'||phase==='mcp-pluto')){
        const require=createRequire(import.meta.url);
        externalBrowser=await require('./native-external-browser.cjs').create(session,{chromium:require('playwright').chromium});
      }
      if(process.env.PERFCHECKER_NATIVE_VIDEO==='1'){
        if(process.platform!=='linux'||version!=='stable'||!display)throw new Error('Native video recording requires the explicitly selected Linux stable Xvfb host.');
        await execute('ffmpeg',['-version']);videoStartedAt=new Date().toISOString();
        recording=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','x11grab','-framerate','15',
          '-video_size','1920x1080','-draw_mouse','1','-i',display,'-an','-c:v','libx264','-preset','ultrafast',
          '-threads','2','-crf','23','-pix_fmt','yuv420p',video],{stdio:['pipe','ignore','pipe']});
        recording.stderr.on('data',data=>{recordingError=(recordingError+data.toString()).slice(-5000);});
        recorded=new Promise(resolve=>{recording.once('close',code=>resolve(code));recording.once('error',error=>{recordingError=String(error);resolve(-1);});});
        console.log(`NATIVE_VIDEO_START ${phase} ${videoStartedAt}`);
      }
      const environment={...runnerEnvironment,...externalBrowser?.environment,...(phase==='landscape'?landscapeFixture.environment:{}),PERFCHECKER_NATIVE_PHASE: phase, PERFCHECKER_NATIVE_INVOCATION:randomUUID(),PERFCHECKER_NATIVE_OUTPUT: output, PERFCHECKER_NATIVE_PROFILE: phaseProfile,
        PERFCHECKER_NATIVE_SESSION:session,PERFCHECKER_NATIVE_WORKSPACE: workspace, PERFCHECKER_NATIVE_CONTROLLER: controller,
        PERFCHECKER_NATIVE_TARGET: target, PERFCHECKER_NATIVE_JULIA: julia,
        PERFCHECKER_NATIVE_OFFICIAL_JULIA:officialRuntime.executable,PERFCHECKER_NATIVE_OFFICIAL_JULIA_VERSION:officialRuntime.version,
        PERFCHECKER_NATIVE_MODE: mode, PERFCHECKER_NATIVE_SHA: sha,
        PERFCHECKER_NATIVE_STAGE: process.env.PERFCHECKER_NATIVE_STAGE || 'smoke',
        PERFCHECKER_NATIVE_EXPECTED_VERSION: expectedVersion, PERFCHECKER_NATIVE_JULIA_VERSION: runtime.version,
        PERFCHECKER_NATIVE_CORE_VERSION: expectedCoreVersion, PERFCHECKER_NATIVE_CORE_PROVENANCE:JSON.stringify(coreProvenance),
        PERFCHECKER_NATIVE_GENERAL_MINIMUM_AVAILABLE:String(minimumAvailable),
        PERFCHECKER_NATIVE_VIDEO_STARTED_AT:videoStartedAt||'',
        UV_THREADPOOL_SIZE: '4'};
      await new Promise((resolve,reject)=>{
        // Actual interactive host: no --extensionTestsPath or smoke driver, and
        // no intercepted APIs. All dialogs are clicked through the real UI.
        const child=spawn(vscode,[phase==='prepared'||stage==='focused'?workspaceFile:workspace,...phaseCliProfile,'--new-window','--skip-welcome','--skip-release-notes',
          ...(phase==='restricted'?[]:['--disable-workspace-trust']),...(phase==='pluto-plots'?['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']:['--disable-gpu']),'--remote-debugging-port=9222',
          ...(process.platform==='linux'?['--no-sandbox']:[]),
          `--extensionDevelopmentPath=${path.join(repository,'test','qualification-host')}`],
          {env:environment,windowsHide:false,detached:process.platform!=='win32',stdio:'inherit'});
        let activated=false,seenChecks=0,seenFailures=0,reading=false,activeCase;
        const progress=setInterval(async()=>{
          if(reading)return;reading=true;
          try{
            if(!activated){const boot=JSON.parse(await fs.readFile(path.join(output,`${phase}-bootstrap.json`),'utf8'));activated=true;clearTimeout(activationTimer);console.log(`NATIVE_HOST_ACTIVATED ${phase} VSCode ${boot.vscode}`);}
            const report=JSON.parse(await fs.readFile(path.join(output,`${phase}.json`),'utf8'));
            if(report.activeCase&&report.activeCase!==activeCase)console.log(`NATIVE_CASE_START ${phase} ${report.activeCase}`);
            activeCase=report.activeCase;
            for(const check of report.checks.slice(seenChecks))console.log(`NATIVE_CHECK ${phase} ${check.name} ${check.status??'observed'}`);
            for(const failure of report.failures.slice(seenFailures))console.log(`NATIVE_FAILURE ${phase} ${failure.name}: ${failure.message}`);
            seenChecks=report.checks.length;seenFailures=report.failures.length;
          }catch(error){if(!['ENOENT'].includes(error.code)&&!(error instanceof SyntaxError))console.log(`NATIVE_PROGRESS ${phase}: ${error.message}`);}
          finally{reading=false;}
        },2000);
        const stop=()=>{if(child.exitCode!==null)return;if(process.platform==='win32')spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true});else try{process.kill(-child.pid,'SIGTERM');}catch{}};
        const activationTimer=setTimeout(()=>{if(activated)return;void(async()=>{
          await retainHostLogs().catch(error=>console.error(`NATIVE_STARTUP_LOGS ${error.message}`));stop();
          reject(new Error(`The ${phase} helper did not activate within 3 minutes. Retained Electron/extension-host logs distinguish startup failure from campaign duration.`));
        })();},180000);
        const minutes=phase==='prepared'&&environment.PERFCHECKER_NATIVE_STAGE==='full'?130:40;
        const deadlineStartedAt=new Date().toISOString();
        let globalDeadlineExpired=false;
        const timer=setTimeout(()=>{globalDeadlineExpired=true;void(async()=>{
          const failure=new Error(`The ${phase} native phase exceeded its explicit ${minutes}-minute bound`);
          try{await fs.writeFile(path.join(output,`${phase}-global-limit.json`),JSON.stringify({status:'failed',phase,
            stage:environment.PERFCHECKER_NATIVE_STAGE,limitMinutes:minutes,startedAt:deadlineStartedAt,
            expiredAt:new Date().toISOString(),lastObservedCase:activeCase||null,
            hostStopRequested:true,productCleanupQualified:false,error:failure.message},null,2));}
          catch(error){console.error(`NATIVE_GLOBAL_LIMIT_REPORT ${error.message}`);}
          stop();reject(failure);
        })();},minutes*60*1000);
        const onInterrupt=()=>stop();process.once('SIGINT',onInterrupt);process.once('SIGTERM',onInterrupt);
        const clean=()=>{clearTimeout(timer);clearTimeout(activationTimer);clearInterval(progress);process.off('SIGINT',onInterrupt);process.off('SIGTERM',onInterrupt);};
        child.once('error',error=>{clean();if(!globalDeadlineExpired)reject(error);});
        child.once('close',async code=>{clean();if(globalDeadlineExpired)return;try{
          const result=JSON.parse(await fs.readFile(path.join(output,`${phase}-finished.json`),'utf8'));
          if(globalDeadlineExpired)return;
          result.status==='passed'?resolve():reject(new Error(result.error||`${phase} failed`));
        }catch(error){if(!globalDeadlineExpired)reject(new Error(`Native host exited ${code} before writing its final qualification: ${error}`));}});
      });
    } catch (error) {await retainHostLogs().catch(logError=>console.error(`NATIVE_HOST_LOGS ${logError.message}`));phaseFailures.push({phase, error: String(error)});}
    finally {
      await externalBrowser?.close();
      if(recording){
        recording.stdin.on('error',()=>{});recording.stdin.end('q\n');
        const timeout=setTimeout(()=>recording.kill('SIGKILL'),15000);
        const code=await recorded;clearTimeout(timeout);
        if(code!==0)phaseFailures.push({phase,kind:'recording',error:`Real Xvfb recording failed (${code}): ${recordingError}`});
        else{
          const probe=JSON.parse(await execute('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name,width,height,avg_frame_rate','-of','json',video]));
          await fs.writeFile(video.replace(/\.mp4$/,'.json'),JSON.stringify({file:path.basename(video),source:'actual-Xvfb-screen',phase,
            startedAt:videoStartedAt,timeline:`${phase}.json`,timestampPrecision:'Wall-clock offsets from recorder launch; correlate with native UI events and review frames before editing.',
            vscodeRequested:version,extension:expectedVersion,core:coreProvenance,fixtures:'Disposable deterministic qualification data; no human model authentication',
            sha256:createHash('sha256').update(await fs.readFile(video)).digest('hex'),probe},null,2));
        }
      }
    }
  };
  // The first real launch has no PerfChecker settings, Julia or Jupyter extension.
  if(completeCampaign)await launch('fresh');
  const installation=await execute(julia, ['--startup-file=no', '-e', `using Pkg; Pkg.activate(ARGS[1]); ${installCore}; if ARGS[6]!="landscape";Pkg.add(["TestItemRunner","HTTP","BenchmarkTools","Chairmarks","JET","AllocCheck"]);end; using PerfChecker; @assert Base.pkgversion(PerfChecker)==VersionNumber(ARGS[4]); info=Pkg.dependencies()[Base.PkgId(PerfChecker).uuid]; if !isempty(ARGS[3]); @assert string(info.tree_hash)==ARGS[3]; else; @assert info.is_tracking_registry; end; print("QUALIFIED_CORE_PROVENANCE ");PerfChecker.JSON.print(Dict("version"=>string(Base.pkgversion(PerfChecker)),"tree"=>string(info.tree_hash),"registered"=>info.is_tracking_registry));println();println("QUALIFIED_CORE_MODE=", ARGS[5], " VERSION=", Base.pkgversion(PerfChecker), " TREE=",info.tree_hash," SOURCE=", pathof(PerfChecker))`, controller,coreCommit,coreTree,expectedCoreVersion,coreMode,landscapeOnly?'landscape':'standard'],{timeout:landscapeOnly?900000:undefined});
  const installed=JSON.parse(installation.split(/\r?\n/).find(line=>line.startsWith('QUALIFIED_CORE_PROVENANCE ')).slice('QUALIFIED_CORE_PROVENANCE '.length));
  if(installed.version!==expectedCoreVersion||!/^[a-f0-9]{40}$/.test(installed.tree)||coreMode==='general'&&!installed.registered)
    throw new Error('The actual Core installation must match its version and registry/candidate provenance.');
  Object.assign(coreProvenance,installed);
  await fs.writeFile(path.join(output, 'artifact.json'), JSON.stringify(artifactRecord, null, 2));
  if(!landscapeOnly){
  if(stage==='full'||stage==='focused'&&caseGroup==='investigation')await execute(julia,['--startup-file=no','-e','using Pkg;Pkg.activate(ARGS[1]);Pkg.add(["Aqua","SnoopCompile"]);using Aqua,SnoopCompile;println("OPTIONAL_ANALYZER_INSTALL Aqua=",Base.pkgversion(Aqua)," SnoopCompile=",Base.pkgversion(SnoopCompile))',controller]);
  await execute(julia, ['--startup-file=no', '-e', 'using Pkg; Pkg.activate(ARGS[1]); Pkg.add(["BenchmarkTools","Chairmarks","TestItems"]); Pkg.activate(ARGS[2]); Pkg.add("TestItems")', target, workspace]);
  await fs.mkdir(path.join(workspace, 'perf'), {recursive: true});
  // Fresh first-use evidence belongs to the starter; the prepared campaign uses its own reports.
  await fs.rm(path.join(workspace,'perf','results'),{recursive:true,force:true});
  await fs.rm(path.join(workspace,'perf','perfchecker-ui.json'),{force:true});
  await fs.writeFile(path.join(workspace, 'perf', 'sum.jl'), 'using PerfCheckerNativeFixture\nperf_setup() = collect(1.0:1000.0)\nperf_workload(xs) = PerfCheckerNativeFixture.sum_squares(xs)\nperf_oracle(xs) = perf_workload(xs) == 333833500.0\n');
  await fs.writeFile(path.join(workspace,'perf','profile-sum.jl'),'using PerfCheckerNativeFixture\nperf_setup() = collect(1.0:1_000_000.0)\nperf_workload(xs) = PerfCheckerNativeFixture.sum_squares(xs)\nperf_oracle(xs,result) = isapprox(result,1_000_000.0*1_000_001.0*2_000_001.0/6;rtol=1e-12)\n');
  await fs.writeFile(path.join(workspace, 'perf', 'wait.jl'), 'using PerfCheckerNativeFixture\nperf_setup() = 42\nperf_workload(x) = PerfCheckerNativeFixture.wait_task(x)\nperf_oracle(x) = perf_workload(x) == 42\n');
  await fs.writeFile(path.join(workspace, 'perf', 'cases.jl'), 'make_sum_case(p) = (prepare=()->collect(1.0:1000.0), operation=xs->sum(xs.^2), verify=(xs,result)->result==333833500.0)\nmake_wait_case(p) = (prepare=()->42, operation=x->(sleep(0.005);x), verify=(x,result)->result==42)\nmake_cancel_case(p) = (prepare=()->42, operation=x->(write(p["marker"],"running");sleep(30);x), verify=(x,result)->result==42)\n');
  // A distinct bounded workload gives CPU sampling actual operation time;
  // ordinary benchmark and diagnosis examples keep their small input.
  await fs.appendFile(path.join(workspace,'perf','cases.jl'),'Base.@noinline function native_profile_sum(xs)\n result=0.0\n for _ in 1:64\n  result=sum(xs.^2)\n end\n result\nend\nmake_profile_case(p) = (prepare=()->collect(1.0:1_000_000.0), operation=native_profile_sum, verify=(xs,result)->isapprox(result,1_000_000.0*1_000_001.0*2_000_001.0/6;rtol=1e-12))\n');
  await fs.appendFile(path.join(workspace,'perf','cases.jl'),'make_owned_cancel_case(p) = (prepare=()->mktempdir(cleanup=false), operation=directory->begin write(joinpath(directory,"owned.tmp"),"owned");write(p["marker"],string(getpid())*"\\n"*directory*"\\n"*dirname(Base.ARGS[1]));sleep(120);42 end, verify=(directory,result)->result==42, cleanup=directory->begin rm(directory;recursive=true,force=true);write(p["cleaned"],"cleaned") end)\n');
  await fs.writeFile(path.join(workspace,'perf','owned-cancel.jl'),`perf_setup() = dirname(Base.active_project())
function perf_workload(directory)
 write(joinpath(directory,"owned.tmp"),"owned")
 write(joinpath(@__DIR__,"owned-suite-worker.marker"),string(getpid())*"\\n"*directory)
 sleep(120);42
end
# The lifecycle marker must come from the measured allocation operation,
# rather than the two-argument oracle fallback executing that operation first.
perf_oracle(directory) = isdir(directory)
`);
  await fs.writeFile(path.join(workspace,'perf','owned-suite.jl'),'using PerfChecker\nfunction build_suite()\n f=FeatureSpec(:owned_stop;backend=:alloc,entrypoint=joinpath(@__DIR__,"owned-cancel.jl"),oracle=OracleSpec())\n SoftwareSuite(:owned_stop,[PackageSuite("PerfCheckerNativeFixture";source=dirname(@__DIR__),worker_environment=joinpath(dirname(@__DIR__),"worker-environment"),versions=VersionNumber[],features=[f])])\nend\n');
  await fs.writeFile(path.join(workspace, 'perf', 'scenarios.toml'), 'schema_version = "perfchecker-scenario-catalog/1"\nroot = "."\n[[scenarios]]\nid = "sum_squares"\nimplementation = "allocating"\nsource = "cases.jl"\nfactory = "make_sum_case"\ncollectors = ["benchmark", "chairmark", "profile", "profile_alloc"]\n[[scenarios]]\nid = "wait_task"\nimplementation = "waiting"\nsource = "cases.jl"\nfactory = "make_wait_case"\ncollectors = ["benchmark"]\n');
  await fs.appendFile(path.join(workspace,'perf','scenarios.toml'),'[[scenarios]]\nid = "sampled_sum_squares"\nimplementation = "sampled"\nsource = "cases.jl"\nfactory = "make_profile_case"\ncollectors = ["benchmark", "chairmark", "profile", "profile_alloc"]\n');
  if(stage==='full'||stage==='focused'&&caseGroup==='investigation'){
    const catalog=path.join(workspace,'perf','scenarios.toml');
    // Aqua needs the actual target package, rather than the perf script folder.
    // Declared source paths remain relative to the catalog's own directory.
    await fs.writeFile(catalog,(await fs.readFile(catalog,'utf8')).replace('root = "."','root = ".."'));
  }
  await fs.writeFile(path.join(workspace, 'perf', 'example.jl'), 'using Example\nperf_setup() = "PerfChecker"\nperf_workload(name) = Example.hello(name)\nperf_oracle(name,result) = occursin(name,result)\n');
  await fs.writeFile(path.join(workspace,'perf','network.jl'), `using Sockets
perf_setup() = collect(UInt8(0):UInt8(127))
function perf_workload(payload)
 server=listen(ip"127.0.0.1",0); port=getsockname(server)[2]
 task=@async begin
  peer=accept(server)
  try; data=read(peer,length(payload));write(peer,data);flush(peer);finally;close(peer);end
 end
 client=connect(ip"127.0.0.1",port)
 try
  write(client,payload);flush(client);returned=read(client,length(payload));wait(task)
  @assert returned==payload
  (bytes_sent=length(payload),bytes_received=length(returned),operations=1)
 finally;close(client);close(server);end
end
perf_oracle(payload,result) = result.bytes_sent==128 && result.bytes_received==128 && result.operations==1
`);
  const capabilities=JSON.parse((await execute(julia,['--startup-file=no',`--project=${controller}`,'-e','using PerfChecker; PerfChecker.JSON.print(stdout,Dict("interface"=>network_interface_capabilities(),"isolated"=>network_isolation_capabilities(probe=true)),2)'])).trim());
  await fs.writeFile(path.join(output,'network-capabilities.json'),JSON.stringify(capabilities,null,2));
  await execute('git', ['init'], {cwd: workspace});
  await execute('git', ['config', 'user.name', 'PerfChecker native fixture'], {cwd: workspace});
  await execute('git', ['config', 'user.email', 'fixture@example.invalid'], {cwd: workspace});
  await execute('git', ['config', 'commit.gpgsign', 'false'], {cwd: workspace});
  await execute('git', ['add', '.'], {cwd: workspace});
  await execute('git', ['commit', '-m', 'Baseline fixture'], {cwd: workspace});
  await execute('git', ['tag', 'v0.1.0'], {cwd: workspace});
  await execute('git', ['branch', 'native-baseline'], {cwd: workspace});
  const baseline = (await execute('git', ['rev-parse', 'HEAD'], {cwd: workspace})).trim();
  await fs.writeFile(path.join(workspace,'perf','suite.jl'),`using PerfChecker
function build_suite()
 features=FeatureSpec[]
 for (workload,file) in [(:sum_squares,"sum.jl"),(:wait_task,"wait.jl")], backend in [:benchmark,:chairmark,:profile,:wall_profile,:profile_alloc,:alloc]
  options=Dict{Symbol,Any}(:samples=>3,:seconds=>0.03,:evals=>1,:repeat=>false,:targets=>["PerfCheckerNativeFixture"],:profile_seconds=>0.5,:profile_delay=>0.0005,:profile_repetitions=>3,:sample_rate=>1.0)
  entrypoint=workload===:sum_squares && backend in (:profile,:wall_profile) ? "profile-sum.jl" : file
  push!(features,FeatureSpec(Symbol(workload,"_",backend);workload,backend,entrypoint=joinpath(@__DIR__,entrypoint),options,oracle=OracleSpec()))
 end
 for (backend,supported,reason) in [(:network,true,""),(:network_interface,${capabilities.interface.supported},${JSON.stringify(capabilities.interface.supported ? '' : 'Native interface counters unavailable on this operating system')}),(:network_isolated,${capabilities.isolated.supported},${JSON.stringify(capabilities.isolated.reason)})]
  push!(features,FeatureSpec(Symbol("tcp_",backend);workload=:tcp_roundtrip,backend,description=reason,
   entrypoint=joinpath(@__DIR__,"network.jl"),until=supported ? nothing : v"0.0.0",
   options=Dict{Symbol,Any}(:repeat=>false,:network_repetitions=>2,:network_interface=>(Sys.islinux() ? "lo" : "auto")),oracle=OracleSpec()))
 end
 package=PackageSuite("PerfCheckerNativeFixture";source=dirname(@__DIR__),worker_environment=joinpath(dirname(@__DIR__),"worker-environment"),versions=VersionNumber[],features,candidates=[SuiteCandidate("baseline",${JSON.stringify(baseline)};source=dirname(@__DIR__),compatibility_version=v"0.1.0")])
 example=PackageSuite("Example";worker_environment=joinpath(dirname(@__DIR__),"worker-environment"),versions=[v"0.5.0",v"0.5.3",v"0.5.4",v"0.5.5"],include_dev=false,features=[FeatureSpec(:hello;workload=:hello,backend=:benchmark,entrypoint=joinpath(@__DIR__,"example.jl"),options=Dict(:samples=>3,:seconds=>0.03,:evals=>1),oracle=OracleSpec())])
 SoftwareSuite(:native_fixture,[package,example])
end
`);
  await fs.writeFile(path.join(workspace, 'perf', 'large-suite.jl'), 'using PerfChecker\nfunction build_suite()\n features=[FeatureSpec(Symbol("workload_",i);workload=Symbol("workload_",i),backend=:benchmark,entrypoint=joinpath(@__DIR__,"sum.jl")) for i in 1:125]\n SoftwareSuite(:large_native_fixture,[PackageSuite("PerfCheckerNativeFixture";source=dirname(@__DIR__),worker_environment=joinpath(dirname(@__DIR__),"worker-environment"),versions=VersionNumber[],features)])\nend\n');
  await fs.mkdir(path.join(workspace, '.vscode'),{recursive:true});
  await fs.writeFile(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({'julia.executablePath': officialRuntime.executable, 'julia.enableTelemetry': false, 'julia.symbolCacheDownload': false, 'git.enabled': false, 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none'}));
  const plutoProject=path.join(workspace,'perf','pluto');
  if(mode==='candidate'&&(completeCampaign||stage==='focused'&&['mcp-pluto','pluto-plots'].includes(caseGroup))){
    const companion={commit:'7e9c380f0b6f08676c73658743661dcc5f826162',tree:'9bc464202aa5b60262be9483bda5968bacd2960a',version:'1.0.1'};
    const revision=coreMode==='candidate'?companion.commit:'v1.0.1';
    const text=await execute(julia,['--startup-file=no','-e',`using Pkg; Pkg.activate(ARGS[1]); ${installCore}; Pkg.add([PackageSpec(name="Pluto",version="1.0.4"),PackageSpec(name="PlutoUI"),PackageSpec(name="BenchmarkTools"),PackageSpec(name="Chairmarks")]); Pkg.add(PackageSpec(url="https://github.com/Mirage-Interactive-Fr/PerfChecker.jl",subdir="packages/PerfCheckerPluto",rev=ARGS[7]);preserve=Pkg.PRESERVE_ALL); using PerfChecker,PerfCheckerPluto,Pluto,PlutoUI; @assert Base.pkgversion(Pluto)==v"1.0.4";@assert Base.pkgversion(PerfCheckerPluto)==v"1.0.1";@assert Base.pkgversion(PerfChecker)==VersionNumber(ARGS[4]);info=Pkg.dependencies()[Base.PkgId(PerfChecker).uuid];@assert string(info.tree_hash)==ARGS[6];@assert string(Pkg.dependencies()[Base.PkgId(PerfCheckerPluto).uuid].tree_hash)==ARGS[8];if ARGS[5]=="general";@assert info.is_tracking_registry;end;print("PLUTO_ENV_PROVENANCE ");PerfChecker.JSON.print(Dict(string(nameof(m))=>Dict("version"=>string(Base.pkgversion(m)),"tree"=>string(Pkg.dependencies()[Base.PkgId(m).uuid].tree_hash)) for m in (PerfChecker,PerfCheckerPluto,Pluto,PlutoUI)));println()`,plutoProject,coreCommit,coreTree,expectedCoreVersion,coreMode,coreProvenance.tree,revision,companion.tree]);
    artifactRecord.plutoEnvironment={companion:{...companion,revision},packages:JSON.parse(text.split(/\r?\n/).find(line=>line.startsWith('PLUTO_ENV_PROVENANCE ')).slice('PLUTO_ENV_PROVENANCE '.length))};
    await fs.writeFile(path.join(output,'artifact.json'),JSON.stringify(artifactRecord,null,2));
  }
  if(stage==='focused'&&caseGroup==='pluto-plots'){
    const pins={makieCommit:'74d0deca140f34e72e2d074d185838ecc6980ecb',plutoCommit:'7e9c380f0b6f08676c73658743661dcc5f826162',makieTree:'300c1a3ee5c32a8fc7e5245d00badb3f68c235f6',plutoTree:'9bc464202aa5b60262be9483bda5968bacd2960a',WGLMakie:'0.13.15',Makie:'0.24.15',Bonito:'4.2.0'};
    const text=await execute(julia,['--startup-file=no','-e',      'using Pkg;Pkg.activate(ARGS[1]);Pkg.add([PackageSpec(url="https://github.com/Mirage-Interactive-Fr/PerfChecker.jl",subdir="packages/PerfCheckerMakie",rev=ARGS[2]),PackageSpec(name="WGLMakie",version="0.13.15"),PackageSpec(name="Makie",version="0.24.15"),PackageSpec(name="Bonito",version="4.2.0")];preserve=Pkg.PRESERVE_ALL);using PerfChecker,PerfCheckerMakie,PerfCheckerPluto,WGLMakie,Makie,Bonito,Pluto;@assert Base.pkgversion(PerfCheckerPluto)==v"1.0.1";@assert Base.pkgversion(Pluto)==v"1.0.4";@assert Base.pkgversion(WGLMakie)==v"0.13.15";@assert Base.pkgversion(Makie)==v"0.24.15";@assert Base.pkgversion(Bonito)==v"4.2.0";@assert Base.get_extension(PerfCheckerMakie,:WGLMakieExt)!==nothing;@assert string(Pkg.dependencies()[Base.PkgId(PerfCheckerMakie).uuid].tree_hash)==ARGS[3];@assert string(Pkg.dependencies()[Base.PkgId(PerfCheckerPluto).uuid].tree_hash)==ARGS[4];@assert string(Pkg.dependencies()[Base.PkgId(PerfChecker).uuid].tree_hash)==ARGS[5];print("PLUTO_PLOT_PROVENANCE ");PerfChecker.JSON.print(Dict(string(nameof(m))=>Dict("version"=>string(Base.pkgversion(m)),"tree"=>string(Pkg.dependencies()[Base.PkgId(m).uuid].tree_hash)) for m in (PerfChecker,PerfCheckerMakie,PerfCheckerPluto,WGLMakie,Makie,Bonito,Pluto)));println()',plutoProject,pins.makieCommit,pins.makieTree,pins.plutoTree,coreProvenance.tree]);
    const provenance=JSON.parse(text.split(/\r?\n/).find(line=>line.startsWith('PLUTO_PLOT_PROVENANCE ')).slice('PLUTO_PLOT_PROVENANCE '.length));
    await fs.writeFile(path.join(output,'pluto-plot-provider-provenance.json'),JSON.stringify({pins,providers:provenance,manifestSha256:createHash('sha256').update(await fs.readFile(path.join(plutoProject,'Manifest.toml'))).digest('hex'),renderer:'Disposable Electron ANGLE/SwiftShader; no physical GPU qualification'},null,2));
  }
  if(completeCampaign)await launch('configured');
  // TestItemRunner's default imports use the chosen controller. This explicit fixture
  // preparation is separate from production bootstrap, which never develops a user's package.
  // The focused missing-target check keeps this controller unprepared.
  if(!(stage==='focused'&&caseGroup==='testitems'))
    await execute(julia,['--startup-file=no','-e','using Pkg;Pkg.activate(ARGS[1]);Pkg.develop(path=ARGS[2]);println("TESTITEM_TARGET_EXPLICITLY_PREPARED=",ARGS[2])',controller,workspace]);
  for (const extension of completeCampaign||stage==='focused'&&caseGroup==='workbench'?(mode==='public'?['julialang.language-julia','ms-toolsai.jupyter']:['julialang.language-julia']):[]) {
    await execute(cli, [...cliArgs, ...cliProfile, '--install-extension', extension], {shell: process.platform === 'win32' && cli.endsWith('.cmd')});
  }
  }else{
    landscapeFixture=await prepareLandscapeFixture(runtime);
    artifactRecord.landscapeFixture=landscapeFixture.provenance;
    await fs.writeFile(path.join(output,'artifact.json'),JSON.stringify(artifactRecord,null,2));
  }
  // Adding a second folder to a single-folder window converts its workspace and
  // restarts the extension host. Start the multi-root campaign in a real saved
  // workspace so those buttons are tested once without restarting the driver.
  // Julia's executable resolver reads unscoped configuration. A saved multi-root
  // workspace needs this setting at workspace scope, not in an individual folder.
  await fs.writeFile(workspaceFile,JSON.stringify({folders:[{path:workspace},...(landscapeOnly?[{path:landscapeFixture.root}]:[])],settings:{'julia.executablePath':officialRuntime.executable}},null,2));
  if(stage==='targeted'){
    if(mode!=='candidate')throw new Error('The targeted lifecycle/protocol campaign requires an explicit exact candidate archive.');
    await launch('reload');
    await launch('narrative');
  }else if(stage==='focused'){
    if(mode!=='candidate')throw new Error('Focused native controls require an explicit exact candidate archive.');
    await launch(caseGroup);
  }else await launch('prepared');
  if (phaseFailures.length) throw new Error(JSON.stringify(phaseFailures));
  }
} catch(error){landscapePrimaryError=error;throw error;}
finally {
  if(landscapeOnly){
    process.off('SIGINT',abortLandscape);process.off('SIGTERM',abortLandscape);
    await landscapeObserver?.sample();
    const errors=[],display=landscapeFixture?.displayChild;
    // Observe ownership continuously, including detached descendants after a parent exits.
    // A forced harness cleanup is a failure, never the native command's success oracle.
    const remaining=(await livingLandscapeProcesses()).filter(record=>record.pid!==display?.pid);
    if(remaining.length){
      errors.push(new Error(`Landscape native session still owns processes before teardown: ${remaining.map(record=>record.pid).join(',')}`));
      for(const signal of ['SIGTERM','SIGKILL']){
        const signalled=new Set();
        const until=Date.now()+(signal==='SIGTERM'?5000:2000);
        do{
          await landscapeObserver?.sample();
          for(const record of (await livingLandscapeProcesses()).reverse()){
            if(record.pid===display?.pid)continue;
            const identity=record.pid+'/'+record.started,current=await landscapeIdentity(record.pid);
            if(signalled.has(identity)||current?.started!==record.started||current.state==='Z')continue;
            try{process.kill(record.pid,signal);signalled.add(identity);}catch(error){if(error.code!=='ESRCH')errors.push(error);}
          }
          if(!(await livingLandscapeProcesses()).some(record=>record.pid!==display?.pid))break;
          await new Promise(resolve=>setTimeout(resolve,100));
        }while(Date.now()<until);
      }
    }
    if(display&&display.exitCode===null&&display.signalCode===null){
      display.kill('SIGTERM');await Promise.race([landscapeFixture.displayExit,new Promise(resolve=>setTimeout(resolve,2000))]);
      if(display.exitCode===null&&display.signalCode===null){display.kill('SIGKILL');await landscapeFixture.displayExit;}
    }
    clearInterval(landscapeObserver);await landscapeObserver?.sample();await landscapeObserver?.drain();
    errors.push(...landscapeObserverErrors);
    const survivors=await livingLandscapeProcesses();
    if(survivors.length||landscapeObserverErrors.length)errors.push(new Error(`Session preserved because the drained observer cannot confirm an empty owned tree: ${session}; PIDs=${survivors.map(record=>record.pid).join(',')}`));
    else await fs.rm(session,{recursive:true,force:true,maxRetries:12,retryDelay:500});
    if(errors.length)throw new AggregateError(landscapePrimaryError?[landscapePrimaryError,...errors]:errors,'Native Landscape or its owned failure cleanup failed');
  }else await fs.rm(session, {recursive: true, force: true, maxRetries: 12, retryDelay: 500});
}

function assertCI() {
  if (process.env.CI !== 'true') throw new Error('Native VS Code installation is restricted to disposable remote CI.');
  if (process.arch !== 'x64') throw new Error(`The registered core hardware dependency requires the explicitly tested x64 host, got ${process.arch}`);
}
