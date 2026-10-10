// Disposable Linux default-browser fixture. env.openExternal is never mocked:
// Electron launches xdg-open, which invokes this fixture's temporary handler.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createServer}=require('node:http');
const {randomBytes,createHash}=require('node:crypto');
const assert=require('node:assert/strict');

if(require.main===module){
  const url=process.argv.at(-1);
  fetch(`${process.env.PERFCHECKER_NATIVE_BROWSER_ORACLE}/open`,{method:'POST',headers:{
    authorization:`Bearer ${process.env.PERFCHECKER_NATIVE_BROWSER_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({url})})
    .then(response=>{if(!response.ok)throw Error('Owned browser fixture rejected the launch');})
    .catch(()=>{process.stderr.write('Owned browser fixture launch failed\n');process.exitCode=1;});
}

exports.create=async(directory,{chromium,executablePath}={})=>{
  const fixture=path.join(directory,'default-browser');await fs.mkdir(path.join(fixture,'data','applications'),{recursive:true});
  await fs.mkdir(path.join(fixture,'config'),{recursive:true});
  const token=randomBytes(32).toString('hex'),events=[];
  let browser,origin,secret;
  const server=createServer(async(request,response)=>{
    if(request.headers.authorization!==`Bearer ${token}`){response.writeHead(403);response.end();return;}
    response.setHeader('content-type','application/json');
    if(request.method==='GET'&&request.url==='/events'){response.end(JSON.stringify(events));return;}
    if(request.method!=='POST'||request.url!=='/open'){response.writeHead(404);response.end();return;}
    try{
      let input='';for await(const chunk of request){input+=chunk;if(input.length>12000)throw Error('Oversized launch');}
      const url=new URL(JSON.parse(input).url);
      assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');
      assert(['/notebookfile','/notebookexport','/new','/open','/edit','/'].includes(url.pathname));
      assert(url.searchParams.get('secret'));
      if(origin){assert.equal(url.origin,origin);assert.equal(url.searchParams.get('secret'),secret);}
      else{origin=url.origin;secret=url.searchParams.get('secret');}
      browser||=await chromium.launch({...(executablePath?{executablePath}:{}),headless:true,args:['--no-sandbox']});
      const page=await browser.newPage();
      const route=url.pathname;let proof;
      if(route==='/notebookexport'){
        const downloadPromise=page.waitForEvent('download');
        await page.goto(url.href).catch(error=>{if(!/ERR_ABORTED|Download is starting/i.test(error.message))throw error;});
        const download=await downloadPromise,stream=await download.createReadStream(),chunks=[];
        for await(const chunk of stream)chunks.push(chunk);
        const bytes=Buffer.concat(chunks),html=bytes.toString();
        assert.match(html,/<!doctype html>/i);assert.match(download.suggestedFilename(),/\.html$/);
        const encoded=html.match(/data:text\/julia;charset=utf-8;base64,([A-Za-z0-9+/=]+)/);
        assert(encoded,'The real HTML export embeds the Julia source');
        const source=Buffer.from(encoded[1],'base64').toString();
        assert(source.startsWith('### A Pluto.jl notebook ###'));assert.match(source,/4 \+ 5/);
        assert(!html.includes(secret)&&!source.includes(secret),'Exports never contain the session credential');
        proof={route,kind:'html-download',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),embeddedJulia:true,editedExpression:true,credentialAbsent:true};
      }else if(route==='/notebookfile'){
        const result=await page.goto(url.href);assert.equal(result.status(),200);
        const source=await page.locator('body').innerText();
        assert(source.startsWith('### A Pluto.jl notebook ###'));assert.match(source,/4 \+ 5/);assert(!source.includes(secret));
        proof={route,kind:'julia-source-browser',bytes:Buffer.byteLength(source),sha256:createHash('sha256').update(source).digest('hex'),editedExpression:true,credentialAbsent:true};
      }else{
        let authenticatedWebSocket=false;
        page.on('websocket',socket=>{const ws=new URL(socket.url());if(ws.host===url.host&&ws.searchParams.get('secret')===secret)authenticatedWebSocket=true;});
        await page.goto(url.href);await page.locator('pluto-notebook').waitFor({timeout:90000});
        const final=new URL(page.url());assert.equal(final.origin,origin);assert.equal(final.pathname,'/edit');assert.equal(final.searchParams.get('secret'),secret);
        assert(authenticatedWebSocket,'The actual new browser notebook connects its authenticated WebSocket');
        proof={route,kind:'new-context-editor',authenticatedWebSocket:true,notebookId:final.searchParams.get('id')};
      }
      events.push({...proof,completedAt:new Date().toISOString()});response.end(JSON.stringify({ok:true}));
    }catch(error){events.push({failed:true,reason:error.message.replaceAll(secret||'\0','[session secret]')});response.writeHead(500);response.end(JSON.stringify({ok:false}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const oracle=`http://127.0.0.1:${server.address().port}`;
  const launcher=path.join(fixture,'browser');
  const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
  // xdg-open requires an executable handler and desktop entry. Both live only
  // inside the disposable session; no real user's MIME/default profile changes.
  await fs.writeFile(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(__filename)} "$@"\n`,{mode:0o700});
  await fs.writeFile(path.join(fixture,'data','applications','perfchecker-fixture.desktop'),`[Desktop Entry]\nType=Application\nName=PerfChecker disposable browser\nExec=${launcher} %u\nMimeType=x-scheme-handler/http;x-scheme-handler/https;\nNoDisplay=true\n`);
  await fs.writeFile(path.join(fixture,'config','mimeapps.list'),'[Default Applications]\nx-scheme-handler/http=perfchecker-fixture.desktop\nx-scheme-handler/https=perfchecker-fixture.desktop\n');
  return{environment:{BROWSER:launcher,XDG_CURRENT_DESKTOP:'',XDG_CONFIG_HOME:path.join(fixture,'config'),XDG_DATA_HOME:path.join(fixture,'data'),
      PERFCHECKER_NATIVE_BROWSER_ORACLE:oracle,PERFCHECKER_NATIVE_BROWSER_TOKEN:token},
    async close(){await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(fixture,{recursive:true,force:true});}};
};
