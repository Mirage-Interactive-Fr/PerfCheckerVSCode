import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath} from '@vscode/test-electron';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(repository, 'native-qualification-results');
const session = await fs.mkdtemp(path.join(os.tmpdir(), 'perfchecker-public-vsix-'));
let julia = process.env.PERFCHECKER_TEST_JULIA || 'julia';
const mode = process.env.PERFCHECKER_VSIX_MODE || 'public';
const coreMode=process.env.PERFCHECKER_NATIVE_CORE || 'general';
const coreCommit=process.env.PERFCHECKER_NATIVE_CORE_COMMIT || '';
const coreTree=process.env.PERFCHECKER_NATIVE_CORE_TREE || '';
if(!['general','candidate'].includes(coreMode))throw new Error('Choose the registered or explicitly pinned candidate Core.');
if(coreMode==='candidate' && ![coreCommit,coreTree].every(value=>/^[a-f0-9]{40}$/.test(value)))throw new Error('Core candidate mode requires an immutable commit and expected Git tree.');
const expectedCoreVersion=coreMode==='candidate'||mode==='candidate'?'1.0.1':'1.0.0';
const coreProvenance={mode:coreMode,version:expectedCoreVersion,...(coreMode==='candidate'?{commit:coreCommit,tree:coreTree}:{registry:'General'})};
const installCore=coreMode==='candidate'?'Pkg.add(Pkg.PackageSpec(url="https://github.com/Mirage-Interactive-Fr/PerfChecker.jl",rev=ARGS[2]))':`Pkg.add(Pkg.PackageSpec(name="PerfChecker",version="${expectedCoreVersion}"))`;
const version = process.env.PERFCHECKER_VSCODE_VERSION || 'stable';
const stage=process.env.PERFCHECKER_NATIVE_STAGE||'smoke';
if(!['smoke','full','targeted','core-external'].includes(stage))throw new Error('Choose smoke, full, targeted lifecycle/protocol, or the explicit Core-only external-process regression.');
const phaseFailures = [];
const publicSha = 'c4123271e71e4c4d148fe0e613ba260f4aeea6f28445338cab11d3fb9513df09';
if (!['public', 'candidate'].includes(mode)) throw new Error('Choose public or candidate VSIX explicitly.');

async function execute(executable, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {windowsHide: true, ...options});
    let text = '';
    child.stdout?.on('data', chunk => {text += chunk; process.stdout.write(chunk);});
    child.stderr?.on('data', chunk => {text += chunk; process.stderr.write(chunk);});
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(text) : reject(Object.assign(new Error(`${path.basename(executable)} exited ${code}\n${text.slice(-5000)}`), {commandOutput: text, exitCode: code})));
  });
}

