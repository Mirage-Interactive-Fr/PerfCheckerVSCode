import {runTests} from '@vscode/test-electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

const client = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const controller = process.env.PERFCHECKER_TEST_CONTROLLER;
if (!controller) throw new Error('PERFCHECKER_TEST_CONTROLLER is required');
const session = await fs.mkdtemp(path.join(os.tmpdir(), 'perfchecker-cancel-host-'));
try {
  const root = path.join(session, 'workspace');
  await fs.mkdir(path.join(root, 'src'), {recursive: true});
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.mkdir(path.join(root, 'worker-environment'));
  await fs.writeFile(path.join(root, 'worker-environment', 'Project.toml'), '[deps]\n');
  await fs.writeFile(path.join(root, 'Project.toml'), 'name = "PerfCheckerCancellationFixture"\nuuid = "ce59c047-c922-4f2c-814b-1a4dc48c4c30"\nversion = "0.1.0"\n');
  await fs.writeFile(path.join(root, 'src', 'PerfCheckerCancellationFixture.jl'), '__precompile__(false)\nmodule PerfCheckerCancellationFixture\ninclude("operation.jl")\nend\n');
  await fs.writeFile(path.join(root, 'src', 'operation.jl'), 'allocate() = copy(fill(1, 4096))\n');
  await fs.writeFile(path.join(root, 'src', 'operation.jl.987654321.mem'), 'foreign trace\r\n');
  await fs.writeFile(path.join(root, 'src', 'notes.mem'), 'user notes\n');
  await fs.writeFile(path.join(root, 'case.jl'), String.raw`
trace = joinpath(@__DIR__, "src", "operation.jl") * "." * string(getpid()) * ".mem"
write(trace, "previous bytes\r\n")
using PerfCheckerCancellationFixture
function perf_workload(_)
    PerfCheckerCancellationFixture.allocate()
    if isfile(joinpath(@__DIR__, "fail-cleanup"))
        rm(trace)
        mkdir(trace)
    end
    write(joinpath(@__DIR__, "measuring"), string(getpid()))
    sleep(120)
end
`);
  await fs.writeFile(path.join(root, 'suite.jl'), `
using PerfChecker
function build_suite()
    feature = FeatureSpec(:allocating; backend=:alloc, entrypoint=joinpath(@__DIR__, "case.jl"),
        options=Dict(:repeat=>false, :targets=>["PerfCheckerCancellationFixture"]))
    package = PackageSuite("PerfCheckerCancellationFixture"; source=@__DIR__,
        worker_environment=joinpath(@__DIR__, "worker-environment"),
        versions=VersionNumber[], features=[feature])
    SoftwareSuite(:cancellation_fixture, [package])
end
`);
  await fs.writeFile(path.join(root, '.vscode', 'settings.json'), JSON.stringify({
    'perfchecker.runnerProject': controller, 'perfchecker.suite': 'suite.jl',
    'perfchecker.profile': 'quick', 'perfchecker.reports': 'reports',
    'perfchecker.juliaExecutable': process.env.PERFCHECKER_TEST_JULIA || 'julia',
    'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
  }));
  await runTests({extensionDevelopmentPath: client,
    extensionTestsPath: path.join(client, 'test', 'cancellation-vscode.cjs'),
    ...(process.env.PERFCHECKER_VSCODE_EXECUTABLE ? {vscodeExecutablePath: process.env.PERFCHECKER_VSCODE_EXECUTABLE} : {}),
    launchArgs: [root, '--new-window', '--disable-extensions', '--disable-workspace-trust',
      '--skip-welcome', '--skip-release-notes', '--disable-gpu',
      `--user-data-dir=${path.join(session, 'profile')}`, `--extensions-dir=${path.join(session, 'extensions')}`],
    extensionTestsEnv: {PERFCHECKER_CANCEL_RESULT: path.join(session, 'result.json'),
      PERFCHECKER_CANCEL_CASE: process.env.PERFCHECKER_CANCEL_CASE || '',
      JULIA_NUM_THREADS: '1', JULIA_NUM_PRECOMPILE_TASKS: '1', JULIA_NUM_GC_THREADS: '1',
      OPENBLAS_NUM_THREADS: '1', UV_THREADPOOL_SIZE: '4'},
  });
  const result = JSON.parse(await fs.readFile(path.join(session, 'result.json'), 'utf8'));
  if (result.status !== 'passed') throw new Error(JSON.stringify(result));
  console.log(JSON.stringify(result));
} finally {await fs.rm(session, {recursive: true, force: true});}
