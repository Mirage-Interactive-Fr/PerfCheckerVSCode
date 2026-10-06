import {runTests} from '@vscode/test-electron';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const client=path.dirname(path.dirname(fileURLToPath(import.meta.url))),execute=promisify(execFile);
if(!process.env.PERFCHECKER_TEST_CONTROLLER||!process.env.PERFCHECKER_TEST_CODEX)throw new Error('Provide an existing PerfChecker 1.0 controller and authenticated Codex CLI.');
const session=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-codex-host-'));
try{
  const root=path.join(session,'workspace');await fs.mkdir(path.join(root,'.vscode'),{recursive:true});await fs.mkdir(path.join(root,'perf'));
  await fs.writeFile(path.join(root,'.perfchecker-test-fixture'),'sacrificial\n');
  await fs.writeFile(path.join(root,'source.cjs'),'exports.sumSquares = values => values.map(value => value * value).reduce((sum, value) => sum + value, 0);\n');
  await fs.writeFile(path.join(root,'perf','advisor.json'),JSON.stringify({protocol:'mcp_http',endpoint:'https://previous.example.invalid/mcp',mcp_tool:'previous_advice'}));
  await fs.writeFile(path.join(root,'.vscode','settings.json'),JSON.stringify({
    'perfchecker.runnerProject':process.env.PERFCHECKER_TEST_CONTROLLER,'perfchecker.scenarioProject':process.env.PERFCHECKER_TEST_CONTROLLER,
    'perfchecker.juliaExecutable':process.env.PERFCHECKER_TEST_JULIA||'julia','perfchecker.codexExecutable':process.env.PERFCHECKER_TEST_CODEX,
    'perfchecker.advisorConfig':'perf/advisor.json','perfchecker.advisorEnabled':false,'perfchecker.advisorImplementationMcpTool':'previous_agent','perfchecker.advisorTimeout':180,
    'telemetry.telemetryLevel':'off','workbench.startupEditor':'none'}));
  const git=(...args)=>execute('git',args,{cwd:root});await git('init');await git('config','user.name','PerfChecker qualification');await git('config','user.email','qualification@example.invalid');await git('add','.');await git('commit','-m','Sacrificial Codex fixture');
  await runTests({extensionDevelopmentPath:client,extensionTestsPath:path.join(client,'test','codex-vscode-host.cjs'),
    ...(process.env.PERFCHECKER_VSCODE_EXECUTABLE?{vscodeExecutablePath:process.env.PERFCHECKER_VSCODE_EXECUTABLE}:{}),
    launchArgs:[root,'--new-window','--disable-extensions','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-gpu',`--user-data-dir=${path.join(session,'profile')}`,`--extensions-dir=${path.join(session,'extensions')}`],
    extensionTestsEnv:{PERFCHECKER_HOST_RESULT:path.join(session,'result.json'),PERFCHECKER_TEST_NODE:process.execPath,
      JULIA_NUM_THREADS:'1',JULIA_NUM_PRECOMPILE_TASKS:'1',JULIA_NUM_GC_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
  const result=JSON.parse(await fs.readFile(path.join(session,'result.json'),'utf8'));if(result.status!=='passed')throw new Error(JSON.stringify(result));console.log(JSON.stringify(result));
}finally{await fs.rm(session,{recursive:true,force:true});}
