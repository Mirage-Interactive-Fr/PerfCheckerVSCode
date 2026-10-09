// Local authenticated replay through the installed VSIX and real Chat controls.
const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs/promises');
const path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {createHash}=require('node:crypto'),{pathToFileURL}=require('node:url');
const execute=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let suiteDeadline=Infinity;
async function eventually(read,label,timeout=210000){
  const until=Math.min(Date.now()+timeout,suiteDeadline);
  while(Date.now()<until){const value=await read();if(value)return value;await delay(100);}
  throw new Error(label);
}
async function packagedFiles(root){
  const files={};
  const visit=async relative=>{
    for(const item of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
      const file=path.join(relative,item.name);assert(!item.isSymbolicLink(),'Packaged runtime must not redirect to a development checkout');
      if(item.isDirectory())await visit(file);else files[file]=hash(await fs.readFile(path.join(root,file)));
    }
  };
  for(const directory of ['dist','media','resources'])await visit(directory);
  return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));
}
function loopbackServers(){
  // Observe only server handles. Never enumerate environment variables or read the MCP token.
  return process._getActiveHandles().filter(handle=>{
    if(typeof handle.address!=='function'||typeof handle.getConnections!=='function')return false;
    const address=handle.address();return address&&typeof address==='object'&&address.address==='127.0.0.1';
  });
}
async function processIdentity(pid){
  try{
    const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/);
    return fields[0]==='Z'?undefined:fields[19];
  }catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return undefined;throw error;}
}
async function requestProcesses(root){
  // Command lines are filtered in memory and never written to the result.
  const {stdout}=await execute('ps',['-eo','pid=,ppid=,args=']);
  const rows=stdout.split('\n').map(line=>{
    const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match?{pid:Number(match[1]),parent:Number(match[2]),command:match[3]}:undefined;
  }).filter(Boolean);
  const cli=rows.find(row=>row.parent===process.pid&&/perfchecker-chat-/.test(row.command)&&/--source=/.test(row.command));
  const worker=cli&&rows.find(row=>row.parent===cli.pid&&/advisor_worker\.jl/.test(row.command));
  const agent=rows.find(row=>row.parent===process.pid&&row.command.includes(root)&&/--no-daemon\s+exec/.test(row.command));
  const ids=new Set([cli?.pid,worker?.pid,agent?.pid].filter(Boolean));let previous;
  do{previous=ids.size;for(const row of rows)if(ids.has(row.parent))ids.add(row.pid);}while(previous!==ids.size);
  const identities=(await Promise.all([...ids].map(async pid=>({pid,parent:rows.find(row=>row.pid===pid).parent,start:await processIdentity(pid)})))).filter(item=>item.start);
  return {cli:cli?.pid,worker:worker?.pid,agent:agent?.pid,identities};
}

