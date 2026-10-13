import { documentSelectionRaces } from './document-selection-races.js';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile, access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { startDemo } from '../src/local-demo.js';
import { prepareRequest, invitationFragment, openInvitation, api } from '../src/approval-client.js';
const dir=new URL('../artifacts/',import.meta.url);
await mkdir(dir,{recursive:true});
// Isolated launcher and ephemeral listener: never touch the live user's demo.
const launchDir=await mkdtemp(join(tmpdir(),'pdfcraft-browser-'));
const app=await startDemo({port:0,writeLaunch:false});
app.launchPath=join(launchDir,'open-sender.html');
await writeFile(app.launchPath,`<!doctype html><meta name="referrer" content="no-referrer"><a href="${app.url}/#setup=${app.launchToken}" rel="noreferrer">Open local sender (keep this file private)</a>`,{mode:0o600});
let browser;
try {
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext();
  const errors=[],consoleMessages=[],requests=[],responses=[],trafficReads=[],secrets=[];
  context.on('request',request=>trafficReads.push(request.allHeaders().then(headers=>requests.push({url:request.url(),headers,body:request.postData() || ''}))));
  context.on('response',response=>{if(response.url().includes('/api/')) trafficReads.push((async()=>responses.push({url:response.url(),headers:await response.allHeaders(),body:await response.text()}))());});
  context.on('page',page=>{page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleMessages.push(m.text());});});
  // A real file:// click, not page.goto(privateLink), must open the sender.
  const sender=await context.newPage();
  await sender.goto(pathToFileURL(app.launchPath).href);
  const navigation=sender.waitForResponse(response=>response.request().isNavigationRequest() && response.url()===app.url+'/');
  await sender.getByRole('link',{name:'Open local sender (keep this file private)'}).click();
  const launchResponse=await navigation;
  const launchHeaders=await launchResponse.request().allHeaders();
  const launcher={status:launchResponse.status(),site:launchHeaders['sec-fetch-site'],mode:launchHeaders['sec-fetch-mode'],dest:launchHeaders['sec-fetch-dest'],origin:launchHeaders.origin || 'absent'};
  console.log('Launcher navigation:',JSON.stringify(launcher));
  assert.equal(launcher.status,200,'Real file launcher click must load the sender, not origin_or_host_forbidden');
  assert.equal(launcher.site,'cross-site');
  assert.equal(launcher.mode,'navigate');
  assert.equal(launcher.dest,'document');
  await sender.getByRole('button',{name:'Use sample PDF'}).waitFor();
  assert.equal(await sender.evaluate(()=>location.hash),'','Setup fragment is removed after local parsing');
  // Real PDF.js failure, both before any canvas and after a partial render.
  for (const normalPages of [0,1]) {
    const doc=await PDFDocument.create();
    if(normalPages) doc.addPage([612,792]);
    doc.addPage([2600,792]);
    const request=await prepareRequest(app.url,app.launchToken,await doc.save(),['Render Test'],'any');
    secrets.push(request.invitations[0].key,request.invitations[0].responseKey);
    const page=await context.newPage();
    await page.goto(app.url+'/'+invitationFragment(request.invitations[0]));
    await page.getByText('Page dimensions exceed demo rendering limit').waitFor();
    assert.equal(await page.locator('canvas').count(),normalPages);
    // Even a synthetic click bypassing disabled UI must not submit evidence.
    await page.evaluate(()=>{
      document.getElementById('name').value='Render Test';
      document.getElementById('consent').checked=true;
      document.getElementById('approve').dispatchEvent(new MouseEvent('click'));
    });
    await page.waitForFunction(()=>!document.getElementById('message').textContent.includes('Working locally'));
    const state=await api(app.url,`/api/requests/${request.id}`,request.adminToken);
    assert.equal(state.recipients[0].state,'waiting','Failed rendering must never submit an approval');
    assert.equal(await page.locator('#consent-panel').isVisible(),false);
    assert.equal(await page.locator('#approve').isDisabled(),true);
    await page.close();
  }
  assert.deepEqual(await sender.locator('#workflow a').allTextContents(),['Document','People','Fields','Review / share']);
  await sender.getByRole('button',{name:'Use sample PDF'}).click();
  await sender.getByLabel('Signer 1 name').fill('Alice Test');
  await sender.getByRole('button',{name:'Add signer',exact:true}).click();
  await sender.getByLabel('Signer 2 name').fill('Bob Test');
  await sender.getByRole('button',{name:'Add signer',exact:true}).click();
  await sender.getByRole('button',{name:'Remove signer 3'}).click();
  assert.equal(await sender.locator('.recipient-card').count(),2);
  assert.notEqual(await sender.locator('.recipient-card').nth(0).evaluate(e=>getComputedStyle(e).borderLeftColor),await sender.locator('.recipient-card').nth(1).evaluate(e=>getComputedStyle(e).borderLeftColor));
  await sender.getByLabel('Signing order').selectOption('sequential');
  await sender.getByRole('button',{name:'Preview and place fields'}).click();
  await sender.locator('#placement-pages canvas').nth(1).waitFor();
  const keyboardPage=sender.locator('#placement-pages canvas').first();
  await keyboardPage.focus();await keyboardPage.press('Enter');
  assert.equal(await sender.locator('#placement-pages .signature-field').count(),1,'Keyboard places a field');
  const keyboardLeft=await sender.locator('#placement-pages .signature-field').evaluate(e=>parseFloat(e.style.left));
  await keyboardPage.press('ArrowRight');
  assert(await sender.locator('#placement-pages .signature-field').evaluate((e,left)=>parseFloat(e.style.left)>left,keyboardLeft),'Arrow key moves field');
  await sender.getByLabel('Field recipient').selectOption('r1');
  await sender.locator('#placement-pages canvas').nth(0).click({position:{x:70,y:500}});
  await sender.getByLabel('Field recipient').selectOption('r2');
  await sender.locator('#placement-pages canvas').nth(1).click({position:{x:100,y:550}});
  assert.equal(await sender.locator('#placement-pages .signature-field').count(),2);
  await sender.locator('#placement-pages canvas').nth(1).click({position:{x:130,y:530}});
  assert.equal(await sender.locator('#placement-pages .signature-field').count(),2,'Moving replaces rather than duplicates the selected field');
  await sender.getByRole('button',{name:'Remove selected field'}).click();
  assert.equal(await sender.locator('#placement-pages .signature-field').count(),1);
  await sender.locator('#placement-pages canvas').nth(1).click({position:{x:100,y:500}});
  await sender.screenshot({path:new URL('sender-fields.png',dir).pathname.replace(/^\/C:/,'C:'),fullPage:true});
  await sender.setViewportSize({width:390,height:844});
  assert.equal(await sender.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await sender.screenshot({path:new URL('sender-mobile.png',dir).pathname.replace(/^\/C:/,'C:'),fullPage:true});
  await sender.setViewportSize({width:1280,height:720});
  await sender.getByRole('button',{name:'Create encrypted request'}).click();
  await sender.getByRole('heading',{name:'Request ready'}).waitFor();
  const links=await sender.locator('[data-invitation]').evaluateAll(nodes=>nodes.map(n=>n.href));
  assert.equal(links.length,2);
  const firstInvite=JSON.parse(new URLSearchParams(new URL(links[0]).hash.slice(1)).get('invite'));
  const firstOpened=await openInvitation(app.url,firstInvite);
  assert.deepEqual(firstOpened.manifest.fields.map(({recipientId,page,width,height})=>({recipientId,page,width,height})),[{recipientId:'r1',page:1,width:220,height:60},{recipientId:'r2',page:2,width:220,height:60}]);
  // Browser input coordinates round fractional CSS offsets to device pixels.
  firstOpened.manifest.fields.forEach((f,i)=>{assert(Math.abs(f.x-[70,100][i])<1);assert(Math.abs(f.y-232)<1);});
  secrets.push(firstInvite.key,firstOpened.responseKey);
  const recipient=await context.newPage();
  await recipient.goto(links[1]);
  await recipient.getByText('Waiting for earlier recipients').waitFor();
  let releaseDocument;
  const documentGate=new Promise(resolve=>{releaseDocument=resolve;});
  await recipient.route('**/api/requests/*/recipients/r1',async route=>{await documentGate;await route.continue();});
  await recipient.goto(links[0],{waitUntil:'domcontentloaded'});
  assert.equal(await recipient.locator('#consent-panel').isVisible(),false,'Consent starts hidden');
  assert.equal(await recipient.locator('#approve').isDisabled(),true,'Approval starts disabled');
  await recipient.evaluate(()=>{
    window.prematureApproval=false;
    new MutationObserver(()=>{
      if(!document.getElementById('approve').disabled && document.querySelectorAll('#pages canvas').length!==2) window.prematureApproval=true;
    }).observe(document.body,{subtree:true,childList:true,attributes:true});
  });
  releaseDocument();
  await recipient.locator('canvas').nth(1).waitFor();
  await recipient.locator('#consent-panel').waitFor();
  await recipient.getByRole('button',{name:'Start signing'}).click();
  assert.equal(await recipient.evaluate(()=>document.activeElement.classList.contains('signature-field')),true);
  await recipient.getByRole('button',{name:'Enter typed signature'}).click();
  assert.equal(await recipient.evaluate(()=>document.activeElement.id),'name');
  assert(!await recipient.locator('#message').textContent().then(text=>text.includes('Working locally')),'Navigation must not leave a busy message');
  assert.equal(await recipient.evaluate(()=>window.prematureApproval),false,'Enable only after every page rendered');
  assert.equal(await recipient.locator('#pages .signature-field').count(),1);
  assert.match(await recipient.locator('#pages .signature-field').textContent(),/r1/);
  await recipient.getByRole('button',{name:'Approve and return encrypted PDF'}).click();
  await recipient.getByText('Confirm that you reviewed every page before approving.').waitFor();
  await recipient.getByLabel('Your typed name').fill('W'.repeat(80));
  assert.equal(await recipient.locator('#signature-preview').textContent(),'W'.repeat(80));
  await recipient.getByLabel('I reviewed every page').check();
  await recipient.screenshot({path:new URL('recipient-desktop.png',dir).pathname.replace(/^\/C:/,'C:') ,fullPage:true});
  await recipient.getByRole('button',{name:'Approve and return encrypted PDF'}).click();
  await recipient.getByText('Approval returned').waitFor();
  await recipient.getByRole('heading',{name:'Your approval is returned'}).waitFor();
  await recipient.screenshot({path:new URL('recipient-success.png',dir).pathname.replace(/^\/C:/,'C:'),fullPage:true});
  const ownDownload=recipient.waitForEvent('download');
  await recipient.getByRole('button',{name:'Download my approved PDF'}).click();
  await (await ownDownload).saveAs(new URL('own-approved-synthetic.pdf',dir).pathname.replace(/^\/C:/,'C:'));
  assert.equal((await PDFDocument.load(await readFile(new URL('own-approved-synthetic.pdf',dir)))).getPageCount(),3);
  assert.match(await recipient.locator('#completion-status').textContent(),/not known/);
  await sender.bringToFront();
  await sender.getByText('1 of 2 accepted',{exact:false}).waitFor({timeout:15000});
  assert.match(await sender.locator('[data-recipient="r1"] .status').textContent(),/Accepted/);
  assert.match(await sender.locator('[data-recipient="r2"] .status').textContent(),/Ready to sign/);
  const secondInvite=JSON.parse(new URLSearchParams(new URL(links[1]).hash.slice(1)).get('invite'));
  secrets.push(secondInvite.key,(await openInvitation(app.url,secondInvite)).responseKey);
  await recipient.goto(links[1]);
  await recipient.locator('canvas').nth(1).waitFor();
  await recipient.setViewportSize({width:390,height:844});
  await recipient.getByLabel('Your typed name').fill('Bob Test');
  await recipient.getByLabel('I reviewed every page').check();
  await recipient.locator('#pages .signature-field').scrollIntoViewIfNeeded();
  await recipient.locator('#pages').evaluate(el=>{el.scrollTop=el.scrollHeight;});
  assert(await recipient.locator('#pages .signature-field').evaluate(el=>el.scrollHeight<=el.clientHeight),'Mobile field label must not clip');
  await recipient.locator('#pages').screenshot({path:new URL('recipient-mobile-field.png',dir).pathname.replace(/^\/C:/,'C:')});
  await recipient.screenshot({path:new URL('recipient-mobile.png',dir).pathname.replace(/^\/C:/,'C:'),fullPage:true});
  assert.equal(await recipient.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await recipient.getByRole('button',{name:'Approve and return encrypted PDF'}).click();
  await recipient.getByText('Approval returned').waitFor();
  await sender.getByRole('button',{name:'Check responses'}).click();
  await sender.getByText('2 of 2 accepted').waitFor();
  assert.match(await sender.locator('#auto-status').textContent(),/complete/i);
  await sender.screenshot({path:new URL('sender-complete.png',dir).pathname.replace(/^\/C:/,'C:'),fullPage:true,mask:[sender.locator('#invitations')]});
  const evidenceDownload=sender.waitForEvent('download');
  await sender.getByRole('button',{name:'Download evidence JSON'}).click();
  await (await evidenceDownload).saveAs(new URL('approval-evidence.json',dir).pathname.replace(/^\/C:/,'C:'));
  const evidence=JSON.parse(await readFile(new URL('approval-evidence.json',dir),'utf8'));
  assert.deepEqual(evidence.manifest.fields,firstOpened.manifest.fields);
  assert.equal(evidence.approvals.length,2);
  const download=sender.waitForEvent('download');
  await sender.getByRole('button',{name:'Download completed PDF'}).click();
  const d=await download;
  const output=new URL('completed-synthetic.pdf',dir);
  await d.saveAs(output.pathname.replace(/^\/C:/,'C:'));
  const pdf=await readFile(output);
  assert.equal((await PDFDocument.load(pdf)).getPageCount(),4);
  // Independent parser confirms actual appearance text, not just a file extension.
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const parsed=await getDocument({data:new Uint8Array(pdf),useSystemFonts:true}).promise;
  const receipt=await (await parsed.getPage(4)).getTextContent();
  assert(receipt.items.some(i=>i.str.includes('Bob Test')));
  assert(receipt.items.some(i=>i.str.includes('not a trusted digital PDF signature')));
  for(const f of firstOpened.manifest.fields) {
    const text=await (await parsed.getPage(f.page)).getTextContent();
    const name=f.recipientId==='r1'?'W'.repeat(80):'Bob Test';
    const items=text.items.filter(i=>f.recipientId==='r1'?/^W+$/.test(i.str):i.str===name);
    assert.equal(items.map(i=>i.str).join(''),name,'Typed signature on selected original page');
    assert(items.every(item=>item.transform[4]>=f.x && item.transform[4]+item.width<=f.x+f.width));
    assert(items.every(item=>item.transform[5]>=f.y && item.transform[5]+item.height<=f.y+f.height && item.height>=8));
  }
  await parsed.destroy();
  // Render the maximum-width name receipt using the actual browser PDF.js canvas.
  const receiptPage=await context.newPage();
  await receiptPage.goto(app.url);
  const rendered=await receiptPage.evaluate(async bytes=>{
    const {getDocument}=await import('/vendor/pdf.mjs');
    const doc=await getDocument({data:new Uint8Array(bytes),useSystemFonts:true}).promise;
    try {
      const page=await doc.getPage(3),viewport=page.getViewport({scale:1});
      const text=await page.getTextContent();
      const canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;
      document.body.replaceChildren(canvas);
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      return text.items.filter(i=>i.str.trim()).map(i=>({text:i.str,x:i.transform[4],width:i.width}));
    } finally {await doc.destroy();}
  },Array.from(pdf));
  assert(rendered.map(i=>i.text).join('').includes('W'.repeat(80)));
  assert(rendered.every(i=>i.x>=39.99 && i.x+i.width<=572.01));
  await receiptPage.screenshot({path:new URL('receipt-wide-name.png',dir).pathname.replace(/^\/C:/,'C:'),fullPage:true});
  await receiptPage.evaluate(async bytes=>{
    const {getDocument}=await import('/vendor/pdf.mjs');
    const doc=await getDocument({data:new Uint8Array(bytes),useSystemFonts:true}).promise;
    try {
      const page=await doc.getPage(2),viewport=page.getViewport({scale:1});
      const canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;
      document.body.replaceChildren(canvas);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    } finally {await doc.destroy();}
  },Array.from(pdf));
  await receiptPage.screenshot({path:new URL('completed-in-page-signature.png',dir).pathname.replace(/^\/C:/,'C:'),fullPage:true});
  const selectionRaces=await documentSelectionRaces(context,app,secrets);
  await Promise.all(trafficReads);
  for(const traffic of [...requests,...responses]) {
    const wire=JSON.stringify(traffic);
    for(const secret of secrets) for(const representation of [secret,encodeURIComponent(secret)])
      assert(!wire.includes(representation),'No document or response encryption keys in HTTP URLs, headers, or bodies');
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(consoleMessages.filter(m=>!m.includes('423 (Locked)') && !m.includes('404 (Not Found)')),[]);
  for(const request of requests) {
    if(['data:','edge:','file:'].includes(new URL(request.url).protocol)) continue; // Local launcher/font data / Edge download UI, not HTTP traffic.
    assert.equal(new URL(request.url).origin,app.url,'No third-party network requests');
    assert(!request.url.includes('#'),'Invitation fragment must not enter an HTTP URL');
    assert(!request.url.includes(app.launchToken) && !request.body.includes(app.launchToken),'Setup bearer must not enter HTTP URLs or bodies');
    for(const [name,value] of Object.entries(request.headers)) {
      if(name==='authorization' && request.url===app.url+'/api/requests') continue; // Sender capability, not a decryption key.
      assert(!value.includes(app.launchToken),'Setup bearer may only enter the request-creation Authorization header');
    }
    if(request.url.includes('/api/')) {
      assert(!request.body.includes('Alice Test') && !request.body.includes('Bob Test') && !request.body.includes('%PDF') && !request.body.includes('W'.repeat(80)),'No plaintext PDF or recipient names at relay');
      for(const link of links) {const inv=JSON.parse(new URLSearchParams(new URL(link).hash.slice(1)).get('invite'));assert(!request.body.includes(inv.key),'No document keys at relay');}
    }
  }
  await writeFile(new URL('browser-result.json',dir),JSON.stringify({passed:true,launcher,selectionRaces,flow:'two recipients sequential',pages:4,positionedFields:{count:2,originalPages:[1,2],pdfjsTextBoundsVerified:true},failedRenderCases:[{width:2600,height:792,renderedPages:0,state:'waiting'},{width:2600,height:792,renderedPages:1,state:'waiting'}],wideNameReceipt:{characters:80,rendered:true,leftMargin:40,rightMargin:40},keyLeakChecks:{documentAndResponseKeys:true,urls:true,headers:true,bodies:true,requests:requests.length,responses:responses.length},pageErrors:errors,unexpectedConsoleErrors:[],expectedHttpErrors:consoleMessages,screenshots:['sender-mobile.png','recipient-success.png','recipient-mobile-field.png','sender-fields.png','completed-in-page-signature.png','recipient-desktop.png','recipient-mobile.png','sender-complete.png','receipt-wide-name.png']},null,2));
  console.log('PASS: browser sender -> two gated recipients -> encrypted returns -> downloaded 4-page PDF; failed/partial renders cannot approve; 80-W receipt rendered within margins; document/response keys absent from HTTP URLs, headers and bodies; no page errors.');
} finally {
  try {await browser?.close();} finally {await app.close();await rm(launchDir,{recursive:true,force:true});}
  await assert.rejects(fetch(app.url+'/health'),'Test listener must be closed');
  await assert.rejects(access(app.launchPath),{code:'ENOENT'});
  console.log('Cleanup verified: test listener closed; generated private launcher removed.');
}
