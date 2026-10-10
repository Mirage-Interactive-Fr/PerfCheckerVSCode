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

test('overlay follows the declared version order, preserves gaps and bounds only visible ratios',()=>{
  const chart=normalizedChart({description:'Selection',options:{versions:['v1','v2','v3'],reference_version:'minimum'},data:[
    {version:'outside',metric:'time',ratio:1e100},
    {version:'v3',metric:'time',ratio:2,value:20,unit:'ns',normalization_status:'ratio'},
    {version:'v1',metric:'time',ratio:1,value:10,unit:'ns',normalization_status:'ratio'},
    {version:'v2',metric:'time',ratio:null,normalization_status:'zero_reference'},
    {version:'v1',metric:'bytes',ratio:-1,normalization_status:'invalid'},
    {version:'v2',metric:'bytes',ratio:Infinity,normalization_status:'invalid'},
  ]},'selection');
  assert.equal((chart.match(/class="hover-value"/g)||[]).length,2);
  assert.equal((chart.match(/<path /g)||[]).length,2);
  assert.match(chart,/Unavailable ratios: v2 · time: zero_reference/);
  assert.match(chart,/Gaps are preserved/);
  assert.doesNotMatch(chart,/NaN|Infinity|style=/);
  assert.match(chart,/cx="55"/);
  assert.match(chart,/cx="875"/);
  assert.ok(chart.indexOf('v1 · time') < chart.indexOf('v3 · time'));
  assert.doesNotMatch(chart,/1e\+100/);
});

test('one measured version is centered before client interaction',()=>{
  const chart=normalizedChart({description:'One measurement',options:{versions:['only'],reference_version:'minimum'},data:[
    {version:'only',metric:'time',ratio:1,value:10,unit:'ns',normalization_status:'ratio'},
  ]},'single');
  assert.match(chart,/<circle[^>]*cx="465"/);
  assert.match(chart,/<text x="465" y="310"/);
  assert.doesNotMatch(chart,/NaN|Infinity/);
});
