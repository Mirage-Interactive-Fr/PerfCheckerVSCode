import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile, realpath, stat} from 'node:fs/promises';
import * as path from 'node:path';
import {cancellableJulia,controllerCancellation} from './controllerCancellation';

const qualityName = /^[a-z][a-z0-9-]*$/;
const bundleLine = /^PERFCHECKER_LIVE_BUNDLE (.+)$/m;

export interface LiveProviderInput {
  root: string;
  provider: string;
  quality: string;
  qualityDigest: string;
  controller: string;
  julia: string;
  reports: string;
}

async function ownedFile(root: string, relative: string): Promise<string> {
  const file = await realpath(path.join(root, relative));
  const inside = path.relative(root, file);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
    throw new Error(`Live measurement file escapes its workspace: ${relative}`);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`Live measurement requires a file: ${relative}`);
  return file;
}

function topLevel(text: string, key: string): string | undefined {
  const header = text.split(/^\s*\[/m, 1)[0];
  const values = [...header.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\n]+)"\\s*(?:#.*)?$`, 'gm'))];
  return values.length === 1 ? values[0][1] : undefined;
}

export async function prepareLiveProvider(rootPath: string, quality: string): Promise<
    Pick<LiveProviderInput, 'root' | 'provider' | 'quality' | 'qualityDigest'>> {
  if (typeof quality !== 'string' || !qualityName.test(quality))
    throw new Error('Select a valid render quality slug.');
  const root = await realpath(rootPath);
  const manifest = await readFile(await ownedFile(root, 'EtenduGame.toml'), 'utf8');
  if (topLevel(manifest, 'id') !== 'etendu.beautifullandscape' ||
      topLevel(manifest, 'entrypoint') !== 'scripts/play.jl')
    throw new Error('This workspace does not declare the Beautiful Landscape live measurement contract.');
  const qualityText = await readFile(await ownedFile(root, 'config/quality.toml'), 'utf8');
  if (topLevel(qualityText, 'schema') !== 'beautiful-landscape-quality/1')
    throw new Error('Unsupported Beautiful Landscape quality contract.');
  const names = [...qualityText.matchAll(/^\s*\[profiles\.([a-z][a-z0-9-]*)\]\s*$/gm)]
    .map(match => match[1]);
  if (names.filter(name => name === quality).length !== 1)
    throw new Error(`Render quality ${quality} is missing or duplicated; select it again.`);
  const provider = await ownedFile(root, 'perf/live_provider.jl');
  return {root, provider, quality,
    qualityDigest: createHash('sha256').update(qualityText).digest('hex')};
}

