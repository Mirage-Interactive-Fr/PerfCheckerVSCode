import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {compareVersions, comparisonsForRuns, filterRuns, logicalFeature, moveRun, outputsForRuns, parseGitReference, seriesForRuns} from '../dist/model.js';

const runs = [
  {id: 'a', package: 'Bib', feature: 'parse', backend: 'benchmark', version: '1.2.0', description: ''},
  {id: 'b', package: 'Bib', feature: 'render', backend: 'alloc', version: 'dev@1.10.0', description: ''},
  {id: 'c', package: 'Core', feature: 'parse', backend: 'benchmark', version: '1.10.0', description: ''},
];

test('semantic versions and dev order naturally', () => {
  assert.ok(compareVersions('1.10.0', '1.2.0') > 0);
  assert.ok(compareVersions('dev', '99.0.0') > 0);
  assert.ok(compareVersions('dev@1.10.0', '1.10.0') > 0);
  assert.ok(compareVersions('dev@1.10.0', '2.0.0') < 0);
});

const designerSource=readFileSync(new URL('../media/designer.js',import.meta.url),'utf8');
const designerCompare=runInNewContext(designerSource.slice(designerSource.indexOf('function compareVersion('),
  designerSource.indexOf('\nfunction visibleRuns('))+'\ncompareVersion');
const comparators={model:compareVersions,designer:designerCompare};

test('model and actual Designer consistently order numeric versions, opaque Git labels and dev',()=>{
  const expected=['dev@0.1.0','0.5.0','1.2.0','dev@1.2.0','1.10.0','4eec7f3','baseline','dev@fast-sort','dev'];
  for(const [name,compare] of Object.entries(comparators)){
    for(const a of expected)for(const b of expected){
      assert.equal(compare(a,b)>0,compare(b,a)<0,`${name}: antisymmetry ${a}, ${b}`);
      for(const c of expected)if(compare(a,b)<=0&&compare(b,c)<=0)
        assert(compare(a,c)<=0,`${name}: transitivity ${a} <= ${b} <= ${c}`);
    }
    assert.deepEqual([...expected].reverse().sort(compare),expected,name);
    const cycle=['dev@0.1.0','0.5.0','baseline'];
    for(const first of cycle)for(const second of cycle.filter(value=>value!==first)){
      const third=cycle.find(value=>value!==first&&value!==second);
      assert.deepEqual([first,second,third].sort(compare),cycle,`${name}: every original-cycle permutation`);
    }
  }
  for(const a of expected)for(const b of expected)
    assert.equal(Math.sign(compareVersions(a,b)),Math.sign(designerCompare(a,b)),`Model/Designer parity: ${a}, ${b}`);
});

test('numeric version grammar is anchored and retains prerelease, build, v and dev@ labels',()=>{
  const expected=['1','v1','dev@1','1.2','1.2.3-A','1.2.3-a','1.2.3-alpha.2','1.2.3-alpha.10','1.2.3-beta','1.2.3',
    '1.2.3+build.7','dev@1.2.3','1.2.4','1.2.x','4eec7f3','feature/1.2.3','dev'];
  for(const [name,compare] of Object.entries(comparators)){
    assert.deepEqual([...expected].reverse().sort(compare),expected,name);
    for(const a of expected)for(const b of expected)
      assert.equal(Math.sign(compare(a,b)),Math.sign(compareVersions(a,b)),`${name}: grammar parity ${a}, ${b}`);
  }
});

test('release bounds include equivalent v/build labels while keeping prerelease precedence',()=>{
  const versions=['1.2.3-A','1.2.3-a','1.2.3-rc.2','1.2.3','v1.2.3','1.2.3+build.7','1.2.4','4eec7f3','dev@1.2.3','dev'];
  const planned=versions.map((version,index)=>({...runs[0],id:String(index),version,
    target_kind:version==='4eec7f3'||version.startsWith('dev')?'git':'release'}));
  const actual=filterRuns(planned,{fromVersion:'1.2.3',toVersion:'1.2.3'}).map(run=>run.version);
  assert.deepEqual(actual,['1.2.3','v1.2.3','1.2.3+build.7','4eec7f3','dev@1.2.3','dev']);
  for(const [name,compare] of Object.entries(comparators)){
    for(const bound of ['1.2.3','v1.2.3','1.2.3+build.7'])
      for(const version of ['1.2.3','v1.2.3','1.2.3+build.7'])assert.equal(compare(version,bound,true),0,name);
    assert(compare('1.2.3-A','1.2.3-a',true)<0,name+': ASCII prerelease order');
    assert(compare('1.2.3-rc.2','1.2.3',true)<0,name+': prerelease precedes release');
    for(const a of versions)for(const b of versions)
      assert.equal(Math.sign(compare(a,b,true)),Math.sign(compareVersions(a,b,true)),name+': precedence parity');
  }
});

