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
async function packagedFiles(root,directories=['dist','media','resources']){
  const files={};
  const visit=async relative=>{
    for(const item of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
      const file=path.join(relative,item.name);assert(!item.isSymbolicLink(),'Packaged runtime must not redirect to a development checkout');
      if(item.isDirectory())await visit(file);else files[file]=hash(await fs.readFile(path.join(root,file)));
    }
  };
  for(const directory of directories)await visit(directory);
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

async function nativeWindowSnapshot(page,{output,label,session}){
  const x11=async(command,args)=>{
    try{return {command,args,stdout:(await execute(command,args,{env:{...process.env,DISPLAY:process.env.PERFCHECKER_PRIVATE_DISPLAY},timeout:5000})).stdout};}
    catch(error){return {command,args,error:String(error),stdout:error.stdout,stderr:error.stderr};}
  };
  const snapshot=async()=>{
    const geometry=await page.evaluate(()=>({innerWidth,innerHeight,outerWidth,outerHeight,screenX,screenY,devicePixelRatio,
      screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight},
      visualViewport:visualViewport&&{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale},
      document:{clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}}));
    const pixels=await page.screenshot({path:path.join(output,`${label}.png`),scale:'device'});
    const tree=await x11('/usr/bin/xwininfo',['-root','-tree']);
    const windows=[];
    for(const id of new Set([...String(tree.stdout||'').matchAll(/^\s+(0x[0-9a-f]+)\s+/gm)].map(match=>match[1]))){
      const properties=await x11('/usr/bin/xprop',['-id',id,'_NET_WM_PID','WM_CLASS','_NET_WM_STATE','_NET_FRAME_EXTENTS']);
      const pid=Number(properties.stdout?.match(/_NET_WM_PID[^=]*=\s*(\d+)/)?.[1]);
      if(!pid)continue;
      const executable=await fs.realpath(`/proc/${pid}/exe`).catch(()=>undefined);
      if(!executable?.startsWith(session+path.sep))continue;
      windows.push({id,pid,executable,start:await processIdentity(pid),properties,
        geometry:await x11('/usr/bin/xwininfo',['-id',id]),
        affinity:(await fs.readFile(`/proc/${pid}/status`,'utf8')).match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1]});
    }
    const nativePath=path.join(output,`${label}-native-x11.png`);
    let native,captureError;
    try{
      await execute('/usr/bin/import',['-display',process.env.PERFCHECKER_PRIVATE_DISPLAY,'-window','root',nativePath],
        {env:{...process.env,DISPLAY:process.env.PERFCHECKER_PRIVATE_DISPLAY,MAGICK_THREAD_LIMIT:'2'},timeout:10000});
      native=await fs.readFile(nativePath);
    }catch(error){captureError=String(error);}
    const visible=windows.filter(window=>/Map State: IsViewable/.test(window.geometry.stdout||''));
    const occupation=visible.length===1&&/Absolute upper-left X:\s*0\s/.test(visible[0].geometry.stdout)&&
      /Absolute upper-left Y:\s*0\s/.test(visible[0].geometry.stdout)&&/Width:\s*1920\s/.test(visible[0].geometry.stdout)&&
      /Height:\s*1080\s/.test(visible[0].geometry.stdout)&&/Border width:\s*0\s/.test(visible[0].geometry.stdout);
    const observation={label,at:new Date().toISOString(),geometry,rendererPng:{width:pixels.readUInt32BE(16),height:pixels.readUInt32BE(20),sha256:hash(pixels)},
      nativeX11Png:native?{width:native.readUInt32BE(16),height:native.readUInt32BE(20),sha256:hash(native),windowOccupationQualified:occupation}:{error:captureError,windowOccupationQualified:false},
      xrandr:await x11('/usr/bin/xrandr',['--current']),tree,rootProperties:await x11('/usr/bin/xprop',['-root','_NET_SUPPORTING_WM_CHECK','_NET_SUPPORTED','_NET_CLIENT_LIST']),windows};
    return observation;
  };

  return snapshot();
}
async function studioThemeCaptures(page,result,{output,session}){
  const nativeChildren=async()=>{
    const request=execute('ps',['-eo','pid=,ppid='],{timeout:5000}),observer=request.child?.pid;
    const rows=(await request).stdout.split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(\d+)\s*$/.exec(line);return match?[{pid:Number(match[1]),parent:Number(match[2])}]:[];});
    const observerRow=rows.find(row=>row.pid===observer);if(observerRow)assert.equal(observerRow.parent,process.pid,'Only the identified inspection child is excluded');
    const descendants=new Set([process.pid]);for(let changed=true;changed;){changed=false;for(const row of rows)if(row.pid!==observer&&descendants.has(row.parent)&&!descendants.has(row.pid)){descendants.add(row.pid);changed=true;}}
    const records=[];for(const row of rows.filter(row=>descendants.has(row.pid)&&row.pid!==process.pid)){
      const start=await processIdentity(row.pid);if(!start)continue;
      let executable;try{executable=await fs.realpath(`/proc/${row.pid}/exe`);}catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw error;}
      assert.equal(await processIdentity(row.pid),start);records.push({...row,start,executable});
    }
    assert(!records.some(row=>/^(?:julia|codex)(?:\.exe)?$/.test(path.basename(row.executable))),'Opening Studio and changing theme must not start Julia or an agent');
    return {observedAt:new Date().toISOString(),scope:'Actual extension-host descendants, not unobserved detached daemons',records};
  };
  result.nativeProcessObservations=[await nativeChildren()];result.themes=[];
  await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.workspace.workspaceFolders[0].uri);
  await vscode.commands.executeCommand('workbench.action.joinAllGroups');
  for(const [name,kind,bodyClass,label]of [['Default Light Modern',vscode.ColorThemeKind.Light,'vscode-light','studio-light'],['Default Dark Modern',vscode.ColorThemeKind.Dark,'vscode-dark','studio-dark']]){
    await vscode.workspace.getConfiguration('workbench').update('colorTheme',name,vscode.ConfigurationTarget.Global);
    let studio;
    await eventually(async()=>{
      if(vscode.window.activeColorTheme.kind!==kind)return false;
      for(const frame of page.frames()){
        const root=frame.locator('#studio-root');if(!await root.isVisible().catch(()=>false))continue;
        if(!/Feature suite/.test(await root.innerText()))continue;
        if(!await frame.evaluate(expected=>document.body.classList.contains(expected),bodyClass))continue;
        let visible=true;for(let current=frame;current.parentFrame();current=current.parentFrame()){const owner=await current.frameElement();visible&&=await owner.isVisible();await owner.dispose();}
        if(visible){studio=frame;return true;}
      }
      return false;
    },'The actual Studio cards and selected theme are painted before capture',20000);
    const tab=page.locator('.tabs-container .tab.active').filter({hasText:'PerfChecker'});assert.equal(await tab.count(),1);assert(await tab.isVisible());
    const tabRendering=await tab.evaluate(element=>({text:element.textContent,rectangle:element.getBoundingClientRect().toJSON(),icons:[...element.querySelectorAll('[class*=icon]')].map(icon=>{const style=getComputedStyle(icon);return {class:icon.className,backgroundImage:style.backgroundImage,maskImage:style.maskImage,color:style.color,rectangle:icon.getBoundingClientRect().toJSON()};})}));
    await studio.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const capture=await nativeWindowSnapshot(page,{output,label,session});
    assert.equal(capture.nativeX11Png.width,1920);assert.equal(capture.nativeX11Png.height,1080);assert(capture.nativeX11Png.windowOccupationQualified);
    const owner=capture.windows.find(window=>window.id===result.nativeWindowIdentity.id);assert.equal(owner?.pid,result.nativeWindowIdentity.pid);assert.equal(owner?.start,result.nativeWindowIdentity.start);
    assert.equal(await processIdentity(result.privateWindowManager.pid),result.privateWindowManager.start);
    assert(capture.rootProperties.stdout.includes(result.privateWindowManager.xid));
    result.themes.push({name,kind,tabRendering,capture});result.nativeProcessObservations.push(await nativeChildren());
    assert.deepEqual(await fs.readdir(path.join(session,'empty-workspace')),[]);
    await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result,null,2));
  }
}
async function framingOnly({studioThemes=false}={}){
  assert(!process.env.CI);assert.equal(process.platform,'linux');
  const session=await fs.realpath(process.env.PERFCHECKER_HOST_SESSION),output=process.env.PERFCHECKER_FRAMING_OUTPUT;
  const root=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  assert.equal(root,path.join(session,'empty-workspace'));
  assert.equal(process.env.DISPLAY,process.env.PERFCHECKER_PRIVATE_DISPLAY);
  assert(/^:\d+$/.test(process.env.DISPLAY));
  assert.equal(process.env.WAYLAND_DISPLAY,undefined,'The private framing child must not inherit a Wayland connection');
  assert.deepEqual(await fs.readdir(root),[],'Framing has no Julia sources, settings, evidence or advisor fixture');
  const result={runner:'bibliography-pilot-host.cjs',mode:studioThemes?'studio-theme-only':'framing-only',hostExecuted:true,hostPid:process.pid,status:'running',observations:[],measurements:0,agentRequests:0,privateWindowManager:JSON.parse(process.env.PERFCHECKER_PRIVATE_WM)};
  assert.equal(await processIdentity(result.privateWindowManager.pid),result.privateWindowManager.start);
  assert.equal(await fs.realpath(`/proc/${result.privateWindowManager.pid}/exe`),result.privateWindowManager.executable);
  assert.equal(result.privateWindowManager.affinity,'16-17');
  let browser,primaryError;
  suiteDeadline=Date.now()+90000;
  const snapshot=async(page,label)=>{
    const observation=await nativeWindowSnapshot(page,{output,label,session});
    result.observations.push(observation);await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result,null,2));return observation;
  };
  try{
    const extension=vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode');assert(extension);
    assert.equal(vscode.version,'1.141.0');assert.equal(extension.packageJSON.version,'1.0.1');
    assert((await fs.realpath(extension.extensionPath)).startsWith(path.join(session,'extensions')+path.sep));
    if(studioThemes){
      result.candidate={sha256:process.env.PERFCHECKER_UI_VSIX_SHA,size:Number(process.env.PERFCHECKER_UI_VSIX_SIZE),source:process.env.PERFCHECKER_UI_SOURCE_COMMIT,tree:process.env.PERFCHECKER_UI_SOURCE_TREE};
      assert(/^[a-f0-9]{64}$/.test(result.candidate.sha256));assert(Number.isSafeInteger(result.candidate.size)&&result.candidate.size>0);
      assert(/^[a-f0-9]{40}$/.test(result.candidate.source));assert(/^[a-f0-9]{40}$/.test(result.candidate.tree));
      assert.equal(hash(await fs.readFile(process.env.PERFCHECKER_HOST_ARCHIVE)),result.candidate.sha256);assert.equal((await fs.stat(process.env.PERFCHECKER_HOST_ARCHIVE)).size,result.candidate.size);
      for(const key of ['PERFCHECKER_TEST_CONTROLLER','PERFCHECKER_TEST_JULIA','PERFCHECKER_TEST_CODEX','JULIA_DEPOT_PATH','JULIA_LOAD_PATH'])assert.equal(process.env[key],undefined);
      result.scope='Unpublished candidate; two real Studio tab/theme captures only; no Core or authenticated conversation qualification';
      result.nativeHostIdentity={pid:process.pid,parent:process.ppid,start:await processIdentity(process.pid),executable:await fs.realpath('/proc/self/exe')};
      assert(result.nativeHostIdentity.start);assert(result.nativeHostIdentity.executable.startsWith(session+path.sep));
    }else assert.equal(hash(await fs.readFile(process.env.PERFCHECKER_HOST_ARCHIVE)),'ff5a1af088ababeccd0847f27bcd2e6c0f7e9c0f894b37e35e5711d7b044857d');
    assert.deepEqual(await packagedFiles(extension.extensionPath),await packagedFiles(process.env.PERFCHECKER_HOST_ARCHIVE_EXTENSION));
    await extension.activate();
    const {chromium}=await import(pathToFileURL(process.env.PERFCHECKER_TEST_PLAYWRIGHT).href);
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PERFCHECKER_HOST_CDP_PORT}`);
    const page=await eventually(()=>browser.contexts().flatMap(context=>context.pages()).find(value=>value.url().includes('workbench')),'Locate private native workbench',20000);
    await vscode.commands.executeCommand('workbench.action.joinAllGroups');
    const before=await snapshot(page,'before-fullscreen');
    const visible=before.windows.filter(window=>/Map State: IsViewable/.test(window.geometry.stdout||''));
    assert.equal(visible.length,1,'One visible private X11 window must be identified before fullscreen');
    assert(visible[0].start,'The private XID has a live process start identity');
    assert.equal(visible[0].affinity,'16-17','The private native main process inherits the shared CPU mask');
    result.nativeWindowIdentity={id:visible[0].id,pid:visible[0].pid,executable:visible[0].executable,start:visible[0].start,affinity:visible[0].affinity};
    await vscode.commands.executeCommand('workbench.action.toggleFullScreen');
    // Keep the original physical assertion; capture the failure rather than relaxing it.
    try{await eventually(async()=>{const value=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));result.lastFullscreenGeometry=value;return Math.round(value.width*value.dpr)===1920&&Math.round(value.height*value.dpr)===1080;},'Private fullscreen must really be 1920 by 1080',20000);}
    catch(error){primaryError=error;}
    await snapshot(page,'after-fullscreen');
    await vscode.workspace.getConfiguration('zenMode').update('centerLayout',false,vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('zenMode').update('fullScreen',false,vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.toggleZenMode');
    for(let i=0;i<2;i++)await vscode.commands.executeCommand('workbench.action.zoomIn');
    const final=await snapshot(page,'after-zen-and-zoom');
    assert.equal(final.nativeX11Png.width,1920);assert.equal(final.nativeX11Png.height,1080);
    assert(final.nativeX11Png.windowOccupationQualified,'The identified private native window must occupy the physical capture');
    const owner=final.windows.find(window=>window.id===result.nativeWindowIdentity.id);
    assert.equal(owner?.pid,result.nativeWindowIdentity.pid);assert.equal(owner?.start,result.nativeWindowIdentity.start);
    assert.equal(await processIdentity(result.privateWindowManager.pid),result.privateWindowManager.start);
    assert(final.rootProperties.stdout.includes(result.privateWindowManager.xid),'The same private WM owns the final X11 root');
    if(studioThemes&&!primaryError)await studioThemeCaptures(page,result,{output,session});
    result.status=primaryError?'failed':'passed';
  }catch(error){primaryError??=error;result.status='failed';}
  finally{
    if(primaryError){result.error=String(primaryError);result.stack=primaryError.stack;result.status='failed';}
    await browser?.close();
    await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result,null,2));
  }
  if(primaryError)throw primaryError;
}

async function publicLesson(){
  const mode=process.env.PERFCHECKER_PUBLIC_LESSON,setup=await fs.realpath(process.env.PERFCHECKER_PUBLIC_SETUP),workspace=await fs.realpath(process.env.PERFCHECKER_PUBLIC_WORKSPACE);
  assert(['installation','installation-continuation','testitem','testitem-continuation','reports-only'].includes(mode));assert.equal(process.platform,'linux');assert(!process.env.CI);
  const reportsOnly=mode==='reports-only',itemLesson=mode==='testitem'||mode==='testitem-continuation'||reportsOnly;
  assert(setup.startsWith('/tmp/perfchecker-public-lesson-'));assert.equal(vscode.workspace.workspaceFolders.length,1);
  assert.equal(await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath),workspace);assert(vscode.workspace.isTrusted);
  assert.equal(process.env.DISPLAY,process.env.PERFCHECKER_PRIVATE_DISPLAY);assert.equal(process.env.WAYLAND_DISPLAY,undefined);
  assert.equal(process.env.JULIA_DEPOT_PATH,path.join(setup,'depot'));assert.equal(process.env.JULIA_LOAD_PATH,['@','@stdlib'].join(path.delimiter));
  assert.equal(hash(await fs.readFile(process.env.PERFCHECKER_HOST_ARCHIVE)),'c4123271e71e4c4d148fe0e613ba260f4aeea6f28445338cab11d3fb9513df09');
  assert.equal(vscode.version,'1.141.0');assert.equal(vscode.workspace.getConfiguration('files').get('simpleDialog.enable'),true);
  const output=process.env.PERFCHECKER_FRAMING_OUTPUT,controller=path.join(workspace,'perf/controller');
  const result={mode:`public-${mode}`,status:'running',workspace,setup,hostPid:process.pid,maximumMinutes:itemLesson?8:12,measurements:0,agentRequests:0,steps:[],captures:[],nativeIdentities:[],processObservationErrors:[]};
  if(mode==='testitem-continuation'){
    const bytes=await fs.readFile(process.env.PERFCHECKER_PUBLIC_TESTITEM_RECEIPT),parent=JSON.parse(bytes);
    assert.equal(hash(bytes),'665ecc3e0326981bbe9bf6cc5cdcce935f0d70742022fd2873f704a3a89faa63');
    assert.equal(parent.mode,'public-testitem');assert.equal(parent.status,'failed');assert.equal(parent.measurements,0);assert.equal(parent.agentRequests,0);
    assert.equal(parent.setup,setup);assert.equal(parent.workspace,workspace);
    assert.equal(parent.runnerState.nativeShutdown.qualified,true);assert.equal(parent.runnerState.windowManagerCleanup.originalIdentityGone,true);
    assert.equal(parent.testItemSource.sha256,'df13f23d706576c86e9d88edfca27fa805df2c4ebcfd71b302f942a687abdaf5');
    assert.equal(await fs.realpath(parent.testItemSource.file),path.join(workspace,'test/performance.jl'));
    assert.equal(hash(await fs.readFile(parent.testItemSource.file)),parent.testItemSource.sha256);
    result.failedTestItemParent={file:process.env.PERFCHECKER_PUBLIC_TESTITEM_RECEIPT,sha256:hash(bytes),hostError:parent.hostError,juliaCleanup:parent.juliaCleanup};
    result.sourcePrepared=true;
    const locatorBytes=await fs.readFile(process.env.PERFCHECKER_PUBLIC_LOCATOR_RECEIPT),locatorParent=JSON.parse(locatorBytes);
    assert.equal(hash(locatorBytes),'78f3ad86797fc4ebe915d765e42ffebf2f78b488b7bcc183c0d7abf6053c55aa');
    assert.equal(locatorParent.status,'failed');assert.equal(locatorParent.measurements,0);assert.equal(locatorParent.setup,setup);assert.equal(locatorParent.workspace,workspace);
    result.failedLocatorParent={file:process.env.PERFCHECKER_PUBLIC_LOCATOR_RECEIPT,sha256:hash(locatorBytes),hostError:locatorParent.hostError};
  }
  if(mode==='installation-continuation'){
    const parent=JSON.parse(await fs.readFile(process.env.PERFCHECKER_PUBLIC_INSTALLATION_RECEIPT,'utf8'));
    assert.equal(parent.status,'failed');assert.equal(parent.workspace,workspace);assert.equal(parent.setup,setup);
    assert.equal(parent.runnerState.nativeShutdown.qualified,true);assert.equal(parent.runnerState.windowManagerCleanup.originalIdentityGone,true);
    result.failedParent={file:process.env.PERFCHECKER_PUBLIC_INSTALLATION_RECEIPT,sha256:hash(await fs.readFile(process.env.PERFCHECKER_PUBLIC_INSTALLATION_RECEIPT)),startedAt:parent.startedAt,error:parent.error};
    result.controllerPrepared=true;result.controllerHashesBefore=JSON.parse(process.env.PERFCHECKER_PUBLIC_CONTROLLER_HASHES);
    assert.deepEqual(Object.fromEntries(await Promise.all(['Project.toml','Manifest.toml'].map(async name=>[name,hash(await fs.readFile(path.join(controller,name)))]))),result.controllerHashesBefore);
  }
  if(reportsOnly){
    const parentBytes=await fs.readFile(process.env.PERFCHECKER_PUBLIC_EVIDENCE_RECEIPT),parent=JSON.parse(parentBytes);
    assert.equal(hash(parentBytes),'8763117caee01945dbf3db2b9e9446b406cdc5ab6e81efd0ad3d4366069a51cf');
    assert.equal(parent.mode,'public-testitem-continuation');assert.equal(parent.status,'failed');assert.equal(parent.measurements,1);assert.equal(parent.intentionalItemLaunches,1);assert.equal(parent.agentRequests,0);
    assert.equal(parent.setup,setup);assert.equal(parent.workspace,workspace);assert.equal(parent.publicArchive.sha256,'c4123271e71e4c4d148fe0e613ba260f4aeea6f28445338cab11d3fb9513df09');
    assert.equal(parent.nativeShutdown.qualified,true);assert.equal(parent.windowManagerCleanup.originalIdentityGone,true);
    assert.deepEqual(parent.juliaCleanup.signals,[]);assert.deepEqual(parent.juliaCleanup.remaining,[]);assert.deepEqual(parent.processObservationErrors,[]);
    assert.equal(parent.testItemSource.file,path.join(workspace,'test/performance.jl'));assert.equal(parent.testItemSource.sha256,'df13f23d706576c86e9d88edfca27fa805df2c4ebcfd71b302f942a687abdaf5');
    assert.equal(await fs.realpath(parent.testItemSource.file),parent.testItemSource.file);assert.equal(hash(await fs.readFile(parent.testItemSource.file)),parent.testItemSource.sha256);
    for(const [name,sha]of Object.entries(parent.controllerHashes))assert.equal(hash(await fs.readFile(path.join(workspace,'perf/controller',name))),sha);
    const evidenceFile=parent.evidence.file,info=await fs.lstat(evidenceFile);assert(info.isFile()&&!info.isSymbolicLink());assert.equal(await fs.realpath(evidenceFile),evidenceFile);
    assert.equal(path.dirname(path.dirname(evidenceFile)),path.join(setup,'profile/User/globalStorage/mirage-interactive-fr.perfchecker-vscode/native-testitems'));assert.equal(path.basename(evidenceFile),'result.json');
    const bytes=await fs.readFile(evidenceFile),payload=JSON.parse(bytes);assert.equal(hash(bytes),parent.evidence.sha256);
    assert.equal(payload.schema_version,'perfchecker-testitem-run/1');assert.equal(payload.root,workspace);assert.equal(payload.passed,true);assert.equal(payload.runs.length,1);
    const run=payload.runs[0];assert.equal(run.status,'validated');assert.deepEqual(run.item,parent.evidence.item);assert.equal(run.item.source_sha256,parent.testItemSource.sha256);assert.equal(run.samples.length,1);assert.deepEqual(run.samples[0],parent.evidence.sample);
    assert.equal(run.samples[0].correctness,'passed');assert.equal(run.samples[0].passes,1);assert.equal(run.samples[0].errors,0);assert.equal(run.samples[0].failures,0);
    result.existingEvidenceParent={file:process.env.PERFCHECKER_PUBLIC_EVIDENCE_RECEIPT,sha256:hash(parentBytes),hostError:parent.hostError};
    result.evidence=parent.evidence;result.controllerHashes=parent.controllerHashes;result.testItemSource={...parent.testItemSource,createdInThisTake:false};result.inspectedMeasurements=1;result.sourcePrepared=true;result.intentionalItemLaunches=0;
    result.nativeEvidenceDirectoriesBefore=JSON.parse(process.env.PERFCHECKER_PUBLIC_EVIDENCE_DIRECTORIES);assert(Array.isArray(result.nativeEvidenceDirectoriesBefore));
    assert.deepEqual((await fs.readdir(path.dirname(path.dirname(evidenceFile)))).sort(),result.nativeEvidenceDirectoriesBefore,'No evidence directory appeared between runner pre-SDK inventory and host activation');
  }
  suiteDeadline=Number(process.env.PERFCHECKER_PUBLIC_DEADLINE);
  assert(Number.isFinite(suiteDeadline)&&suiteDeadline>Date.now(),'The public runner supplies its actual remaining filming deadline');
  const save=()=>fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result,null,2));
  const identities=new Map();let browser,page,mainPid,observation=Promise.resolve(),observing=false,timer,primaryError;
  const terminals=[];
  const juliaIdentity=async row=>{
    const stat=await fs.readFile(`/proc/${row.pid}/stat`,'utf8').catch(error=>{if(['ENOENT','ESRCH'].includes(error.code))return undefined;throw error;});
    if(!stat)return undefined;const fields=stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/);
    assert(/^\d+$/.test(fields[19]));if(fields[19]!==row.start||/^[ZX]$/.test(fields[0]))return undefined;
    let executable;try{executable=await fs.realpath(`/proc/${row.pid}/exe`);}catch(error){if(['ENOENT','ESRCH'].includes(error.code))return undefined;throw error;}
    assert.equal(executable,row.executable,'Cleanup only addresses the observed Julia executable');
    const after=await fs.readFile(`/proc/${row.pid}/stat`,'utf8').catch(error=>{if(['ENOENT','ESRCH'].includes(error.code))return undefined;throw error;});
    if(!after)return undefined;const current=after.slice(after.lastIndexOf(') ')+2).trim().split(/\s+/);
    if(current[19]!==row.start||/^[ZX]$/.test(current[0]))return undefined;
    return row;
  };
  const observe=()=>{
    if(observing)return observation;observing=true;
    observation=(async()=>{
    if(mainPid)assert.equal(await processIdentity(mainPid),result.mainIdentity.start,'Observe only the original native main incarnation');
    const request=execute('/usr/bin/ps',['-eo','pid=,ppid='],{timeout:5000}),observer=request.child?.pid;
    const rows=(await request).stdout.split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(\d+)\s*$/.exec(line);return match?[{pid:Number(match[1]),parent:Number(match[2])}]:[];});
    const observerRow=rows.find(row=>row.pid===observer);if(observerRow)assert.equal(observerRow.parent,process.pid);
    const roots=new Set([process.pid,mainPid].filter(Boolean));for(let changed=true;changed;){changed=false;for(const row of rows)if(row.pid!==observer&&roots.has(row.parent)&&!roots.has(row.pid)){roots.add(row.pid);changed=true;}}
    for(const row of rows.filter(row=>roots.has(row.pid)&&row.pid!==observer)){
      const start=await processIdentity(row.pid);if(!start)continue;
      let executable;try{executable=await fs.realpath(`/proc/${row.pid}/exe`);}catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw error;}
      assert.equal(await processIdentity(row.pid),start);
      const affinity=(await fs.readFile(`/proc/${row.pid}/status`,'utf8')).match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1];assert.equal(affinity,'16-17');
      const prior=identities.get(`${row.pid}/${start}`);if(prior)assert.equal(executable,prior.executable,'An observed incarnation must not silently change executable');
      identities.set(`${row.pid}/${start}`,{...row,start,executable,affinity});
    }
    result.nativeIdentities=[...identities.values()];await save();
    })().catch(async error=>{result.processObservationErrors.push({at:new Date().toISOString(),error:String(error)});await save();}).finally(()=>{observing=false;});
    return observation;
  };
  const capture=async label=>{
    const panelView=/julia-and-package-root|controller-installation|resolved-controller|output-evidence-path|new-session-output-channel-state/.test(label),testingView=/item-discovered-before-run|item-real-passed/.test(label);
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    if(!testingView)await vscode.commands.executeCommand('workbench.action.closeSidebar');
    if(panelView){
      const tall=()=>page.locator('.part.panel').evaluate(node=>node.getBoundingClientRect().height>=innerHeight*0.8);
      if(!await tall())await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
      await eventually(tall,'The actual lesson panel occupies most of the viewport',5000);
    }else await vscode.commands.executeCommand('workbench.action.closePanel');
    await delay(200);
    const framing=await page.evaluate(()=>Object.fromEntries(['auxiliarybar','sidebar','panel'].map(name=>{const node=document.querySelector(`.part.${name}`),r=node?.getBoundingClientRect();return[name,r?{width:r.width,height:r.height,visible:getComputedStyle(node).display!=='none'&&r.width>0&&r.height>0}:null];})));
    assert(!framing.auxiliarybar?.visible);if(!testingView)assert(!framing.sidebar?.visible);
    result.steps.push({label:'native-framing',view:label,at:new Date().toISOString(),secondarySidebarClosed:true,primarySidebarClosed:!testingView,panelMaximized:panelView,geometry:framing});
    await observe();assert(!result.processObservationErrors.length);
    const value=await nativeWindowSnapshot(page,{output,label,session:setup});
    assert.equal(value.nativeX11Png.width,1920);assert.equal(value.nativeX11Png.height,1080);assert(value.nativeX11Png.windowOccupationQualified);
    const current=value.windows.find(row=>row.pid===mainPid);assert(current);assert.equal(await processIdentity(mainPid),result.mainIdentity.start);
    const wm=JSON.parse(process.env.PERFCHECKER_PRIVATE_WM);assert.equal(await processIdentity(wm.pid),wm.start);assert(value.rootProperties.stdout.includes(wm.xid));
    result.captures.push({label,...value});await save();
  };
  const palette=async label=>{
    await vscode.commands.executeCommand('workbench.action.showCommands');
    const input=page.locator('.quick-input-widget input:visible');assert.equal(await input.count(),1);await input.fill(`>${label}`);
    const row=page.locator('.quick-input-widget .monaco-list-row').filter({hasText:label});await row.waitFor({state:'visible',timeout:10000});assert.equal(await row.count(),1);await row.click();
  };
  const runJulia=async(terminal,script,label,timeout)=>{
    const file=path.join(output,`${label}.json`),startedAt=new Date().toISOString();
    terminal.show();await observe();
    terminal.sendText(`begin\n${script}\n@assert VERSION>=v"1.10"\n@assert Base.pkgversion(TestItemRunner)>=v"1.3.2"\nthread_masks=Dict(id=>match(r"(?m)^Cpus_allowed_list:\\s*(.*)$",read("/proc/self/task/"*id*"/status",String)).captures[1] for id in readdir("/proc/self/task"))\n@assert all(==("16-17"),values(thread_masks))\nopen(${JSON.stringify(file)}, "w") do io; PerfChecker.JSON.print(io, Dict("julia"=>string(VERSION),"core"=>string(Base.pkgversion(PerfChecker)),"controller"=>Base.active_project(),"cwd"=>pwd(),"package"=>pkgdir(PerfCheckerFirstTestItem),"runner"=>string(Base.pkgversion(TestItemRunner)),"threads"=>Threads.nthreads(),"thread_masks"=>thread_masks,"depot"=>DEPOT_PATH,"load_path"=>LOAD_PATH));end\nprintln("LESSON COMPLETED: ${label}")\nend`,true);
    const receipt=await eventually(()=>fs.readFile(file,'utf8').then(JSON.parse).catch(()=>undefined),`Actual Julia terminal stage ${label} must complete`,timeout);
    assert.equal(receipt.core,'1.0.0');assert.equal(await fs.realpath(receipt.controller),await fs.realpath(path.join(controller,'Project.toml')));assert.equal(await fs.realpath(receipt.package),workspace);
    assert.equal(receipt.threads,2);assert(Object.keys(receipt.thread_masks).length>=2);assert(Object.values(receipt.thread_masks).every(mask=>mask==='16-17'));assert.deepEqual(receipt.load_path,['@','@stdlib']);assert.deepEqual(receipt.depot,[path.join(setup,'depot')]);assert(/^1\.(?:[3-9]|\d{2,})\./.test(receipt.runner));
    result.steps.push({label,startedAt,finishedAt:new Date().toISOString(),receipt});
    await vscode.commands.executeCommand('workbench.action.terminal.clear');
    for(const expression of ['VERSION','Base.active_project()','Base.pkgversion(PerfChecker)','Pkg.status("PerfChecker")']){
      terminal.sendText(expression,true);await delay(300);
    }
    result.steps.push({label:'native-terminal-teaching-view',stage:label,at:new Date().toISOString(),clearCommand:'workbench.action.terminal.clear',expressions:['VERSION','Base.active_project()','Base.pkgversion(PerfChecker)','Pkg.status("PerfChecker")'],outsideBegin:true});
    await capture(label);return receipt;
  };
  try{
    await save();
    const {chromium}=await import(pathToFileURL(process.env.PERFCHECKER_TEST_PLAYWRIGHT).href);browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PERFCHECKER_HOST_CDP_PORT}`);
    page=await eventually(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('workbench')),'Find the private lesson workbench',20000);
    const before=await nativeWindowSnapshot(page,{output,label:'initial-private-window',session:setup});const visible=before.windows.filter(row=>/Map State: IsViewable/.test(row.geometry.stdout||''));assert.equal(visible.length,1);
    result.mainIdentity=visible[0];mainPid=visible[0].pid;assert(/^\d+$/.test(visible[0].start));assert(visible[0].executable.startsWith(setup+path.sep));assert.equal(visible[0].affinity,'16-17');
    await observe();timer=setInterval(()=>{void observe();},1000);
    await vscode.commands.executeCommand('workbench.action.joinAllGroups');await vscode.commands.executeCommand('workbench.action.toggleFullScreen');
    await eventually(async()=>{const g=await page.evaluate(()=>({w:innerWidth,h:innerHeight,d:devicePixelRatio}));return Math.round(g.w*g.d)===1920&&Math.round(g.h*g.d)===1080;},'Actual public lesson fullscreen',20000);
    for(let n=0;n<2;n++)await vscode.commands.executeCommand('workbench.action.zoomIn');
    if(mode==='installation'){
      assert.equal(vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode'),undefined);
      assert(!await fs.stat(controller).catch(()=>undefined));result.controllerInitiallyAbsent=true;
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace,'Project.toml'))),{preview:false});await capture('fresh-package-no-controller');
      const terminal=vscode.window.createTerminal({name:'Public PerfChecker installation',cwd:workspace,shellPath:process.env.PERFCHECKER_PUBLIC_JULIA,shellArgs:['--startup-file=no','--threads=2',`--project=${workspace}`],env:{JULIA_DEPOT_PATH:path.join(setup,'depot'),JULIA_LOAD_PATH:['@','@stdlib'].join(path.delimiter)}});terminals.push(terminal);terminal.show();
      const terminalPid=await terminal.processId;assert(terminalPid);result.installationTerminal={pid:terminalPid,start:await processIdentity(terminalPid),executable:await fs.realpath(`/proc/${terminalPid}/exe`)};assert.equal(result.installationTerminal.executable,process.env.PERFCHECKER_PUBLIC_JULIA);await observe();
      terminal.sendText('VERSION\npwd()\nisfile("Project.toml")',true);await delay(1000);await capture('julia-and-package-root');
      await runJulia(terminal,'import Pkg\nPkg.activate("perf/controller")\nPkg.add(Pkg.PackageSpec(name="PerfChecker",version="1.0.0"))\nusing PerfChecker\nBase.pkgversion(PerfChecker)\nPkg.status("PerfChecker")\nPkg.add(["TestItems","TestItemRunner"])\nPkg.develop(path=".")\nusing TestItemRunner, PerfCheckerFirstTestItem\n@assert Base.pkgversion(TestItemRunner)>=v"1.3.2"\nPkg.status()','actual-public-controller-installation',480000);
      terminal.dispose();
      await vscode.commands.executeCommand('workbench.view.extensions');await capture('before-extension-installation');
      await palette('Extensions: Install from VSIX');
      const input=page.locator('.quick-input-widget input:visible');await input.waitFor({state:'visible',timeout:10000});await input.fill(process.env.PERFCHECKER_HOST_ARCHIVE);
      const file=page.locator('.quick-input-widget .monaco-list-row').filter({hasText:path.basename(process.env.PERFCHECKER_HOST_ARCHIVE)});await file.waitFor({state:'visible',timeout:10000});assert.equal(await file.count(),1);
      await capture('visible-built-in-vsix-picker');await input.press('Enter');
      result.extensionInstallationRoute='Actual Extensions command palette / Install from VSIX / VS Code built-in file picker (files.simpleDialog.enable=true); no URI installation shortcut or CLI';
    }else if(mode==='installation-continuation'){
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace,'Project.toml'))),{preview:false});await capture('prepared-package-existing-controller');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(controller,'Project.toml'))),{preview:false});await capture('existing-public-controller-project');
    }
    const extension=await eventually(()=>vscode.extensions.getExtension('mirage-interactive-fr.perfchecker-vscode'),'The actual public extension becomes installed',60000);
    assert.equal(extension.packageJSON.version,'1.0.0');assert((await fs.realpath(extension.extensionPath)).startsWith(path.join(setup,'extensions')+path.sep));
    const actualPublicFiles=await packagedFiles(extension.extensionPath,['dist','media']);assert.equal(Object.keys(actualPublicFiles).length,30);
    assert.deepEqual(actualPublicFiles,await packagedFiles(process.env.PERFCHECKER_HOST_ARCHIVE_EXTENSION,['dist','media']));await extension.activate();
    result.installedExtension={version:extension.packageJSON.version,path:extension.extensionPath,packagedFiles:actualPublicFiles};
    await vscode.commands.executeCommand('extension.open','mirage-interactive-fr.perfchecker-vscode');await delay(500);await capture('installed-public-extension-version');
    if(!reportsOnly){
    const config=vscode.workspace.getConfiguration('perfchecker',vscode.workspace.workspaceFolders[0].uri);
    for(const [key,value]of Object.entries({juliaExecutable:process.env.PERFCHECKER_PUBLIC_JULIA,runnerProject:'perf/controller',...(itemLesson?{testItemSamples:1,testItemTags:[],testItemExcludeTags:[]}: {})}))await config.update(key,value,vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace,'.vscode/settings.json'))),{preview:false});
    if(itemLesson){
      await vscode.commands.executeCommand('editor.action.toggleWordWrap');
      result.steps.push({label:'native-settings-word-wrap',command:'editor.action.toggleWordWrap',at:new Date().toISOString(),scope:'The actual private-profile settings editor'});
    }
    await capture('actual-folder-settings');
    const priorTerminals=new Set(vscode.window.terminals);await vscode.commands.executeCommand('perfchecker.openTerminal',vscode.workspace.workspaceFolders[0].uri);
    const terminal=await eventually(()=>vscode.window.terminals.find(value=>!priorTerminals.has(value)),'The extension opens its actual Julia terminal',20000);terminals.push(terminal);
    await runJulia(terminal,'import Pkg\nusing PerfChecker, TestItemRunner, PerfCheckerFirstTestItem\nVERSION\nBase.active_project()\nPkg.status("PerfChecker")\nBase.pkgversion(PerfChecker)','extension-resolved-controller',120000);terminal.dispose();
    result.controllerHashes=Object.fromEntries(await Promise.all(['Project.toml','Manifest.toml'].map(async name=>[name,hash(await fs.readFile(path.join(controller,name)))])));
    if(mode==='installation-continuation')assert.deepEqual(result.controllerHashes,result.controllerHashesBefore,'Inspecting a prepared installation never mutates its controller');
    result.tutorialSourceHashes=Object.fromEntries(await Promise.all(['Project.toml','src/PerfCheckerFirstTestItem.jl'].map(async name=>[name,hash(await fs.readFile(path.join(workspace,name)))])));
    }
    if(reportsOnly){
      await palette('Output: Show Output Channels');
      const channel=page.locator('.quick-input-widget .monaco-list-row').filter({hasText:'PerfChecker test items'});await channel.waitFor({state:'visible',timeout:10000});assert.equal(await channel.count(),1);await channel.click();
      result.newSessionOutput={at:new Date().toISOString(),rawLines:await page.locator('.part.panel .view-line').allTextContents(),scope:'Newly activated Output channel, shown as observed; old content is neither required nor injected'};await capture('new-session-output-channel-state');
      await vscode.commands.executeCommand('workbench.action.closePanel');
      const logFile=path.join(setup,'profile/logs/20261009T053138/window1/exthost/output_logging_20261009T053141/1-PerfChecker test items.log');
      const logInfo=await fs.lstat(logFile);assert(logInfo.isFile()&&!logInfo.isSymbolicLink());assert.equal(await fs.realpath(logFile),logFile);
      const logBytes=await fs.readFile(logFile),logText=logBytes.toString('utf8');assert.equal(hash(logBytes),'edc5da8d92346be931d57b64d95681b17c13d7b8c743d643d668e145d6051c60');
      assert.equal(logText.split('\n')[11],`Evidence: ${result.evidence.file}`);
      result.savedOutputLog={file:logFile,sha256:hash(logBytes),evidenceLine:12,scope:'Unmodified saved channel log from the earlier measured take; not a populated current channel'};
      const logEditor=await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(logFile)),{preview:false});
      assert.equal(logEditor.document.uri.fsPath,logFile);
      logEditor.selection=new vscode.Selection(11,0,11,0);logEditor.revealRange(new vscode.Range(11,0,11,0),vscode.TextEditorRevealType.InCenter);
      await vscode.commands.executeCommand('editor.action.toggleWordWrap');await capture('saved-previous-output-log-exact-evidence-path');
      const bytes=await fs.readFile(result.evidence.file);assert.equal(hash(bytes),result.evidence.sha256);await fs.copyFile(result.evidence.file,path.join(output,'actual-testitem-result.json'));
      const jsonEditor=await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(result.evidence.file)),{preview:false});
      assert.equal(jsonEditor.document.uri.fsPath,result.evidence.file);await capture('existing-item-evidence-json-identity');
      const environmentIndex=jsonEditor.document.getText().indexOf('"environment_provenance"');assert(environmentIndex>=0);const environment=jsonEditor.document.positionAt(environmentIndex);
      jsonEditor.selection=new vscode.Selection(environment,environment);await vscode.commands.executeCommand('editor.fold');
      const metricsIndex=jsonEditor.document.getText().indexOf('"bytes"');assert(metricsIndex>=0);const metrics=jsonEditor.document.positionAt(metricsIndex);
      jsonEditor.selection=new vscode.Selection(metrics,metrics);jsonEditor.revealRange(new vscode.Range(metrics,metrics),vscode.TextEditorRevealType.AtTop);
      result.steps.push({label:'native-existing-json-navigation',foldCommand:'editor.fold',foldedProperty:'environment_provenance',sampleFields:['bytes','correctness','passes','errors','failures','seconds'],edited:false,at:new Date().toISOString()});await capture('existing-item-evidence-json-sample');
      assert.equal(jsonEditor.document.isDirty,false);assert.equal(hash(await fs.readFile(result.evidence.file)),result.evidence.sha256);assert.equal(hash(await fs.readFile(logFile)),result.savedOutputLog.sha256);
      result.nativeEvidenceDirectoriesAfter=(await fs.readdir(path.dirname(path.dirname(result.evidence.file)))).sort();assert.deepEqual(result.nativeEvidenceDirectoriesAfter,result.nativeEvidenceDirectoriesBefore,'Inspecting saved evidence creates no discovery or measurement directory');
      assert.deepEqual(Object.fromEntries(await Promise.all(['Project.toml','Manifest.toml'].map(async name=>[name,hash(await fs.readFile(path.join(controller,name)))]))),result.controllerHashes);
      assert.equal(hash(await fs.readFile(result.testItemSource.file)),result.testItemSource.sha256);
    }else if(mode==='installation'||mode==='installation-continuation'){
      await vscode.commands.executeCommand('perfchecker.openStudioForWorkspace',vscode.workspace.workspaceFolders[0].uri);await delay(500);await capture('public-studio-ready-without-measurement');
    }else{
      const source=path.join(workspace,'test/performance.jl');
      const code='using TestItems\n\n@testitem "Vector reduction" tags = [:performance] begin\n    data = collect(1:10_000)\n    @test sum(data) == 50_005_000\nend\n';
      if(mode!=='testitem-continuation'){assert(!await fs.stat(source).catch(()=>undefined));await fs.mkdir(path.dirname(source),{recursive:true});await fs.writeFile(source,'',{flag:'wx'});}
      const editor=await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(source)),{preview:false});
      if(mode!=='testitem-continuation'){assert(await editor.edit(edit=>edit.insert(new vscode.Position(0,0),code)));assert(await editor.document.save());}
      assert.equal(await fs.readFile(source,'utf8'),code);assert.equal(editor.document.isDirty,false);result.testItemSource={file:source,sha256:hash(Buffer.from(code)),createdInThisTake:mode!=='testitem-continuation'};await capture(mode==='testitem-continuation'?'prepared-vector-reduction-source':'new-vector-reduction-source');
      const testingCommand='workbench.view.extension.test';assert((await vscode.commands.getCommands(true)).includes(testingCommand),'The actual SDK registers this Testing container command');
      result.steps.push({label:'verified-testing-container',command:testingCommand,at:new Date().toISOString()});
      const storage=path.join(setup,'profile/User/globalStorage/mirage-interactive-fr.perfchecker-vscode/native-testitems');
      const beforeDiscovery=new Set(await fs.readdir(storage).catch(()=>[])),discoveryStartedAt=new Date().toISOString();
      await palette('PerfChecker: Discover existing test items');await vscode.commands.executeCommand(testingCommand);
      const rows=page.locator('.testing-view-pane .monaco-list-row');
      const visibleItemLabels=()=>rows.evaluateAll(nodes=>nodes.map((row,index)=>{
        const label=row.querySelector('.testing-stdtree-container .label');
        return {index,name:label?[...label.childNodes].filter(node=>node.nodeType===3).map(node=>node.textContent).join('').trim():null,
          description:label?.querySelector('.test-label-description')?.textContent??null};
      }));
      let selectedIndex,listing;
      try{await eventually(async()=>{
        const labels=await visibleItemLabels(),matches=labels.filter(value=>value.name==='Vector reduction'&&value.description==='test/performance.jl · performance');
        assert(matches.length<=1,'This exact native leaf is unique');if(!matches.length)return false;
        const fresh=[];
        for(const name of await fs.readdir(storage)){
          if(beforeDiscovery.has(name))continue;const file=path.join(storage,name,'result.json');
          const stat=await fs.stat(file).catch(()=>undefined);if(!stat)continue;assert(stat.size<1000000);
          const bytes=await fs.readFile(file),payload=JSON.parse(bytes);if(payload.schema_version!=='perfchecker-testitems/1')continue;
          assert.equal(payload.executed,false);assert.equal(payload.root,workspace);assert.equal(payload.items.length,1);
          const item=payload.items[0];assert.equal(item.name,'Vector reduction');assert.equal(item.file,'test/performance.jl');assert.equal(item.source_sha256,result.testItemSource.sha256);
          assert.equal(item.id,'e397771a30c115fa4bd46d4df2fab00d72a6a394cf800dc6ec5f9d9ea4f63e2d');assert.deepEqual(item.tags,['performance']);
          fresh.push({file,sha256:hash(bytes),item,executed:payload.executed,root:payload.root});
        }
        if(!fresh.length)return false;selectedIndex=matches[0].index;listing=fresh;return true;
      },'The visible exact leaf and fresh nonexecuted listing identify the selected item',120000);}
      catch(error){result.discoveryDiagnostic={observedAt:new Date().toISOString(),startedAt:discoveryStartedAt,
        labels:(await visibleItemLabels().catch(diagnostic=>[{error:String(diagnostic)}])).slice(0,20),
        freshDirectories:(await fs.readdir(storage).catch(()=>[])).filter(name=>!beforeDiscovery.has(name)).slice(0,20)};await save();throw error;}
      result.discovery={startedAt:discoveryStartedAt,completedAt:new Date().toISOString(),listings:listing};await save();
      const row=rows.nth(selectedIndex);assert(await row.isVisible());await row.hover();await capture('exact-item-discovered-before-run');
      const prior=new Set(await fs.readdir(storage).catch(()=>[]));
      const button=row.locator('.action-label[title="Run Test"],.action-label[aria-label="Run Test"],.action-label.codicon-testing-run-icon');assert.equal(await button.count(),1);
      const beforeClick=await row.evaluate(node=>{const label=node.querySelector('.testing-stdtree-container .label');return {name:[...label.childNodes].filter(child=>child.nodeType===3).map(child=>child.textContent).join('').trim(),description:label.querySelector('.test-label-description')?.textContent};});
      assert.equal(beforeClick.name,'Vector reduction');assert.equal(beforeClick.description,'test/performance.jl · performance');
      result.steps.push({label:'native-item-identity-revalidated-before-click',...beforeClick,at:new Date().toISOString()});
      result.intentionalItemLaunches=1;result.steps.push({label:'native-item-run-click',startedAt:new Date().toISOString()});await save();await button.click();
      const measured=await eventually(async()=>{const found=[];for(const name of await fs.readdir(storage)){if(prior.has(name))continue;const file=path.join(storage,name,'result.json'),payload=await fs.readFile(file,'utf8').then(JSON.parse).catch(()=>undefined);if(payload?.schema_version==='perfchecker-testitem-run/1')found.push({file,payload});}assert(found.length<=1);return found[0];},'One real item click must return fresh current evidence',180000);
      const r=measured.payload;assert.equal(r.passed,true);assert.equal(r.runs.length,1);assert.equal(r.runs[0].status,'validated');assert.equal(r.runs[0].item.name,'Vector reduction');assert.equal(r.runs[0].item.source_sha256,result.testItemSource.sha256);assert.equal(r.runs[0].samples.length,1);
      const sample=r.runs[0].samples[0];assert.equal(sample.correctness,'passed');assert.equal(sample.passes,1);assert.equal(sample.errors,0);assert.equal(sample.failures,0);assert(Number.isFinite(sample.seconds)&&sample.seconds>=0);assert(Number.isFinite(sample.bytes)&&sample.bytes>=0);
      await eventually(async()=>/passed/i.test(await row.getAttribute('aria-label')||'')||await row.locator('.codicon-testing-passed-icon').count()>0,'The actual selected item shows Passed',10000);
      result.measurements=1;result.evidence={file:measured.file,sha256:hash(await fs.readFile(measured.file)),item:r.runs[0].item,sample};await capture('selected-item-real-passed');
      await palette('Output: Show Output Channels');
      const channel=page.locator('.quick-input-widget .monaco-list-row').filter({hasText:'PerfChecker test items'});await channel.waitFor({state:'visible',timeout:10000});assert.equal(await channel.count(),1);await channel.click();
      await eventually(async()=>{const lines=await page.locator('.part.panel .view-lines').allTextContents();return lines.join('\n').includes(`Evidence: ${measured.file}`);},'The real Output panel exposes this exact current Evidence path',10000);await capture('actual-output-evidence-path');
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await fs.copyFile(measured.file,path.join(output,'actual-testitem-result.json'));await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(measured.file)),{preview:false});await capture('current-item-evidence-json');
      assert.deepEqual(Object.fromEntries(await Promise.all(['Project.toml','Manifest.toml'].map(async name=>[name,hash(await fs.readFile(path.join(controller,name)))]))),result.controllerHashes);
    }
    assert(!result.processObservationErrors.length);result.status='passed';
  }catch(error){primaryError=error;result.status='failed';result.error=String(error);result.stack=error.stack;if(page)try{result.failureCapture=await nativeWindowSnapshot(page,{output,label:'failed-current-state',session:setup});}catch(captureError){result.failureCaptureError=String(captureError);}}
  finally{
    const until=Date.now()+20000;clearInterval(timer);
    result.juliaCleanup={startedAt:new Date().toISOString(),signals:[],remaining:[]};
    try{
      await observation;await observe();for(const terminal of terminals)terminal.dispose();
      for(let tries=0;tries<10&&Date.now()<until;tries++){const live=[];for(const row of identities.values())if(path.basename(row.executable)==='julia'&&await juliaIdentity(row))live.push(row.pid);if(!live.length)break;await delay(100);}
      // A forced stop protects owned resources, but never turns a failed/unfinished stage into PASS.
      for(const signal of ['SIGTERM','SIGKILL']){
        for(const row of identities.values())if(Date.now()<until&&path.basename(row.executable)==='julia'&&await juliaIdentity(row))try{process.kill(row.pid,signal);result.juliaCleanup.signals.push({pid:row.pid,start:row.start,signal,at:new Date().toISOString()});}catch(error){if(error.code!=='ESRCH')throw error;}
        for(let tries=0;tries<10&&Date.now()<until;tries++){const live=[];for(const row of identities.values())if(path.basename(row.executable)==='julia'&&await juliaIdentity(row))live.push(row.pid);if(!live.length)break;await delay(100);}
      }
      for(const row of identities.values())if(path.basename(row.executable)==='julia'&&await juliaIdentity(row))result.juliaCleanup.remaining.push(row);
      if(result.juliaCleanup.remaining.length||result.juliaCleanup.signals.length||result.processObservationErrors.length)throw new Error('Public lesson cleanup needed a forced signal, or ownership is unqualified');
    }catch(error){result.status='failed';result.juliaCleanup.error=String(error);primaryError??=error;}
    result.juliaCleanup.finishedAt=new Date().toISOString();
    await browser?.close();await save();
  }
  if(primaryError)throw primaryError;
}
exports.run=async()=>{
  if(process.env.PERFCHECKER_PUBLIC_LESSON)return publicLesson();
  if(process.env.PERFCHECKER_STUDIO_THEME_ONLY==='1')return framingOnly({studioThemes:true});
  if(process.env.PERFCHECKER_FRAMING_ONLY==='1')return framingOnly();
  assert(!process.env.CI,'Never run authenticated model tests in CI');assert.equal(process.platform,'linux');
  const session=await fs.realpath(process.env.PERFCHECKER_HOST_SESSION),folder=vscode.workspace.workspaceFolders[0],root=await fs.realpath(folder.uri.fsPath);
  assert(path.basename(session).startsWith('perfchecker-codex-host-'));assert.equal(root,process.env.PERFCHECKER_MEDIA_WORKSPACE);
  assert.equal(await fs.readFile(path.join(root,'.perfchecker-test-fixture'),'utf8'),'sacrificial\n');
  const checks=[],result={runner:'bibliography-pilot-host.cjs',hostExecuted:true,hostPid:process.pid,status:'running',checks};
  suiteDeadline=Date.now()+14*60*1000;result.maximumHostMinutes=14;
  // This sentinel must be written by the actual extension host, never by the outer SDK.
  await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result));
  const configFile=path.join(root,'perf','advisor.json'),settingsFile=path.join(root,'.vscode','settings.json');
  const relative='src/bibtex.jl',sourceFile=path.join(root,relative);
  const indexPath=path.resolve(root,(await execute('git',['rev-parse','--git-path','index'],{cwd:root})).stdout.trim());
  const saved=await fs.readFile(configFile),savedSettings=await fs.readFile(settingsFile),source=await fs.readFile(sourceFile,'utf8'),index=await fs.readFile(indexPath);
  const settings=()=>vscode.workspace.getConfiguration('perfchecker',folder.uri);
  const git=async(...args)=>(await execute('git',args,{cwd:root,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;
  const initialStatus=await git('status','--porcelain');const head=await git('rev-parse','HEAD'),state=()=>vscode.commands.executeCommand('perfchecker.chatState');
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
    assert.deepEqual(await fs.readFile(settingsFile),savedSettings);assert.deepEqual(await fs.readFile(indexPath),index);
    assert.equal(await git('rev-parse','HEAD'),head);assert.equal(await git('status','--porcelain'),initialStatus);
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
    assert.equal(result.vsixSha256,'ff5a1af088ababeccd0847f27bcd2e6c0f7e9c0f894b37e35e5711d7b044857d');
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
    result.workerPreflight=JSON.parse(process.env.PERFCHECKER_WORKER_PREFLIGHT);
    assert.equal(result.workerPreflight.status,'passed');
    assert.equal(result.workerPreflight.project,settings().get('scenarioProject'));
    assert.equal(result.workerPreflight.packages.find(value=>value.name==='BenchmarkTools').version,'1.8.0');
    for(const [name,sha] of Object.entries(result.workerPreflight.hashesAfter))assert.equal(hash(await fs.readFile(path.join(result.workerPreflight.project,name))),sha);
    result.core=JSON.parse(process.env.PERFCHECKER_HOST_CORE);assert.equal(result.core.version,'1.0.1');
    const evidence=JSON.parse(await fs.readFile('/home/azzaare/.julia/dev/Bibliography-perfchecker-media-20261008/perf/media/results/version-comparison.json','utf8'));
    assert.equal(evidence.run_id,'c024d57e-6310-4c45-a05a-dd1d53b77703');
    result.introComparisonReference={runId:evidence.run_id,sourceWorkloadCommit:'03e6c518b4857e653300a7e8d7161bec44b55884',allocationBaselineBytes:4080,allocationCandidateBytes:3056};result.messages=[];
    const {chromium}=await import(process.env.PERFCHECKER_TEST_PLAYWRIGHT?pathToFileURL(process.env.PERFCHECKER_TEST_PLAYWRIGHT).href:'playwright');
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PERFCHECKER_HOST_CDP_PORT}`);
    observer=setInterval(()=>{void observe().catch(error=>{result.observationError=String(error);});},200);
    const windowPage=await eventually(()=>browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('workbench')),'Locate the real native workbench');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    assert.equal(process.env.DISPLAY,process.env.PERFCHECKER_PRIVATE_DISPLAY);assert(/^:\d+$/.test(process.env.DISPLAY));
    assert.equal(process.env.WAYLAND_DISPLAY,undefined);
    result.privateWindowManager=JSON.parse(process.env.PERFCHECKER_PRIVATE_WM);
    assert.equal(await processIdentity(result.privateWindowManager.pid),result.privateWindowManager.start);
    assert.equal(await fs.realpath(`/proc/${result.privateWindowManager.pid}/exe`),result.privateWindowManager.executable);
    assert.equal(result.privateWindowManager.affinity,'16-17');
    const physicalOutput=path.join(session,'framing');await fs.mkdir(physicalOutput);
    const captureNative=async(label,publishName)=>{
      const observation=await nativeWindowSnapshot(windowPage,{output:physicalOutput,label,session});
      (result.nativeCaptures??=[]).push(observation);
      const visible=observation.windows.filter(window=>/Map State: IsViewable/.test(window.geometry.stdout||''));
      assert.equal(visible.length,1);assert(visible[0].start);assert.equal(visible[0].affinity,'16-17');
      if(!result.nativeWindowIdentity)result.nativeWindowIdentity={id:visible[0].id,pid:visible[0].pid,executable:visible[0].executable,start:visible[0].start,affinity:visible[0].affinity};
      assert.equal(visible[0].id,result.nativeWindowIdentity.id);assert.equal(visible[0].pid,result.nativeWindowIdentity.pid);assert.equal(visible[0].start,result.nativeWindowIdentity.start);
      assert.equal(await processIdentity(result.privateWindowManager.pid),result.privateWindowManager.start);
      assert(observation.rootProperties.stdout.includes(result.privateWindowManager.xid));
      if(label!=='before-fullscreen'){
        assert.equal(observation.nativeX11Png.width,1920);assert.equal(observation.nativeX11Png.height,1080);
        assert(observation.nativeX11Png.windowOccupationQualified,'The native client must occupy the actual 1920 by 1080 capture');
      }
      if(publishName){
        const destination=path.join(process.env.PERFCHECKER_MEDIA_OUTPUT,publishName);
        await fs.copyFile(path.join(physicalOutput,`${label}-native-x11.png`),destination);
        assert.equal(hash(await fs.readFile(destination)),observation.nativeX11Png.sha256);
        observation.publishedNativePath=destination;
      }
      await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result,null,2));return observation;
    };
    await vscode.commands.executeCommand('workbench.action.joinAllGroups');
    await captureNative('before-fullscreen');
    result.nativeWindowStrategy='official toggleFullScreen command with private EWMH window manager';
    await vscode.commands.executeCommand('workbench.action.toggleFullScreen');
    const nativeGeometry=()=>windowPage.evaluate(()=>({width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,devicePixelRatio}));
    result.nativeViewportBeforeZoom=await eventually(async()=>{
      const observed=await nativeGeometry();result.nativeViewportObservedBeforeZoom=observed;
      return Math.round(observed.width*observed.devicePixelRatio)===1920&&Math.round(observed.height*observed.devicePixelRatio)===1080?observed:undefined;
    },'The actual private native window must fill the 1920 by 1080 display',20000);
    await captureNative('after-fullscreen');
    await vscode.workspace.getConfiguration('zenMode').update('centerLayout',false,vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('zenMode').update('fullScreen',false,vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.toggleZenMode');
    for(let i=0;i<2;i++)await vscode.commands.executeCommand('workbench.action.zoomIn');
    result.nativeViewportAfterZoom=await nativeGeometry();
    await captureNative('after-zen-and-zoom');
    const discovery=await vscode.commands.executeCommand('perfchecker.discoverScenarios');
    assert(discovery,'Public discovery completes');
    assert(discovery.declared.some(value=>value.id==='export-bibtex'&&value.implementation==='local-checkout'),'The declared local scenario was discovered');
    const measurementProject=path.join(root,'perf/media/scenario-worker');
    assert.equal(settings().get('scenarioProject'),measurementProject);
    const measurement=await vscode.commands.executeCommand('perfchecker.measureScenarios',[JSON.stringify(['export-bibtex','local-checkout'])]);
    assert.equal(measurement?.schema_version,'perfchecker-scenario-run/1');
    assert.equal(measurement.runs.length,1);result.selectedMeasurement=measurement;
    assert.equal(measurement.runs[0].qualification.correctness,'passed');
    assert.equal(measurement.runs[0].qualification.availability,'complete');
    assert.equal(measurement.runs[0].summaries.find(value=>value.metric==='julia.alloc.bytes').samples,100);
    result.measurementProject=measurementProject;result.advisorProject=process.env.PERFCHECKER_TEST_CONTROLLER;
    await preserved();
    await vscode.commands.executeCommand('perfchecker.openStudio');
    await vscode.commands.executeCommand('workbench.action.joinAllGroups');
    await windowPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await eventually(async()=>{
      for(const frame of windowPage.frames()){
        const studio=frame.locator('#studio-root');if(!await studio.isVisible().catch(()=>false))continue;
        if(!/Feature suite/.test(await studio.innerText()))continue;
        let visible=true;for(let current=frame;current.parentFrame();current=current.parentFrame()){const owner=await current.frameElement();visible&&=await owner.isVisible();await owner.dispose();}
        if(visible)return true;
      }
    },'The actual Studio cards are visible before its native capture',30000);
    await captureNative('studio','perfchecker-episode-00-studio.png');
    await vscode.commands.executeCommand('perfchecker.openChat');
    await vscode.commands.executeCommand('workbench.action.joinAllGroups');view=await findChat();
    const measuredRunIds=measurement.runs.map(run=>run.run_id);assert.equal(new Set(measuredRunIds).size,1);
    const historyRoot=path.resolve(root,settings().get('investigationReports','perf/results/investigations'));
    const attached=await eventually(async()=>{
      const matching=[];
      for(const option of (await state()).evidence){
        assert.equal(path.basename(option.id),option.id,'A history id is one directory component');
        const directory=path.join(historyRoot,option.id),runFile=path.join(directory,'run.json');
        const bytes=await fs.readFile(runFile).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});if(!bytes)continue;
        const savedRun=JSON.parse(bytes);
        if(JSON.stringify(savedRun.runs?.map(run=>run.run_id))!==JSON.stringify(measuredRunIds))continue;
        assert.deepEqual(savedRun,measurement,'The attachment is the exact fresh measurement, not a prior history item');
        assert(savedRun.runs.every(run=>run.collector==='benchmark'&&run.scenario.id==='export-bibtex'&&run.scenario.implementation==='local-checkout'&&run.qualification.correctness==='passed'&&run.qualification.availability==='complete'));
        for(const run of savedRun.runs){
          const quantities=run.summaries.filter(row=>['julia.alloc.bytes','julia.alloc.count','julia.wall.time'].includes(row.metric));
          assert.equal(quantities.length,3);assert(quantities.every(row=>row.samples===100));
        }
        const adviceFile=path.join(directory,'advice','advice.json'),adviceBytes=await fs.readFile(adviceFile),advice=JSON.parse(adviceBytes);
        assert.equal(advice.schema_version,'perfchecker-advice/1');assert.equal(advice.measurement_summaries.length,3);
        assert.deepEqual(advice.measurement_summaries.map(row=>[row.metric,row.unit]).sort(),[['julia.alloc.bytes','By'],['julia.alloc.count','1'],['julia.wall.time','s']]);
        assert.equal(new Set(advice.measurement_summaries.map(row=>row.id)).size,3);
        const manifestBytes=await fs.readFile(path.join(directory,measuredRunIds[0],'manifest.json')),manifest=JSON.parse(manifestBytes);
        const observations=(await fs.readFile(path.join(directory,measuredRunIds[0],'observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
        for(const row of advice.measurement_summaries){
          assert.match(row.id,/^measurement-[a-f0-9]{64}$/);assert.equal(row.run_id,measuredRunIds[0]);assert.equal(row.record_count,100);
          assert.equal(row.correctness,'passed');assert.equal(row.bundle_status,'complete');assert.equal(row.collector,'benchmark');
          assert.equal(row.record_semantics,'operation_measurement');assert.equal(row.aggregation,'sample');
          assert.equal(observations.filter(record=>record.measurement_definition===row.measurement_definition&&record.metric===row.metric&&record.unit===row.unit).length,100);
        }
        const workerProvenance=[];
        for(const environment of manifest.environment_provenance){
          assert.equal(await fs.realpath(environment.path),await fs.realpath(measurementProject));
          assert.equal(environment.project_sha256,hash(await fs.readFile(path.join(measurementProject,'Project.toml'))));
          assert.equal(environment.manifest_sha256,hash(await fs.readFile(path.join(measurementProject,'Manifest.toml'))));
          const packages=environment.resolved_packages.map(item=>item.name);
          assert(packages.includes('BenchmarkTools'));assert(!packages.includes('PerfChecker')&&!packages.includes('HTTP'));
          workerProvenance.push(environment);
        }
        assert(workerProvenance.length>0);
        matching.push({option,receipt:{historyId:option.id,runIds:measuredRunIds,runFile,adviceFile,runSha256:hash(bytes),adviceSha256:hash(adviceBytes),manifestSha256:hash(manifestBytes),
          measurementSummaries:advice.measurement_summaries,workerProvenance,verifiedBeforeConnect:true,matchedExactFreshRun:true}});
      }
      assert(matching.length<=1,'Exactly one saved history item owns the fresh run');return matching[0];
    },'The exact fresh BenchmarkTools run is available to attach');
    await view.getByRole('combobox',{name:'Attach saved evidence',exact:true}).selectOption(attached.option.id);
    await eventually(async()=>(await state()).evidenceId===attached.option.id,'Public evidence selector attaches the exact fresh saved result');
    result.attachedEvidence=attached.option;result.attachmentReceipt=attached.receipt;
    await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result,null,2));
    const beforeServers=new Set(loopbackServers());await click('Connect Codex CLI');
    await eventually(async()=>Boolean((await state()).connection),'The actual Connect button authenticates the existing CLI',60000);
    const connected=await state();assert.match(connected.connection,/^codex-cli\s+\S+/);assert.equal(connected.implementation.tool,'implement_perfchecker');
    result.agent=connected.connection;
    server=await eventually(()=>{const added=loopbackServers().filter(handle=>!beforeServers.has(handle));assert(added.length<=1);return added[0];},'Observe the newly owned loopback listener',10000);
    endpoint=`http://127.0.0.1:${server.address().port}/mcp`;
    const unauthorized=await fetch(endpoint,{method:'POST',headers:{Connection:'close'},body:'{}',signal:AbortSignal.timeout(5000)});
    assert.equal(unauthorized.status,401);await unauthorized.arrayBuffer();await preserved();
    checks.push('installed ff5a product path/version/runtime hashes; genuine Connect control; saved disabled provider unchanged; unauthenticated HTTP refused');

    const questions=[
      'What does this attached export result tell us, and what should we check before changing the code? Give read-only advice in 45–60 natural English words. No commands or edits.',
      'How would you test a change to the local checkout, then restore it? Keep this workload and oracle unchanged. Give read-only advice in 45–60 natural English words. No commands or edits.'
    ];
    const adviceCharacters=[];
    for(const [turn,question] of questions.entries()){
      await view.locator('#chat-question').fill(question);await click('Send question');
      const reply=await eventually(async()=>{const value=await state();
        result.requestState={busy:value.busy,status:value.status,messageCount:value.messages.length};
        if(!value.busy&&value.messages.length!==2*(turn+1)&&/^(Error|ArgumentError|TypeError)|failed|unavailable|timed out/i.test(value.status))throw new Error(`Advice turn ${turn+1} failed: ${value.status}`);
        return !value.busy&&value.messages.length===2*(turn+1)?value:undefined;
      },`Authenticated Julia advice turn ${turn+1} completes`);
      assert.deepEqual(reply.messages.map(message=>message.role),Array.from({length:turn+1},()=>['user','assistant']).flat());
      const answer=reply.messages.at(-1).content;assert(answer.length>10);adviceCharacters.push(answer.length);result.messages=reply.messages;
      assert(!/no saved measurements were attached/i.test(answer),'The agent receives the selected measured records, including reports with no recommendations');
      await view.locator('.message.assistant').last().scrollIntoViewIfNeeded();
      const layout=await view.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}));
      assert(layout.scrollWidth<=layout.clientWidth+1,'The real chat has no clipped horizontal overflow');
      await windowPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await captureNative(`mcp-turn-${turn+1}`,`perfchecker-episode-00-mcp-turn-${turn+1}.png`);
      (result.captureLayout??=[]).push(layout);
      await eventually(async()=>await view.locator('.message.assistant').count()===turn+1,'The actual reply is visible');
      assert((await view.locator('.message.assistant').last().innerText()).includes(answer));await preserved();
    }
    checks.push('two authenticated contextual advice replies through Julia MCP are visible and preserve exact source/index/HEAD/config');
    await observe();
    checks.push('Bibliography fresh report discussed in two real contextual MCP replies; no implementation or apply claimed in this intro capture');
    await click('Disconnect Codex');await eventually(async()=>!((await state()).connection),'Actual Disconnect clears the session');
    assert.equal((await state()).implementation.tool,'previous_agent');
    assert.equal((await vscode.commands.executeCommand('perfchecker.codexConnectionState')).connected,false);
    assert.equal(server.listening,false);await assert.rejects(fetch(endpoint,{method:'POST',body:'{}',signal:AbortSignal.timeout(5000)}));await preserved();
    checks.push('actual Disconnect closes the listener and preserves original disabled configuration/file/tool');
    Object.assign(result,{status:'passed',adviceTurns:2,adviceCharacters,localScenarioCommit:'2e86892401536ca4cfd20eb45c00e98168b482a3',implementationCaptured:false,ownedDeadBeforeCleanup:true,socketClosedBeforeCleanup:true});
  }catch(error){primaryError=error;Object.assign(result,{status:'failed',error:String(error),stack:error.stack});}
  finally{
    suiteDeadline=Date.now()+30000;
    // Failure cleanup uses the same owning controls and does not turn teardown into a PASS oracle.
    try{
      if(browser&&view){if((await state()).busy){await click('Cancel request');await idle('Failure cleanup finishes the owned request');}
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
