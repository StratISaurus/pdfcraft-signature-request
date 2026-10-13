import { PDFDocument, StandardFonts, rgb, PDFName } from 'pdf-lib';
import { VERSION, digest, manifestHash, validateManifest } from './workflow.js';
export async function inspectPdf(bytes) {
  if (bytes.length > 180000) throw Error('Demo limit: 180 KB per PDF');
  if (new TextDecoder('latin1').decode(bytes).includes('/ByteRange')) throw Error('Existing digital signatures are not supported');
  const doc=await PDFDocument.load(bytes,{updateMetadata:false});
  if (doc.getPageCount()<1 || doc.getPageCount()>10) throw Error('Demo limit: 1 to 10 pages');
  return doc;
}
export function validateFields(doc,m) {
  validateManifest(m);
  for(const f of m.fields || []) {
    if(f.page>doc.getPageCount()) throw Error('Signature field page out of bounds');
    const p=doc.getPage(f.page-1),media=p.getMediaBox(),crop=p.getCropBox();
    const unit=p.node.get(PDFName.of('UserUnit'));
    if(p.getRotation().angle!==0 || media.x!==0 || media.y!==0 || ['x','y','width','height'].some(k=>crop[k]!==media[k]) || (unit && unit.asNumber?.()!==1)) throw Error('Unsupported page geometry: fields require unrotated, uncropped, zero-origin pages with UserUnit 1');
    if(!Number.isFinite(media.width) || !Number.isFinite(media.height) || f.x+f.width>media.width || f.y+f.height>media.height) throw Error('Signature field out of bounds');
  }
}
export async function syntheticPdf() {
  const doc=await PDFDocument.create();
  const font=await doc.embedFont(StandardFonts.Helvetica);
  for (let i=0;i<2;i++) {
    const p=doc.addPage([612,792]);
    p.drawRectangle({x:40,y:675,width:532,height:65,color:rgb(.08,.2,.25)});
    p.drawText(i===0?'SYNTHETIC SERVICE AGREEMENT':'SYNTHETIC TERMS - PAGE 2',{x:58,y:700,size:19,font,color:rgb(1,1,1)});
    const lines=i===0?['Local demonstration only. No real parties or obligations.','Project: sample document approval','Scope: Review both pages, then record electronic consent.','Amount: no payment or financial obligation.']:['All names and contents in this sample are fictional.','Recipients approve the same immutable original document.','An approval receipt will be appended as a separate page.','This is not a certificate-based digital PDF signature.'];
    lines.forEach((text,j)=>p.drawText(text,{x:50,y:620-j*38,size:13,font}));
    p.drawText(`Page ${i+1} of 2 | Generated locally`,{x:50,y:45,size:10,font});
  }
  return doc.save();
}
export async function validateApproval(a,m) {
  validateManifest(m);
  if (!a || a.version!==VERSION || a.manifestHash!==await manifestHash(m) || a.documentHash!==m.documentHash || !m.recipients.some(r=>r.id===a.recipientId) || a.consent!==true || typeof a.name!=='string' || !/^[\x20-\x7e]{1,80}$/.test(a.name) || !a.name.trim() || typeof a.claimedAt!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(a.claimedAt) || !Number.isFinite(Date.parse(a.claimedAt))) throw Error('Approval binding or consent is invalid');
  return a;
}
export async function approvalPdf(bytes,m,approvals) {
  if (await digest(bytes)!==m.documentHash) throw Error('Document hash mismatch');
  const doc=await inspectPdf(bytes), font=await doc.embedFont(StandardFonts.Helvetica);
  validateFields(doc,m);
  const ids=new Set();
  for(const a of [...approvals].sort((a,b)=>m.recipients.findIndex(r=>r.id===a.recipientId)-m.recipients.findIndex(r=>r.id===b.recipientId))) {
    await validateApproval(a,m);
    if(ids.has(a.recipientId)) throw Error('Duplicate approval');ids.add(a.recipientId);
    for(const f of (m.fields || []).filter(f=>f.recipientId===a.recipientId)) {
      const page=doc.getPage(f.page-1);
      page.drawRectangle({x:f.x,y:f.y,width:f.width,height:f.height,borderWidth:1,borderColor:rgb(.08,.3,.35)});
      let size=18,lines;
      for(;size>=8;size--) {
        lines=[''];
        for(const ch of a.name) {
          if(font.widthOfTextAtSize(lines.at(-1)+ch,size)>f.width-12)lines.push('');
          lines[lines.length-1]+=ch;
        }
        if(lines.length*(size+2)<=f.height-20)break;
      }
      if(size<8)throw Error('Signature field too small for legible name');
      lines.forEach((line,i)=>page.drawText(line,{x:f.x+6,y:f.y+f.height-6-size-i*(size+2),size,font,color:rgb(.08,.3,.35)}));
      page.drawText('Electronic approval - '+a.recipientId,{x:f.x+6,y:f.y+6,size:8,font});
    }
    const p=doc.addPage([612,792]);
    p.drawText('ELECTRONIC APPROVAL RECEIPT',{x:40,y:732,size:20,font,color:rgb(.08,.3,.35)});
    const lines=['Local experimental demo - not a trusted digital PDF signature.',`Typed approval: ${a.name}`,`Recipient slot: ${a.recipientId}`,`Claimed device time: ${a.claimedAt}`,'Consent: I reviewed this document and approve it electronically.','Identity and timestamp are self-asserted; no email/SMS verification.','Original PDF SHA-256:',m.documentHash,'Manifest SHA-256:',a.manifestHash,'Approvals bind to the original; no native signatures were merged.'];
    const margin=40, maxWidth=p.getWidth()-2*margin;
    let y=685;
    lines.forEach((text,i)=>{
      const size=i===7||i===9?10:11;
      let line='';
      // Character wrapping also handles maximum-length names without spaces.
      for(const character of text) {
        if(font.widthOfTextAtSize(line+character,size)>maxWidth) {
          p.drawText(line,{x:margin,y,size,font});y-=18;line='';
        }
        line+=character;
      }
      p.drawText(line,{x:margin,y,size,font});y-=33;
    });
  }
  return doc.save();
}
