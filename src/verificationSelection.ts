import type {PlanRun} from './model';

/** A trial must measure the modified working tree, including for a pinned reference analysis. */
export function verificationSelection(plan: PlanRun[], selections?: {package: string; feature: string; version: string}[]) {
  if (selections !== undefined && (!Array.isArray(selections) || !selections.length)) throw new Error('No checks were selected for verification.');
  const referenceRuns = selections?.map(selected => {
    const matching = plan.filter(run => run.package === selected.package && run.feature === selected.feature && run.version === selected.version);
    if (matching.length !== 1) throw new Error('The original checks changed. Select the new plan and analyze it before trying this suggestion.');
    return matching[0];
  }) ?? [];
  const cases = referenceRuns.length ? referenceRuns : plan.filter(run => run.target_kind === 'dev');
  if (!cases.length) throw new Error('Include a working-tree dev target in the feature suite before verifying a trial.');
  const trialRuns = [...new Map(cases.map(reference => {
    const matching = plan.filter(run => run.package === reference.package && run.feature === reference.feature && run.target_kind === 'dev');
    if (matching.length !== 1) throw new Error('Each selected check needs one working-tree dev target. Include it in the feature suite before verifying the trial.');
    return [matching[0].id, matching[0]] as const;
  })).values()];
  const runs = [...new Map([...referenceRuns, ...trialRuns].map(run => [run.id, run])).values()];
  return {runs, trialRuns};
}
