import test from 'node:test';
import assert from 'node:assert/strict';
import narrative from './native-narrative-controls.cjs';

const created = '2026-10-15T00:34:00.123Z';
const runs = [{scenario: {id: 'sum_squares', implementation: 'allocating'}, collector: 'benchmark',
  qualification: {availability: 'complete', correctness: 'passed'}, summaries: [{metric: 'julia.wall.time', median: 0.25, samples: 2}]}];
const measured = {id: 'measured-fixture', report: {schema_version: 'perfchecker-scenario-run/1', runs}};
const ready = () => ({status: `Saved evidence · ${created}`, busy: false, narrative: false, imported: false,
  cancelDisabled: true, explainDisabled: false, runs: structuredClone(runs)});

function fixture(initial) {
  let firstRead;
  const seen = new Promise(resolve => {firstRead = resolve;});
  const state = {snapshot: initial, view: 'Saved evidence', opens: 0, explains: 0, proofs: []};
  const app = () => ({
    querySelector(selector) {
      if (selector === '.status') return {textContent: state.snapshot.status, classList: {contains: () => state.snapshot.busy}};
      if (selector === '.imported-diagnostic') return state.snapshot.imported ? {} : null;
      if (selector.startsWith('nav[')) return {textContent: state.view};
      throw new Error(`Unexpected DOM selector ${selector}`);
    },
    querySelectorAll(selector) {
      if (selector === 'button') return [{textContent: 'Cancel', disabled: state.snapshot.cancelDisabled},
        {textContent: 'Explain with configured model', disabled: state.snapshot.explainDisabled}];
      if (selector === 'h2') return state.snapshot.narrative ? [{textContent: 'Optional model explanation'}] : [];
      if (selector === 'details') return state.snapshot.runs.map(run => ({querySelector: selector =>
        ({textContent: selector === ':scope > summary' ? 'Qualification and measurement evidence' : JSON.stringify(run)})}));
      throw new Error(`Unexpected DOM collection ${selector}`);
    },
  });
  const card = {getByRole(role, options) {
    if (role === 'heading') return {innerText: async () => `run · ${created}`};
    assert.equal(options.name, 'Open evidence');
    return {click: async () => {state.opens++; state.view = 'Findings & advice';}};
  }};
  const frame = {
    getByRole(role, options) {
      if (role === 'heading') return {};
      return {click: async () => {
        if (options.name === 'Explain with configured model') state.explains++;
        else {assert.equal(options.name, 'Saved evidence'); state.view = options.name;}
      }, getAttribute: async () => 'page'};
    },
    locator(selector) {
      if (selector === 'article.card') return {filter: () => ({first: () => card})};
      assert.equal(selector, '#app');
      return {evaluate: async callback => {const observed = callback(app()); firstRead(); return observed;}};
    },
  };
  const context = {vscode: {commands: {executeCommand: async command => assert.equal(command, 'perfchecker.openInvestigations')}},
    findFrame: async () => frame, log: () => {}, proof: (name, detail) => state.proofs.push({name, ...detail})};
  return {state, context, seen};
}

async function waitForRealAck(initial) {
  const f = fixture(initial);
  let resolved = false;
  const pending = narrative.reloadMeasuredEvidence(f.context, measured, 'before-cancel').then(async frame => {
    resolved = true;
    await frame.getByRole('button', {name: 'Explain with configured model', exact: true}).click();
  });
  try {
    await f.seen;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resolved, false, 'Neither tab selection nor stale evidence acknowledges the reload');
    assert.equal(f.state.opens, 1, 'The actual Open evidence click is not retried');
    assert.equal(f.state.explains, 0, 'Explain waits for the measured report');
    assert(!f.state.proofs.some(check => check.name === 'native-narrative-history-measured-ack'));
    f.state.snapshot = ready();
    await pending;
    assert.equal(f.state.opens, 1);
    assert.equal(f.state.explains, 1);
    assert.equal(f.state.proofs.filter(check => check.name === 'native-narrative-history-measured-ack').length, 1);
  } finally {
    f.state.snapshot = ready();
    await pending;
  }
}

test('native narrative reload waits for the delayed DOM acknowledgement before Explain', async () => {
  await waitForRealAck({...ready(), status: 'Previous narrative', narrative: true, runs: []});
});

test('native narrative reload rejects a same-date report with different or incomplete deep measurement evidence', async () => {
  const changed = structuredClone(runs); changed[0].summaries[0].median = 999;
  for (const wrong of [changed, [], [{...runs[0], qualification: {availability: 'complete', correctness: 'failed'}}]])
    await waitForRealAck({...ready(), runs: wrong});
});

test('native narrative reload rejects stale identity, narrative, imported and busy UI states', async () => {
  for (const stale of [{status: 'Saved evidence · 2026-10-15T00:34:00.124Z'}, {narrative: true},
    {imported: true}, {busy: true}, {cancelDisabled: false}, {explainDisabled: true}])
    await waitForRealAck({...ready(), ...stale});
});
