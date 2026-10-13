import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { startDemo } from '../src/local-demo.js';
import { api, openInvitation } from '../src/approval-client.js';

const app=await startDemo({port:0,writeLaunch:false});let browser;
try {
  browser=await chromium.launch({channel:'msedge',headless:true});
  for(const scenario of ['mode','stages','cleanup']) {
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(app.url+'/#setup='+app.launchToken);
    await page.getByLabel('Signer 1 name').fill('Routing One');
    await page.locator('#add-signer').click();await page.getByLabel('Signer 2 name').fill('Routing Two');
    if(scenario==='stages'){await page.locator('#mode').selectOption('grouped');await page.locator('#stages').fill('1,1');}
    await page.locator('#sample').click();await page.locator('#preview-fields').click();
    await page.getByText('Select a recipient and click a page to place their field.').waitFor();
    for(const id of ['r1','r2']){await page.locator('#field-recipient').selectOption(id);await page.locator('#placement-pages canvas').first().press('Enter');}
    let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let posts=0,stale;
    await page.route('**/api/requests',async route=>{
      posts++;const response=await route.fetch();assert.equal(response.status(),201);
      if(posts===1){stale=await response.json();entered();await gate;}
      await route.fulfill({response});
    });
    await page.locator('#create').click();await started;
    let cleanupFails=scenario==='cleanup',deletes=0;
    await page.route(`**/api/requests/${stale.id}`,async route=>{
      deletes++;
      if(cleanupFails)await route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic_cleanup_failure"}'});
      else await route.continue();
    });
    const frozen=await page.locator('#mode,#stages,#recipient-cards input,#recipient-cards button,#add-signer').evaluateAll(nodes=>nodes.every(n=>n.disabled));
    // Direct DOM writes bypass disabled controls; mode deliberately emits no event.
    await page.evaluate(scenario=>{
      document.getElementById(scenario!=='stages'?'mode':'stages').value=scenario!=='stages'?'sequential':'1,2';
      if(scenario==='stages')document.getElementById('stages').dispatchEvent(new Event('input'));
      for(let i=0;i<5;i++)document.getElementById('create').dispatchEvent(new MouseEvent('click'));
    },scenario);
    release();await page.waitForFunction(()=>!document.getElementById('create').disabled);
    assert.equal(await page.locator('[data-invitation]').count(),0,`${scenario}: stale invitations must not publish`);
    assert.equal(await page.locator('#manage').isVisible(),false);
    assert(frozen,`${scenario}: routing and recipient controls frozen during creation`);
    assert.equal(posts,1,'Synthetic duplicate clicks never create concurrent requests');
    if(scenario==='cleanup') {
      assert.match(await page.locator('#message').textContent(),/could not be revoked/);
      await page.locator('#create').click();await page.waitForFunction(()=>!document.getElementById('create').disabled);
      assert.equal(posts,1,'Failed cleanup retry must not create another request');
      assert.equal(deletes,2);cleanupFails=false;
    } else {
      await assert.rejects(api(app.url,`/api/requests/${stale.id}`,stale.adminToken),/not_found/);
      assert.match(await page.locator('#message').textContent(),/changed.*create again/i);
    }
    assert.equal(await page.locator('#mode').isDisabled(),false);
    await page.locator('#create').click();await page.locator('#manage').waitFor();
    assert.equal(posts,2,'Exactly one explicit retry creates the latest request');
    const href=await page.locator('[data-invitation]').first().getAttribute('href');
    const inv=JSON.parse(new URLSearchParams(new URL(href).hash.slice(1)).get('invite'));
    const opened=await openInvitation(app.url,inv);
    await assert.rejects(api(app.url,`/api/requests/${stale.id}`,stale.adminToken),/not_found/);
    assert.equal(opened.manifest.mode,scenario!=='stages'?'sequential':'grouped');
    assert.deepEqual(opened.manifest.recipients.map(r=>r.stage),[0,1]);
    assert.equal(await page.locator('[data-invitation]').count(),2);
    assert.deepEqual(errors,[]);await page.close();
    console.log(`PASS: held real creation POST ${scenario}, freeze, synthetic mutation, stale revocation, single explicit retry`);
  }
} finally {await browser?.close();await app.close();await assert.rejects(fetch(app.url+'/health'));console.log('Cleanup verified: routing test listener closed.');}
