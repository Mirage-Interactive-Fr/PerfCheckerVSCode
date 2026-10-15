import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {spawn as nativeSpawn} from 'node:child_process';
import * as nativeChildProcess from 'node:child_process';
import * as entryFs from 'node:fs';
import {randomBytes, createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp, writeFile, readFile, readdir, mkdir, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const entryVariable='PERFCHECKER_SACRIFICIAL_ENTRY',entryLimit=2048;
const entryPhase=args=>args[0]==='--version'?'version':args[0]==='--help'?'global-help':
  args[0]==='exec'&&args[1]==='--help'?'exec-help':args[0]==='login'&&args[1]==='status'?'login-status':'fixture-operation';
const safeEntryError=error=>({name:['Error','TypeError','RangeError'].includes(error?.name)?error.name:'Error',
  ...(typeof error?.code==='string'&&/^(?:E[A-Z0-9_]{1,30}|ERR_[A-Z0-9_]{1,40})$/.test(error.code)?{code:error.code}:{})});
const sameEntryFile=(left,right)=>left.isFile()&&right.isFile()&&left.nlink===1n&&right.nlink===1n&&
  left.ino!==0n&&left.birthtimeNs>0n&&left.dev===right.dev&&left.ino===right.ino&&left.birthtimeNs===right.birthtimeNs;
function createEntryProbe(script,args){
  const nonce=randomBytes(24).toString('hex'),file=path.join(path.dirname(script),`entry-${nonce}.json`);
  const descriptor=entryFs.openSync(file,entryFs.constants.O_CREAT|entryFs.constants.O_EXCL|entryFs.constants.O_RDWR,0o600);
  try{
    const identity=entryFs.fstatSync(descriptor,{bigint:true});
    if(!identity.isFile()||identity.nlink!==1n||identity.ino===0n||identity.birthtimeNs<=0n)throw new Error('Ambiguous private entry file');
    return {file,nonce,identity,phase:entryPhase(args),image:entryFs.realpathSync(process.execPath),started:Date.now()};
  }catch(error){entryFs.rmSync(file,{force:true});throw error;}
  finally{entryFs.closeSync(descriptor);}
}
function inspectEntryProbe(probe,ownerPid,closed=Date.now()){
  let descriptor;
  const unavailable=(status,reason)=>({status,reason});
  try{
    const pathBefore=entryFs.lstatSync(probe.file,{bigint:true});
    if(pathBefore.isSymbolicLink()||!sameEntryFile(probe.identity,pathBefore))return unavailable('refused','private-file-identity');
    if(pathBefore.size>BigInt(entryLimit))return unavailable('refused','size-limit');
    descriptor=entryFs.openSync(probe.file,entryFs.constants.O_RDONLY|(entryFs.constants.O_NOFOLLOW??0));
    const before=entryFs.fstatSync(descriptor,{bigint:true});
    if(!sameEntryFile(pathBefore,before)||before.size!==pathBefore.size)return unavailable('refused','private-file-identity');
    const bytes=Buffer.alloc(entryLimit+1),count=entryFs.readSync(descriptor,bytes,0,bytes.length,0);
    const after=entryFs.fstatSync(descriptor,{bigint:true}),pathAfter=entryFs.lstatSync(probe.file,{bigint:true});
    if(!sameEntryFile(before,after)||!sameEntryFile(after,pathAfter)||before.size!==after.size||after.size!==BigInt(count)||
      before.mtimeNs!==after.mtimeNs||after.mtimeNs!==pathAfter.mtimeNs)return unavailable('refused','private-file-changed');
    if(count===0)return unavailable('unavailable','script-entry-not-observed');
    if(count>entryLimit)return unavailable('refused','size-limit');
    const value=JSON.parse(bytes.subarray(0,count).toString('utf8'));
    if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='at,image,nonce,phase,pid,ppid,schema'||
      value.schema!==1||value.nonce!==probe.nonce||value.phase!==probe.phase||value.image!==probe.image||
      !Number.isSafeInteger(ownerPid)||ownerPid<=0||value.ppid!==ownerPid||!Number.isSafeInteger(value.pid)||value.pid<=0||value.pid===ownerPid||
      !Number.isSafeInteger(value.at)||value.at<probe.started||value.at>closed)return unavailable('refused','entry-identity');
    return {status:'script-entry-observed',phase:value.phase,pid:value.pid,ppid:value.ppid,image:'expected-native-node',at:value.at};
  }catch(error){return {status:'unavailable',reason:'inspection-error',error:safeEntryError(error)};}
  finally{if(descriptor!==undefined)try{entryFs.closeSync(descriptor);}catch{}}
}
function observeFixtureSpawn(delegate,args,options,script,record=value=>console.log(JSON.stringify(value))){
  let probe,probeError,child;
  try{probe=createEntryProbe(script,args);}catch(error){probeError=safeEntryError(error);}
  const started=Date.now();let stdoutBytes=0,stderrBytes=0,firstOutput,spawnError,finished=false;
  const finish=(code,signal,terminalEvent='close')=>{
    if(finished)return;finished=true;
    const closed=Date.now(),marker=probe?inspectEntryProbe(probe,child?.pid,closed):{status:'unavailable',reason:'probe-setup-error',error:probeError};
    let markerRetired=true;
    try{if(probe)entryFs.rmSync(probe.file,{force:true});}catch{markerRetired=false;}
    try{record({event:'sacrificial-windows-cli-timing',phase:entryPhase(args),ownerPid:child?.pid??null,
      terminalEvent,startedAt:started,...(terminalEvent==='close'?{closedAt:closed}:{eventAt:closed}),milliseconds:closed-started,firstOutputMilliseconds:firstOutput,
      stdoutBytes,stderrBytes,code,signal,spawnError,marker,markerRetired});}catch{/* Diagnostic output never replaces the operation result. */}
  };
  try{
    child=delegate(probe?{...options,env:{...options.env,[entryVariable]:JSON.stringify({file:probe.file,nonce:probe.nonce,
      dev:String(probe.identity.dev),ino:String(probe.identity.ino),birthtimeNs:String(probe.identity.birthtimeNs),phase:probe.phase})}}:options);
  }catch(error){spawnError=safeEntryError(error);finish(null,null,'synchronous-spawn-error');throw error;}
  const output=(kind,chunk)=>{if(firstOutput===undefined)firstOutput=Date.now()-started;kind==='stdout'?stdoutBytes+=Buffer.byteLength(chunk):stderrBytes+=Buffer.byteLength(chunk);};
  child.stdout.on('data',chunk=>output('stdout',chunk));child.stderr.on('data',chunk=>output('stderr',chunk));
  child.once('error',error=>{spawnError=safeEntryError(error);finish(null,null,'spawn-error');});
  child.once('close',finish);
  return child;
}
function fixtureChildClose(child,cleanupMs=2000){
  return new Promise((resolve,reject)=>{
    let failure,timer;
    const retire=()=>{clearTimeout(timer);child.removeListener('error',onError);child.removeListener('close',onClose);};
    const onError=error=>{
      failure??=error;
      timer??=setTimeout(()=>{
        retire();reject(Object.assign(new AggregateError([failure], 'Fixture child close was not observed after its original error.'),{cleanupQualified:false}));
      },cleanupMs);
    };
    const onClose=(code,signal)=>{retire();failure?reject(failure):resolve({code,signal});};
    child.on('error',onError);child.once('close',onClose);
  });
}

