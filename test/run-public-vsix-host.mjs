import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests} from '@vscode/test-electron';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(repository, 'native-qualification-results');
const session = await fs.mkdtemp(path.join(os.tmpdir(), 'perfchecker-public-vsix-'));
let julia = process.env.PERFCHECKER_TEST_JULIA || 'julia';
const mode = process.env.PERFCHECKER_VSIX_MODE || 'public';
const version = process.env.PERFCHECKER_VSCODE_VERSION || 'stable';
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
    child.once('close', code => code === 0 ? resolve(text) : reject(new Error(`${path.basename(executable)} exited ${code}\n${text.slice(-5000)}`)));
  });
}

try {
  await fs.mkdir(output, {recursive: true});
  assertCI();
  const runtime = JSON.parse((await execute(julia, ['--startup-file=no', '-e',
    'print("{\\\"executable\\\":", repr(joinpath(Sys.BINDIR, Base.julia_exename())), ",\\\"version\\\":", repr(string(VERSION)), "}")'])).trim());
  julia = runtime.executable;
  const expectedVersion = mode === 'public' ? '1.0.0' : JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')).version;
  const vscode = await downloadAndUnzipVSCode({version, cachePath: path.join(session, 'vscode')});
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscode, {reuseMachineInstall: true});
  const extensions = path.join(session, 'extensions');
  const profile = path.join(session, 'profile');
  const workspace = path.join(session, 'workspace');
  const controller = path.join(session, 'controller');
  const target = path.join(workspace, 'worker-environment');
  await fs.mkdir(path.join(workspace, 'src'), {recursive: true});
  await fs.mkdir(path.join(workspace, 'test'));
  await fs.writeFile(path.join(workspace, 'Project.toml'), 'name = "PerfCheckerNativeFixture"\nuuid = "6af56806-e0b1-4f34-88bf-fde69d8a8679"\nversion = "0.1.0"\n');
  await fs.writeFile(path.join(workspace, 'src', 'PerfCheckerNativeFixture.jl'), 'module PerfCheckerNativeFixture\nsum_squares(xs) = sum(xs .^ 2)\nend\n');
  await fs.writeFile(path.join(workspace, 'test', 'performance.jl'), 'using TestItems\n@testitem "Vector reduction" tags=[:performance] begin\n data=collect(1:10_000)\n @test sum(data)==50_005_000\nend\n');
  const vsix = path.join(session, 'perfchecker.vsix');
  if (mode === 'public') {
    const response = await fetch('https://github.com/Mirage-Interactive-Fr/PerfCheckerVSCode/releases/download/v1.0.0/perfchecker-vscode-1.0.0.vsix');
    if (!response.ok) throw new Error(`Public VSIX download failed: ${response.status}`);
    await fs.writeFile(vsix, Buffer.from(await response.arrayBuffer()));
  } else await fs.copyFile(path.join(repository, 'candidate.vsix'), vsix);
  const sha = createHash('sha256').update(await fs.readFile(vsix)).digest('hex');
  if (mode === 'public' && sha !== publicSha) throw new Error('Public VSIX SHA256 differs from the published qualification.');
  const cliProfile = [`--user-data-dir=${profile}`, `--extensions-dir=${extensions}`];
  await execute(cli, [...cliArgs, ...cliProfile, '--install-extension', vsix, '--force'], {shell: process.platform === 'win32' && cli.endsWith('.cmd')});
  await fs.writeFile(path.join(output, 'artifact.json'), JSON.stringify({mode, sha256: sha, vscodeRequested: version}, null, 2));

  const launch = async phase => {
    try {await runTests({vscodeExecutablePath: vscode,
      extensionDevelopmentPath: path.join(repository, 'test', 'qualification-host'),
      extensionTestsPath: path.join(repository, 'test', 'public-vsix-host.cjs'),
      launchArgs: [workspace, ...cliProfile, '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu', '--remote-debugging-port=9222'],
      extensionTestsEnv: {PERFCHECKER_NATIVE_PHASE: phase, PERFCHECKER_NATIVE_OUTPUT: output,
        PERFCHECKER_NATIVE_WORKSPACE: workspace, PERFCHECKER_NATIVE_CONTROLLER: controller,
        PERFCHECKER_NATIVE_TARGET: target, PERFCHECKER_NATIVE_JULIA: julia,
        PERFCHECKER_NATIVE_MODE: mode, PERFCHECKER_NATIVE_SHA: sha,
        PERFCHECKER_NATIVE_STAGE: process.env.PERFCHECKER_NATIVE_STAGE || 'smoke',
        PERFCHECKER_NATIVE_EXPECTED_VERSION: expectedVersion, PERFCHECKER_NATIVE_JULIA_VERSION: runtime.version,
        UV_THREADPOOL_SIZE: '1'},
    });} catch (error) {phaseFailures.push({phase, error: String(error)});}
  };
  // The first real launch has no PerfChecker settings, Julia or Jupyter extension.
  await launch('fresh');
  await execute(julia, ['--startup-file=no', '-e', 'using Pkg; Pkg.activate(ARGS[1]); Pkg.add(Pkg.PackageSpec(name="PerfChecker",version="1.0.0")); Pkg.add(["TestItemRunner","HTTP","BenchmarkTools","Chairmarks","JET","AllocCheck"]); using PerfChecker; @assert Base.pkgversion(PerfChecker)==v"1.0.0"; println("REGISTERED_CORE=", Base.pkgversion(PerfChecker), " SOURCE=", pathof(PerfChecker))', controller]);
  await execute(julia, ['--startup-file=no', '-e', 'using Pkg; Pkg.activate(ARGS[1]); Pkg.add(["BenchmarkTools","Chairmarks","TestItems"]); Pkg.activate(ARGS[2]); Pkg.add("TestItems")', target, workspace]);
  await fs.mkdir(path.join(workspace, 'perf'), {recursive: true});
  await fs.writeFile(path.join(workspace, 'perf', 'sum.jl'), 'using PerfCheckerNativeFixture\nperf_setup() = collect(1.0:1000.0)\nperf_workload(xs) = PerfCheckerNativeFixture.sum_squares(xs)\nperf_oracle(xs) = perf_workload(xs) == 333833500.0\n');
  await fs.writeFile(path.join(workspace, 'perf', 'wait.jl'), 'perf_setup() = 42\nperf_workload(x) = (sleep(0.001); x)\nperf_oracle(x) = perf_workload(x) == 42\n');
  await fs.writeFile(path.join(workspace, 'perf', 'cases.jl'), 'make_sum_case(p) = (prepare=()->collect(1.0:1000.0), operation=xs->sum(xs.^2), verify=(xs,result)->result==333833500.0)\nmake_wait_case(p) = (prepare=()->42, operation=x->(sleep(0.005);x), verify=(x,result)->result==42)\nmake_cancel_case(p) = (prepare=()->42, operation=x->(write(p["marker"],"running");sleep(30);x), verify=(x,result)->result==42)\n');
  await fs.writeFile(path.join(workspace, 'perf', 'scenarios.toml'), 'schema_version = "perfchecker-scenario-catalog/1"\nroot = "."\n[[scenarios]]\nid = "sum_squares"\nimplementation = "allocating"\nsource = "cases.jl"\nfactory = "make_sum_case"\ncollectors = ["benchmark", "chairmark", "profile", "profile_alloc"]\n[[scenarios]]\nid = "wait_task"\nimplementation = "waiting"\nsource = "cases.jl"\nfactory = "make_wait_case"\ncollectors = ["benchmark"]\n');
  await fs.writeFile(path.join(workspace, 'perf', 'example.jl'), 'using Example\nperf_setup() = "PerfChecker"\nperf_workload(name) = Example.hello(name)\nperf_oracle(name,result) = occursin(name,result)\n');
  await execute('git', ['init'], {cwd: workspace});
  await execute('git', ['config', 'user.name', 'PerfChecker native fixture'], {cwd: workspace});
  await execute('git', ['config', 'user.email', 'fixture@example.invalid'], {cwd: workspace});
  await execute('git', ['config', 'commit.gpgsign', 'false'], {cwd: workspace});
  await execute('git', ['add', '.'], {cwd: workspace});
  await execute('git', ['commit', '-m', 'Baseline fixture'], {cwd: workspace});
  await execute('git', ['tag', 'v0.1.0'], {cwd: workspace});
  await execute('git', ['branch', 'native-baseline'], {cwd: workspace});
  const baseline = (await execute('git', ['rev-parse', 'HEAD'], {cwd: workspace})).trim();
  await fs.writeFile(path.join(workspace, 'perf', 'suite.jl'), `using PerfChecker\nfunction build_suite()\n features=FeatureSpec[]\n for (workload,file) in [(:sum_squares,"sum.jl"),(:wait_task,"wait.jl")], backend in [:benchmark,:chairmark,:profile,:wall_profile,:profile_alloc,:alloc,:network,:network_interface,:network_isolated]\n  supported = backend in [:benchmark,:chairmark,:profile,:wall_profile,:profile_alloc,:alloc]\n  options=Dict{Symbol,Any}(:samples=>3,:seconds=>0.03,:evals=>1,:repeat=>false,:targets=>["PerfCheckerNativeFixture"])\n  push!(features,FeatureSpec(Symbol(workload,"_",backend);workload,backend,entrypoint=joinpath(@__DIR__,file),until=supported ? nothing : v"0.0.0",options,oracle=OracleSpec()))\n end\n package=PackageSuite("PerfCheckerNativeFixture";source=dirname(@__DIR__),worker_environment=joinpath(dirname(@__DIR__),"worker-environment"),versions=VersionNumber[],features,candidates=[SuiteCandidate("baseline",${JSON.stringify(baseline)};source=dirname(@__DIR__),compatibility_version=v"0.1.0")])\n SoftwareSuite(:native_fixture,[package])\nend\n`);
  await fs.writeFile(path.join(workspace, 'perf', 'large-suite.jl'), 'using PerfChecker\nfunction build_suite()\n features=[FeatureSpec(Symbol("workload_",i);workload=Symbol("workload_",i),backend=:benchmark,entrypoint=joinpath(@__DIR__,"sum.jl")) for i in 1:125]\n SoftwareSuite(:large_native_fixture,[PackageSuite("PerfCheckerNativeFixture";source=dirname(@__DIR__),worker_environment=joinpath(dirname(@__DIR__),"worker-environment"),versions=VersionNumber[],features)])\nend\n');
  await fs.mkdir(path.join(workspace, '.vscode'));
  await fs.writeFile(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({'julia.executablePath': julia, 'julia.enableTelemetry': false, 'julia.symbolCacheDownload': false, 'git.enabled': false, 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none'}));
  await launch('configured');
  for (const extension of ['julialang.language-julia', 'ms-toolsai.jupyter']) {
    await execute(cli, [...cliArgs, ...cliProfile, '--install-extension', extension], {shell: process.platform === 'win32' && cli.endsWith('.cmd')});
  }
  await launch('prepared');
  if (phaseFailures.length) throw new Error(JSON.stringify(phaseFailures));
} finally {await fs.rm(session, {recursive: true, force: true, maxRetries: 12, retryDelay: 500});}

function assertCI() {
  if (process.env.CI !== 'true') throw new Error('Native VS Code installation is restricted to disposable remote CI.');
  if (process.arch !== 'x64') throw new Error(`The registered core hardware dependency requires the explicitly tested x64 host, got ${process.arch}`);
}
