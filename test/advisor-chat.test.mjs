import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareChatMessages, completeChatMessages, chatReply} from '../dist/advisorChatModel.js';

const response = text => ({schema_version:'perfchecker-narrative/1',status:'complete',authority:'unverified_narrative',reference_status:'unstructured_not_verified',cards:[],external_review:text});
test('chat retains whole recent exchanges and bounds both stored history and requests', () => {
  let history = [];
  for (let index=0; index<25; index++) {
    const request = prepareChatMessages(history, `Question ${index}`);
    assert.ok(request.messages.length<=21);
    history = completeChatMessages(request.messages, `Reply ${index}`).messages;
    assert.ok(history.length<=20);
  }
  assert.equal(history[0].content,'Question 15');
  assert.equal(history.at(-1).content,'Reply 24');
  history = [{role:'user',content:'a'.repeat(16000)},{role:'assistant',content:'b'.repeat(16000)}];
  const request = prepareChatMessages(history,'😀'.repeat(16000));
  assert.equal(request.omitted,2); assert.equal(request.messages.length,1);
  const completed = completeChatMessages(request.messages,'c'.repeat(16000));
  assert.equal(completed.messages.length,2);
  assert.equal(completed.messages.reduce((n,message)=>n+[...message.content].length,0),32000);
});
test('chat rejects malformed roles, empty or oversized questions and unverified contracts', () => {
  for (const input of [undefined, {}, '', '  ', '😀'.repeat(16001)]) assert.throws(()=>prepareChatMessages([],input),/question/);
  for (const history of [[{role:'user',content:'x'}],[{role:'assistant',content:'x'},{role:'user',content:'x'}],[{role:'user',content:''},{role:'assistant',content:'x'}]]) assert.throws(()=>prepareChatMessages(history,'next'),/history/);
  assert.equal(chatReply(response('<script>plain text only</script>')),'<script>plain text only</script>');
  for (const input of [{...response('x'),authority:'verified'}, {...response('x'),reference_status:'verified'}, {...response('x'),external_review:{}},response('x'.repeat(16001)), {...response('x'),schema_version:'perfchecker-narrative/2'}]) assert.throws(()=>chatReply(input));
  assert.throws(()=>chatReply({...response('x'),status:'unavailable',message:'tool missing'}),/tool missing/);
});

test('chat displays the actual global timeout and preserves the original diagnostic', () => {
  assert.throws(()=>chatReply({...response('x'),status:'timeout',message:'isolated worker stopped'},180),
    /Global request timed out after 180 seconds \(including worker startup\). PerfChecker did not apply changes to your project. Details: isolated worker stopped/);
  assert.throws(()=>chatReply({...response('x'),status:'timeout',message:'isolated worker stopped'}),
    /Global request timed out \(including worker startup\).*isolated worker stopped/);
});
