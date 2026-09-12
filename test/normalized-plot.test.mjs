import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizedChart} from '../dist/normalized-plot.js';

test('shared overlay payload retains four curves, raw values and unavailable ratios',()=>{
  const data=['julia.wall.time','julia.gc.time','julia.alloc.bytes','julia.alloc.count'].flatMap(metric=>[
    {metric,version:'0.2.9',value:20,unit:'ns',ratio:2,normalization_status:'ratio'},
    {metric,version:'0.2.10',value:10,unit:'ns',ratio:1,normalization_status:'ratio'},
  ]);
  data[2].ratio=null;data[2].normalization_status='zero_reference';
  const content=normalizedChart({kind:'normalized_metrics',title:'Demo',description:'minimum < reference',
    options:{versions:['0.2.9','0.2.10'],reference_version:'minimum'},data},'overlay');
  assert.equal((content.match(/<path /g)||[]).length,4);
  assert.equal((content.match(/<circle /g)||[]).length,7);
  assert(content.includes('minimum &lt; reference'));
  assert(content.includes('20 ns; ratio 2'));
  assert(!content.includes('NaN')&&!content.includes('Infinity'));
});
