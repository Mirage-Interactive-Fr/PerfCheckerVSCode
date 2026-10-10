import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {controllerPreflightScript,parseControllerImportReceipt,controllerInspectionFailure} from './native-controller-preflight.mjs';

const project=path.resolve('controller','Project.toml'),coreRoot=path.resolve('packages','PerfChecker','Δ'),httpRoot=path.resolve('packages','HTTP','abc');
const hex=value=>Buffer.from(value).toString('hex'),tree='a'.repeat(40),httpTree='b'.repeat(40);
const fields=['CONTROLLER_IMPORT_RECEIPT_V1','175.935475','HTTPAdvisorExt',hex(project),
  'PerfChecker','1.0.1',hex(coreRoot),hex(path.join(coreRoot,'src','PerfChecker.jl')),tree,tree,
  'HTTP','2.9.0',hex(httpRoot),hex(path.join(httpRoot,'src','HTTP.jl')),httpTree,httpTree];
const parse=value=>parseControllerImportReceipt(value,{project,version:'1.0.1',tree});
test('primitive preflight receipt preserves real import time, Unicode paths and both pinned source trees',()=>{
  const value=parse(`CONTROLLER_IMPORT_AFTER HTTP elapsed=175.935475\n${fields.join('\t')}\n`);
  assert.equal(value.elapsedSeconds,175.935475);assert.equal(value.packages[0].root,coreRoot);
  assert.equal(value.packages[1].tree,httpTree);assert.equal(value.activeProject,project);
  assert(!controllerPreflightScript.includes('JSON.print'));assert(controllerPreflightScript.includes('Pkg.GitTools.tree_hash(root)'));
});
test('missing, duplicate, truncated, malformed and mismatched identities fail closed',()=>{
  assert.throws(()=>parse('CONTROLLER_IMPORT_RECEIPT '));
  assert.throws(()=>parse(`${fields.join('\t')}\n${fields.join('\t')}`));
  assert.throws(()=>parse(fields.slice(0,-1).join('\t')));
  for(const [index,value]of [[0,'CONTROLLER_IMPORT_RECEIPT_V2'],[1,'Infinity'],[1,'-1'],[2,'MissingExt'],
    [3,hex(path.resolve('different','Project.toml'))],[5,'1.0.0'],[6,'ff'],[6,'0'],[6,hex('relative')],
    [7,hex(path.join(httpRoot,'src','HTTP.jl'))],[8,'c'.repeat(40)],[10,'Other'],[15,'c'.repeat(40)]]){
    const changed=[...fields];changed[index]=value;assert.throws(()=>parse(changed.join('\t')),`Reject field ${index}: ${value}`);
  }
});
test('failed inspection preserves target, timing and subprocess cause without weakening qualification',()=>{
  const error=Object.assign(new Error('Process survey failed'),{code:1,signal:'SIGTERM',killed:true,stderr:'x'.repeat(4500),stdout:'not requested'});
  const value=controllerInspectionFailure(error,{stage:'survey',pid:123,ownerPid:456});
  assert.equal(value.pid,123);assert.equal(value.ownerPid,456);assert.equal(value.code,1);assert.equal(value.signal,'SIGTERM');
  assert.equal(value.killed,true);assert.equal(value.stderr.length,4000);assert(Number.isFinite(Date.parse(value.observedAt)));
  assert(!('stdout'in value));assert(!('command'in value));assert.equal(controllerInspectionFailure(new Error('unknown'),{stage:'inspect',pid:2,ownerPid:1}).code,null);
});
