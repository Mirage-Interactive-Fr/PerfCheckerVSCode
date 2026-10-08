import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function nativeVSCodeApplication(executable, cli, {platform=process.platform, expectedVersion}={}) {
  const root=path.dirname(executable);
  const direct=platform==='darwin'?path.resolve(root,'../Resources/app'):path.join(root,'resources','app');
  const complete=async directory=>(await Promise.all(['package.json','product.json','out/cli.js'].map(file=>
    fs.stat(path.join(directory,file)).then(stat=>stat.isFile()).catch(error=>{if(error.code==='ENOENT')return false;throw error;})))).every(Boolean);
  let application=direct;
  if(!await complete(application)){
    assert.equal(platform,'win32','The declared VS Code application contains all required metadata and CLI files');
    const candidates=[];
    for(const item of await fs.readdir(root,{withFileTypes:true})){
      if(!item.isDirectory()||!/^[a-f0-9]{10,40}$/i.test(item.name))continue;
      const directory=path.join(root,item.name,'resources','app');
      if(await complete(directory))candidates.push(directory);
    }
    assert.equal(candidates.length,1,'Exactly one complete versioned Windows application must be present');
    [application]=candidates;
  }
  assert((await fs.stat(executable)).isFile(),'The SDK resolves a real VS Code executable');
  assert((await fs.stat(cli)).isFile(),'The SDK resolves a real VS Code CLI');
  const manifest=JSON.parse(await fs.readFile(path.join(application,'package.json'),'utf8'));
  const product=JSON.parse(await fs.readFile(path.join(application,'product.json'),'utf8'));
  assert.match(manifest.version,/^\d+\.\d+\.\d+$/,'The actual application has a stable numeric version');
  assert.equal(product.version,manifest.version,'Application package and product versions agree');
  if(expectedVersion&&expectedVersion!=='stable')assert.equal(manifest.version,expectedVersion,'The actual application has the requested exact version');
  assert.equal(product.applicationName,'code','The actual application is the declared stable VS Code product');
  assert.match(product.commit,/^[a-f0-9]{40}$/,'The actual product supplies its immutable commit');
  if(platform==='win32'){
    const relative=path.relative(root,application),versioned=relative.split(path.sep)[0];
    if(application!==direct)assert(product.commit.startsWith(versioned),'The versioned application directory matches its actual product commit');
    const wrapper=await fs.readFile(cli,'utf8'),relativeCLI=path.join(relative,'out','cli.js').split(path.sep).join('\\');
    assert(wrapper.includes(relativeCLI),'The actual SDK CLI wrapper routes to the same validated application CLI');
  }
  return {application,version:manifest.version,commit:product.commit,applicationName:product.applicationName,
    cliSource:await fs.readFile(path.join(application,'out','cli.js'),'utf8')};
}