/** The provider writes perfchecker-provider-result/1 to PERFCHECKER_OUTPUT. */
export const LIVE_JULIA = `
using PerfChecker, SHA
root, provider, quality, reports, digest, julia = ARGS
bytes2hex(sha256(read(joinpath(root, "config", "quality.toml")))) == digest ||
    error("render quality changed before measurement")
spec = ExternalCommandSpec(:landscape_live, "julia",
    [julia, "--startup-file=no", "--project=" * root, provider, "--quality=" * quality];
    directory=root, timeout_seconds=900)
bundle = run_external_command(spec)
bundle_passed(bundle) || error("live provider failed: " *
    join([string(get(item, "message", "provider failed")) for item in bundle.diagnostics], "; "))
manifest = bundle.manifest
environment = manifest["environment"]
get(manifest, "suite", nothing) == "etendu-beautiful-landscape-live" ||
    error("unexpected live provider suite")
get(environment, "quality_profile", nothing) == quality || error("quality mismatch")
all(key -> get(environment, key, 0) isa Integer && environment[key] > 0,
    ("width", "height")) || error("effective resolution is missing")
get(environment, "resolution_source", nothing) in ("display", "fallback", "fixed", "override") ||
    error("resolution source is missing")
hardware = get(environment, "hardware", nothing)
hardware isa AbstractDict && all(key -> get(hardware, key, nothing) isa AbstractString &&
    !isempty(hardware[key]), ("cpu_name", "gpu_name")) || error("hardware identity is missing")
runtime = get(manifest, "runtime", nothing)
runtime isa AbstractDict && get(runtime, "language", nothing) == "julia" &&
    get(runtime, "version", nothing) isa AbstractString || error("Julia runtime is missing")
occursin(r"^[0-9a-f]{64}$", string(get(environment, "scene_sha256", ""))) ||
    error("scene source digest is missing")
get(environment, "gpu_timing", nothing) == "unavailable" &&
get(environment, "physical_presentation", nothing) == "unavailable" ||
    error("GPU and presentation availability must be explicit")
occursin("SDL_SubmitGPUCommandBuffer", string(get(environment, "timing_boundary", ""))) ||
    error("submission timing boundary is missing")
all(key -> occursin(r"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
    string(get(manifest, key, ""))), ("started_at", "finished_at")) ||
    error("UTC timestamps are missing")
get(environment, "scene_file_changed_during_run", true) === false ||
    error("scene changed during measurement")
metrics = [string(item["metric"]) for item in bundle.observations]
all(metric -> !occursin(r"(?i)(gpu|fps|physical.presentation)", metric), metrics) ||
    error("unsupported GPU or physical FPS metric")
for prefix in ("landscape.cpu.", "landscape.submit_interval.")
    any(item -> startswith(string(item["metric"]), prefix) && item["unit"] == "ms",
        bundle.observations) || error("missing millisecond observation: " * prefix)
end
bytes2hex(sha256(read(joinpath(root, "config", "quality.toml")))) == digest ||
    error("render quality changed during measurement")
destination = joinpath(reports, "run-" * string(manifest["run_id"]))
write_run_bundle(bundle, destination)
verify_run_bundle(destination; require_integrity=true)["verified"] === true ||
    error("bundle integrity verification failed")
println("PERFCHECKER_LIVE_BUNDLE " * destination)
`;

export function liveJuliaArguments(input: LiveProviderInput): string[] {
  return ['--startup-file=no', `--project=${input.controller}`, '-e', cancellableJulia(LIVE_JULIA),
    '--', input.root, input.provider, input.quality, input.reports, input.qualityDigest, input.julia];
}

export interface Cancellation {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): {dispose(): void};
}

/** A failed or cancelled provider never returns a path that callers may show as qualified evidence. */
export async function executeLiveProvider(input: LiveProviderInput, token: Cancellation,
    output: (line: string) => void): Promise<string> {
  if (token.isCancellationRequested) throw new Error('Live measurement cancelled.');
  return new Promise<string>((resolve, reject) => {
    const child = spawn(input.julia, liveJuliaArguments(input), {
      cwd: input.root, windowsHide: true, detached: process.platform !== 'win32',
      env: {...process.env, JULIA_LOAD_PATH: ['@', '@stdlib'].join(path.delimiter)},
    });
    let stdout = '', stderr = '', cancelled = false;
    const controller=controllerCancellation(child,message=>output(`${message}\n`));
    const stop = () => {
      cancelled = true;
      controller.request();
    };
    const subscription = token.onCancellationRequested(stop);
    child.stdout.on('data', data => {
      stdout += String(data);
      if (stdout.length > 131072) stdout = stdout.slice(-131072);
      output(String(data));
    });
    child.stderr.on('data', data => {
      stderr += String(data);
      if (stderr.length > 131072) stderr = stderr.slice(-131072);
      output(String(data));
    });
    child.on('error', error => {subscription.dispose();controller.dispose();reject(error);});
    child.on('close', async code => {
      subscription.dispose();
      controller.dispose();
      if (cancelled || token.isCancellationRequested) { reject(new Error('Live measurement cancelled.')); return; }
      if (code !== 0) { reject(new Error(`Live measurement failed (exit ${code}): ${stderr.slice(-2048)}`)); return; }
      const match = stdout.match(bundleLine);
      if (!match) { reject(new Error('PerfChecker did not return a live bundle.')); return; }
      try {
        const reports = await realpath(input.reports);
        const directory = await realpath(match[1].trim());
        if (path.dirname(directory) !== reports ||
            !/^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(path.basename(directory)))
          throw new Error('PerfChecker returned a bundle outside the live reports directory.');
        if (token.isCancellationRequested) throw new Error('Live measurement cancelled.');
        resolve(directory);
      } catch (error) { reject(error); }
    });
  });
}
