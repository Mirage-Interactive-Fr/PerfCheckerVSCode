import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {workspacePath} from './investigationModel';
import type {AnalysisContext, AnalysisResult} from './guidedAnalysis';

export interface SuiteChatSource {
  kind: 'suite-bundle'; workspace: string; root: string; reports: string; directory: string;
  runId: string; fingerprint: string;
  /** Captured reports belong to this execution even when the latest report changes. */
  snapshot?: {suite: string; series: string};
}
const documents = ['manifest.json', 'measurement-definitions.json', 'observations.jsonl',
  'diagnostics.jsonl', 'artifacts.json', 'integrity.json'];
const bounded = async (file: string, limit = 32_000_000) => {
  if ((await fs.stat(file)).size > limit) throw new Error('Saved suite evidence exceeds the attachment size limit.');
  const bytes = await fs.readFile(file);
  if (bytes.length > limit) throw new Error('Saved suite evidence exceeds the attachment size limit.');
  return bytes.toString('utf8');
};

/** Revalidate the explicit saved run; never infer a bundle from modification time. */
export async function validateSuiteChatSource(source: SuiteChatSource, verifyDocuments = false): Promise<void> {
  const root = await fs.realpath(source.root), directory = await fs.realpath(source.directory);
  if (root !== source.root || directory !== source.directory) throw new Error('Saved suite evidence location changed. Reopen Chat.');
  workspacePath(root, directory);
  workspacePath(root, source.reports);
  const reportBytes: string[] = [];
  if (source.snapshot) {
    if ([source.snapshot.suite, source.snapshot.series].some(value => typeof value !== 'string' || Buffer.byteLength(value) > 32_000_000))
      throw new Error('Saved result snapshot exceeds the attachment size limit.');
    reportBytes.push(source.snapshot.suite, source.snapshot.series);
  } else for (const name of ['suite-result.json', 'version-series.json']) {
      const file = path.join(source.reports, name);
      workspacePath(source.reports, await fs.realpath(file));
      reportBytes.push(await bounded(file));
    }
  let total = 0;
  for (const name of documents) {
    const file = path.join(directory, name);
    workspacePath(directory, await fs.realpath(file));
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 32_000_000 || (total += stat.size) > 64_000_000)
      throw new Error('Saved suite evidence exceeds the attachment size limit.');
  }
  const manifestBytes = await bounded(path.join(directory, 'manifest.json'), 1_000_000);
  const integrityBytes = await bounded(path.join(directory, 'integrity.json'), 1_000_000);
  const manifest = JSON.parse(manifestBytes), integrity = JSON.parse(integrityBytes);
  const suite = JSON.parse(reportBytes[0]), series = JSON.parse(reportBytes[1]);
  if (manifest.schema_version !== 'perfchecker-run-bundle/1' || manifest.run_id !== source.runId ||
      integrity.schema_version !== 'perfchecker-bundle-integrity/1' || suite.schema_version !== 'perfchecker-suite-result/1' ||
      series.schema_version !== 'perfchecker-version-series/1' || series.run_id !== source.runId ||
      ['suite', 'profile', 'started_at', 'finished_at'].some(key => typeof suite[key] !== 'string' || !suite[key] || suite[key] !== manifest[key]))
    throw new Error('Saved suite report, bundle identity or integrity document is invalid.');
  if (integrity.algorithm !== 'sha256' || !Array.isArray(integrity.files) || integrity.files.length !== documents.length - 1 ||
      new Set(integrity.files.map((record: any) => record?.path)).size !== documents.length - 1 ||
      integrity.files.some((record: any) => !record || !documents.slice(0, -1).includes(record.path) ||
        !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)))
    throw new Error('Saved suite bundle integrity records are invalid.');
  if (verifyDocuments) for (const record of integrity.files) {
    const bytes = await fs.readFile(path.join(directory, record.path));
    if (bytes.length > 32_000_000 || bytes.length !== record.bytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256)
      throw new Error('Saved suite bundle failed its byte integrity check. No measurements were sent.');
  }
  const fingerprint = createHash('sha256').update(manifestBytes).update('\0').update(integrityBytes)
    .update('\0').update(reportBytes[0]).update('\0').update(reportBytes[1]).digest('hex');
  if (fingerprint !== source.fingerprint) throw new Error('Saved suite evidence changed. Reopen Chat.');
}

/** Capture only a validated, explicitly selected run; never adopt the newest directory. */
export async function captureSuiteChatSource(source: SuiteChatSource): Promise<SuiteChatSource> {
  await validateSuiteChatSource(source, true);
  const snapshot = source.snapshot ?? {
    suite: await bounded(path.join(source.reports, 'suite-result.json')),
    series: await bounded(path.join(source.reports, 'version-series.json')),
  };
  const captured = {...source, snapshot: {...snapshot}};
  // Detect a report replacement between the initial validation and the copy.
  await validateSuiteChatSource(captured, true);
  return captured;
}

