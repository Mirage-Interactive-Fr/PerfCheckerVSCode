(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let state = {}; let selected = new Set(saved.selected || []); let initialized = false;
  let selectedTools = new Set(saved.tools || ['jet', 'alloccheck', 'latency']); let toolsInitialized = Boolean(saved.tools);
  let tab = saved.tab || 'scenarios'; let query = saved.query || '';
  const app = document.getElementById('app');
  const send = (type, detail = {}) => vscode.postMessage({type, ...detail});
  const persist = () => vscode.setState({selected: [...selected], tools: [...selectedTools], tab, query});
  const node = (tag, text, cls) => {const element = document.createElement(tag); if (text !== undefined) element.textContent = String(text); if (cls) element.className = cls; return element;};
  const key = scenario => JSON.stringify([scenario.id, scenario.implementation]);
  const button = (text, callback, disabled = false) => {const b = node('button', text); b.type = 'button'; b.disabled = disabled; b.addEventListener('click', callback); return b;};
  const source = (file, line = 1) => button(`${file}:${line}`, () => send('source', {file, line}));
  const details = (title, content) => {const item = node('details'); item.append(node('summary', title), node('pre', typeof content === 'string' ? content : JSON.stringify(content, null, 2))); return item;};
  const paragraph = (label, value) => {const p = node('p'); p.append(node('strong', `${label} `), node('span', value)); return p;};
  const execute = action => send('execute', {action, keys: [...selected], tools: [...selectedTools]});
  const format = (value, unit) => {
    if (!Number.isFinite(value)) return 'Unavailable';
    if (unit === 's') {const scale = value < 1e-6 ? [1e9, 'ns'] : value < 1e-3 ? [1e6, 'µs'] : value < 1 ? [1000, 'ms'] : [1, 's']; return `${(value * scale[0]).toPrecision(4)} ${scale[1]}`;}
    return `${new Intl.NumberFormat(undefined, {maximumFractionDigits: 2}).format(value)} ${unit === 'By' ? 'bytes' : unit === '1' ? 'allocations' : unit}`;
  };
  function measurement(run) {
    const card = node('article', undefined, 'card'); card.append(node('h3', `${run.scenario.id} · ${run.scenario.implementation} · ${run.collector || ''}`));
    card.append(paragraph('Correctness:', run.qualification.correctness), paragraph('Availability:', run.qualification.availability));
    for (const summary of run.summaries || []) {
      const metricName = {'julia.wall.time': 'Operation duration', 'julia.alloc.bytes': 'Allocated memory', 'julia.alloc.count': 'Allocation count'}[summary.metric] || summary.metric;
      card.append(paragraph(metricName, `median ${format(summary.median, summary.unit)} · ${summary.samples} samples`));
      if (summary.unit !== 's' || !summary.display_values?.length) continue;
      const values = summary.display_values.filter(Number.isFinite); const low = Math.min(...values); const high = Math.max(...values);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 520 100'); svg.setAttribute('class', 'sample-chart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Operation duration by sample; preparation and verification excluded');
      values.forEach((value, index) => {
        const dot = document.createElementNS(svg.namespaceURI, 'circle'); dot.setAttribute('cx', String(12 + index * 496 / Math.max(values.length - 1, 1))); dot.setAttribute('cy', String(high === low ? 50 : 88 - (value - low) * 76 / (high - low))); dot.setAttribute('r', '3'); dot.setAttribute('tabindex', '0');
        const label = `Displayed sample ${index + 1}: ${format(value, 's')}`; dot.setAttribute('aria-label', label); const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = label; dot.append(title); svg.append(dot);
      }); card.append(svg, node('p', `${format(low, 's')} – ${format(high, 's')}${summary.display_truncated ? ' · display sampled; full series is retained in the bundle' : ''}`));
    }
    if (run.collector === 'benchmark') card.append(node('p', 'Allocation values are the BenchmarkTools trial estimate; timing samples remain individual observations.'));
    if (run.profile) {
      const profile = node('details'); profile.append(node('summary', 'Explore sampled stacks and allocations'));
      const filter = node('input'); filter.type = 'search'; filter.placeholder = 'Filter function or file'; filter.setAttribute('aria-label', 'Filter profile stacks');
      const rows = node('div');
      const draw = () => {
        rows.replaceChildren();
        const stacks = run.profile.stacks?.length ? run.profile.stacks : run.profile.allocation_sites || [];
        if (!stacks.length) {
          rows.append(node('p', 'No samples were collected. Run a longer operation or more repetitions before drawing conclusions.'));
          return;
        }
        const matching = stacks.filter(row => JSON.stringify(row).toLowerCase().includes(filter.value.toLowerCase()));
        for (const row of matching.slice(0, 100)) {
          const stack = row.stack || [];
          const sourcePath = (run.scenario.source || '').replaceAll('\\', '/').toLowerCase();
          const frame = run.profile.stacks?.length ? stack.at(-1) :
            stack.find(item => sourcePath && typeof item === 'object' && String(item.file).replaceAll('\\', '/').toLowerCase() === sourcePath) || stack[0];
          const label = typeof frame === 'string' ? frame : frame ? `${frame.function} (${frame.file}:${frame.line})` : 'Allocation site';
          const weight = run.profile.stacks?.length ? `${row.value ?? row.count ?? 0} sampled stacks` : format(row.bytes, 'By');
          rows.append(details(`${weight} · ${label}`, row));
        }
        rows.append(node('p', `${Math.min(matching.length, 100)} / ${matching.length} matching stacks. Full evidence remains in the bundle.`));
      };
      filter.addEventListener('input', draw); draw(); profile.append(filter, rows, details('Raw profile', run.profile.text || '' )); card.append(profile);
    }
    card.append(details('Qualification and measurement evidence', run)); return card;
  }

  function render() {
    app.replaceChildren();
    const toolbar = node('div', undefined, 'toolbar');
    toolbar.append(button('Discover tests', () => execute('discover'), state.busy),
      button('Measure selected', () => execute('run'), state.busy || !selected.size),
      button('Diagnose selected', () => execute('diagnose'), state.busy || !selected.size || !selectedTools.size),
      button('Investigate selected', () => execute('investigate'), state.busy || !selected.size || !selectedTools.size),
      button('Cancel', () => send('cancel'), !state.busy), button('Worker log', () => send('log')));
    app.append(toolbar, node('p', state.message || 'Discover tests to begin.', state.busy ? 'status busy' : 'status'));
    const nav = node('nav'); nav.setAttribute('aria-label', 'Investigation views');
    for (const [id, title] of [['scenarios', 'Scenarios'], ['evidence', 'Findings & advice'], ['comparisons', 'Before / after'], ['history', 'Saved evidence']]) {
      const b = button(title, () => {tab = id; persist(); render();}); b.setAttribute('aria-current', tab === id ? 'page' : 'false'); nav.append(b);
    }
    app.append(nav);
    const body = node('section'); app.append(body);
    if (tab === 'scenarios') scenarios(body);
    if (tab === 'evidence') evidence(body);
    if (tab === 'comparisons') comparisons(body);
    if (tab === 'history') history(body);
  }

  function scenarios(body) {
    const discovery = state.discovery || {};
    const declared = discovery.declared || []; const proposals = discovery.candidates || [];
    const counters = node('div', undefined, 'counters');
    for (const [count, label] of [[declared.length, 'declared'], [proposals.length, 'proposed'], [(discovery.changes || []).length, 'changed inputs']]) {
      const card = node('div', undefined, 'counter'); card.append(node('strong', count), node('span', label)); counters.append(card);
    }
    body.append(counters);
    body.append(button('Compare catalogue with CI', () => execute('sync'), state.busy), button('Browse tool catalogue', () => execute('tools'), state.busy));
    const controls = node('div', undefined, 'toolbar');
    const search = node('input'); search.type = 'search'; search.placeholder = 'Filter scenarios and test proposals'; search.value = query; search.setAttribute('aria-label', 'Filter scenarios');
    search.addEventListener('change', () => {query = search.value; persist(); render();});
    controls.append(search, button('Select all declared', () => {selected = new Set(declared.map(key)); persist(); render();}),
      button('Clear selection', () => {selected.clear(); persist(); render();}), node('span', `${selected.size} selected`));
    body.append(controls);
    const tools = node('fieldset'); tools.append(node('legend', 'Diagnostic tools'));
    for (const tool of state.analyzers || []) {
      const id = tool.tool; const label = `${id} · ${tool.scope}${tool.installation ? ` (controller: ${tool.installation}; worker checked on launch)` : ''}`;
      const container = node('label'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedTools.has(id);
      checkbox.addEventListener('change', () => {checkbox.checked ? selectedTools.add(id) : selectedTools.delete(id); persist(); render();});
      container.append(checkbox, node('span', label)); tools.append(container);
    }
    body.append(tools, node('h2', 'Declared scenarios'));
    const matching = value => JSON.stringify(value).toLowerCase().includes(query.toLowerCase());
    const cards = node('div', undefined, 'grid');
    for (const scenario of declared.filter(matching)) {
      const card = node('article', undefined, 'card'); const label = node('label', undefined, 'scenario-title');
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(key(scenario));
      checkbox.addEventListener('change', () => {checkbox.checked ? selected.add(key(scenario)) : selected.delete(key(scenario)); persist(); render();});
      label.append(checkbox, node('strong', scenario.id)); card.append(label, node('p', scenario.implementation, 'implementation'),
        node('p', (scenario.collectors || []).join(' · ')), source(scenario.source), details('Factory and inputs', {factory: scenario.factory, parameters: scenario.parameters, fixtures: scenario.fixtures, requirements: scenario.requirements})); cards.append(card);
    }
    body.append(cards);
    if (!declared.length) body.append(node('p', 'No declared cases yet. Prepare a proposal or adopt a shared factory below.', 'empty'));
    const form = node('details', undefined, 'card'); form.append(node('summary', 'Adopt a shared factory into the catalogue'));
    form.append(node('p', `Catalogue: ${state.catalog || ''}`), node('p', 'The same factory should be used by your ordinary tests. Adoption declares it as executable; it does not establish correctness or create a performance budget.'));
    const fields = {};
    for (const [id, title, placeholder] of [['id', 'Scenario identifier', 'parse-small-document'], ['source', 'Julia source file', 'test/performance_cases.jl'], ['factory', 'Factory entry point', 'PerformanceCases.make_case'], ['implementation', 'Implementation', 'default']]) {
      const label = node('label', undefined, 'field'); const input = node('input'); input.placeholder = placeholder; input.name = id;
      if (id === 'implementation') input.value = 'default'; fields[id] = input; label.append(node('span', title), input); form.append(label);
    }
    const parameterLabel = node('label', undefined, 'field'); const parameters = node('textarea'); parameters.value = '{}'; parameterLabel.append(node('span', 'Parameters (JSON)'), parameters);
    const fixtureLabel = node('label', undefined, 'field'); const fixtures = node('textarea'); fixtures.value = '[]'; fixtureLabel.append(node('span', 'Fixture paths (JSON array)'), fixtures);
    const collectors = node('fieldset'); collectors.append(node('legend', 'Collectors'));
    for (const collector of ['benchmark', 'chairmark', 'profile', 'profile_alloc']) {
      const label = node('label'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.value = collector; checkbox.checked = collector === 'benchmark'; label.append(checkbox, node('span', collector)); collectors.append(label);
    }
    const adoptionError = node('p'); adoptionError.setAttribute('role', 'alert');
    form.append(parameterLabel, fixtureLabel, collectors, adoptionError, button('Add declaration', () => {
      try {send('adopt', {scenario: {...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.value])), parameters: JSON.parse(parameters.value), fixtures: JSON.parse(fixtures.value), collectors: [...collectors.querySelectorAll('input:checked')].map(input => input.value)}}); adoptionError.textContent = '';}
      catch (error) {adoptionError.textContent = `Invalid input: ${error.message}`;}
    }, state.busy)); body.append(form);
    body.append(node('h2', 'Proposals from existing tests'));
    const visible = proposals.filter(matching);
    for (const proposal of visible.slice(0, 200)) {
      const card = node('article', undefined, 'card proposal'); card.append(source(proposal.origin.file, proposal.origin.line), node('pre', proposal.operation_candidate),
        paragraph('To complete:', (proposal.missing || []).join('; ')), button('Prepare shared case', () => send('draft', {id: proposal.id}))); body.append(card);
    }
    if (visible.length > 200) body.append(node('p', 'Showing 200 proposals. Refine the filter to inspect others.'));
    for (const change of discovery.changes || []) body.append(details(`${change.status}: ${change.file}`, change));
    for (const warning of discovery.warnings || []) body.append(paragraph(`${warning.file}:${warning.line}`, warning.message));
    if ((discovery.ci || []).length) body.append(details('CI configurations inferred from literal matrices', discovery.ci));
    if ((discovery.corpora || []).length) body.append(details('Frozen input corpora', discovery.corpora));
  }

  function evidence(body) {
    body.append(node('h2', 'Evidence and next experiments'), button('Advise from saved evidence', () => execute('advise'), state.busy),
      button('Explain with configured model', () => execute('narrate'), state.busy), button('Model settings', () => send('advisorSettings')));
    if (state.report?.cards) {
      body.append(node('h2', 'Optional model explanation'), node('p', `${state.report.status} · Generated prose needs review. The deterministic evidence below remains authoritative.`));
      if (state.report.external_review) {
        const review = node('article', undefined, 'card');
        const text = node('p', state.report.external_review); text.style.whiteSpace = 'pre-wrap';
        review.append(node('h3', 'External MCP advice'), node('p', 'Free-text advice: references are not individually verified and no proposed action is executed.'), text);
        body.append(review);
      }
      for (const card of state.report.cards) {
        const reference = state.report.fallback?.recommendations?.find(r => r.id === card.evidence_id);
        const article = node('article', undefined, 'card'); article.append(node('h3', reference ? `${reference.scenario} · ${reference.implementation}` : 'Explanation'),
          node('p', card.explanation), details('Evidence reference', {id: card.evidence_id, rule: reference?.rule_id})); body.append(article);
      }
      body.append(details('Model usage and availability', {status: state.report.status, model: state.report.model, usage: state.report.usage, elapsed_seconds: state.report.elapsed_seconds, message: state.report.message}));
    }
    if (state.report?.experiments) {
      body.append(node('h2', 'Bounded investigation'), paragraph('Outcome:', state.report.status), details('Limits', state.report.limits));
      for (const experiment of state.report.experiments) body.append(paragraph(`${experiment.status} · ${experiment.elapsed_seconds.toFixed(2)} s`, experiment.purpose));
      body.append(details('Experiments not executed', state.report.unexecuted), details('Optional model decisions', state.report.decisions));
    }
    if (state.report?.coverage) body.append(node('h2', 'Shared catalogue and CI'), node('p', 'These combinations are proposals. They do not certify CI coverage or adopt budgets.'), details('Configurations to qualify', state.report.coverage), details('Changed inputs', state.report.changes), details('Unresolved CI constructs', state.report.warnings));
    if (state.report?.tools) {
      body.append(node('h2', 'Tool catalogue'), node('p', 'Integration status describes availability of an adapter, never successful qualification on your machine.'));
      const filter = node('input'); filter.type = 'search'; filter.placeholder = 'Search category, tool or integration status'; filter.setAttribute('aria-label', 'Search tool catalogue');
      const list = node('div');
      const draw = () => {list.replaceChildren(); for (const tool of state.report.tools.filter(t => JSON.stringify(t).toLowerCase().includes(filter.value.toLowerCase()))) {
        const card = node('article', undefined, 'card'); card.append(node('h3', tool.name), paragraph('Integration:', tool.integration), node('p', tool.purpose), details('Platforms, source and limits', tool)); list.append(card);
      }};
      filter.addEventListener('input', draw); draw(); body.append(filter, list);
    }
    for (const record of state.report?.records || []) {
      const card = node('article', undefined, 'card'); card.append(node('h3', `${record.scenario} · ${record.implementation} · ${record.tool}`));
      const badges = node('div', undefined, 'badges');
      for (const [label, value] of [['Availability', record.status], ['Correctness', record.correctness || 'not_checked'], ['Quality', record.quality || 'not_checked'], ['Performance', record.performance || 'not_compared']]) badges.append(node('span', `${label}: ${value}`, 'badge'));
      card.append(badges); if (record.message) card.append(node('pre', record.message));
      if (record.summary) card.append(node('p', record.summary));
      for (const finding of record.findings || []) {
        const findingCard = node('div', undefined, 'finding'); findingCard.append(node('strong', finding.rule_id), node('pre', finding.message));
        if (finding.location?.file) findingCard.append(source(finding.location.file, finding.location.line)); card.append(findingCard);
      }
      for (const artifact of record.artifacts || []) card.append(button(`Open ${artifact.kind}`, () => send('artifact', {file: artifact.path})));
      card.append(details('Configuration, measurements and limits', {configuration: record.configuration, measurements: record.measurements, scope: record.analysis_scope || record.measurement_scope, version: record.tool_version, limits: record.limitations})); body.append(card);
    }
    if (state.report?.runs) for (const run of state.report.runs) body.append(measurement(run));
    const advice = state.advice || (state.report?.recommendations ? state.report : undefined);
    if (advice) {
      body.append(node('h2', 'Recommendations'));
      for (const recommendation of advice.recommendations) {
        const card = node('article', undefined, 'card advice'); card.append(node('h3', `${recommendation.scenario} · ${recommendation.implementation}`),
          node('p', recommendation.hypothesis), paragraph('Next experiment:', recommendation.action), paragraph('After the change:', recommendation.validation));
        if (recommendation.location?.file) card.append(source(recommendation.location.file, recommendation.location.line));
        card.append(details('Evidence and limits', {evidence: recommendation.evidence, limitations: recommendation.limitations})); body.append(card);
      }
      if (!advice.recommendations.length) body.append(node('p', 'No recommendation is supported by these rules. This does not certify optimal performance.', 'empty'));
    }
    if (!advice && !state.report?.records && !state.report?.runs && !state.report?.tools && !state.report?.coverage && !state.report?.cards) body.append(node('p', 'Run an analysis or open saved evidence to begin.', 'empty'));
  }

  function comparisons(body) {
    body.append(node('h2', 'Compare the same scenarios'), node('p', 'Choose explicit before and after measurements. Implementations and collectors remain separate; absent or incompatible configurations remain visible.'), button('Choose baseline and candidate', () => execute('compare'), state.busy));
    for (const configuration of state.report?.configurations || []) {
      const card = node('article', undefined, 'card'); card.append(node('h3', `${configuration.scenario} · ${configuration.implementation} · ${configuration.collector}`),
        node('p', configuration.status, 'badge'), details('Changes, regressions and compatibility', configuration.comparison || {status: 'not_tested'})); body.append(card);
    }
    if (!state.report?.configurations) body.append(node('p', 'No before/after comparison is open.', 'empty'));
  }

  function history(body) {
    body.append(node('h2', 'Saved evidence'), node('p', 'Open a previous report without rerunning the target program. JSON and Markdown preserve the evidence for CI and agents.'));
    for (const item of state.history || []) {
      const card = node('article', undefined, 'card'); card.append(node('h3', `${item.action} · ${item.created}`), node('p', `${item.status} · ${item.summary}`));
      const actions = node('div', undefined, 'toolbar'); actions.append(button('Open evidence', () => {tab = item.action === 'discover' ? 'scenarios' : item.action === 'compare' ? 'comparisons' : 'evidence'; persist(); send('history', {id: item.id});}, !item.report),
        button('JSON', () => send('export', {id: item.id, format: 'json'}), !item.report),
        button('Markdown', () => send('export', {id: item.id, format: 'md'}), !item.report)); card.append(actions); body.append(card);
    }
  }
  window.addEventListener('message', event => {
    if (event.data.type !== 'state') return;
    const previousAttempt = state.history?.[0]?.id;
    state = event.data;
    if (state.history?.[0]?.id && state.history[0].id !== previousAttempt) tab = state.history[0].action === 'discover' ? 'scenarios' : state.history[0].action === 'compare' ? 'comparisons' : 'evidence';
    if (!toolsInitialized) {selectedTools = new Set(state.tools || []); toolsInitialized = true;}
    if (state.discovery) {
      const available = new Set((state.discovery.declared || []).map(key));
      if (!initialized) {if (!selected.size) selected = available; initialized = true;}
      selected = new Set([...selected].filter(item => available.has(item)));
    }
    if (state.report?.records || state.report?.recommendations || state.report?.runs) {if (state.busy) tab = 'evidence';}
    if (state.report?.configurations) tab = 'comparisons';
    persist(); render();
  });
  send('ready');
})();
