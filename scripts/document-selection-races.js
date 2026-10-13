import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { startDemo } from '../src/local-demo.js';
import { openInvitation } from '../src/approval-client.js';
import { pathToFileURL } from 'node:url';

export async function documentSelectionRaces(context,app,secrets=[]) {
  const failures=[],passed=[];
  const doc=await PDFDocument.create();doc.addPage([612,792]);
  const one=Buffer.from(await doc.save());
  const doc2=await PDFDocument.create();doc2.addPage([612,792]);doc2.addPage([612,792]);
  const two=Buffer.from(await doc2.save());
  async function setup() {
    const page=await context.newPage();
    await page.addInitScript(()=>{
      window.fileGates={};window.selectionTasks=[];
      const original=File.prototype.arrayBuffer;
      File.prototype.arrayBuffer=async function(){
        if(this.name.startsWith('held')) await new Promise(resolve=>window.fileGates[this.name]=resolve);
        return original.call(this);
      };
      const add=EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener=function(type,listener,options){
        if(['file','sample','preview-fields','create'].includes(this.id) && ['click','change'].includes(type)) {
          const wrapped=function(...args){const task=Promise.resolve(listener.apply(this,args));window.selectionTasks.push(task);return task;};
          return add.call(this,type,wrapped,options);
        }
        return add.call(this,type,listener,options);
      };
    });
    await page.goto(app.url+'/#setup='+app.launchToken);
    await page.locator('#recipients').fill('Race Test');
    return page;
  }
  const upload=(page,name,buffer)=>page.locator('#file').setInputFiles({name,mimeType:'application/pdf',buffer});
  const settle=page=>page.evaluate(()=>Promise.all(window.selectionTasks));
  async function preview(page) {
    await page.locator('#preview-fields').click();await settle(page);
    await page.locator('#placement-pages canvas').first().click({position:{x:70,y:500}});
  }
  async function createdPages(page) {
    await page.locator('#create').click();await settle(page);
    const link=await page.locator('[data-invitation]').first().getAttribute('href');
    const inv=JSON.parse(new URLSearchParams(new URL(link).hash.slice(1)).get('invite'));
    const opened=await openInvitation(app.url,inv);secrets.push(inv.key,opened.responseKey);
    return (await PDFDocument.load(opened.pdf)).getPageCount();
  }
  async function scenario(name,run) {
    const page=await setup();
    try {await run(page);passed.push(name);console.log('PASS: '+name);}
    catch(e){failures.push(name+': '+e.message);console.error('FAIL: '+name+': '+e.message);}
    finally {await page.close();}
  }
  await scenario('delayed upload -> sample -> preview/place -> release keeps sample bytes',async page=>{
    await upload(page,'held-first.pdf',one);
    await page.waitForFunction(()=>window.fileGates['held-first.pdf']);
    await page.locator('#sample').click();
    await page.getByText('Sample PDF ready. No real personal data.').waitFor();
    // Do not await the held upload while rendering the newer sample.
    await page.locator('#preview-fields').click();
    await page.getByText('Select a recipient and click a page to place their field.').waitFor();
    await page.locator('#placement-pages canvas').first().click({position:{x:70,y:500}});
    await page.evaluate(()=>window.fileGates['held-first.pdf']());await settle(page);
    const pages=await createdPages(page);
    assert.equal(pages,2,'Created PDF must remain the two-page sample, not the stale one-page upload');
  });
  await scenario('two uploads completing out of order keep newest selection',async page=>{
    await upload(page,'held-first.pdf',one);await page.waitForFunction(()=>window.fileGates['held-first.pdf']);
    await upload(page,'held-second.pdf',two);await page.waitForFunction(()=>window.fileGates['held-second.pdf']);
    await page.evaluate(()=>window.fileGates['held-second.pdf']());await page.getByText('PDF ready. Use only synthetic documents.').waitFor();
    await page.evaluate(()=>window.fileGates['held-first.pdf']());await settle(page);
    await preview(page);
    assert.equal(await createdPages(page),2,'Created PDF must use the newer two-page upload');
  });
  await scenario('changed document clears fields and rejects detached stale canvas clicks',async page=>{
    await page.locator('#sample').click();await settle(page);await preview(page);
    await page.evaluate(()=>window.oldCanvas=document.querySelector('#placement-pages canvas'));
    await upload(page,'new.pdf',one);await settle(page);
    assert.equal(await page.locator('.signature-field').count(),0,'Changing documents clears fields');
    await page.locator('#preview-fields').click();await settle(page);
    await page.evaluate(()=>window.oldCanvas.dispatchEvent(new MouseEvent('click',{clientX:70,clientY:500})));
    assert.equal(await page.locator('.signature-field').count(),0,'Detached stale canvas must not place on current revision');
    let posts=0;page.on('request',r=>{if(r.method()==='POST' && r.url().endsWith('/api/requests'))posts++;});
    await page.evaluate(()=>document.getElementById('create').dispatchEvent(new MouseEvent('click')));await settle(page);
    assert.equal(posts,0,'Synthetic create cannot submit mismatched placements');
    assert.equal(await page.locator('#create').isDisabled(),true);
  });
  await scenario('pending old preview cannot render or enable placement after selection changes',async page=>{
    let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
    await page.route('**/vendor/pdf.worker.mjs',async route=>{entered();await gate;await route.continue();});
    await page.locator('#sample').click();await settle(page);
    await page.locator('#preview-fields').click();await started;
    await upload(page,'new.pdf',one);await page.getByText('PDF ready. Use only synthetic documents.').waitFor();
    release();await settle(page);
    assert.equal(await page.locator('#placement-pages canvas').count(),0,'Stale preview must not append canvases');
    assert.equal(await page.locator('#placement').isHidden(),true);
    assert.equal(await page.locator('#create').isDisabled(),true);
  });
  for(const failValidation of [false,true]) await scenario(`stale validation ${failValidation?'failure':'success'} cannot replace newer sample; pending bytes unavailable`,async page=>{
    await page.evaluate(async fail=>{
      const {PDFDocument}=await import('/vendor/pdf-lib.js');const load=PDFDocument.load;
      PDFDocument.load=async function(...args){
        PDFDocument.load=load;
        await new Promise(resolve=>window.releaseValidation=resolve);
        if(fail)throw Error('Synthetic delayed validation failure');
        return load.apply(this,args);
      };
    },failValidation);
    await upload(page,'validating.pdf',one);await page.waitForFunction(()=>window.releaseValidation);
    await page.locator('#preview-fields').click();
    await page.getByText('Choose a PDF first.').waitFor();
    assert.equal(await page.locator('#create').isDisabled(),true);
    assert.equal(await page.locator('#filename').textContent(),'');
    await page.locator('#sample').click();await page.getByText('Sample PDF ready. No real personal data.').waitFor();
    await page.evaluate(()=>window.releaseValidation());await settle(page);
    assert.match(await page.locator('#filename').textContent(),/synthetic-agreement/);
    assert.equal(await page.locator('#message').textContent(),'Sample PDF ready. No real personal data.');
    await preview(page);assert.equal(await createdPages(page),2);
  });
  await scenario('delayed sample generation cannot replace later upload',async page=>{
    await page.evaluate(async()=>{
      const {PDFDocument}=await import('/vendor/pdf-lib.js');const save=PDFDocument.prototype.save;
      PDFDocument.prototype.save=async function(...args){
        PDFDocument.prototype.save=save;
        await new Promise(resolve=>window.releaseSample=resolve);
        return save.apply(this,args);
      };
    });
    await page.locator('#sample').click();await page.waitForFunction(()=>window.releaseSample);
    await upload(page,'latest.pdf',one);await page.getByText('PDF ready. Use only synthetic documents.').waitFor();
    await page.evaluate(()=>window.releaseSample());await settle(page);
    assert.equal(await page.locator('#filename').textContent(),'latest.pdf');
    await preview(page);assert.equal(await createdPages(page),1);
  });
  assert.deepEqual(failures,[],'Document selection race regressions');
  return {passed:passed.length,cases:passed};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const app=await startDemo({port:0,writeLaunch:false});let browser;
  try {browser=await chromium.launch({channel:'msedge',headless:true});await documentSelectionRaces(await browser.newContext(),app);}
  finally {await browser?.close();await app.close();}
}