// Exercise HTTP and real process lifetime with a sacrificial CLI, not a model response claim.
const ownerDiagnosticOrigin={
  sha256:'bc61f9fa172069c61722e0691900d3ddf8a39ce143fd9d553b252304dbc55850',
  version:'1.0.3',commit:'73b99deb87efaf45bd5e96036f755e42c748bdab',
  tree:'3722727a870402497078e63da78be90d606f5ed5',packagedOnceOn:'Linux',run:'38653410110'
};
const ownerDiagnosticHashes={
  'dist/windowsOwnedProcess.js':'8abf0b32d794c7f35a257c5abaae395adc842b44d6b6d8088bd3f40247765ca0',
  'resources/windows-owned-process.ps1':'c859b0009de31a60246c2a487752dcedb4a5c9b9f06c0a862a14771a9596c318'
};
const ownerStageNames=['powershell-entry','add-type-complete','parent-verified','job-configured','native-suspended','job-assigned','native-resumed'];
const ownerTraceLimit=8192,fileTimeEpoch=116444736000000000n;
const ownerDiagnosticStates=new Map(),hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
function assertOwnerDiagnosticContext(platform=process.platform,env=process.env){
  if(platform!=='win32'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
    env.PERFCHECKER_NATIVE_STAGE!=='connector-workers'||env.PERFCHECKER_NATIVE_SCOPE!=='windows-stable')
    throw new Error('Owner stage diagnostics require the explicit Windows-only connector workflow.');
}
function createOwnerStageProbe(dir){
  const nonce=randomBytes(24).toString('hex');
  return {file:path.join(dir,`owner-${nonce}.jsonl`),nonce};
}
function instrumentOwnerLauncher(source,probe){
  const ps=value=>"'"+value.replaceAll("'","''")+"'";
  const psEntry=[
    '# Diagnostic-only observer; failures never replace the original launcher outcome.',
    '$diagnosticStream=$null',
    'try {',
    '  $tracePath='+ps(probe.file)+'; $traceNonce='+ps(probe.nonce),
    '  $diagnosticStream=[IO.FileStream]::new($tracePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)',
    '  $row=[ordered]@{schema=1;nonce=$traceNonce;phase="powershell-entry";ownerPid=$PID;ownerStarted=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc().ToString();at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();childPid=0;childStarted=$null}',
    '  $bytes=[Text.Encoding]::UTF8.GetBytes(($row|ConvertTo-Json -Compress)+[Environment]::NewLine)',
    '  if ($bytes.Length -le 1024) { $diagnosticStream.Write($bytes,0,$bytes.Length);$diagnosticStream.Flush() }',
    '} catch {}',
    ''
  ].join('\n');
  const traceMethod=[
    '    // Diagnostic-only stages; original process/Job calls and errors are unchanged.',
    '    public static System.IO.FileStream DiagnosticStream;',
    '    public static void ObserveStartupStage(string phase,uint child,IntPtr childHandle) {',
    '        try {',
    '            if (Array.IndexOf(new string[] { "add-type-complete","parent-verified","job-configured","native-suspended","job-assigned","native-resumed" },phase)<0) return;',
    '            var stream=DiagnosticStream; if(stream==null || !stream.CanWrite) return;',
    '            long created,ended,kernel,user,childCreated=0;',
    '            if (!GetProcessTimes(GetCurrentProcess(),out created,out ended,out kernel,out user)) return;',
    '            if (child!=0 && (childHandle==IntPtr.Zero || !GetProcessTimes(childHandle,out childCreated,out ended,out kernel,out user))) return;',
    '            if (stream.Length>'+ownerTraceLimit+'-1024) return;',
    '                string record="{\\"schema\\":1,\\"nonce\\":\\"'+probe.nonce+'\\",\\"phase\\":\\""+phase+"\\",\\"ownerPid\\":"+Process.GetCurrentProcess().Id+",\\"ownerStarted\\":\\""+created+"\\",\\"at\\":"+DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+",\\"childPid\\":"+child+",\\"childStarted\\":"+(child==0?"null":"\\""+childCreated+"\\"")+"}\\n";',
    '                byte[] bytes=Encoding.UTF8.GetBytes(record); if(bytes.Length>1024)return;',
    '                stream.Position=stream.Length;stream.Write(bytes,0,bytes.Length);stream.Flush();',
    '        } catch { }',
    '    }',
    ''
  ].join('\n');
  const injections=[
    ["$ErrorActionPreference = 'Stop'\n",psEntry],
    ['    static void Check(bool success,string operation) {\n',traceMethod,'before'],
    ["'@\n",'    try { [PerfCheckerOwnedProcess]::DiagnosticStream=$diagnosticStream; [PerfCheckerOwnedProcess]::ObserveStartupStage("add-type-complete",0,[IntPtr]::Zero) } catch {}\n'],
    ['            if (WaitForSingleObject(parent,0)!=258) throw new InvalidOperationException("The owner parent has already stopped.");\n','            ObserveStartupStage("parent-verified",0,IntPtr.Zero);\n'],
    ['            Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))),"Set private Job limits");\n','            ObserveStartupStage("job-configured",0,IntPtr.Zero);\n'],
    ['            Check(CreateProcessW(application,command,IntPtr.Zero,IntPtr.Zero,true,0x00080004,IntPtr.Zero,directory,ref startup,out process),"Create suspended native process");\n','            ObserveStartupStage("native-suspended",process.processId,process.process);\n'],
    ['            Check(AssignProcessToJobObject(job,process.process),"Assign native process to private Job"); assigned=true;\n','            ObserveStartupStage("job-assigned",process.processId,process.process);\n'],
    ['            if (ResumeThread(process.thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(),"Resume owned process");\n','            ObserveStartupStage("native-resumed",process.processId,process.process);\n'],
    ["    [Console]::Error.WriteLine('PerfChecker Windows process owner failed: ' + $_.Exception.Message)\n    exit 1\n}", ' finally { if ($diagnosticStream) { try { $diagnosticStream.Dispose() } catch {} } }']
  ];
  let result=source;
  for(const [anchor,addition,where] of injections){
    if(source.split(anchor).length!==2)throw new Error('Canonical owner diagnostic anchor is not unique.');
    result=result.replace(anchor,where==='before'?addition+anchor:anchor+addition);
  }
  let restored=result;
  for(const [anchor,addition,where] of [...injections].reverse())
    restored=restored.replace(where==='before'?addition+anchor:anchor+addition,anchor);
  assert.equal(restored,source);
  return result;
}
function readOwnerStages(probe,ownerPid,started,observedAt){
  let descriptor;
  const absent=reason=>({status:'unobserved',reason,observedAt});
  try{
    let beforePath;
    try{beforePath=entryFs.lstatSync(probe.file,{bigint:true});}
    catch(error){
      if(error.code==='ENOENT'&&!probe.identity&&!probe.pathObserved)return absent('no-stage-observed');
      throw error;
    }
    probe.pathObserved=true;
    if(beforePath.isSymbolicLink()||!sameEntryFile(probe.identity??beforePath,beforePath))return absent('private-file-identity');
    if(beforePath.size>BigInt(ownerTraceLimit))return absent('size-limit');
    descriptor=entryFs.openSync(probe.file,entryFs.constants.O_RDONLY|(entryFs.constants.O_NOFOLLOW??0));
    const before=entryFs.fstatSync(descriptor,{bigint:true}),buffer=Buffer.alloc(ownerTraceLimit+1);
    if(!sameEntryFile(beforePath,before)||before.size!==beforePath.size)return absent('private-file-identity');
    const count=entryFs.readSync(descriptor,buffer,0,buffer.length,0);
    const after=entryFs.fstatSync(descriptor,{bigint:true}),afterPath=entryFs.lstatSync(probe.file,{bigint:true});
    if(!sameEntryFile(before,after)||!sameEntryFile(after,afterPath)||count!==Number(before.size)||
      before.size!==after.size||after.mtimeNs!==before.mtimeNs||after.mtimeNs!==afterPath.mtimeNs)return absent('private-file-changed');
    if(count===0)return absent('no-stage-observed');
    if(count>ownerTraceLimit)return absent('size-limit');
    const text=buffer.subarray(0,count).toString('utf8');
    if(!text.endsWith('\n'))return absent('partial-stage-write');
    const rows=text.trim().split(/\r?\n/).map(line=>JSON.parse(line));
    if(rows.length>ownerStageNames.length)return absent('stage-limit');
    let incarnation,previous=started,childIdentity,previousPhase=-1;
    const stages=[];
    for(const row of rows){
      const phaseIndex=ownerStageNames.indexOf(row?.phase);
      if(!row||Object.keys(row).sort().join(',')!=='at,childPid,childStarted,nonce,ownerPid,ownerStarted,phase,schema'||
        row.schema!==1||row.nonce!==probe.nonce||phaseIndex<=previousPhase||row.ownerPid!==ownerPid||
        !Number.isSafeInteger(ownerPid)||ownerPid<=0||typeof row.ownerStarted!=='string'||!/^[0-9]{17,19}$/.test(row.ownerStarted)||
        !Number.isSafeInteger(row.at)||row.at<previous||row.at>observedAt)return absent('stage-identity');
      const born=Number((BigInt(row.ownerStarted)-fileTimeEpoch)/10000n);
      if(born<started-1||born>row.at||incarnation&&incarnation!==row.ownerStarted)return absent('owner-incarnation');
      incarnation=row.ownerStarted;previous=row.at;previousPhase=phaseIndex;
      if(phaseIndex<4){if(row.childPid!==0||row.childStarted!==null)return absent('child-identity');}
      else{
        if(!Number.isSafeInteger(row.childPid)||row.childPid<=0||row.childPid===ownerPid||
          typeof row.childStarted!=='string'||!/^[0-9]{17,19}$/.test(row.childStarted)||BigInt(row.childStarted)<BigInt(incarnation)||
          Number((BigInt(row.childStarted)-fileTimeEpoch)/10000n)>row.at)return absent('child-identity');
        const identity=row.childPid+':'+row.childStarted;
        if(childIdentity&&childIdentity!==identity)return absent('child-incarnation');
        childIdentity=identity;
      }
      stages.push({phase:row.phase,ownerPid:row.ownerPid,ownerStarted:row.ownerStarted,at:row.at,
        ...(row.childPid?{childPid:row.childPid,childStarted:row.childStarted}:{})});
    }
    const createdAt=Number(before.birthtimeNs/1000000n);
    if(createdAt<started-1||createdAt>stages[0].at||createdAt>observedAt)return absent('private-file-creation-window');
    // Bind the first identity only after every row and the actual owner window is verified.
    probe.identity??=before;
    return {status:'observed',observedAt,stages};
  }catch(error){return {...absent('inspection-error'),error:safeEntryError(error)};}
  finally{if(descriptor!==undefined)try{entryFs.closeSync(descriptor);}catch{}}
}
function observeOwnerStages(delegate,args,options,state){
  const started=Date.now();let child,done;
  state.started=started;state.closed=false;state.complete=new Promise(resolve=>{done=resolve;});
  const finish=(code,signal)=>{
    if(state.closed)return;state.closed=true;clearTimeout(state.timer);
    state.after=readOwnerStages(state.probe,child?.pid,started,Date.now());state.outcome={code,signal};done();
  };
  try{child=delegate(options);}catch(error){
    state.spawnError=safeEntryError(error);state.spawnFailed=true;state.closed=true;done();throw error;
  }
  state.child=child;
  child.once('error',error=>{state.spawnError=safeEntryError(error);});
  child.once('close',finish);
  state.beforeDeadline=()=>{
    const at=Date.now();
    if(state.closed||at>=started+10000){
      state.before={status:'unobserved',reason:state.closed?'already-closed':'pre-deadline-observation-missed',observedAt:at};return;
    }
    const snapshot=readOwnerStages(state.probe,child.pid,started,at),completedAt=Date.now();
    state.before=completedAt<started+10000?{...snapshot,completedAt}:
      {status:'unobserved',reason:'pre-deadline-observation-missed',observedAt:at,completedAt};
  };
  state.timer=setTimeout(state.beforeDeadline,9000);
  return child;
}
function externalOwnerScript(context,nonce){
  const literal=value=>"'"+value.replaceAll("'","''")+"'";
  return [
    "$ErrorActionPreference='Stop'",
    '$ownerId='+context.ownerPid+';$parentId='+context.parentPid+';$deadline='+context.deadline+'L;$nonce='+JSON.stringify(nonce),
    '$anchorOwner=$null;$anchorParent=$null',
    'function Read-Identity([int]$id) {',
    '  $p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$id) -ErrorAction Stop',
    '  if (!$p) { return $null }',
    '  @{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;started=$p.CreationDate.ToUniversalTime().ToString("o");executable=$p.ExecutablePath;kernel=[string]$p.KernelModeTime;user=[string]$p.UserModeTime;state=$p.ExecutionState}',
    '}',
    'function Same-Identity($a,$b) { $null -ne $a -and $null -ne $b -and $a.pid -eq $b.pid -and $a.parent -eq $b.parent -and $a.started -eq $b.started -and $a.executable -eq $b.executable }',
    'for ($index=0; $index -lt 3; $index++) {',
    '  $due='+context.started+'L+@(0,5000,8000)[$index]',
    '  while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $due -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) { Start-Sleep -Milliseconds 20 }',
    '  if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $deadline) { break }',
    '  $beforeAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$parentBefore=Read-Identity $parentId;$ownerBefore=Read-Identity $ownerId',
    '  $reason=$null;$pairs=@();$queue=@()',
    '  if (!$parentBefore -or !$ownerBefore -or $ownerBefore.parent -ne $parentId -or $ownerBefore.executable -ine '+literal(context.ownerExecutable)+' -or $parentBefore.executable -ine '+literal(context.parentExecutable)+') { $reason="initial-identity-unavailable" }',
    '  elseif ([DateTimeOffset]::Parse($ownerBefore.started).ToUnixTimeMilliseconds() -lt '+(context.started-1)+'L -or [DateTimeOffset]::Parse($ownerBefore.started).ToUnixTimeMilliseconds() -gt '+(context.spawnedAt+1)+'L -or ($anchorOwner -and !(Same-Identity $anchorOwner $ownerBefore)) -or ($anchorParent -and !(Same-Identity $anchorParent $parentBefore))) { $reason="owner-incarnation-refused" }',
    '  else {',
    '    $anchorOwner=$ownerBefore;$anchorParent=$parentBefore',
    '    $queue=@(@{identity=$ownerBefore;depth=0})',
    '    while ($queue.Count -gt 0 -and !$reason) {',
    '      $next=$queue[0];$queue=@($queue|Select-Object -Skip 1)',
    '      $parentNow=Read-Identity $next.identity.pid',
    '      if (!(Same-Identity $next.identity $parentNow)) { $reason="parent-identity-changed";break }',
    '      if ($next.depth -ge 2) { continue }',
    '      $rows=@(Get-CimInstance Win32_Process -Filter ("ParentProcessId="+$next.identity.pid) -ErrorAction Stop)',
    '      if ($pairs.Count+$rows.Count -gt 7) { $reason="descendant-limit";break }',
    '      foreach ($row in $rows) {',
    '        $before=@{pid=[int]$row.ProcessId;parent=[int]$row.ParentProcessId;started=$row.CreationDate.ToUniversalTime().ToString("o");executable=$row.ExecutablePath;kernel=[string]$row.KernelModeTime;user=[string]$row.UserModeTime;state=$row.ExecutionState}',
    '        $after=Read-Identity $before.pid',
    '        if (!(Same-Identity $before $after)) { $reason="descendant-identity-changed";break }',
    '        $pairs+=@{before=$before;after=$after;depth=$next.depth+1};$queue+=@{identity=$after;depth=$next.depth+1}',
    '      }',
    '      if (!(Same-Identity $next.identity (Read-Identity $next.identity.pid))) { $reason="parent-identity-changed" }',
    '    }',
    '  }',
    '  $ownerAfter=Read-Identity $ownerId;$parentAfter=Read-Identity $parentId',
    '  if (!(Same-Identity $ownerBefore $ownerAfter) -or !(Same-Identity $parentBefore $parentAfter)) { $reason="final-identity-unavailable" }',
    '  $afterAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '  @{schema=1;nonce=$nonce;observerPid=$PID;index=$index;beforeAt=$beforeAt;afterAt=$afterAt;reason=$reason;parent=@{before=$parentBefore;after=$parentAfter};owner=@{before=$ownerBefore;after=$ownerAfter};descendants=@($pairs)}|ConvertTo-Json -Depth 8 -Compress',
    '  if ($reason) { break }',
    '}'
  ].join('\n');
}
function qualifyExternalOwnerFrame(frame,context,observerPid,nonce,receivedAt,canonical=entryFs.realpathSync){
  const keys='afterAt,beforeAt,descendants,index,nonce,observerPid,owner,parent,reason,schema';
  assert(frame&&Object.keys(frame).sort().join(',')===keys,'External frame schema is exact');
  assert.equal(frame.schema,1);assert.equal(frame.nonce,nonce);assert.equal(frame.observerPid,observerPid);
  assert(Number.isSafeInteger(observerPid)&&observerPid>0&&observerPid!==context.ownerPid&&observerPid!==context.parentPid);
  assert(Number.isSafeInteger(frame.index)&&frame.index>=0&&frame.index<3);
  assert(Number.isSafeInteger(frame.beforeAt)&&Number.isSafeInteger(frame.afterAt)&&frame.beforeAt>=context.started&&
    frame.afterAt>=frame.beforeAt&&frame.afterAt<=receivedAt&&receivedAt<context.deadline,'External frame is timely');
  assert.equal(frame.reason,null,'External inspection is conclusive');
  const identify=(pair,expectedPid,expectedParent,expectedExecutable,latestBorn=frame.beforeAt)=>{
    assert(pair&&Object.keys(pair).sort().join(',')==='after,before');
    for(const row of [pair.before,pair.after]){
      assert(row&&Object.keys(row).sort().join(',')==='executable,kernel,parent,pid,started,state,user');
      assert(Number.isSafeInteger(row.pid)&&row.pid>0&&Number.isSafeInteger(row.parent)&&row.parent>0);
      assert(typeof row.started==='string'&&/^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.started)&&Number.isFinite(Date.parse(row.started)));
      assert(typeof row.executable==='string'&&row.executable.length>0&&row.executable.length<=2048);
      assert(typeof row.kernel==='string'&&/^\d{1,20}$/.test(row.kernel)&&typeof row.user==='string'&&/^\d{1,20}$/.test(row.user));
      assert(row.state===null||Number.isSafeInteger(row.state)&&row.state>=0&&row.state<=10);
    }
    const before=pair.before,after=pair.after;
    assert.equal(after.pid,before.pid);assert.equal(after.parent,before.parent);assert.equal(after.started,before.started);
    const beforeImage=canonical(before.executable).toLowerCase(),afterImage=canonical(after.executable).toLowerCase();
    assert.equal(afterImage,beforeImage);
    if(expectedPid!==undefined)assert.equal(before.pid,expectedPid);
    if(expectedParent!==undefined)assert.equal(before.parent,expectedParent);
    if(expectedExecutable!==undefined)assert.equal(beforeImage,expectedExecutable.toLowerCase());
    assert(BigInt(after.kernel)>=BigInt(before.kernel)&&BigInt(after.user)>=BigInt(before.user));
    assert(Date.parse(before.started)<=latestBorn);
    return {pid:before.pid,parent:before.parent,started:before.started,imageSha256:hashBytes(Buffer.from(beforeImage)),
      before:{kernel:before.kernel,user:before.user,state:before.state},after:{kernel:after.kernel,user:after.user,state:after.state}};
  };
  const parent=identify(frame.parent,context.parentPid,undefined,context.parentExecutable);
  const owner=identify(frame.owner,context.ownerPid,context.parentPid,context.ownerExecutable);
  assert(Date.parse(owner.started)>=context.started-1&&Date.parse(owner.started)<=context.spawnedAt+1&&
    Date.parse(owner.started)>=Date.parse(parent.started));
  assert(Array.isArray(frame.descendants)&&frame.descendants.length<=7);
  const known=new Map([[owner.pid,{...owner,depth:0}]]),descendants=[];
  for(const pair of frame.descendants){
    assert(pair&&Object.keys(pair).sort().join(',')==='after,before,depth'&&[1,2].includes(pair.depth));
    const row=identify({before:pair.before,after:pair.after},undefined,undefined,undefined,frame.afterAt);
    const parentRow=known.get(row.parent);
    assert(parentRow&&pair.depth===parentRow.depth+1&&!known.has(row.pid),'Only qualified descendant links are followed');
    assert(Date.parse(row.started)>=Date.parse(parentRow.started));
    known.set(row.pid,{...row,depth:pair.depth});descendants.push({...row,depth:pair.depth});
  }
  return {index:frame.index,beforeAt:frame.beforeAt,afterAt:frame.afterAt,receivedAt,parent,owner,descendants};
}
function observeExternalOwner(delegate,args,options,state){
  const started=Date.now();let child,done;
  state.started=started;state.closed=false;state.complete=new Promise(resolve=>{done=resolve;});
  try{child=delegate(options);}catch(error){state.spawnError=safeEntryError(error);state.spawnFailed=true;state.closed=true;done();throw error;}
  const spawnedAt=Date.now();
  state.child=child;
  const external=state.external={samples:[],unknown:[],closed:false,started:false};
  const stop=reason=>{
    clearTimeout(external.timer);external.stopReason??=reason;
    if(external.child&&!external.closed&&!external.stopRequested){
      external.stopRequested=true;
      try{external.child.kill('SIGKILL');}catch(error){external.unknown.push({reason:'observer-stop-error',error:safeEntryError(error)});}
    }
  };
  external.stop=stop;
  child.once('error',error=>{state.spawnError=safeEntryError(error);});
  child.once('close',(code,signal)=>{state.closed=true;state.outcome={code,signal};stop('owner-closed');done();});
  let context;
  try{
    assert(Number.isSafeInteger(child.pid)&&child.pid>0);
    const powershell=state.externalExecutable??path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    context=Object.freeze({started,spawnedAt,deadline:started+9000,ownerPid:child.pid,parentPid:process.pid,
      ownerExecutable:powershell,parentExecutable:process.execPath,cwd:options.cwd});
  }catch(error){external.unknown.push({reason:'context-unavailable',error:safeEntryError(error)});}
  queueMicrotask(()=>{
    if(!context||state.closed){external.closed=true;external.unknown.push({reason:state.closed?'owner-closed-before-observer':'context-unavailable'});return;}
    const nonce=randomBytes(24).toString('hex');let resolveClose,stdout='',stdoutBytes=0,stderrBytes=0;
    external.complete=new Promise(resolve=>{resolveClose=resolve;});
    const finish=(code,signal)=>{
      if(external.closed)return;external.closed=true;clearTimeout(external.timer);
      if(stdout.trim())external.unknown.push({reason:'partial-observer-frame'});
      external.outcome={code,signal};resolveClose();
    };
    const accept=line=>{
      try{
        assert(!state.closed,'Owner close precedes this frame');assert(line.length<=16384);
        const frame=JSON.parse(line);
        assert(frame.index===external.samples.length,'External frames are ordered without retries');
        const sample=qualifyExternalOwnerFrame(frame,context,external.child.pid,nonce,Date.now());
        const anchor={ownerStarted:sample.owner.started,parentStarted:sample.parent.started};
        if(external.anchor)assert.deepEqual(anchor,external.anchor,'Owner and parent incarnations remain fixed');
        else external.anchor=anchor;
        external.samples.push(sample);
      }catch(error){external.unknown.push({reason:'frame-refused',error:safeEntryError(error)});stop('frame-refused');}
    };
    try{
      // The original command has returned and armed its own 10s timer before any observer I/O.
      context=Object.freeze({...context,ownerExecutable:entryFs.realpathSync(context.ownerExecutable),
        parentExecutable:entryFs.realpathSync(context.parentExecutable)});
      external.context=context;
      assert(Date.now()<context.deadline,'External observer preparation is timely');
      const spawnObserver=state.externalSpawn??nativeSpawn;
      external.child=spawnObserver(context.ownerExecutable,['-NoLogo','-NoProfile','-NonInteractive','-Command',externalOwnerScript(context,nonce)],
        {cwd:context.cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
      external.started=true;
      external.child.once('error',error=>{external.unknown.push({reason:'observer-error',error:safeEntryError(error)});});
      external.child.once('close',finish);
      assert(Number.isSafeInteger(external.child.pid)&&external.child.pid>0&&
        external.child.pid!==context.ownerPid&&external.child.pid!==context.parentPid,'Observer is distinct from owner and caller');
      external.child.stdout.on('data',chunk=>{
        stdoutBytes+=chunk.length;
        if(stdoutBytes>65536){external.unknown.push({reason:'stdout-limit'});stop('stdout-limit');return;}
        stdout+=chunk.toString('utf8');
        let newline;while((newline=stdout.indexOf('\n'))>=0){const line=stdout.slice(0,newline).replace(/\r$/,'');stdout=stdout.slice(newline+1);if(line)accept(line);}
      });
      external.child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>2048)stop('stderr-limit');});
      if(!external.closed)external.timer=setTimeout(()=>stop('absolute-deadline'),Math.max(0,context.deadline-Date.now()));
    }catch(error){
      external.unknown.push({reason:'observer-spawn-error',error:safeEntryError(error)});
      if(!external.child){external.spawnFailed=true;external.closed=true;resolveClose();}
      else stop('observer-setup-error');
    }
  });
  return child;
}
async function prepareOwnerDiagnostic(root){
  if(process.env.PERFCHECKER_TEST_OWNER_DIAGNOSTIC!=='1')return;
  assertOwnerDiagnosticContext();
  const mode=process.env.PERFCHECKER_TEST_OWNER_DIAGNOSTIC_MODE||'instrumented';
  assert(['instrumented','external'].includes(mode),'Owner diagnostic mode is explicit');
  const archive=JSON.parse(await readFile(path.resolve('native-qualification-results/connector-workers-archive.json'),'utf8'));
  assert.equal(archive.sha256,ownerDiagnosticOrigin.sha256);assert.deepEqual(archive.origin,ownerDiagnosticOrigin);
  assert.equal(archive.compiled,false);
  const sources={};
  for(const [name,expected] of Object.entries(ownerDiagnosticHashes)){
    const bytes=await readFile(path.resolve(name));assert.equal(hashBytes(bytes),expected);
    assert.equal(archive.entries.find(entry=>entry.path===name)?.sha256,expected);sources[name]=bytes;
  }
  const dir=await mkdtemp(path.join(root,'owner-diagnostic-'));
  if(mode==='external'){
    ownerDiagnosticStates.set(root,{mode,dir,sources,used:false,diagnosticOnly:true});
    return;
  }
  await mkdir(path.join(dir,'dist'));await mkdir(path.join(dir,'resources'));
  const probe=createOwnerStageProbe(dir);
  const launcher=instrumentOwnerLauncher(sources['resources/windows-owned-process.ps1'].toString('utf8'),probe);
  await writeFile(path.join(dir,'dist/windowsOwnedProcess.js'),sources['dist/windowsOwnedProcess.js'],{flag:'wx'});
  await writeFile(path.join(dir,'resources/windows-owned-process.ps1'),launcher,{flag:'wx'});
  const state={probe,dir,sources,used:false,diagnosticOnly:true,launcherSha256:hashBytes(Buffer.from(launcher))};
  state.owner=require(path.join(dir,'dist/windowsOwnedProcess.js'));
  ownerDiagnosticStates.set(root,state);
}
async function retireOwnerDiagnostic(root,cleanupMs=2000){
  const state=ownerDiagnosticStates.get(root);if(!state)return true;
  await Promise.resolve(); // Drain the already-scheduled observer start, without delaying the product launch.
  state.external?.stop('diagnostic-finally');
  clearTimeout(state.timer);
  let timer;
  const pending=[state.complete&&!state.closed?state.complete:undefined,
    state.external?.complete&&!state.external.closed?state.external.complete:undefined].filter(Boolean);
  if(pending.length)await Promise.race([Promise.all(pending),new Promise(resolve=>{timer=setTimeout(resolve,cleanupMs);})]);
  clearTimeout(timer);clearTimeout(state.timer);
  const physicallyClosed=Boolean(state.child)&&state.closed===true;
  const observerClosed=state.mode!=='external'||state.external?.closed===true||state.external?.started!==true;
  const safelyRetired=(!state.used||state.spawnFailed===true||physicallyClosed)&&observerClosed;
  let originalFilesUnchanged=false,cleanupError;
  try{originalFilesUnchanged=Object.entries(state.sources).every(([name,bytes])=>entryFs.readFileSync(path.resolve(name)).equals(bytes));}
  catch(error){cleanupError=safeEntryError(error);}
  let removed=false;
  if(safelyRetired)try{await rm(state.dir,{recursive:true,force:true});removed=true;}catch(error){cleanupError=safeEntryError(error);}
  const afterRefused=state.after?.status==='unobserved'&&!['no-stage-observed','close-not-observed','synchronous-spawn-error'].includes(state.after.reason);
  const observerStopFailed=state.external?.unknown.some(row=>row.reason==='observer-stop-error')??false;
  const result={schema:'perfchecker-windows-owner-diagnostic/1',diagnosticOnly:true,qualifiesCanonicalProduct:false,
    mode:state.mode??'instrumented',...(state.mode==='external'?{observerPerturbing:true,
      externalObserver:{physicalClose:state.external?.started===true&&state.external.closed===true,
        started:state.external?.started===true,pid:state.external?.child?.pid??null,
        samples:state.external?.samples??[],unknown:state.external?.unknown??[],outcome:state.external?.outcome,
        stopReason:state.external?.stopReason}}:{}),
    origin:ownerDiagnosticOrigin,originalHashes:ownerDiagnosticHashes,instrumentedLauncherSha256:state.launcherSha256,
    used:state.used,ownerPid:state.child?.pid??null,beforeDeadline:state.before??{status:'unobserved',reason:'closed-before-observation'},
    afterClose:state.after??{status:'unobserved',reason:state.mode==='external'?'external-owner-observation':state.spawnFailed?'synchronous-spawn-error':'close-not-observed'},
    spawnError:state.spawnError,outcome:state.outcome,physicalClose:physicallyClosed,
    originalFilesUnchanged,observerCleanupQualified:safelyRetired&&removed,temporaryFilesRetained:!removed,cleanupError};
  let receiptError;
  try{
    if(state.record)state.record(result);
    else entryFs.writeFileSync(path.resolve('native-qualification-results/windows-owner-startup.json'),JSON.stringify(result,null,2),{flag:'wx'});
  }catch(error){receiptError=error;console.log(JSON.stringify({event:'owner-diagnostic-record-error',error:safeEntryError(error)}));}
  finally{ownerDiagnosticStates.delete(root);}
  if(!safelyRetired||!removed||!originalFilesUnchanged||afterRefused||observerStopFailed||receiptError)
    throw Object.assign(new Error('Windows owner diagnostic security, receipt or retirement was not qualified.'),
      {observerRetired:safelyRetired&&removed,diagnosticError:receiptError? safeEntryError(receiptError):cleanupError});
  return safelyRetired&&removed;
}
let fixture;
const require = createRequire(import.meta.url), original = Module._load;
Module._load = function(name, ...args) {
  if (name === './windowsOwnedProcess') {
    const owner = original.call(this, name, ...args);
    return {...owner, spawnWindowsOwnedProcess: (cli, argv, options) => {
      const script=fixture;
      return cli === 'sacrificial-codex' ? observeFixtureSpawn(observedOptions=>
        {const state=ownerDiagnosticStates.get(path.dirname(script));
          if(state&&!state.used&&argv[0]==='--version'){
            state.used=true;
            return state.mode==='external'?
              observeExternalOwner(next=>owner.spawnWindowsOwnedProcess(process.execPath,[script,...argv],next),argv,observedOptions,state):
              observeOwnerStages(next=>state.owner.spawnWindowsOwnedProcess(process.execPath,[script,...argv],next),argv,observedOptions,state);
          }
          return owner.spawnWindowsOwnedProcess(process.execPath,[script,...argv],observedOptions);
        },argv,options,script) : owner.spawnWindowsOwnedProcess(cli,argv,options);
    }};
  }
  if (name === 'node:child_process') return {...nativeChildProcess, spawn: (cli, argv, options) =>
    cli === 'sacrificial-codex' ? nativeSpawn(process.execPath, [fixture, ...argv], options) : nativeSpawn(cli, argv, options)};
  return original.call(this, name, ...args);
};
let CodexConnector, inspectCodex, shutdownCodexPreflights;
try {({CodexConnector, inspectCodex, shutdownCodexPreflights} = require('../dist/codexConnector.js'));} finally {Module._load = original;}

