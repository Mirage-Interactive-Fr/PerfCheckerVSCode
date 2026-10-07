import assert from 'node:assert/strict';
import test from 'node:test';
import Module, {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {createServer,request as httpRequest} from 'node:http';
import {createServer as createPortServer} from 'node:net';
import {randomBytes} from 'node:crypto';

test('real Pluto 1.0.4 keeps native components and authenticates its complete embedded navigation',{
  skip:!process.env.PERFCHECKER_PLUTO_TEST_PROJECT,timeout:360000,
},async()=>{
  const require=createRequire(import.meta.url),{chromium}=require(process.env.PERFCHECKER_PLAYWRIGHT||'playwright');
  const {cancellableJulia,CANCEL_REQUEST}=require('../dist/controllerCancellation.js');
  const root=await mkdtemp(path.join(os.tmpdir(),'perfchecker-real-pluto-'));
  const notebook=path.join(root,'Navigation.jl'),project=process.env.PERFCHECKER_PLUTO_TEST_PROJECT,originalMarker=path.join(root,'original.pid');
  await writeFile(notebook,`### A Pluto.jl notebook ###\n# v1.0.4\n\nusing Markdown\nusing InteractiveUtils\n\n# ╔═╡ 27187d83-0729-4300-b3dc-7185b06af0ed\nbegin\nimport Pkg\nPkg.activate(${JSON.stringify(project)})\nwrite(${JSON.stringify(originalMarker)},string(getpid()))\n1 + 2\nend\n\n# ╔═╡ Cell order:\n# ╠═27187d83-0729-4300-b3dc-7185b06af0ed\n`);
  const initialNotebook=await readFile(notebook,'utf8');
  const source=await readFile(new URL('../src/plutoNotebook.ts',import.meta.url),'utf8');
  const code=source.match(/const serverCode = `([\s\S]*?)`;/)[1];
  const navigation=await readFile(new URL('../media/pluto-navigation.js',import.meta.url),'utf8');
  const eventual=async(read,description,timeout=90000)=>{const until=Date.now()+timeout;while(Date.now()<until){const result=await read();if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(description);};
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
  let browser;
  const run=async(script,verify,sandbox=false,popupBridge=false)=>{
    await rm(originalMarker,{force:true});
    await writeFile(notebook,initialNotebook);
    const socket=createPortServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
    const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const secret=randomBytes(32).toString('hex'),capability=randomBytes(32).toString('hex');let output='',errors='';
    if(popupBridge)script=script.replace('__PERFCHECKER_PLUTO_POPUP_CAPABILITY__',capability);
    const child=spawn(process.env.PERFCHECKER_TEST_JULIA||'julia',['--startup-file=no','--history-file=no',`--project=${project}`,'-e',cancellableJulia(code)],{
      cwd:root,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],
      env:{...process.env,JULIA_LOAD_PATH:['@','@stdlib'].join(path.delimiter),JULIA_PLUTO_NEW_NOTEBOOKS_DIR:root,PERFCHECKER_PLUTO_PORT:String(port),
        PERFCHECKER_PLUTO_NOTEBOOK:notebook,PERFCHECKER_PLUTO_SECRET:secret,PERFCHECKER_PLUTO_NAVIGATION:`data:text/javascript;base64,${Buffer.from(script).toString('base64')}`}});
    child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors=(errors+data).slice(-2000));
    const externalRequests=[];
    const server=createServer((request,response)=>{
      const incoming=new URL(request.url,'http://localhost');
      if(incoming.pathname==='/outside'){externalRequests.push({secret:incoming.searchParams.has('secret'),referer:request.headers.referer});response.end('Separate origin');return;}
      const target=new URL(request.url,'http://localhost').searchParams.get('target')||`edit?id=${output.match(/PERFCHECKER_PLUTO_READY \d+ ([a-f0-9-]+)/)?.[1]}`;
      const bridge=popupBridge?Function('popupOrigin','capability',`return \`${source.match(/const bridge=\x60([\s\S]*?)\x60;/)[1]}\`;`)(JSON.stringify(`http://127.0.0.1:${port}`),JSON.stringify(capability)):'';
      response.setHeader('content-type','text/html');response.end(`<iframe class="perfchecker-pluto-frame" ${sandbox?'sandbox="allow-same-origin allow-pointer-lock allow-scripts allow-downloads allow-forms"':''} width="1100" height="800" src="http://127.0.0.1:${port}/${target}${target.includes('?')?'&':'?'}secret=${secret}"></iframe>${popupBridge?`<script>const api={postMessage:message=>window.__browserLaunch(message)};${bridge}</script>`:''}`);
    });
    let page,defaultBrowser;
    try{
      await eventual(()=>{if(child.exitCode!==null)throw Error(`Actual Pluto startup failed: ${errors.replaceAll(secret,'[session secret]')}`);return /PERFCHECKER_PLUTO_READY/.test(output);},'Actual Pluto server readiness');
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      page=await browser.newPage({viewport:{width:1400,height:1100},locale:'fr-FR'});
      if(popupBridge){
        defaultBrowser=await require('./native-external-browser.cjs').create(root,{chromium,executablePath:process.env.PERFCHECKER_BROWSER});
        await page.exposeFunction('__browserLaunch',async message=>{
          assert.equal(message.type,'plutoPopup');assert.equal(message.capability,capability);
          const value=new URL(message.url);assert.equal(value.origin,`http://127.0.0.1:${port}`);assert.equal(value.searchParams.get('secret'),secret);
          await new Promise((resolve,reject)=>{const launch=spawn(process.platform==='linux'?'xdg-open':defaultBrowser.environment.BROWSER,[message.url],{env:{...process.env,...defaultBrowser.environment},stdio:'pipe'});launch.once('error',reject);launch.once('exit',code=>code===0?resolve():reject(Error('Owned actual browser launch failed')));});
        });
      }
      await page.goto(`http://localhost:${server.address().port}/`);
      let frame=page.frames().find(item=>item.parentFrame());
      await frame.locator('[data-perfchecker-navigation="ready"]').waitFor({state:'attached',timeout:90000});
      const homepage=async()=>{await frame.locator('img#logo-big').locator('..').click();await frame.locator('[data-perfchecker-navigation="ready"]').waitFor({state:'attached'});await frame.locator('#recent').waitFor();};
      const closeOwned=async()=>{
        child.stdin.write(`${CANCEL_REQUEST}\n`);
        await eventual(()=>child.exitCode!==null,'Cooperative Close finishes with multiple native clients and notebooks',45000);
        assert.equal(child.exitCode,130,errors.replaceAll(secret,'[session secret]'));
        assert.match(errors,/cancelled after controller cleanup/);
        await assert.rejects(fetch(`http://127.0.0.1:${port}/?secret=${secret}`));
      };
      const browserEvents=defaultBrowser?async()=>{const result=await fetch(`${defaultBrowser.environment.PERFCHECKER_NATIVE_BROWSER_ORACLE}/events`,{headers:{authorization:`Bearer ${defaultBrowser.environment.PERFCHECKER_NATIVE_BROWSER_TOKEN}`}});return result.json();}:undefined;
      await verify({page,frame,homepage,port,secret,capability,externalRequests,closeOwned,browserEvents,host:`http://localhost:${server.address().port}`});
    }catch(error){
      throw new Error(`${error.message}\n${errors.replaceAll(secret,'[session secret]')}`,{cause:error});
    }finally{
      await page?.close();await defaultBrowser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      if(child.exitCode===null&&child.signalCode===null){
        if(process.platform==='win32'){const killer=spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore'});await once(killer,'exit');}
        else try{process.kill(-child.pid,'SIGTERM');}catch{}
        if(child.exitCode===null&&child.signalCode===null)await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,5000))]);
        if(process.platform!=='win32'&&child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGKILL');}catch{}
      }
    }
  };
  try{
    browser=await chromium.launch({...(process.env.PERFCHECKER_BROWSER?{executablePath:process.env.PERFCHECKER_BROWSER}:{}),headless:true,args:['--no-sandbox']});
    const oldOverrides=navigation.replace('return {};','const noop=()=>false;return {custom_editor_header_component:noop,custom_recent:noop,custom_filepicker:noop};');
    await run(oldOverrides,async({page,frame,host})=>{
      await eventual(async()=>await frame.locator('pluto-filepicker').count()===0,'The prior hook removes the real native header file picker',5000);
      await page.goto(`${host}/?target=${encodeURIComponent('')}&home=1`);
      frame=page.frames().find(item=>item.parentFrame());await frame.goto(frame.url().replace(/\/edit\?id=[^&]+&/,'/?'));
      await frame.locator('[data-perfchecker-navigation="ready"]').waitFor({state:'attached'});
      await eventual(async()=>await frame.locator('#recent').count()===0,'The prior hook removes the real Recent list',5000);
    });
    const unadapted='export default function(){document.documentElement.setAttribute("data-perfchecker-navigation","ready");return {};}';
    await run(unadapted,async({page,frame,homepage,closeOwned})=>{
      const pid=await eventual(async()=>{const value=await readFile(originalMarker,'utf8').catch(()=>undefined);return value?Number(value):false;},'The original real notebook worker is ready');
      let dialogs=0;const warnings=[];
      page.on('dialog',async dialog=>{dialogs++;await dialog.accept();});page.on('console',message=>warnings.push(message.text()));
      await frame.locator('#at_the_top button.toggle_export').click();
      await frame.locator('#export a[href*="notebookfile?"]').click();
      await eventual(()=>warnings.some(value=>/allow-popups/.test(value)),
        'The actual native Julia export new-window link is blocked by the official ancestor sandbox',5000);
      await homepage();
      const running=frame.locator('#recent li.running').filter({hasText:'Navigation.jl'});
      await running.locator('button').first().click();
      await eventual(()=>warnings.some(value=>/confirm.*sandbox|sandbox.*allow-modals/i.test(value)),
        'Real Pluto native confirmation is suppressed by the exact VS Code ancestor sandbox',5000);
      assert.equal(dialogs,0);assert.equal(await running.count(),1);assert(alive(pid));
      await closeOwned();await eventual(()=>!alive(pid),'The regression fixture worker is closed before harness teardown',45000);
    },true);
    await run(navigation,async({frame,homepage,port,secret,closeOwned})=>{
      const pid=await eventual(async()=>{const value=await readFile(originalMarker,'utf8').catch(()=>undefined);return value?Number(value):false;},'The sandboxed real notebook worker is ready');
      assert(alive(pid));await homepage();
      const running=frame.locator('#recent li.running').filter({hasText:'Navigation.jl'});
      await frame.evaluate(()=>{window.__perfcheckerTestConfirm=window.confirm;});
      await running.locator('button').first().click();
      const confirmation=frame.getByRole('dialog',{name:'Pluto confirmation'});
      await confirmation.waitFor();
      assert.equal(await confirmation.locator('p').innerText(),'Terminer le processus du notebook ?');
      assert(await frame.evaluate(()=>window.confirm===window.__perfcheckerTestConfirm),'Question capture restores the original native confirm immediately');
      await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();
      assert.equal(await running.count(),1);assert(alive(pid));
      await running.locator('button').first().click();await confirmation.waitFor();
      await confirmation.getByRole('button',{name:'Confirm',exact:true}).click();
      assert(await frame.evaluate(()=>window.confirm===window.__perfcheckerTestConfirm),'Approval restores the native confirm immediately');
      await frame.evaluate(()=>{delete window.__perfcheckerTestConfirm;});
      await running.waitFor({state:'detached'});
      await eventual(()=>!alive(pid),'Sandboxed native Shutdown terminates its real worker before harness cleanup',45000);
      assert.equal((await fetch(`http://127.0.0.1:${port}/?secret=${secret}`)).status,200);
      await closeOwned();
    },true);
    await run(navigation,async({page,frame,homepage,closeOwned,browserEvents,capability,secret})=>{
      const editorUrl=frame.url();
      for(const [cap,url]of [['wrong',editorUrl],[capability,editorUrl.replace(secret,'wrong')],[capability,'https://external.invalid/new'],[capability,new URL(`/frontend/common/Environment.js?secret=${secret}`,editorUrl).href]]){
        await frame.evaluate(({cap,url})=>parent.postMessage({type:'perfcheckerPlutoPopup',capability:cap,url},'*'),{cap,url});
      }
      // A sibling/outer window cannot impersonate the exact owned child source.
      await page.evaluate(({capability,url})=>window.postMessage({type:'perfcheckerPlutoPopup',capability,url},location.origin),{capability,url:editorUrl});
      for(const [href,download]of [['#cell',false],['https://external.invalid/new',false],['/frontend/common/Environment.js',false],['/new?secret=wrong',false],['/new',true]]){
        await frame.evaluate(({href,download})=>{const link=document.createElement('a');link.id='negative-popup';link.href=href;link.textContent='Negative new-context fixture';if(download)link.download='fixture';link.addEventListener('click',event=>event.preventDefault());document.body.append(link);},{href,download});
        await frame.locator('#negative-popup').click({modifiers:['Control']});
        assert.equal(new URL(await frame.locator('#negative-popup').getAttribute('href'),editorUrl).href,new URL(href,editorUrl).href,
          'Negative gestures preserve their destination and never acquire the session credential');
        await frame.locator('#negative-popup').evaluate(link=>link.remove());
      }
      await new Promise(resolve=>setTimeout(resolve,300));assert.deepEqual(await browserEvents(),[]);
      const cell=frame.locator('pluto-cell').first(),editor=cell.locator('pluto-input .cm-content[contenteditable="true"]');
      if(!await editor.isVisible())await cell.locator('.foldcode').click();
      await editor.fill('4 + 5');await editor.press('ControlOrMeta+Enter');
      await eventual(async()=>/^9$/.test((await cell.locator('pluto-output').innerText()).trim()),'The sandboxed editor saves the exported 4 + 5 expression');
      await eventual(async()=>/4 \+ 5/.test(await readFile(notebook,'utf8')),'The exported source is genuinely autosaved');
      const completed=async(kind)=>eventual(async()=>{const values=await browserEvents();assert(!values.some(value=>value.failed),JSON.stringify(values));return values.find(value=>value.kind===kind);},`Actual browser fixture completes ${kind}`);
      await frame.locator('#at_the_top button.toggle_export').click();
      await frame.locator('#export a[href*="notebookfile?"]').click();
      assert((await completed('julia-source-browser')).credentialAbsent);console.log('REAL_PLUTO_SANDBOX_JULIA_EXPORT_PASS');
      if(!((await frame.locator('#pluto-nav').getAttribute('class'))||'').includes('show_export'))await frame.locator('#at_the_top button.toggle_export').click();
      await frame.locator('#pluto-nav.show_export #export a[href*="notebookexport?"]').click();
      await frame.locator('.export-html-dialog .ple-download a[download]').click();
      assert((await completed('html-download')).embeddedJulia);console.log('REAL_PLUTO_SANDBOX_HTML_DOWNLOAD_PASS');
      await homepage();await frame.locator('#recent li.new a').click({modifiers:['Control']});
      assert((await completed('new-context-editor')).authenticatedWebSocket);console.log('REAL_PLUTO_SANDBOX_IMMEDIATE_MODIFIED_NEW_PASS');
      assert.equal(new URL(frame.url()).pathname,'/','Modified New does not navigate the original embedded editor');
      await closeOwned();
    },true,true);
    await run(navigation,async({page,frame,homepage,port,secret,externalRequests,closeOwned,host})=>{
      assert(await frame.locator('img#logo-big').isVisible());await frame.locator('#at_the_top pluto-filepicker').waitFor();await homepage();
      const authenticated=()=>assert.equal(new URL(frame.url()).searchParams.get('secret'),secret);
      authenticated();assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,403);
      assert.equal((await fetch(`http://127.0.0.1:${port}/edit?id=invalid`,{headers:{Referer:`http://external.invalid/?secret=${secret}`}})).status,403);
      assert.equal((await fetch(`http://127.0.0.1:${port}/edit?id=invalid`,{headers:{Referer:`https://127.0.0.1:${port}/?secret=${secret}`}})).status,403);
      assert.equal((await fetch(`http://127.0.0.1:${port}/edit?id=invalid&secret=wrong`,{headers:{Referer:`http://127.0.0.1:${port}/?secret=${secret}`}})).status,403);
      for(const query of ['','?secret=wrong'])await new Promise((resolve,reject)=>{
        const request=httpRequest(`http://127.0.0.1:${port}/${query}`,{headers:{Connection:'Upgrade',Upgrade:'websocket',
          'Sec-WebSocket-Version':'13','Sec-WebSocket-Key':randomBytes(16).toString('base64')}},response=>{
          assert.equal(response.statusCode,403,'An unauthenticated real WebSocket handshake admits no client');
          let body='';response.on('data',data=>body+=data);response.on('end',()=>{assert.equal(body,'Forbidden');resolve();});
        });
        request.on('upgrade',(_response,socket)=>{socket.destroy();reject(Error('An unauthenticated WebSocket was admitted'));});
        request.on('error',reject);request.setTimeout(5000,()=>request.destroy(Error('The refused WebSocket response did not finish')));request.end();
      });
      await frame.evaluate(url=>{const link=document.createElement('a');link.id='actual-external-navigation';link.href=url;link.target='_blank';link.textContent='Separate origin';document.body.append(link);},`${host}/outside`);
      const externalPagePromise=page.context().waitForEvent('page');await frame.locator('#actual-external-navigation').click();
      const externalPage=await externalPagePromise;await externalPage.getByText('Separate origin',{exact:true}).waitFor();await externalPage.close();
      assert.deepEqual(externalRequests,[{secret:false,referer:undefined}],
        'An actual browser request to another origin has no session secret in its URL or Referer');
      await frame.locator('#recent li.running a').filter({hasText:'Navigation.jl'}).click();await frame.locator('pluto-notebook').waitFor();authenticated();
      const cell=frame.locator('pluto-cell[id="27187d83-0729-4300-b3dc-7185b06af0ed"]');
      await eventual(async()=>/^3$/.test((await cell.locator('pluto-output').innerText()).trim()),'The actual initial reactive cell finishes');
      const originalPid=Number(await readFile(originalMarker,'utf8'));assert(alive(originalPid));
      const editor=cell.locator('pluto-input .cm-editor:not(.cm-ssr-fake) .cm-content[contenteditable="true"]');
      const edited=`begin\nimport Pkg\nPkg.activate(${JSON.stringify(project)})\n4 + 5\nend`;
      await editor.fill(edited);await editor.press('Escape');assert.equal((await editor.innerText()).replace(/\s+/g,''),edited.replace(/\s+/g,''));await editor.press('ControlOrMeta+Enter');
      await eventual(async()=>{const value=(await cell.locator('pluto-output').innerText()).trim();if(await cell.locator('.errored').count())throw Error(`Actual reactive error: ${value.slice(0,500)}`);return /^9$/.test(value);},'The edited cell reevaluates over the real authenticated WebSocket');
      await eventual(async()=>(await readFile(notebook,'utf8')).includes('4 + 5'),'The reactive editor saves actual changed Julia source');
      const notebookId=new URL(frame.url()).searchParams.get('id');
      for(const route of ['notebookfile','notebookexport']){
        const target=`http://127.0.0.1:${port}/${route}?id=${notebookId}`;
        assert.equal((await fetch(target)).status,403);
        assert.equal((await fetch(target,{headers:{Referer:`http://external.invalid/?secret=${secret}`}})).status,403);
        assert.equal((await fetch(`${target}&secret=wrong`,{headers:{Referer:frame.url()}})).status,403);
      }
      await frame.locator('#at_the_top button.toggle_export').click();
      const sourcePagePromise=page.context().waitForEvent('page');await frame.locator('#export a[href*="notebookfile?"]').click();
      const sourcePage=await sourcePagePromise;await sourcePage.waitForURL(url=>url.pathname==='/notebookfile'&&url.searchParams.get('secret')===secret);
      const exportedJulia=await sourcePage.locator('body').innerText();assert.match(exportedJulia,/### A Pluto\.jl notebook ###/);assert.match(exportedJulia,/4 \+ 5/);await sourcePage.close();
      if(!((await frame.locator('#pluto-nav').getAttribute('class'))||'').includes('show_export'))await frame.locator('#at_the_top button.toggle_export').click();
      await frame.locator('#pluto-nav.show_export #export a[href*="notebookexport?"]').click();
      const htmlDownloadPromise=page.waitForEvent('download',{timeout:90000});
      await frame.locator('.export-html-dialog .ple-download a[download]').click();
      const htmlDownload=await htmlDownloadPromise;assert.match(htmlDownload.suggestedFilename(),/Navigation\.html$/);
      const stream=await htmlDownload.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
      const exportedHtml=Buffer.concat(chunks).toString('utf8');assert.match(exportedHtml,/<!doctype html/i);
      assert(!exportedJulia.includes(secret)&&!exportedHtml.includes(secret),'Exported notebook artifacts contain no session credential');
      const embedded=exportedHtml.match(/data:text\/julia;charset=utf-8;base64,([A-Za-z0-9+/=]+)/);assert(embedded,'The actual HTML download includes its original Julia notebook');
      assert.match(Buffer.from(embedded[1],'base64').toString('utf8'),/4 \+ 5/);
      await homepage();
      // Real programmatic FilePicker navigation, both native submission paths.
      for(const enter of [false,true]){
        const input=frame.locator('#new .cm-content');await input.fill(notebook);
        if(enter)await input.press('Enter');else await frame.locator('#new pluto-filepicker button').click();
        await frame.locator('pluto-notebook').waitFor();authenticated();await homepage();
      }
      // Pluto's GET /new redirect and actual modified anchor navigation.
      const link=frame.locator('#recent li.new a');
      const popupPromise=page.context().waitForEvent('page');await link.click({modifiers:[process.platform==='darwin'?'Meta':'Control']});
      const popup=await popupPromise;await popup.waitForURL(url=>url.pathname==='/edit'&&url.searchParams.get('secret')===secret);await popup.locator('pluto-notebook').waitFor();
      await link.click();await frame.locator('pluto-notebook').waitFor();authenticated();const mainNotebook=new URL(frame.url()).searchParams.get('id');await homepage();
      const workerPid=async(surface,name)=>{
        const file=path.join(root,name),editor=surface.locator('pluto-cell pluto-input .cm-editor:not(.cm-ssr-fake) .cm-content[contenteditable="true"]').first();
        await editor.fill(`write(${JSON.stringify(file)},string(getpid()));getpid()`);await editor.press('Escape');await editor.press('ControlOrMeta+Enter');
        return eventual(async()=>{const value=await readFile(file,'utf8').catch(()=>undefined);return value?Number(value):false;},'A real second notebook evaluates and publishes its worker PID');
      };
      const popupPid=await workerPid(popup,'popup.pid');
      const activeNew=frame.locator(`#recent li.running a[href*="id=${mainNotebook}"]`);
      await activeNew.click();await frame.locator('pluto-notebook').waitFor();
      const mainPid=await workerPid(frame,'main.pid');assert.notEqual(mainPid,popupPid);await homepage();
      await frame.evaluate(()=>{window.__perfcheckerTestConfirm=window.confirm;});
      const running=frame.locator('#recent li.running').filter({hasText:'Navigation.jl'});await running.locator('button').first().click();
      const confirmation=frame.getByRole('dialog',{name:'Pluto confirmation'});
      await confirmation.waitFor();
      assert.equal(await confirmation.locator('p').innerText(),'Terminer le processus du notebook ?');
      await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();
      assert.equal(await running.count(),1);assert(alive(originalPid),'Cancelling the actual confirmation preserves the running worker');
      assert(await frame.evaluate(()=>window.confirm===window.__perfcheckerTestConfirm));
      // A real pending dialog must not authorize a row whose notebook identity
      // changed or whose DOM node was replaced while the question was open.
      await running.locator('button').first().click();await confirmation.waitFor();
      const originalLink=await running.locator('a[href]').getAttribute('href');
      await running.locator('a[href]').evaluate((link,id)=>{const url=new URL(link.href);url.searchParams.set('id',id);link.href=url.href;},mainNotebook);
      await confirmation.getByRole('button',{name:'Confirm',exact:true}).click();
      assert(alive(originalPid)&&alive(mainPid)&&alive(popupPid),'A changed notebook ID is never approved by the pending dialog');
      await running.locator('a[href]').evaluate((link,href)=>link.setAttribute('href',href),originalLink);
      await running.locator('button').first().click();await confirmation.waitFor();
      await running.evaluate(row=>{window.__perfcheckerTestRow=row;row.replaceWith(row.cloneNode(true));});
      await confirmation.getByRole('button',{name:'Confirm',exact:true}).click();
      assert(alive(originalPid)&&alive(mainPid)&&alive(popupPid),'A replaced native Recent row cannot replay the detached stock handler');
      await running.evaluate(row=>{row.replaceWith(window.__perfcheckerTestRow);delete window.__perfcheckerTestRow;});
      await running.locator('button').first().click();await confirmation.waitFor();await confirmation.press('Escape');
      assert(alive(originalPid),'Escape cancels the actual modal without shutting down the notebook');
      await running.locator('button').first().click();await confirmation.waitFor();
      await confirmation.getByRole('button',{name:'Confirm',exact:true}).click();
      assert(await frame.evaluate(()=>window.confirm===window.__perfcheckerTestConfirm));
      await frame.evaluate(()=>{delete window.__perfcheckerTestConfirm;});
      await running.waitFor({state:'detached'});assert.equal((await fetch(`http://127.0.0.1:${port}/?secret=${secret}`)).status,200);
      await eventual(()=>!alive(originalPid),'Actual homepage Shutdown terminates its own Malt worker before harness cleanup',45000);
      assert(await frame.locator('#recent li.running').count()>=2,'Multiple actual notebooks still run before owned Close');
      assert(alive(mainPid)&&alive(popupPid),'Two distinct real Malt workers are alive before Close');
      await closeOwned();await eventual(()=>!alive(mainPid)&&!alive(popupPid),'Both real Malt workers disappear before harness process kills',45000);await popup.close();
    });
  }finally{await browser?.close();await rm(root,{recursive:true,force:true});}
});

