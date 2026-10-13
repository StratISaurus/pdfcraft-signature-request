import test from 'node:test';
test('expired relay request remains unrecoverable even with intact phrase and encrypted sender state',async t=>{
  const app=await startLocalApp({ttlMs:300});t.after(()=>app.close());
  const sender=await prepareRequest(app.url,app.launchToken,await syntheticPdf(),['Expired'],'any');
  const phrase=vault.generatePhrase(),backup=await vault.sealSender(app.url,sender,phrase);
  await new Promise(resolve=>setTimeout(resolve,350));
  const restored=await vault.openSender(backup,phrase,app.url);
  assert.deepEqual(restored.sender,sender);
  await assert.rejects(collectApprovals(app.url,restored.sender),/not_found/);
});

test('bounded local storage saves ciphertext only, does not overwrite other sessions or collisions',async t=>{
  const app=await startLocalApp();t.after(()=>app.close());
  const s=await prepareRequest(app.url,app.launchToken,await syntheticPdf(),['Storage'],'any');
  const b=await vault.sealSender(app.url,s,vault.generatePhrase());
  const map=new Map([['unrelated','keep']]);
  const storage={get length(){return map.size;},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};
  vault.saveBackup(storage,b);vault.saveBackup(storage,b);
  assert.equal(map.size,2);assert.equal(map.get('unrelated'),'keep');
  const changed=JSON.parse(b);changed.ciphertext=(changed.ciphertext[0]==='A'?'B':'A')+changed.ciphertext.slice(1);
  assert.throws(()=>vault.saveBackup(storage,JSON.stringify(changed)),/conflict/);
  for(let i=1;i<20;i++){const e=JSON.parse(b);e.id=crypto.randomUUID();vault.saveBackup(storage,JSON.stringify(e));}
  const e=JSON.parse(b);e.id=crypto.randomUUID();
  assert.throws(()=>vault.saveBackup(storage,JSON.stringify(e)),/limit/);
  assert.equal(map.size,21);
});

test('recovery rejects wrong phrase, every envelope tamper, origin forwarding, oversized and unknown states',async t=>{
  const app=await startLocalApp();t.after(()=>app.close());
  const sender=await prepareRequest(app.url,app.launchToken,await syntheticPdf(),['One'],'any');
  const phrase=vault.generatePhrase(),backup=await vault.sealSender(app.url,sender,phrase);
  await assert.rejects(vault.openSender(backup,vault.generatePhrase(),app.url));
  await assert.rejects(vault.openSender(backup,'123456',app.url));
  for(const key of ['version','id','kdf','salt','nonce','ciphertext']){
    const e=JSON.parse(backup);e[key]=(e[key][0]==='A'?'B':'A')+e[key].slice(1);
    await assert.rejects(vault.openSender(JSON.stringify(e),phrase,app.url),key);
  }
  await assert.rejects(vault.openSender(JSON.stringify({...JSON.parse(backup),extra:true}),phrase,app.url),/Invalid/);
  await assert.rejects(vault.openSender(backup,phrase,'http://127.0.0.1:1'),/origin/);
  await assert.rejects(vault.openSender(' '.repeat(vault.MAX_BACKUP_BYTES+1),phrase,app.url),/limit/);
  await assert.rejects(vault.sealSender(app.url,{...sender,version:'future'},phrase),/Invalid/);
  await assert.rejects(vault.sealSender(app.url,{...sender,pdf:new Uint8Array(180001)},phrase),/Invalid/);
  await assert.rejects(vault.sealSender(app.url,{...sender,adminToken:'123456'},phrase),/Invalid/);
  const swapped=structuredClone(sender);swapped.invitations[0].manifestHash='0'.repeat(64);
  await assert.rejects(vault.sealSender(app.url,swapped,phrase),/Invalid/);
});

import assert from 'node:assert/strict';
import * as vault from '../src/sender-vault.js';
import { startLocalApp } from '../src/local-app.js';
import { syntheticPdf } from '../src/approval-pdf.js';
import { prepareRequest, openInvitation, submitApproval, collectApprovals, finalise, api } from '../src/approval-client.js';

test('phrase plus encrypted backup restores complete sender state and continues sequential request',async t=>{
  const app=await startLocalApp();t.after(()=>app.close());
  const sender=await prepareRequest(app.url,app.launchToken,await syntheticPdf(),['One','Two'],'sequential');
  const phrase=vault.generatePhrase();assert.equal(phrase.split(' ').length,24);
  const backup=await vault.sealSender(app.url,sender,phrase);
  assert(!backup.includes(sender.adminToken));assert(!backup.includes(sender.invitations[0].key));assert(!backup.includes(phrase));
  const restored=await vault.openSender(backup,phrase,app.url);
  assert.deepEqual(restored.sender,sender);
  for(const inv of restored.sender.invitations){
    await submitApproval(app.url,inv,await openInvitation(app.url,inv),'Recovery Test');
    await collectApprovals(app.url,restored.sender);
  }
  assert((await finalise(restored.sender,(await collectApprovals(app.url,restored.sender)).approvals)).length>0);
  await api(app.url,`/api/requests/${sender.id}`,sender.adminToken,'DELETE');
  await assert.rejects(collectApprovals(app.url,(await vault.openSender(backup,phrase,app.url)).sender),/not_found/);
});
