import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { openSender } from '../src/sender-vault.js';
const storageDir=await mkdtemp(join(tmpdir(),'pdfcraft-browser-restart-'));
let child,browser,app;
async function start(port=0){
  child=fork(new URL('./restart-demo-child.js',import.meta.url),[],{stdio:['ignore','ignore','inherit','ipc']});
  const ready=once(child,'message',{signal:AbortSignal.timeout(20000)});child.send({port,storageDir});[app]=await ready;assert(!app.error,app.error);
}
async function stop(crash=false){if(!child)return;if(child.exitCode!==null || child.signalCode!==null){child=null;return;}const exited=once(child,'exit',{signal:AbortSignal.timeout(20000)});if(crash)child.kill('SIGKILL');else child.send('stop');await exited;child=null;}
try{
  await start();browser=await chromium.launch({channel:'msedge',headless:true});
  const errors=[];const context=await browser.newContext();context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  const page=await context.newPage();await page.goto(app.url+'/#setup='+app.launchToken);
  await page.locator('#sample').click();await page.locator('#recipients').fill('Restart Synthetic Signer');
  await page.locator('#preview-fields').click();await page.getByText('Select a recipient and click a page to place their field.').waitFor();
  await page.locator('#placement-pages canvas').first().press('Enter');await page.locator('#create').click();
  const phrase=await page.locator('#vault-phrase').inputValue();await page.locator('#vault-confirm').check();await page.locator('#create').click();await page.locator('#manage').waitFor();
  const link=await page.locator('[data-invitation]').getAttribute('href');
  const exported=page.waitForEvent('download');await page.locator('#vault-export').click();const backup=await readFile(await (await exported).path(),'utf8');
  const {sender}=await openSender(backup,phrase,app.url);const origin=app.url;
  await context.close();await stop(true);await start(Number(new URL(origin).port));assert.equal(app.url,origin);
  const restoredContext=await browser.newContext();restoredContext.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  const restored=await restoredContext.newPage();await restored.goto(origin);
  await restored.locator('#vault-import').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(backup)});
  await restored.locator('#vault-unlock-phrase').fill(phrase);await restored.locator('#vault-unlock').click();
  await restored.locator('#manage').waitFor({timeout:5000});
  assert((await restored.locator('[data-invitation]').getAttribute('href'))===link,'Recovered invitation differs (suppressed)');
  // Sign through the real browser, then restart again with accepted response ciphertext.
  const recipient=await restoredContext.newPage();await recipient.goto(link);await recipient.locator('#consent-panel').waitFor();
  await recipient.locator('#name').fill('Restart Synthetic Signer');await recipient.locator('#consent').check();await recipient.locator('#approve').click();
  await recipient.getByText('Approval returned',{exact:false}).waitFor();await restored.locator('#refresh').click();await restored.getByText('1 of 1 accepted').waitFor();
  await restoredContext.close();await stop(true);await start(Number(new URL(origin).port));
  const finalContext=await browser.newContext();const final=await finalContext.newPage();await final.goto(origin);
  await final.locator('#vault-import').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(backup)});
  await final.locator('#vault-unlock-phrase').fill(phrase);await final.locator('#vault-unlock').click();await final.getByText('1 of 1 accepted').waitFor();
  const downloaded=final.waitForEvent('download');await final.locator('#download-final').click();const pdf=await readFile(await (await downloaded).path());assert.equal((await PDFDocument.load(pdf)).getPageCount(),3);
  await finalContext.close();await stop();
  const secrets=[phrase,sender.adminToken,'Restart Synthetic Signer',...sender.invitations.flatMap(i=>[i.key,i.responseKey,i.readToken,i.responseToken])];
  for(const file of await readdir(storageDir)){
    const bytes=await readFile(join(storageDir,file));assert(!bytes.includes(pdf),'Returned plaintext PDF persisted');assert(!bytes.includes(Buffer.from('%PDF-')),'PDF persisted');
    for(const secret of secrets)for(const form of [secret,Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('hex')])assert(!bytes.includes(Buffer.from(form)),'Secret/plaintext persisted (suppressed)');
  }
  assert.deepEqual(errors,[]);console.log('PASS: isolated real process kill/restart twice, same origin/storage, phrase + backup empty-profile recovery, browser signing, persisted acceptance, completed PDF download, ciphertext-only disk audit.');
}finally{await browser?.close();await stop();await rm(storageDir,{recursive:true,force:true});if(app)await assert.rejects(fetch(app.url+'/health'));}
