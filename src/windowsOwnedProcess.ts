import {spawn, ChildProcess} from 'node:child_process';
import {createServer, Socket} from 'node:net';
import {PassThrough} from 'node:stream';
import {randomBytes} from 'node:crypto';
import * as path from 'node:path';

export type WindowsOwnedChild = ChildProcess & {protocolOutput?: PassThrough};

/** Own the CLI and its descendants before it starts, including after its leader exits.
 * The packaged Windows launcher keeps the only private Job handle. Normal exit
 * waits for an empty Job; forcibly killing this owner invokes KILL_ON_JOB_CLOSE.
 */
export function spawnWindowsOwnedProcess(cli: string, args: string[],
    options: {cwd: string; env: NodeJS.ProcessEnv; privateStdout?: boolean}): WindowsOwnedChild {
  if (process.platform !== 'win32') throw new Error('The Windows process owner requires Windows.');
  if (/\.(cmd|bat)$/i.test(cli)) throw new Error('Select a native executable; Windows shell launchers are not supported.');
  if ([cli, options.cwd, ...args].some(value => value.includes('\0'))) throw new Error('Process arguments cannot contain NUL.');
  // __dirname is dist/ in both compiled tests and the packaged extension.
  const launcher = path.join(__dirname, '..', 'resources', 'windows-owned-process.ps1');
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const pipe = options.privateStdout ? `\\\\.\\pipe\\perfchecker-${randomBytes(24).toString('hex')}` : undefined;
  const nonce = pipe ? randomBytes(32).toString('hex') : undefined;
  const output = pipe ? new PassThrough({destroy(error, callback) {
    clearTimeout(timer); closeListener(); socket?.destroy(); callback(error);
  }}) : undefined;
  let child: WindowsOwnedChild | undefined, socket: Socket | undefined, authenticated = false, finished = false;
  let bound = false, listenerRetired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener = pipe ? createServer(connection => {
    if (socket || finished) {connection.destroy(); return;}
    socket = connection;
    let header = Buffer.alloc(0);
    const handshake = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const newline = header.indexOf(10);
      if (newline < 0) {if (header.length > 128) abort(new Error('Invalid private MCP output handshake.')); return;}
      if (newline > 128 || header.subarray(0, newline).toString('ascii') !== `${nonce} ${child?.pid}`) {
        abort(new Error('The private MCP output owner could not be verified.')); return;
      }
      authenticated = true; clearTimeout(timer); connection.removeListener('data', handshake);
      closeListener(); connection.write(`READY ${nonce}\n`);
      if (header.length > newline + 1) output!.write(header.subarray(newline + 1));
      connection.pipe(output!);
    };
    connection.on('data', handshake);
    connection.once('error', abort);
    connection.once('end', () => {if (!authenticated) abort(new Error('The private MCP output handshake ended early.'));});
  }) : undefined;
  const closeListener = () => {
    if (!listener || listenerRetired) return;
    listenerRetired = true;
    if (bound) listener.close();
  };
  const abort = (error: Error) => {
    if (finished) return;
    finished = true; clearTimeout(timer); closeListener(); socket?.destroy(); output?.destroy(error);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  if (listener) {
    listener.once('error', abort);
    listener.once('listening', () => {bound = true; if (listenerRetired) listener.close();});
    // A synchronous spawn failure may leave no caller to observe this stream.
    // Consumer listeners still receive errors from asynchronous launch failure.
    output!.on('error', () => {});
    listener.listen(pipe!);
    timer = setTimeout(() => abort(new Error('The private MCP output handshake timed out.')), 10000);
  }
  try {child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher,
    '-Executable', cli, '-WorkingDirectory', options.cwd,
    '-ArgumentsBase64', Buffer.from(JSON.stringify(args), 'utf8').toString('base64'), '-ParentPid', String(process.pid),
    ...(pipe ? ['-OutputPipe', pipe, '-OutputNonce', nonce!] : [])],
  {cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', pipe ? 'ignore' : 'pipe', 'pipe']});}
  catch (error) {abort(error as Error); throw error;}
  if (output) {
    child.protocolOutput = output;
    child.once('error', abort);
    child.once('close', () => {
      clearTimeout(timer); closeListener();
      if (!authenticated) abort(new Error('The Windows owner stopped before its private output handshake.'));
      else if (!output.readableEnded && !output.destroyed) {
        // Drain data already written before normal process exit; a broken
        // channel still releases its socket within a bounded interval.
        timer = setTimeout(() => {socket?.destroy(); output.destroy();}, 2000);
        output.once('end', () => clearTimeout(timer));
      }
    });
  }
  return child;
}
