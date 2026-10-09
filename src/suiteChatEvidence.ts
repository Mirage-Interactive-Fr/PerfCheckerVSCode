import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {workspacePath} from './investigationModel';

export interface SuiteChatSource {
  kind: 'suite-bundle'; workspace: string; root: string; reports: string; directory: string;
  runId: string; fingerprint: string;
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
  for (const name of ['suite-result.json', 'version-series.json']) {
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
