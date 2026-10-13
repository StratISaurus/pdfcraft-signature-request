import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalApp } from '../src/local-app.js';
import { encryptBytes } from '../src/client-crypto.js';
import { randomBytes } from 'node:crypto';

for (const invalidation of ['expiry','revoke']) {
  test(`delayed chunked submission rejects ${invalidation}`,async t=>{
    await delayedMutation(t,'submission',invalidation);
  });
  test(`delayed chunked acceptance rejects ${invalidation}`,async t=>{
    await delayedMutation(t,'acceptance',invalidation);
  });
}

async function delayedMutation(t,operation,invalidation) {
  const app=await startLocalApp({ttlMs:invalidation==='expiry'?500:10000});
  t.after(()=>app.close());
  const token=()=>randomBytes(32).toString('base64url');
  const {payload}=await encryptBytes(new Uint8Array([1,2,3]));
  const recipient={id:'r1',stage:0,readToken:token(),responseToken:token(),payload};
  const manifestHash='a'.repeat(64);
  const call=(path,credential,method='GET',body)=>fetch(app.url+path,{method,headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
  const created=await call('/api/requests',app.launchToken,'POST',{version:'pdfcraft-approval-v1',manifestHash,recipients:[recipient]});
  assert.equal(created.status,201);
  const {id,adminToken}=await created.json(),base=`/api/requests/${id}`;
  const responsePath=base+'/recipients/r1/response';
  if(operation==='acceptance') assert.equal((await call(responsePath,recipient.responseToken,'POST',{manifestHash,payload})).status,201);
  const body=JSON.stringify(operation==='acceptance'?{manifestHash}:{manifestHash,payload});
  let request;
  const result=new Promise((resolve,reject)=>{
    request=http.request(app.url+(operation==='acceptance'?base+'/accept/r1':responsePath),{method:'POST',headers:{Authorization:`Bearer ${operation==='acceptance'?adminToken:recipient.responseToken}`,'Content-Type':'application/json','Transfer-Encoding':'chunked',Expect:'100-continue'}},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
    });
    request.on('error',reject);
  });
  t.after(()=>request.destroy());
  await new Promise(resolve=>{request.once('continue',resolve);request.flushHeaders();});
  request.write(body.slice(0,-1));
  // Keep a real HTTP body incomplete while the record becomes unusable.
  await delay(invalidation==='expiry'?750:75);
  if(invalidation==='revoke') assert.equal((await call(base,adminToken,'DELETE')).status,204);
  request.end(body.slice(-1));
  assert.deepEqual(await result,{status:404,body:{error:'not_found'}});
  assert.equal((await call(base,adminToken)).status,404);
}