exports.run=async()=>{
  assert(!process.env.CI,'Never run authenticated model tests in CI');assert.equal(process.platform,'linux');
  const session=await fs.realpath(process.env.PERFCHECKER_HOST_SESSION),folder=vscode.workspace.workspaceFolders[0],root=await fs.realpath(folder.uri.fsPath);
  assert(path.basename(session).startsWith('perfchecker-codex-host-'));assert.equal(path.dirname(root),session);
  assert.equal(await fs.readFile(path.join(root,'.perfchecker-test-fixture'),'utf8'),'sacrificial\n');
  const checks=[],result={runner:'codex-vscode-host.cjs',hostExecuted:true,hostPid:process.pid,status:'running',checks};
  suiteDeadline=Date.now()+14*60*1000;result.maximumHostMinutes=14;
  // This sentinel must be written by the actual extension host, never by the outer SDK.
  await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result));
  const configFile=path.join(root,'perf','advisor.json'),settingsFile=path.join(root,'.vscode','settings.json');
  const relative='src/PerfCheckerNativeFixture.jl',sourceFile=path.join(root,relative);
  const saved=await fs.readFile(configFile),savedSettings=await fs.readFile(settingsFile),source=await fs.readFile(sourceFile,'utf8'),index=await fs.readFile(path.join(root,'.git','index'));
  const settings=()=>vscode.workspace.getConfiguration('perfchecker',folder.uri);
  const git=async(...args)=>(await execute('git',args,{cwd:root,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;
  const head=await git('rev-parse','HEAD'),state=()=>vscode.commands.executeCommand('perfchecker.chatState');
  let browser,view,endpoint,server,owned,primaryError,observer,observation;
  const observed=new Map();
  const observe=async()=>{
    if(observation)return observation;
    observation=(async()=>{
      let changed=false;const current=await requestProcesses(root);
      for(const item of current.identities)if(!observed.has(`${item.pid}:${item.start}`)){observed.set(`${item.pid}:${item.start}`,item);changed=true;}
      if(changed){result.observedProcesses=[...observed.values()];await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result));}
      return current;
    })();
    try{return await observation;}finally{observation=undefined;}
  };
  const preserved=async()=>{
    assert.equal(await fs.readFile(sourceFile,'utf8'),source);assert.deepEqual(await fs.readFile(configFile),saved);
    assert.deepEqual(await fs.readFile(settingsFile),savedSettings);assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);
    assert.equal(await git('rev-parse','HEAD'),head);assert.equal(await git('status','--porcelain'),'');
    assert.equal(settings().get('advisorEnabled'),false);assert.equal(settings().get('advisorImplementationMcpTool'),'previous_agent');
  };
  const findChat=()=>eventually(async()=>{
    for(const context of browser.contexts())for(const page of context.pages())for(const frame of page.frames()){
      if(!await frame.locator('#chat-root').isVisible().catch(()=>false))continue;
      let visible=true;
      for(let current=frame;current.parentFrame();current=current.parentFrame()){
        const owner=await current.frameElement();visible&&=await owner.isVisible();await owner.dispose();
      }
      if(visible)return frame;
    }
  },'Locate the visible installed Chat webview',30000);
  const click=name=>view.getByRole('button',{name,exact:true}).click();
  const idle=label=>eventually(async()=>!((await state()).busy),label);
  const noOwnedProcesses=()=>eventually(async()=>{
    for(const item of owned.identities)if(await processIdentity(item.pid)===item.start)return false;
    return true;
  },'All observed request-owned processes must stop before fixture cleanup',20000);
  try{
    result.vsixSha256=hash(await fs.readFile(process.env.PERFCHECKER_HOST_ARCHIVE));
    assert.equal(result.vsixSha256,'b899ea751d7baf1d99c150271721f935aa4591f6292dbf41f224b5bd2016664c');
    const extension=vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');assert(extension,'Load the installed product');
    const installed=await fs.realpath(extension.extensionPath);
    assert(installed.startsWith(path.join(session,'extensions')+path.sep),'The product must not come from the source checkout or human extension directory');
    assert.equal(extension.packageJSON.version,'1.0.1');assert.equal(vscode.version,'1.141.0');
    const expected=await packagedFiles(process.env.PERFCHECKER_HOST_ARCHIVE_EXTENSION),actual=await packagedFiles(installed);
    assert.deepEqual(actual,expected,'Every installed compiled module, media file and resource matches the SHA-verified archive');
    result.installedExtension={path:installed,version:extension.packageJSON.version,mainSha256:hash(await fs.readFile(path.resolve(installed,extension.packageJSON.main))),runtimeFiles:actual};
    await extension.activate();assert(extension.isActive);
    assert.equal(settings().get('runnerProject'),process.env.PERFCHECKER_TEST_CONTROLLER);
    assert.equal(settings().get('juliaExecutable'),process.env.PERFCHECKER_TEST_JULIA);
    result.core=JSON.parse(process.env.PERFCHECKER_HOST_CORE);assert.equal(result.core.tree,'309e12d55896cbe5b9aed2b07e39421793c7248f');assert.equal(result.core.version,'1.0.1');
    process.env.PERFCHECKER_CODEX_HOST_ONLY='1';
    const {probeJuliaCodexFixture}=await import(pathToFileURL(path.join(__dirname,'codex-real.test.mjs')).href);
    const probe=directory=>probeJuliaCodexFixture(directory,process.env.PERFCHECKER_TEST_JULIA);
    const baselineBytes=await probe(root);assert.equal(baselineBytes,Number(process.env.PERFCHECKER_HOST_BASELINE_BYTES));
    const {chromium}=await import(process.env.PERFCHECKER_TEST_PLAYWRIGHT?pathToFileURL(process.env.PERFCHECKER_TEST_PLAYWRIGHT).href:'playwright');
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PERFCHECKER_HOST_CDP_PORT}`);
    observer=setInterval(()=>{void observe().catch(error=>{result.observationError=String(error);});},200);
    await vscode.commands.executeCommand('perfchecker.openChat');view=await findChat();
    await view.locator('summary').filter({hasText:'Optional Codex CLI connector'}).click();
    const beforeServers=new Set(loopbackServers());await click('Connect Codex CLI');
    await eventually(async()=>Boolean((await state()).connection),'The actual Connect button authenticates the existing CLI',60000);
    const connected=await state();assert.match(connected.connection,/^codex-cli\s+\S+/);assert.equal(connected.implementation.tool,'implement_perfchecker');
    result.agent=connected.connection;
    server=await eventually(()=>{const added=loopbackServers().filter(handle=>!beforeServers.has(handle));assert(added.length<=1);return added[0];},'Observe the newly owned loopback listener',10000);
    endpoint=`http://127.0.0.1:${server.address().port}/mcp`;
    const unauthorized=await fetch(endpoint,{method:'POST',headers:{Connection:'close'},body:'{}',signal:AbortSignal.timeout(5000)});
    assert.equal(unauthorized.status,401);await unauthorized.arrayBuffer();await preserved();
    checks.push('installed b899 product path/version/runtime hashes; genuine Connect control; saved disabled provider unchanged; unauthenticated HTTP refused');

    const questions=[
      `Advice only, no tools, commands or file changes. This real Julia function allocated ${baselineBytes} bytes after warming on1000 Float64 inputs: ${source}. Explain removing its intermediate squared array and what remains unmeasured. When I later explicitly request implementation, modify ONLY ${relative}, preserve the module and @noinline API, create no other files, and use ONLY the existing Julia executable ${process.env.PERFCHECKER_TEST_JULIA} with --startup-file=no --history-file=no -e for checks. Never install packages or call external services.`,
      `Continue the same conversation: specify actual Julia checks for Float64[]==0.0, [1.0,-2.0,3.0]==14.0 and collect(1.0:1000.0)==333833500.0. The implementation should preserve those results and reduce warmed @allocated, without claiming speed improved. Advice only now: no tools, commands or edits. On the later explicit implementation request, change ONLY ${relative}, preserve module/@noinline, test those three cases with ${process.env.PERFCHECKER_TEST_JULIA} --startup-file=no --history-file=no -e, warm then measure1000 inputs. Create no files except that source edit.`
    ];
    const adviceCharacters=[];
    for(const [turn,question] of questions.entries()){
      await view.locator('#chat-question').fill(question);await click('Send question');
      const reply=await eventually(async()=>{const value=await state();return !value.busy&&value.messages.length===2*(turn+1)?value:undefined;},`Authenticated Julia advice turn ${turn+1} completes`);
      assert.deepEqual(reply.messages.map(message=>message.role),Array.from({length:turn+1},()=>['user','assistant']).flat());
      const answer=reply.messages.at(-1).content;assert(answer.length>10);adviceCharacters.push(answer.length);
      await eventually(async()=>await view.locator('.message.assistant').count()===turn+1,'The actual reply is visible');
      assert((await view.locator('.message.assistant').last().innerText()).includes(answer));await preserved();
    }
    checks.push('two authenticated contextual advice replies through Julia MCP are visible and preserve exact source/index/HEAD/config');
    await view.getByRole('tab',{name:'02 · Implementation',exact:true}).click();
    assert.match(await view.locator('.warning').innerText(),/Git checkpoint.*isolated copy.*diff review/);
    await click('I reviewed the advice · Prepare implementation');
    const proposed=await eventually(async()=>{const value=await state();return !value.busy&&value.proposal?.patch?value:undefined;},'Actual Prepare returns an isolated reviewed proposal');
    assert.deepEqual(proposed.proposal.files,[relative]);assert.equal(proposed.proposal.applied,false);assert.match(proposed.backupRef,/^refs\/perfchecker\/checkpoints\//);await preserved();
    // Read the installed backend's retained proposal; do not generate or apply a replacement patch.
    const {recoverActiveImplementationProposal}=require(path.join(installed,'dist','implementation.js'));
    const proposal=await recoverActiveImplementationProposal(root);assert(proposal);assert.equal(proposal.patch,proposed.proposal.patch);
    const candidate=path.join(session,'candidate-oracle');await fs.mkdir(path.join(candidate,'src'),{recursive:true});
    await fs.writeFile(path.join(candidate,relative),await git('show',`${proposal.candidate}:${relative}`));
    const candidateBytes=await probe(candidate);assert(candidateBytes<baselineBytes,'The real Julia candidate reduces measured allocations');
    await click('Open full diff');
    await eventually(()=>vscode.window.visibleTextEditors.some(editor=>editor.document.languageId==='diff'&&editor.document.getText()===proposal.patch),'The real native diff editor displays the entire collected patch',30000);
    await vscode.commands.executeCommand('perfchecker.openChat');view=await findChat();
    await click('Apply reviewed changes');await eventually(async()=>!((await state()).busy)&&(await state()).proposal?.applied,'Actual Apply completes');
    assert.notEqual(await fs.readFile(sourceFile,'utf8'),source);assert.equal(await probe(root),candidateBytes);
    assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);assert.equal(await git('rev-parse','HEAD'),head);
    await click('Restore previous code');await eventually(async()=>!((await state()).busy)&&!(await state()).proposal?.applied,'Actual Restore completes');
    assert.equal(await probe(root),baselineBytes);await preserved();
    checks.push('real Prepare/checkpoint/diff clicks; Julia empty/signed/range oracles and allocation reduction before Apply; actual Apply/Restore preserve staging/HEAD');

    await view.getByRole('tab',{name:'01 · Advice',exact:true}).click();
    await view.locator('#chat-question').fill('Advice only, no tools or edits. Give a detailed explanation of remaining floating-point correctness and benchmark uncertainty in this Julia optimization, including NaN/Infinity, signed zero, reduction order and stable allocation measurement.');
    await click('Send question');
    owned=await eventually(async()=>{
      const current=await observe();return (await state()).busy&&current.cli&&current.worker&&current.agent?current:undefined;
    },'Observe the actual Julia controller, detached advisor worker and authenticated Codex exec alive before Cancel',30000);
    assert(await view.getByRole('button',{name:'Disconnect Codex',exact:true}).isDisabled(),'The real Disconnect control requires the active request to be cancelled first');
    assert(await new Promise((resolve,reject)=>server.getConnections((error,count)=>error?reject(error):resolve(count>0))),'The Julia worker has an active real HTTP connection');
    await click('Cancel request');await idle('The actual Cancel waits for local worker cleanup');await noOwnedProcesses();
    assert.match((await state()).status,/cancelled after local worker cleanup.*remote server may still finish/i);
    assert.equal((await state()).messages.length,4,'The interrupted third request does not manufacture a reply');
    assert.match(await view.locator('#chat-root').innerText(),/remote server may still finish its work/i);
    await eventually(()=>new Promise((resolve,reject)=>server.getConnections((error,count)=>error?reject(error):resolve(count===0))),'Request socket closes before teardown',10000);
    await preserved();checks.push('actual Cancel with live authenticated exec + Julia controller/worker; exact owned identities dead and HTTP socket closed before fixture cleanup; remote caveat visible');
    await click('Disconnect Codex');await eventually(async()=>!((await state()).connection),'Actual Disconnect clears the session');
    assert.equal((await state()).implementation.tool,'previous_agent');
    assert.equal((await vscode.commands.executeCommand('perfchecker.codexConnectionState')).connected,false);
    assert.equal(server.listening,false);await assert.rejects(fetch(endpoint,{method:'POST',body:'{}',signal:AbortSignal.timeout(5000)}));await preserved();
    checks.push('actual Disconnect closes the listener and preserves original disabled configuration/file/tool');
    Object.assign(result,{status:'passed',adviceTurns:2,adviceCharacters,oracle:{empty:0,signed:14,range1000:333833500},
      allocationBaselineBytes:baselineBytes,allocationCandidateBytes:candidateBytes,changedFiles:proposal.files,
      ownedRequestPids:{cli:owned.cli,worker:owned.worker,codex:owned.agent},ownedDeadBeforeCleanup:true,socketClosedBeforeCleanup:true,
      remoteInferenceCancellation:'Not established; UI accurately preserves the remote-work caveat'});
  }catch(error){primaryError=error;Object.assign(result,{status:'failed',error:String(error),stack:error.stack});}
  finally{
    suiteDeadline=Date.now()+30000;
    // Failure cleanup uses the same owning controls and does not turn teardown into a PASS oracle.
    try{
      if(browser){view=await findChat();if((await state()).busy){await click('Cancel request');await idle('Failure cleanup finishes the owned request');}
        if((await state()).connection){await click('Disconnect Codex');await eventually(async()=>!((await state()).connection),'Failure cleanup disconnects the local connector');}}
    }catch(error){result.cleanupError=String(error);primaryError??=error;result.status='failed';}
    clearInterval(observer);
    try{await observation;await observe();}
    catch(error){result.observationError=String(error);primaryError??=error;result.status='failed';}
    try{
      const remaining=[];for(const record of observed.values())if(await processIdentity(record.pid)===record.start)remaining.push(record);
      if(remaining.length){
        primaryError??=new Error('Owned processes survived the real-control cleanup');result.status='failed';
        result.failureTeardownPids=remaining.map(record=>record.pid);
        const {stopObservedCodexProcesses}=await import(pathToFileURL(path.join(__dirname,'codex-real.test.mjs')).href);
        await stopObservedCodexProcesses([...observed.values()]);
      }
      for(const record of observed.values())assert.notEqual(await processIdentity(record.pid),record.start);
      result.cleanupSafeToRemove=true;
    }catch(error){result.processCleanupError=String(error);primaryError??=error;result.status='failed';result.cleanupSafeToRemove=false;}
    try{await browser?.close();}catch(error){result.browserCleanupError=String(error);primaryError??=error;result.status='failed';}
    await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result,null,2));
  }
  if(primaryError)throw primaryError;
};
