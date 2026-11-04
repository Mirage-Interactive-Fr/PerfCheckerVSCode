import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkflowHistory} from '../dist/workflowHistory.js';

test('continuing from a checkpoint forks the action tree without rewriting descendants or mixing feedback',()=>{
  const history=new WorkflowHistory('workspace-A');
  const results=history.append('results','Measured run',{runId:'first'},'context-a');
  const analysis=history.append('analysis','Initial analysis',{summary:'Original agent response'},'context-a',{provider:'codex',connection:'c',id:'session-a'});
  const trial=history.append('implementation','First approach',{suggestionId:'one'},'context-a');
  history.append('verification','A failing trial',{tests:'failed'},'context-a');
  history.checkout(analysis.id);
  const alternative=history.append('implementation','Another approach',{suggestionId:'two'},'context-a');
  assert.equal(alternative.parent,analysis.id);assert.notEqual(alternative.id,trial.id);
  assert.equal(history.state().nodes.length,5);
  assert.deepEqual(history.replay().map(n=>n.action),['results','analysis','implementation']);
  assert.doesNotMatch(JSON.stringify(history.replay()),/failed|"one"/);
  assert.equal(history.agentParent().id,'session-a');
  const restored=new WorkflowHistory('workspace-A',history.state());
  assert.equal(restored.get().id,alternative.id);assert.equal(restored.get(results.id).data.runId,'first');
});

test('saved history cannot import another workspace or fabricate a parent or cycle',()=>{
  const history=new WorkflowHistory('workspace-A');history.append('results','Measured run',{});
  assert.throws(()=>new WorkflowHistory('workspace-B',history.state()),/invalid/);
  const state=history.state();state.nodes[0].parent=state.nodes[0].id;
  assert.throws(()=>new WorkflowHistory('workspace-A',state),/invalid branch/);
  assert.throws(()=>history.checkout('foreign'),/checkpoint/);
  const copied=history.state();copied.nodes[0].data.changed=true;
  assert.equal(history.get().data.changed,undefined,'UI copies cannot mutate stored checkpoints.');
});
