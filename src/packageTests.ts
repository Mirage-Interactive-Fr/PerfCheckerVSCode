import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {cancellableJulia, controllerCancellation} from './controllerCancellation';

export interface PackageTestResult {
  status: 'passed' | 'failed' | 'cancelled' | 'error';
  exitCode: number | null;
  durationSeconds: number;
  output: string;
  outputTruncated: boolean;
}

/** Verification runs the package's tests, never commands suggested by a model. */
export async function runPackageTests(root: string, julia: string, signal: AbortSignal,
    progress: (text: string) => void = () => {}, timeoutSeconds = 900): Promise<PackageTestResult> {
  if (!(await fs.stat(path.join(root, 'Project.toml')).catch(() => undefined))?.isFile())
    throw new Error('Open the Julia package folder before running its package tests.');
  if (signal.aborted) throw new Error('Verification cancelled.');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(julia, ['--startup-file=no', `--project=${root}`, '-e',
      cancellableJulia('using Pkg; Pkg.test(; julia_args=["--threads=1"])')], {
      cwd: root, detached: process.platform !== 'win32', windowsHide: true,
      env: {...process.env, JULIA_NUM_THREADS: '1', JULIA_NUM_PRECOMPILE_TASKS: '1'},
    });
    let output = '', characters = 0, timedOut = false;
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    const owner = controllerCancellation(child, progress);
    const abort = () => owner.request();
    signal.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => {timedOut = true; owner.request();}, Math.max(1, timeoutSeconds) * 1000);
    const append = (text: string) => {
      characters += text.length;
      output = (output + text).slice(-16000);
      progress(text);
    };
    child.stdout.on('data', bytes => append(stdout.write(bytes)));
    child.stderr.on('data', bytes => append(stderr.write(bytes)));
    const release = () => {clearTimeout(timer); signal.removeEventListener('abort', abort); owner.dispose();};
    child.once('error', error => {release(); reject(error);});
    child.once('close', exitCode => {
      release(); output = (output + stdout.end() + stderr.end()).slice(-16000);
      if (owner.forced) output += '\nPackage-test cleanup required a forced stop.';
      if (timedOut) output += '\nPackage tests exceeded the verification time limit.';
      resolve({status: owner.forced || timedOut ? 'error' : signal.aborted ? 'cancelled' : exitCode === 0 ? 'passed' : 'failed',
        exitCode, durationSeconds: (Date.now() - started) / 1000, output, outputTruncated: characters > 16000});
    });
    if (signal.aborted) owner.request();
  });
}
