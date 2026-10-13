import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { startRelay } from '../src/relay.js';
import { startLocalApp } from '../src/local-app.js';

for(const [name,start] of [['relay',()=>startRelay({port:0,bootstrapToken:randomBytes(32).toString('base64url')})],['browser app',()=>startLocalApp({port:0})]]) {
  test(`${name} never publishes a Fetch-blocked ephemeral port`,async()=>{
    // Reproduce this host's 1024..65534 dynamic range deterministically with a real socket.
    const original=http.Server.prototype.listen;let allocated=false,app;
    http.Server.prototype.listen=function(port,...args){
      if(port===0 && !allocated){allocated=true;return original.call(this,2049,...args);}
      return original.call(this,port,...args);
    };
    try {
      app=await start();assert(allocated);
      assert.notEqual(new URL(app.url).port,'2049','OS allocation must be checked before publishing');
      const response=await fetch(app.url+'/health');await response.text();
    } finally {http.Server.prototype.listen=original;await app?.close();}
  });
}