async function environment(run,removeRoot=rm) {
  const root = await mkdtemp(path.join(tmpdir(), 'perfchecker-codex-contract-'));
  fixture = path.join(root, 'cli.cjs');
  await writeFile(fixture, `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const args=process.argv.slice(2);
const entry=process.env.PERFCHECKER_SACRIFICIAL_ENTRY;delete process.env.PERFCHECKER_SACRIFICIAL_ENTRY;
if(entry){let fd;try{
const probe=JSON.parse(entry);if(fs.lstatSync(probe.file).isSymbolicLink())throw Error('Private marker is a link');
fd=fs.openSync(probe.file,fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW||0));
const identity=fs.fstatSync(fd,{bigint:true});
if(!identity.isFile()||identity.nlink!==1n||identity.size!==0n||String(identity.dev)!==probe.dev||String(identity.ino)!==probe.ino||String(identity.birthtimeNs)!==probe.birthtimeNs)throw Error('Private marker identity changed');
const current=fs.lstatSync(probe.file,{bigint:true});if(current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino||current.birthtimeNs!==identity.birthtimeNs)throw Error('Private marker path changed');
const phase=args[0]==='--version'?'version':args[0]==='--help'?'global-help':args[0]==='exec'&&args[1]==='--help'?'exec-help':args[0]==='login'&&args[1]==='status'?'login-status':'fixture-operation';
const value=Buffer.from(JSON.stringify({schema:1,nonce:probe.nonce,phase,pid:process.pid,ppid:process.ppid,image:fs.realpathSync(process.execPath),at:Date.now()}));
if(value.length<=2048)fs.writeSync(fd,value);
}catch{}finally{if(fd!==undefined)try{fs.closeSync(fd)}catch{}}}
function execImage(){const child=cp.spawn('/bin/sh',['-c','while [ ! -e "$1" ]; do sleep 0.02; done; exec /bin/sleep 1000','--',path.join(process.cwd(),'release-exec')],{stdio:'ignore'});fs.writeFileSync('exec-image.json',JSON.stringify({leader:process.pid,child:child.pid}));setInterval(()=>{if(fs.existsSync('release-parent'))process.exit(0)},10)}
if(args[0]==='--exec-owner'){execImage();return}
if(args[0]==='--cohort-detached'){const leaf=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('cohort.json',JSON.stringify({middle:process.ppid,detached:process.pid,leaf:leaf.pid}));setInterval(()=>{},1000);return}
if(args[0]==='--cohort-middle'){cp.spawn(process.execPath,[__filename,'--cohort-detached'],{detached:true,stdio:'ignore'});setInterval(()=>{if(fs.existsSync('release-middle'))process.exit(0)},10);return}
if(args[0]==='--version'){console.log('codex-cli 0.159.2');process.exit(0)}
if(args[0]==='--help'){console.log('--no-daemon');process.exit(0)}
if(args[1]==='--help'){console.log('--ephemeral --sandbox --output-last-message --json --skip-git-repo-check --ignore-user-config --ignore-rules');process.exit(0)}
if(args[0]==='login'){process.exit(process.env.PERFCHECKER_FAKE_AUTH==='no'?1:0)}
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{
fs.writeFileSync(path.join(process.cwd(),'captured.json'),JSON.stringify({args,prompt,leaked:Object.keys(process.env).some(k=>k.startsWith('PERFCHECKER_CODEX_TOKEN_'))}));
if(prompt.includes('EXEC_IMAGE')){execImage();return}
if(prompt.includes('REPARENT_COHORT')){const middle=cp.spawn(process.execPath,[__filename,'--cohort-middle'],{stdio:'ignore'});fs.writeFileSync('cohort-leader.json',JSON.stringify({leader:process.pid,middle:middle.pid}));setInterval(()=>{if(fs.existsSync('release-leader'))process.exit(0)},10);return}
if(prompt.includes('EXIT_WITH_CHILD')||prompt.includes('OWNED_ACTIVE_CHILD')){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});fs.writeFileSync(path.join(process.cwd(),'exited-cli.json'),JSON.stringify({leader:process.pid,descendant:child.pid}));if(prompt.includes('EXIT_WITH_CHILD'))process.exit(0);setInterval(()=>{},1000);return}
if(prompt.includes('SLOW')){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)']);fs.writeFileSync(path.join(process.cwd(),'descendant.pid'),String(child.pid));setInterval(()=>{},1000);return}
if(args[args.indexOf('--sandbox')+1]==='workspace-write')fs.writeFileSync(path.join(process.cwd(),'source.txt'),'optimized\\n');
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],prompt.includes('OVERSIZED')?'x'.repeat(64001):'Review the allocation evidence and verify the suggested changes.');});`);
  let originalFailure,result;const cleanupErrors=[];
  try {result=await run(root);} catch(error){originalFailure=error;} finally {
    delete process.env.PERFCHECKER_FAKE_AUTH;
    let retired=true;
    try{retired=await retireOwnerDiagnostic(root);}catch(error){retired=error.observerRetired===true;cleanupErrors.push(error);}
    if(retired)try{await removeRoot(root,{recursive:true,force:true});}catch(error){cleanupErrors.push(error);}
  }
  if(cleanupErrors.length){
    if(originalFailure)throw new AggregateError([originalFailure,...cleanupErrors],originalFailure.message+' Windows owner diagnostic retirement failed.');
    if(cleanupErrors.length===1)throw cleanupErrors[0];
    throw new AggregateError(cleanupErrors,'Windows owner diagnostic retirement failed.');
  }
  if(originalFailure)throw originalFailure;return result;
}
const metadata=version=>({'io.modelcontextprotocol/protocolVersion':version,
  'io.modelcontextprotocol/clientInfo':{name:'Connector contract test',version:'1'},
  'io.modelcontextprotocol/clientCapabilities':{}});
