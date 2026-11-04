import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';

test('guided controls stay readable, submit choices and preserve hostile agent text at desktop and phone widths',{
  skip: !process.env.PERFCHECKER_BROWSER_TESTS,
},async()=>{
  const require=createRequire(import.meta.url),{chromium}=require(process.env.PERFCHECKER_PLAYWRIGHT||'playwright');
  const browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.PERFCHECKER_BROWSER?{executablePath:process.env.PERFCHECKER_BROWSER}:{})});
  try {
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div></body></html>');
    await page.addStyleTag({content:await readFile('media/advisor-workflow.css','utf8')});
    await page.addScriptTag({content:await readFile('media/advisor-workflow.js','utf8')});
    await page.evaluate(()=>{window.sent=[];window.workflow=mountAdvisorWorkflow(document.getElementById('app'),message=>window.sent.push(message));});
    const state={type:'chatState',workspace:'Example',status:'Ready',evidenceId:'saved',evidence:[{id:'saved',label:'Saved execution'}],
      guided:{context:{evidenceId:'saved',results:[{id:'selected',package:'Example',feature:'push',target:'dev',revision:'a'.repeat(40),status:'pass'}]},
        selectedResultIds:['selected'],analysisCurrent:true,analysis:{summary:'<img src=x onerror=alert(1)>',findings:[],suggestions:[
          {id:'one',title:'Try one change',rationale:'A hypothesis.',change:'One selected edit.',checks:['Repeat the check.'],resultIds:['selected']} ]},
        history:{current:'a',nodes:[{id:'a',action:'analysis',title:'Agent analysis',createdAt:'2026-11-04T00:00:00Z',data:{historyMode:'native-fork'}}]}}};
    for(const width of [1440,360]) {
      await page.setViewportSize({width,height:1000});await page.evaluate(state=>workflow.receive(state),state);
      assert.equal(await page.locator('img').count(),0,'Agent text remains literal');
      assert(await page.getByText('Native fork',{exact:true}).isVisible());
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`No horizontal page overflow at ${width}px`);
      await page.getByRole('radio').check();await page.getByRole('button',{name:'Try selected suggestion',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>sent.at(-1)),{type:'workflowTrySuggestion',suggestionId:'one',instructions:''});
      await page.getByRole('button',{name:'Continue from here',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>sent.at(-1)),{type:'workflowContinue',nodeId:'a'});
      await page.evaluate(state=>workflow.receive({...state,busy:true}),state);
      assert(await page.getByRole('button',{name:'Try selected suggestion',exact:true}).isDisabled());
      assert(await page.getByRole('button',{name:'Cancel action',exact:true}).isVisible());
    }
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});