test('filters and sorts the common plan', () => {
  assert.deepEqual(filterRuns(runs, {features: ['parse'], sort: 'version'}).map(run => run.id), ['a', 'c']);
  assert.deepEqual(filterRuns(runs, {search: 'render'}).map(run => run.id), ['b']);
});

test('a workload filter retains its collectors while an exact leaf still isolates one', () => {
  const exports = [
    {id:'timing',package:'Bibliography',feature:'export_bibtex',workload:'export_bibtex',backend:'benchmark',version:'dev@0.4.0',description:''},
    {id:'allocations',package:'Bibliography',feature:'export_bibtex_allocations',workload:'export_bibtex',backend:'profile_alloc',version:'dev@0.4.0',description:''},
    {id:'cpu',package:'Bibliography',feature:'export_bibtex_profile',workload:'export_bibtex',backend:'profile',version:'dev@0.4.0',description:''},
  ];
  assert.deepEqual(filterRuns(exports,{features:['export_bibtex']}).map(run=>run.id),['timing','allocations','cpu']);
  assert.deepEqual(filterRuns(exports,{features:['export_bibtex'],backends:['profile_alloc']}).map(run=>run.id),['allocations']);
  assert.deepEqual(filterRuns(exports,{features:['export_bibtex_profile']}).map(run=>run.id),['cpu']);
});

test('drag ordering is stable', () => {
  assert.deepEqual(moveRun(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
});

test('Git comparison targets accept refs and pasted repository URLs', () => {
  assert.deepEqual(parseGitReference('refs/remotes/origin/feature/faster-parser'), {
    revision: 'refs/remotes/origin/feature/faster-parser', suggestedLabel: 'refs/remotes/origin/feature/faster-parser',
  });
  assert.deepEqual(parseGitReference('https://github.com/Mirage-Interactive-Fr/PerfChecker.jl/tree/feature/ui'), {
    revision: 'feature/ui', source: 'https://github.com/Mirage-Interactive-Fr/PerfChecker.jl.git',
    suggestedLabel: 'feature/ui',
  });
  assert.deepEqual(parseGitReference('Mirage-Interactive-Fr/PerfChecker.jl@v1.0.0'), {
    revision: 'v1.0.0', source: 'https://github.com/Mirage-Interactive-Fr/PerfChecker.jl.git',
    suggestedLabel: 'v1.0.0',
  });
  assert.equal(parseGitReference('0123456789abcdef0123456789abcdef01234567').suggestedLabel, '0123456789ab');
  assert.equal(parseGitReference('https://github.com/example/Example.jl/releases/tag/same').revision, 'refs/tags/same');
  assert.equal(parseGitReference('https://gitlab.com/group/Example.jl/-/tags/same').revision, 'refs/tags/same');
  assert.throws(() => parseGitReference('https://github.com/Mirage-Interactive-Fr/PerfChecker.jl'),
    /does not identify/);
});

test('measurement backends do not leak into the workload name', () => {
  assert.equal(logicalFeature({feature: 'import_bibtex_allocations', backend: 'profile_alloc'}), 'import_bibtex');
  assert.equal(logicalFeature({feature: 'import_bibtex_profile', backend: 'profile'}), 'import_bibtex');
  assert.equal(logicalFeature({feature: 'import_bibtex_wall_profile', backend: 'wall_profile'}), 'import_bibtex');
  assert.equal(logicalFeature({feature: 'read_and_filter', backend: 'benchmark'}), 'read_and_filter');
});

test('visual outputs follow the selected package, feature and version scope', () => {
  const planned = [{...runs[0], target_kind: 'release', comparison_key: 'parse/v1'}];
  const outputs = [
    {package: 'Bib', feature: 'parse', version: '1.2.0', target_kind: 'release', comparison_key: 'parse/v1'},
    {package: 'Bib', feature: 'parse', version: '1.3.0', target_kind: 'release', comparison_key: 'parse/v1'},
    {package: 'Core', feature: 'parse', version: '1.2.0', target_kind: 'release', comparison_key: 'parse/v1'},
  ];
  assert.deepEqual(outputsForRuns(outputs, planned), [outputs[0]]);

  const series = [
    {package: 'Bib', feature: 'parse'},
    {package: 'Bib', feature: 'render'},
    {package: 'Core', feature: 'parse'},
  ];
  assert.deepEqual(seriesForRuns(series, planned), [series[0]]);
  assert.deepEqual(comparisonsForRuns(series, planned), [series[0]]);
});