async function request(connector, method, params = {}, {signal,version='2026-07-28',headers={},body} = {}) {
  const response = await fetch(connector.endpoint, {method: 'POST', signal,
    headers: {'Content-Type': 'application/json', Accept:'application/json, text/event-stream',
      Authorization: `Bearer ${connector.token}`, 'MCP-Protocol-Version': version,
      ...(version==='2025-11-25'?{}:{'Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':params.name}:{})}),...headers},
    body: body ?? JSON.stringify({jsonrpc: '2.0', id: 1, method,
      params:version==='2025-11-25'?params:{...params,_meta:metadata(version)}})});
  return {status:response.status,message:await response.json()};
}
async function call(connector, method, params, signal) {
  const {status,message}=await request(connector,method,params,{signal});
  assert.equal(status,200,JSON.stringify(message));assert.equal(message.error,undefined,JSON.stringify(message));
  assert.equal(message.result.resultType,'complete');
  return message.result;
}
const tool = (connector, name, args, signal) => call(connector, 'tools/call', {name, arguments: args}, signal);

async function ownerStageFixture(){
  const root=await mkdtemp(path.join(tmpdir(),'perfchecker-owner-stage-')),dir=path.join(root,'copy');
  await mkdir(dir);
  const probe=createOwnerStageProbe(dir),originalFile=path.join(root,'original-module');
  const bytes=Buffer.from('unchanged original module');await writeFile(originalFile,bytes);
  const records=[],state={dir,probe,used:true,sources:{[originalFile]:bytes},record:value=>records.push(value)};
  return {root,dir,probe,state,records};
}
function ownerStageRow(probe,owner,started,phase='powershell-entry'){
  const at=Math.max(started,Date.now()),child=ownerStageNames.indexOf(phase)>=4;
  return {schema:1,nonce:probe.nonce,phase,ownerPid:owner,
    ownerStarted:String(fileTimeEpoch+BigInt(started)*10000n),at,
    childPid:child?owner+1:0,childStarted:child?String(fileTimeEpoch+BigInt(started)*10000n):null};
}
test('owner stage diagnostic is opt-in and changes only annotations in the actual H2 launcher',async()=>{
  const f=await ownerStageFixture();
  try{
    const context={GITHUB_EVENT_NAME:'workflow_dispatch',PERFCHECKER_NATIVE_STAGE:'connector-workers',PERFCHECKER_NATIVE_SCOPE:'windows-stable'};
    assert.doesNotThrow(()=>assertOwnerDiagnosticContext('win32',context));
    for(const bad of [{GITHUB_EVENT_NAME:'pull_request'},{PERFCHECKER_NATIVE_STAGE:'full'},{PERFCHECKER_NATIVE_SCOPE:'all'}])
      assert.throws(()=>assertOwnerDiagnosticContext('win32',{...context,...bad}),/explicit Windows-only/);
    assert.throws(()=>assertOwnerDiagnosticContext('linux',context),/explicit Windows-only/);
    const source=await readFile(new URL('../resources/windows-owned-process.ps1',import.meta.url),'utf8');
    assert.equal(hashBytes(Buffer.from(source)),ownerDiagnosticHashes['resources/windows-owned-process.ps1']);
    const changed=instrumentOwnerLauncher(source,f.probe);
    assert.equal((changed.match(/Check\(CreateProcessW\(/g)||[]).length,1);
    assert.equal((changed.match(/Check\(AssignProcessToJobObject\(/g)||[]).length,1);
    assert.equal((changed.match(/if \(ResumeThread\(/g)||[]).length,1);
    assert.equal(entryFs.existsSync(f.probe.file),false);
    assert.equal((changed.match(/\[IO.FileStream\]::new/g)||[]).length,1);
    assert(changed.includes('[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read'));
    assert(changed.includes('DiagnosticStream=$diagnosticStream'));
    assert(changed.includes('var stream=DiagnosticStream;'));
    assert.doesNotMatch(changed,/new System\.IO\.FileStream|System\.IO\.FileMode\.Open/);
    assert(changed.includes('$diagnosticStream.Dispose()'));
    assert(changed.includes('KILL_ON_JOB_CLOSE; no breakaway.'));
    assert.throws(()=>instrumentOwnerLauncher(source.replace('static void Check(bool success,string operation)','changed Check(bool success,string operation)'),f.probe),/canonical|anchor/i);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('owner stage diagnostic refuses foreign identities, partial writes, replacement and oversized records',async()=>{
  const f=await ownerStageFixture(),started=Date.now(),owner=32101;
  const inspect=()=>readOwnerStages(f.probe,owner,started,Date.now());
  try{
    assert.equal(inspect().status,'unobserved');assert.equal(f.probe.identity,undefined);
    const row=ownerStageRow(f.probe,owner,started);
    await writeFile(f.probe.file,JSON.stringify({...row,nonce:'foreign'})+'\n',{flag:'wx'});
    assert.equal(inspect().status,'unobserved');assert.equal(f.probe.identity,undefined);assert.equal(f.probe.pathObserved,true);
    await rm(f.probe.file);assert.equal(inspect().reason,'inspection-error');assert.equal(f.probe.identity,undefined);
    await writeFile(f.probe.file,'',{flag:'wx'});row.at=Date.now();
    await writeFile(f.probe.file,JSON.stringify(row)+'\n');assert.equal(inspect().status,'observed');
    assert(f.probe.identity);const boundIdentity=f.probe.identity;
    assert.doesNotMatch(JSON.stringify(inspect()),new RegExp(f.probe.nonce));
    for(const bad of [{nonce:'foreign'},{ownerPid:owner+1},{ownerStarted:'1'},{ownerStarted:Number(row.ownerStarted)},{phase:'arbitrary-private-text'},{at:started-1}]) {
      await writeFile(f.probe.file,JSON.stringify({...row,...bad})+'\n');assert.equal(inspect().status,'unobserved');
      assert.equal(f.probe.identity,boundIdentity);
    }
    await writeFile(f.probe.file,JSON.stringify(row));assert.equal(inspect().reason,'partial-stage-write');
    await writeFile(f.probe.file,'x'.repeat(ownerTraceLimit+1));assert.equal(inspect().reason,'size-limit');
    await writeFile(f.probe.file,JSON.stringify(row)+'\n'+JSON.stringify(row)+'\n');assert.equal(inspect().status,'unobserved');
    entryFs.renameSync(f.probe.file,path.join(f.dir,'replaced-marker'));
    assert.equal(inspect().reason,'inspection-error');assert.equal(f.probe.identity,boundIdentity);
    await writeFile(f.probe.file,JSON.stringify(row)+'\n');
    assert.equal(inspect().reason,'private-file-identity');
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('owner stage diagnostic preserves delegation and waits for physical close before retirement',async()=>{
  const f=await ownerStageFixture(),child=new EventEmitter(),options={cwd:f.root,env:{PRIVATE:'not observed'}};
  child.pid=32102;let calls=0,settled=false;const errors=[],originalError=new Error('original delegated failure');
  child.on('error',error=>errors.push(error));
  try{
    ownerDiagnosticStates.set(f.root,f.state);
    const actual=observeOwnerStages(received=>{calls++;assert.equal(received,options);return child;},['--version'],options,f.state);
    assert.equal(actual,child);assert.equal(calls,1);
    await writeFile(f.probe.file,JSON.stringify(ownerStageRow(f.probe,child.pid,f.state.started))+'\n');
    f.state.beforeDeadline();assert.equal(f.state.before.status,'observed');
    const retiring=retireOwnerDiagnostic(f.root).then(value=>{settled=true;return value;});
    child.emit('error',originalError);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false);assert.equal(f.state.closed,false);assert.equal(errors[0],originalError);
    child.emit('close',17,null);assert.equal(await retiring,true);
    assert.equal(f.records[0].physicalClose,true);assert.equal(f.records[0].observerCleanupQualified,true);
    assert.equal(f.records[0].qualifiesCanonicalProduct,false);assert.equal(f.records[0].originalFilesUnchanged,true);
    assert.deepEqual(f.records[0].outcome,{code:17,signal:null});
    assert.doesNotMatch(JSON.stringify(f.records),new RegExp(f.probe.nonce+'|not observed'));
    assert.equal(entryFs.existsSync(f.dir),false);assert.equal(ownerDiagnosticStates.has(f.root),false);
  }finally{child.emit('close',17,null);clearTimeout(f.state.timer);ownerDiagnosticStates.delete(f.root);await rm(f.root,{recursive:true,force:true});}
});
test('owner stage diagnostic rejects a missed observation deadline and retains uncertain cleanup',async t=>{
  const f=await ownerStageFixture(),child=new EventEmitter();child.pid=32103;let kills=0;child.kill=()=>{kills++;};
  try{
    ownerDiagnosticStates.set(f.root,f.state);
    observeOwnerStages(()=>child,['--version'],{},f.state);
    t.mock.method(Date,'now',()=>f.state.started+10000);
    f.state.beforeDeadline();t.mock.restoreAll();
    assert.equal(f.state.before.reason,'pre-deadline-observation-missed');
    await assert.rejects(retireOwnerDiagnostic(f.root,20),error=>error.observerRetired===false);
    assert.equal(f.records[0].physicalClose,false);assert.equal(f.records[0].observerCleanupQualified,false);
    assert.equal(f.records[0].temporaryFilesRetained,true);assert.equal(kills,0);
    assert.equal(entryFs.existsSync(f.dir),true);assert.equal(ownerDiagnosticStates.has(f.root),false);
  }finally{t.mock.restoreAll();child.emit('close',null,'SIGKILL');clearTimeout(f.state.timer);ownerDiagnosticStates.delete(f.root);await rm(f.root,{recursive:true,force:true});}
});
test('owner stage diagnostic preserves synchronous spawn errors and refuses a failed receipt',async()=>{
  const f=await ownerStageFixture(),originalError=new Error('original spawn failure');
  try{
    ownerDiagnosticStates.set(f.root,f.state);
    assert.throws(()=>observeOwnerStages(()=>{throw originalError;},['--version'],{},f.state),error=>error===originalError);
    f.state.record=()=>{throw new Error('private diagnostic sink failure');};
    await assert.rejects(retireOwnerDiagnostic(f.root),error=>error.observerRetired===true);
    assert.equal(entryFs.existsSync(f.dir),false);assert.equal(ownerDiagnosticStates.has(f.root),false);
  }finally{ownerDiagnosticStates.delete(f.root);await rm(f.root,{recursive:true,force:true});}
});
test('owner stage diagnostic treats a never-created trace as unknown after physical close and preserves the original failure',async()=>{
  const originalError=new Error('original request failure'),records=[];let fixtureRoot;
  await assert.rejects(environment(async root=>{
    fixtureRoot=root;
    const dir=path.join(root,'diagnostic-copy');await mkdir(dir);
    const state={dir,probe:createOwnerStageProbe(dir),used:true,sources:{},record:value=>records.push(value)};
    ownerDiagnosticStates.set(root,state);
    const child=new EventEmitter();child.pid=32105;
    observeOwnerStages(()=>child,['--version'],{},state);
    state.beforeDeadline();assert.equal(state.before.reason,'no-stage-observed');
    assert.equal(state.probe.pathObserved,undefined);assert.equal(state.probe.identity,undefined);
    child.emit('close',null,'SIGKILL');
    throw originalError;
  }),error=>error===originalError);
  assert.equal(records[0].afterClose.reason,'no-stage-observed');
  assert.equal(records[0].physicalClose,true);assert.equal(records[0].observerCleanupQualified,true);
  assert.equal(records[0].qualifiesCanonicalProduct,false);assert.equal(entryFs.existsSync(fixtureRoot),false);
});
test('owner stage diagnostic reports modified originals without replacing the original request error',async()=>{
  const originalError=new Error('original request failure'),records=[];let fixtureRoot;
  await assert.rejects(environment(async root=>{
    fixtureRoot=root;
    const dir=path.join(root,'diagnostic-copy');await mkdir(dir);
    const probe=createOwnerStageProbe(dir),file=path.join(root,'original-module');
    const bytes=Buffer.from('original bytes');await writeFile(file,bytes);
    const state={dir,probe,used:true,sources:{[file]:bytes},record:value=>records.push(value)};
    ownerDiagnosticStates.set(root,state);
    const child=new EventEmitter();child.pid=32104;
    observeOwnerStages(()=>child,['--version'],{},state);
    await writeFile(file,'modified bytes');child.emit('close',0,null);
    throw originalError;
  }),error=>error instanceof AggregateError&&error.errors[0]===originalError&&
    /security, receipt or retirement/.test(error.errors[1].message));
  assert.equal(records[0].originalFilesUnchanged,false);assert.equal(records[0].physicalClose,true);
  assert.equal(records[0].qualifiesCanonicalProduct,false);assert.equal(entryFs.existsSync(fixtureRoot),false);
});
test('owner stage diagnostic retains the direct request error when retirement and root removal both fail',async()=>{
  const originalError=new Error('original request failure'),removeError=new Error('root removal failure');let fixtureRoot;
  try{
    await assert.rejects(environment(async root=>{
      fixtureRoot=root;
      const dir=path.join(root,'diagnostic-copy');await mkdir(dir);
      const state={dir,probe:createOwnerStageProbe(dir),used:false,sources:{},record:()=>{throw new Error('receipt failure');}};
      ownerDiagnosticStates.set(root,state);
      throw originalError;
    },async(root,options)=>{assert.equal(root,fixtureRoot);assert.deepEqual(options,{recursive:true,force:true});throw removeError;}),
    error=>error instanceof AggregateError&&error.errors.length===3&&error.errors[0]===originalError&&
      /security, receipt or retirement/.test(error.errors[1].message)&&error.errors[2]===removeError);
    assert.equal(entryFs.existsSync(path.join(fixtureRoot,'diagnostic-copy')),false);
  }finally{if(fixtureRoot)await rm(fixtureRoot,{recursive:true,force:true});}
});
function externalFrame(context,observerPid,nonce,index=0){
  const row=(pid,parent,started)=>({pid,parent,started:new Date(started).toISOString(),executable:process.execPath,kernel:'0',user:'0',state:null});
  const parent=row(context.parentPid,process.ppid,context.started-1000),owner=row(context.ownerPid,context.parentPid,context.started);
  return {schema:1,nonce,observerPid,index,beforeAt:context.started,afterAt:Date.now(),reason:null,
    parent:{before:{...parent},after:{...parent}},owner:{before:{...owner},after:{...owner}},descendants:[]};
}
function fakeExternalChild(pid){
  const child=Object.assign(new EventEmitter(),{pid,stdout:new PassThrough(),stderr:new PassThrough(),kills:0});
  child.kill=()=>{child.kills++;return true;};return child;
}
test('external owner observation starts after the real delegate returns and freezes the invocation',async()=>{
  const f=await ownerStageFixture(),owner=fakeExternalChild(32201),observer=fakeExternalChild(32202),order=[];
  const options={cwd:f.root,env:{PRIVATE:'not observable'}};
  Object.assign(f.state,{mode:'external',externalExecutable:process.execPath,externalSpawn:(image,args,received)=>{
    order.push('observer');assert.deepEqual(order,['delegate','returned','observer']);
    assert.equal(image,entryFs.realpathSync(process.execPath));assert.equal(received.cwd,f.root);assert.equal(received.env,undefined);
    assert.doesNotMatch(args.at(-1),/Add-Type|CommandLine|Get-CimInstance Win32_Process\s+-ErrorAction/);
    assert.match(args.at(-1),/ParentProcessId=/);return observer;
  }});
  try{
    ownerDiagnosticStates.set(f.root,f.state);
    assert.equal(observeExternalOwner(received=>{order.push('delegate');assert.equal(received,options);return owner;},['--version'],options,f.state),owner);
    order.push('returned');options.cwd='later mutation';f.state.externalExecutable='later mutation';
    await new Promise(resolve=>setImmediate(resolve));assert.equal(f.state.external.started,true);
    const retiring=retireOwnerDiagnostic(f.root);owner.emit('close',0,null);
    observer.emit('close',null,'SIGKILL');assert.equal(await retiring,true);
    assert.equal(owner.kills,0);assert.equal(observer.kills,1);
    assert.equal(f.records[0].observerPerturbing,true);assert.equal(f.records[0].qualifiesCanonicalProduct,false);
    assert.equal(f.records[0].externalObserver.physicalClose,true);assert.equal(f.records[0].originalFilesUnchanged,true);
    assert.doesNotMatch(JSON.stringify(f.records),/not observable|later mutation/);
  }finally{owner.emit('close',0,null);observer.emit('close',null,'SIGKILL');clearTimeout(f.state.external?.timer);ownerDiagnosticStates.delete(f.root);await rm(f.root,{recursive:true,force:true});}
});
test('external owner frames refuse late or replaced identities and accept a child born during collection',()=>{
  const started=Date.now(),context={started,spawnedAt:started+1,deadline:started+9000,ownerPid:32203,parentPid:process.pid,
    ownerExecutable:entryFs.realpathSync(process.execPath),parentExecutable:entryFs.realpathSync(process.execPath)};
  const valid=externalFrame(context,32204,'nonce');valid.afterAt=started+200;
  const descendant={pid:32205,parent:context.ownerPid,started:new Date(started+100).toISOString(),
    executable:process.execPath,kernel:'0',user:'0',state:null};
  valid.descendants=[{depth:1,before:{...descendant},after:{...descendant,user:'1'}}];
  assert.equal(qualifyExternalOwnerFrame(valid,context,32204,'nonce',started+201).descendants.length,1);
  for(const modify of [
    f=>{f.owner.before.started=f.owner.after.started=new Date(started+50).toISOString();},
    f=>{f.owner.after.parent++;},f=>{f.owner.after.started=new Date(started+1).toISOString();},
    f=>{f.parent.after.started=new Date(started-900).toISOString();},
    f=>{f.descendants[0].before.parent=f.descendants[0].after.parent=999;},
    f=>{f.descendants[0].depth=3;},f=>{f.reason='inspection-failed';},
    f=>{f.observerPid=context.ownerPid;},f=>{f.owner.after.executable='/unavailable-private-image';}
  ]){
    const bad=structuredClone(valid);modify(bad);assert.throws(()=>qualifyExternalOwnerFrame(bad,context,32204,'nonce',started+201));
  }
  assert.throws(()=>qualifyExternalOwnerFrame(valid,context,32204,'nonce',context.deadline));
  assert.throws(()=>qualifyExternalOwnerFrame(valid,context,context.ownerPid,'nonce',started+201));
});
test('external owner observation fixes incarnations across frames and never kills the real owner',async()=>{
  const f=await ownerStageFixture(),owner=fakeExternalChild(32206),observer=fakeExternalChild(32207);let script;
  Object.assign(f.state,{mode:'external',externalExecutable:process.execPath,externalSpawn:(_image,args)=>{script=args.at(-1);return observer;}});
  try{
    ownerDiagnosticStates.set(f.root,f.state);observeExternalOwner(()=>owner,['--version'],{cwd:f.root},f.state);
    await new Promise(resolve=>setImmediate(resolve));
    const nonce=JSON.parse(/;\$nonce=("(?:[^"\\]|\\.)*")/.exec(script)[1]),context=f.state.external.context;
    observer.stdout.write(JSON.stringify(externalFrame(context,observer.pid,nonce))+'\n');
    assert.equal(f.state.external.samples.length,1);
    const changed=externalFrame(context,observer.pid,nonce,1);
    changed.parent.before.started=changed.parent.after.started=new Date(context.started-900).toISOString();
    observer.stdout.write(JSON.stringify(changed)+'\n');
    assert.equal(f.state.external.samples.length,1);assert.equal(observer.kills,1);assert.equal(owner.kills,0);
    assert.equal(f.state.external.unknown[0].reason,'frame-refused');
    owner.emit('close',0,null);observer.emit('close',null,'SIGKILL');assert.equal(await retireOwnerDiagnostic(f.root),true);
  }finally{owner.emit('close',0,null);observer.emit('close',null,'SIGKILL');clearTimeout(f.state.external?.timer);ownerDiagnosticStates.delete(f.root);await rm(f.root,{recursive:true,force:true});}
});
test('external owner observation does not start after close and retains an observer without physical close',async()=>{
  const early=await ownerStageFixture(),late=await ownerStageFixture(),owner=fakeExternalChild(32208),observer=fakeExternalChild(32209);
  try{
    let starts=0;
    Object.assign(early.state,{mode:'external',externalExecutable:process.execPath,externalSpawn:()=>{starts++;return observer;}});
    ownerDiagnosticStates.set(early.root,early.state);observeExternalOwner(()=>owner,['--version'],{},early.state);
    owner.emit('close',0,null);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(starts,0);assert.equal(await retireOwnerDiagnostic(early.root),true);
    const secondOwner=fakeExternalChild(32210);
    Object.assign(late.state,{mode:'external',externalExecutable:process.execPath,externalSpawn:()=>observer});
    ownerDiagnosticStates.set(late.root,late.state);observeExternalOwner(()=>secondOwner,['--version'],{},late.state);
    await new Promise(resolve=>setImmediate(resolve));secondOwner.emit('close',1,null);
    await assert.rejects(retireOwnerDiagnostic(late.root,20),error=>error.observerRetired===false);
    assert.equal(entryFs.existsSync(late.dir),true);assert.equal(late.records[0].observerCleanupQualified,false);
    assert.equal(secondOwner.kills,0);assert.equal(observer.kills,1);
  }finally{observer.emit('close',null,'SIGKILL');clearTimeout(early.state.external?.timer);clearTimeout(late.state.external?.timer);ownerDiagnosticStates.delete(early.root);ownerDiagnosticStates.delete(late.root);await rm(early.root,{recursive:true,force:true});await rm(late.root,{recursive:true,force:true});}
});
test('external observer stop errors cannot interrupt owner close and preserve the original failure directly',async()=>{
  const originalError=new Error('original request failure'),records=[];let rootSeen;
  await assert.rejects(environment(async root=>{
    rootSeen=root;const dir=path.join(root,'observer');await mkdir(dir);
    const owner=fakeExternalChild(32211),observer=fakeExternalChild(32212);
    observer.kill=()=>{throw new Error('observer stop failed');};
    const state={mode:'external',dir,used:true,sources:{},externalExecutable:process.execPath,externalSpawn:()=>observer,
      record:value=>records.push(value)};
    ownerDiagnosticStates.set(root,state);observeExternalOwner(()=>owner,['--version'],{cwd:root},state);
    await new Promise(resolve=>setImmediate(resolve));let originalListenerCompleted=false;
    owner.on('close',()=>{originalListenerCompleted=true;});
    assert.doesNotThrow(()=>owner.emit('close',1,null));assert.equal(originalListenerCompleted,true);
    observer.emit('close',0,null);throw originalError;
  }),error=>error instanceof AggregateError&&error.errors[0]===originalError&&error.errors.length===2);
  assert.equal(records[0].externalObserver.physicalClose,true);
  assert.equal(records[0].externalObserver.unknown[0].reason,'observer-stop-error');assert.equal(entryFs.existsSync(rootSeen),false);
});
test('external owner observation refuses a fourth frame and bounds private diagnostic output',async()=>{
  const f=await ownerStageFixture(),owner=fakeExternalChild(32213),observer=fakeExternalChild(32214);let script;
  Object.assign(f.state,{mode:'external',externalExecutable:process.execPath,externalSpawn:(_image,args)=>{script=args.at(-1);return observer;}});
  try{
    ownerDiagnosticStates.set(f.root,f.state);observeExternalOwner(()=>owner,['--version'],{cwd:f.root},f.state);
    await new Promise(resolve=>setImmediate(resolve));
    const nonce=JSON.parse(/;\$nonce=("(?:[^"\\]|\\.)*")/.exec(script)[1]),context=f.state.external.context;
    for(let index=0;index<3;index++)observer.stdout.write(JSON.stringify(externalFrame(context,observer.pid,nonce,index))+'\n');
    assert.equal(f.state.external.samples.length,3);
    observer.stdout.write(JSON.stringify(externalFrame(context,observer.pid,nonce,3))+'\n');
    observer.stdout.write('PRIVATE'.repeat(12000));assert.equal(observer.kills,1);assert.equal(owner.kills,0);
    assert.equal(f.state.external.samples.length,3);
    owner.emit('close',0,null);observer.emit('close',null,'SIGKILL');await retireOwnerDiagnostic(f.root);
    assert.doesNotMatch(JSON.stringify(f.records),/PRIVATE/);
  }finally{owner.emit('close',0,null);observer.emit('close',null,'SIGKILL');clearTimeout(f.state.external?.timer);ownerDiagnosticStates.delete(f.root);await rm(f.root,{recursive:true,force:true});}
});
async function until(read) {for (let i=0;i<(process.platform==='win32'?1000:100);i++) {try {return await read();} catch {await new Promise(r=>setTimeout(r,20));}} throw new Error('Fixture process did not start.');}

test('CLI entry diagnostics preserve the delegated child and original spawn errors',async()=>environment(async root=>{
  const child=Object.assign(new EventEmitter(),{pid:12345,stdout:new PassThrough(),stderr:new PassThrough()});
  const options={cwd:root,env:{UNCHANGED:'yes'}},events=[];let calls=0,privateEntry;
  assert.equal(observeFixtureSpawn(received=>{
    calls++;assert.equal(received.cwd,options.cwd);assert.equal(received.env.UNCHANGED,'yes');
    privateEntry=JSON.parse(received.env[entryVariable]);return child;
  },['--version'],options,fixture,value=>events.push(value)),child);
  assert.equal(calls,1);assert.equal(options.env[entryVariable],undefined);
  await writeFile(privateEntry.file,JSON.stringify({schema:1,nonce:privateEntry.nonce,phase:'version',pid:12346,ppid:12345,
    image:entryFs.realpathSync(process.execPath),at:Date.now()}));
  child.stdout.write('private response payload');child.stderr.write('private error payload');child.emit('close',7,'SIGKILL');
  assert.equal(events.length,1);assert.equal(events[0].code,7);assert.equal(events[0].signal,'SIGKILL');
  assert.equal(events[0].marker.status,'script-entry-observed');assert.equal(events[0].marker.image,'expected-native-node');
  assert.equal(events[0].stdoutBytes,24);assert.equal(events[0].stderrBytes,21);assert.equal(events[0].markerRetired,true);
  assert(!entryFs.existsSync(privateEntry.file));assert.doesNotMatch(JSON.stringify(events),/private response|private error|entry-.*\.json/);
  const originalError=Object.assign(new Error('private spawn details'),{code:'ENOENT'});
  assert.throws(()=>observeFixtureSpawn(()=>{throw originalError;},['unlisted-sensitive-argument'],options,fixture,value=>events.push(value)),error=>error===originalError);
  assert.equal(events.at(-1).phase,'fixture-operation');assert.equal(events.at(-1).terminalEvent,'synchronous-spawn-error');
  assert.deepEqual(events.at(-1).spawnError,{name:'Error',code:'ENOENT'});assert.equal(events.at(-1).markerRetired,true);
  assert.doesNotMatch(JSON.stringify(events),/private spawn details|unlisted-sensitive-argument/);
  const asyncChild=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough()});
  observeFixtureSpawn(()=>asyncChild,['--help'],options,fixture,value=>events.push(value));
  asyncChild.emit('error',originalError);asyncChild.emit('close',null,null);
  assert.equal(events.length,3);assert.equal(events.at(-1).terminalEvent,'spawn-error');assert.equal(events.at(-1).ownerPid,null);
  assert.equal(events.at(-1).markerRetired,true);
  assert.deepEqual(await readdir(root),['cli.cjs']);
  const closing=new EventEmitter(),closed=fixtureChildClose(closing,100);let settled=false;
  const handled=closed.catch(error=>{settled=true;return error;});closing.emit('error',originalError);
  await Promise.resolve();assert.equal(settled,false,'An error must not finish the fixture before physical close');
  closing.emit('close',null,'SIGTERM');assert.equal(await handled,originalError);
  assert.equal(closing.listenerCount('error'),0);assert.equal(closing.listenerCount('close'),0);
  const missingClose=new EventEmitter(),incomplete=fixtureChildClose(missingClose,10);missingClose.emit('error',originalError);
  await assert.rejects(incomplete,error=>error instanceof AggregateError&&error.errors[0]===originalError&&error.cleanupQualified===false);
  assert.equal(missingClose.listenerCount('error'),0);assert.equal(missingClose.listenerCount('close'),0);
}));

test('CLI entry diagnostics refuse stale, foreign or arbitrary marker records',async()=>environment(async root=>{
  const probe=createEntryProbe(fixture,['--version']),owner=12345;
  try{
    assert.deepEqual(inspectEntryProbe(probe,owner),{status:'unavailable',reason:'script-entry-not-observed'});
    const valid={schema:1,nonce:probe.nonce,phase:'version',pid:12346,ppid:owner,image:probe.image,at:Date.now()};
    for(const changed of [{ppid:owner+1},{pid:owner},{nonce:'foreign'},{phase:'login-status'},{image:'unexpected'},
      {at:probe.started-1},{at:Date.now()+60000},{token:'private secret'}]){
      await writeFile(probe.file,JSON.stringify({...valid,...changed}));
      const result=inspectEntryProbe(probe,owner);assert.deepEqual(result,{status:'refused',reason:'entry-identity'});
      assert.doesNotMatch(JSON.stringify(result),/private secret|unexpected|foreign/);
    }
    await writeFile(probe.file,'{private invalid JSON');
    assert.deepEqual(inspectEntryProbe(probe,owner),{status:'unavailable',reason:'inspection-error',error:{name:'Error'}});
    await writeFile(probe.file,'x'.repeat(entryLimit+1));assert.deepEqual(inspectEntryProbe(probe,owner),{status:'refused',reason:'size-limit'});
  }finally{await rm(probe.file,{force:true});}
}));

test('CLI entry diagnostics observe actual Node entry and refuse replaced files and links',async()=>environment(async root=>{
  const probe=createEntryProbe(fixture,['--version']),retired=probe.file+'.retired';
  try{
    const child=nativeSpawn(process.execPath,[fixture,'--version'],{cwd:root,env:{...process.env,[entryVariable]:JSON.stringify({file:probe.file,
      nonce:probe.nonce,dev:String(probe.identity.dev),ino:String(probe.identity.ino),birthtimeNs:String(probe.identity.birthtimeNs),phase:probe.phase})},
      signal:AbortSignal.timeout(5000),stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    const result=await fixtureChildClose(child);
    assert.deepEqual(result,{code:0,signal:null});assert.equal(stdout,'codex-cli 0.159.2\n');assert.equal(stderr,'');
    const observed=inspectEntryProbe(probe,process.pid);assert.equal(observed.status,'script-entry-observed');
    assert.equal(observed.pid,child.pid);assert.equal(observed.ppid,process.pid);assert.equal(observed.image,'expected-native-node');
    entryFs.renameSync(probe.file,retired);await writeFile(probe.file,'private replacement');
    assert.deepEqual(inspectEntryProbe(probe,12345),{status:'refused',reason:'private-file-identity'});
    if(process.platform!=='win32'){
      await rm(probe.file);entryFs.symlinkSync(retired,probe.file);
      assert.deepEqual(inspectEntryProbe(probe,12345),{status:'refused',reason:'private-file-identity'});
      assert.equal(JSON.parse(await readFile(retired,'utf8')).pid,child.pid);
    }
  }finally{await rm(probe.file,{force:true});await rm(retired,{force:true});}
}));

test('modern discovery is authenticated, stateless and never starts a CLI; legacy 2025 remains distinct',async()=>environment(async root=>{
  const connector=await new CodexConnector({cli:path.join(root,'must-not-run'),root}).start();
  try{
    for(const options of [{headers:{Authorization:'Bearer invalid'}},{headers:{Origin:'https://example.test'}}]){
      const response=await fetch(connector.endpoint,{method:'POST',headers:{Authorization:`Bearer ${connector.token}`,...options.headers},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover'})});
      assert.equal(response.status,401);
    }
    // There is deliberately no initialize request before these modern operations.
    const discovered=await call(connector,'server/discover');
    assert.deepEqual(discovered.supportedVersions,['2026-07-28','2025-11-25']);
    assert.deepEqual(discovered.capabilities,{tools:{}});
    assert.equal(discovered._meta['io.modelcontextprotocol/serverInfo'].name,'PerfChecker local Codex connector');
    assert.equal(discovered.ttlMs,0);assert.equal(discovered.cacheScope,'private');
    const listed=await call(connector,'tools/list');
    assert.deepEqual(listed.tools.map(tool=>tool.name),['ask_perfchecker','implement_perfchecker']);
    assert.equal(listed.ttlMs,0);assert.equal(listed.cacheScope,'private');
    const legacy=await request(connector,'initialize',{protocolVersion:'2025-11-25'},{version:'2025-11-25'});
    assert.equal(legacy.status,200);assert.equal(legacy.message.result.protocolVersion,'2025-11-25');
    assert.equal(legacy.message.result.resultType,undefined);
    const initialized=await fetch(connector.endpoint,{method:'POST',headers:{Authorization:`Bearer ${connector.token}`,'MCP-Protocol-Version':'2025-11-25'},
      body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
    assert.equal(initialized.status,202);assert.equal(await initialized.text(),'');
    const legacyTools=await request(connector,'tools/list',{}, {version:'2025-11-25'});
    assert.equal(legacyTools.status,200);assert.deepEqual(legacyTools.message.result.tools,listed.tools);
    assert.equal(legacyTools.message.result.resultType,undefined);
    const errors=[
      ['server/discover',{}, {version:'2099-01-01'},400,-32022],
      ['server/discover',{}, {headers:{'Mcp-Method':'tools/list'}},400,-32020],
      ['tools/call',{name:'ask_perfchecker',arguments:{prompt:'Never run'}},{headers:{'Mcp-Name':'implement_perfchecker'}},400,-32020],
      ['server/discover',{}, {body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover',params:{}})},400,-32602],
      ['server/discover',{}, {body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover',params:{_meta:metadata('2025-11-25')}})},400,-32020],
      ['initialize',{protocolVersion:'2026-07-28'},{},404,-32601],
      ['unavailable/method',{}, {},404,-32601],
      ['tools/call',{name:'unavailable_tool',arguments:{}},{},400,-32602],
    ];
    for(const [method,params,options,status,code]of errors){
      const received=await request(connector,method,params,options);
      assert.equal(received.status,status,JSON.stringify(received));assert.equal(received.message.error.code,code);
      assert.equal(received.message.result,undefined,'Protocol failures must not masquerade as tool results');
      if(code===-32022)assert.deepEqual(received.message.error.data,{supported:['2026-07-28','2025-11-25'],requested:'2099-01-01'});
    }
    for(const [body,code]of [['{',-32700],['[]',-32600],[JSON.stringify({jsonrpc:'2.0',method:'server/discover',id:null}),-32600]]){
      const malformed=await request(connector,'server/discover',{}, {body});
      assert.equal(malformed.status,400);assert.equal(malformed.message.error.code,code);
      assert.equal(malformed.message.id,null,'Malformed requests with no readable ID must return JSON-RPC id:null');
    }
    assert.equal(connector.children.size,0);assert.equal(connector.busy,false);
    await assert.rejects(readFile(path.join(root,'captured.json')),error=>error.code==='ENOENT');
  }finally{await connector.dispose();}
  assert.equal(process.env[connector.keyEnvironment],undefined);await assert.rejects(fetch(connector.endpoint));
}));

test('authenticated local MCP exposes two exact tools and never forwards its token to Codex', async () => environment(async root => {
  await prepareOwnerDiagnostic(root);
  assert.equal(await inspectCodex('sacrificial-codex', root), 'codex-cli 0.159.2');
  process.env.PERFCHECKER_FAKE_AUTH = 'no'; await assert.rejects(inspectCodex('sacrificial-codex', root), /not authenticated/);
  delete process.env.PERFCHECKER_FAKE_AUTH;
  const connector = await new CodexConnector({cli:'sacrificial-codex', root}).start();
  try {
    assert.equal((await fetch(connector.endpoint, {method:'POST'})).status,401);
    assert.equal((await fetch(connector.endpoint, {method:'POST',headers:{Authorization:`Bearer ${connector.token}`,Origin:'https://example.test'}})).status,401);
    const discovered=await call(connector,'server/discover');assert(discovered.supportedVersions.includes('2026-07-28'));
    const listed=await call(connector,'tools/list'); assert.deepEqual(listed.tools.map(t=>t.name),['ask_perfchecker','implement_perfchecker']);
    assert.deepEqual(listed.tools[1].inputSchema.required,['prompt','workspace']);
    assert.equal(listed.tools[1].inputSchema.additionalProperties,false);
    assert.match((await tool(connector,'ask_perfchecker',{prompt:'Advice only.'})).content[0].text,/allocation evidence/);
    const captured=JSON.parse(await readFile(path.join(root,'captured.json'),'utf8'));
    assert.equal(captured.leaked,false);assert.equal(captured.args[captured.args.indexOf('--sandbox')+1],'read-only');
    assert.ok(captured.args.includes('--ignore-user-config'));assert.ok(captured.args.includes('--ignore-rules'));assert.ok(captured.args.includes('--ephemeral'));
    assert.equal(captured.args[0],'--no-daemon');assert.equal(captured.args[1],'exec');
    assert.ok(!captured.args.includes('--model'));assert.match(captured.prompt,/Give advice only/);
    const legacyAdvice=await request(connector,'tools/call',{name:'ask_perfchecker',arguments:{prompt:'Legacy advice only.'}},{version:'2025-11-25'});
    assert.equal(legacyAdvice.status,200);assert.match(legacyAdvice.message.result.content[0].text,/allocation evidence/);
    assert.equal(legacyAdvice.message.result.resultType,undefined);
    const encodedAdvice=await request(connector,'tools/call',{name:'ask_perfchecker',arguments:{prompt:'Encoded tool name.'}},
      {headers:{'Mcp-Name':'=?base64?'+Buffer.from('ask_perfchecker').toString('base64')+'?='}});
    assert.equal(encodedAdvice.status,200);assert.equal(encodedAdvice.message.result.resultType,'complete');
    assert.equal((await tool(connector,'ask_perfchecker',{prompt:'Unexpected',workspace:root})).isError,true);
    assert.equal((await tool(connector,'implement_perfchecker',{prompt:'Edit',workspace:root})).isError,true);
    assert.equal((await tool(connector,'ask_perfchecker',{prompt:'OVERSIZED'})).isError,true);
    assert.equal((await tool(connector,'ask_perfchecker',{prompt:'Retry'})).isError,undefined);
  } finally {await connector.dispose();}
  assert.equal(process.env[connector.keyEnvironment],undefined);
  await assert.rejects(fetch(connector.endpoint));
}));

test('implementation accepts a canonical PerfChecker checkout and uses workspace-write without touching original files', async () => environment(async root => {
  const temporary=await mkdtemp(path.join(tmpdir(),'perfchecker-implementation-contract-')), checkout=path.join(temporary,'checkout');
  await mkdir(checkout);await writeFile(path.join(checkout,'source.txt'),'original\n');await writeFile(path.join(root,'source.txt'),'original\n');
  const connector=await new CodexConnector({cli:'sacrificial-codex',root}).start();
  try {
    assert.equal((await tool(connector,'implement_perfchecker',{prompt:'Implement reviewed advice.',workspace:checkout})).isError,undefined);
    assert.equal(await readFile(path.join(checkout,'source.txt'),'utf8'),'optimized\n');assert.equal(await readFile(path.join(root,'source.txt'),'utf8'),'original\n');
    const captured=JSON.parse(await readFile(path.join(checkout,'captured.json'),'utf8'));
    assert.equal(captured.args[captured.args.indexOf('-C')+1],await realpath(checkout));assert.equal(captured.args[captured.args.indexOf('--sandbox')+1],'workspace-write');
    assert.match(captured.prompt,/Do not publish, push, deploy/);
  } finally {await connector.dispose();await rm(temporary,{recursive:true,force:true});}
}));

test('timeout, HTTP cancellation and disposal stop the actual CLI process tree and permit retry', async () => environment(async root => {
  for (const mode of ['timeout','cancel','dispose']) {
    await rm(path.join(root,'descendant.pid'),{force:true});
    const connector=await new CodexConnector({cli:'sacrificial-codex',root,timeoutMs:mode==='timeout'?(process.platform==='win32'?10000:300):30000}).start();
    try {
    const controller=new AbortController();
    const pending=tool(connector,'ask_perfchecker',{prompt:'SLOW'},controller.signal);
    const handled=pending.catch(error=>error);
    const pid=Number(await until(()=>readFile(path.join(root,'descendant.pid'),'utf8')));
    const overlapping=await tool(connector,'ask_perfchecker',{prompt:'Second request'});assert.equal(overlapping.isError,true);assert.match(overlapping.content[0].text,/already handling/);
    if(mode==='cancel')controller.abort();if(mode==='dispose')await connector.dispose();
    const result=await handled;if(mode==='timeout'){assert.equal(result.isError,true);assert.match(result.content[0].text,/timed out/);}
    await until(async()=>{try{process.kill(pid,0);}catch{return true;}
      if(process.platform==='linux' && /\) Z /.test(await readFile(`/proc/${pid}/stat`,'utf8')))return true;
      throw new Error('Descendant still running');});
    if(mode!=='dispose')await until(async()=>{const retry=await tool(connector,'ask_perfchecker',{prompt:'Retry'});
      if(retry.isError)throw new Error(retry.content[0].text);return retry;});
    } finally {await connector.dispose();}
  }
}));

// No model/authentication: exercise the installed product bridge against a real
// disposable process cohort. Its ancestry is observed before either fork parent
// exits; the detached child and its child survive that reparenting naturally.
test('Codex owns an observed detached/reparented cohort through timeout, HTTP abort, disposal and natural exit',
  {skip:process.platform==='win32'},async t=>environment(async root=>{
  const identity=async pid=>{
    try{
      if(process.platform==='linux'){
        const raw=await readFile('/proc/'+pid+'/stat','utf8'),f=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
        if(['Z','X'].includes(f[0]))return undefined;
        return{pid,parent:Number(f[1]),group:Number(f[2]),session:Number(f[3]),start:f[19],exe:await realpath('/proc/'+pid+'/exe')};
      }
      const exec=(file,args)=>new Promise((resolve,reject)=>nativeChildProcess.execFile(file,args,{timeout:2000},(error,stdout)=>error?reject(error):resolve(stdout)));
      const raw=await exec('/bin/ps',['-p',String(pid),'-o','pid=,ppid=,pgid=,sess=,stat=,lstart=']);
      const m=raw.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
      if(!m||/^[ZX]/.test(m[5]))return undefined;
      const mapped=await exec('/usr/sbin/lsof',['-a','-p',String(pid),'-d','txt','-Fn']);
      const filename=mapped.split('\n').find(x=>x.startsWith('n/'))?.slice(1);assert(filename);
      return{pid,parent:Number(m[2]),group:Number(m[3]),session:m[4],state:m[5],start:m[6],exe:await realpath(filename)};
    }catch(error){if(['ENOENT','ESRCH'].includes(error.code)||error.code===1)return undefined;throw error;}
  };
  for(const mode of ['timeout','cancel','dispose','natural-exit'])await t.test(mode,async()=>{
    for(const file of ['cohort.json','cohort-leader.json','release-middle','release-leader'])await rm(path.join(root,file),{force:true});
    const foreign=nativeSpawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,detached:true,stdio:'ignore'});
    const connector=await new CodexConnector({cli:'sacrificial-codex',root,timeoutMs:mode==='timeout'?5000:30000}).start();
    const abort=new AbortController(),pending=tool(connector,'ask_perfchecker',{prompt:'REPARENT_COHORT'},abort.signal).catch(error=>error);
    const qualified=[];
    try{
      const leader=JSON.parse(await until(()=>readFile(path.join(root,'cohort-leader.json'),'utf8')));
      const cohort=JSON.parse(await until(()=>readFile(path.join(root,'cohort.json'),'utf8')));
      for(const pid of [leader.leader,cohort.middle,cohort.detached,cohort.leaf]){
        const current=await identity(pid);assert(current,'Every ancestor is alive before reparenting');qualified.push(current);
      }
      assert.equal(qualified[1].parent,leader.leader);assert.equal(qualified[2].parent,cohort.middle);assert.equal(qualified[3].parent,cohort.detached);
      assert.notEqual(qualified[2].group,qualified[0].group);
      if(process.platform==='linux')assert.notEqual(qualified[2].session,qualified[0].session);
      else{
        // Darwin ps sess exposes the kernel e_sess pointer, which XNU leaves
        // zero. Its stat 's' is the actual EPROC_SLEADER session-leader flag.
        assert.equal(qualified[2].group,qualified[2].pid);assert.match(qualified[2].state,/s/);
      }
      const owner=connector.owners?.values().next().value;
      if(owner?.cohort)await until(()=>{assert(qualified.every(row=>owner.cohort.known.get(row.pid)?.start===row.start));return true;});
      await writeFile(path.join(root,'release-middle'),'release');
      const reparented=await until(async()=>{assert.equal(await identity(cohort.middle),undefined);const row=await identity(cohort.detached);assert(row);assert.notEqual(row.parent,cohort.middle);return row;});
      assert.equal(reparented.start,qualified[2].start);assert.equal(reparented.exe,qualified[2].exe);
      assert(await identity(cohort.leaf));assert(await identity(foreign.pid));
      if(mode==='cancel')abort.abort();
      const disposal=mode==='dispose'?connector.dispose():undefined;
      if(mode==='natural-exit')await writeFile(path.join(root,'release-leader'),'release');
      const outcome=await pending;await disposal;
      // Fetch aborts before the server finishes ownership cleanup. Await its
      // actual retained request, without calling dispose as a cleanup oracle.
      await until(async()=>{assert.equal(connector.owners.size,0);assert.equal(connector.children.size,0);return true;});
      for(const row of qualified)assert.equal(await identity(row.pid),undefined,mode+': owned incarnation absent before harness teardown');
      assert(await identity(foreign.pid),'An unrelated process with the same executable/cwd survives');
      if(mode==='timeout'){assert.equal(outcome.isError,true);assert.match(outcome.content[0].text,/timed out/);}
      if(owner)assert.equal(connector.owners.size,0,'Only proven cleanup retires ownership');
      t.diagnostic(JSON.stringify({mode,qualified,reparented,ownedAbsentBeforeTeardown:true,foreignAlive:true}));
    }finally{
      abort.abort();
      // On a regression, reclaim only an exact incarnation recorded alive while
      // its full parent chain was still attached to this fixture's leader.
      for(const row of qualified.reverse()){
        const current=await identity(row.pid);
        if(current?.start===row.start&&current.exe===row.exe)try{process.kill(row.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
      }
      await connector.dispose();await pending;
      foreign.kill('SIGKILL');await new Promise(resolve=>foreign.once('close',resolve));
    }
  });
}));


test('Codex preflight handles a missing executable and rapid normal exit without retaining an owner',async()=>environment(async root=>{
  // POSIX spawn raises ENOENT; the Windows private launcher reports failure
  // through its exit code, which inspectCodex translates into the public refusal.
  await assert.rejects(inspectCodex(path.join(root,'missing-native-cli'),root),
    process.platform==='win32'?/^Error: Choose a Codex CLI executable, then reconnect\.$/:/ENOENT/);
  await shutdownCodexPreflights();
  for(let iteration=0;iteration<3;iteration++)assert.equal(await inspectCodex('sacrificial-codex',root),'codex-cli 0.159.2');
  await shutdownCodexPreflights();
}));

test('Codex recovers cleanup after a rejected initial identity inspection without losing its owner',
  {skip:process.platform==='win32',timeout:10000},async()=>environment(async root=>{
  const {PosixProcessCohort}=require('../dist/posixProcessCohort.js'),observe=PosixProcessCohort.prototype.observe;
  let failed=false,pid;
  PosixProcessCohort.prototype.observe=async function(initial,...args){
    if(initial&&!failed){failed=true;pid=this.child.pid;throw new Error('Controlled initial process inspection failure.');}
    return observe.call(this,initial,...args);
  };
  try{await assert.rejects(inspectCodex('sacrificial-codex',root),/Controlled initial/);}
  finally{PosixProcessCohort.prototype.observe=observe;}
  assert(failed&&pid);await shutdownCodexPreflights();
  const rows=await new PosixProcessCohort({pid},true).group(true);
  assert.equal(rows.length,0,'The rejected preflight process is physically absent before retry');
  assert.equal(await inspectCodex('sacrificial-codex',root),'codex-cli 0.159.2');
}));


test('a live unobservable Codex owner is retained, blocks new calls, and can be disconnected after observation recovers',
  {skip:process.platform==='win32',timeout:10000},async()=>environment(async root=>{
  const {PosixProcessCohort}=require('../dist/posixProcessCohort.js'),observe=PosixProcessCohort.prototype.observe;
  const connector=await new CodexConnector({cli:'sacrificial-codex',root}).start();
  let pid;
  PosixProcessCohort.prototype.observe=async function(initial,...args){
    pid??=this.child.pid;throw new Error('Controlled unavailable process inspection.');
  };
  try{
    const result=await tool(connector,'ask_perfchecker',{prompt:'Must never be sent without qualified ownership.'});
    assert.equal(result.isError,true);assert.match(result.content[0].text,/Controlled unavailable/);
    assert.equal(connector.owners.size,1);assert.equal(connector.children.size,1);
    assert(pid);process.kill(pid,0);
    const blocked=await tool(connector,'ask_perfchecker',{prompt:'No second invocation.'});
    assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/cleanup is incomplete/);
  }finally{PosixProcessCohort.prototype.observe=observe;await connector.dispose();}
  assert.equal(connector.owners.size,0);assert.equal(connector.children.size,0);
  const rows=await new PosixProcessCohort({pid},true).group(true);assert.equal(rows.length,0);
}));


test('Codex observes a real shell exec while its parent is owned; an exec after reparenting is refused explicitly',
  {skip:process.platform==='win32',timeout:15000},async t=>{
  const {PosixProcessCohort}=require('../dist/posixProcessCohort.js');
  const identity=async pid=>(await new PosixProcessCohort({pid},true).group(true)).find(row=>row.pid===pid);
  const image=await realpath('/bin/sleep');
  for(const mode of ['attached','reparented'])await t.test(mode,()=>environment(async root=>{
    const foreign=nativeSpawn('/bin/sleep',['1000'],{stdio:'ignore'}),foreignClosed=new Promise(resolve=>foreign.once('close',resolve));
    const abort=new AbortController();let connector,leader,closed,pending,cohort,owned,initial;
    try{
      if(mode==='attached'){
        connector=await new CodexConnector({cli:'sacrificial-codex',root,timeoutMs:10000}).start();
        pending=tool(connector,'ask_perfchecker',{prompt:'EXEC_IMAGE'},abort.signal).catch(error=>error);
      }else{
        leader=nativeSpawn(process.execPath,[fixture,'--exec-owner'],{cwd:root,detached:true,stdio:'ignore'});
        closed=new Promise(resolve=>leader.once('close',resolve));cohort=new PosixProcessCohort(leader,true);await cohort.observe(true);
      }
      owned=JSON.parse(await until(()=>readFile(path.join(root,'exec-image.json'),'utf8')));
      if(connector)cohort=connector.owners.values().next().value.cohort;
      await until(async()=>{await cohort.observe();assert(cohort.known.has(owned.child));return true;});
      initial=cohort.known.get(owned.child);assert.notEqual(initial.exe,image);assert.equal(initial.parent,owned.leader);
      if(mode==='reparented'){
        await writeFile(path.join(root,'release-parent'),'release');await closed;
        await until(async()=>{await cohort.observe();assert.notEqual(cohort.known.get(owned.child).parent,owned.leader);return true;});
      }
      await writeFile(path.join(root,'release-exec'),'release');
      const current=await until(async()=>{const row=await identity(owned.child);assert(row);assert.equal(row.exe,image);return row;});
      assert.equal(current.start,initial.start,'exec keeps the exact observed kernel birth');
      if(mode==='attached'){
        await until(()=>{assert.equal(cohort.known.get(owned.child).exe,image);return true;});
        abort.abort();await pending;await until(()=>{assert.equal(connector.owners.size,0);return true;});
        assert.equal(await identity(owned.child),undefined,'The new executable is stopped before harness cleanup');
      }else{
        await assert.rejects(cohort.observe(),/executable changed without a currently qualified live parent/);
        await assert.rejects(cohort.signal('SIGKILL'),/executable changed without a currently qualified live parent/);
        assert(await identity(owned.child),'The unresolved image is not signalled on incomplete ownership proof');
      }
      assert(await identity(foreign.pid),'The unrelated same-executable process survives');
      t.diagnostic(JSON.stringify({mode,pid:owned.child,start:initial.start,fromExecutable:initial.exe,toExecutable:current.exe,
        executableTransitionQualified:mode==='attached',cleanupRefusedExplicitly:mode==='reparented',foreignAlive:true}));
    }finally{
      abort.abort();
      // External fixture teardown has its own creation/birth proof, distinct
      // from the product's deliberately refused detached-image cleanup.
      if(owned&&initial){const current=await identity(owned.child);if(current?.start===initial.start)process.kill(owned.child,'SIGKILL');}
      if(leader&&await identity(leader.pid))leader.kill('SIGKILL');
      if(closed)await closed;if(connector)await connector.dispose();if(pending)await pending;
      foreign.kill('SIGKILL');await foreignClosed;
    }
  }));
});
