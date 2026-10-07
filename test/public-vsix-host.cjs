// Runs in an actual Electron extension host, using an independently installed VSIX.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const controls = require('./native-studio-controls.cjs');
const mcp = require('./native-mcp-controls.cjs');
const investigations = require('./native-investigation-controls.cjs');
const pluto = require('./native-pluto-controls.cjs');
const workbench = require('./native-workbench-controls.cjs');
const advisor = require('./native-advisor-controls.cjs');
const redact=value=>String(value).replace(/([?&]secret=)[^&\s"'<>]*/gi,'$1[session secret]');

// Feature effects are separate from registering a command. Missing evidence stays unverified.
function commandCoverage(commands,checks){
  const effects={
    discoverTestItems:['testitem-current-evidence'],configureAdvisor:['advisor-native-model-management','advisor-native-provider-and-tool-discovery'],catalogTools:['native-tool-catalogue'],
    syncScenarios:['native-discovery-and-sync-after-pluto','investigation-sync-tools-history-native-exports'],
    narrateAdvice:['investigation-saved-advice-and-disabled-model'],investigateScenarios:['investigation-real-bounded-work'],
    openInvestigations:['investigation-discovery-selection-source-draft'],discoverScenarios:['investigation-discovery-selection-source-draft'],
    measureScenarios:['investigation-real-measurement'],diagnoseScenarios:['investigation-analyzer-jet','investigation-analyzer-alloccheck'],
    adviseScenarios:['investigation-saved-advice-and-disabled-model'],compareScenarios:['investigation-real-baseline-candidate'],
    cancelInvestigation:['investigation-cancel-active-julia-worker'],prepareScenario:['investigation-discovery-selection-source-draft'],
    openInvestigationSource:['investigation-discovery-selection-source-draft'],refresh:['suite-selection-and-save'],initialize:['bootstrap-first-install-and-measurement','bootstrap-awaiting-registration'],
    runAll:['all-supported-collectors-measured'],runNode:['native-run-selection-command'],openEntrypoint:['native-workload-command'],
    openOutput:['result-controls'],showLog:['native-tool-catalogue'],openDesigner:['suite-selection-and-save'],openDesignerForWorkspace:['save-palette-command'],
    runLandscapeLiveForWorkspace:['landscape-live-prerequisite'],saveConfiguration:['save-palette-command','native-suite-save-palette'],
    openStudio:['first-open-studio'],openStudioForWorkspace:['controller-visible-in-studio'],openChat:['native-mcp-advice-implementation-restore'],
    openTerminal:['native-julia-terminal'],newNotebook:['pluto-suite-select-launch-save'],openNotebook:['pluto-reactive-save-reload-close'],
    debugFile:['official-julia-debug'],prepareImplementation:['native-mcp-advice-implementation-restore'],applyImplementation:['native-mcp-advice-implementation-restore'],
    restoreImplementation:['native-mcp-advice-implementation-restore'],connectCodex:['codex-missing-native-prerequisite'],disconnectCodex:['codex-disconnected-command'],
    stopNotebookSession:['native-pluto-without-jupyter'],
  };
  return commands.map(command=>{
    const name=command.replace(/^perfchecker\./,''),proof=checks.filter(check=>check.assertionsCompleted===true&&(effects[name]||[]).includes(check.name));
    const externalPrerequisite=['narrateAdvice','connectCodex','runLandscapeLiveForWorkspace'].includes(name);
    const prerequisite=externalPrerequisite||(proof.length>0&&proof.every(check=>['prerequisite','unavailable'].includes(check.status)));
    return {command,registered:true,status:proof.length?(prerequisite?'prerequisite-verified':'effect-verified'):'unverified',evidence:proof.map(check=>({name:check.name,outcome:check.status||'validated-effect',case:check.case,prerequisite:check.prerequisite})),
      ...(prerequisite?{limit:name==='narrateAdvice'?'No configured narrative model; enabled model execution is not qualified.':name==='connectCodex'?'No human Codex authentication in CI; authenticated CLI/General integration is covered by the separate local opt-in test.':name==='runLandscapeLiveForWorkspace'?'No physical Étendue/GPU renderer in this disposable package; only its explicit prerequisites are verified.':'Only explicit prerequisites were validated; this execution was unavailable.'}:{}),
      ...(name==='disconnectCodex'?{limit:'The native test verifies the explicit disconnected return state and preserved saved configuration after a failed temporary connection. An active authenticated CLI disconnect is covered separately by the local opt-in test.'}:{}),
      route:'Evidence records actual palette/API or webview backend effects; registration alone is never execution proof.'};
  });
}

function buttonCoverage(checks){
  const families={
    'Studio · Feature suite':['suite-selection-and-save'],
    'Studio · Existing Julia tests / Test Explorer':['testitem-current-evidence'],
    'Studio · Plots & results':['result-controls'],
    'Studio · Investigations':['investigation-discovery-selection-source-draft'],
    'Studio · Tool catalogue':['native-tool-catalogue'],
    'Studio · Talk to your agent':['native-mcp-advice-implementation-restore'],
    'Studio · Connect an advisor':['advisor-native-model-management','advisor-native-provider-and-tool-discovery'],
    'Studio · Debug Julia code':['official-julia-debug'],
    'Studio · New/Open Pluto notebook':['pluto-studio-file-dialog-buttons'],
    'Studio · PerfChecker terminal':['multi-root-explicit-routing'],
    'Studio · Julia extension REPL':['official-julia-repl'],
    'Studio · Project tasks':['project-task'],
    'Studio · Setup workspace':['bootstrap-first-install-and-measurement','bootstrap-awaiting-registration'],
    'Designer · nine check types / hidden selections / filters / save':['suite-selection-and-save'],
    'Designer · Git refs / commit pin / add / remove':['git-reference-controls'],
    'Designer · Cancel Git discovery':['git-cancel-discovery'],
    'Designer · comparison policy selection':['comparison-controls'],
    'Designer · median / mean / minimum / maximum calculated':['computed-reference-aggregation'],
    'Designer · pagination125 / drag / bulk hidden selection':['large-plan-pagination-and-drag'],
    'Designer · Run selected and native backend':['native-run-selection'],
    'Results · filters / reports / keyboard navigation':['result-controls'],
    'Investigation · adoption / validation / duplicate rejection':['investigation-adoption-types-and-duplicate-rejected'],
    'Investigation · real collectors / profile filters / raw evidence':['investigation-real-collectors-and-profile-controls'],
    'Investigation · artifact open / digest validation':['investigation-native-artifact-and-integrity'],
    'Investigation · before/after saved measurements':['investigation-real-baseline-candidate'],
    'Investigation · bounded work / limits':['investigation-real-bounded-work'],
    'Investigation · active worker cancellation':['investigation-cancel-active-julia-worker'],
    'Pluto · reactive edit / evaluate / autosave / reload':['pluto-reactive-save-reload-close'],
    'Pluto · Launch selected checks / Refresh / Save reports':['pluto-suite-select-launch-save'],
    'Pluto · Launch selected investigation / Refresh':['pluto-investigation-real-run'],
    'Pluto · Cancel investigation':['pluto-cancel-active-worker'],
    'Pluto · Cancel suite twice during cleanup':['pluto-suite-cancel-active-allocation'],
    'Pluto · Stop / Close active workers and owned .mem cleanup':['pluto-stop-active-owned-worker','pluto-close-active-allocation-worker'],
    'Pluto · homepage Shutdown / real confirmation':['pluto-home-shutdown-active-allocation'],
    'Pluto · failed Restart leaves no stale worker':['pluto-failed-restart-real-worker-cleanup'],
    'MCP · two advice turns / diff / Apply / oracle / Restore':['native-mcp-advice-implementation-restore'],
    'Coordination3D · physical renderer prerequisites':['landscape-live-prerequisite'],
    ...Object.fromEntries(['jet','aqua','alloccheck','snoopcompile','latency','gc','memory','heap','locks'].map(tool=>[`Analyzer · ${tool}`,[`investigation-analyzer-${tool}`]])),
  };
  const rows=Object.entries(families).map(([family,names])=>{
    const evidence=checks.filter(check=>check.assertionsCompleted===true&&names.includes(check.name));
    const complete=names.every(name=>evidence.some(check=>check.name===name))||family==='Studio · Setup workspace'&&evidence.length>0;
    const allAggregations=family!=='Designer · median / mean / minimum / maximum calculated'||['median','mean','minimum','maximum'].every(aggregation=>evidence.some(check=>check.aggregation===aggregation));
    return {family,status:complete&&allAggregations?(evidence.some(check=>['unavailable','prerequisite'].includes(check.status))?'prerequisite':'passed'):'unverified',
      evidence:evidence.map(check=>({name:check.name,case:check.case,status:check.status,aggregation:check.aggregation,prerequisite:check.prerequisite||check.reason}))};
  });
  const result=checks.findLast(check=>check.assertionsCompleted===true&&check.name==='result-controls');
  for(const [name,key] of Object.entries({distribution:'distribution',allocationPie:'allocation',normalizedOverlay:'normalized',flameGraph:'flame',versionSeries:'series'})){
    const count=result?.chartFamilies[key];
    rows.push({family:`Results plot · ${name}`,status:count>0?'passed':result?'prerequisite':'unverified',
      points:count,evidence:result?[{name:result.name,case:result.case,prerequisite:count>0?undefined:'This real run produced no observations for this plot family; rendering execution is unqualified.'}]:[]});
  }
  return rows;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {const value = await read(); if (value) return value;} catch (error) {last = error;}
    await delay(150);
  }
  throw new Error(`${description}${last ? `: ${last.message}` : ''}`);
}

async function measureNativeTestItem(context,expectedPassed){
  const {vscode,windowPage,workspace}=context;
  await controls.clickStudioAction(context,'items');
  await controls.clickStudioAction(context,'testing');
  const row=windowPage.locator('.monaco-list-row[aria-label*="test/performance.jl · performance"]').filter({hasText:'Vector reduction'}).first();
  await row.waitFor({state:'visible',timeout:120000});await row.hover();
  const button=row.locator('.action-label[title="Run Test"],.action-label[aria-label="Run Test"],.action-label.codicon-testing-run-icon').first();
  const storage=path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','native-testitems');
  const before=new Set(await fs.readdir(storage).catch(()=>[]));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace,'test','performance.jl'))),{preview:false});
  if(process.env.PERFCHECKER_NATIVE_VIDEO==='1')await delay(2500);
  await row.hover();
  context.log('native-ui-action',{surface:'Test Explorer',action:'Run Test',expectedPassed});
  await button.click();
  const measured=await eventually(async()=>{
    for(const name of await fs.readdir(storage)){
      if(before.has(name))continue;
      const file=path.join(storage,name,'result.json');
      const payload=await fs.readFile(file,'utf8').then(JSON.parse).catch(()=>undefined);
      if(payload?.schema_version==='perfchecker-testitem-run/1')return {file,payload};
    }
  },'The actual Test Explorer Run button returns fresh worker evidence',180000);
  assert.equal(measured.payload.passed,expectedPassed);assert.equal(measured.payload.runs.length,1);
  const retained=path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,'worker-evidence',process.env.PERFCHECKER_NATIVE_PHASE,expectedPassed?'native-testitem-passed':'native-testitem-missing-target','result.json');
  await fs.mkdir(path.dirname(retained),{recursive:true});await fs.copyFile(measured.file,retained);
  if(expectedPassed){
    assert.equal(measured.payload.runs[0].status,'validated');
    await eventually(async()=>/passed/i.test(await row.getAttribute('aria-label')||'')||await row.locator('.codicon-testing-passed-icon').count()>0,'The actual Testing tree reports Passed');
    context.proof('testitem-current-evidence',{items:1,core:context.core,nativeClick:true,studioDiscoverAndTestingButtons:true,report:measured.file,retainedReport:path.relative(process.env.PERFCHECKER_NATIVE_OUTPUT,retained),samples:measured.payload.runs[0].samples});
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(measured.file)),{preview:false});
    if(process.env.PERFCHECKER_NATIVE_VIDEO==='1')await delay(3000);
  }else{
    assert.equal(measured.payload.runs[0].samples[0].passes,0);assert.equal(measured.payload.runs[0].samples[0].errors,1);
    await eventually(async()=>/failed|errored/i.test(await row.getAttribute('aria-label')||''),'The tree does not present missing target dependencies as passed');
    await row.click();await vscode.commands.executeCommand('testing.openOutputPeek');
    await eventually(async()=>/package under test and its test dependencies/.test(await windowPage.locator('body').innerText()),'The real Test Results surface explains how to prepare the chosen controller');
    context.log('testitem-missing-target-prerequisite',{core:context.core,nativeClick:true,errors:1,assertions:0,diagnosticExplained:true});
  }
}

