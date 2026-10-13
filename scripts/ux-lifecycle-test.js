import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { startDemo } from '../src/local-demo.js';
import { openInvitation, submitApproval, api } from '../src/approval-client.js';
const app=await startDemo({port:0,writeLaunch:false});let browser;
try {
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url+'/#setup='+app.launchToken);
  await page.clock.install();
  await page.getByLabel('Signer 1 name').fill('Lifecycle Test');
  await page.getByRole('button',{name:'Use sample PDF'}).click();
  await page.getByRole('button',{name:'Preview and place fields'}).click();
  await page.getByText('Select a recipient and click a page to place their field.').waitFor();
  await page.locator('#placement-pages canvas').first().press('Enter');
  await page.locator('#create').click();await page.locator('#manage').waitFor();
  const link=await page.locator('[data-invitation]').getAttribute('href');
  const invitation=JSON.parse(new URLSearchParams(new URL(link).hash.slice(1)).get('invite'));
  await page.getByRole('button',{name:'Copy link for Lifecycle Test'}).click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),link,'Copy link matches that signer only');
  // Gate the actual management read, then spam manual events while the auto poll is active.
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let gets=0;
  const path=`**/api/requests/${invitation.id}`;
  await page.route(path,async route=>{gets++;entered();await gate;await route.continue();});
  await page.clock.runFor(5000);await started;
  await page.evaluate(()=>{for(let i=0;i<5;i++)document.getElementById('refresh').dispatchEvent(new MouseEvent('click'));});
  assert.equal(gets,1,'Automatic + manual collection is locked to one request');
  release();await page.getByText('Checked just now.',{exact:false}).waitFor();await page.unroute(path);
  // Simulated visibility uses the real browser event and clock, without waiting on wall time.
  await page.evaluate(()=>{window.testHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.testHidden});document.dispatchEvent(new Event('visibilitychange'));});
  let reads=0;await page.route(path,async route=>{reads++;await route.continue();});
  await page.clock.runFor(15000);assert.equal(reads,0,'Hidden sender does not poll');
  await page.evaluate(()=>{window.testHidden=false;document.dispatchEvent(new Event('visibilitychange'));});
  await page.clock.runFor(5000);await page.waitForFunction(()=>document.getElementById('auto-status').textContent.includes('Checked just now'));
  // Allow the read's processing/finally to settle before switching failure injection.
  await page.locator('#refresh').click();await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
  assert(reads>=1);await page.unroute(path);
  let failures=0;await page.route(path,async route=>{failures++;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'synthetic_offline'})});});
  await page.locator('#refresh').click();await page.getByText('Automatic checking paused after an error.',{exact:false}).waitFor();
  await page.clock.runFor(15000);assert.equal(failures,1,'Error pauses polls');
  await page.evaluate(()=>{window.testHidden=true;document.dispatchEvent(new Event('visibilitychange'));window.testHidden=false;document.dispatchEvent(new Event('visibilitychange'));});
  await page.clock.runFor(15000);assert.equal(failures,1,'Visibility cannot silently resume an error');
  await page.unroute(path);await page.locator('#refresh').click();await page.getByText('Checked just now.',{exact:false}).waitFor();
  const opened=await openInvitation(app.url,invitation);await submitApproval(app.url,invitation,opened,'Lifecycle Test');
  // Drop the acceptance ACK after the real server processes it. Retry must re-read accepted state.
  let accepts=0;await page.route(`**/api/requests/${invitation.id}/accept/r1`,async route=>{accepts++;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');});
  await page.locator('#refresh').click();await page.getByText('Automatic checking paused after an error.',{exact:false}).waitFor();
  await page.unroute(`**/api/requests/${invitation.id}/accept/r1`);
  await page.locator('#refresh').click();await page.getByText('1 of 1 accepted').waitFor();
  assert.equal(accepts,1,'Lost ACK retry does not repeat acceptance');
  assert.equal(await page.locator('#returned button').count(),1,'Retry does not duplicate artifacts');
  reads=0;await page.route(path,async route=>{reads++;await route.continue();});
  await page.clock.runFor(20000);await page.locator('#refresh').click();assert.equal(reads,0,'Completed request is terminal');
  assert.deepEqual(errors,[]);
  await writeFile(new URL('../artifacts/ux-lifecycle-result.json',import.meta.url),JSON.stringify({passed:true,copyLink:true,automaticManualLock:true,simulatedVisibilityPause:true,errorStopsUntilManualRetry:true,lostAcceptanceAckRetry:true,terminalStops:true,pageErrors:errors},null,2));
  console.log('PASS: real Edge copy link, auto/manual collect lock, hidden pause, error stop/manual retry, lost acceptance ACK idempotent retry, terminal stop. Visibility and time simulated with browser hooks.');
} finally {await browser?.close();await app.close();await assert.rejects(fetch(app.url+'/health'));console.log('Cleanup verified: isolated test listener closed.');}
