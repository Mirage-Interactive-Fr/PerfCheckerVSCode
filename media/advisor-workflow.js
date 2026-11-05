/* The host owns execution identities and transitions; the page only submits choices. */
function mountAdvisorWorkflow(root, send, logo) {
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (text, action, className = 'secondary') => {
    const element = node('button', text, className); element.type = 'button'; element.addEventListener('click', action); return element;
  };
  const optionalText = (label, placeholder) => {
    const field = node('label', label, 'optional-text'), input = node('textarea');
    input.rows = 2; input.maxLength = 4000; input.placeholder = placeholder; field.append(input);
    return {field, input};
  };
  let state = {evidence: [], guided: {}, busy: false}, selectedIds = [], loadedExecution = '';
  let selectedSuggestion = '';
  const hero = node('header', '', 'hero');
  if (logo) {const image = node('img'); image.src = logo; image.alt = 'PerfChecker'; hero.append(image);}
  const heading = node('div'); heading.append(node('p', 'PERFCHECKER / AGENT WORKFLOW', 'eyebrow'),
    node('h1', 'From checks to tested changes.'));
  const connection = node('p', 'Connect an agent to get started.', 'subtle'); heading.append(connection); hero.append(heading);
  const connect = button('Connect agent', () => send({type: 'chatSettings'}), 'primary');
  const shortcuts = node('details', '', 'connection-shortcuts'); shortcuts.append(node('summary', 'Local agent connections'));
  shortcuts.append(button('Connect Mistral Vibe', () => send({type: 'workflowConnectAcp', preset: 'vibe'})),
    button('Connect Claude (ACP)', () => send({type: 'workflowConnectAcp', preset: 'claude'})),
    button('Connect another ACP agent', () => send({type: 'workflowConnectAcp'})),
    button('Connect Codex CLI', () => send({type: 'chatConnectCodex'})),
    button('Connect local MCP server', () => send({type: 'chatConnectMcpStdio'})),
    button('Disconnect', () => send({type: state.connectionKind === 'codex' ? 'chatDisconnectCodex' : 'chatDisconnectMcpStdio'})));
  const cancel = button('Cancel action', () => send({type: 'chatCancel'})); hero.append(connect, shortcuts, cancel); root.append(hero);
  const status = node('p', '', 'status'); status.setAttribute('role', 'status'); root.append(status);
  const layout = node('div', '', 'workflow-layout'), flow = node('main', '', 'workflow-flow'), history = node('aside', '', 'workflow-history');
  layout.append(flow, history); root.append(layout);
  const section = (id, title, description) => {
    const element = node('section', '', 'workflow-step'); element.id = id;
    element.append(node('h2', title), node('p', description, 'subtle')); flow.append(element); return element;
  };

  const checks = section('workflow-checks', '1 · Choose or create checks', 'Use existing checks, or ask the agent to prepare a small suite for review.');
  const checkNotes = optionalText('What should the checks cover? (optional)', 'For example: focus on inserting and removing values.');
  const chooseChecks = button('Choose / run checks', () => send({type: 'workflowChecks'}), 'primary');
  const createChecks = button('Create checks with agent', () => send({type: 'workflowCreateChecks', instructions: checkNotes.input.value}));
  checks.append(chooseChecks, createChecks, checkNotes.field);

  const results = section('workflow-results', '2 · Select the results', 'The execution and check selection supply the agent’s context.');
  const executionLabel = node('label', 'Execution'), execution = node('select'); execution.id = 'workflow-execution';
  executionLabel.append(execution); results.append(executionLabel);
  execution.addEventListener('change', () => send({type: 'workflowSelectResults', evidenceId: execution.value}));
  const resultActions = node('div', '', 'actions');
  const all = button('Select all', () => updateSelection((state.guided.context?.results ?? []).map(result => result.id)));
  const none = button('Clear selection', () => updateSelection([]));
  const plots = button('Open plots', () => send({type: 'workflowShowResults', resultIds: selectedIds}));
  resultActions.append(all, none, plots); results.append(resultActions);
  const resultList = node('div', '', 'workflow-results'), resultCount = node('p', '', 'subtle');
  results.append(resultCount, resultList);
  function updateSelection(ids) {
    selectedIds = [...ids]; selectedSuggestion = '';
    send({type: 'workflowSelection', resultIds: selectedIds}); renderResults(); renderControls();
  }
  function renderResults() {
    const context = state.guided.context;
    resultCount.textContent = context ? `${selectedIds.length} of ${context.results.length} check results selected` : 'No execution selected yet.';
    resultList.replaceChildren(...(context?.results ?? []).map(result => {
      const label = node('label', '', 'workflow-result'), input = node('input'); input.type = 'checkbox';
      input.checked = selectedIds.includes(result.id); input.disabled = state.busy;
      input.addEventListener('change', () => updateSelection(input.checked ? [...selectedIds, result.id] : selectedIds.filter(id => id !== result.id)));
      const title = node('div'); title.append(node('strong', `${result.package} · ${result.workload || result.feature}`));
      title.append(node('small', `${result.check || result.feature} · ${result.target}${result.revision ? ` · ${result.revision.slice(0, 12)}` : ''}`));
      title.title = result.revision || result.target;
      label.append(input, title, node('span', result.status, `result-status ${result.status}`)); return label;
    }));
  }

  const analysis = section('workflow-analysis', '3 · Analyze and choose a next step', 'Ask about these results, then choose one suggestion to try.');
  const topics = node('fieldset', '', 'analysis-topics'); topics.append(node('legend', 'Look at'));
  const topicInputs = new Map();
  for (const [value, title] of [['timing','Timing'],['profiles','Profiles'],['allocations','Allocations'],['comparisons','Compare targets'],['suggestions','Next steps']]) {
    const label = node('label'), input = node('input'); input.type = 'checkbox'; input.checked = true; input.value = value;
    label.append(input, node('span', title)); topics.append(label); topicInputs.set(value, input);
  }
  const analysisNotes = optionalText('Anything to add? (optional)', 'For example: keep the public API unchanged.');
  const analyze = button('Analyze selected results', () => send({type: 'workflowAnalyze', resultIds: selectedIds,
    topics: [...topicInputs].filter(([,input]) => input.checked).map(([key]) => key), instructions: analysisNotes.input.value}), 'primary');
  const analysisOutput = node('div', '', 'analysis-output');
  analysis.append(topics, analysisNotes.field, analyze, analysisOutput);
  const trialNotes = optionalText('Anything to add to this trial? (optional)', 'For example: also cover empty input in the tests.');
  const trySuggestion = button('Try selected suggestion', () => send({type: 'workflowTrySuggestion', suggestionId: selectedSuggestion, instructions: trialNotes.input.value}), 'primary');
  analysis.append(trialNotes.field, trySuggestion);

  const trial = section('workflow-trial', '4 · Review, test and compare', 'Review the proposed change, then run the package tests and the same performance checks.');
  const trialSummary = node('p', '', 'message-text'), files = node('ul'), patch = node('pre', '', 'patch-preview');
  const diff = button('Open full diff', () => send({type: 'chatDiff'}));
  const apply = button('Apply, test & analyze', () => send({type: 'workflowApplyVerify', instructions: trialNotes.input.value}), 'primary');
  const verify = button('Run verification again', () => send({type: 'workflowVerify'}));
  const feedback = button('Analyze test feedback', () => send({type: 'workflowAnalyzeTrial', instructions: analysisNotes.input.value}));
  const keep = button('Keep trial', () => send({type: 'workflowKeep'}), 'primary');
  const restore = button('Restore previous code', () => send({type: 'workflowRestore'}));
  const discard = button('Discard proposal', () => send({type: 'chatDiscard'}));
  const trialActions = node('div', '', 'actions'); trialActions.append(diff, apply, verify, feedback, keep, restore, discard);
  const verification = node('div', '', 'verification-output'); trial.append(trialSummary, files, patch, trialActions, verification);

  function renderAnalysis() {
    const report = state.guided.analysis;
    analysisOutput.replaceChildren();
    if (!report) {analysisOutput.append(node('p', 'The agent’s analysis and suggestions will appear here.', 'subtle')); return;}
    analysisOutput.append(node('h3', 'Agent analysis'), node('p', report.summary, 'message-text'));
    for (const finding of report.findings) {
      const card = node('details', '', 'finding'); card.append(node('summary', finding.title), node('p', finding.detail, 'message-text'),
        button('Show measurements', () => send({type: 'workflowShowResults', resultIds: finding.resultIds})));
      analysisOutput.append(card);
    }
    analysisOutput.append(node('h3', 'Suggestions'));
    if (!report.suggestions.length) analysisOutput.append(node('p', 'The agent did not suggest a change. You can keep working with the current code.'));
    for (const suggestion of report.suggestions) {
      const card = node('article', '', 'suggestion-card'), label = node('label'), input = node('input');
      input.type = 'radio'; input.name = 'selected-suggestion'; input.value = suggestion.id;
      input.checked = selectedSuggestion === suggestion.id; input.disabled = state.busy || !state.guided.analysisCurrent;
      input.addEventListener('change', () => {selectedSuggestion = suggestion.id; send({type: 'workflowSuggestion', suggestionId: suggestion.id}); renderControls();});
      label.append(input, node('strong', suggestion.title));
      const verification = node('ul'); suggestion.checks.forEach(check => verification.append(node('li', check)));
      card.append(label, node('p', suggestion.rationale, 'message-text'), node('p', suggestion.change, 'message-text'), verification);
      analysisOutput.append(card);
    }
  }
  function renderTrial() {
    const proposal = state.proposal, report = state.guided.verification;
    trialSummary.textContent = state.implementationSummary || 'No implementation has been prepared.';
    files.replaceChildren(...(proposal?.files ?? []).map(file => node('li', file)));
    patch.hidden = !proposal; patch.textContent = proposal ? proposal.patch.slice(0, 20000) : '';
    verification.replaceChildren();
    if (!report) return;
    verification.append(node('h3', 'Verification'), node('p', `Package tests: ${report.packageTests?.status ?? 'not run'}`),
      node('p', `Performance checks: ${report.checks?.status ?? 'not run'}`));
    if (report.checks?.comparisonNotice) verification.append(node('p', report.checks.comparisonNotice, 'subtle'));
    if (report.error) verification.append(node('p', report.error, 'error'));
    if (report.packageTests?.output) {
      const details = node('details'); details.append(node('summary', 'Package test output'), node('pre', report.packageTests.output));
      verification.append(details);
    }
    const comparisons = report.checks?.comparisons ?? [];
    if (comparisons.length) {
      const table = node('table'), head = node('tr');
      ['Metric','Reference','Trial','Change'].forEach(title => head.append(node('th', title))); table.append(head);
      for (const comparison of comparisons) {
        const row = node('tr'), quantity = value => Number.isFinite(value) ? `${new Intl.NumberFormat('en-US').format(value)} ${comparison.unit || ''}` : 'Unavailable';
        [comparison.metric, `${comparison.baseline_version}: ${quantity(comparison.baseline_median)}`,
          `${comparison.candidate_version}: ${quantity(comparison.candidate_median)}`,
          Number.isFinite(comparison.relative_delta) ? `${(100 * comparison.relative_delta).toFixed(1)}%` : 'Unavailable']
          .forEach(value => row.append(node('td', value)));
        table.append(row);
      }
      verification.append(table);
    }
  }
  function renderHistory() {
    history.replaceChildren(node('h2', 'Action history'), node('p', 'Continue from a previous choice to explore another branch.', 'subtle'));
    const saved = state.guided.history, nodes = saved?.nodes ?? [], depth = new Map();
    for (const item of nodes) {
      const level = item.parent ? (depth.get(item.parent) ?? 0) + 1 : 0; depth.set(item.id, level);
      const card = node('article', '', 'history-node'); card.style.marginLeft = `${Math.min(level, 5) * 9}px`;
      if (item.id === saved.current) card.setAttribute('aria-current', 'step');
      card.append(node('strong', item.title), node('small', new Date(item.createdAt).toLocaleString('en-US')), ...(item.data.historyMode ? [node('small', item.data.historyMode === 'native-fork' ? 'Native fork' : item.data.historyMode === 'context-replay' ? 'Context replay' : 'New conversation')] : []),
        button('Continue from here', () => send({type: 'workflowContinue', nodeId: item.id})));
      card.querySelector('button').disabled = state.busy; history.append(card);
    }
  }
  function renderControls() {
    cancel.hidden = !state.busy;
    for (const control of [connect, chooseChecks, createChecks, execution, all, none]) control.disabled = state.busy;
    analyze.disabled = state.busy || !selectedIds.length;
    plots.disabled = state.busy || !selectedIds.length;
    trySuggestion.disabled = state.busy || !selectedSuggestion || !state.guided.analysisCurrent || !!state.proposal?.applied;
    diff.disabled = state.busy || !state.proposal;
    apply.disabled = state.busy || !state.proposal || state.proposal.intentMatches === false || state.proposal.applied || !state.proposal.files.length;
    verify.disabled = state.busy || !state.proposal?.applied;
    feedback.disabled = state.busy || !state.guided.verification;
    restore.disabled = state.busy || !state.proposal?.applied;
    keep.disabled = state.busy || !state.proposal?.applied || !!state.guided.verification?.error || state.guided.verification?.packageTests?.status !== 'passed' || state.guided.verification?.checks?.status !== 'passed';
    discard.disabled = state.busy || !state.proposal || state.proposal.applied;
  }
  return {receive(value) {
    if (value.type !== 'chatState') return;
    state = {...value, guided: value.guided ?? {}};
    connection.textContent = state.connection || 'Use your MCP agent connection.'; status.textContent = state.status || '';
    execution.replaceChildren(new Option('Choose an execution…', ''), ...(state.evidence ?? []).map(item => {
      const option = new Option(item.label, item.id); option.disabled = !!item.unavailable; return option;
    }));
    execution.value = state.evidenceId || '';
    const key = state.guided.context?.evidenceId || '';
    if (key !== loadedExecution || JSON.stringify(state.guided.selectedResultIds) !== JSON.stringify(selectedIds)) {
      loadedExecution = key; selectedIds = [...(state.guided.selectedResultIds ?? [])];
    }
    selectedSuggestion = state.guided.selectedSuggestionId || '';
    renderResults(); renderAnalysis(); renderTrial(); renderHistory(); renderControls();
  }};
}
