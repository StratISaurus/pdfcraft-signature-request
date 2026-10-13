import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { makeManifest, manifestHash } from '../src/workflow.js';
import { syntheticPdf, approvalPdf } from '../src/approval-pdf.js';
test('field ownership, geometry and tampering fail closed',async()=>{
 const bytes=await syntheticPdf();
 for(const change of [{recipientId:'r2'},{page:0},{page:3},{x:-1},{x:600},{y:780},{width:0},{height:20},{x:NaN}]) {
  await assert.rejects(async()=>{const m=await makeManifest(bytes,['Alice'],'any',[],[{...field(),...change}]);await approvalPdf(bytes,m,[await approval(m,'r1','Alice')]);},/field|bounds/i);
 }
 await assert.rejects(makeManifest(bytes,['Alice'],'any',[],[field(),field()]),/field/i);
 const m=await makeManifest(bytes,['Alice'],'any',[],[field()]),a=await approval(m,'r1','Alice');
 m.fields[0].x+=1;await assert.rejects(approvalPdf(bytes,m,[a]),/binding/i);
 for(const kind of ['rotation','crop','origin','unit']) {
  const doc=await PDFDocument.create(),page=doc.addPage([612,792]);
  if(kind==='rotation')page.setRotation(degrees(90));
  if(kind==='crop')page.setCropBox(10,20,500,700);
  if(kind==='origin')page.setMediaBox(10,20,612,792);
  if(kind==='unit'){const {PDFName,PDFNumber}=await import('pdf-lib');page.node.set(PDFName.of('UserUnit'),PDFNumber.of(2));}
  const source=await doc.save(),manifest=await makeManifest(source,['Alice'],'any',[],[field()]);
  await assert.rejects(approvalPdf(source,manifest,[await approval(manifest,'r1','Alice')]),/Unsupported page geometry/);
 }
});
test('80-character in-page signature stays legible and inside its field',async()=>{
 const bytes=await syntheticPdf(),m=await makeManifest(bytes,['Alice'],'any',[],[field()]);
 const name='W'.repeat(80),a=await approval(m,'r1',name);
 const doc=await getDocument({data:await approvalPdf(bytes,m,[a]),useSystemFonts:true}).promise;
 try {const text=await (await doc.getPage(1)).getTextContent();
 const items=text.items.filter(i=>/^W+$/.test(i.str));
 assert.equal(items.map(i=>i.str).join(''),name);
 assert(items.every(i=>i.height>=8),'Signature name must not shrink to unreadable type');
 assert(items.every(i=>i.transform[4]>=60 && i.transform[4]+i.width<=280 && i.transform[5]>=114 && i.transform[5]+i.height<=160));
 }finally{await doc.destroy();}
});
const field=(recipientId='r1',x=60)=>({id:`f-${recipientId}`,recipientId,page:1,x,y:100,width:220,height:60});
const approval=async(m,id,name)=>({version:m.version,manifestHash:await manifestHash(m),documentHash:m.documentHash,recipientId:id,name,consent:true,claimedAt:'2026-10-12T18:00:00.000Z'});
test('positioned typed appearance on original page composes in manifest order',async()=>{
 const bytes=await syntheticPdf(),m=await makeManifest(bytes,['Alice','Bob'],'any',[],[field(),field('r2',320)]);
 const a=await approval(m,'r1','Alice Test'),b=await approval(m,'r2','Bob Test');
 const output=await approvalPdf(bytes,m,[b,a]);
 assert.deepEqual(output,await approvalPdf(bytes,m,[a,b]));
 const doc=await getDocument({data:output,useSystemFonts:true}).promise;
 try {const text=await (await doc.getPage(1)).getTextContent();
 for(const [name,x] of [['Alice Test',60],['Bob Test',320]]) {
  const item=text.items.find(i=>i.str===name);assert(item,'Name must appear on original page');
  assert(item.transform[4]>=x && item.transform[4]+item.width<=x+220);
  assert(item.transform[5]>=100 && item.transform[5]+item.height<=160);
 }
 }finally{await doc.destroy();}
});
