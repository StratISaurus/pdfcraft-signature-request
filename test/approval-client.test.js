import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { startLocalApp } from '../src/local-app.js';
import { syntheticPdf } from '../src/approval-pdf.js';
import * as client from '../src/approval-client.js';
import { toBase64, fromBase64, digest } from '../src/workflow.js';
import { PROTOCOL } from '../src/client-crypto.js';

test('sender rejects a substituted returned PDF even with a matching self-reported hash',async t=>{
  const app=await startLocalApp();t.after(()=>app.close());
  const sender=await client.prepareRequest(app.url,app.launchToken,await syntheticPdf(),['Alice'],'any',[],[{id:'f-r1',recipientId:'r1',page:1,x:60,y:100,width:220,height:60}]);
  const inv=sender.invitations[0],opened=await client.openInvitation(app.url,inv);
  const pdf=await syntheticPdf(); // Not the required original plus approval receipt.
  const approval={version:sender.version,manifestHash:inv.manifestHash,documentHash:sender.manifest.documentHash,recipientId:'r1',name:'Alice',consent:true,claimedAt:new Date().toISOString()};
  const response={version:sender.version,approval,pdf:toBase64(pdf),artifactHash:await digest(pdf)};
  const key=await crypto.subtle.importKey('raw',fromBase64(opened.responseKey),'AES-GCM',false,['encrypt']);
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:new TextEncoder().encode(PROTOCOL)},key,new TextEncoder().encode(JSON.stringify(response)));
  await client.api(app.url,`/api/requests/${sender.id}/recipients/r1/response`,inv.responseToken,'POST',{manifestHash:inv.manifestHash,payload:{protocol:PROTOCOL,nonce:toBase64(nonce),ciphertext:toBase64(new Uint8Array(ciphertext))}});
  await assert.rejects(client.collectApprovals(app.url,sender),/Artifact does not match/);
  const status=await client.api(app.url,`/api/requests/${sender.id}`,sender.adminToken);
  assert.equal(status.recipients[0].state,'submitted');
});

test('real HTTP encrypted PDF review, response and sender finalisation',async t=>{
  const app=await startLocalApp();t.after(()=>app.close());
  const original=await syntheticPdf();
  const sender=await client.prepareRequest(app.url,app.launchToken,original,['Alice','Bob'],'sequential');
  await assert.rejects(client.openInvitation(app.url,sender.invitations[1]),/stage_locked/);
  const opened=await client.openInvitation(app.url,sender.invitations[0]);
  assert.deepEqual(opened.pdf,original);
  await client.submitApproval(app.url,sender.invitations[0],opened,'Alice Test');
  let state=await client.collectApprovals(app.url,sender);
  assert.equal(state.approvals.length,1);
  await assert.rejects(client.finalise(sender,state.approvals),/Not all/);
  const second=await client.openInvitation(app.url,sender.invitations[1]);
  await client.submitApproval(app.url,sender.invitations[1],second,'Bob Test');
  state=await client.collectApprovals(app.url,sender);
  const final=await client.finalise(sender,state.approvals);
  assert.equal((await PDFDocument.load(final)).getPageCount(),4);
  assert.equal(state.artifacts.length,2);
  const swapped={...sender.invitations[0],key:sender.invitations[1].key};
  await assert.rejects(client.openInvitation(app.url,swapped));
});

for(const mode of ['any','grouped']) test(`${mode} recipients complete in allowed order with real encrypted PDF artifacts`,async t=>{
  const app=await startLocalApp();t.after(()=>app.close());
  const sender=await client.prepareRequest(app.url,app.launchToken,await syntheticPdf(),['First','Second','Third'],mode,[0,0,1],[0,1,2].map(i=>({id:`f-r${i+1}`,recipientId:`r${i+1}`,page:1,x:60,y:80+i*80,width:220,height:60})));
  for(const index of [1,0,2]) {
    if(mode==='grouped' && index!==2) await assert.rejects(client.openInvitation(app.url,sender.invitations[2]),/stage_locked/);
    const inv=sender.invitations[index],opened=await client.openInvitation(app.url,inv);
    await client.submitApproval(app.url,inv,opened,`Test Person ${index}`);
    await client.collectApprovals(app.url,sender);
  }
  const result=await client.collectApprovals(app.url,sender);
  const final=await client.finalise(sender,result.approvals);
  assert.equal((await PDFDocument.load(final)).getPageCount(),5);
  assert.equal(await digest(final),await digest(await client.finalise(sender,[...result.approvals].reverse())));
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const parsed=await getDocument({data:final,useSystemFonts:true}).promise;
  try {const text=await (await parsed.getPage(1)).getTextContent();for(const i of [0,1,2])assert(text.items.some(item=>item.str===`Test Person ${i}`));}finally{await parsed.destroy();}
});