exports.run = async () => {
  assert.equal(process.env.CI, 'true', 'Never run this host against a human VS Code installation');
  const phase = process.env.PERFCHECKER_NATIVE_PHASE;
  const workspace = process.env.PERFCHECKER_NATIVE_WORKSPACE;
  const output = process.env.PERFCHECKER_NATIVE_OUTPUT;
  assert(path.isAbsolute(workspace));
  assert(path.basename(path.dirname(workspace)).startsWith('perfchecker-public-vsix-'));
  const checks = [], failures = [];
  let browser, windowPage,commands=[],activeCase;
  let pendingReport=Promise.resolve();
  const timing=()=>({observedAt:new Date().toISOString(),...(process.env.PERFCHECKER_NATIVE_VIDEO_STARTED_AT?
    {videoOffsetSeconds:(Date.now()-Date.parse(process.env.PERFCHECKER_NATIVE_VIDEO_STARTED_AT))/1000}:{})});
  const persist=(status='running')=>{
    const report=JSON.stringify({status,phase,platform:process.platform,vscode:vscode.version,extension:process.env.PERFCHECKER_NATIVE_EXPECTED_VERSION,invocation:process.env.PERFCHECKER_NATIVE_INVOCATION,
      coverage:process.env.PERFCHECKER_NATIVE_STAGE==='full'?'first-install-studio-investigations-mcp-pluto':'first-install-and-first-run-smoke',
      core:phase==='fresh'?{mode:'production-first-install',registry:'General',version:process.env.PERFCHECKER_NATIVE_MODE==='public'?'1.0.0':'1.0.1',available:process.env.PERFCHECKER_NATIVE_GENERAL_MINIMUM_AVAILABLE==='true'}:JSON.parse(process.env.PERFCHECKER_NATIVE_CORE_PROVENANCE),
      commands:commandCoverage(commands,checks),buttons:buttonCoverage(checks),activeCase,checks,failures},null,2);
    pendingReport=pendingReport.then(()=>fs.writeFile(path.join(output,`${phase}.json`),report));
    return pendingReport;
  };
  const retainEvidence=async name=>{
    const directory=path.join(output,'worker-evidence',phase,name);
    for(const relative of ['perf/results']){
      const origin=path.join(workspace,relative);
      await fs.cp(origin,path.join(directory,relative),{recursive:true,filter:async(file)=>{
        const stat=await fs.stat(file);return stat.isDirectory()||(/\.(json|jsonl|md|csv|xml)$/.test(file)&&stat.size<5000000);
      }}).catch(error=>{if(error.code!=='ENOENT')console.error(`NATIVE_EVIDENCE_COPY ${error}`);});
    }
  };
  const log = (name, detail = {}) => {const clean=JSON.parse(redact(JSON.stringify({name,...detail,...timing()})));checks.push(clean); console.log(`NATIVE_CHECK ${name} ${JSON.stringify(clean)}`);void persist();};
  const proof=(name,detail={})=>log(name,{...detail,assertionsCompleted:true,case:activeCase});
  const runCase = async (name, run) => {
    activeCase=name;await persist();
    log('native-case-start',{action:name});
    console.log(`NATIVE_CASE_START ${phase} ${name}`);
    try {
      if((await vscode.commands.getCommands(true)).includes('notifications.clearAll'))await vscode.commands.executeCommand('notifications.clearAll');
      await run(); proof(name, {status: 'passed'});
      if(process.env.PERFCHECKER_NATIVE_VIDEO==='1')await delay(1500);
    }
    catch (error) {
      failures.push({name, message: redact(error), stack: redact(error.stack)});
      console.error(`NATIVE_FAILURE ${name}: ${redact(error.stack || error)}`);
      await windowPage?.screenshot({path: path.join(output, `${phase}-${name}.png`)}).catch(() => {});
      await persist();await retainEvidence(name);
    }
    finally{activeCase=undefined;await persist();}
  };
  try {
    browser = await eventually(() => chromium.connectOverCDP('http://127.0.0.1:9222'), 'Connect to the disposable Electron host');
    windowPage = await eventually(async () => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('workbench')), 'Locate the actual VS Code workbench');
    const allCommands=await vscode.commands.getCommands(true);
    if(allCommands.includes('workbench.action.closeAuxiliaryBar'))await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    if(process.env.PERFCHECKER_NATIVE_VIDEO==='1'){
      let target,cdp;
      try{
        target=await windowPage.context().newCDPSession(windowPage);
        cdp=await browser.newBrowserCDPSession();
        const {targetInfo}=await target.send('Target.getTargetInfo');
        const {windowId}=await cdp.send('Browser.getWindowForTarget',{targetId:targetInfo.targetId});
        await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
        await cdp.send('Browser.setWindowBounds',{windowId,bounds:{left:0,top:0,width:1920,height:1080}});
        log('native-recording-layout',{actualWindowBounds:await cdp.send('Browser.getWindowBounds',{windowId}),auxiliaryChatClosed:true});
      }catch(error){
        log('native-recording-layout-warning',{message:String(error),functionalTestsContinue:true});
        if(allCommands.includes('workbench.action.toggleFullScreen')){
          await vscode.commands.executeCommand('workbench.action.toggleFullScreen').catch(error=>log('native-recording-layout-warning',{fallback:String(error)}));
        }
        log('native-recording-viewport',{dimensions:await windowPage.evaluate(()=>({width:innerWidth,height:innerHeight})),fallback:'actual-workbench-fullscreen-command'});
      }finally{await target?.detach().catch(()=>{});await cdp?.detach().catch(()=>{});}
    }
    const findFrame = selector => eventually(async () => {
      for (const context of browser.contexts()) for (const page of context.pages()) for (const frame of page.frames()) {
        if (!await frame.locator(selector).first().isVisible().catch(() => false)) continue;
        let visible=true;
        for(let current=frame;current.parentFrame();current=current.parentFrame()) {
          const owner=await current.frameElement().catch(()=>undefined);
          if(!owner || !await owner.isVisible().catch(()=>false))visible=false;
          await owner?.dispose();if(!visible)break;
        }
        if(visible)return frame;
      }
    }, `Locate the real webview ${selector}`);
    const extension = vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');
    assert(extension, 'The product must come from the separate installed VSIX');
    assert.equal(extension.packageJSON.version, process.env.PERFCHECKER_NATIVE_EXPECTED_VERSION);
    assert(!extension.extensionPath.includes('qualification-host'));
    await extension.activate();
    const registered = new Set(await vscode.commands.getCommands(true));
    commands = extension.packageJSON.contributes.commands.map(command => command.command);
    for (const command of commands) assert(registered.has(command), `Contributed command is registered: ${command}`);
    log('installed-extension', {version: extension.packageJSON.version, vscode: vscode.version, commands: commands.length,
      settings: Object.keys(extension.packageJSON.contributes.configuration.properties).length, vsixSha256: process.env.PERFCHECKER_NATIVE_SHA});
    const uri = vscode.Uri.file(workspace);
    const context = {vscode, browser, windowPage, workspace,
      controller: process.env.PERFCHECKER_NATIVE_CONTROLLER, target: process.env.PERFCHECKER_NATIVE_TARGET,
      results: path.join(workspace, 'perf', 'results', 'vscode'), log, proof, findFrame,
      core:JSON.parse(process.env.PERFCHECKER_NATIVE_CORE_PROVENANCE),coreVersion:process.env.PERFCHECKER_NATIVE_CORE_VERSION};
    log('core-installation-provenance',phase==='fresh'?{mode:'first-install',controllerInitiallyAbsent:true,productionInstaller:`General ${process.env.PERFCHECKER_NATIVE_MODE==='public'?'1.0.0':'1.0.1'}`,minimumAvailable:process.env.PERFCHECKER_NATIVE_GENERAL_MINIMUM_AVAILABLE==='true'}:context.core);

    if (phase === 'fresh') {
      assert(!vscode.extensions.getExtension('julialang.language-julia'));
      assert(!vscode.extensions.getExtension('ms-toolsai.jupyter'));
      await runCase('first-open-studio', () => controls.runFresh(context));
      await runCase('missing-controller-terminal', async () => {
        await assert.rejects(vscode.commands.executeCommand('perfchecker.openTerminal', uri), /Project\.toml|controller|runnerProject/i);
      });
      await runCase('missing-julia-debug', async () => {
        await assert.rejects(vscode.commands.executeCommand('perfchecker.debugFile', uri), /Install the Julia VS Code extension/i);
      });
      await runCase('missing-controller-initialize', async () => {
        if(process.env.PERFCHECKER_NATIVE_MODE==='public'){
          await assert.rejects(vscode.commands.executeCommand('perfchecker.initialize'), /controller Project\.toml not found.*perfchecker\.runnerProject/i);
          log('bootstrap-prerequisite', {controllerAbsent: true, initializeCurrentlyBlocked: true});return;
        }
        const notebook=vscode.commands.executeCommand('perfchecker.newNotebook',vscode.Uri.file(path.join(workspace,'perf','notebooks','Declined.jl')),{kind:'suite'});
        await windowPage.getByRole('button',{name:'Install Pluto environment',exact:true}).waitFor({timeout:30000});
        await windowPage.keyboard.press('Escape');assert.equal(await notebook,undefined);
        assert(!await fs.stat(path.join(workspace,'perf','pluto','Project.toml')).then(()=>true).catch(()=>false),'Opening alone never installs Pluto');
        // A conventional perf project can exist while PerfChecker is absent.
        await fs.mkdir(path.join(workspace,'perf'),{recursive:true});
        await fs.writeFile(path.join(workspace,'perf','Project.toml'),'[deps]\n');
        const declined=vscode.commands.executeCommand('perfchecker.initialize',uri);
        const picker=windowPage.locator('.quick-input-widget');
        await picker.waitFor({state:'visible',timeout:60000});
        await picker.locator('.monaco-list-row').filter({hasText:'Create controller environment'}).click();
        await windowPage.getByRole('button',{name:'Install controller',exact:true}).waitFor({timeout:30000});
        await windowPage.keyboard.press('Escape');await declined;
        assert(!await fs.stat(path.join(workspace,'perf','controller','Project.toml')).then(()=>true).catch(()=>false));
        await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',uri);
        const studio=await findFrame('#setup-workspace');
        await studio.locator('#setup-workspace').click();
        await picker.waitFor({state:'visible',timeout:60000});
        await picker.locator('.monaco-list-row').filter({hasText:'Create controller environment'}).click();
        await windowPage.getByRole('button',{name:'Install controller',exact:true}).click();
        if(process.env.PERFCHECKER_NATIVE_GENERAL_MINIMUM_AVAILABLE!=='true'){
          await eventually(async()=>{
            const text=(await studio.locator('body').innerText())+'\n'+(await windowPage.locator('body').innerText());
            return /requires registered PerfChecker 1\.0\.1/.test(text)&&/Install or upgrade it explicitly/.test(text);
          },'Production bootstrap explains the registered minimum and upgrade action',180000);
          assert.equal(vscode.workspace.getConfiguration('perfchecker',uri).get('runnerProject','perf'),'perf','Failed production setup preserves the selected controller');
          assert(!await fs.stat(path.join(workspace,'perf','suite.jl')).then(()=>true).catch(()=>false));
          proof('bootstrap-awaiting-registration',{status:'prerequisite',minimum:'1.0.1',registry:'General',positiveBootstrapQualified:false,explicitConfirmation:true,nativeStudioClick:true});
          return;
        }
        await eventually(()=>fs.stat(path.join(workspace,'perf','suite.jl')).then(()=>true).catch(()=>false),'Explicit first-use setup creates a real suite',600000);
        await eventually(()=>vscode.workspace.getConfiguration('perfchecker',uri).get('runnerProject')==='perf/controller','Controller setting is saved only after successful setup');
        await controls.runSelection(context);
        proof('bootstrap-first-install-and-measurement',{existingProjectWithoutPerfChecker:true,explicitConfirmation:true,core:'General 1.0.1',nativeStudioClick:true});
      });
    } else {
      const settings = vscode.workspace.getConfiguration('perfchecker', uri);
      for (const [key, value] of Object.entries({juliaExecutable: process.env.PERFCHECKER_NATIVE_JULIA,
        runnerProject: context.controller, scenarioProject: context.controller,
        suite: 'perf/suite.jl', profile: phase==='prepared'?'historical':'quick', reports: 'perf/results/vscode', advisorEnabled: false,
        scenarioSamples: 2, analysisTools: []})) {
        await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
      }
      await runCase('controller-visible-in-studio', async () => {
        await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace', uri);
        const frame = await findFrame('#studio-root');
        const environment=frame.locator('details.environment');
        if(!await environment.evaluate(element=>element.open))await environment.locator('summary').click();
        await eventually(async()=>(await environment.innerText()).includes(context.controller),'The expanded Studio environment shows the selected controller');
      });
      await runCase('native-julia-terminal', async () => {
        const terminal = await vscode.commands.executeCommand('perfchecker.openTerminal', uri);
        assert(terminal && await terminal.processId, 'Julia runs in the actual integrated terminal');
        const marker = path.join(workspace, 'terminal-version.txt');
        terminal.sendText(`using PerfChecker; write(${JSON.stringify(marker)}, string(Base.pkgversion(PerfChecker)))`);
        await eventually(async () => (await fs.readFile(marker, 'utf8')) === context.coreVersion, 'The integrated terminal imports the explicitly qualified Core version', 180000);
        assert.strictEqual(await vscode.commands.executeCommand('perfchecker.openTerminal', uri), terminal, 'The project terminal is reused');
        terminal.dispose();
      });
      if(process.env.PERFCHECKER_NATIVE_MODE==='candidate'){
        await runCase('native-pluto-without-jupyter',async()=>{
          assert(!vscode.extensions.getExtension('ms-toolsai.jupyter'));
          const file=path.join(workspace,'perf','notebooks',`${phase}-first.jl`);
          const result=await vscode.commands.executeCommand('perfchecker.newNotebook',vscode.Uri.file(file),{kind:'suite'});
          assert.equal(result.fsPath,vscode.Uri.file(file).fsPath);
          const parent=await findFrame('iframe.perfchecker-pluto-frame');
          const frame=await(await parent.locator('iframe.perfchecker-pluto-frame').elementHandle()).contentFrame();
          await frame.locator('pluto-notebook').waitFor({state:'visible',timeout:180000});
          await eventually(async()=>/idle/.test(await frame.locator('[data-suite-state]').innerText()),'Opening Pluto initializes a live dashboard without launching checks',180000);
          await windowPage.screenshot({path:path.join(output,`native-${process.env.PERFCHECKER_NATIVE_EXPECTED_VERSION}-${process.platform}-${vscode.version}-${phase}-pluto.png`)});
          await vscode.commands.executeCommand('perfchecker.stopNotebookSession',uri);
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
          log('pluto-prerequisites',{juliaExtensionInstalled:Boolean(vscode.extensions.getExtension('julialang.language-julia')),jupyterInstalled:false,interactiveIframe:true,noMeasurementOnOpen:true});
        });
      }
      if (phase === 'configured' && process.env.PERFCHECKER_NATIVE_MODE==='public') {
        await runCase('notebook-missing-prerequisite', async () => {
          assert(!vscode.extensions.getExtension('ms-toolsai.jupyter'));
          try {
            const notebookUri = await vscode.commands.executeCommand('perfchecker.newNotebook', uri);
            const document = vscode.workspace.notebookDocuments.find(document => document.uri.toString() === notebookUri.toString());
            assert(document, 'The available native serializer opens the actual notebook');
            assert(document.getCells().some(cell => /Select the \*\*Julia\*\* kernel/.test(cell.document.getText())), 'The notebook explains the Julia kernel prerequisite');
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            log('notebook-native-serializer-available', {jupyterInstalled: false, kernelExplained: true});
          } catch (error) {
            assert.match(String(error), /install.*jupyter|jupyter.*install|notebook.*extension/i,
              'Unavailable notebook serialization must explain how to obtain its provider');
          }
        });
      } else if(phase==='configured'&&process.env.PERFCHECKER_NATIVE_MODE==='candidate') {
        await runCase('native-testitem-missing-target',()=>measureNativeTestItem(context,false));
      } else if(phase==='prepared') {
        if(process.env.PERFCHECKER_NATIVE_MODE==='public')await runCase('native-notebook-with-jupyter', async () => {
          assert(vscode.extensions.getExtension('ms-toolsai.jupyter'));
          const notebookUri = await vscode.commands.executeCommand('perfchecker.newNotebook', uri);
          const document = vscode.workspace.notebookDocuments.find(document => document.uri.toString() === notebookUri.toString());
          assert(document && document.cellCount > 0, 'A real investigation notebook was opened');
          assert.equal(document.notebookType, 'jupyter-notebook');
          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        });
        await runCase('native-suite-run-button', async () => {context.results = await controls.runSelection(context);});
        await runCase('native-suite-save-palette', async () => {
          await vscode.commands.executeCommand('perfchecker.openDesignerForWorkspace', uri);
          const frame = await findFrame('#save');
          await frame.locator('#save').click();
          await eventually(() => fs.readFile(path.join(workspace, 'perf', 'perfchecker-ui.json'), 'utf8').then(JSON.parse), 'Native Save button writes the shared configuration');
          const title = `Unsaved palette state ${Date.now()}`;
          await frame.locator('#doc-title').fill(title);
          await vscode.commands.executeCommand('perfchecker.saveConfiguration');
          const saved = JSON.parse(await fs.readFile(path.join(workspace, 'perf', 'perfchecker-ui.json'), 'utf8'));
          assert.equal(saved.documentation.blocks[0].title, title, 'Palette Save persists current unsaved editor state');
        });
        await runCase('native-run-selection-command',async()=>{
          const plan=JSON.parse(await fs.readFile(path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','suite-plan.json'),'utf8'));
          const run=plan.runs.find(run=>run.status==='ready'&&run.backend==='benchmark');assert(run);
          await vscode.commands.executeCommand('perfchecker.openEntrypoint',run);
          assert.equal(vscode.window.activeTextEditor.document.uri.fsPath,vscode.Uri.file(run.entrypoint).fsPath);
          proof('native-workload-command',{command:'perfchecker.openEntrypoint',entrypoint:run.entrypoint});
          await vscode.commands.executeCommand('perfchecker.runNode',{runs:[run]});
          const report=JSON.parse(await fs.readFile(path.join(context.results,'suite-result.json'),'utf8'));
          assert.equal(report.runs.length,1);assert.equal(report.runs[0].status,'pass');
        });
        await runCase('native-testitem-measurement',()=>measureNativeTestItem(context,true));
        if (process.env.PERFCHECKER_NATIVE_STAGE === 'full') {
          await runCase('native-complete-suite-measurements',async()=>{
            await vscode.commands.executeCommand('perfchecker.runAll');
            const report=JSON.parse(await fs.readFile(path.join(context.results,'suite-result.json'),'utf8'));
            const plan=JSON.parse(await fs.readFile(path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','suite-plan.json'),'utf8'));
            const backend=run=>plan.runs.find(item=>item.package===run.package && item.feature===run.feature && item.version===run.version)?.backend;
            const ready=report.runs.filter(run=>run.status==='pass');
            assert(ready.length>1);assert(report.runs.every(run=>['pass','unavailable'].includes(run.status)),'Available collectors pass correctness; only known unavailable checks may remain');
            assert.deepEqual(new Set(report.runs.filter(run=>run.package==='Example').map(run=>run.version)),new Set(['0.5.0','0.5.3','0.5.4','0.5.5']));
            proof('all-supported-collectors-measured',{collectors:[...new Set(ready.map(backend))],checks:ready.length,unavailable:report.runs.filter(run=>run.status==='unavailable').map(run=>({backend:backend(run),reason:run.message})),versions:['0.5.0','0.5.3','0.5.4','0.5.5']});
          });
          await runCase('native-all-studio-controls', () => controls.run(context));
          await runCase('native-workbench-controls',()=>workbench.run(context));
          await runCase('native-investigation-controls', () => investigations.run(context));
          await runCase('native-advisor-controls', () => advisor.run(context));
          await runCase('native-mcp-controls', () => mcp.run(context));
          if(process.env.PERFCHECKER_NATIVE_MODE==='candidate')await runCase('native-pluto-controls',()=>pluto.run(context));
          await runCase('native-discovery-and-sync-after-pluto',async()=>{
            await vscode.commands.executeCommand('perfchecker.discoverScenarios');
            await vscode.commands.executeCommand('perfchecker.syncScenarios');
          });
        }
      }
    }
  } catch (error) {failures.push({name: 'host-bootstrap', message: String(error), stack: error.stack});}
  finally {
    await persist(failures.length?'failed':'passed');await retainEvidence('final');
    // A browser connected over CDP closes its protocol connection here. The
    // qualification extension quits VS Code after its final report is written.
    await browser?.close().catch(() => {});
  }
  if (failures.length) throw new Error(`${phase}: ${failures.length} native smoke check(s) failed; see the uploaded evidence`);
};
