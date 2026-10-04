import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Module=require('node:module');
const folder=name=>({name,uri:{scheme:'file',fsPath:`/tmp/${name}`,toString:()=>`file:///tmp/${name}`}});
const a=folder('chat-state-A'),b=folder('chat-state-B');
const vscode={workspace:{workspaceFolders:[a,b],getConfiguration:()=>({get:(_name,fallback)=>fallback})}};
const original=Module._load;
Module._load=function(name,...args){if(name==='vscode')return vscode;return original.call(this,name,...args);};
let AdvisorChat;
try {({AdvisorChat}=require('../dist/advisorChat.js'));}finally{Module._load=original;}
const {selectWorkspaceFolder}=require('../dist/workspace-root.js');
test('new conversation clears text/evidence while preserving reviewed proposal and Git recovery',()=>{
  selectWorkspaceFolder(vscode.workspace.workspaceFolders,a);
  const chat=new AdvisorChat({workspaceState:{get:()=>undefined,update:()=>Promise.resolve()}},()=>[],async()=>{});
  chat.state();chat.messages=[{role:'user',content:'old'},{role:'assistant',content:'advice'}];
  const proposal={patch:'reviewed diff',files:['source.jl'],applied:true,backupRef:'refs/perfchecker/checkpoints/test'};
  chat.proposal=proposal;chat.implementationSummary='original implementation summary';chat.backupRef=proposal.backupRef;
  chat.clear();const state=chat.state();
  assert.deepEqual(state.messages,[]);assert.equal(chat.proposal,proposal);assert.equal(state.proposal.applied,true);
  assert.equal(state.backupRef,proposal.backupRef);assert.equal(state.implementationSummary,'original implementation summary');
});
test('folder switches always invalidate the recovery marker, including a return to the same folder',()=>{
  selectWorkspaceFolder(vscode.workspace.workspaceFolders,a);
  const chat=new AdvisorChat({workspaceState:{get:()=>undefined,update:()=>Promise.resolve()}},()=>[],async()=>{});
  chat.state();chat.recoveredWorkspace=a.uri.toString();
  selectWorkspaceFolder(vscode.workspace.workspaceFolders,b);chat.state();assert.equal(chat.recoveredWorkspace,undefined);
  selectWorkspaceFolder(vscode.workspace.workspaceFolders,a);chat.state();assert.equal(chat.recoveredWorkspace,undefined);
});