export async function suiteAnalysisContext(source: SuiteChatSource, evidenceId: string): Promise<AnalysisContext> {
  if (!source.snapshot) throw new Error('Select and capture an execution before analyzing it.');
  await validateSuiteChatSource(source, true);
  const suite = JSON.parse(source.snapshot.suite);
  const manifest = JSON.parse(await bounded(path.join(source.directory, 'manifest.json'), 1_000_000));
  if (!Array.isArray(suite.runs) || suite.runs.length > 10_000) throw new Error('Invalid saved check results.');
  const seen = new Set<string>();
  const results: AnalysisResult[] = suite.runs.map((run: any) => {
    if (!run || ['package', 'feature', 'version', 'status', 'target_kind', 'comparison_key'].some(key => typeof run[key] !== 'string' || !run[key]))
      throw new Error('A saved check result has an invalid identity.');
    const matching = (manifest.plan?.runs ?? []).filter((planned: any) => planned.package === run.package &&
      planned.feature === run.feature && planned.version === run.version && planned.target_kind === run.target_kind &&
      planned.comparison_key === run.comparison_key);
    if (matching.length > 1) throw new Error('A saved check result has ambiguous plan metadata.');
    const planned = matching[0];
    const provenance = (manifest.source_provenance ?? []).filter((item: any) => item.target_label === run.version);
    const sourceState = provenance.length === 1 ? provenance[0] : undefined;
    const id = JSON.stringify([source.runId, run.package, run.feature, run.version, run.target_kind, run.comparison_key]);
    if (seen.has(id)) throw new Error('A saved execution contains duplicate check results.');
    seen.add(id);
    const summary = run.summary && typeof run.summary === 'object' && !Array.isArray(run.summary) ? run.summary : {};
    return {id, package: run.package, feature: run.feature, workload: run.workload,
      check: planned?.backend, target: run.version, targetKind: run.target_kind, revision: planned?.target_revision ?? sourceState?.revision ?? undefined,
      source: sourceState ? {captureScope: sourceState.capture_scope, dirty: sourceState.dirty, fingerprint: sourceState.dirty_state_sha256} : undefined,
      status: run.status, summary,
      qualification: Object.fromEntries(['verdict', 'correctness', 'performance', 'allocation_profile']
        .filter(key => run.qualification?.[key] !== undefined).map(key => [key, run.qualification[key]])),
      message: typeof run.message === 'string' ? run.message.split('\n').slice(0, 8).join('\n').slice(0, 1200) : undefined};
  });
  return {evidenceId, runId: source.runId, fingerprint: source.fingerprint,
    label: `${suite.suite} · ${suite.finished_at}`, results, environment: manifest.environment};
}

/** Inventory contains only the run explicitly referenced by the saved suite's series report. */
export class SuiteChatEvidence {
  private inventories = new Map<string, {options: {id: string; label: string; unavailable?: boolean}[]; source?: SuiteChatSource}>();
  options(workspace: string) {return this.inventories.get(workspace)?.options ?? [];}
  async refresh(workspace: string, folder: string, reports: string): Promise<void> {
    let suite: any;
    try {
      const root = await fs.realpath(folder), reportRoot = await fs.realpath(workspacePath(root, path.resolve(root, reports)));
      workspacePath(root, reportRoot);
      const suiteFile = path.join(reportRoot, 'suite-result.json');
      workspacePath(reportRoot, await fs.realpath(suiteFile));
      const suiteBytes = await bounded(suiteFile);suite = JSON.parse(suiteBytes);
      if (suite.schema_version !== 'perfchecker-suite-result/1' || typeof suite.suite !== 'string' || !Array.isArray(suite.runs))
        throw new Error('Invalid saved suite report.');
      const seriesFile = path.join(reportRoot, 'version-series.json');
      workspacePath(reportRoot, await fs.realpath(seriesFile));
      const seriesBytes = await bounded(seriesFile), series = JSON.parse(seriesBytes);
      if (series.schema_version !== 'perfchecker-version-series/1' || typeof series.run_id !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(series.run_id))
        throw new Error('The suite report has no explicit saved bundle reference.');
      const directory = await fs.realpath(path.join(reportRoot, 'bundles', `run-${series.run_id}`));
      workspacePath(reportRoot, directory);
      for (const name of ['manifest.json', 'integrity.json']) workspacePath(directory, await fs.realpath(path.join(directory, name)));
      const manifestBytes = await bounded(path.join(directory, 'manifest.json'), 1_000_000);
      const integrityBytes = await bounded(path.join(directory, 'integrity.json'), 1_000_000);
      if (JSON.parse(manifestBytes).suite !== suite.suite) throw new Error('The saved bundle belongs to another suite.');
      const source: SuiteChatSource = {kind: 'suite-bundle', workspace, root, reports: reportRoot, directory, runId: series.run_id,
        fingerprint: createHash('sha256').update(manifestBytes).update('\0').update(integrityBytes)
          .update('\0').update(suiteBytes).update('\0').update(seriesBytes).digest('hex')};
      await validateSuiteChatSource(source);
      const id = `suite:${JSON.stringify([workspace, source.runId, source.fingerprint])}`;
      this.inventories.set(workspace, {source, options: [{id, label: `Suite · ${suite.suite} · ${suite.finished_at ?? ''} · ${source.runId}`} ]});
    } catch (error: any) {
      // An unrelated missing suite must not disable the existing Investigation picker.
      const options = !suite && error?.code === 'ENOENT' ? [] : [{id: `suite-unavailable:${workspace}`, unavailable: true,
        label: `Suite evidence unavailable · ${error?.code === 'ENOENT' ? 'Saved bundle or integrity documents are missing.' : String(error?.message ?? error).slice(0, 200)}`}];
      this.inventories.set(workspace, {options});
    }
  }
  async read(id: string, workspace: string): Promise<SuiteChatSource> {
    const inventory = this.inventories.get(workspace);
    if (!inventory?.source || !inventory.options.some(option => option.id === id && !option.unavailable))
      throw new Error('Saved suite evidence is no longer available in this workspace.');
    await validateSuiteChatSource(inventory.source);
    return {...inventory.source};
  }
}
