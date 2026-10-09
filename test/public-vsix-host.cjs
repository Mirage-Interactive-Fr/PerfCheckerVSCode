// Runs in an actual Electron extension host, using an independently installed VSIX.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
const processObservationSignatures=new WeakMap();
const {chromium} = require('playwright');
const controls = require('./native-studio-controls.cjs');
const mcp = require('./native-mcp-controls.cjs');
const investigations = require('./native-investigation-controls.cjs');
const pluto = require('./native-pluto-controls.cjs');
const workbench = require('./native-workbench-controls.cjs');
const advisor = require('./native-advisor-controls.cjs');
const redact=value=>String(value).replace(/([?&]secret=)[^&\s"'<>]*/gi,'$1[session secret]')
  .replace(/(secret%3D)[^%\s"'<>]*/gi,'$1[session secret]');

// Feature effects are separate from registering a command. Missing evidence stays unverified.
function commandCoverage(commands,checks){
  const effects={
    discoverTestItems:['testitem-current-evidence'],configureAdvisor:['advisor-native-model-management','advisor-native-provider-and-tool-discovery'],catalogTools:['native-tool-catalogue'],
    syncScenarios:['native-discovery-and-sync-after-pluto','investigation-sync-tools-history-native-exports'],
    narrateAdvice:['investigation-saved-advice-and-disabled-model','native-narrative-controlled-response','native-narrative-cancel-active-http'],investigateScenarios:['investigation-real-bounded-work'],
    openInvestigations:['investigation-discovery-selection-source-draft','native-codelens-and-quickfix'],discoverScenarios:['investigation-discovery-selection-source-draft'],
    measureScenarios:['investigation-real-measurement'],diagnoseScenarios:['investigation-analyzer-jet','investigation-analyzer-alloccheck','native-codelens-and-quickfix'],
    adviseScenarios:['investigation-saved-advice-and-disabled-model'],compareScenarios:['investigation-real-baseline-candidate'],
    cancelInvestigation:['investigation-cancel-active-julia-worker'],prepareScenario:['investigation-discovery-selection-source-draft'],
    openInvestigationSource:['investigation-discovery-selection-source-draft'],refresh:['suite-selection-and-save'],initialize:['bootstrap-first-install-and-measurement','bootstrap-awaiting-registration','bootstrap-existing-controller'],
    runAll:['all-supported-collectors-measured'],runNode:['native-run-selection-command'],openEntrypoint:['native-workload-command'],
    openOutput:['result-controls'],showLog:['native-suite-worker-output'],openDesigner:['suite-selection-and-save'],openDesignerForWorkspace:['save-palette-command'],
    runLandscapeLiveForWorkspace:['landscape-live-prerequisite','native-landscape-command-completed','native-landscape-cancel-owned-renderer'],saveConfiguration:['save-palette-command','native-suite-save-palette'],
    openStudio:['native-open-studio-command'],openStudioForWorkspace:['controller-visible-in-studio','studio-inventory','bootstrap-existing-controller'],openChat:['native-mcp-advice-implementation-restore','native-mcp-configuration-only-conversation'],
    openTerminal:['native-julia-terminal'],newNotebook:['pluto-suite-select-launch-save','pluto-studio-file-dialog-buttons'],openNotebook:['pluto-reactive-save-reload-close','pluto-studio-file-dialog-buttons'],
    debugFile:['official-julia-debug'],prepareImplementation:['native-mcp-advice-implementation-restore','native-mcp-reviewed-apply-exact-restore'],applyImplementation:['native-mcp-advice-implementation-restore','native-mcp-reviewed-apply-exact-restore'],
    restoreImplementation:['native-mcp-advice-implementation-restore','native-mcp-reviewed-apply-exact-restore'],connectCodex:['codex-missing-native-prerequisite'],disconnectCodex:['codex-disconnected-command'],
    connectMcpStdio:['native-mcp-stdio-connected-session'],disconnectMcpStdio:['native-mcp-stdio-modern-disconnect'],
    stopNotebookSession:['native-pluto-without-jupyter','pluto-stop-active-owned-worker'],
  };
  return commands.map(command=>{
    const name=command.replace(/^perfchecker\./,''),proof=checks.filter(check=>check.assertionsCompleted===true&&(effects[name]||[]).includes(check.name));
    const narrativeEnabled=proof.some(check=>check.name==='native-narrative-controlled-response');
    const landscapeExecuted=proof.some(check=>check.name==='native-landscape-command-completed');
    const externalPrerequisite=name==='connectCodex'||name==='runLandscapeLiveForWorkspace'&&!landscapeExecuted||name==='narrateAdvice'&&!narrativeEnabled;
    const prerequisite=externalPrerequisite||(proof.length>0&&proof.every(check=>['prerequisite','unavailable'].includes(check.status)));
    return {command,registered:true,status:proof.length?(prerequisite?'prerequisite-verified':'effect-verified'):'unverified',evidence:proof.map(check=>({name:check.name,outcome:check.status||'validated-effect',case:check.case,prerequisite:check.prerequisite})),
      ...(prerequisite?{limit:name==='narrateAdvice'?'No configured narrative model; enabled model execution is not qualified.':name==='connectCodex'?'No human Codex authentication in CI; authenticated CLI/General integration is covered by the separate local opt-in test.':name==='runLandscapeLiveForWorkspace'?'No physical Étendue/GPU renderer in this disposable package; only its explicit prerequisites are verified.':'Only explicit prerequisites were validated; this execution was unavailable.'}:{}),
      ...(name==='disconnectCodex'?{limit:'The native test verifies the explicit disconnected return state and preserved saved configuration after a failed temporary connection. An active authenticated CLI disconnect is covered separately by the local opt-in test.'}:{}),
      ...(name==='narrateAdvice'&&narrativeEnabled?{limit:'The actual native button, Core worker and request/response contract use a clearly identified local protocol fixture. This is not evidence of authenticated model inference.'}:{}),
      ...(name==='runLandscapeLiveForWorkspace'&&landscapeExecuted?{limit:'Real immutable Landscape tag and SDKs through the installed command, SDL/Vulkan llvmpipe software rendering. GPU timing and physical presentation remain unavailable. Cancellation is separate evidence.'}:{}),
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
    'Studio · Setup workspace':['bootstrap-first-install-and-measurement','bootstrap-awaiting-registration','bootstrap-existing-controller'],
    'Designer · nine check types / hidden selections / filters / save':['suite-selection-and-save'],
    'Designer · Git refs / commit pin / add / remove':['git-reference-controls'],
    'Designer · Cancel Git discovery':['git-cancel-discovery'],
    'Designer · comparison policy selection':['comparison-controls'],
    'Designer · median / mean / minimum / maximum calculated':['computed-reference-aggregation'],
    'Designer · pagination125 / drag / bulk hidden selection':['large-plan-pagination-and-drag'],
    'Designer · Run selected and native backend':['native-run-selection'],
    'Designer · native colour picker / group labels / save / reload':['native-colour-picker-save-reload'],
    'Results · filters / reports / keyboard navigation':['result-controls'],
    'Results · metric visibility / measured version range / Reset':['native-results-comparison-controls'],
    'Investigation · adoption / validation / duplicate rejection':['investigation-adoption-types-and-duplicate-rejected'],
    'Editor · real proposal and diagnosis CodeLens / quick fix':['native-codelens-and-quickfix'],
    'Investigation · real collectors / profile filters / raw evidence':['investigation-real-collectors-and-profile-controls'],
    'Investigation · artifact open / digest validation':['investigation-native-artifact-and-integrity'],
    'Investigation · before/after saved measurements':['investigation-real-baseline-candidate'],
    'Investigation · bounded work / limits':['investigation-real-bounded-work'],
    'Investigation · active worker cancellation':['investigation-cancel-active-julia-worker'],
    'Investigation · Explain with configured model / HTTP contract':['native-narrative-controlled-response'],
    'Investigation · Cancel active explanation / connection cleanup':['native-narrative-cancel-active-http'],
    'Workspace · actual extension-host reload / owned allocation cleanup':['native-reload-owned-allocation-cleanup'],
    'Pluto · reactive edit / evaluate / autosave / reload':['pluto-reactive-save-reload-close'],
    'Pluto · Launch selected checks / Refresh / Save reports':['pluto-suite-select-launch-save'],
    'Pluto · measured Makie/WGLMakie figures and point inspection':['pluto-rendered-measured-plots'],
    'Pluto · Launch selected investigation / Refresh':['pluto-investigation-real-run'],
    'Pluto · Cancel investigation':['pluto-cancel-active-worker'],
    'Pluto · Cancel active suite / repeat Cancel / owned allocation cleanup':['pluto-suite-cancel-active-allocation'],
    'Pluto · Stop / Close active workers and owned .mem cleanup':['pluto-stop-active-owned-worker','pluto-close-active-allocation-worker'],
    'Pluto · homepage Shutdown / real confirmation':['pluto-home-shutdown-active-allocation'],
    'Pluto · Julia/HTML exports / modified New in default browser':['pluto-default-browser-exports'],
    'Pluto · failed Restart leaves no stale worker':['pluto-failed-restart-real-worker-cleanup'],
    'MCP · two advice turns / diff / Apply / oracle / Restore':['native-mcp-advice-implementation-restore'],
    'MCP · select measured evidence / exact IDs / bounded context':['native-mcp-selected-measured-evidence'],
    'MCP · configuration-only conversation':['native-mcp-configuration-only-conversation'],
    'MCP stdio · paginated discovery / displayed tool schemas':['native-mcp-stdio-discovered-schema'],
    'MCP stdio · newline JSON-RPC / explicit session Connect':['native-mcp-stdio-connected-session'],
    'MCP stdio · separate advice / implementation tools and arguments':['native-mcp-stdio-connected-session','native-mcp-custom-arguments'],
    'MCP stdio · Cancel / pending request notification / EOF / owned cleanup':['native-mcp-stdio-cancel-before-teardown'],
    'MCP stdio · Disconnect / owned cleanup':['native-mcp-stdio-modern-disconnect'],
    'MCP stdio · official Reload / no automatic server restart':['native-mcp-stdio-official-editor-reload'],
    'Coordination3D · physical renderer prerequisites':['landscape-live-prerequisite'],
    'Coordination3D · real software Landscape command / complete opened bundle':['native-landscape-command-completed'],
    'Coordination3D · native Cancel / owned renderer cleanup':['native-landscape-cancel-owned-renderer'],
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

// Native evidence does not imply every alternate value or external service was tested.
// Preserve a row for every contributed option, including remaining unqualified paths.
function configurationCoverage(properties,checks){
  const paths={
    testItemTags:['native-testitems-tags-exclusions-samples'],testItemExcludeTags:['native-testitems-tags-exclusions-samples'],testItemSamples:['testitem-current-evidence','native-testitems-tags-exclusions-samples'],
    advisorEnabled:['advisor-native-provider-and-tool-discovery','native-mcp-advice-implementation-restore'],
    advisorConfig:['advisor-native-model-management','advisor-native-provider-and-tool-discovery','native-mcp-advice-implementation-restore'],
    advisorEndpoint:['advisor-native-model-management','native-mcp-advice-implementation-restore','native-narrative-controlled-response'],
    advisorModel:['advisor-native-model-management','native-narrative-controlled-response'],advisorProtocol:['provider-controls','advisor-native-provider-and-tool-discovery','native-mcp-advice-implementation-restore','native-narrative-controlled-response'],
    advisorInstructions:['native-narrative-custom-instruction-and-environment-key'],advisorMcpTool:['advisor-native-provider-and-tool-discovery','native-mcp-advice-implementation-restore'],
    advisorMcpPromptArgument:['advisor-native-provider-and-tool-discovery','native-mcp-advice-implementation-restore','native-mcp-custom-arguments'],
    advisorMcpArguments:['advisor-native-provider-and-tool-discovery','native-mcp-custom-arguments'],advisorMcpResponse:['provider-controls','native-mcp-advice-implementation-restore'],
    advisorMcpVersion:['advisor-native-provider-and-tool-discovery','native-mcp-advice-implementation-restore'],advisorAllowRemote:['native-advisor-remote-opt-in-contract'],advisorKeyEnvironment:['native-narrative-custom-instruction-and-environment-key'],advisorTimeout:['native-mcp-advice-implementation-restore','native-narrative-configured-deadline'],
    advisorInvestigates:['investigation-real-bounded-work','native-investigation-enabled-model-decision'],investigationMaxExperiments:['investigation-real-bounded-work'],investigationBudgetSeconds:['investigation-real-bounded-work','native-investigation-elapsed-budget'],
    scenarioCatalog:['investigation-adoption','native-codelens-and-quickfix'],scenarioProject:['native-codelens-and-quickfix','native-active-controller-runtime-settings'],
    investigationReports:['investigation-real-measurement','native-codelens-and-quickfix'],analysisTools:['investigation-analyzer-jet','investigation-analyzer-alloccheck','native-codelens-and-quickfix'],
    analysisTimeout:['investigation-real-measurement','native-analysis-configured-deadline'],scenarioThreads:['native-codelens-and-quickfix'],scenarioSamples:['investigation-real-measurement','native-mcp-selected-measured-evidence'],
    juliaExecutable:['native-julia-terminal','official-julia-debug','native-active-controller-runtime-settings'],runnerProject:['multi-root-explicit-routing','official-julia-debug','native-active-controller-runtime-settings'],
    suite:['suite-selection-and-save'],factory:['suite-selection-and-save'],profile:['all-supported-collectors-measured'],reports:['result-controls','computed-reference-aggregation'],
    uiConfiguration:['save-palette-command','native-suite-save-palette'],gitTargets:['git-reference-controls'],comparisonPolicies:['computed-reference-aggregation'],
    advisorImplementationMcpTool:['native-mcp-advice-implementation-restore'],advisorImplementationMcpPromptArgument:['native-mcp-advice-implementation-restore','native-mcp-custom-arguments'],
    advisorImplementationMcpWorkspaceArgument:['native-mcp-advice-implementation-restore','native-mcp-custom-arguments'],codexExecutable:['codex-missing-native-prerequisite'],
    ...Object.fromEntries(['advisorImplementationMcpArguments','advisorMcpStdioCommand','advisorMcpStdioArguments','advisorMcpStdioDirectory'].map(key=>[key,['native-mcp-persisted-stdio-settings-after-reload']])),
    plutoProject:['native-pluto-without-jupyter','pluto-investigation-real-run','pluto-stop-active-owned-worker'],
  };
  const pathOnly=new Set(['advisorTimeout','advisorInvestigates','investigationBudgetSeconds','analysisTimeout','suite','factory','profile']);
  const limits={
    advisorAllowRemote:'The native checkbox and Julia HTTPS opt-in/refusal contract are validated without external remote connection.',
    advisorKeyEnvironment:'The asserted bearer is synthetic and sent only to the owned loopback fixture; no human credentials or authenticated external model are qualified.',
    advisorTimeout:'Active cancellation is qualified separately; expiry of every configured deadline is not implied.',
    advisorInvestigates:'The deterministic disabled-model path is exercised; enabled model decisions inside bounded investigations are not qualified.',
    investigationBudgetSeconds:'The actual bounded report is inspected, but elapsed-time exhaustion is not independently forced.',
    analysisTimeout:'Successful worker execution uses the configured limit; timeout expiry is not independently forced by this path.',
    suite:'The actual configured suite is planned and run; every alternate filename is not qualified.',
    factory:'The actual build_suite factory is used; alternate factory names are not native-qualified.',
    profile:'The actual quick profile is run; every alternate profile is not native-qualified.',
    codexExecutable:'The unavailable executable diagnostic is native-tested; authenticated Codex is a separate local opt-in proof.',
    ...Object.fromEntries(['advisorImplementationMcpArguments','advisorMcpStdioCommand','advisorMcpStdioArguments','advisorMcpStdioDirectory'].map(key=>[key,
      'This proof covers controlled saved values and actual form prefill for two workspace folders after a real host restart; external commands and authenticated agents are outside its scope.'])),
  };
  return Object.keys(properties).map(option=>{
    const key=option.replace(/^perfchecker\./,''),evidence=checks.filter(check=>check.assertionsCompleted===true&&(paths[key]||[]).includes(check.name));
    const deadlineVerified=evidence.some(check=>({advisorTimeout:'native-narrative-configured-deadline',analysisTimeout:'native-analysis-configured-deadline',
      investigationBudgetSeconds:'native-investigation-elapsed-budget',advisorInvestigates:'native-investigation-enabled-model-decision'})[key]===check.name);
    const status=!evidence.length?'unverified':key==='codexExecutable'?'prerequisite-verified':pathOnly.has(key)&&!deadlineVerified?'path-exercised':'effect-verified';
    const qualifiedLimit=deadlineVerified?({advisorTimeout:'One actual 45-second request expiry is asserted; other configured limits are not implied.',
      analysisTimeout:'One actual 45-second sleeping scenario expires; every analyzer and deadline value is not implied.',
      investigationBudgetSeconds:'One real 45-second elapsed budget interrupts a running scenario and leaves experiments unexecuted.',
      advisorInvestigates:'One controlled structured MCP stop decision is asserted with preserved custom fields; external inference is not qualified.'})[key]:undefined;
    return {option,status,evidence:evidence.map(check=>({name:check.name,case:check.case,status:check.status||'validated-effect'})),
      scope:'Actual values asserted by the cited case only; API-written test settings and native UI changes are not interchangeable.',
      ...(qualifiedLimit||limits[key]?{limit:qualifiedLimit||limits[key]}:{})};
  });
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

// Read only the runner-owned process tree. Arguments help diagnose phases;
// they never establish ownership or executable identity.
async function readDiagnosticRequest(context,argumentsText,deadline){
  const withinDeadline=()=>assert(deadline===undefined||Date.now()<deadline,'Request observation stays inside the existing diagnosis report deadline');
  withinDeadline();
  const worker=context.core.diagnosticWorker,root=process.env.PERFCHECKER_NATIVE_DIAGNOSTIC_TEMP;
  assert(worker&&root,'Diagnostic request observation requires qualified Core and a private temporary root');
  assert.equal(await fs.realpath(root),root);assert.equal(await fs.realpath(worker.file),worker.file);
  const rootStat=await fs.lstat(root);assert(rootStat.isDirectory()&&!rootStat.isSymbolicLink());
  assert(!/[\s"']/.test(worker.file+root),'The controlled argv paths have an unambiguous ps representation');
  const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const suffix=new RegExp(`(?:^|\\s)${escape(worker.file)}\\s+(${escape(root)}/[^/\\s]+/request\\.toml)\\s+(${escape(root)}/[^/\\s]+/response\\.toml)$`);
  const match=suffix.exec(argumentsText);if(!match)return {status:'arguments-unavailable',scope:'Exact Core script and private request/response suffix were not observed'};
  const request=match[1],response=match[2],directory=path.dirname(request);
  assert.equal(path.dirname(directory),root);assert.equal(path.dirname(response),directory);
  assert.equal(await fs.realpath(directory),directory);const directoryStat=await fs.lstat(directory);assert(directoryStat.isDirectory()&&!directoryStat.isSymbolicLink());
  assert.equal(await fs.realpath(request),request);const initial=await fs.lstat(request);assert(initial.isFile()&&!initial.isSymbolicLink());
  assert(initial.size>0&&initial.size<=256*1024,'Request observation has a fixed 256 KiB bound');
  const handle=await fs.open(request,require('node:fs').constants.O_RDONLY|require('node:fs').constants.O_NOFOLLOW);
  let bytes;
  try{const opened=await handle.stat();assert(opened.dev===initial.dev&&opened.ino===initial.ino&&opened.size===initial.size);
    bytes=Buffer.alloc(initial.size);const read=await handle.read(bytes,0,bytes.length,0);assert.equal(read.bytesRead,bytes.length);
    const after=await handle.stat();assert(after.dev===opened.dev&&after.ino===opened.ino&&after.size===opened.size&&after.mtimeMs===opened.mtimeMs);
  }finally{await handle.close();}
  const final=await fs.lstat(request);assert(final.isFile()&&!final.isSymbolicLink()&&final.dev===initial.dev&&final.ino===initial.ino&&final.size===initial.size&&final.mtimeMs===initial.mtimeMs);
  assert.equal(await fs.realpath(directory),directory);const directoryAfter=await fs.lstat(directory);
  assert(directoryAfter.isDirectory()&&!directoryAfter.isSymbolicLink()&&directoryAfter.dev===directoryStat.dev&&directoryAfter.ino===directoryStat.ino);
  assert.equal(await fs.realpath(root),root);const rootAfter=await fs.lstat(root);
  assert(rootAfter.isDirectory()&&!rootAfter.isSymbolicLink()&&rootAfter.dev===rootStat.dev&&rootAfter.ino===rootStat.ino);
  assert.equal(createHash('sha256').update(await fs.readFile(worker.file)).digest('hex'),worker.sha256);
  withinDeadline();
  assert.equal(require('@iarna/toml/package.json').version,'2.2.5');
  let value;
  try{value=require('@iarna/toml/parse-string')(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch(error){return {status:'parse-error',errorClass:error.name==='TomlError'?'TomlError':'ParseError',
    line:Number.isFinite(error.line)?error.line:undefined,column:Number.isFinite(error.col)?error.col:undefined};}
  assert(['jet','aqua','alloccheck','snoopcompile','latency','gc','memory','heap','locks'].includes(value.tool),'Only selected analyzer names are retained');
  if(value.tool!=='aqua')assert(value.scenario?.id==='ui_adopted'&&value.scenario?.implementation==='ui','Only the exact selected bank scenario is retained');
  const responseStat=await fs.lstat(response).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(responseStat)assert(responseStat.isFile()&&!responseStat.isSymbolicLink());
  withinDeadline();
  return {status:'observed',tool:value.tool,scenario:value.tool==='aqua'?'package':'ui_adopted',implementation:value.tool==='aqua'?'package':'ui',
    requestBytes:initial.size,requestInode:initial.ino,requestDevice:initial.dev,responsePresent:!!responseStat,
    scope:'Whitelisted request fields and response existence only; no import/analysis phase or log payload inferred'};
}

async function macProcessInventory(context,stage,port,knownIdentities=[],deadline){
  assert.equal(process.platform,'darwin');
  const bounded=maximum=>{if(deadline===undefined)return maximum;const remaining=deadline-Date.now();assert(remaining>0,'Observation stays inside the existing diagnosis report deadline');return Math.min(maximum,remaining);};
  const expectedExecutable=await fs.realpath(process.env.PERFCHECKER_NATIVE_JULIA);
  const survey=execute('ps',['-eo','pid=,ppid=,args='],{timeout:bounded(10000),maxBuffer:4*1024*1024});
  const observerPid=survey.child.pid,{stdout,stderr}=await survey;assert(!stderr.trim(),'Process survey has no stderr inspection error');
  const all=stdout.split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(line);return match?[{pid:Number(match[1]),parent:Number(match[2]),arguments:match[3]||''}]:[];});
  const observer=all.find(row=>row.pid===observerPid);
  if(observer)assert.equal(observer.parent,process.pid,'Only the actual ps observer owned by this host is excluded');
  const owned=new Set([process.pid]);
  for(let changed=true;changed;){changed=false;for(const row of all){
    if(row.pid===observerPid||owned.has(row.pid)||!owned.has(row.parent))continue;
    owned.add(row.pid);changed=true;
  }}
  const errors=[],rows=[];
  const relevant=all.filter(row=>row.pid!==process.pid&&(owned.has(row.pid)||knownIdentities.some(prior=>prior.pid===row.pid)));
  await Promise.all(relevant.map(async row=>{
    let before;
    try{
      const identity=async()=>{
        const observed=await execute('ps',['-p',String(row.pid),'-o','ppid=','-o','lstart='],{timeout:bounded(3000)});
        assert(!observed.stderr.trim(),'Process identity has no stderr inspection error');const value=observed.stdout.trim();
        const match=/^(\d+)\s+(.+)$/.exec(value);assert(match&&Number.isFinite(Date.parse(match[2])),'macOS supplies a real parent and lstart');
        return {parent:Number(match[1]),started:match[2],createdAt:new Date(Date.parse(match[2])).toISOString()};
      };
      before=await identity();assert.equal(before.parent,row.parent);
      const observedMappings=await execute('lsof',['-a','-p',String(row.pid),'-d','txt','-Fn'],{timeout:bounded(3000)});
      assert(!observedMappings.stderr.trim(),'Executable inspection has no stderr error');
      const mappings=observedMappings.stdout.split('\n').filter(line=>line.startsWith('n')).map(line=>line.slice(1));
      const canonicalMappings=await Promise.all(mappings.map(value=>fs.realpath(value).catch(()=>value)));
      assert.deepEqual(await identity(),before,'The observed process retains its parent and start identity while its executable is inspected');
      const projects=[...row.arguments.matchAll(/--project(?:=|\s+)([^\s]+)/g)].map(match=>match[1]).filter(value=>value.startsWith(process.env.PERFCHECKER_NATIVE_SESSION+path.sep));
      let diagnosticRequest;
      if(process.env.PERFCHECKER_NATIVE_PHASE==='diagnosis'&&canonicalMappings.includes(expectedExecutable)&&row.arguments.includes('diagnostic_worker.jl')){
        try{diagnosticRequest=await readDiagnosticRequest(context,row.arguments,deadline);
          const observedAfter=await execute('lsof',['-a','-p',String(row.pid),'-d','txt','-Fn'],{timeout:bounded(3000)});
          assert(!observedAfter.stderr.trim(),'Post-read executable inspection has no stderr error');
          const afterMappings=observedAfter.stdout.split('\n').filter(line=>line.startsWith('n')).map(line=>line.slice(1));
          assert((await Promise.all(afterMappings.map(value=>fs.realpath(value).catch(()=>value)))).includes(expectedExecutable),'The observed worker retains its canonical executable after request reading');
          assert.deepEqual(await identity(),before,'The observed worker retains its parent and incarnation after request reading');
        }catch(error){diagnosticRequest={status:'inspection-error',errorClass:error.name||'Error',code:typeof error.code==='string'?error.code:undefined};}
      }
      rows.push({pid:row.pid,...before,canonicalExecutable:canonicalMappings.includes(expectedExecutable)?expectedExecutable:undefined,
        executableMappings:canonicalMappings.slice(0,8),projects,argumentsCharacters:row.arguments.length,...(diagnosticRequest?{diagnosticRequest}: {})});
    }catch(error){if(before)rows.push({pid:row.pid,...before,identityOnly:true});errors.push({pid:row.pid,parent:row.parent,error:redact(error)});}
  }));
  let listeners=[];
  if(port!==undefined){
    assert(Number.isInteger(port)&&port>0&&port<65536);
    try{const value=await execute('lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-Fpn'],{timeout:3000});assert(!value.stderr.trim(),'Exact listener inspection has no stderr error');
      let pid;for(const line of value.stdout.split('\n')){
        if(/^p\d+$/.test(line))pid=Number(line.slice(1));
        else{const endpoint=/^n(.+):(\d+)$/.exec(line);if(endpoint&&Number(endpoint[2])===port&&pid)listeners.push({pid,port,address:endpoint[1],state:'Listen'});}
      }
    }catch(error){if(error.code!==1||String(error.stdout||'').trim()||String(error.stderr||'').trim())errors.push({port,error:redact(error)});}
  }
  rows.sort((a,b)=>a.pid-b.pid);errors.sort((a,b)=>(a.pid||0)-(b.pid||0));
  const inventory={stage,observedAt:new Date().toISOString(),hostPid:process.pid,expectedExecutable,observerPid,
    observerParentVerified:!!observer,presentPids:relevant.map(row=>row.pid),rows,direct:rows.filter(row=>row.parent===process.pid&&row.canonicalExecutable===expectedExecutable),listeners,errors};
  const signature=JSON.stringify({stage,rows,listeners,errors});
  if(processObservationSignatures.get(context)!==signature){context.log('native-macos-owned-processes',inventory);processObservationSignatures.set(context,signature);}
  return inventory;
}

async function observeNativeWork(context,stage){
  const settings=context.vscode.workspace.getConfiguration('perfchecker',context.vscode.Uri.file(context.workspace));
  const diagnostic={stage,observedAt:new Date().toISOString(),hostPid:process.pid,processArch:process.arch,
    workspace:context.workspace,workspaceUri:context.vscode.Uri.file(context.workspace).toString(),trusted:context.vscode.workspace.isTrusted,visibleControls:[],
    testItemSettings:Object.fromEntries(['testItemTags','testItemExcludeTags','testItemSamples'].map(key=>[key,settings.get(key)])),files:[],reports:[],testingRows:[],errors:[]};
  for(const root of [...new Set([context.controller,context.target,path.resolve(context.workspace,settings.get('plutoProject','perf/pluto'))])]){
    for(const name of ['Project.toml','Manifest.toml'])try{const file=path.join(root,name),bytes=await fs.readFile(file),stat=await fs.stat(file);
      diagnostic.files.push({file,sha256:createHash('sha256').update(bytes).digest('hex'),modifiedAt:stat.mtime.toISOString()});
    }catch(error){diagnostic.errors.push({file:path.join(root,name),error:String(error)});}
  }
  const source=path.join(context.workspace,'test','performance.jl');
  try{diagnostic.testItemSource={file:source,sha256:createHash('sha256').update(await fs.readFile(source)).digest('hex')};}catch(error){diagnostic.errors.push({file:source,error:String(error)});}
  try{diagnostic.testingRows=(await context.windowPage.locator('.monaco-list-row[aria-label]').evaluateAll(rows=>rows.map(row=>row.getAttribute('aria-label')))).filter(value=>/performance\.jl|Vector reduction|Passed|Failed|Errored/i.test(value)).slice(0,30);}catch(error){diagnostic.errors.push({surface:'Testing',error:String(error)});}
  for(const frame of context.windowPage.frames())try{
    if(!await frame.locator('#run,#app .status').first().isVisible().catch(()=>false))continue;
    diagnostic.visibleControls.push(await frame.evaluate(()=>({
      busy:document.getElementById('run')?.disabled,status:document.querySelector('#app .status')?.textContent?.slice(-1000),
      progress:document.getElementById('progress')?.textContent?.slice(-1000),error:document.getElementById('designer-error')?.textContent?.slice(-2000),
      selection:document.getElementById('count')?.textContent,controls:[...document.querySelectorAll('#run,#save,#app button')].slice(0,20).map(node=>({id:node.id,text:node.textContent?.slice(0,80),disabled:node.disabled}))
    })));
  }catch(error){diagnostic.errors.push({surface:'webview',error:String(error)});}
  const plan=path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','suite-plan.json');
  try{const bytes=await fs.readFile(plan),stat=await fs.stat(plan);diagnostic.files.push({file:plan,sha256:createHash('sha256').update(bytes).digest('hex'),modifiedAt:stat.mtime.toISOString()});}catch(error){diagnostic.errors.push({file:plan,error:String(error)});}
  const roots=[path.join(context.workspace,'perf','results'),path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','native-testitems')];
  for(const root of roots){
    const names=(await fs.readdir(root,{recursive:true}).catch(()=>[])).filter(name=>/(?:result|diagnosis|list|discovery|run)\.json$/.test(name)).slice(-24);
    for(const name of names)try{const file=path.join(root,name),bytes=await fs.readFile(file),stat=await fs.stat(file);if(bytes.length>5000000)continue;
      const value=JSON.parse(bytes);diagnostic.reports.push({file,sha256:createHash('sha256').update(bytes).digest('hex'),modifiedAt:stat.mtime.toISOString(),schema:value.schema_version,
        status:value.status,passed:value.passed,runId:value.run_id,runs:value.runs?.map(run=>({id:run.id,status:run.status,qualification:run.qualification})).slice(0,20),
        records:value.records?.map(record=>({tool:record.tool,status:record.status,message:record.message})).slice(0,12)});
    }catch(error){diagnostic.errors.push({file:path.join(root,name),error:String(error)});}
  }
  const logs=path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'logs');diagnostic.outputTails=[];
  const names=(await fs.readdir(logs,{recursive:true}).catch(()=>[])).filter(file=>/(?:\d+-)?PerfChecker(?: investigations| test items| Pluto)?\.log$/.test(path.basename(file)));
  for(const name of names.slice(-4))try{const handle=await fs.open(path.join(logs,name),'r');
    try{const stat=await handle.stat(),bytes=Buffer.alloc(Math.min(stat.size,2000));await handle.read(bytes,0,bytes.length,Math.max(0,stat.size-bytes.length));diagnostic.outputTails.push({channel:path.basename(name),tail:redact(bytes.toString('utf8'))});}finally{await handle.close();}
  }catch(error){diagnostic.errors.push({channel:name,error:String(error)});}
  if(process.platform==='darwin')diagnostic.processes=await macProcessInventory(context,stage);
  context.log('native-work-phase-diagnostic',diagnostic);return diagnostic;
}

async function runSuiteCases(context,runCase,options={}){
  const {vscode,workspace,findFrame,proof}=context,uri=vscode.Uri.file(workspace);
  const selected=await runCase('native-suite-run-button',async()=>{context.results=await controls.runSelection(context);});
  await runCase('native-suite-save-palette', async () => {
          if(options.blockDependents&&!selected)throw Object.assign(new Error('Blocked by native-suite-run-button; no dependent action was executed'),{blockedBy:'native-suite-run-button'});
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
          if(options.blockDependents&&!selected)throw Object.assign(new Error('Blocked by native-suite-run-button; no dependent action was executed'),{blockedBy:'native-suite-run-button'});
          const plan=JSON.parse(await fs.readFile(path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','suite-plan.json'),'utf8'));
          const run=plan.runs.find(run=>run.status==='ready'&&run.backend==='benchmark');assert(run);
          await vscode.commands.executeCommand('perfchecker.openEntrypoint',run);
          assert.equal(vscode.window.activeTextEditor.document.uri.fsPath,vscode.Uri.file(run.entrypoint).fsPath);
          proof('native-workload-command',{command:'perfchecker.openEntrypoint',entrypoint:run.entrypoint});
          await vscode.commands.executeCommand('perfchecker.runNode',{runs:[run]});
          const report=JSON.parse(await fs.readFile(path.join(context.results,'suite-result.json'),'utf8'));
          assert.equal(report.runs.length,1);assert.equal(report.runs[0].status,'pass');
        });
  if(options.testItem)await runCase('native-testitem-measurement',()=>measureNativeTestItem(context,true));
  if(options.complete){
    await runCase('native-complete-suite-measurements',async()=>{
            if(options.blockDependents&&!selected)throw Object.assign(new Error('Blocked by native-suite-run-button; no dependent action was executed'),{blockedBy:'native-suite-run-button'});
            await vscode.commands.executeCommand('perfchecker.runAll');
            const report=JSON.parse(await fs.readFile(path.join(context.results,'suite-result.json'),'utf8'));
            const plan=JSON.parse(await fs.readFile(path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','suite-plan.json'),'utf8'));
            const backend=run=>plan.runs.find(item=>item.package===run.package && item.feature===run.feature && item.version===run.version)?.backend;
            const ready=report.runs.filter(run=>run.status==='pass');
            assert(ready.length>1);assert(report.runs.every(run=>['pass','unavailable'].includes(run.status)),'Available collectors pass correctness; only known unavailable checks may remain');
            assert.deepEqual(new Set(report.runs.filter(run=>run.package==='Example').map(run=>run.version)),new Set(['0.5.0','0.5.3','0.5.4','0.5.5']));
            proof('all-supported-collectors-measured',{collectors:[...new Set(ready.map(backend))],checks:ready.length,unavailable:report.runs.filter(run=>run.status==='unavailable').map(run=>({backend:backend(run),reason:run.message})),versions:['0.5.0','0.5.3','0.5.4','0.5.5']});
          });
  }
}

async function measureNativeTestItem(context,expectedPassed,options={}){
  const {vscode,windowPage,workspace}=context;
  await context.observeWork?.('testitems-before-discovery');
  await controls.clickStudioAction(context,'items');
  await controls.clickStudioAction(context,'testing');
  const filename=options.file||'test/performance.jl',name=options.name||'Vector reduction';
  const row=windowPage.locator(`.monaco-list-row[aria-label*="${filename}"]`).filter({hasText:name}).first();
  await row.waitFor({state:'visible',timeout:120000});await row.hover();
  if(context.editorQualification)context.log('native-editor-visible-testing-item',{name,file:filename,matchingRows:await windowPage.locator(`.monaco-list-row[aria-label*="${filename}"]`).filter({hasText:name}).count(),
    visible:await row.isVisible(),ariaLabel:await row.getAttribute('aria-label'),runButtons:await row.locator('.action-label[title="Run Test"],.action-label[aria-label="Run Test"],.action-label.codicon-testing-run-icon').count()});
  await context.editorQualification?.surface('tagged-testing-before-run');
  await context.observeWork?.('testitems-real-tree-ready');
  const button=row.locator('.action-label[title="Run Test"],.action-label[aria-label="Run Test"],.action-label.codicon-testing-run-icon').first();
  const storage=path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','native-testitems');
  const before=new Set(await fs.readdir(storage).catch(()=>[]));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace,filename))),{preview:false});
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
  await context.observeWork?.('testitems-current-evidence-before-teardown');
  if(options.samples!==undefined)assert.equal(measured.payload.runs[0].samples.length,options.samples);
  const retained=path.join(process.env.PERFCHECKER_NATIVE_OUTPUT,'worker-evidence',process.env.PERFCHECKER_NATIVE_PHASE,
    options.retainName||(expectedPassed?'native-testitem-passed':'native-testitem-missing-target'),'result.json');
  await fs.mkdir(path.dirname(retained),{recursive:true});await fs.copyFile(measured.file,retained);
  if(expectedPassed){
    assert.equal(measured.payload.runs[0].status,'validated');
    await eventually(async()=>/passed/i.test(await row.getAttribute('aria-label')||'')||await row.locator('.codicon-testing-passed-icon').count()>0,'The actual Testing tree reports Passed');
    context.proof(options.proofName||'testitem-current-evidence',{items:1,core:context.core,nativeClick:true,studioDiscoverAndTestingButtons:true,report:measured.file,retainedReport:path.relative(process.env.PERFCHECKER_NATIVE_OUTPUT,retained),samples:measured.payload.runs[0].samples});
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(measured.file)),{preview:false});
    if(process.env.PERFCHECKER_NATIVE_VIDEO==='1')await delay(3000);
  }else{
    assert.equal(measured.payload.runs[0].samples[0].passes,0);assert.equal(measured.payload.runs[0].samples[0].errors,1);
    await eventually(async()=>/failed|errored/i.test(await row.getAttribute('aria-label')||''),'The tree does not present missing target dependencies as passed');
    await row.click();await vscode.commands.executeCommand('testing.openOutputPeek');
    const results=windowPage.locator('.part.panel .pane-body:visible').filter({has:windowPage.locator('.test-output-peek-tree')});
    await results.waitFor({state:'visible'});
    const failedResult=results.locator('.monaco-list-row').filter({hasText:name}).first();
    await failedResult.waitFor({state:'visible'});await failedResult.click();
    await eventually(async()=>{
      // Monaco soft-wraps even within words. Read only the visible result editor,
      // retaining the actual UI oracle while removing those rendering breaks.
      const text=(await results.locator('.monaco-editor:visible .view-lines').allInnerTexts()).join('').replace(/\s+/g,'');
      return text.includes(`TestItemRunnerexecutesin${context.controller.replace(/\s+/g,'')}.`)
        &&text.includes('Ensurethepackageundertestanditstestdependenciesareavailableinthatcontrollerenvironment');
    },'The selected real Test Results surface explains how to prepare the chosen controller');
    context.proof('testitem-missing-target-prerequisite',{core:context.core,nativeClick:true,selectedResult:name,errors:1,assertions:0,
      visibleSurface:'Test Results',selectedController:context.controller,diagnosticExplained:true});
  }
  return measured;
}

exports.run = async () => {
  assert.equal(process.env.CI, 'true', 'Never run this host against a human VS Code installation');
  const phase = process.env.PERFCHECKER_NATIVE_PHASE;
  const workspace = process.env.PERFCHECKER_NATIVE_WORKSPACE;
  const output = process.env.PERFCHECKER_NATIVE_OUTPUT;
  assert(path.isAbsolute(workspace));
  const session=process.env.PERFCHECKER_NATIVE_SESSION;
  assert(session&&path.isAbsolute(session),'The runner must provide its owned temporary session');
  assert.equal(await fs.realpath(workspace),path.join(await fs.realpath(session),'workspace'),
    'The native host must operate only on the exact workspace created by its runner');
  const checks = [], failures = [];
  let browser, windowPage,commands=[],activeCase,nativeContext;
  let pendingReport=Promise.resolve();
  let configurationProperties={};
  const timing=()=>({observedAt:new Date().toISOString(),...(process.env.PERFCHECKER_NATIVE_VIDEO_STARTED_AT?
    {videoOffsetSeconds:(Date.now()-Date.parse(process.env.PERFCHECKER_NATIVE_VIDEO_STARTED_AT))/1000}:{})});
  const persist=(status='running')=>{
    const report=JSON.stringify({status,phase,platform:process.platform,vscode:vscode.version,extension:process.env.PERFCHECKER_NATIVE_EXPECTED_VERSION,invocation:process.env.PERFCHECKER_NATIVE_INVOCATION,
      coverage:process.env.PERFCHECKER_NATIVE_STAGE==='focused'?`focused-native-${process.env.PERFCHECKER_NATIVE_CASE_GROUP}`:process.env.PERFCHECKER_NATIVE_STAGE==='targeted'?'actual-workspace-reload-and-controlled-narrative-protocol':process.env.PERFCHECKER_NATIVE_STAGE==='full'?'first-install-studio-investigations-mcp-pluto':'first-install-and-first-run-smoke',
      core:phase==='fresh'?{mode:'production-first-install',registry:'General',version:process.env.PERFCHECKER_NATIVE_MODE==='public'?'1.0.0':'1.0.1',available:process.env.PERFCHECKER_NATIVE_GENERAL_MINIMUM_AVAILABLE==='true'}:JSON.parse(process.env.PERFCHECKER_NATIVE_CORE_PROVENANCE),
      commands:commandCoverage(commands,checks),configuration:configurationCoverage(configurationProperties,checks),buttons:buttonCoverage(checks),activeCase,checks,failures},null,2);
    pendingReport=pendingReport.then(()=>fs.writeFile(path.join(output,`${phase}.json`),report));
    return pendingReport;
  };
  const retainEvidence=async name=>{
    const directory=path.join(output,'worker-evidence',phase,name);
    const origins=['perf/results','perf/notebooks'].map(relative=>({root:workspace,relative,prefix:''}));
    if(['testitems-ready','suite','diagnosis','pluto'].includes(phase))origins.push({
      root:path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode'),relative:'native-testitems',prefix:'host-storage'});
    if(phase==='landscape'){
      const root=process.env.PERFCHECKER_NATIVE_LANDSCAPE_WORKSPACE;
      assert.equal(root,path.join(session,'landscape'),'Only the runner-owned game reports are retained');
      origins.push({root,relative:'perf/results/live',prefix:'landscape'});
    }
    for(const {root,relative,prefix}of origins){
      const origin=path.join(root,relative);
      await fs.cp(origin,path.join(directory,prefix,relative),{recursive:true,filter:async(file)=>{
        const stat=await fs.stat(file);return stat.isDirectory()||(/\.(json|jsonl|md|csv|xml|jl|toml)$/.test(file)&&stat.size<5000000);
      }}).catch(error=>{if(error.code!=='ENOENT')console.error(`NATIVE_EVIDENCE_COPY ${error}`);});
    }
  };
  const log = (name, detail = {}) => {const clean=JSON.parse(redact(JSON.stringify({name,...detail,...timing()})));checks.push(clean); console.log(`NATIVE_CHECK ${name} ${JSON.stringify(clean)}`);void persist();};
  const proof=(name,detail={})=>log(name,{...detail,assertionsCompleted:true,case:activeCase});
  const runCase = async (name, run) => {
    activeCase=name;await persist();
    log('native-case-start',{action:name});
    console.log(`NATIVE_CASE_START ${phase} ${name}`);
    let observation=Promise.resolve();
    const observe=stage=>{observation=observation.then(()=>nativeContext?.observeWork?.(stage)).catch(error=>log('native-work-observation-error',{case:name,error:redact(error)}));return observation;};
    const observer=nativeContext?.observeWork?setInterval(()=>{void observe(`${name}-pending`);},60000):undefined;
    try {
      await observe(`${name}-before-action`);
      if((await vscode.commands.getCommands(true)).includes('notifications.clearAll'))await vscode.commands.executeCommand('notifications.clearAll');
      await run(); proof(name, {status: 'passed'});
      await observe(`${name}-completed-before-teardown`);
      if(process.env.PERFCHECKER_NATIVE_VIDEO==='1')await delay(1500);
      return true;
    }
    catch (error) {
      failures.push({name,status:error.blockedBy?'blocked':'failed',blockedBy:error.blockedBy,message: redact(error), stack: redact(error.stack)});
      console.error(`NATIVE_FAILURE ${name}: ${redact(error.stack || error)}`);
      await observe(`${name}-failed-before-cleanup`);
      // Keep a short terminal witness even if GitHub cannot upload the larger
      // evidence archive. This only observes the real panel and owned log files.
      const diagnostic={case:name,observedAt:new Date().toISOString(),visibleDesigner:[],outputTails:[]};
      try{
        for(const context of browser?.contexts()||[])for(const page of context.pages())for(const frame of page.frames()){
          if(!await frame.locator('#run').isVisible().catch(()=>false))continue;
          diagnostic.visibleDesigner.push(await frame.evaluate(()=>({
            busy:document.getElementById('run')?.disabled,
            progress:document.getElementById('progress')?.innerText?.slice(-1000),
            error:document.getElementById('designer-error')?.innerText?.slice(-2000),
            selection:document.getElementById('count')?.innerText,
          })).catch(value=>({readError:String(value)})));
        }
        const logs=path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'logs');
        const names=(await fs.readdir(logs,{recursive:true}).catch(()=>[])).filter(file=>/(?:\d+-)?PerfChecker(?: investigations| test items| Pluto)?\.log$/.test(path.basename(file)));
        for(const file of names.slice(-4)){
          const handle=await fs.open(path.join(logs,file),'r');
          try{const stat=await handle.stat(),bytes=Buffer.alloc(Math.min(stat.size,2000));
            await handle.read(bytes,0,bytes.length,Math.max(0,stat.size-bytes.length));
            diagnostic.outputTails.push({channel:path.basename(file),tail:bytes.toString('utf8')});
          }finally{await handle.close();}
        }
      }catch(value){diagnostic.readError=String(value);}
      log('native-failure-diagnostic',diagnostic);
      await windowPage?.screenshot({path: path.join(output, `${phase}-${name}.png`)}).catch(() => {});
      await persist();await retainEvidence(name);
      return false;
    }
    finally{clearInterval(observer);await observation;activeCase=undefined;await persist();}
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
        await eventually(async()=>await windowPage.evaluate(()=>innerWidth>=1800),'The asynchronous native fullscreen action reaches the recording width',5000)
          .catch(error=>log('native-recording-layout-warning',{fallback:String(error),functionalTestsContinue:true}));
        log('native-recording-viewport',{dimensions:await windowPage.evaluate(()=>({width:innerWidth,height:innerHeight})),fallback:'actual-workbench-fullscreen-command'});
      }finally{await target?.detach().catch(()=>{});await cdp?.detach().catch(()=>{});}
    }
    const findFrame = (selector,{allowAttached=false}={}) => eventually(async () => {
      for (const context of browser.contexts()) for (const page of context.pages()) for (const frame of page.frames()) {
        if (allowAttached?!await frame.locator(selector).count().catch(()=>0):!await frame.locator(selector).first().isVisible().catch(() => false)) continue;
        let visible=true;
        for(let current=frame;current.parentFrame();current=current.parentFrame()) {
          const owner=await current.frameElement().catch(()=>undefined);
          if(!owner || !await owner.isVisible().catch(()=>false))visible=false;
          await owner?.dispose();if(!visible)break;
        }
        if(visible)return frame;
      }
    }, `Locate the real webview ${selector}`);
    if(phase==='restricted'){
      await runCase('native-restricted-mode',()=>require('./native-restricted-controls.cjs').run({
        vscode,windowPage,workspace,log,proof,eventually}));
    }else{
    const extension = vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');
    assert(extension, 'The product must come from the separate installed VSIX');
    assert.equal(extension.packageJSON.version, process.env.PERFCHECKER_NATIVE_EXPECTED_VERSION);
    assert(!extension.extensionPath.includes('qualification-host'));
    await extension.activate();
    const registered = new Set(await vscode.commands.getCommands(true));
    commands = extension.packageJSON.contributes.commands.map(command => command.command);
    configurationProperties=extension.packageJSON.contributes.configuration.properties;
    for (const command of commands) assert(registered.has(command), `Contributed command is registered: ${command}`);
    log('installed-extension', {version: extension.packageJSON.version, vscode: vscode.version, commands: commands.length,
      settings: Object.keys(extension.packageJSON.contributes.configuration.properties).length, vsixSha256: process.env.PERFCHECKER_NATIVE_SHA});
    const uri = vscode.Uri.file(workspace);
    const context = {vscode, browser, windowPage, workspace,
      controller: process.env.PERFCHECKER_NATIVE_CONTROLLER, target: process.env.PERFCHECKER_NATIVE_TARGET,
      results: path.join(workspace, 'perf', 'results', 'vscode'), log, proof, findFrame,
      core:JSON.parse(process.env.PERFCHECKER_NATIVE_CORE_PROVENANCE),coreVersion:process.env.PERFCHECKER_NATIVE_CORE_VERSION,flushReport:()=>persist()};
    nativeContext=context;
    if(process.platform==='darwin')context.processInventory=(stage,port,known)=>macProcessInventory(context,stage,port,known);
    if(['testitems-ready','suite','diagnosis','pluto'].includes(phase))context.observeWork=stage=>observeNativeWork(context,stage);
    if(phase==='diagnosis'&&process.platform==='darwin'&&process.env.PERFCHECKER_NATIVE_DIAGNOSTIC_TEMP)context.observeDiagnosisRequest=(stage,deadline)=>macProcessInventory(context,stage,undefined,[],deadline);
    context.measureTestItem=options=>measureNativeTestItem(context,true,options);
    log('core-installation-provenance',phase==='fresh'?{mode:'first-install',controllerInitiallyAbsent:true,productionInstaller:`General ${process.env.PERFCHECKER_NATIVE_MODE==='public'?'1.0.0':'1.0.1'}`,minimumAvailable:process.env.PERFCHECKER_NATIVE_GENERAL_MINIMUM_AVAILABLE==='true'}:context.core);

    if(phase==='narrative'||process.env.PERFCHECKER_NATIVE_STAGE==='focused'){
      const settings=vscode.workspace.getConfiguration('perfchecker',uri);
      const continuingStdio=phase==='mcp-stdio'&&await fs.stat(path.join(output,'mcp-stdio-reload-handoff.json')).then(stat=>stat.isFile()).catch(error=>{if(error.code==='ENOENT')return false;throw error;});
      if(!continuingStdio)for(const [key,value] of Object.entries({juliaExecutable:process.env.PERFCHECKER_NATIVE_JULIA,runnerProject:context.controller,scenarioProject:context.controller,
        suite:'perf/suite.jl',profile:['studio','suite'].includes(phase)?'historical':'quick',reports:'perf/results/vscode',advisorEnabled:false,advisorConfig:'',scenarioSamples:2,analysisTools:[],plutoProject:'perf/pluto'}))
        await settings.update(key,value,vscode.ConfigurationTarget.WorkspaceFolder);
      if(phase==='narrative')await runCase('native-enabled-narrative-protocol',()=>require('./native-narrative-controls.cjs').run(context));
      else if(phase==='landscape')await runCase('native-landscape-controls',()=>require('./native-landscape-controls.cjs').run(context));
      else if(phase==='studio-color')await runCase('native-colour-picker-save-reload',()=>controls.runColour(context));
      else if(phase==='mcp')await runCase('native-mcp-controls',()=>mcp.run(context));
      else if(phase==='mcp-stdio')await runCase('native-generic-mcp-stdio-controls',()=>mcp.run(context,{stdio:true,customArguments:true}));
      else if(phase==='pluto-plots')await runCase('native-pluto-rendered-plots',()=>pluto.runPlots(context));
      else if(phase==='pluto-start-stop')await runCase('native-pluto-first-prepared-start-stop',()=>pluto.runStartStop(context));
      else if(phase==='mcp-pluto'){
        await runCase('native-mcp-controls',()=>mcp.run(context));
        await runCase('native-pluto-controls',()=>pluto.run(context));
        await runCase('native-discovery-and-sync-after-pluto',async()=>{
          const discovery=await vscode.commands.executeCommand('perfchecker.discoverScenarios');
          const sync=await vscode.commands.executeCommand('perfchecker.syncScenarios');
          assert.equal(discovery.schema_version,'perfchecker-discovery/1');
          assert.equal(sync.schema_version,'perfchecker-scenario-sync/1');
          assert.equal(sync.discovery.schema_version,'perfchecker-discovery/1');
          proof('native-discovery-after-pluto',{generatedNotebookPresent:true,core:context.core,commandsCompleted:true,returnedReportsValidated:true});
        });
      }else if(phase==='studio-ordering')await runCase('native-plan-pagination-and-ordering',()=>controls.runOrdering(context));
      else if(phase==='workbench')await runCase('native-workbench-controls',()=>workbench.run(context));
      else if(phase==='testitems')await runCase('native-testitem-missing-target',()=>measureNativeTestItem(context,false));
      else if(phase==='testitems-ready')await runCase('native-testitem-measurement',()=>measureNativeTestItem(context,true,{samples:settings.get('testItemSamples',1)}));
      else if(phase==='suite')await runSuiteCases(context,runCase,{complete:true,blockDependents:true});
      else if(phase==='diagnosis')await runCase('native-diagnosis-controls',()=>investigations.runDiagnosis(context));
      else if(phase==='pluto')await runCase('native-pluto-controls',()=>pluto.run(context));
      else if(phase==='advisor')await runCase('native-advisor-controls',()=>advisor.run(context));
      else if(phase==='investigation-limits')await runCase('native-investigation-limits',()=>require('./native-investigation-limits.cjs').run(context));
      else if(phase==='investigation')await runCase('native-investigation-controls',()=>investigations.run(context));
      else if(phase==='editor'){
        const editor=require('./native-editor-actions.cjs');
        const qualification=process.platform==='linux'?await editor.beginQualification(context):undefined;
        let effectsCompleted=true;
        const editorCase=async(name,run)=>{const completed=await runCase(name,run);effectsCompleted&&=completed;};
        try{
          await editorCase('native-suite-worker-output',()=>editor.runSuiteLog(context));
          await editorCase('native-testitem-tag-selection-and-samples',()=>editor.runTestItems(context));
          await editorCase('native-codelens-and-quickfix',()=>editor.run(context));
          await editorCase('native-active-controller-runtime-settings',()=>editor.runActiveSettings(context));
          await editorCase('native-mcp-custom-arguments',()=>mcp.run(context,{customArguments:true}));
        }finally{if(qualification)await runCase('native-editor-effects-and-cleanup',()=>qualification.finish(effectsCompleted));}
      }
      else if(phase==='studio'){
        await runCase('native-suite-run-button',async()=>{context.results=await controls.runSelection(context);});
        await runCase('native-focused-result-measurements',async()=>{
          const plan=JSON.parse(await fs.readFile(path.join(process.env.PERFCHECKER_NATIVE_PROFILE,'User','globalStorage','mirage-interactive-fr.perfchecker-vscode','suite-plan.json'),'utf8'));
          const examples=plan.runs.filter(run=>run.status==='ready'&&run.package==='Example');
          const sampled=['profile','wall_profile','profile_alloc','alloc'].map(backend=>{
            const run=plan.runs.find(run=>run.status==='ready'&&run.package==='PerfCheckerNativeFixture'&&run.feature===`sum_squares_${backend}`);
            assert(run,`A real ${backend} workload is available for the focused Results controls`);return run;
          });
          assert.equal(examples.length,4,'Four registered Example versions supply real series and distributions');
          await vscode.commands.executeCommand('perfchecker.runNode',{runs:[...sampled,...examples]});
          const report=JSON.parse(await fs.readFile(path.join(context.results,'suite-result.json'),'utf8'));
          assert.equal(report.runs.length,8);assert(report.runs.every(run=>run.status==='pass'));
          proof('native-focused-result-measurements',{checks:8,collectors:['profile','wall_profile','profile_alloc','alloc','benchmark'],versions:examples.map(run=>run.version),source:'Actual Julia workers; no synthetic reports'});
        });
        await runCase('native-all-studio-controls',()=>controls.run(context));
      }else throw new Error(`Unsupported focused native control group: ${phase}`);
    }else if(phase==='reload'){
      await runCase('native-single-folder-reload',()=>require('./native-reload-host.cjs').run(context));
    }else if (phase === 'fresh') {
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
        await runSuiteCases(context,runCase,{testItem:true,complete:process.env.PERFCHECKER_NATIVE_STAGE==='full'});
        if (process.env.PERFCHECKER_NATIVE_STAGE === 'full') {
          await runCase('native-all-studio-controls', () => controls.run(context));
          await runCase('native-workbench-controls',()=>workbench.run(context));
          await runCase('native-investigation-controls', () => investigations.run(context));
          await runCase('native-investigation-limits',()=>require('./native-investigation-limits.cjs').run(context));
          await runCase('native-enabled-narrative-protocol',()=>require('./native-narrative-controls.cjs').run(context));
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