try {
  await fs.mkdir(output, {recursive: true});
  assertCI();
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
  await fs.writeFile(path.join(workspace, 'src', 'PerfCheckerNativeFixture.jl'), 'module PerfCheckerNativeFixture\nBase.@noinline sum_squares(xs) = sum(xs .^ 2)\nBase.@noinline wait_task(x) = (values=fill(x,1000); sleep(0.005); values[1])\nend\n');
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
  const cliProfile = [`--user-data-dir=${profile}`, `--extensions-dir=${extensions}`];
  await execute(cli, [...cliArgs, ...cliProfile, '--install-extension', vsix, '--force'], {shell: process.platform === 'win32' && cli.endsWith('.cmd')});
  await fs.writeFile(path.join(output, 'artifact.json'), JSON.stringify({mode,retainedVsix,sha256: sha,vscodeRequested: version,core:coreProvenance,packageProvenance,
    runtimes:{perfchecker:runtime,officialJulia:officialRuntime},hostPreferences:{scope:'disposable-application-profile',dialogStyle:'custom',dialogAPI:'real-VS-Code-no-interception'}}, null, 2));
  const minimumResponse=await fetch('https://raw.githubusercontent.com/JuliaRegistries/General/master/P/PerfChecker/Versions.toml');
  if(!minimumResponse.ok)throw new Error(`Cannot verify the production minimum in General: ${minimumResponse.status}`);
  const minimumAvailable=/^\["1\.0\.1"\]$/m.test(await minimumResponse.text());
  await fs.writeFile(path.join(output,'production-bootstrap-gate.json'),JSON.stringify({minimum:'1.0.1',registry:'General',available:minimumAvailable,
    status:minimumAvailable?'native-positive-test-required':'awaiting-human-registration',candidateFunctions:coreProvenance},null,2));

  const launch = async phase => {
    let recording,recorded,videoStartedAt,recordingError='';
    const video=path.join(output,`native-${process.platform}-vscode-${version}-${expectedVersion}-${phase}.mp4`);
    const retainHostLogs=async()=>{
      const origin=path.join(profile,'logs'),destination=path.join(output,'host-startup-logs',phase);
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
      if(process.env.PERFCHECKER_NATIVE_VIDEO==='1'){
        if(process.platform!=='linux'||version!=='stable'||!process.env.DISPLAY)throw new Error('Native video recording requires the explicitly selected Linux stable Xvfb host.');
        await execute('ffmpeg',['-version']);videoStartedAt=new Date().toISOString();
        recording=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','x11grab','-framerate','15',
          '-video_size','1920x1080','-draw_mouse','1','-i',process.env.DISPLAY,'-an','-c:v','libx264','-preset','ultrafast',
          '-threads','2','-crf','23','-pix_fmt','yuv420p',video],{stdio:['pipe','ignore','pipe']});
        recording.stderr.on('data',data=>{recordingError=(recordingError+data.toString()).slice(-5000);});
        recorded=new Promise(resolve=>{recording.once('close',code=>resolve(code));recording.once('error',error=>{recordingError=String(error);resolve(-1);});});
        console.log(`NATIVE_VIDEO_START ${phase} ${videoStartedAt}`);
      }
      const environment={...process.env,PERFCHECKER_NATIVE_PHASE: phase, PERFCHECKER_NATIVE_INVOCATION:randomUUID(),PERFCHECKER_NATIVE_OUTPUT: output, PERFCHECKER_NATIVE_PROFILE: profile,
        PERFCHECKER_NATIVE_WORKSPACE: workspace, PERFCHECKER_NATIVE_CONTROLLER: controller,
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
        const child=spawn(vscode,[phase==='prepared'?workspaceFile:workspace,...cliProfile,'--new-window','--skip-welcome','--skip-release-notes',
          '--disable-workspace-trust','--disable-gpu','--remote-debugging-port=9222',
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
        const minutes=phase==='prepared'&&environment.PERFCHECKER_NATIVE_STAGE==='full'?70:40;
        const timer=setTimeout(()=>{stop();reject(new Error(`The ${phase} native phase exceeded its explicit ${minutes}-minute bound`));},minutes*60*1000);
        const onInterrupt=()=>stop();process.once('SIGINT',onInterrupt);process.once('SIGTERM',onInterrupt);
        const clean=()=>{clearTimeout(timer);clearTimeout(activationTimer);clearInterval(progress);process.off('SIGINT',onInterrupt);process.off('SIGTERM',onInterrupt);};
        child.once('error',error=>{clean();reject(error);});
        child.once('close',async code=>{clean();try{
          const result=JSON.parse(await fs.readFile(path.join(output,`${phase}-finished.json`),'utf8'));
          result.status==='passed'?resolve():reject(new Error(result.error||`${phase} failed`));
        }catch(error){reject(new Error(`Native host exited ${code} before writing its final qualification: ${error}`));}});
      });
    } catch (error) {await retainHostLogs().catch(logError=>console.error(`NATIVE_HOST_LOGS ${logError.message}`));phaseFailures.push({phase, error: String(error)});}
    finally {
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
  if(stage!=='targeted')await launch('fresh');
  await execute(julia, ['--startup-file=no', '-e', `using Pkg; Pkg.activate(ARGS[1]); ${installCore}; Pkg.add(["TestItemRunner","HTTP","BenchmarkTools","Chairmarks","JET","AllocCheck"]); using PerfChecker; @assert Base.pkgversion(PerfChecker)==VersionNumber(ARGS[4]); info=Pkg.dependencies()[Base.PkgId(PerfChecker).uuid]; if !isempty(ARGS[3]); @assert string(info.tree_hash)==ARGS[3]; end; println("QUALIFIED_CORE_MODE=", ARGS[5], " VERSION=", Base.pkgversion(PerfChecker), " TREE=",info.tree_hash," SOURCE=", pathof(PerfChecker))`, controller,coreCommit,coreTree,expectedCoreVersion,coreMode]);
  await execute(julia, ['--startup-file=no', '-e', 'using Pkg; Pkg.activate(ARGS[1]); Pkg.add(["BenchmarkTools","Chairmarks","TestItems"]); Pkg.activate(ARGS[2]); Pkg.add("TestItems")', target, workspace]);
  await fs.mkdir(path.join(workspace, 'perf'), {recursive: true});
  // Fresh first-use evidence belongs to the starter; the prepared campaign uses its own reports.
  await fs.rm(path.join(workspace,'perf','results'),{recursive:true,force:true});
  await fs.rm(path.join(workspace,'perf','perfchecker-ui.json'),{force:true});
  await fs.writeFile(path.join(workspace, 'perf', 'sum.jl'), 'using PerfCheckerNativeFixture\nperf_setup() = collect(1.0:1000.0)\nperf_workload(xs) = PerfCheckerNativeFixture.sum_squares(xs)\nperf_oracle(xs) = perf_workload(xs) == 333833500.0\n');
  await fs.writeFile(path.join(workspace, 'perf', 'wait.jl'), 'using PerfCheckerNativeFixture\nperf_setup() = 42\nperf_workload(x) = PerfCheckerNativeFixture.wait_task(x)\nperf_oracle(x) = perf_workload(x) == 42\n');
  await fs.writeFile(path.join(workspace, 'perf', 'cases.jl'), 'make_sum_case(p) = (prepare=()->collect(1.0:1000.0), operation=xs->sum(xs.^2), verify=(xs,result)->result==333833500.0)\nmake_wait_case(p) = (prepare=()->42, operation=x->(sleep(0.005);x), verify=(x,result)->result==42)\nmake_cancel_case(p) = (prepare=()->42, operation=x->(write(p["marker"],"running");sleep(30);x), verify=(x,result)->result==42)\n');
  // A distinct bounded workload gives CPU sampling actual operation time;
  // ordinary benchmark and diagnosis examples keep their small input.
  await fs.appendFile(path.join(workspace,'perf','cases.jl'),'Base.@noinline native_profile_sum(xs) = sum(xs.^2)\nmake_profile_case(p) = (prepare=()->collect(1.0:1_000_000.0), operation=native_profile_sum, verify=(xs,result)->isapprox(result,1_000_000.0*1_000_001.0*2_000_001.0/6;rtol=1e-12))\n');
  await fs.appendFile(path.join(workspace,'perf','cases.jl'),'make_owned_cancel_case(p) = (prepare=()->mktempdir(cleanup=false), operation=directory->begin write(joinpath(directory,"owned.tmp"),"owned");write(p["marker"],string(getpid())*"\\n"*directory);sleep(120);42 end, verify=(directory,result)->result==42, cleanup=directory->begin rm(directory;recursive=true,force=true);write(p["cleaned"],"cleaned") end)\n');
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
  options=Dict{Symbol,Any}(:samples=>3,:seconds=>0.03,:evals=>1,:repeat=>false,:targets=>["PerfCheckerNativeFixture"],:profile_seconds=>0.15,:profile_delay=>0.0005,:profile_repetitions=>3,:sample_rate=>1.0)
  push!(features,FeatureSpec(Symbol(workload,"_",backend);workload,backend,entrypoint=joinpath(@__DIR__,file),options,oracle=OracleSpec()))
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
  if(mode==='candidate'&&stage!=='targeted')await execute(julia,['--startup-file=no','-e',`using Pkg; Pkg.activate(ARGS[1]); ${installCore}; Pkg.add([PackageSpec(name="Pluto",version="1.0.4"),PackageSpec(name="PlutoUI"),PackageSpec(name="BenchmarkTools"),PackageSpec(name="Chairmarks")]); Pkg.add(PackageSpec(url="https://github.com/Mirage-Interactive-Fr/PerfChecker.jl",subdir="packages/PerfCheckerPluto",rev="v1.0.0")); using PerfChecker,PerfCheckerPluto,Pluto,PlutoUI; @assert Base.pkgversion(Pluto)==v"1.0.4";@assert Base.pkgversion(PerfChecker)==VersionNumber(ARGS[4]);if !isempty(ARGS[3]);@assert string(Pkg.dependencies()[Base.PkgId(PerfChecker).uuid].tree_hash)==ARGS[3];end;println("PLUTO_CORE_MODE=",ARGS[5]," CORE=",Base.pkgversion(PerfChecker)," PLUTO=",Base.pkgversion(Pluto))`,plutoProject,coreCommit,coreTree,expectedCoreVersion,coreMode]);
  if(stage!=='targeted')await launch('configured');
  // TestItemRunner's default imports use the chosen controller. This explicit fixture
  // preparation is separate from production bootstrap, which never develops a user's package.
  await execute(julia,['--startup-file=no','-e','using Pkg;Pkg.activate(ARGS[1]);Pkg.develop(path=ARGS[2]);println("TESTITEM_TARGET_EXPLICITLY_PREPARED=",ARGS[2])',controller,workspace]);
  for (const extension of stage==='targeted'?[]:mode==='public'?['julialang.language-julia','ms-toolsai.jupyter']:['julialang.language-julia']) {
    await execute(cli, [...cliArgs, ...cliProfile, '--install-extension', extension], {shell: process.platform === 'win32' && cli.endsWith('.cmd')});
  }
  // Adding a second folder to a single-folder window converts its workspace and
  // restarts the extension host. Start the multi-root campaign in a real saved
  // workspace so those buttons are tested once without restarting the driver.
  await fs.writeFile(workspaceFile,JSON.stringify({folders:[{path:workspace}],settings:{}},null,2));
  if(stage==='targeted'){
    if(mode!=='candidate')throw new Error('The targeted lifecycle/protocol campaign requires an explicit exact candidate archive.');
    await launch('reload');
    await launch('narrative');
  }else await launch('prepared');
  if (phaseFailures.length) throw new Error(JSON.stringify(phaseFailures));
  }
} finally {await fs.rm(session, {recursive: true, force: true, maxRetries: 12, retryDelay: 500});}

function assertCI() {
  if (process.env.CI !== 'true') throw new Error('Native VS Code installation is restricted to disposable remote CI.');
  if (process.arch !== 'x64') throw new Error(`The registered core hardware dependency requires the explicitly tested x64 host, got ${process.arch}`);
}
