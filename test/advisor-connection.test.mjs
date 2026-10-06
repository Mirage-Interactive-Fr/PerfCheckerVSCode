import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url), original=Module._load;
const saved={advisorConfig:'advisor.json',advisorImplementationMcpTool:'previous_agent'};
const settings={get:(key,fallback)=>saved[key]??fallback,update:()=>{throw new Error('A temporary connection must not update saved settings.');}};
const vscode={workspace:{getConfiguration:()=>settings,isTrusted:true}};
Module._load=function(name,...args){return name==='vscode'?vscode:original.call(this,name,...args);};
let readAdvisorConfiguration,AdvisorSetup,AdvisorChat;
try{({readAdvisorConfiguration,AdvisorSetup}=require('../dist/advisorSetup.js'));({AdvisorChat}=require('../dist/advisorChat.js'));}finally{Module._load=original;}
const {setLocalAdvisorConnection,localAdvisorConnection}=require('../dist/advisorConnection.js');

test('explicit local connection overrides a saved file in memory and restores it byte for byte',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-connection-')), key=`file://${root}`;
  const folder={name:'fixture',uri:{fsPath:root,toString:()=>key}};
  vscode.workspace.workspaceFolders=[folder];
  const bytes=JSON.stringify({protocol:'mcp_http',endpoint:'https://previous.example.test/mcp',mcp_tool:'previous_advice'})+'\n';
  await writeFile(path.join(root,'advisor.json'),bytes);
  try{
    assert.equal((await readAdvisorConfiguration(folder)).mcp_tool,'previous_advice');
    setLocalAdvisorConnection(key,{label:'local Codex',config:{protocol:'mcp_http',endpoint:'http://127.0.0.1:1/mcp',mcp_tool:'ask_perfchecker'},
      implementation:{tool:'implement_perfchecker',promptArgument:'prompt',workspaceArgument:'workspace'}});
    const config=await readAdvisorConfiguration(folder);assert.equal(config.mcp_tool,'ask_perfchecker');
    config.mcp_tool='tampered';assert.equal(localAdvisorConnection(key).config.mcp_tool,'ask_perfchecker');
    const setup=new AdvisorSetup({});setup.folder=()=>folder;
    await assert.rejects(setup.action({action:'save',config}),/must not be saved/);
    const chat=new AdvisorChat({},()=>[],async()=>{});chat.folder=()=>folder;
    assert.equal(chat.state().implementation.tool,'implement_perfchecker');
    await assert.rejects(chat.saveImplementationSettings({tool:'other'}),/Disconnect/);
    assert.equal(await readFile(path.join(root,'advisor.json'),'utf8'),bytes);
    setLocalAdvisorConnection(key);
    assert.equal((await readAdvisorConfiguration(folder)).mcp_tool,'previous_advice');
    assert.equal(chat.state().implementation.tool,'previous_agent');
    assert.equal(await readFile(path.join(root,'advisor.json'),'utf8'),bytes);
  }finally{setLocalAdvisorConnection(key);await rm(root,{recursive:true,force:true});}
});
