import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { toBase64, fromBase64, VERSION, manifestHash, digest } from './workflow.js';
import { inspectPdf, validateFields } from './approval-pdf.js';
const VERSION_VAULT='pdfcraft-sender-vault-v1', KDF='HKDF-SHA-256-BIP39-entropy';
const enc=new TextEncoder(), dec=new TextDecoder('utf-8',{fatal:true});
export const MAX_BACKUP_BYTES=1024*1024;
export const STORAGE_PREFIX='pdfcraft.sender-vault.v1.';
export function generatePhrase(){return entropyToMnemonic(crypto.getRandomValues(new Uint8Array(32)),wordlist);}
async function derive(phrase,salt){
  const entropy=mnemonicToEntropy(phrase,wordlist);
  if(entropy.length!==32)throw Error('A 24-word recovery phrase is required');
  const material=await crypto.subtle.importKey('raw',entropy,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:fromBase64(salt),info:enc.encode(VERSION_VAULT)},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
const exact=(o,keys)=>o && typeof o==='object' && !Array.isArray(o) && Object.keys(o).sort().join(',')===keys;
const invalid=()=>{throw Error('Invalid sender vault');};
function b64(value,length){
  if(typeof value!=='string')invalid();
  let bytes;try{bytes=fromBase64(value);}catch{invalid();}
  if(toBase64(bytes)!==value || (length!==undefined && bytes.length!==length))invalid();
  return bytes;
}
function envelopeFrom(backup){
  if(typeof backup!=='string' || backup.length>MAX_BACKUP_BYTES)throw Error('Backup exceeds size limit');
  let e;try{e=JSON.parse(backup);}catch{invalid();}
  if(!exact(e,'ciphertext,id,kdf,nonce,salt,version') || e.version!==VERSION_VAULT || e.kdf!==KDF || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(e.id))invalid();
  b64(e.salt,32);b64(e.nonce,12);
  const bytes=b64(e.ciphertext);if(bytes.length<16 || bytes.length>512*1024+16)invalid();
  return e;
}
async function validateState(state,origin){
  if(!exact(state,'origin,sender,version') || state.version!=='pdfcraft-sender-state-v1')invalid();
  if(state.origin!==origin)throw Error('Vault origin differs from this relay; automatic credential forwarding refused');
  let url;try{url=new URL(origin);}catch{invalid();}
  if(url.origin!==origin || !['http:','https:'].includes(url.protocol))invalid();
  const s=state.sender;
  if(!exact(s,'adminToken,id,invitations,manifest,pdf,version') || s.version!==VERSION || !/^[a-f0-9]{32}$/.test(s.id))invalid();
  const capability=t=>{if(typeof t!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(t))invalid();b64(t.replaceAll('-','+').replaceAll('_','/')+'=',32);};
  capability(s.adminToken);
  const pdf=b64(s.pdf);if(!pdf.length || pdf.length>180000)invalid();
  if(!Array.isArray(s.invitations) || s.invitations.length<1 || s.invitations.length>12)invalid();
  const binding=await manifestHash(s.manifest);
  if(await digest(pdf)!==s.manifest.documentHash || s.invitations.length!==s.manifest.recipients.length)invalid();
  for(const [i,inv] of s.invitations.entries()){
    if(!exact(inv,'id,key,manifestHash,readToken,recipientId,responseKey,responseToken,version') || inv.version!==VERSION || inv.id!==s.id || inv.recipientId!==s.manifest.recipients[i].id || inv.manifestHash!==binding)invalid();
    b64(inv.key,32);b64(inv.responseKey,32);capability(inv.readToken);capability(inv.responseToken);
  }
  validateFields(await inspectPdf(pdf),s.manifest);
  return {...state,sender:{...s,pdf}};
}
const aad=e=>enc.encode(JSON.stringify([e.version,e.id,e.kdf,e.salt]));
export async function sealSender(origin,sender,phrase){
  const state={version:'pdfcraft-sender-state-v1',origin,sender:{...sender,pdf:toBase64(sender.pdf)}};
  if(enc.encode(JSON.stringify(state)).length>512*1024)throw Error('Backup exceeds size limit');
  await validateState(state,origin);
  const envelope={version:VERSION_VAULT,id:crypto.randomUUID(),kdf:KDF,salt:toBase64(crypto.getRandomValues(new Uint8Array(32))),nonce:toBase64(crypto.getRandomValues(new Uint8Array(12)))};
  const key=await derive(phrase,envelope.salt);
  envelope.ciphertext=toBase64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:fromBase64(envelope.nonce),additionalData:aad(envelope),tagLength:128},key,enc.encode(JSON.stringify(state)))));
  return JSON.stringify(envelope);
}
// Call under the browser Web Lock to bound concurrent sender tabs atomically.
export function saveBackup(storage,backup){
  const e=envelopeFrom(backup),key=STORAGE_PREFIX+e.id,old=storage.getItem(key);
  if(old!==null){if(old!==backup)throw Error('Local vault conflict; refusing to overwrite');return e.id;}
  let count=0,total=backup.length;
  for(let i=0;i<storage.length;i++){
    const k=storage.key(i);if(k?.startsWith(STORAGE_PREFIX)){count++;total+=(storage.getItem(k)||'').length;}
  }
  if(count>=20 || total>4*1024*1024)throw Error('Local vault storage limit reached; export backups before clearing browser storage');
  storage.setItem(key,backup);return e.id;
}
export async function openSender(backup,phrase,origin){
  const envelope=envelopeFrom(backup),key=await derive(phrase,envelope.salt);
  const state=JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64(envelope.nonce),additionalData:aad(envelope),tagLength:128},key,fromBase64(envelope.ciphertext))));
  return {id:envelope.id,...await validateState(state,origin)};
}