test('embedded Pluto preserves authenticated internal links without forwarding its session secret elsewhere',{
  skip:!process.env.PERFCHECKER_BROWSER_TESTS,
},async()=>{
  const require=createRequire(import.meta.url),{chromium}=require(process.env.PERFCHECKER_PLAYWRIGHT||'playwright');
  const script=await readFile(new URL('../media/pluto-navigation.js',import.meta.url),'utf8');
  const module=`data:text/javascript;base64,${Buffer.from(script).toString('base64')}`;
  const secret='isolated-navigation-test',requests=[];
  const server=createServer((request,response)=>{
    const url=new URL(request.url,'http://127.0.0.1');requests.push({path:url.pathname,authenticated:url.searchParams.get('secret')===secret});
    response.setHeader('content-type','text/html');
    if(url.pathname==='/host'){response.end(`<iframe src="http://127.0.0.1:${server.address().port}/edit?id=notebook&secret=${secret}${url.searchParams.has('baseline')?'&baseline=1':''}"></iframe>`);return;}
    if(url.searchParams.get('secret')!==secret){response.statusCode=403;response.end('Not yet authenticated');return;}
    response.end(`<a id="logo" href="./"><span>Pluto</span></a><a id="recent" href="edit?id=notebook">Recent notebook</a>
      <a id="external" href="https://external.invalid/edit?id=other">External</a>
      <a id="download" href="edit?id=notebook" download>Download</a><a id="hash" href="#cell">Cell</a>
      <a id="asset" href="asset.js">Asset</a><a id="existing" href="edit?id=other&secret=explicit">Explicit</a>
      ${url.searchParams.has('baseline')?'':`<script type="module">import environment from '${module}';environment();environment();</script>`}`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({...(process.env.PERFCHECKER_BROWSER?{executablePath:process.env.PERFCHECKER_BROWSER}:{}),headless:true,args:['--no-sandbox']});
    const page=await browser.newPage();
    await page.goto(`http://localhost:${server.address().port}/host?baseline=1`);
    let baseline=page.frames().find(item=>item.parentFrame());
    await baseline.locator('#logo').click();
    await baseline.getByText('Not yet authenticated',{exact:true}).waitFor();
    assert(requests.some(item=>item.path==='/'&&!item.authenticated),'The unadapted internal link reproduces the lost authentication');
    const positiveStart=requests.length;
    await page.goto(`http://localhost:${server.address().port}/host`);
    let frame=page.frames().find(item=>item.parentFrame());
    await frame.locator('[data-perfchecker-navigation="ready"]').waitFor({state:'attached'});
    for(const [id,expected]of [['external','https://external.invalid/edit?id=other'],['download','edit?id=notebook'],['hash','#cell'],['asset','asset.js'],['existing',`http://127.0.0.1:${server.address().port}/edit?id=other&secret=explicit`]]){
      const href=await frame.locator(`#${id}`).evaluate(element=>{
        element.addEventListener('click',event=>event.preventDefault(),{once:true});element.click();return element.getAttribute('href');
      });
      assert.equal(href,expected,`The ${id} link does not acquire or overwrite the current session secret`);
    }
    await frame.locator('#logo span').click();
    await frame.waitForURL(url=>url.pathname==='/'&&url.searchParams.get('secret')===secret);
    await frame.locator('[data-perfchecker-navigation="ready"]').waitFor({state:'attached'});
    await frame.locator('#recent').click();
    await frame.waitForURL(url=>url.pathname==='/edit'&&url.searchParams.get('id')==='notebook'&&url.searchParams.get('secret')===secret);
    assert(requests.slice(positiveStart).filter(item=>item.path==='/'||item.path==='/edit').every(item=>item.authenticated),
      'Logo and Recent perform authenticated HTTP navigation inside a cross-site iframe');
  }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('Pluto requires explicit installation, a trusted workspace and a native notebook',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'perfchecker-pluto-boundaries-'));
  const uri=file=>({scheme:'file',fsPath:file,toString:()=>`file://${file}`});
  const folder={name:'fixture',uri:uri(root)},messages=[],scopes=[],values=new Map();
  const disposable=()=>({dispose(){}});
  const vscode={env:{openExternal:async()=>false},workspace:{isTrusted:true,workspaceFolders:[folder],getWorkspaceFolder:source=>source.fsPath.startsWith(root+path.sep)?folder:undefined,
    getConfiguration:(_name,scope)=>{scopes.push(scope);return{get:(key,fallback)=>values.has(key)?values.get(key):fallback};},onDidChangeWorkspaceFolders:disposable},
    Uri:{file:uri,joinPath:(base,...pieces)=>uri(path.join(base.fsPath,...pieces)),parse:value=>({toString:()=>value})},ViewColumn:{One:1},
    window:{createOutputChannel:()=>({append(){},appendLine(){},dispose(){}}),
      showWarningMessage:async message=>{messages.push(message);return undefined;}},
  };
  const original=Module._load;
  Module._load=function(name,...args){return name==='vscode'?vscode:original.call(this,name,...args);};
  let PlutoNotebooks;try{({PlutoNotebooks}=createRequire(import.meta.url)('../dist/plutoNotebook.js'));}finally{Module._load=original;}
  const context={subscriptions:[],extensionUri:uri(root)},pluto=new PlutoNotebooks(context);
  try{
    const notebook=uri(path.join(root,'perf','notebooks','case.jl'));
    assert.equal(await pluto.create(notebook,{kind:'suite'}),undefined);
    assert.equal(messages.length,1,'No package manager runs before the installation choice');
    assert.match(messages[0],/own Julia environment.*perf.*pluto/);
    assert.deepEqual(await readdir(root),[],'Declining setup creates neither an environment nor a notebook');
    vscode.workspace.isTrusted=false;
    await assert.rejects(pluto.create(notebook,{kind:'suite'}),/Trust/);
    assert.equal(messages.length,1);
    vscode.workspace.isTrusted=true;
    await assert.rejects(pluto.create(uri(path.join(os.tmpdir(),'foreign.pluto.jl')),{kind:'suite'}),/inside an open workspace/);
    await assert.rejects(pluto.create(notebook,{kind:'unknown'}),/Choose a suite or investigation/);
    await mkdir(path.join(root,'perf'),{recursive:true});
    await writeFile(path.join(root,'perf','ordinary.jl'),'println("Julia source")\n');
    await assert.rejects(pluto.open(uri(path.join(root,'perf','ordinary.jl'))),/Choose a Pluto .jl notebook/);
    await writeFile(path.join(root,'perf','existing.jl'),'### A Pluto.jl notebook ###\n');
    await assert.rejects(pluto.create(uri(path.join(root,'perf','existing.jl')),{kind:'suite'}),/already exists/);
    assert.equal(messages.length,1,'Invalid files never start environment setup');
    assert(scopes.every(scope=>scope.toString()===folder.uri.toString()));
    const server=createServer((request,response)=>{
      const query=new URL(request.url,'http://localhost').searchParams;
      response.statusCode=query.get('secret')==='isolated-test-secret' ? 200 : 403;
      response.end();
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const address=server.address(),url=`http://127.0.0.1:${address.port}/edit?id=test-notebook&secret=isolated-test-secret`;
      // This is VS Code URI's documented serialization of a query component.
      const forwarded={toString:skipEncoding=>skipEncoding?url:`http://127.0.0.1:${address.port}/edit?${encodeURIComponent('id=test-notebook&secret=isolated-test-secret')}`};
      assert.equal((await fetch(forwarded.toString())).status,403,'The previous URI encoding loses authenticated query parameters');
      const panel={webview:{}};
      pluto.render({panel},forwarded);
      const source=/src="([^"]+)"/.exec(panel.webview.html)[1].replaceAll('&amp;','&');
      assert.equal((await fetch(source)).status,200,'The rendered iframe carries the original authentication parameters');
      assert.equal(new URL(source).searchParams.get('id'),'test-notebook');
    }finally{await new Promise(resolve=>server.close(resolve));}

    const project=path.join(root,'perf','pluto'),suite=path.join(root,'perf','suite.jl');
    await writeFile(suite,'using PerfChecker\n');
    const originalEnsure=pluto.ensureEnvironment,originalCommand=pluto.command,originalOpen=pluto.openFile;
    // Isolate the asynchronous file/settings boundary; the native campaign tests
    // the real generator/server separately rather than claiming that here.
    pluto.ensureEnvironment=async()=>project;
    pluto.command=async()=>`PERFCHECKER_PLUTO_NOTEBOOK ${Buffer.from('### A Pluto.jl notebook ###\n').toString('base64')}\n`;
    pluto.openFile=async(_folder,file)=>uri(file);
    const nativeFs=createRequire(import.meta.url)('node:fs').promises,originalStat=nativeFs.stat;
    let changed=false;
    nativeFs.stat=async(file,...args)=>{
      const result=await originalStat(file,...args);
      if(file===suite&&!changed){changed=true;values.set('profile','changed-during-generation');}
      return result;
    };
    const stale=path.join(root,'perf','notebooks','stale.jl');
    try{
      await assert.rejects(pluto.create(uri(stale),{kind:'suite'}),/settings changed|configuration changed/i);
      assert.equal(await originalStat(stale).then(()=>true).catch(()=>false),false,'Stale generation cannot leave a notebook on disk');
    }finally{nativeFs.stat=originalStat;pluto.ensureEnvironment=originalEnsure;pluto.command=originalCommand;pluto.openFile=originalOpen;}

    // Stop owns the old session even after a user selects another environment.
    // Exercise the real dedicated pipe and process exit, not a mocked stop().
    const {controllerCancellation}=createRequire(import.meta.url)('../dist/controllerCancellation.js');
    const marker=path.join(root,'stopped-session.json');
    let messageHandler,owned;const originalStart=pluto.start;
    const panel={webview:{onDidReceiveMessage:handler=>{messageHandler=handler;return disposable();}},onDidDispose:disposable,reveal(){},dispose(){}};
    vscode.window.createWebviewPanel=()=>panel;
    pluto.start=async session=>{
      owned=session;
      const child=spawn(process.execPath,['-e',`process.stdout.write('ready\\n');process.stdin.on('data',async input=>{if(input.toString().includes('PERFCHECKER_CANCEL/1')){require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,cleaned:true}));process.exit(0);}});`,marker],{stdio:['pipe','pipe','pipe']});
      session.child=child;session.cancel=controllerCancellation(child,()=>{});
      session.stopped=once(child,'close').then(()=>{});
      await once(child.stdout,'data');
    };
    try{
      await pluto.openFile(folder,path.join(root,'perf','existing.jl'),project);
      const oldPid=owned.child.pid;
      const launches=[];vscode.env.openExternal=async value=>{launches.push(value.toString());return true;};
      const base='http://127.0.0.1:12345/edit?id=owned&secret=owned-test-secret';
      owned.popupCapability='owned-test-capability';
      const reset=()=>pluto.render(owned,{toString:()=>base});
      for(const message of [
        {capability:'wrong',url:base},
        {capability:owned.popupCapability,url:base.replace('owned-test-secret','wrong')},
        {capability:owned.popupCapability,url:base.replace('127.0.0.1','external.invalid')},
        {capability:owned.popupCapability,url:base.replace('/edit','/frontend/common/Environment.js')},
        {capability:owned.popupCapability,url:base.replace('http:','https:')},
      ]){reset();await messageHandler({type:'plutoPopup',...message});}
      assert.equal(launches.length,0,'The actual registered host handler rejects foreign origins, credentials, routes and capabilities before the browser API');
      for(const route of ['/notebookfile','/notebookexport','/new']){
        reset();await messageHandler({type:'plutoPopup',capability:owned.popupCapability,url:base.replace('/edit',route)});
      }
      assert.equal(launches.length,3,'The owned live session delegates only its authenticated export/new-context routes');
      values.set('plutoProject','perf/another-pluto');
      await messageHandler({type:'plutoStop'});
      const cleaned=await readFile(marker,'utf8').then(JSON.parse).catch(()=>undefined);
      assert.equal(cleaned?.cleaned,true,'Changing plutoProject must not disable the old session Stop button');
      assert.equal(cleaned.pid,oldPid);
      assert.equal(owned.child.exitCode,0,'The owned process finished before fixture cleanup');
      assert.match(panel.webview.html,/Session stopped/);
      await messageHandler({type:'plutoPopup',capability:'owned-test-capability',url:base});
      assert.equal(launches.length,3,'A stopped or invalidated session cannot launch a browser');
      await messageHandler({type:'plutoRestart'});
      assert.match(panel.webview.html,/environment changed/i,'Restart still validates the configured environment');
    }finally{
      owned?.cancel?.request();await owned?.stopped;
      values.delete('plutoProject');pluto.start=originalStart;
    }
  }finally{pluto.dispose();context.subscriptions.forEach(item=>item.dispose());await rm(root,{recursive:true,force:true});}
});
