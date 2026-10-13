import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import * as pdf from '../src/approval-pdf.js';
import { makeManifest, manifestHash } from '../src/workflow.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

test('80 wide characters remain complete inside receipt margins',async()=>{
  const bytes=await pdf.syntheticPdf(),m=await makeManifest(bytes,['Wide Name'],'any');
  const name='W'.repeat(80);
  const a={version:m.version,manifestHash:await manifestHash(m),documentHash:m.documentHash,recipientId:'r1',name,consent:true,claimedAt:'2026-10-12T18:00:00.000Z'};
  const parsed=await getDocument({data:await pdf.approvalPdf(bytes,m,[a]),useSystemFonts:true}).promise;
  try {
    const page=await parsed.getPage(3),text=await page.getTextContent();
    const items=text.items.filter(i=>i.str.trim());
    assert(items.map(i=>i.str).join('').includes('Typed approval: '+name),'Complete name must survive PDF text extraction');
    for(const item of items) {
      const x=item.transform[4],y=item.transform[5];
      assert(x>=40-0.01 && x+item.width<=572+0.01,`Receipt text exceeds horizontal margins: x=${x}, width=${item.width}`);
      assert(y>=40 && y+item.height<=752,'Receipt text exceeds vertical margins');
    }
  } finally {await parsed.destroy();}
});

test('synthetic PDF approval appends an honest receipt without changing original pages',async()=>{
  assert.equal(typeof pdf.syntheticPdf,'function');
  const bytes=await pdf.syntheticPdf();
  const m=await makeManifest(bytes,['Alice'],'any');
  const a={version:m.version,manifestHash:await manifestHash(m),documentHash:m.documentHash,recipientId:'r1',name:'Alice Test',consent:true,claimedAt:'2026-10-12T18:00:00.000Z'};
  const result=await pdf.approvalPdf(bytes,m,[a]);
  const loaded=await PDFDocument.load(result);
  assert.equal(loaded.getPageCount(),3);
  assert.equal(loaded.getPage(0).getWidth(),612);
  await assert.rejects(pdf.approvalPdf(bytes,m,[{...a,documentHash:'b'.repeat(64)}]));
  await assert.rejects(pdf.approvalPdf(bytes,m,[{...a,consent:false}]));
});
