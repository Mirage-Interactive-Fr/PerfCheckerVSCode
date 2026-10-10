import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {flameModel, flameFramePath, flameGraph, profileGroups, flameViewportRange, flameViewportPercent, flameFunctionName, flameFunctionColor} from '../dist/flame-plot.js';

const observation=(stack,value,extra={})=>({case_id:'profile-case',target_id:'v1',metric:'julia.profile.samples',
  measurement_definition:'julia-profile-v1',unit:'1',value,attributes:{stack,...extra}});

test('explicit viewport bounds stay exact and display rounding stays separate',()=>{
  assert.deepEqual(flameViewportRange(.1,1),[.1,1],
    'Editing Start to 10 must not clamp it to 1-(1-.1)');
  assert.deepEqual(flameViewportRange(.1,.9),[.1,.9]);
  assert.deepEqual(flameViewportRange(.8,1),[.8,1]);
  assert.deepEqual(flameViewportRange(0,1),[0,1]);
  for(const end of [1e-100,Number.MIN_VALUE])assert.deepEqual(flameViewportRange(0,end),[0,1e-6],
    'Manual subnormal ranges retain the minimum span, preventing infinite SVG coordinates');
  for(const range of [[-.2,.3],[.7,1.2],[-1,2]]){
    const [from,to]=flameViewportRange(...range);
    assert(from>=0&&to<=1&&to>from);
    assert(Math.abs(to-from-Math.min(1,range[1]-range[0]))<Number.EPSILON*2);
  }
  for(const range of [[NaN,1],[0,Infinity],[.9,.1],[.1,.1]])assert.equal(flameViewportRange(...range),undefined);
  assert.equal(flameViewportPercent(.09999999999999998),'10');
  assert.equal(flameViewportPercent(.1),'10');assert.equal(flameViewportPercent(.9),'90');
  assert.equal(flameViewportPercent(.30000000000000004),'30');
  assert.equal(flameViewportPercent(1e-6),'0.0001');
  const range=flameViewportRange(.123456789012345,.9),saved=[...range];
  for(const bound of range)flameViewportPercent(bound);
  assert.deepEqual(range,saved,'Readable percentages never replace the numerical viewport bounds');
});

test('inclusive geometry preserves sibling shares and separate call paths',()=>{
  const rows=[observation(['entry','hot'],3),observation(['entry','cold'],1),observation(['other','hot'],1)];
  const saved=structuredClone(rows),model=flameModel(rows);
  assert.equal(model.totalWeight,5);assert.equal(model.frames.length,5);
  assert.deepEqual(model.frames.map(f=>[f.name,f.value,f.x0,f.x1,f.parent]),[
    ['entry',4,0,.8,null],['hot',3,0,.6,1],['cold',1,.6,.8,1],
    ['other',1,.8,1,null],['hot',1,.8,1,4],
  ]);
  assert.deepEqual(flameFramePath(model,2),['entry','hot']);
  assert.deepEqual(flameFramePath(model,5),['other','hot']);
  assert.deepEqual(rows,saved,'Rendering must leave original observations unchanged');
});

