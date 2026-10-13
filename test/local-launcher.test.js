import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startLocalApp } from '../src/local-app.js';

// Use actual HTTP headers: fetch implementations can rewrite Fetch Metadata.
function call(app, path, {method='GET', headers={}, body}={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request(app.url+path,{method,headers},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });
    req.on('error',reject);req.end(body);
  });
}
const navigation={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
const assets=new Map([
  ['/',{type:'text/html',bytes:'<!doctype html><title>Public shell</title>'}],
  ['/app.js',{type:'text/javascript',bytes:'// public script'}],
]);

test('launcher exception is only a bodyless root document GET; Host and explicit Origin still fail closed',async t=>{
  const app=await startLocalApp({assets});t.after(()=>app.close());
  const accepted=await call(app,'/',{headers:navigation});
  assert.equal(accepted.status,200);
  assert.equal(accepted.headers['referrer-policy'],'no-referrer');
  assert.equal(accepted.headers['cache-control'],'no-store');
  assert.match(accepted.headers['content-security-policy'],/frame-ancestors 'none'/);
  assert.equal(accepted.headers['access-control-allow-origin'],undefined);
  for(const path of ['/app.js','/health','/api/requests','/missing','/?setup=synthetic']) {
    assert.equal((await call(app,path,{headers:navigation})).status,403,path);
  }
  for(const extra of [
    {'Sec-Fetch-Mode':'cors'}, {'Sec-Fetch-Mode':'no-cors'},
    {'Sec-Fetch-Dest':'iframe'}, {'Sec-Fetch-Dest':'empty'},
    {Origin:'null'}, {Origin:'https://attacker.invalid'},
    {Host:'attacker.invalid'}, {Host:'localhost'},
  ]) assert.equal((await call(app,'/',{headers:{...navigation,...extra}})).status,403);
  assert.equal((await call(app,'/',{method:'POST',headers:navigation})).status,403);
  assert.equal((await call(app,'/',{method:'HEAD',headers:navigation})).status,403);
  assert.equal((await call(app,'/',{headers:{...navigation,'Content-Length':'1'},body:'x'})).status,400);
  assert.equal((await call(app,'/',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
});

test('all API methods retain hostile/null Origin, cross-site and Host rejection even with navigation metadata and a valid bearer',async t=>{
  const app=await startLocalApp({assets});t.after(()=>app.close());
  const authorization=`Bearer ${app.launchToken}`;
  for(const path of ['/api/requests','/api/requests/'+'a'.repeat(32)]) {
    for(const method of ['GET','POST','DELETE','OPTIONS']) {
      for(const hostile of [
        {Origin:'https://attacker.invalid'}, {Origin:'null'},
        {'Sec-Fetch-Site':'cross-site'}, navigation,
        {Host:'attacker.invalid'}, {Host:'localhost'},
        {...navigation,Host:'attacker.invalid'},
      ]) {
        const result=await call(app,path,{method,headers:{Authorization:authorization,...hostile}});
        assert.equal(result.status,403);
        assert.equal(result.body,JSON.stringify({error:'origin_or_host_forbidden'}));
        assert.equal(result.headers['access-control-allow-origin'],undefined);
      }
    }
  }
  // Same-origin reaches API authentication/validation, not the navigation exception.
  const allowed=await call(app,'/api/requests',{method:'POST',headers:{
    Origin:app.url,'Sec-Fetch-Site':'same-origin',Authorization:authorization,'Content-Type':'application/json',
  },body:'{}'});
  assert.equal(allowed.status,400);
  assert.equal(allowed.body,JSON.stringify({error:'invalid_request'}));
  assert.equal((await call(app,'/api/requests',{method:'POST',headers:{Origin:app.url}})).status,401);
});
