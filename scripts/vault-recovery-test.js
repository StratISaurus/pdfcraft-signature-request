import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openSender } from '../src/sender-vault.js';
import { startDemo } from '../src/local-demo.js';
import { openInvitation, submitApproval, api } from '../src/approval-client.js';
const app=await startDemo({port:0,writeLaunch:false});let browser;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const errors=[],traffic=[],reads=[],logs=[],secrets=[];
  async function auditedContext(){
    const c=await browser.newContext();
    c.on('request',r=>reads.push(r.allHeaders().then(h=>traffic.push(JSON.stringify(h)+(r.postData()||'')+r.url()))));
    c.on('response',r=>reads.push((async()=>{
      traffic.push(r.url()+JSON.stringify(await r.allHeaders()));
      // Redirect/204 responses have no body; every other response must be readable.
      if(r.status()!==204 && !(r.status()>=300 && r.status()<400))traffic.push((await r.body()).toString('utf8'));
    })()));
    c.on('page',p=>{p.on('console',m=>logs.push(m.text()));p.on('pageerror',e=>errors.push(e.message));});
    return c;
  }
  const denied=await auditedContext();
  await denied.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Synthetic denied','SecurityError');}}));
  const blocked=await denied.newPage();await blocked.goto(app.url+'/#setup='+app.launchToken);
  assert.equal(await blocked.locator('#prepare').isVisible(),true,'Storage getter failure must not discard setup capability');
  assert.match(await blocked.locator('#vault-status').textContent(),/storage unavailable.*import.*session-only/i);
  assert.equal(new URL(blocked.url()).hash,'');
  // Setup credential still works, but creation must revoke rather than publish without persistence.
  await blocked.locator('#sample').click();await blocked.locator('#recipients').fill('Blocked Storage');
  await blocked.locator('#preview-fields').click();await blocked.getByText('Select a recipient and click a page to place their field.').waitFor();
  await blocked.locator('#placement-pages canvas').first().press('Enter');await blocked.locator('#create').click();
  secrets.push(await blocked.locator('#vault-phrase').inputValue());await blocked.locator('#vault-confirm').check();
  const deniedCreation=blocked.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith('/api/requests') && r.status()===201);
  await blocked.locator('#create').click();const deniedRequest=await (await deniedCreation).json();
  await blocked.getByText('Synthetic denied',{exact:true}).waitFor();
  assert.equal(await blocked.locator('[data-invitation]').count(),0);
  await assert.rejects(api(app.url,`/api/requests/${deniedRequest.id}`,deniedRequest.adminToken),/not_found/);
  assert.equal(await blocked.locator('#vault-session').isVisible(),false,'Creation failure must never offer session publication');
  const context=await auditedContext(),page=await context.newPage();
  await page.goto(app.url+'/#setup='+app.launchToken);
  await page.locator('#sample').click();await page.locator('#recipients').fill('Recovery One');
  await page.locator('#add-signer').click();await page.locator('#person-1').fill('Recovery Two');
  await page.locator('#mode').selectOption('sequential');await page.locator('#preview-fields').click();
  await page.getByText('Select a recipient and click a page to place their field.').waitFor();
  await page.locator('#placement-pages canvas').first().press('Enter');await page.locator('#field-recipient').selectOption('r2');
  await page.locator('#placement-pages canvas').last().press('Enter');
  await page.locator('#create').click();
  await page.locator('#vault-phrase').waitFor({timeout:3000});
  const phrase=await page.locator('#vault-phrase').inputValue();assert.equal(phrase.split(' ').length,24);
  await page.locator('#vault-confirm').check();await page.locator('#create').click();await page.locator('#manage').waitFor();
  const links=await page.locator('[data-invitation]').evaluateAll(ns=>ns.map(n=>n.href));
  const invs=links.map(link=>JSON.parse(new URLSearchParams(new URL(link).hash.slice(1)).get('invite')));
  const download=page.waitForEvent('download');await page.locator('#vault-export').click();
  const backup=await readFile(await (await download).path(),'utf8');
  const stored=await page.evaluate(()=>JSON.stringify(localStorage));
  for(const secret of [phrase,invs[0].key,invs[1].key,invs[0].readToken])assert(!stored.includes(secret));
  assert((await page.locator('#vault-phrase').inputValue())==='','Phrase not cleared (value suppressed)');
  await page.reload();await page.locator('#vault-unlock').waitFor();assert.equal(await page.locator('#manage').isVisible(),false);
  await page.locator('#vault-unlock-phrase').fill(phrase);await page.locator('#vault-unlock').click();await page.locator('#manage').waitFor();
  assert(JSON.stringify(await page.locator('[data-invitation]').evaluateAll(ns=>ns.map(n=>n.href)))===JSON.stringify(links),'Restored invitation mismatch (values suppressed)');
  // Return stage one after reload; recovered sender validates it and unlocks stage two.
  await submitApproval(app.url,invs[0],await openInvitation(app.url,invs[0]),'Recovery One');
  await page.locator('#refresh').click();await page.getByText('1 of 2 accepted').waitFor();
  // Restore exported backup in a completely empty browser profile, no setup credential.
  const other=await auditedContext(),restored=await other.newPage();
  await restored.goto(app.url);await restored.locator('#vault-import').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(backup)});
  await restored.locator('#vault-unlock-phrase').fill('wrong phrase');await restored.locator('#vault-unlock').click();
  await restored.getByText('Unable to unlock backup.',{exact:false}).waitFor();assert.equal(await restored.locator('#manage').isVisible(),false);
  await restored.locator('#vault-unlock-phrase').fill(phrase);await restored.locator('#vault-unlock').click();await restored.locator('#manage').waitFor();
  await submitApproval(app.url,invs[1],await openInvitation(app.url,invs[1]),'Recovery Two');
  await restored.locator('#refresh').click();await restored.getByText('2 of 2 accepted').waitFor();
  assert.equal(await restored.locator('#download-final').isEnabled(),true);
  const finalDownload=restored.waitForEvent('download');await restored.locator('#download-final').click();assert((await readFile(await (await finalDownload).path())).length>0);
  // Valid imported backup remains recoverable when startup getter or restore writes fail.
  const quota=await auditedContext();
  await quota.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('Synthetic quota','QuotaExceededError');};});
  const quotaPage=await quota.newPage();await quotaPage.goto(app.url);
  for(const recovery of [blocked,quotaPage]){
    await recovery.locator('#vault-import').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(backup)});
    await recovery.locator('#vault-unlock-phrase').fill(phrase);await recovery.locator('#vault-unlock').click();
    await recovery.locator('#vault-session').waitFor({timeout:3000});
    assert.equal(await recovery.locator('#manage').isVisible(),false,'No implicit session-only restore');
    assert((await recovery.locator('#vault-unlock-phrase').inputValue())==='','Phrase not cleared (value suppressed)');
    assert.match(await recovery.locator('#vault-session').textContent(),/not saved.*reload.*backup.*phrase/i);
    // Pending decrypted state warns before navigation, and explicit retry must not lose it.
    assert.equal(await recovery.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});dispatchEvent(e);return e.defaultPrevented;}),true);
    await recovery.locator('#vault-unlock-phrase').fill(phrase);
    await recovery.locator('#vault-unlock').click();await recovery.getByText('Choose session-only recovery or reload to discard the unlocked backup.',{exact:true}).waitFor();
    assert((await recovery.locator('#vault-unlock-phrase').inputValue())==='','Even a rejected retry clears the phrase (value suppressed)');
    await recovery.locator('#vault-resume-session').click();await recovery.locator('#manage').waitFor();
    assert(JSON.stringify(await recovery.locator('[data-invitation]').evaluateAll(ns=>ns.map(n=>n.href)))===JSON.stringify(links),'Session invitation mismatch (values suppressed)');
    assert.match(await recovery.locator('#vault-status').textContent(),/session-only.*not saved/i);
    await recovery.getByText('2 of 2 accepted').waitFor();
    const result=recovery.waitForEvent('download');await recovery.locator('#download-final').click();assert((await readFile(await (await result).path())).length>0);
    const exported=recovery.waitForEvent('download');await recovery.locator('#vault-export').click();assert.equal(await readFile(await (await exported).path(),'utf8'),backup);
    assert.match(await recovery.locator('#vault-status').textContent(),/session-only/i);
    assert.equal(await recovery.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});dispatchEvent(e);return e.defaultPrevented;}),true);
  }
  assert.equal(await quotaPage.evaluate(()=>localStorage.length+sessionStorage.length),0,'Session recovery must not persist plaintext or keys');
  await restored.locator('#revoke').click();await restored.getByText('Request revoked.',{exact:false}).waitFor();
  await restored.reload();await restored.locator('#vault-unlock-phrase').fill(phrase);await restored.locator('#vault-unlock').click();
  await restored.getByText('Request unavailable: expired, revoked, or relay restarted.',{exact:false}).waitFor();assert.equal(await restored.locator('#manage').isVisible(),false);
  secrets.push(phrase,...(await openSender(backup,phrase,app.url)).sender.invitations.flatMap(i=>[i.key,i.responseKey]));
  // Another sender tab shares ciphertext storage, never a shared active-request slot.
  const second=await context.newPage();await second.goto(app.url+'/#setup='+app.launchToken);
  await second.locator('#sample').click();await second.locator('#recipients').fill('Isolated Request');
  await second.locator('#preview-fields').click();await second.getByText('Select a recipient and click a page to place their field.').waitFor();
  await second.locator('#placement-pages canvas').first().press('Enter');
  await second.locator('#create').click();const isolatedPhrase=await second.locator('#vault-phrase').inputValue();await second.locator('#vault-confirm').check();
  // Simulated browser quota denial AFTER the real relay POST: revoke the orphan, publish no links.
  await second.evaluate(()=>{const original=Storage.prototype.setItem;window.restoreStorage=()=>Storage.prototype.setItem=original;Storage.prototype.setItem=function(k,v){if(k.startsWith('pdfcraft.sender-vault.v1.'))throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,k,v);};});
  let failedRequest;
  second.on('response',async r=>{if(r.request().method()==='POST' && r.url().endsWith('/api/requests') && r.status()===201)failedRequest=await r.json();});
  await second.locator('#create').click();await second.getByText('Synthetic quota',{exact:true}).waitFor();
  assert.equal(await second.locator('[data-invitation]').count(),0);
  await assert.rejects(api(app.url,`/api/requests/${failedRequest.id}`,failedRequest.adminToken),/not_found/);
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage)),stored,'Failure leaves other request ciphertext untouched');
  await second.evaluate(()=>window.restoreStorage());
  await second.locator('#create').click();await second.locator('#manage').waitFor();
  const isolated=await second.evaluate(()=>Object.entries(localStorage));assert.equal(isolated.length,2);
  assert(isolated.some(([,v])=>v===backup),'Original ciphertext preserved byte-for-byte');
  assert((await second.locator('[data-invitation]').getAttribute('href'))!==links[0],'Independent invitation expected (values suppressed)');
  secrets.push(isolatedPhrase,...(await openSender(isolated.find(([,v])=>v!==backup)[1],isolatedPhrase,app.url)).sender.invitations.flatMap(i=>[i.key,i.responseKey]));
  // Audit all contexts through the end, including restoration and second-sender traffic.
  for(let i=0;i<reads.length;i++)await reads[i];
  const observed=traffic.join('')+logs.join('');
  for(const secret of secrets){
    const forms=[secret,encodeURIComponent(secret),new URLSearchParams({s:secret}).toString().slice(2),Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('base64url')];
    if(!secret.includes(' '))forms.push(Buffer.from(secret,'base64').toString('hex'),Buffer.from(secret,'base64').toString('base64url'));
    for(const form of forms)assert(!observed.includes(form),'Recovery secret leaked (value suppressed)');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: Edge first-request setup, ciphertext-only persistence/export, reload unlock, sequential continuation, empty-profile restore, wrong phrase, completed download, missing relay refusal, all-context request/response URL/header/body/console audit of document + response keys and phrase encodings, getter SecurityError startup/setup, getter + quota explicit session-only restore/export/finalisation, retained pending state, navigation warning, phrase clearing, shared-context isolation and fail-closed creation orphan cleanup.');
}finally{await browser?.close();await app.close();await assert.rejects(fetch(app.url+'/health'));console.log('Isolated listener cleanup verified.');}
