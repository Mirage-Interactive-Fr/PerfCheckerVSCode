import * as path from 'node:path';

export interface Scenario {
  id: string; implementation: string; source: string; factory: string;
  collectors: string[]; catalog?: string; parameters?: Record<string, unknown>; fixtures?: string[]; requirements?: string[];
}
export interface Proposal {
  id: string; status: string; origin: {file: string; line: number};
  operation_candidate: string; oracle_candidate: string; missing: string[];
}
export interface InvestigationReport {
  schema_version: string;
  declared?: Scenario[]; candidates?: Proposal[]; warnings?: any[]; changes?: any[];
  ci?: any[]; corpora?: any[]; fingerprints?: Record<string, string>;
  analyzers?: {tool: string; scope: string; installation?: string}[];
  records?: any[]; recommendations?: any[]; configurations?: any[]; runs?: any[];
  tools?: any[]; cards?: any[]; experiments?: any[]; unexecuted?: any[]; results?: any[]; coverage?: any[];
  status?: string; advice?: InvestigationReport; fallback?: InvestigationReport; discovery?: InvestigationReport;
  external_review?: string;
}
const fields: Record<string, string[]> = {
  'perfchecker-discovery/1': ['declared', 'candidates', 'warnings', 'changes'],
  'perfchecker-diagnosis/1': ['records'],
  'perfchecker-advice/1': ['recommendations'],
  'perfchecker-scenario-comparison/1': ['configurations'],
  'perfchecker-scenario-run/1': ['runs'],
  'perfchecker-tool-catalog/1': ['tools'],
  'perfchecker-narrative/1': ['cards'],
  'perfchecker-investigation/1': ['experiments', 'unexecuted', 'records', 'runs'],
  'perfchecker-advisor-evaluation/1': ['results'],
  'perfchecker-scenario-sync/1': ['coverage', 'declared', 'proposals', 'changes', 'warnings'],
};

export function parseInvestigation(input: unknown): InvestigationReport {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid investigation report');
  const value = input as Record<string, unknown>;
  const schema = String(value.schema_version ?? '');
  if (!Object.hasOwn(fields, schema)) throw new Error(`Unsupported investigation schema: ${schema}`);
  if (value.external_review !== undefined && (typeof value.external_review !== 'string' || [...value.external_review].length > 16000)) {
    throw new Error('Invalid external MCP advice text');
  }
  for (const field of fields[schema]) {
    if (!Array.isArray(value[field]) || !(value[field] as unknown[]).every(item => item && typeof item === 'object' && !Array.isArray(item))) {
      throw new Error(`Invalid ${field} in ${schema}`);
    }
  }
  return value as unknown as InvestigationReport;
}

export function scenarioKey(value: Pick<Scenario, 'id' | 'implementation'>): string {
  return JSON.stringify([value.id, value.implementation]);
}

/** A result must contain every requested collector exactly once to qualify an item. */
export function scenarioOutcome(scenario: Scenario, report?: InvestigationReport): 'passed' | 'failed' | 'errored' {
  if (report?.schema_version !== 'perfchecker-scenario-run/1') return 'errored';
  const records = report.runs?.filter(r => r.scenario && scenarioKey(r.scenario) === scenarioKey(scenario)) ?? [];
  if (records.length !== scenario.collectors.length || scenario.collectors.some(
    collector => records.filter(r => r.collector === collector).length !== 1)) return 'errored';
  if (records.some(r => r.qualification?.correctness === 'failed')) return 'failed';
  return records.every(r => r.qualification?.availability === 'complete' &&
    r.qualification?.correctness === 'passed') ? 'passed' : 'errored';
}

export function selectedTestItems<T extends {id: string}>(all: T[], include?: readonly T[], exclude: readonly T[] = []): T[] {
  const excluded = new Set(exclude.map(item => item.id));
  return [...new Map((include ?? all).filter(item => !excluded.has(item.id)).map(item => [item.id, item])).values()];
}

export function selectedScenarios(declared: Scenario[], keys: string[]): Scenario[] {
  const selected = new Set(keys);
  const available = new Map(declared.map(item => [scenarioKey(item), item]));
  if (selected.size !== keys.length || keys.some(key => !available.has(key))) throw new Error('Selection is stale or unknown; discover again.');
  return keys.map(key => available.get(key)!);
}

export function workspacePath(root: string, input: string): string {
  const resolved = path.resolve(root, input);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Choose a file inside the package workspace.');
  }
  return resolved;
}

