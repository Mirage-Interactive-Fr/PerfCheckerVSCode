const {chromium}=require(process.env.PERFCHECKER_PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises'),os=require('node:os');
const {captureConversationReply}=require('./codex-vscode-host.cjs');
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--disable-gpu','--disable-software-rasterizer'],...(process.env.PERFCHECKER_BROWSER?{executablePath:process.env.PERFCHECKER_BROWSER}:{})});
  const page=await browser.newPage({viewport:{width:1250,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  const state={type:'chatState',workspace:'Julia demo',messages:[],evidence:[{id:'safe',label:'Saved evidence'},
    {id:'suite:workspace-run',label:'Suite · saved measured run'},
    {id:'suite-unavailable:workspace',label:'Suite evidence unavailable · Missing integrity',unavailable:true}],
    evidenceId:'',pending:'',busy:false,status:'Ready',implementation:{tool:'implement',promptArgument:'prompt',workspaceArgument:'workspace'}};
  try {
    await page.setContent('<!doctype html><html lang="en"><body><main id="chat-root"></main></body></html>');
    await page.addStyleTag({path:path.join(__dirname,'../media/advisor-chat.css')});
    await page.addScriptTag({path:path.join(__dirname,'../media/advisor-chat.js')});
    await page.evaluate(()=>{globalThis.requests=[];globalThis.panel=mountAdvisorChat(document.getElementById('chat-root'),message=>requests.push(message));});
    await page.evaluate(value=>panel.receive(value),state);
    assert.equal((await page.evaluate(()=>requests)).length,0);
    assert.equal(await page.locator('select[aria-label="Attach saved evidence"] option[value="suite-unavailable:workspace"]').evaluate(option=>option.disabled),true);
    await page.getByRole('combobox',{name:'Attach saved evidence',exact:true}).selectOption('suite:workspace-run');
    assert.deepEqual(await page.evaluate(()=>requests.at(-1)),{type:'chatClear',evidenceId:'suite:workspace-run'});
    state.evidenceId='suite:workspace-run';
    await page.locator('summary').filter({hasText:'Optional Codex CLI connector'}).click();
    await page.getByRole('button',{name:'Connect Codex CLI',exact:true}).click();
    assert.equal((await page.evaluate(()=>requests.at(-1))).type,'chatConnectCodex');
    state.connection='codex-cli 0.159.2 · local connector';await page.evaluate(value=>panel.receive(value),state);
    assert.ok(await page.getByRole('button',{name:'Connect Codex CLI',exact:true}).isHidden());
    await page.getByRole('button',{name:'Disconnect Codex',exact:true}).click();
    assert.equal((await page.evaluate(()=>requests.at(-1))).type,'chatDisconnectCodex');
    delete state.connection;await page.evaluate(value=>panel.receive(value),state);
    await page.getByRole('textbox',{name:'Ask about configuration'}).fill('How can I reduce allocations?');
    await page.getByRole('textbox',{name:'Ask about configuration'}).press('Control+Enter');
    assert.equal((await page.evaluate(()=>requests.at(-1))).type,'chatSend');
    assert.equal((await page.evaluate(()=>requests.at(-1))).evidenceId,'suite:workspace-run');
    assert.ok(await page.getByRole('button',{name:'Send question',exact:true}).isDisabled());
    await page.getByRole('button',{name:'Cancel request',exact:true}).click();
    assert.equal((await page.evaluate(()=>requests.at(-1))).type,'chatCancel');
    state.messages=[{role:'user',content:'How can I reduce allocations?'},{role:'assistant',content:'<script>globalThis.injected=true</script>\nPreserve correctness.'}];
    await page.evaluate(value=>panel.receive(value),state);
    assert.equal(await page.evaluate(()=>globalThis.injected),undefined); assert.equal(await page.locator('#chat-root script').count(),0);
    assert.equal(await page.getByRole('textbox',{name:'Ask about configuration'}).inputValue(),'');
    await page.getByRole('tab',{name:'01 · Advice',exact:true}).focus();
    await page.getByRole('tab',{name:'01 · Advice',exact:true}).press('ArrowRight');
    assert.equal(await page.getByRole('tab',{name:'02 · Implementation',exact:true}).getAttribute('aria-selected'),'true');
    assert.ok(await page.getByRole('textbox',{name:'Ask about configuration'}).isHidden());
    await page.getByText('Latest advice to implement',{exact:true}).click();
    assert.ok(await page.locator('#chat-implementation').getByText('Preserve correctness.',{exact:false}).isVisible());
    const before=(await page.evaluate(()=>requests)).length;
    await page.getByRole('button',{name:'I reviewed the advice · Prepare implementation',exact:true}).click();
    assert.equal((await page.evaluate(()=>requests.at(-1))).type,'chatImplement');
    assert.equal((await page.evaluate(()=>requests)).length,before+1);
    assert.ok(await page.locator('.proposal').isHidden());
    state.proposal={patch:'diff --git a/x.jl b/x.jl\n- old\n+ new <img onerror="globalThis.injected=true">',files:['x.jl'],applied:false}; state.backupRef='refs/perfchecker/checkpoints/test';
    state.implementationSummary='Prepared changes. <script>still plain text</script>';
    await page.evaluate(value=>panel.receive(value),state);
    await page.getByRole('button',{name:'Apply reviewed changes',exact:true}).click();
    assert.equal((await page.evaluate(()=>requests.at(-1))).type,'chatApply');
    state.proposal.applied=true; await page.evaluate(value=>panel.receive(value),state);
    await page.getByRole('button',{name:'Restore previous code',exact:true}).click();
    assert.equal((await page.evaluate(()=>requests.at(-1))).type,'chatRestore');
    await page.evaluate(value=>panel.receive(value),state);
    await page.getByText('Configure the MCP implementation tool',{exact:true}).click();
    await page.getByRole('textbox',{name:'Implementation tool name',exact:true}).fill('implement_code');
    await page.getByRole('button',{name:'Save implementation tool',exact:true}).click();
    assert.equal((await page.evaluate(()=>requests.at(-1))).tool,'implement_code');
    // Control fixtures exercise the same native-wheel capture routine used by
    // the authenticated host, against the actual product JS/CSS unchanged.
    await page.getByRole('tab',{name:'01 · Advice',exact:true}).click();
    const user=Array.from({length:90},(_,i)=>`Source context line ${i+1}`).join('\n');
    const reply=Array.from({length:65},(_,i)=>`Advice paragraph ${i+1}: preserve exact output and independent evidence.`).join('\n');
    state.messages=[{role:'user',content:user},{role:'assistant',content:reply}];
    await page.evaluate(value=>panel.receive(value),state);
    const view={locator:selector=>page.locator(selector),page:()=>page};
    const capture=async(_part,geometry)=>{
      const png=await page.screenshot();
      assert.equal(png.subarray(12,16).toString(),'IHDR');
      assert.equal(png.readUInt32BE(16),1250);assert.equal(png.readUInt32BE(20),1000);
      assert(geometry.end>geometry.start,'Each retained section exposes actual reply text');
    };
    for(const direction of ['below','above']){
      const record={parts:[],wheels:[],complete:false};
      await captureConversationReply(view,record,capture);
      assert.equal(record.complete,true);assert(record.parts.length>=3,'The long reply requires overlapping native captures');
      assert(direction==='below'?record.initial.replyTop>record.initial.visibleBottom:record.initial.start>0);
      assert.equal(Math.sign(record.wheels[0].delta),direction==='below'?1:-1);
      for(const action of record.wheels)assert(Math.sign(action.delta)*(action.after.scrollTop-action.before.scrollTop)>0);
      for(let i=1;i<record.parts.length;i++)assert(record.parts[i].start<record.parts[i-1].end,'Captured sections overlap');
      assert.equal(await page.locator('.message.assistant .message-text').innerText(),reply);
      assert.equal(await page.locator('.message.user .message-text').innerText(),user);
    }
    state.messages=[{role:'user',content:'Short context'},{role:'assistant',content:'Complete short reply.'}];
    await page.evaluate(value=>panel.receive(value),state);
    const short={parts:[],wheels:[],complete:false};await captureConversationReply(view,short,capture);
    assert.equal(short.parts.length,1);assert.equal(short.wheels.length,0);assert.equal(short.complete,true);
    // Chromium's native default zoom uses the same level 2.75 as the private
    // VS Code host (~1.651). This required disposable browser profile changes
    // neither the product CSS nor its messages and never uses a human profile.
    // Chromium ChromeZoomLevelPrefs: the default partition's key is "x".
    const zoomProfile=await fs.mkdtemp(path.join(os.tmpdir(),'perfchecker-chat-zoom-'));
    let zoomContext;
    try{
      await fs.mkdir(path.join(zoomProfile,'Default'));
      await fs.writeFile(path.join(zoomProfile,'Default','Preferences'),JSON.stringify({partition:{default_zoom_level:{x:2.75}}}));
      zoomContext=await chromium.launchPersistentContext(zoomProfile,{headless:true,channel:'chromium',
        viewport:{width:1250,height:1000},deviceScaleFactor:1,args:['--disable-gpu','--disable-software-rasterizer'],
        ...(process.env.PERFCHECKER_BROWSER?{executablePath:process.env.PERFCHECKER_BROWSER}:{})});
      const zoomPage=zoomContext.pages()[0];
      zoomPage.on('pageerror',error=>errors.push(String(error)));
      await zoomPage.route('https://perfchecker.test/**',route=>route.fulfill({contentType:'text/html',
        body:'<!doctype html><html lang="en"><body><main id="chat-root"></main></body></html>'}));
      await zoomPage.goto('https://perfchecker.test/advice');
      const nativeZoom=await zoomPage.evaluate(()=>devicePixelRatio);
      assert(Math.abs(nativeZoom-Math.pow(1.2,2.75))<.01,'The regression actually applies Chromium native zoom, not a CSS transform');
      await zoomPage.addStyleTag({path:path.join(__dirname,'../media/advisor-chat.css')});
      await zoomPage.addScriptTag({path:path.join(__dirname,'../media/advisor-chat.js')});
      await zoomPage.evaluate(()=>{globalThis.panel=mountAdvisorChat(document.getElementById('chat-root'),()=>{});});
      const longUser=Array.from({length:220},(_,i)=>`Source context ${i+1}: preserve every recorded field and its original separator, Unicode and provenance.`).join('\n');
      const zoomReply=Array.from({length:40},(_,i)=>`Advice ${i+1}: use the independent literal oracle before applying changes.`).join('\n');
      await zoomPage.evaluate(value=>panel.receive(value),{...state,messages:[{role:'user',content:longUser},{role:'assistant',content:zoomReply}]});
      const zoomRecord={parts:[],wheels:[],complete:false};
      await captureConversationReply({locator:selector=>zoomPage.locator(selector),page:()=>zoomPage},zoomRecord,async(_part,g)=>{
        const png=await zoomPage.screenshot();assert.equal(png.subarray(12,16).toString(),'IHDR');assert(g.end>g.start);
      });
      assert(zoomRecord.initial.replyTop>zoomRecord.initial.visibleBottom+5000,'The native zoom fixture includes the long source passage before the reply');
      assert(zoomRecord.wheels.length>=2,'Observed native displacement requires convergence rather than one assumed jump');
      assert(zoomRecord.wheels.some(action=>Math.abs(action.delta/(action.after.scrollTop-action.before.scrollTop)-nativeZoom)<.02),
        'The real native wheel exposes the input/CSS coordinate mismatch observed in R10');
      assert.equal(zoomRecord.complete,true);assert(zoomRecord.parts.length<=8);
      for(let i=1;i<zoomRecord.parts.length;i++)assert(zoomRecord.parts[i].start<zoomRecord.parts[i-1].end);
      assert.equal(await zoomPage.locator('.message.user .message-text').innerText(),longUser);
      assert.equal(await zoomPage.locator('.message.assistant .message-text').innerText(),zoomReply);
    }finally{await zoomContext?.close();await fs.rm(zoomProfile,{recursive:true,force:true});}
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]); assert.equal(await page.evaluate(()=>globalThis.injected),undefined);
    console.log('Chat browser checks passed: requests, keyboard tabs, cancellation, text escaping, diff review, apply/restore, configuration, complete native-wheel reply coverage and mobile width.');
  } finally {await browser.close();}
})();