test('all thin frames and descendants survive beyond the former 1800-frame cap',()=>{
  const rows=[observation(['entry','large'],1e9),...Array.from({length:1805},(_,i)=>observation(['entry',`thin-${i}`],1))];
  const model=flameModel(rows),content=flameGraph(rows,'thin');
  assert.equal(model.frames.length,1807);
  assert.equal((content.match(/class="flame-node /g)||[]).length,1807);
  for(const frame of model.frames.filter(f=>f.name.startsWith('thin-'))){
    assert.equal(frame.value,1);assert(frame.x1>frame.x0);
    assert((frame.x1-frame.x0)*1000<.12,'These real-width fixture frames exercised the old rejection threshold');
    assert(Math.abs((frame.x1-frame.x0)-1/model.totalWeight)<Number.EPSILON*2);
  }
  assert.deepEqual(flameFramePath(model,1807),['entry','thin-1804']);
  assert(content.includes('max="1807"'));
  assert(!content.includes('View limited')&&!content.includes('NaN'));
});

test('deep stacks use iterative traversal and do not duplicate paths per frame',()=>{
  const stack=Array.from({length:5000},(_,i)=>`source.jl:${i+1} deep_call_${i}`),rows=[observation(stack,7)];
  const model=flameModel(rows);
  assert.equal(model.frames.length,5000);assert.equal(model.maximumDepth,4999);
  assert.deepEqual(flameFramePath(model,5000),stack);
  assert(model.frames.every(f=>f.value===7&&f.x0===0&&f.x1===1));
  assert(!('path' in model.frames[4999]),'Full paths are constructed on inspection, rather than copied quadratically');
  assert(JSON.stringify(model).length<2_000_000);
});

test('complete inference metadata and hostile source names remain safe and unchanged',()=>{
  const name='caller <script>alert("frame")</script> & source.jl:3';
  const rows=Array.from({length:7},(_,i)=>observation([name,'same'],1,{
    runtime_dispatch:[i===0,false],inference_status:['concrete','abstract'],
    gc_event:[false,i===1],inferred_return_type:[`Type${i}`,`Return${i}`],
  }));
  const before=structuredClone(rows),model=flameModel(rows),content=flameGraph(rows,'unsafe');
  assert.equal(model.frames[0].inferredTypes.length,7);assert.equal(model.frames[1].inferredTypes.length,7);
  assert(model.frames[0].dynamic);assert(model.frames[1].unstable&&model.frames[1].gc);
  assert.equal(flameFramePath(model,2)[0],name);
  assert(!content.includes('<script>alert'));assert(content.includes('&lt;script&gt;'));
  assert.deepEqual(rows,before);
});

test('only recorded any, union or abstract inference is a warning; unknown remains metadata',()=>{
  for(const status of [undefined,'','unknown','custom-status','concrete','any','union','abstract']){
    const rows=[observation(['entry'],2,status===undefined?{}:{inference_status:[status]})],saved=structuredClone(rows);
    const frame=flameModel(rows).frames[0];
    assert.equal(frame.unstable,['any','union','abstract'].includes(status),String(status));
    assert.deepEqual(frame.inferenceStatuses,status?[status]:[]);
    assert.equal(frame.value,2);assert.equal(frame.x0,0);assert.equal(frame.x1,1);
    assert.deepEqual(rows,saved);
  }
  const rows=['unknown','any','concrete','unknown'].map(status=>observation(['same'],1,{inference_status:[status]})),saved=structuredClone(rows);
  const frame=flameModel(rows).frames[0];
  assert(frame.unstable);assert.deepEqual(frame.inferenceStatuses,['any','concrete','unknown']);
  assert.equal(frame.value,4);assert.deepEqual(rows,saved);
});

test('function labels follow the Core source suffix and retain all other names verbatim',()=>{
  assert.equal(flameFunctionName('percolate_down! (src/heaps/arrays_as_heaps.jl:19)'),'percolate_down!');
  assert.equal(flameFunctionName('macro expansion (C:/work/source.jl:42)'),'macro expansion');
  assert.equal(flameFunctionName('operator (custom) (src/source.jl:7)'),'operator (custom)');
  for(const name of ['Other sampled allocation stacks','custom (text:4)','caller (source.jl:0)',
    'caller (source.jl:-1)','caller (source.jl:abc)','caller (path(with-parentheses).jl:2)',
    'caller (source.jl:2) trailing','unsafe <script>frame</script>'])assert.equal(flameFunctionName(name),name);
  const same=['percolate_down! (src/heaps/arrays_as_heaps.jl:19)','percolate_down! (changed/source.jl:201)'];
  assert.equal(flameFunctionColor(same[0]),flameFunctionColor(same[1]),'Source relocation and line changes keep the function color');
  const names=['pop!','heappop!','percolate_down!','BinaryHeap','heapify'];
  assert(new Set(names.map(flameFunctionColor)).size>1,'Real function names receive a varied palette');
  for(const name of names)assert.equal(flameFunctionColor(name),flameFunctionColor(name));
  assert.equal(flameFunctionColor('custom label'),flameFunctionColor('custom label'));
});

test('zero, negative and non-finite weights never acquire fake area',()=>{
  const rows=[observation(['zero'],0),observation(['negative'],-1),observation(['not finite'],NaN),observation(['infinite'],Infinity)];
  const before=structuredClone(rows),model=flameModel(rows),content=flameGraph(rows,'zero');
  assert.equal(model.totalWeight,0);assert.deepEqual(model.frames,[]);
  assert(!content.includes('<rect')&&!content.includes('<svg'));assert.deepEqual(rows,before);
  const overflow=flameGraph([observation(['one'],Number.MAX_VALUE),observation(['two'],Number.MAX_VALUE)],'overflow');
  assert(overflow.includes('numeric range'));assert(!overflow.includes('<svg'));
});

test('all profile and allocation groups remain available beyond group 24',t=>{
  const rows=Array.from({length:64},(_,i)=>Array.from({length:16},(_,j)=>({
    ...observation(['entry',`route-${Math.floor(j/4)}`,`source-${i}-${j}`],j+1),
    case_id:`case-${i}`,target_id:`commit-${i}`,metric:'julia.alloc.bytes',unit:'By',measurement_definition:'julia-profile-allocs-v1',
  }))).flat();
  const before=structuredClone(rows),start=performance.now();
  const flames=profileGroups(rows,'flame'),allocations=profileGroups(rows,'allocation');
  assert.equal(flames.size,64);assert.equal(allocations.size,64);
  const last=JSON.stringify(['case-63','commit-63','julia-profile-allocs-v1']);
  assert.equal(flames.get(last).length,16);assert.equal(allocations.get(last).at(-1).value,16);
  const content=[...flames.values()].map((group,i)=>flameGraph(group,`group-${i}`)).join('');
  assert.equal((content.match(/class="flame-view"/g)||[]).length,64);
  assert(content.includes('source-63-15'));
  const milliseconds=performance.now()-start;
  t.diagnostic(JSON.stringify({groups:64,observations:1024,frames:1344,bytes:Buffer.byteLength(content),milliseconds}));
  assert(Buffer.byteLength(content)<2_000_000);assert(milliseconds<10_000);
  assert.deepEqual(rows,before);
});
