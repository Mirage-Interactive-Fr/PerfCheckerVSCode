import {spawn, ChildProcess} from 'node:child_process';
import * as path from 'node:path';

/** Own the CLI and its descendants before it starts, including after its leader exits.
 * The packaged Windows launcher keeps the only private Job handle. Normal exit
 * waits for an empty Job; forcibly killing this owner invokes KILL_ON_JOB_CLOSE.
 */
export function spawnWindowsOwnedProcess(cli: string, args: string[],
    options: {cwd: string; env: NodeJS.ProcessEnv}): ChildProcess {
  if (process.platform !== 'win32') throw new Error('The Windows process owner requires Windows.');
  if (/\.(cmd|bat)$/i.test(cli)) throw new Error('Select a native executable; Windows shell launchers are not supported.');
  if ([cli, options.cwd, ...args].some(value => value.includes('\0'))) throw new Error('Process arguments cannot contain NUL.');
  // __dirname is dist/ in both compiled tests and the packaged extension.
  const launcher = path.join(__dirname, '..', 'resources', 'windows-owned-process.ps1');
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher,
    '-Executable', cli, '-WorkingDirectory', options.cwd,
    '-ArgumentsBase64', Buffer.from(JSON.stringify(args), 'utf8').toString('base64'), '-ParentPid', String(process.pid)],
  {cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
}
