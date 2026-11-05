import type {AnalysisContext} from './guidedAnalysis';

/** Compare repeated operation measurements, never profile-frame or allocation-site weights. */
export function trialComparisons(before: any[], after: any[], reference: AnalysisContext, trial: AnalysisContext) {
  const eligible = (row: any) => row && ['operation_measurement', 'independent_operation_total'].includes(row.record_semantics) &&
    row.correctness !== 'failed' && typeof row.median === 'number' && Number.isFinite(row.median) && row.median >= 0 &&
    ['case_id', 'target_id', 'metric', 'unit', 'measurement_definition', 'scope', 'aggregation', 'comparison_fingerprint', 'collector']
      .every(key => typeof row[key] === 'string' && row[key]);
  const key = (row: any) => JSON.stringify([row.case_id, row.metric, row.unit,
    row.measurement_definition, row.scope, row.aggregation, row.comparison_fingerprint, row.collector, row.record_semantics]);
  const index = (rows: any[]) => {
    const grouped = new Map<string, any[]>();
    for (const row of rows.filter(eligible)) {const id = key(row); const group = grouped.get(id) ?? []; group.push(row); grouped.set(id, group);}
    return grouped;
  };
  const left = index(before), right = index(after), comparisons = [];
  for (const [identity, rows] of left) for (const a of rows) {
    if (rows.filter(row => row.target_id === a.target_id).length !== 1) continue;
    const referenceResult = reference.results.find(result => result.target === a.target_id && a.case_id.endsWith(`/${result.package}/${result.feature}`));
    if (!referenceResult) continue;
    const targets = trial.results.filter(result => result.targetKind === 'dev' && result.package === referenceResult.package && result.feature === referenceResult.feature);
    if (targets.length !== 1) continue;
    const matching = right.get(identity)?.filter(row => row.target_id === targets[0].target);
    if (matching?.length !== 1) continue;
    const b = matching[0];
    comparisons.push({metric: `${a.case_id} · ${a.metric}`, unit: a.unit,
      baseline_version: `${a.target_id} · run ${reference.runId}`, candidate_version: `${b.target_id} · run ${trial.runId}`,
      baseline_median: a.median, candidate_median: b.median,
      relative_delta: a.median > 0 ? (b.median - a.median) / a.median : null,
      baseline_samples: a.record_count, candidate_samples: b.record_count,
      correctness: [a.correctness, b.correctness], scope: a.scope, measurement_definition: a.measurement_definition,
      interpretation: 'Observed change between executions; this is not a statistical performance verdict.'});
  }
  return comparisons;
}
