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
  const agent=rows.find(row=>{
    if(row.parent!==process.pid||!/--no-daemon\s+exec/.test(row.command))return false;
    const cwd=row.command.match(/(?:^|\s)-C\s+(\S+)/)?.[1];
    return cwd===root||(cwd&&path.basename(cwd)==='checkout'&&
      path.dirname(path.dirname(cwd))===require('node:os').tmpdir()&&path.basename(path.dirname(cwd)).startsWith('perfchecker-implementation-'));
  });
  const ids=new Set([cli?.pid,worker?.pid,agent?.pid].filter(Boolean));let previous;
  do{previous=ids.size;for(const row of rows)if(ids.has(row.parent))ids.add(row.pid);}while(previous!==ids.size);
  const identities=(await Promise.all([...ids].map(async pid=>({pid,parent:rows.find(row=>row.pid===pid).parent,start:await processIdentity(pid)})))).filter(item=>item.start);
  const states=await Promise.all(identities.map(async identity=>{
    try{
      const raw=await fs.readFile(`/proc/${identity.pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(') ')+2).trim().split(/\s+/);
      if(fields[19]!==identity.start)return {...identity,observation:'incarnation-changed'};
      const executable=path.basename(await fs.readlink(`/proc/${identity.pid}/exe`));
      return {...identity,currentParent:Number(fields[1]),state:fields[0],executable:executable.slice(0,100)};
    }catch(error){return {...identity,observation:['ENOENT','ESRCH'].includes(error.code)?'exited-during-observation':'unknown',errorCode:error.code??error.name};}
  }));
  return {cli:cli?.pid,worker:worker?.pid,agent:agent?.pid,identities,states};
}

exports.run=async()=>{
  assert(!process.env.CI,'Never run authenticated model tests in CI');assert.equal(process.platform,'linux');
  const session=await fs.realpath(process.env.PERFCHECKER_HOST_SESSION),folder=vscode.workspace.workspaceFolders[0],root=await fs.realpath(folder.uri.fsPath);
  assert(path.basename(session).startsWith('perfchecker-codex-host-'));assert.equal(path.dirname(root),session);
  assert.equal(await fs.readFile(path.join(root,'.perfchecker-test-fixture'),'utf8'),'sacrificial\n');
  const checks=[],result={runner:'codex-vscode-host.cjs',hostExecuted:true,hostPid:process.pid,status:'running',checks};
  const bibliography=process.env.PERFCHECKER_HOST_BIBLIOGRAPHY?JSON.parse(process.env.PERFCHECKER_HOST_BIBLIOGRAPHY):undefined;
  suiteDeadline=Date.now()+(bibliography?21:14)*60*1000;result.maximumHostMinutes=bibliography?21:14;
  // This sentinel must be written by the actual extension host, never by the outer SDK.
  await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result));
  const configFile=path.join(root,'perf','advisor.json'),settingsFile=path.join(root,'.vscode','settings.json');
  const relative=bibliography?'src/bibtex.jl':'src/PerfCheckerNativeFixture.jl',sourceFile=path.join(root,relative);
  const saved=await fs.readFile(configFile),savedSettings=await fs.readFile(settingsFile),source=await fs.readFile(sourceFile,'utf8'),index=await fs.readFile(path.join(root,'.git','index'));
  const settings=()=>vscode.workspace.getConfiguration('perfchecker',folder.uri);
  const git=async(...args)=>(await execute('git',args,{cwd:root,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;
  const head=await git('rev-parse','HEAD'),state=()=>vscode.commands.executeCommand('perfchecker.chatState');
  let browser,view,endpoint,server,owned,primaryError,observer,observation;
  const observed=new Map(),cliObservers=new Map(),processStates=new Map();let passiveCli;
  const observe=async()=>{
    if(observation)return observation;
    observation=(async()=>{
      let changed=false;const current=await requestProcesses(root);
      for(const item of current.identities)if(!observed.has(`${item.pid}:${item.start}`)){observed.set(`${item.pid}:${item.start}`,item);changed=true;}
      if(passiveCli&&current.agent){
        const identity=current.identities.find(item=>item.pid===current.agent),key=identity&&`${identity.pid}:${identity.start}`;
        if(identity&&!cliObservers.has(key)){
          const child=process._getActiveHandles().find(value=>value instanceof require('node:child_process').ChildProcess&&value.pid===identity.pid);
          if(child?.stdout&&await processIdentity(identity.pid)===identity.start){
            result.cliEvents??=[];
            cliObservers.set(key,passiveCli(child.stdout,identity,value=>{
              if(result.cliEvents.length<2000)result.cliEvents.push(value);else result.cliEventsUnknown='observation-budget';
            }));
          }
        }
      }
      result.processTimeline??=[];
      for(const row of current.states){const key=`${row.pid}:${row.start}`,signature=JSON.stringify(row),prior=processStates.get(key),now=Date.now();
        if(prior?.signature!==signature){processStates.set(key,{signature,firstSeen:prior?.firstSeen??now,identity:row,live:true});changed=true;
          if(result.processTimeline.length<2000)result.processTimeline.push({observedAt:new Date(now).toISOString(),observedDurationMs:now-(prior?.firstSeen??now),...row});
          else result.processTimelineUnknown='observation-budget';
        }
      }
      const currentKeys=new Set(current.identities.map(row=>`${row.pid}:${row.start}`));
      for(const [key,prior]of processStates)if(prior.live&&!currentKeys.has(key)&&await processIdentity(prior.identity.pid)!==prior.identity.start){
        prior.live=false;changed=true;const now=Date.now();
        if(result.processTimeline.length<2000)result.processTimeline.push({pid:prior.identity.pid,start:prior.identity.start,
          observation:'proved-gone',observedAt:new Date(now).toISOString(),observedDurationMs:now-prior.firstSeen});
        else result.processTimelineUnknown='observation-budget';
      }
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
  const findView=selector=>eventually(async()=>{
    for(const context of browser.contexts())for(const page of context.pages())for(const frame of page.frames()){
      if(!await frame.locator(selector).isVisible().catch(()=>false))continue;
      let visible=true;
      for(let current=frame;current.parentFrame();current=current.parentFrame()){
        const owner=await current.frameElement();visible&&=await owner.isVisible();await owner.dispose();
      }
      if(visible)return frame;
    }
  },`Locate the visible installed webview ${selector}`,30000);
  const findChat=()=>findView('#chat-root');
  const click=name=>view.getByRole('button',{name,exact:true}).click();
  const openConnector=async()=>{
    const summary=view.locator('summary').filter({hasText:'Optional Codex CLI connector'});
    assert.equal(await summary.count(),1);
    const before=await summary.evaluate(node=>node.closest('details').open);
    if(!before)await summary.click();
    assert(await summary.evaluate(node=>node.closest('details').open),'The real connector details are open');
    return {before,after:true};
  };
  const idle=label=>eventually(async()=>!((await state()).busy),label);
  const noOwnedProcesses=()=>eventually(async()=>{
    for(const item of owned.identities)if(await processIdentity(item.pid)===item.start)return false;
    return true;
  },'All observed request-owned processes must stop before fixture cleanup',20000);
  const proofs=process.env.PERFCHECKER_HOST_PROOFS;
  const capture=async(name,timeout=30000)=>{if(proofs){await fs.mkdir(proofs,{recursive:true});await view.page().screenshot({path:path.join(proofs,`${name}.png`),timeout});}};
  const captureAdvice=async turn=>{
    if(!proofs)return;
    await view.locator('.hero').scrollIntoViewIfNeeded();await capture(`advice-${turn}-context`);
    const transcript=view.locator('.transcript'),reply=view.locator('.message.assistant').last();
    await transcript.scrollIntoViewIfNeeded();await transcript.hover();
    const geometry=()=>reply.evaluate(node=>{
      const area=node.closest('.transcript'),a=area.getBoundingClientRect(),r=node.getBoundingClientRect();
      const visibleTop=Math.max(0,a.top),visibleBottom=Math.min(innerHeight,a.bottom);
      return {height:r.height,replyTop:r.top,offset:r.top-a.top,scrollTop:area.scrollTop,clientHeight:area.clientHeight,viewportHeight:innerHeight,
        visibleTop,visibleBottom,visibleHeight:visibleBottom-visibleTop,start:Math.max(0,visibleTop-r.top),end:Math.min(r.height,visibleBottom-r.top),
        fontSize:getComputedStyle(node).fontSize,devicePixelRatio,pixelFontSize:parseFloat(getComputedStyle(node).fontSize)*devicePixelRatio};
    });
    const initial=await geometry(),record={turn,initial,parts:[],complete:false,source:'actual native transcript wheel scrolling; no CSS or message changes'};
    result.adviceCaptures??=[];result.adviceCaptures.push(record);
    assert(initial.pixelFontSize>=22&&initial.pixelFontSize<=24,'The actual native zoom renders reply text at 22–24 screenshot pixels');
    // A long user message can leave the assistant BELOW the viewport. Scroll
    // toward its beginning in either direction, using the real wheel only.
    const delta=initial.replyTop-initial.visibleTop-2;
    if(Math.abs(delta)>2)await view.page().mouse.wheel(0,delta);
    await eventually(async()=>{const g=await geometry();return g.start<5&&g.end>0&&(g.replyTop<=g.visibleTop+5||g.end>=g.height-2);},
      'The real transcript scroll exposes the reply beginning at the visible top, or the entire short reply',5000);
    const parts=record.parts;
    for(let part=1;part<=8;part++){
      const g=await geometry();assert(g.visibleHeight>0,'The actual transcript intersects the viewport');
      if(parts.length)assert(g.start<=parts.at(-1).end+2,'Consecutive native captures retain overlapping reply text');
      await capture(part===1?`advice-${turn}`:`advice-${turn}-part-${part}`);parts.push(g);
      if(g.end>=g.height-2)break;
      await transcript.hover();await view.page().mouse.wheel(0,g.visibleHeight*.85);
      await eventually(async()=>(await geometry()).scrollTop>g.scrollTop,'The native transcript advances for the next readable reply section',5000);
    }
    const complete=parts[0].start<5&&parts.at(-1).end>=parts.at(-1).height-2;
    record.complete=complete;
    assert(complete,'The complete real advice reply is visible across the retained native scroll captures');
  };
  const presentation=async(stage,read)=>{
    try{await read();}catch(error){
      // A failed presentation capture remains a global FAIL, but cannot
      // prevent independent implementation/correctness/Apply/Restore checks.
      result.captureFailures??=[];const failure={stage,name:error.name,message:String(error.message).slice(0,4000)};
      result.captureFailures.push(failure);
      try{await capture(`${stage}-capture-failed`,5000);}catch(snapshotError){failure.captureError=String(snapshotError.message).slice(0,1000);}
      await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result,null,2));
    }
  };
  // Retain the actual user-visible outcome before teardown, without provider
  // configuration, tool arguments, token-bearing environment or full source.
  const chatOutcome=value=>({busy:Boolean(value.busy),status:String(value.status??'').slice(0,4000),
    backupRef:value.backupRef,connected:Boolean(value.connection),
    proposal:value.proposal?{files:value.proposal.files,patchBytes:Buffer.byteLength(value.proposal.patch??''),applied:value.proposal.applied}:undefined,
    implementationSummary:String(value.implementationSummary??'').slice(0,16000)});
  const preserveWorker=async(name,directory)=>{if(proofs){const target=path.join(proofs,name);await fs.mkdir(target,{recursive:true});
    for(const file of ['Project.toml','Manifest.toml'])await fs.copyFile(path.join(directory,'perf','episode-05a','worker',file),path.join(target,file));}};
  try{
    result.vsixSha256=hash(await fs.readFile(process.env.PERFCHECKER_HOST_ARCHIVE));
    assert.equal(result.vsixSha256,'fac983a008dfc57b0b4a8cd422126a38432df7284d1fb7423ac260dfb62b6301');
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
    result.core=JSON.parse(process.env.PERFCHECKER_HOST_CORE);assert.equal(result.core.tree,'00c133336911b8600d63a8d6c59ce1befc5ce690');assert.equal(result.core.version,'1.0.1');
    if(bibliography)assert.equal(result.core.registered,true);
    const directories=JSON.parse(process.env.PERFCHECKER_HOST_PRIVATE_DIRECTORIES);
    assert.deepEqual(directories.map(([flag])=>flag),['user-data-dir','extensions-dir','shared-data-dir','agent-plugins-dir','agents-user-data-dir','agents-extensions-dir']);
    for(const [,directory]of directories){assert.equal(await fs.realpath(directory),directory);assert(directory.startsWith(session+path.sep));}
    assert.equal(new Set(directories.map(([,directory])=>directory)).size,6);result.privateCodeDirectories=directories;
    assert.equal(settings().get('advisorTimeout'),bibliography?600:180);result.configuredAdvisorTimeoutSeconds=settings().get('advisorTimeout');
    process.env.PERFCHECKER_CODEX_HOST_ONLY='1';
    const {probeJuliaCodexFixture,probeBibliographyCodexFixture,observeCodexEvents}=await import(pathToFileURL(path.join(__dirname,'codex-real.test.mjs')).href);
    passiveCli=observeCodexEvents;
    const probe=directory=>bibliography?probeBibliographyCodexFixture(directory,process.env.PERFCHECKER_TEST_JULIA,{prepare:true}):probeJuliaCodexFixture(directory,process.env.PERFCHECKER_TEST_JULIA);
    const baselineProbe=await probe(root),baselineBytes=bibliography?baselineProbe.allocationBytes:baselineProbe;
    assert.equal(baselineBytes,Number(process.env.PERFCHECKER_HOST_BASELINE_BYTES));
    if(bibliography)assert.deepEqual(baselineProbe,bibliography);
    if(bibliography)await preserveWorker('baseline-worker',root);
    const {chromium}=await import(process.env.PERFCHECKER_TEST_PLAYWRIGHT?pathToFileURL(process.env.PERFCHECKER_TEST_PLAYWRIGHT).href:'playwright');
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PERFCHECKER_HOST_CDP_PORT}`);
    if(bibliography){
      const windowPage=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('workbench'));
      assert(windowPage,'Find only the private host workbench');
      const commands=await vscode.commands.getCommands(true);
      for(const command of ['workbench.action.closeAuxiliaryBar','workbench.action.closeSidebar']){
        assert(commands.includes(command));await vscode.commands.executeCommand(command);
      }
      await eventually(async()=>!await windowPage.locator('[id="workbench.parts.auxiliarybar"]').isVisible()&&
        !await windowPage.locator('[id="workbench.parts.sidebar"]').isVisible(),'Native close actions hide the private side bars',5000);
      result.captureLayout={sideBarsClosed:true,nativeCommands:['workbench.action.closeAuxiliaryBar','workbench.action.closeSidebar']};
    }
    observer=setInterval(()=>{void observe().catch(error=>{result.observationError=String(error);});},200);
    const measureBibliography=async label=>{
      const reports=path.join(root,'perf','results','investigations'),receipts=[];
      await fs.mkdir(reports,{recursive:true});
      const beforeSettings=await fs.readFile(settingsFile),beforeConfig=JSON.parse(beforeSettings);
      const priorSamples=settings().get('scenarioSamples'),priorCatalog=settings().get('scenarioCatalog');
      try{
        for(const [id,samples,collectors,catalog]of [['episode05-export-bibtex-timing',100,['benchmark','chairmark'],'timing'],['episode05-export-bibtex-allocation',3,['profile_alloc'],'allocation']]){
          await settings().update('scenarioSamples',samples,vscode.ConfigurationTarget.WorkspaceFolder);
          await settings().update('scenarioCatalog',`perf/episode-05a/${catalog}/scenarios.toml`,vscode.ConfigurationTarget.WorkspaceFolder);
          await vscode.commands.executeCommand('perfchecker.discoverScenarios');
          const investigation=await findView('nav[aria-label="Investigation views"]');
          await investigation.getByRole('button',{name:'Scenarios',exact:true}).click();
          await investigation.getByRole('button',{name:'Clear selection',exact:true}).click();
          await eventually(async()=>await investigation.locator('.scenario-title input:checked').count()===0,
            'The actual Clear selection control removes every previous scenario selection',10000);
          await investigation.locator('.scenario-title').filter({hasText:id}).getByRole('checkbox').check();
          const before=new Set(await fs.readdir(reports));
          await investigation.getByRole('button',{name:'Measure selected',exact:true}).click();
          const receipt=await eventually(async()=>{
            for(const name of await fs.readdir(reports))if(!before.has(name)){
              const file=path.join(reports,name,'run.json'),advice=path.join(reports,name,'advice','advice.json');
              try{const report=JSON.parse(await fs.readFile(file,'utf8'));await fs.access(advice);
                if(!await investigation.locator('.status.busy').count())return {id:name,directory:path.dirname(file),report};
              }catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
            }
          },`The actual ${label} ${id} measurements and advice finish`,300000);
          assert.deepEqual(receipt.report.runs.map(run=>run.collector).sort(),[...collectors].sort());
          for(const run of receipt.report.runs){assert.equal(run.scenario.id,id);assert.equal(run.scenario.implementation,'local-checkout');
            assert.equal(run.qualification.correctness,'passed');assert.equal(run.qualification.availability,'complete');
            if(run.collector!=='profile_alloc')assert.equal(run.summaries.find(summary=>summary.metric==='julia.wall.time').samples,100);
            else assert.equal(run.profile.allocation_profile.profile_evaluations,3);
          }
          if(proofs){const retained=path.join(proofs,`${label}-measurements`,receipt.id);await fs.cp(receipt.directory,retained,{recursive:true});receipt.retainedDirectory=retained;}
          receipts.push(receipt);
        }
      }finally{
        // Only these two setup keys are intentional. Reject any other write
        // before restoring formatting, so restoration cannot hide agent edits.
        const currentConfig=JSON.parse(await fs.readFile(settingsFile,'utf8'));
        for(const object of [beforeConfig,currentConfig])for(const key of ['perfchecker.scenarioSamples','perfchecker.scenarioCatalog'])delete object[key];
        assert.deepEqual(currentConfig,beforeConfig,'Measurements change only the explicitly controlled setup keys');
        await settings().update('scenarioSamples',priorSamples,vscode.ConfigurationTarget.WorkspaceFolder);
        await settings().update('scenarioCatalog',priorCatalog,vscode.ConfigurationTarget.WorkspaceFolder);
        const document=await vscode.workspace.openTextDocument(vscode.Uri.file(settingsFile)),edit=new vscode.WorkspaceEdit();
        edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),beforeSettings.toString('utf8'));
        assert(await vscode.workspace.applyEdit(edit));assert(await document.save());
        await eventually(async()=>Buffer.compare(await fs.readFile(settingsFile),beforeSettings)===0&&settings().get('scenarioSamples')===priorSamples&&settings().get('scenarioCatalog')===priorCatalog,
          'The intended measurement setup restores exact settings bytes and effective configuration',10000);
      }
      result.measurements??={};result.measurements[label]=receipts;
      if(proofs)await fs.writeFile(path.join(proofs,`${label}-measurements.json`),JSON.stringify(receipts,null,2));
      return receipts;
    };
    const baselineMeasurements=bibliography?await measureBibliography('baseline'):undefined;
    await vscode.commands.executeCommand('perfchecker.openChat');view=await findChat();
    if(bibliography){
      result.captureLayout.editorWidth=await view.evaluate(()=>innerWidth);
      assert(result.captureLayout.editorWidth>=1000,'Capture a wide real PerfChecker editor, rather than a narrow side column');
      const evidenceId=baselineMeasurements.at(-1).id;
      await eventually(async()=>(await state()).evidence.some(item=>item.id===evidenceId),'Actual saved Bibliography allocation evidence appears in Chat');
      await view.getByRole('combobox',{name:'Attach saved evidence',exact:true}).selectOption(evidenceId);
      await eventually(async()=>(await state()).evidenceId===evidenceId,'Native evidence selection reaches the product');
      result.fixture={kind:'bibliography',baseline:baselineProbe,selectedEvidenceId:evidenceId};
    }
    await view.locator('summary').filter({hasText:'Optional Codex CLI connector'}).click();
    const beforeServers=new Set(loopbackServers());await click('Connect Codex CLI');
    await eventually(async()=>Boolean((await state()).connection),'The actual Connect button authenticates the existing CLI',60000);
    const connected=await state();assert.match(connected.connection,/^codex-cli\s+\S+/);assert.equal(connected.implementation.tool,'implement_perfchecker');
    result.agent=connected.connection;
    if(bibliography)await view.locator('summary').filter({hasText:'Optional Codex CLI connector'}).click();
    server=await eventually(()=>{const added=loopbackServers().filter(handle=>!beforeServers.has(handle));assert(added.length<=1);return added[0];},'Observe the newly owned loopback listener',10000);
    endpoint=`http://127.0.0.1:${server.address().port}/mcp`;
    const unauthorized=await fetch(endpoint,{method:'POST',headers:{Connection:'close'},body:'{}',signal:AbortSignal.timeout(5000)});
    assert.equal(unauthorized.status,401);await unauthorized.arrayBuffer();await preserved();
    checks.push('installed immutable candidate path/version/runtime hashes; genuine Connect control; saved disabled provider unchanged; unauthenticated HTTP refused');

    const questions=bibliography?[
      `Advice only: no tools, commands or edits. The attached real measurements concern one Bibliography export. The source below is src/bibtex.jl. Explain whether name_to_string is a plausible bounded allocation experiment; distinguish measured attribution from hypotheses and do not claim any gain. Source: ${source}`,
      `Continue the same conversation. Review a change ONLY to name_to_string in src/bibtex.jl that preserves all separators and partial Name values, Unicode, first/middle/particle/junior/last fields, and input non-mutation. The independent literal oracle is perf/episode-05a/correctness.jl; the original perf/media/export-workload.jl oracle and both episode05a catalogues must stay unchanged. On the later explicit implementation request, edit ONLY src/bibtex.jl in the supplied isolated checkout, and test that actual checkout using ${process.env.PERFCHECKER_TEST_JULIA} --startup-file=no --history-file=no --project=perf/episode-05a/worker. Its Project pins BenchmarkTools1.7.0, Chairmarks1.3.1, BibInternal792d8c709169505f998f7d70bfa092551dd4089f and BibParsercf1eb4446b986a23ed444963dcdb4c6ecc2da90f. Its ignored Manifest is intentionally absent: instantiate there with update_registry=false and allow_autoprecomp=false, assert realpath(pkgdir(Bibliography))==realpath(pwd()) and pathof points to that copy's src/Bibliography.jl, then include correctness.jl and the unchanged export oracle. Never reuse the original checkout's Manifest. Create no helper files, change no Project/oracle/catalogue, install nothing outside the private environment, run no external services or push. All descendants must retain CPU16–17, Julia2threads/GC1/precompile1/BLAS1/OMP1. Advice only for this turn; implementation follows separately.`
    ]:[
      `Advice only, no tools, commands or file changes. This real Julia function allocated ${baselineBytes} bytes after warming on1000 Float64 inputs: ${source}. Explain removing its intermediate squared array and what remains unmeasured. When I later explicitly request implementation, modify ONLY ${relative}, preserve the module and @noinline API, create no other files, and use ONLY the existing Julia executable ${process.env.PERFCHECKER_TEST_JULIA} with --startup-file=no --history-file=no -e for checks. Never install packages or call external services.`,
      `Continue the same conversation: specify actual Julia checks for Float64[]==0.0, [1.0,-2.0,3.0]==14.0 and collect(1.0:1000.0)==333833500.0. The implementation should preserve those results and reduce warmed @allocated, without claiming speed improved. Advice only now: no tools, commands or edits. On the later explicit implementation request, change ONLY ${relative}, preserve module/@noinline, test those three cases with ${process.env.PERFCHECKER_TEST_JULIA} --startup-file=no --history-file=no -e, warm then measure1000 inputs. Create no files except that source edit.`
    ];
    const adviceCharacters=[];
    for(const [turn,question] of questions.entries()){
      await view.locator('#chat-question').fill(question);await click('Send question');
      const reply=await eventually(async()=>{const value=await state();return !value.busy&&value.messages.length===2*(turn+1)?value:undefined;},
        `Authenticated Julia advice turn ${turn+1} completes`,(Number(settings().get('advisorTimeout'))+120)*1000);
      assert.deepEqual(reply.messages.map(message=>message.role),Array.from({length:turn+1},()=>['user','assistant']).flat());
      const answer=reply.messages.at(-1).content;assert(answer.length>10);adviceCharacters.push(answer.length);
      await eventually(async()=>await view.locator('.message.assistant').count()===turn+1,'The actual reply is visible');
      assert((await view.locator('.message.assistant').last().innerText()).includes(answer));await preserved();
      if(bibliography)await presentation(`advice-${turn+1}`,()=>captureAdvice(turn+1));
    }
    if(bibliography)result.conversation=(await state()).messages;
    checks.push('two authenticated contextual advice replies through Julia MCP are visible and preserve exact source/index/HEAD/config');
    await view.getByRole('tab',{name:'02 · Implementation',exact:true}).click();
    assert.match(await view.locator('.warning').innerText(),/Git checkpoint.*isolated copy.*diff review/);
    const beforePrepare=chatOutcome(await state()),prepareStarted=Date.now();let prepareAccepted=false,lastPrepare;
    const agentBudgetMs=Number(settings().get('advisorTimeout'))*1000;
    const cleanupGraceMs=require(path.join(installed,'dist','controllerCancellation.js')).CANCELLATION_GRACE_MS;
    assert.equal(agentBudgetMs,bibliography?600000:180000);assert.equal(cleanupGraceMs,60000);
    assert.equal(agentBudgetMs,Number(process.env.PERFCHECKER_HOST_ADVISOR_TIMEOUT)*1000);
    const uiBudgetMs=agentBudgetMs+60000,setupDeadline=prepareStarted+210000;
    result.prepare={preControllerBudgetMs:210000,agentBudgetMs,uiBudgetMs,cleanupGraceMs,transitions:[],
      timerAnchor:'First passive observation of each real PID/incarnation; conservative upper bound, not the internal spawn timestamp'};
    await click('I reviewed the advice · Prepare implementation');
    let proposed;
    while(Date.now()<suiteDeadline){
      const processes=await observe(),value=await state(),outcome=chatOutcome(value),serialized=JSON.stringify(outcome),now=Date.now();
      for(const [role,pid,budgetMs]of [['controller',processes.cli,uiBudgetMs],['agent',processes.agent,agentBudgetMs]]){
        const identity=processes.identities.find(item=>item.pid===pid);
        if(identity&&!result.prepare[role]){
          const firstObserved=processStates.get(`${identity.pid}:${identity.start}`)?.firstSeen??now;
          result.prepare[role]={...identity,firstObservedAt:new Date(firstObserved).toISOString(),
            observedAfterPrepareMs:firstObserved-prepareStarted,deadlineAt:new Date(firstObserved+budgetMs).toISOString()};
        }
      }
      if(serialized!==lastPrepare){result.prepare.transitions.push({elapsedMs:now-prepareStarted,...outcome});lastPrepare=serialized;}
      prepareAccepted||=outcome.busy||outcome.backupRef!==beforePrepare.backupRef||outcome.status!==beforePrepare.status;
      if(prepareAccepted&&!value.busy){
        assert(value.proposal?.patch,`Actual Prepare completed without a reviewed patch: ${outcome.status}; ${outcome.implementationSummary}`);
        result.prepare.naturalCompletionMs=now-prepareStarted;proposed=value;break;
      }
      const controller=result.prepare.controller;
      if(!controller&&now>=setupDeadline)throw new Error('Actual Prepare did not reach its Julia controller within the unchanged 210 second pre-controller budget');
      if(controller){
        const deadline=Date.parse(controller.deadlineAt);
        if(now>=deadline)result.prepare.uiDeadlineObserved=true;
        if(now>=deadline+cleanupGraceMs)throw new Error(`Actual Prepare remained busy beyond its real ${uiBudgetMs/1000} second UI budget and existing 60 second product cleanup grace`);
      }
      await delay(100);
    }
    assert(proposed,'The unchanged 21 minute host budget expired before a natural Prepare outcome');
    assert.deepEqual(proposed.proposal.files,[relative]);assert.equal(proposed.proposal.applied,false);assert.match(proposed.backupRef,/^refs\/perfchecker\/checkpoints\//);await preserved();
    // Read the installed backend's retained proposal; do not generate or apply a replacement patch.
    const {recoverActiveImplementationProposal}=require(path.join(installed,'dist','implementation.js'));
    const proposal=await recoverActiveImplementationProposal(root);assert(proposal);assert.equal(proposal.patch,proposed.proposal.patch);
    const candidate=path.join(session,'candidate-oracle');
    if(bibliography){
      await execute('git',['clone','--quiet','--no-hardlinks',root,candidate]);
      await execute('git',['fetch','--quiet','origin',proposal.candidateRef],{cwd:candidate});
      await execute('git',['checkout','--quiet','--detach','FETCH_HEAD'],{cwd:candidate});
      await execute('git',['remote','remove','origin'],{cwd:candidate});
    }else{await fs.mkdir(path.join(candidate,'src'),{recursive:true});await fs.writeFile(path.join(candidate,relative),await git('show',`${proposal.candidate}:${relative}`));}
    const candidateProbe=await probe(candidate),candidateBytes=bibliography?candidateProbe.allocationBytes:candidateProbe;
    if(bibliography){
      for(const key of ['benchmarkTools','chairmarks','bibInternalRevision','bibParserRevision','dependencyGraphSha256','correctnessSha256','workloadSha256','projectSha256'])
        assert.equal(candidateProbe[key],baselineProbe[key],`The candidate preserves ${key}`);
      assert.notEqual(candidateProbe.sourceSha256,baselineProbe.sourceSha256);await preserveWorker('candidate-worker',candidate);
      result.fixture.candidate=candidateProbe;result.fixture.proposedSource=await fs.readFile(path.join(candidate,relative),'utf8');
      const functionStart=source.indexOf('function name_to_string(name)'),nextDoc=source.indexOf('\n"""\n    names_to_strings',functionStart);
      assert(functionStart>=0&&nextDoc>functionStart,'The reviewed fixture has explicit name_to_string boundaries');
      assert(result.fixture.proposedSource.startsWith(source.slice(0,functionStart))&&result.fixture.proposedSource.endsWith(source.slice(nextDoc)),
        'The real proposal may change only name_to_string, preserving the rest of bibtex.jl');
    }else assert(candidateBytes<baselineBytes,'The real Julia candidate reduces measured allocations');
    await click('Open full diff');
    await eventually(()=>vscode.window.visibleTextEditors.some(editor=>editor.document.languageId==='diff'&&editor.document.getText()===proposal.patch),'The real native diff editor displays the entire collected patch',30000);
    if(bibliography)await presentation('full-diff',()=>capture('full-diff'));
    await vscode.commands.executeCommand('perfchecker.openChat');view=await findChat();
    await click('Apply reviewed changes');await eventually(async()=>!((await state()).busy)&&(await state()).proposal?.applied,'Actual Apply completes');
    assert.notEqual(await fs.readFile(sourceFile,'utf8'),source);
    const appliedProbe=await probe(root);
    if(bibliography){
      assert.equal(appliedProbe.sourceSha256,candidateProbe.sourceSha256);assert.equal(appliedProbe.dependencyGraphSha256,baselineProbe.dependencyGraphSha256);
      result.fixture.applied=appliedProbe;await presentation('applied',()=>capture('applied'));await measureBibliography('applied');
      await vscode.commands.executeCommand('perfchecker.openChat');view=await findChat();
      await view.getByRole('tab',{name:'02 · Implementation',exact:true}).click();
    }else assert.equal(appliedProbe,candidateBytes);
    assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);assert.equal(await git('rev-parse','HEAD'),head);
    await click('Restore previous code');await eventually(async()=>!((await state()).busy)&&!(await state()).proposal?.applied,'Actual Restore completes');
    const restoredProbe=await probe(root);
    if(bibliography){
      assert.deepEqual(restoredProbe,baselineProbe);result.fixture.restored=restoredProbe;await presentation('restored',()=>capture('restored'));
      checks.push('Bibliography: exact source/entrypoint in baseline/candidate/Apply/Restore; independent 10 literal name cases and Unicode/multi-entry/nonmutation export oracles; identical full dependency graph; actual benchmark100/chairmark100/profile_alloc3 measurements before and after Apply; no improvement assumed');
    }else assert.equal(restoredProbe,baselineBytes);
    await preserved();
    checks.push('real Prepare/checkpoint/diff clicks; independent Julia oracles before Apply; actual Apply/Restore preserve staging/HEAD');

    await view.getByRole('tab',{name:'01 · Advice',exact:true}).click();
    await openConnector();
    await view.locator('#chat-question').fill(bibliography?
      'Advice only, no tools or edits. Explain the remaining limits of this bounded bibliography name-string experiment: partial names, Unicode, separator preservation, non-mutation, sampler uncertainty, separate collectors and why one fixture does not establish universal BibTeX equivalence.':
      'Advice only, no tools or edits. Give a detailed explanation of remaining floating-point correctness and benchmark uncertainty in this Julia optimization, including NaN/Infinity, signed zero, reduction order and stable allocation measurement.');
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
    assert.equal((await state()).connection,undefined,'Cancel returns idle only after the local connection is actually disconnected');
    assert.equal((await state()).implementation.tool,'previous_agent');
    assert.equal((await vscode.commands.executeCommand('perfchecker.codexConnectionState')).connected,false);
    assert.equal(server.listening,false);await assert.rejects(fetch(endpoint,{method:'POST',body:'{}',signal:AbortSignal.timeout(5000)}));await preserved();
    result.cancelledConnectionAutomaticallyDisconnected=true;
    const beforeReconnectServers=new Set(loopbackServers());await openConnector();await click('Connect Codex CLI');
    await eventually(async()=>Boolean((await state()).connection),'The real reconnect button runs preflight without another model request',60000);
    server=await eventually(()=>{const added=loopbackServers().filter(handle=>!beforeReconnectServers.has(handle));assert(added.length<=1);return added[0];},'Observe only the newly reconnected listener',10000);
    endpoint=`http://127.0.0.1:${server.address().port}/mcp`;
    await click('Disconnect Codex');await eventually(async()=>!((await state()).connection),'Actual Disconnect clears the reconnected session');
    assert.equal((await vscode.commands.executeCommand('perfchecker.codexConnectionState')).connected,false);
    assert.equal(server.listening,false);await assert.rejects(fetch(endpoint,{method:'POST',body:'{}',signal:AbortSignal.timeout(5000)}));await preserved();
    checks.push('Cancel automatically disconnects after owned cleanup; genuine Reconnect preflight (no model call) and Disconnect close the new listener and preserve saved settings');
    assert.equal(result.captureFailures?.length??0,0,'Every requested native presentation capture must pass before global PASS');
    Object.assign(result,{status:'passed',adviceTurns:2,adviceCharacters,oracle:bibliography?{independentNameCases:10,Unicode:true,multiEntryExport:true,nonMutation:true,historicalOracleUnchanged:true}:{empty:0,signed:14,range1000:333833500},
      allocationBaselineBytes:baselineBytes,allocationCandidateBytes:candidateBytes,changedFiles:proposal.files,
      ownedRequestPids:{cli:owned.cli,worker:owned.worker,codex:owned.agent},ownedDeadBeforeCleanup:true,socketClosedBeforeCleanup:true,
      remoteInferenceCancellation:'Not established; UI accurately preserves the remote-work caveat'});
  }catch(error){
    primaryError=error;Object.assign(result,{status:'failed',error:String(error),stack:error.stack});
    try{result.failureChat=chatOutcome(await state());}catch(snapshotError){result.failureChatError=String(snapshotError);}
    try{result.failureObservedProcesses=(await observe()).identities;}catch(snapshotError){result.failureObservationError=String(snapshotError);}
    const failedDeadline=suiteDeadline,diagnosticDeadline=Date.now()+10000;
    suiteDeadline=diagnosticDeadline;
    try{if(browser){view=await findChat();await capture('failure-before-cleanup',Math.max(1,diagnosticDeadline-Date.now()));}}
    catch(snapshotError){result.failureCaptureError=String(snapshotError);}
    finally{suiteDeadline=failedDeadline;}
    // Persist the actual terminal failure and passive chronology before Cancel
    // can trigger cleanup or any subsequent diagnostic can fail.
    await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result,null,2));
  }
  finally{
    suiteDeadline=Date.now()+30000;
    // Failure cleanup uses the same owning controls and does not turn teardown into a PASS oracle.
    try{
      if(browser){
        const current=await state();
        if(current.busy||current.connection)view=await findChat();
        if(current.busy){
          result.failureCancellation={before:chatOutcome(current)};
          await click('Cancel request');await idle('Failure cleanup finishes the owned request');
          result.failureCancellation.after=chatOutcome(await state());
        }
        if((await state()).connection){
          result.failureDisconnect={before:chatOutcome(await state()),details:await openConnector()};
          await click('Disconnect Codex');await eventually(async()=>!((await state()).connection),'Failure cleanup disconnects the local connector');
          result.failureDisconnect.after=chatOutcome(await state());
        }
        if(primaryError)result.failureAfterCleanup=chatOutcome(await state());
      }
    }catch(error){result.cleanupError=String(error);primaryError??=error;result.status='failed';}
    clearInterval(observer);
    try{await observation;await observe();}
    catch(error){result.observationError=String(error);primaryError??=error;result.status='failed';}
    for(const stop of cliObservers.values())stop();
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
