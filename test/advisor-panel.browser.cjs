// npm install --no-save playwright; npx playwright install chromium
// PERFCHECKER_PLAYWRIGHT_MODULE and PERFCHECKER_BROWSER may select existing test runtimes.
const {chromium} = require(process.env.PERFCHECKER_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.PERFCHECKER_BROWSER ? {executablePath:process.env.PERFCHECKER_BROWSER} : {})});
  const page = await browser.newPage({viewport:{width:1200,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
  try {
    await page.setContent('<!doctype html><html lang="fr"><body><main id="advisor-root"></main></body></html>');
    await page.addStyleTag({path:path.join(__dirname,'../media/investigation.css')});
    await page.addStyleTag({path:path.join(__dirname,'../media/advisor-panel.css')});
    await page.addScriptTag({path:path.join(__dirname,'../media/advisor-panel.js')});
    await page.evaluate(()=>{
      globalThis.requests=[];
      globalThis.panel=mountAdvisorPanel(document.getElementById('advisor-root'),m=>requests.push(m),{enabled:false,config:{}});
    });
    assert.equal((await page.evaluate(()=>requests)).length,0);
    assert.ok(await page.getByRole('button',{name:'Tester la connexion / découvrir',exact:true}).isDisabled());
    await page.locator('#advisor-protocol').selectOption('ollama');
    await page.getByRole('button',{name:'Tester la connexion / découvrir',exact:true}).click();
    assert.equal((await page.evaluate(()=>requests))[0].action,'probe');
    assert.ok(await page.locator('#advisor-endpoint').isDisabled());
    await page.evaluate(()=>panel.receive({type:'advisorResult',result:{status:'complete',models:[{name:'tiny:latest',size_bytes:500000000}]}}));
    assert.ok(await page.getByText('0.500 Go déclarés par le serveur',{exact:true}).isVisible());
    await page.getByRole('button',{name:'Supprimer du disque…',exact:true}).click();
    assert.equal((await page.evaluate(()=>requests)).length,1);
    await page.getByRole('button',{name:'Revenir',exact:true}).click();
    assert.equal((await page.evaluate(()=>requests)).length,1);
    await page.getByRole('button',{name:'Supprimer du disque…',exact:true}).click();
    await page.locator('#advisor-endpoint').fill('http://127.0.0.1:12345/api/chat');
    assert.ok(await page.getByRole('button',{name:'Confirmer',exact:true}).isHidden());
    assert.equal(await page.getByRole('button',{name:'Supprimer du disque…',exact:true}).count(),0);
    await page.locator('#advisor-download-model').fill('tiny:latest');
    await page.getByRole('button',{name:'Télécharger ce modèle…',exact:true}).click();
    await page.getByRole('button',{name:'Confirmer',exact:true}).click();
    let last=await page.evaluate(()=>requests.at(-1)); assert.equal(last.action,'pull'); assert.equal(last.confirmed,true); assert.equal(last.model,'tiny:latest');
    await page.getByRole('button',{name:'Annuler l’opération',exact:true}).click();
    assert.equal((await page.evaluate(()=>requests.at(-1))).type,'advisorCancel');
    await page.evaluate(()=>panel.receive({type:'advisorResult',result:{status:'cancelled',message:'Cancelled'}}));
    await page.locator('#advisor-protocol').selectOption('mcp_http');
    await page.getByRole('button',{name:'Tester la connexion / découvrir',exact:true}).click();
    await page.evaluate(()=>panel.receive({type:'advisorResult',result:{status:'complete',tools:[{name:'ask',description:'<script>globalThis.injected=true</script>',inputSchema:{required:['question'],properties:{question:{type:'string'}}}}]}}));
    await page.getByRole('button',{name:'Utiliser',exact:true}).click();
    assert.equal(await page.locator('#advisor-mcp_tool').inputValue(),'ask');
    assert.equal(await page.locator('#advisor-mcp_prompt_argument').inputValue(),'question');
    assert.equal(await page.evaluate(()=>globalThis.injected),undefined);
    assert.equal(await page.locator('#advisor-root script').count(),0);
    await page.locator('#advisor-investigates').check();
    const count=(await page.evaluate(()=>requests)).length;
    await page.getByRole('button',{name:'Enregistrer la configuration',exact:true}).click();
    assert.equal((await page.evaluate(()=>requests)).length,count);
    assert.ok(await page.getByRole('status').filter({hasText:'nécessite une réponse structurée'}).isVisible());
    await page.locator('#advisor-mcp_response').selectOption('structured');
    await page.locator('#advisor-instructions').fill('Préserver l’API.');
    await page.getByRole('button',{name:'Enregistrer la configuration',exact:true}).click();
    last=await page.evaluate(()=>requests.at(-1)); assert.equal(last.config.instructions,'Préserver l’API.'); assert.equal(last.investigates,true);
    await page.evaluate(()=>panel.receive({type:'advisorResult',result:{status:'complete',message:'Saved'}}));
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
    console.log('Advisor panel browser checks passed: idle, provider choice, inventory, explicit mutations, cancellation, stale selection, MCP arguments, escaping, investigation contract, persistence payload and narrow layout.');
  } finally {await browser.close();}
})();
