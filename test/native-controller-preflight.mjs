import assert from 'node:assert/strict';
import path from 'node:path';
import {TextDecoder} from 'node:util';

// Emit primitive fields rather than compiling a generic JSON writer after the
// cold HTTP import. All loading, identity checks and the 180 s budget remain real.
export const controllerPreflightScript=String.raw`println("CONTROLLER_PREFLIGHT_READY ",getpid());flush(stdout);readline(stdin)
using Pkg;Pkg.activate(ARGS[1]);started=time();modules=Module[]
for name in (:PerfChecker,:HTTP)
 println("CONTROLLER_IMPORT_BEFORE ",name," elapsed=",time()-started);flush(stdout)
 m=Base.require(Main,name);push!(modules,m)
 println("CONTROLLER_IMPORT_AFTER ",name," elapsed=",time()-started," version=",Base.pkgversion(m)," source=",pathof(m));flush(stdout)
end
core=first(modules);extension=Base.get_extension(core,:HTTPAdvisorExt);@assert extension!==nothing
function diagnose_controller_tree(m,root,source,tree,pinned)
 println(join(["CONTROLLER_TREE_CHECK_V1",string(nameof(m)),string(Base.pkgversion(m)),bytes2hex(codeunits(root)),bytes2hex(codeunits(source)),tree,pinned],'\t'));flush(stdout)
 tree==pinned&&return
 println("CONTROLLER_TREE_MISMATCH_V1 ",nameof(m));flush(stdout)
 config=Cmd(["git","-C",root,"config","--show-origin","--get-regexp","^core\\.(autocrlf|eol|filemode)\$"])
 try
  process=open(pipeline(ignorestatus(config),stderr=devnull));value=""
  try;value=read(process,String);wait(process)
   println(join(["CONTROLLER_GIT_CONFIG_V1",string(nameof(m)),string(process.exitcode),bytes2hex(codeunits(first(value,min(length(value),8192))))],'\t'))
  finally;close(process);end
 catch error;println("CONTROLLER_GIT_CONFIG_UNKNOWN_V1 ",nameof(m)," ",nameof(typeof(error)));end
 count=0;total=0
 for (directory,subdirs,files) in walkdir(root)
  filter!(name->name!=".git",subdirs)
  names=sort!(vcat(filter(name->islink(joinpath(directory,name)),subdirs),filter(name->name!=".git",files)))
  for name in names
   file=joinpath(directory,name);count+=1;total+=islink(file) ? ncodeunits(readlink(file)) : filesize(file)
   if count>5000||total>100_000_000
    println("CONTROLLER_TREE_INVENTORY_UNKNOWN_V1 observation-budget files=",count," bytes=",total);flush(stdout);return
   end
   bytes=islink(file) ? Vector{UInt8}(codeunits(readlink(file))) : read(file)
   hash=bytes2hex(Pkg.GitTools.SHA.sha1(vcat(codeunits("blob $(length(bytes))\0"),bytes)))
   crlf=0;for i in 1:(length(bytes)-1);crlf+=(bytes[i]==0x0d&&bytes[i+1]==0x0a);end
   normalized="-";value=String(copy(bytes))
   if crlf>0&&isvalid(value)
    value=replace(value,"\r\n"=>"\n");normalized=bytes2hex(Pkg.GitTools.SHA.sha1(vcat(codeunits("blob $(ncodeunits(value))\0"),codeunits(value))))
   end
   println(join(["CONTROLLER_TREE_FILE_V1",string(nameof(m)),bytes2hex(codeunits(relpath(file,root))),string(Pkg.GitTools.gitmode(file)),string(length(bytes)),hash,string(crlf),normalized],'\t'))
  end
 end
 println("CONTROLLER_TREE_INVENTORY_COMPLETE_V1 ",nameof(m)," files=",count," bytes=",total);flush(stdout)
end
fields=String["CONTROLLER_IMPORT_RECEIPT_V1","",string(nameof(extension)),bytes2hex(codeunits(realpath(Base.active_project())))];deps=Pkg.dependencies()
identities=map(modules) do m
 root=realpath(pkgdir(m));source=realpath(pathof(m));tree=bytes2hex(Pkg.GitTools.tree_hash(root));pinned=string(deps[Base.PkgId(m).uuid].tree_hash)
 (m,root,source,tree,pinned)
end
for (m,root,source,tree,pinned) in identities;diagnose_controller_tree(m,root,source,tree,pinned);end
for (m,root,source,tree,pinned) in identities
 @assert tree==pinned
 append!(fields,[string(nameof(m)),string(Base.pkgversion(m)),bytes2hex(codeunits(root)),bytes2hex(codeunits(source)),tree,pinned])
end
fields[2]=string(time()-started);println(join(fields,'\t'));flush(stdout)`;

export function parseControllerImportReceipt(text,{project,version,tree}){
  const lines=text.split(/\r?\n/).filter(line=>line.startsWith('CONTROLLER_IMPORT_RECEIPT'));
  assert.equal(lines.length,1,'Exactly one complete controller import receipt is required');
  const fields=lines[0].split('\t');
  assert.equal(fields.length,16,'The primitive receipt has every identity field');
  assert.equal(fields[0],'CONTROLLER_IMPORT_RECEIPT_V1','Unknown controller receipt protocol');
  assert(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(fields[1]));
  const elapsedSeconds=Number(fields[1]);assert(Number.isFinite(elapsedSeconds)&&elapsedSeconds>=0);
  assert.equal(fields[2],'HTTPAdvisorExt','The real HTTP extension must be loaded');
  const decode=value=>{
    assert(/^(?:[a-f0-9]{2})+$/.test(value),'Identity strings use canonical nonempty UTF-8 hex');
    const decoded=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(value,'hex'));
    assert(!/[\0\r\n]/.test(decoded),'Identity paths cannot contain control delimiters');
    assert(path.isAbsolute(decoded),'Identity paths are absolute');return decoded;
  };
  const activeProject=decode(fields[3]);assert.equal(activeProject,project,'The imported controller is the prepared project');
  const packages=[4,10].map((offset,index)=>{
    const [name,actualVersion,rootHex,sourceHex,actualTree,pinnedTree]=fields.slice(offset,offset+6);
    assert.equal(name,index===0?'PerfChecker':'HTTP');assert(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(actualVersion));
    const root=decode(rootHex),source=decode(sourceHex);
    assert.equal(source,path.join(root,'src',`${name}.jl`),'The actual entrypoint belongs to the reported package');
    assert(/^[a-f0-9]{40}$/.test(actualTree));assert.equal(actualTree,pinnedTree,'Loaded source matches its pinned dependency tree');
    return {name,version:actualVersion,root,source,tree:actualTree};
  });
  assert.equal(packages[0].version,version);assert.equal(packages[0].tree,tree,'The imported Core matches the qualified immutable tree');
  return {elapsedSeconds,extension:fields[2],activeProject,packages};
}

// Inspection failures remain fatal. Retain the evidence execFile supplies,
// without its command/environment or unbounded stdout/stderr dumps.
export function controllerInspectionFailure(error,{stage,pid,ownerPid}){
  return {stage,pid,ownerPid,observedAt:new Date().toISOString(),
    error:String(error.message??error).slice(0,4000),code:error.code??null,signal:error.signal??null,
    killed:typeof error.killed==='boolean'?error.killed:null,
    stderr:String(error.stderr??'').slice(-4000)};
}
