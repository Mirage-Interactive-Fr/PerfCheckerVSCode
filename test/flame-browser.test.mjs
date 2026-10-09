import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {flameGraph,flameChartScript,flameChartStyle} from '../dist/flame-plot.js';

const observation=(stack,value,attributes={})=>({case_id:'browser-controls-fixture',target_id:'fixture',
  metric:'julia.profile.samples',measurement_definition:'profile-fixture',unit:'1',value,attributes:{stack,...attributes}});

test('the production flame renderer exposes thin, coincident and deep frames at phone width',{
  skip:!process.env.PERFCHECKER_BROWSER_TESTS,
},async t=>{
  const require=createRequire(import.meta.url),{chromium}=require(process.env.PERFCHECKER_PLAYWRIGHT||'playwright');
  const browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.PERFCHECKER_BROWSER?{executablePath:process.env.PERFCHECKER_BROWSER}:{})});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true}),errors=[];
    page.on('pageerror',error=>errors.push(String(error)));
    const capture=async(name,locator)=>{if(process.env.PERFCHECKER_QA_DIR){await mkdir(process.env.PERFCHECKER_QA_DIR,{recursive:true});
      await locator.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.PERFCHECKER_QA_DIR,`module-fixture-phone-${name}.png`)});}};
    const exactGeometry=async graph=>{
      const geometry=await graph.evaluate(node=>{const model=JSON.parse(node.dataset.flame),svg=node.querySelector('svg'),width=svg.viewBox.baseVal.width;
        const from=Number(svg.dataset.currentMin),to=Number(svg.dataset.currentMax);
        return [...svg.querySelectorAll('.flame-node')].map(group=>{const saved=model.frames[Number(group.dataset.frameIndex)-1],rect=group.querySelector('rect');
          return {x:Number(rect.getAttribute('x')),width:Number(rect.getAttribute('width')),
            expectedX:(saved.x0-from)*width/(to-from),expectedWidth:(saved.x1-saved.x0)*width/(to-from)};});});
      assert(geometry.every(frame=>Math.abs(frame.x-frame.expectedX)<1e-8&&Math.abs(frame.width-frame.expectedWidth)<1e-8));
      return geometry;
    };
    const install=async rows=>{
      const markup=flameGraph(rows,'fixture-detail'),started=performance.now();
      // The fixture supplies host colors only; DOM, geometry and handlers are the production module.
      await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        :root{--vscode-editor-background:#1f1f1f;--vscode-charts-blue:#3794ff;--vscode-charts-red:#f14c4c;--vscode-charts-purple:#b180d7;--vscode-charts-orange:#cca700;
        --vscode-input-foreground:#ccc;--vscode-input-background:#313131;--vscode-input-border:#555;--vscode-focusBorder:#0078d4}
        *{box-sizing:border-box}body{margin:14px;font:14px Arial;color:#ccc;background:#1f1f1f}.flame-card{min-width:0;background:#181818;padding:12px}
        button{color:white;background:#0078d4;border:0;border-radius:4px}pre{white-space:pre-wrap}
        ${flameChartStyle}</style></head><body><section class="flame-card">${markup}</section><script>${flameChartScript}</script></body></html>`);
      await page.waitForFunction(()=>document.querySelector('svg.flame')?.dataset.currentMax==='1');
      await page.evaluate(()=>document.fonts.ready);
      return {bytes:Buffer.byteLength(markup),elapsedMs:performance.now()-started};
    };
    const rows=[observation(['entry','large'],1e9),...Array.from({length:1805},(_,i)=>observation(['entry',`thin-${i}`],1)),
      observation(['other','large'],4),observation(['dispatch'],3,{runtime_dispatch:[true]}),
      observation(['inference'],2,{inference_status:['abstract']}),observation(['gc'],1,{gc_event:[true]})];
    const large=await install(rows),graph=page.locator('.flame-view'),model=JSON.parse(await graph.getAttribute('data-flame'));
    assert(model.frames.length>1800);assert.equal(await graph.locator('.flame-node').count(),model.frames.length);
    const payload=await graph.getAttribute('data-flame'),index=graph.locator('[data-flame-index]');
    const originalGeometry=await exactGeometry(graph);
    const thin=model.frames.find(frame=>frame.name==='thin-1804');
    await index.fill(String(thin.index));await index.press('Tab');
    assert.match(await graph.locator('.flame-detail').innerText(),/entry → thin-1804/);
    await capture('thin-readout',graph.locator('.flame-detail'));
    assert.equal(await graph.locator(`.flame-node[data-frame-index="${thin.index}"] rect`).getAttribute('width'),String((thin.x1-thin.x0)*await graph.locator('svg').evaluate(svg=>svg.viewBox.baseVal.width)));
    const same=model.frames.find(frame=>frame.name==='large'&&frame.parent&&model.frames[frame.parent-1].name==='other');
    await index.fill(String(same.index));await index.press('Tab');
    assert.match(await graph.locator('.flame-detail').innerText(),/other → large/);
    await graph.getByRole('button',{name:'Zoom in flame graph',exact:true}).tap();
    assert(Number(await graph.locator('svg').getAttribute('data-current-max'))-Number(await graph.locator('svg').getAttribute('data-current-min'))<1);
    const pan=graph.getByRole('button',{name:'Pan flame graph left',exact:true});
    await (await pan.isEnabled()?pan:graph.getByRole('button',{name:'Pan flame graph right',exact:true})).tap();
    await graph.getByRole('button',{name:'Fit all flame frames',exact:true}).tap();
    assert.equal(await graph.locator('svg').getAttribute('data-current-min'),'0');
    assert.equal(await graph.locator('svg').getAttribute('data-current-max'),'1');
    assert.equal(await graph.getAttribute('data-flame'),payload);
    assert.deepEqual(await exactGeometry(graph),originalGeometry);
    await graph.locator('.flame-range summary').tap();
    const start=graph.locator('[data-flame-bound="min"]'),end=graph.locator('[data-flame-bound="max"]');
    await start.fill('10');await end.fill('90');await end.press('Tab');
    const range=await graph.locator('svg').evaluate(svg=>({from:Number(svg.dataset.currentMin),to:Number(svg.dataset.currentMax)}));
    assert(Math.abs(range.from-.1)<=Number.EPSILON*8&&Math.abs(range.to-.9)<=Number.EPSILON*8,JSON.stringify(range));
    assert.equal(await start.inputValue(),'10');assert.equal(await end.inputValue(),'90');
    await exactGeometry(graph);
    await start.fill('12.3456789012345');await start.press('Tab');
    const exactStart=Number('12.3456789012345')/100;
    assert.equal(await start.inputValue(),'12.3456789012');
    await end.fill('89.12345678901234');await end.press('Tab');
    assert.equal(Number(await graph.locator('svg').getAttribute('data-current-min')),exactStart,
      'Editing End must retain the exact numerical Start, independently of its rounded display');
    await exactGeometry(graph);
    await graph.getByRole('button',{name:'Fit all flame frames',exact:true}).tap();
    assert.deepEqual(await exactGeometry(graph),originalGeometry);
    await end.fill('1e-100');await end.press('Tab');
    assert.equal(Number(await graph.locator('svg').getAttribute('data-current-min')),0);
    assert.equal(Number(await graph.locator('svg').getAttribute('data-current-max')),1e-6);
    assert.equal(await end.inputValue(),'0.0001');
    const tinyGeometry=await exactGeometry(graph);
    assert(tinyGeometry.every(frame=>Number.isFinite(frame.x)&&Number.isFinite(frame.width)),
      'A tiny manual End must retain the minimum span and finite SVG geometry');
    await graph.getByRole('button',{name:'Fit all flame frames',exact:true}).tap();
    assert.deepEqual(await exactGeometry(graph),originalGeometry);
    await graph.locator('.flame-range summary').tap();
    await capture('controls',graph.locator('.flame-toolbar'));
    const geometry=await graph.evaluate(node=>({scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,
      overflowing:[...node.querySelectorAll('*')].filter(item=>item.getBoundingClientRect().right>node.getBoundingClientRect().right+1)
        .slice(0,8).map(item=>({tag:item.tagName,class:item.className?.baseVal??item.className,width:item.getBoundingClientRect().width,right:item.getBoundingClientRect().right}))}));
    t.diagnostic(JSON.stringify({phoneGeometry:geometry}));
    assert(geometry.scrollWidth<=geometry.clientWidth);
    assert.equal(await graph.locator('.flame-toolbar button').evaluateAll(buttons=>buttons.every(button=>button.getBoundingClientRect().height>=44)),true);
    const labels=await graph.locator('svg').evaluate(svg=>[...svg.querySelectorAll('.flame-node text')].filter(text=>text.style.display!=='none').map(text=>{
      const rect=text.parentElement.querySelector('rect'),x=Number(rect.getAttribute('x')),width=Number(rect.getAttribute('width'));
      return {length:text.getComputedTextLength(),available:Math.min(svg.viewBox.baseVal.width,x+width)-Math.max(0,x)-8};
    }));assert(labels.length&&labels.every(label=>label.length<=label.available+1e-6));
    const stack=Array.from({length:5000},(_,i)=>`source.jl:${i+1} call_${i}`),deep=await install([observation(stack,7)]);
    const deepGraph=page.locator('.flame-view');assert.equal(await deepGraph.locator('.flame-node').count(),5000);
    await deepGraph.locator('[data-flame-index]').fill('5000');await deepGraph.locator('[data-flame-index]').press('Tab');
    assert((await deepGraph.locator('.flame-detail').innerText()).includes(stack.join(' → ')));
    assert((await deepGraph.locator('.flame-wrap').evaluate(node=>node.scrollTop))>0);
    await capture('deep-readout',deepGraph.locator('.flame-detail'));
    assert.equal(await deepGraph.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    const deepPayload=await deepGraph.getAttribute('data-flame'),deepGeometry=await exactGeometry(deepGraph),gestures={};
    for(const [name,label]of [['zoom','Zoom in flame graph'],['fit','Fit all flame frames']]){
      const started=performance.now();await deepGraph.getByRole('button',{name:label,exact:true}).tap();
      gestures[name]=performance.now()-started;
      await exactGeometry(deepGraph);
    }
    assert.equal(await deepGraph.locator('svg').getAttribute('data-current-min'),'0');
    assert.equal(await deepGraph.locator('svg').getAttribute('data-current-max'),'1');
    assert.equal(await deepGraph.getAttribute('data-flame'),deepPayload,'Deep-stack gestures preserve every original weight and coordinate');
    assert.deepEqual(await exactGeometry(deepGraph),deepGeometry,'Fit restores the exact rendered geometry of all 5000 frames');
    assert.deepEqual(errors,[]);
    t.diagnostic(JSON.stringify({source:'production-flame-module',viewport:390,frames:model.frames.length,large,deepFrames:5000,deep,gesturesMs:gestures,fullPaths:true,realTouchControls:true}));
    assert(large.elapsedMs<60_000&&deep.elapsedMs<60_000,'The complete browser fixtures stay within the qualification budget');
  }finally{await browser.close();}
});
