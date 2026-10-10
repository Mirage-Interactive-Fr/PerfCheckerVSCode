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
function stagedIndex(debug,bytes){
  assert.equal(bytes.subarray(0,4).toString(),'DIRC','Retain a real Git index');
  const version=bytes.readUInt32BE(4);assert([2,3,4].includes(version),'Require an index version supported by the native Git semantic reader');
  const entries=[],cache=[];let position=0;
  while(position<debug.length){
    const end=debug.indexOf(0,position);assert(end>=0,'Every indexed path has its complete NUL terminator');
    const header=debug.subarray(position,end),tab=header.indexOf(9);assert(tab>0);
    const identity=header.subarray(0,tab).toString('ascii').match(/^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])$/);assert(identity,'Unknown stage records must fail');
    let metadataEnd=end;for(let line=0;line<5;line++){metadataEnd=debug.indexOf(10,metadataEnd+1);assert(metadataEnd>=0,'Complete index metadata is required');}
    const details=debug.subarray(end+1,metadataEnd+1).toString('ascii').match(/^  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: (\d+)\tino: (\d+)\n  uid: (\d+)\tgid: (\d+)\n  size: (\d+)\tflags: ([a-f0-9]+)\n$/);assert(details,'Unknown index metadata must fail');
    entries.push({mode:identity[1],oid:identity[2],stage:Number(identity[3]),pathHex:header.subarray(tab+1).toString('hex'),flags:details[10]});
    cache.push({pathHex:entries.at(-1).pathHex,ctime:details.slice(1,3),mtime:details.slice(3,5),dev:details[5],ino:details[6],uid:details[7],gid:details[8],size:details[9]});
    position=metadataEnd+1;
  }
  assert.equal(entries.length,bytes.readUInt32BE(8),'The staging proof covers every entry, without a truncated dump');
  return {version,entries,cache,binaryMetadata:'Complete binary retained. Native Git supplies semantic entries; extensions/checksum are not independently decoded by this oracle.'};
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
  const capturePreflightOnly=process.env.PERFCHECKER_HOST_CAPTURE_PREFLIGHT_ONLY==='1';
  suiteDeadline=Date.now()+(capturePreflightOnly?5:bibliography?21:14)*60*1000;result.maximumHostMinutes=capturePreflightOnly?5:bibliography?21:14;
  // This sentinel must be written by the actual extension host, never by the outer SDK.
  await fs.writeFile(process.env.PERFCHECKER_HOST_RESULT,JSON.stringify(result));
  const configFile=path.join(root,'perf','advisor.json'),settingsFile=path.join(root,'.vscode','settings.json');
  const relative=bibliography?'src/bibtex.jl':'src/PerfCheckerNativeFixture.jl',sourceFile=path.join(root,relative);
  const saved=await fs.readFile(configFile),savedSettings=await fs.readFile(settingsFile),source=await fs.readFile(sourceFile,'utf8');
  let index=await fs.readFile(path.join(root,'.git','index'));
  const settings=()=>vscode.workspace.getConfiguration('perfchecker',folder.uri);
  const git=async(...args)=>(await execute('git',args,{cwd:root,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;
  const head=await git('rev-parse','HEAD'),state=()=>vscode.commands.executeCommand('perfchecker.chatState');
  const captureWorkingState=async()=>{
    const rawGit=async args=>{
      const {stdout,stderr}=await execute('git',args,{cwd:root,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},encoding:'buffer',timeout:5000,maxBuffer:4_000_000});
      assert.equal(stderr.length,0,'The read-only capture fixture inspection has no unqualified Git warning');return stdout;
    };
    const status=await rawGit(['status','--porcelain=v1','-z','--untracked-files=all']);
    const untracked=await rawGit(['ls-files','--others','--exclude-standard','-z']),files=[];
    for(let position=0;position<untracked.length;){
      const end=untracked.indexOf(0,position);assert(end>position,'Every untracked path has its complete raw NUL terminator');
      const relative=untracked.subarray(position,end),filename=Buffer.concat([Buffer.from(root+path.sep),relative]);
      const type=await fs.lstat(filename);assert(!type.isSymbolicLink(),'Untracked symlinks are unsupported by this private capture fixture');
      assert(type.isFile(),'Every untracked capture fixture entry must be a regular file');
      files.push({pathHex:relative.toString('hex'),type:'regular',mode:type.mode&0o7777,bytes:type.size,sha256:hash(await fs.readFile(filename))});position=end+1;
    }
    return {porcelainV1NulHex:status.toString('hex'),files};
  };
  // Capture-only deliberately skips the Julia fixture preparation/commit. Its
  // seven setup files must remain byte-exact, rather than disappear from Git.
  const captureWorkingStateBefore=capturePreflightOnly?await captureWorkingState():undefined;
  if(capturePreflightOnly)result.captureWorkingStateBefore=captureWorkingStateBefore;
  let browser,view,windowPage,endpoint,server,owned,primaryError,observer,observation;
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
    assert.equal(await git('rev-parse','HEAD'),head);
    if(capturePreflightOnly){
      result.captureWorkingStateAfter=await captureWorkingState();assert.deepEqual(result.captureWorkingStateAfter,captureWorkingStateBefore);
    }else assert.equal(await git('status','--porcelain'),'');
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
  const indexProof=async label=>{
    const bytes=await fs.readFile(path.join(root,'.git','index'));
    if(proofs){await fs.mkdir(proofs,{recursive:true});await fs.writeFile(path.join(proofs,`${label}.index`),bytes);}
    const {stdout,stderr}=await execute('git',['ls-files','--stage','--debug','-z'],{cwd:root,encoding:'buffer',timeout:5000,maxBuffer:4_000_000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
    if(proofs)await fs.writeFile(path.join(proofs,`${label}.index-stage-debug`),stdout);
    assert.equal(stderr.toString().trim(),'','Native Git must not warn about ignored or unsupported index metadata');
    const parsed=stagedIndex(stdout,bytes);assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),bytes,'Read-only staging inspection never refreshes the index');
    const proof={label,sha256:hash(bytes),...parsed};result.indexProofs??=[];result.indexProofs.push(proof);
    return {bytes,...proof};
  };
  const nativeCodeWindow=async stage=>{
    assert(/^:\d+$/.test(process.env.DISPLAY),'Inspect only the disposable driver-owned X display');
    const {stdout:tree}=await execute('/usr/bin/xwininfo',['-display',process.env.DISPLAY,'-root','-tree'],{timeout:5000,maxBuffer:1000000});
    const observed=await eventually(async()=>{
      try{return JSON.parse(await fs.readFile(path.join(session,'affinity-observed.json'),'utf8'));}
      catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return;throw error;}
    },'Read the private driver cohort before inspecting any native window',5000);
    const windows=[];
    for(const line of tree.split('\n')){
      const match=/^\s+(0x[\da-f]+).*?\s(\d+)x(\d+)[+-]\d+[+-]\d+\s+([+-]\d+)([+-]\d+)\s*$/i.exec(line);
      if(!match||Number(match[2])<1000||Number(match[3])<500)continue;
      const {stdout:properties}=await execute('/usr/bin/xprop',['-display',process.env.DISPLAY,'-id',match[1],'WM_CLASS','_NET_WM_PID'],{timeout:5000,maxBuffer:100000});
      const pid=Number(/^_NET_WM_PID\(CARDINAL\) = (\d+)$/m.exec(properties)?.[1]);
      const item={id:match[1],pid:Number.isSafeInteger(pid)&&pid>0?pid:null,
        rawTreeLine:line,rawProperties:properties,
        wmClass:/^WM_CLASS\(STRING\) = (.*)$/m.exec(properties)?.[1]??null,
        width:Number(match[2]),height:Number(match[3]),x:Number(match[4]),y:Number(match[5]),qualified:false};
      windows.push(item);const known=observed.processes.find(process=>process.pid===item.pid);
      if(!known)continue;
      try{
        const start=await processIdentity(known.pid),executable=await fs.readlink(`/proc/${known.pid}/exe`);
        assert.equal(start,known.start,'The X11 window PID is the incarnation already observed in the private driver cohort');
        assert.equal(executable,known.executable);assert(executable.startsWith(path.join(session,'vscode')+path.sep));
        assert.equal(await processIdentity(known.pid),start);
        assert.equal(await fs.readlink(`/proc/${known.pid}/exe`),executable);
        const {stdout:info}=await execute('/usr/bin/xwininfo',['-display',process.env.DISPLAY,'-id',item.id],{timeout:5000,maxBuffer:100000});
        item.mapped=/Map State: IsViewable/.test(info);item.identity={pid:known.pid,start,executable};item.qualified=true;
      }catch(error){item.qualificationError={name:error.name,message:String(error.message).slice(0,1000)};}
    }
    // Preserve native properties before an assertion can fail. WM_CLASS is
    // informative: identity comes from the private observed PID incarnation.
    result.nativeWindowObservations??=[];result.nativeWindowObservations.push({stage,observedAt:new Date().toISOString(),display:process.env.DISPLAY,windows});
    assert(result.nativeWindowObservations.length<=100,'Native window diagnostics remain bounded');
    const candidates=windows.filter(item=>item.qualified&&item.mapped);
    assert.equal(candidates.length,1,'Exactly one large native Code window must render on the disposable X11 display');
    return candidates[0];
  };
  const capture=async(name,timeout=30000)=>{
    if(!proofs)return;
    await fs.mkdir(proofs,{recursive:true});const filename=path.join(proofs,`${name}.png`);
    if(!bibliography){await view.page().screenshot({path:filename,timeout});return;}
    assert(/^:\d+$/.test(process.env.DISPLAY),'Capture only the disposable driver-owned X display');
    assert(windowPage,'Resolve the private host workbench before framebuffer capture');
    // ImageMagick reads the actual X framebuffer, without image scaling or crops.
    await execute('/usr/bin/import',['-display',process.env.DISPLAY,'-silent','-window','root',`PNG:${filename}`],{timeout,maxBuffer:1000000});
    const bytes=await fs.readFile(filename),dimensions=png=>{
      assert.deepEqual(png.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
      assert.equal(png.subarray(12,16).toString(),'IHDR');return {width:png.readUInt32BE(16),height:png.readUInt32BE(20)};
    };
    const framebuffer=dimensions(bytes),viewport=await windowPage.evaluate(()=>({width:innerWidth,height:innerHeight,
      outerWidth,outerHeight,screenWidth:screen.width,screenHeight:screen.height,devicePixelRatio}));
    const renderer=dimensions(await windowPage.screenshot({scale:'device',timeout}));
    const nativeWindow=await nativeCodeWindow(`capture:${name}`);
    const record={file:path.basename(filename),display:process.env.DISPLAY,source:'private X11 root framebuffer; no image resize, crop or transform',
      ...framebuffer,sha256:hash(bytes),viewport,renderer,rendererDimensions:'informative CDP screenshot dimensions, not a physical-pixel measurement',
      nativeWindow,pixelsPerCssX:framebuffer.width/viewport.width,pixelsPerCssY:framebuffer.height/viewport.height};
    result.framebufferCaptures??=[];result.framebufferCaptures.push(record);
    assert.deepEqual({width:nativeWindow.width,height:nativeWindow.height,x:nativeWindow.x,y:nativeWindow.y},{...framebuffer,x:0,y:0},
      'The mapped private X11 Code window covers the whole framebuffer without clipping');
    assert.deepEqual({width:viewport.outerWidth,height:viewport.outerHeight},framebuffer);
    assert.deepEqual({width:viewport.screenWidth,height:viewport.screenHeight},framebuffer);
    assert(Math.abs(record.pixelsPerCssX-record.pixelsPerCssY)<=1/Math.min(viewport.width,viewport.height),
      'The actual framebuffer and fullscreen viewport establish one unscaled pixel mapping');
    return record;
  };
  const captureAdvice=async turn=>{
    if(!proofs)return;
    await view.locator('.hero').scrollIntoViewIfNeeded();await capture(`advice-${turn}-context`);
    const transcript=view.locator('.transcript'),reply=view.locator('.message.assistant').last();
    await transcript.scrollIntoViewIfNeeded();await transcript.click({position:{x:2,y:2}});
    assert(await transcript.evaluate(node=>node===document.activeElement||node.contains(document.activeElement)),
      'A real native click focuses the scrollable conversation before keyboard/wheel navigation');
    const geometry=()=>reply.evaluate(node=>{
      const area=node.closest('.transcript'),a=area.getBoundingClientRect(),r=node.getBoundingClientRect();
      const visibleTop=Math.max(0,a.top),visibleBottom=Math.min(innerHeight,a.bottom);
      return {height:r.height,replyTop:r.top,offset:r.top-a.top,scrollTop:area.scrollTop,clientHeight:area.clientHeight,viewportHeight:innerHeight,
        visibleTop,visibleBottom,visibleHeight:visibleBottom-visibleTop,start:Math.max(0,visibleTop-r.top),end:Math.min(r.height,visibleBottom-r.top),
        fontSize:getComputedStyle(node).fontSize,devicePixelRatio};
    });
    const initial=await geometry(),record={turn,initial,parts:[],complete:false,source:'actual native transcript wheel scrolling; no CSS or message changes'};
    result.adviceCaptures??=[];result.adviceCaptures.push(record);
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
      const framebuffer=await capture(part===1?`advice-${turn}`:`advice-${turn}-part-${part}`);
      assert.equal(g.devicePixelRatio,framebuffer.viewport.devicePixelRatio,'Workbench and conversation share the native zoom');
      g.pixelFontSize=parseFloat(g.fontSize)*framebuffer.pixelsPerCssY;
      g.framebuffer=framebuffer.file;
      assert(g.pixelFontSize>=22&&g.pixelFontSize<=24,'The IHDR-qualified framebuffer mapping renders reply text at 22–24 native pixels');
      parts.push(g);
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
    assert.equal(result.vsixSha256,'e68a9264c301292568edbae21b7165f893bbeec59097233676d9de3983ba21b3');
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
    if(capturePreflightOnly)result.core={loaded:false,probed:false,configuredProject:settings().get('runnerProject')};
    else{result.core=JSON.parse(process.env.PERFCHECKER_HOST_CORE);assert.equal(result.core.tree,'00c133336911b8600d63a8d6c59ce1befc5ce690');assert.equal(result.core.version,'1.0.1');
      if(bibliography)assert.equal(result.core.registered,true);}
    const directories=JSON.parse(process.env.PERFCHECKER_HOST_PRIVATE_DIRECTORIES);
    assert.deepEqual(directories.map(([flag])=>flag),['user-data-dir','extensions-dir','shared-data-dir','agent-plugins-dir','agents-user-data-dir','agents-extensions-dir']);
    for(const [,directory]of directories){assert.equal(await fs.realpath(directory),directory);assert(directory.startsWith(session+path.sep));}
    assert.equal(new Set(directories.map(([,directory])=>directory)).size,6);result.privateCodeDirectories=directories;
    assert.equal(settings().get('advisorTimeout'),bibliography?600:180);result.configuredAdvisorTimeoutSeconds=settings().get('advisorTimeout');
    process.env.PERFCHECKER_CODEX_HOST_ONLY='1';
    const {probeJuliaCodexFixture,probeBibliographyCodexFixture,observeCodexEvents}=await import(pathToFileURL(path.join(__dirname,'codex-real.test.mjs')).href);
    passiveCli=observeCodexEvents;
    const probe=directory=>bibliography?probeBibliographyCodexFixture(directory,process.env.PERFCHECKER_TEST_JULIA,{prepare:true}):probeJuliaCodexFixture(directory,process.env.PERFCHECKER_TEST_JULIA);
    const baselineProbe=capturePreflightOnly?undefined:await probe(root),baselineBytes=bibliography?baselineProbe?.allocationBytes:baselineProbe;
    if(!capturePreflightOnly){assert.equal(baselineBytes,Number(process.env.PERFCHECKER_HOST_BASELINE_BYTES));
      if(bibliography)assert.deepEqual(baselineProbe,bibliography);
      if(bibliography)await preserveWorker('baseline-worker',root);}
    const preflightIndex=capturePreflightOnly?await indexProof('capture-preflight-before'):undefined;
    const {chromium}=await import(process.env.PERFCHECKER_TEST_PLAYWRIGHT?pathToFileURL(process.env.PERFCHECKER_TEST_PLAYWRIGHT).href:'playwright');
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PERFCHECKER_HOST_CDP_PORT}`);
    if(bibliography){
      windowPage=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('workbench'));
      assert(windowPage,'Find only the private host workbench');
      const commands=await vscode.commands.getCommands(true);
      for(const command of ['workbench.action.closeAuxiliaryBar','workbench.action.closeSidebar']){
        assert(commands.includes(command));await vscode.commands.executeCommand(command);
      }
      await eventually(async()=>!await windowPage.locator('[id="workbench.parts.auxiliarybar"]').isVisible()&&
        !await windowPage.locator('[id="workbench.parts.sidebar"]').isVisible(),'Native close actions hide the private side bars',5000);
      assert(commands.includes('workbench.action.toggleFullScreen'));
      await vscode.commands.executeCommand('workbench.action.toggleFullScreen');
      await vscode.commands.executeCommand('perfchecker.openChat');view=await findChat();
      result.captureLayout={sideBarsClosed:true,nativeCommands:['workbench.action.closeAuxiliaryBar','workbench.action.closeSidebar','workbench.action.toggleFullScreen']};
      const initialWindow=await nativeCodeWindow('before-native-sizing');
      const xdotool=process.env.PERFCHECKER_TEST_XDOTOOL;assert(xdotool&&path.isAbsolute(xdotool),'Provide the existing native X11 window control binary');
      await execute(xdotool,['windowmove','--sync',initialWindow.id,'0','0'],{timeout:5000});
      const movedWindow=await nativeCodeWindow('after-native-move');
      assert.deepEqual(movedWindow.identity,initialWindow.identity);assert.equal(movedWindow.id,initialWindow.id);
      await execute(xdotool,['windowsize','--sync',movedWindow.id,'1920','1080'],{timeout:5000});
      await eventually(async()=>{
        const current=await nativeCodeWindow('await-native-size');
        assert.deepEqual(current.identity,initialWindow.identity);assert.equal(current.id,initialWindow.id);
        return current.x===0&&current.y===0&&current.width===1920&&current.height===1080;
      },'The verified private X11 window reaches the exact framebuffer bounds',5000);
      result.captureLayout.nativeWindowActions=['windowmove 0 0','windowsize 1920 1080'];
      try{await eventually(async()=>await view.evaluate(()=>innerWidth>=1000),
        'The real native fullscreen action reaches a wide PerfChecker Chat before measurements',5000);}
      finally{
        result.captureLayout.workbench=await windowPage.evaluate(()=>({width:innerWidth,height:innerHeight,devicePixelRatio}));
        result.captureLayout.chat=await view.evaluate(()=>({width:innerWidth,height:innerHeight,devicePixelRatio,bodyFontSize:getComputedStyle(document.body).fontSize}));
        result.captureLayout.editorWidth=result.captureLayout.chat.width;
      }
      assert(result.captureLayout.editorWidth>=1000,'Capture a wide real PerfChecker editor, rather than a narrow side column');
      result.captureLayout.framebuffer=await capture('capture-layout-preflight',5000);
    }
    if(capturePreflightOnly){
      assert(bibliography&&proofs,'The explicit preflight preserves native framebuffer evidence');
      await view.locator('#chat-question').fill('How can I compare two versions of this package while preserving correctness?');
      await view.locator('#chat-question').scrollIntoViewIfNeeded();
      const font=await view.locator('#chat-question').evaluate(node=>({fontSize:getComputedStyle(node).fontSize,
        bodyFontSize:getComputedStyle(document.body).fontSize,text:node.value}));
      const framebuffer=await capture('capture-preflight-unsent-draft',5000);
      assert.equal(font.fontSize,font.bodyFontSize,'The real composer and inherited conversation typography share the same size');
      font.nativePixels=parseFloat(font.fontSize)*framebuffer.pixelsPerCssY;
      result.preflightTypography=font;
      assert(font.nativePixels>=22&&font.nativePixels<=24,'IHDR-qualified native text must be 22–24 pixels');
      await view.locator('#chat-question').fill('');
      const current=await state();assert.equal(current.busy,false);assert.equal(current.connection,undefined);assert.equal(current.messages.length,0);
      await preserved();const after=await indexProof('capture-preflight-after');assert.deepEqual(after.bytes,preflightIndex.bytes);
      assert.deepEqual(after.entries,preflightIndex.entries);
      checks.push('installed archive and six private Code directories; native fullscreen/framebuffer typography; unsent draft cleared; exact source/config/index retained');
      Object.assign(result,{status:'passed',mode:'landscape-capture-preflight-only',preflightTypography:font,
        notExecuted:['Julia controller/probe','measurements','CLI connection','model request','implementation','assistant transcript scrolling','portrait Short capture']});
    }else{
    observer=setInterval(()=>{void observe().catch(error=>{result.observationError=String(error);});},200);
    const measureBibliography=async label=>{
      const beforeIndex=await indexProof(`${label}-before-measurements`);
      assert.deepEqual(beforeIndex.bytes,index,'Measurement setup begins with the previously qualified whole index');
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
      const afterIndex=await indexProof(`${label}-after-measurements`);
      assert.deepEqual(afterIndex.entries,beforeIndex.entries,'Real measurements preserve every staged mode, object, stage, flag and path');
      result.indexProofs.at(-1).statCacheChanged=JSON.stringify(afterIndex.cache)!==JSON.stringify(beforeIndex.cache);
      result.indexProofs.at(-1).wholeBytesChanged=!afterIndex.bytes.equals(beforeIndex.bytes);
      index=afterIndex.bytes;
      if(proofs)await fs.writeFile(path.join(proofs,`${label}-measurements.json`),JSON.stringify(receipts,null,2));
      return receipts;
    };
    const baselineMeasurements=bibliography?await measureBibliography('baseline'):undefined;
    await vscode.commands.executeCommand('perfchecker.openChat');view=await findChat();
    if(bibliography){
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
    const beforePrepareIndex=await indexProof('before-prepare');assert.deepEqual(beforePrepareIndex.bytes,index);
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
    assert.deepEqual((await indexProof('after-prepare')).bytes,beforePrepareIndex.bytes,'Prepare preserves the whole index byte-exact');
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
    const beforeApply=await indexProof('before-apply');assert.deepEqual(beforeApply.bytes,index);
    await click('Apply reviewed changes');await eventually(async()=>!((await state()).busy)&&(await state()).proposal?.applied,'Actual Apply completes');
    assert.deepEqual((await indexProof('after-apply')).bytes,beforeApply.bytes,'Apply preserves the whole index byte-exact before independent measurements');
    assert.notEqual(await fs.readFile(sourceFile,'utf8'),source);
    const appliedProbe=await probe(root);
    if(bibliography){
      assert.equal(appliedProbe.sourceSha256,candidateProbe.sourceSha256);assert.equal(appliedProbe.dependencyGraphSha256,baselineProbe.dependencyGraphSha256);
      result.fixture.applied=appliedProbe;await presentation('applied',()=>capture('applied'));await measureBibliography('applied');
      await vscode.commands.executeCommand('perfchecker.openChat');view=await findChat();
      await view.getByRole('tab',{name:'02 · Implementation',exact:true}).click();
    }else assert.equal(appliedProbe,candidateBytes);
    assert.deepEqual(await fs.readFile(path.join(root,'.git','index')),index);assert.equal(await git('rev-parse','HEAD'),head);
    const beforeRestore=await indexProof('before-restore');assert.deepEqual(beforeRestore.bytes,index);
    await click('Restore previous code');await eventually(async()=>!((await state()).busy)&&!(await state()).proposal?.applied,'Actual Restore completes');
    assert.deepEqual((await indexProof('after-restore')).bytes,beforeRestore.bytes,'Restore preserves the whole index byte-exact before independent verification');
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
    }
  }catch(error){
    primaryError=error;Object.assign(result,{status:'failed',error:String(error),stack:error.stack});
    try{await indexProof('failure-before-cleanup');}catch(snapshotError){result.failureIndexError=String(snapshotError);}
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
