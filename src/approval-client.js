import { encryptBytes, decryptBytes, PROTOCOL } from './client-crypto.js';
import { makeManifest, manifestHash, digest, toBase64, fromBase64, VERSION } from './workflow.js';
import { inspectPdf, approvalPdf, validateApproval, validateFields } from './approval-pdf.js';
const encoder=new TextEncoder();
const token=()=>toBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const jsonBytes=o=>encoder.encode(JSON.stringify(o));
export async function api(origin,path,capability,method='GET',body) {
  const res=await fetch(origin+path,{method,headers:{Authorization:`Bearer ${capability}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store',referrerPolicy:'no-referrer'});
  if (!res.ok) {const error=await res.json();throw Error(error.error || `HTTP ${res.status}`);}
  return res.status===204?null:res.json();
}
async function seal(value,encodedKey) {
  const key=await crypto.subtle.importKey('raw',fromBase64(encodedKey),'AES-GCM',false,['encrypt']);
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:encoder.encode(PROTOCOL),tagLength:128},key,jsonBytes(value));
  return {protocol:PROTOCOL,nonce:toBase64(nonce),ciphertext:toBase64(new Uint8Array(ciphertext))};
}
const unseal=async(payload,key)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await decryptBytes(payload,key)));
export async function prepareRequest(origin,bootstrap,pdf,labels,mode,stages=[],fields=[]) {
  const doc=await inspectPdf(pdf);
  const manifest=await makeManifest(pdf,labels,mode,stages,fields), binding=await manifestHash(manifest);
  validateFields(doc,manifest);
  const invitations=[],routes=[];
  for(const r of manifest.recipients) {
    const responseKey=toBase64(crypto.getRandomValues(new Uint8Array(32)));
    const {key,payload}=await encryptBytes(jsonBytes({version:VERSION,manifest,pdf:toBase64(pdf),recipientId:r.id,responseKey}));
    const readToken=token(),responseToken=token();
    invitations.push({version:VERSION,recipientId:r.id,manifestHash:binding,key,readToken,responseToken});
    routes.push({id:r.id,stage:r.stage,readToken,responseToken,payload});
    invitations[invitations.length-1].responseKey=responseKey;
  }
  const created=await api(origin,'/api/requests',bootstrap,'POST',{version:VERSION,manifestHash:binding,recipients:routes});
  return {version:VERSION,id:created.id,adminToken:created.adminToken,manifest,pdf,
    invitations:invitations.map(inv=>({...inv,id:created.id}))};
}
export function invitationFragment(inv) {
  // Return key travels only inside the encrypted request, not a second clear URL field.
  const {responseKey,...publicInvitation}=inv;
  return '#invite='+encodeURIComponent(JSON.stringify(publicInvitation));
}
export async function openInvitation(origin,inv) {
  if(inv.version!==VERSION || !/^[a-f0-9]{32}$/.test(inv.id) || !/^r[1-9][0-9]?$/.test(inv.recipientId)) throw Error('Unsupported invitation');
  const data=await api(origin,`/api/requests/${inv.id}/recipients/${inv.recipientId}`,inv.readToken);
  if(data.manifestHash!==inv.manifestHash) throw Error('Manifest binding mismatch');
  const bundle=await unseal(data.payload,inv.key), pdf=fromBase64(bundle.pdf);
  if(bundle.version!==VERSION || bundle.recipientId!==inv.recipientId || await manifestHash(bundle.manifest)!==inv.manifestHash || await digest(pdf)!==bundle.manifest.documentHash) throw Error('Document or manifest binding mismatch');
  validateFields(await inspectPdf(pdf),bundle.manifest);
  return {...bundle,pdf,state:data.state};
}
export async function submitApproval(origin,inv,opened,name) {
  const approval={version:VERSION,manifestHash:inv.manifestHash,documentHash:opened.manifest.documentHash,recipientId:inv.recipientId,name:name.trim(),consent:true,claimedAt:new Date().toISOString()};
  const pdf=await approvalPdf(opened.pdf,opened.manifest,[approval]);
  const response={version:VERSION,approval,pdf:toBase64(pdf),artifactHash:await digest(pdf)};
  await api(origin,`/api/requests/${inv.id}/recipients/${inv.recipientId}/response`,inv.responseToken,'POST',{manifestHash:inv.manifestHash,payload:await seal(response,opened.responseKey)});
  return pdf;
}
export async function collectApprovals(origin,sender) {
  const base=`/api/requests/${sender.id}`,state=await api(origin,base,sender.adminToken);
  const binding=await manifestHash(sender.manifest),approvals=[],artifacts=[];
  if(state.manifestHash!==binding) throw Error('Manifest binding mismatch');
  for(const r of state.recipients) {
    if(!r.response) continue;
    const inv=sender.invitations.find(inv=>inv.recipientId===r.id);
    const response=await unseal(r.response,inv.responseKey);
    await validateApproval(response.approval,sender.manifest);
    if(response.version!==VERSION || response.approval.recipientId!==r.id) throw Error('Recipient binding mismatch');
    const pdf=fromBase64(response.pdf);
    if(pdf.length>400000 || await digest(pdf)!==response.artifactHash) throw Error('Artifact hash mismatch');
    const expected=await approvalPdf(sender.pdf,sender.manifest,[response.approval]);
    if(await digest(expected)!==response.artifactHash) throw Error('Artifact does not match original and approval');
    approvals.push(response.approval);artifacts.push({recipientId:r.id,pdf});
    // Only the authorised sender can validate encrypted evidence and unlock later stages.
    if(r.state==='submitted') {await api(origin,base+`/accept/${r.id}`,sender.adminToken,'POST',{manifestHash:binding});r.state='accepted';}
  }
  return {...state,approvals,artifacts};
}
export async function finalise(sender,approvals) {
  const ids=new Set(approvals.map(a=>a.recipientId));
  if(ids.size!==sender.manifest.recipients.length || !sender.manifest.recipients.every(r=>ids.has(r.id))) throw Error('Not all recipients have approved');
  return approvalPdf(sender.pdf,sender.manifest,approvals);
}