export function draftCase(proposal: Proposal): string {
  const comment = (value: string) => String(value).split(/\r?\n/).map(line => `# ${line}`).join('\n');
  return `# Draft from ${proposal.origin.file}:${proposal.origin.line}\n` +
    `${comment(proposal.operation_candidate)}\n${comment(proposal.oracle_candidate)}\n` +
    '# Complete these callbacks, use them in your ordinary tests, then adopt this factory.\n' +
    '# Discovery has not executed or validated this proposal.\n' +
    'module PerformanceCases\nfunction make_case(parameters)\n    (\n' +
    '        prepare = () -> error("Define fresh inputs and state"),\n' +
    '        operation = state -> error("Define the operation"),\n' +
    '        verify = (state, result) -> false,\n' +
    '        cleanup = state -> nothing,\n    )\nend\nend\n';
}

export function scenarioToml(scenario: Scenario, catalogDirectory: string): string {
  if (!scenario.id.trim() || !scenario.implementation.trim() ||
      !/^[A-Za-z_][A-Za-z_0-9!]*(\.[A-Za-z_][A-Za-z_0-9!]*)*$/.test(scenario.factory)) {
    throw new Error('Supply an identifier, an implementation, and a dotted Julia factory name.');
  }
  if (!scenario.collectors.length || scenario.collectors.some(c => !['benchmark', 'chairmark', 'profile', 'profile_alloc'].includes(c))) {
    throw new Error('Choose at least one supported collector.');
  }
  const quote = (value: string) => JSON.stringify(value);
  const inline = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
    if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([k, v]) => `${quote(k)} = ${inline(v)}`).join(', ')} }`;
    throw new Error('Parameters must be TOML-compatible JSON values; null is not supported.');
  };
  return '\n[[scenarios]]\n' +
    `id = ${quote(scenario.id)}\nimplementation = ${quote(scenario.implementation)}\n` +
    `source = ${quote(path.relative(catalogDirectory, scenario.source).replaceAll('\\', '/'))}\n` +
    `factory = ${quote(scenario.factory)}\ncollectors = [${scenario.collectors.map(quote).join(', ')}]\n` +
    `parameters = ${inline(scenario.parameters ?? {})}\n` +
    `requirements = [${(scenario.requirements ?? []).map(quote).join(', ')}]\n` +
    `fixtures = [${(scenario.fixtures ?? []).map(file => quote(path.relative(catalogDirectory, file).replaceAll('\\', '/'))).join(', ')}]\n`;
}

export function reportSummary(report: InvestigationReport): string {
  if (report.coverage) return `${report.coverage.length} CI combinations proposed · none automatically qualified`;
  if (report.tools) return `${report.tools.length} tools and integration candidates`;
  if (report.external_review) return `${report.status} · external MCP advice · text remains unverified`;
  if (report.cards) return `${report.status} · ${report.cards.length} generated explanations · verdicts remain deterministic`;
  if (report.experiments) return `${report.status} · ${report.experiments.length} experiments · ${report.unexecuted?.length ?? 0} not executed`;
  if (report.results) return `${report.results.length} advisor evaluations · prose requires review`;
  if (report.declared) return `${report.declared.length} declared · ${report.candidates!.length} proposals · ${report.changes!.length} changed inputs`;
  if (report.records) return `${report.records.filter(r => r.status === 'complete').length}/${report.records.length} analyses completed`;
  if (report.recommendations) return `${report.recommendations.length} evidence-based recommendations`;
  if (report.configurations) return `${report.configurations.length} separate configurations`;
  return `${report.runs?.length ?? 0} measurements`;
}

/** Total measured item time for VS Code's duration field, excluding process startup. */
export function nativeItemDuration(samples: unknown, expected: number): number {
  if (!Number.isInteger(expected) || expected < 1 || !Array.isArray(samples) || samples.length !== expected) {
    throw new Error('Missing or incomplete native item measurement samples.');
  }
  let milliseconds = 0;
  for (const sample of samples) {
    if (!sample || sample.status !== 'complete' || sample.correctness !== 'passed' ||
        typeof sample.seconds !== 'number' || !Number.isFinite(sample.seconds) || sample.seconds < 0) {
      throw new Error('Invalid native item measurement sample.');
    }
    milliseconds += sample.seconds * 1000;
  }
  if (!Number.isFinite(milliseconds)) throw new Error('Invalid native item measurement duration.');
  return milliseconds;
}
