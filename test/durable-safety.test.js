import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { openDurableStore } from '../src/durable-store.js';
import { startLocalApp } from '../src/local-app.js';
import { encryptBytes } from '../src/client-crypto.js';
const token=()=>randomBytes(32).toString('base64url');
async function fixture(t,options={}) {
  const storageDir=await mkdtemp(join(tmpdir(),'pdfcraft-store-safety-'));let app;
  let connection;
  const start=async()=>{
    const prepare=DatabaseSync.prototype.prepare;
    const spy=t.mock.method(DatabaseSync.prototype,'prepare',function(...args){connection=this;return prepare.apply(this,args);});
    try {return app=await startLocalApp({storageDir,trustedLocalAccount:true,...options});}finally{spy.mock.restore();}
  };
  const stop=async()=>{await app?.close();app=null;};
  t.after(async()=>{await stop();await rm(storageDir,{recursive:true,force:true});});await start();
  const call=(path,cap,method='GET',body)=>fetch(app.url+path,{method,headers:{Connection:'close',Authorization:`Bearer ${cap}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const {payload}=await encryptBytes(new TextEncoder().encode('PRIVATE safety sentinel'));
  const recipients=[{id:'r1',stage:0,readToken:token(),responseToken:token(),payload}];const manifestHash='b'.repeat(64);
  return {storageDir,path:join(storageDir,'relay.sqlite'),exec:sql=>connection.exec(sql),start,stop,call,payload,recipients,manifestHash,create:()=>call('/api/requests',app.launchToken,'POST',{version:'pdfcraft-approval-v1',manifestHash,recipients})};
}
test('process death during an uncommitted SQLite write rolls back without partial publication',{timeout:20000},async t=>{
  const f=await fixture(t);const created=await (await f.create()).json();await f.stop();
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import { DatabaseSync } from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=10; BEGIN IMMEDIATE;');
    db.prepare('UPDATE records SET value=?').run('incomplete'.repeat(400000));
    process.stdout.write('transaction-open');setInterval(()=>{},1000);
  `,f.path],{stdio:['ignore','pipe','ignore']});
  const exited=once(child,'exit');t.after(()=>child.kill());
  await once(child.stdout,'data');assert((await readFile(f.path+'-journal')).length>0);
  child.kill('SIGKILL');await exited;await f.start();
  const r=await f.call(`/api/requests/${created.id}`,created.adminToken);assert.equal(r.status,200);assert.equal((await r.json()).recipients[0].state,'waiting');
});

test('invalid opt-in paths never silently fall back to ephemeral storage',async()=>{
  for(const storageDir of ['',null,false,'relative/path']){
    let unexpected;
    try {await assert.rejects(async()=>{unexpected=await startLocalApp({storageDir,trustedLocalAccount:true});},/configuration/);}
    finally {await unexpected?.close();}
  }
});

test('explicit trusted-account boundary and single owning process are required',async t=>{
  const f=await fixture(t);
  await assert.rejects(openDurableStore(f.storageDir,false),/trustedLocalAccount/);
  await assert.rejects(openDurableStore(f.storageDir,true),/locked/);
});
for(const damage of ['header','truncate','empty'])test(`corrupt ${damage} fails closed without replacing the store`,async t=>{
  const f=await fixture(t);await f.create();await f.stop();let bytes=await readFile(f.path);
  bytes=damage==='header'?Buffer.from('not a SQLite database'.repeat(50)):damage==='truncate'?bytes.subarray(0,512):Buffer.alloc(0);
  await writeFile(f.path,bytes);await assert.rejects(f.start());assert.deepEqual(await readFile(f.path),bytes);
});
test('revocation and expired records are deleted on disk and stay absent after restart',async t=>{
  const f=await fixture(t,{ttlMs:200});let res=await f.create();const first=await res.json();
  assert.equal((await f.call(`/api/requests/${first.id}`,first.adminToken,'DELETE')).status,204);
  const second=await (await f.create()).json();await f.stop();await new Promise(r=>setTimeout(r,240));await f.start();
  for(const r of [first,second])assert.equal((await f.call(`/api/requests/${r.id}`,r.adminToken)).status,404);
  await f.stop();const db=new DatabaseSync(f.path);assert.equal(db.prepare('SELECT count(*) n FROM records').get().n,0);db.close();
  const disk=await readFile(f.path);assert(!disk.includes(Buffer.from(f.payload.ciphertext)),'Deleted ciphertext remains in SQLite pages');
  assert.deepEqual(await readdir(f.storageDir),['relay.sqlite']);
});
test('creation count and exact serialized quota survive restart; oversized submission is not published',async t=>{
  const f=await fixture(t,{maxStorageBytes:2000});const created=await (await f.create()).json();const base=`/api/requests/${created.id}`;
  const {payload}=await encryptBytes(new Uint8Array(1500));
  assert.equal((await f.call(base+'/recipients/r1/response',f.recipients[0].responseToken,'POST',{manifestHash:f.manifestHash,payload})).status,507);
  assert.equal((await (await f.call(base,created.adminToken)).json()).recipients[0].state,'waiting');
  await f.stop();await f.start();assert.equal((await (await f.call(base,created.adminToken)).json()).recipients[0].state,'waiting');
  await f.stop();await assert.rejects(openDurableStore(f.storageDir,true,1),/capacity/);
  const g=await fixture(t);for(let i=0;i<20;i++)assert.equal((await g.create()).status,201);
  await g.stop();await g.start();assert.equal((await g.create()).status,507);
});
for(const operation of ['create','submit','accept','delete'])test(`SQLite ignored ${operation} never acknowledges or publishes and rolls back trigger side effects`,async t=>{
  const f=await fixture(t);const created=await (await f.create()).json(),base=`/api/requests/${created.id}`;
  const submit=()=>f.call(base+'/recipients/r1/response',f.recipients[0].responseToken,'POST',{manifestHash:f.manifestHash,payload:f.payload});
  if(operation==='accept')assert.equal((await submit()).status,201);
  const expected=operation==='accept'?'submitted':'waiting';
  // Capture the real owning connection only in the test. No production schema bypass.
  // Side effects before IGNORE expose an autocommit-then-check implementation.
  f.exec(`CREATE TRIGGER ignored BEFORE ${operation==='delete'?'DELETE':'INSERT'} ON records BEGIN UPDATE records SET value='invalid side effect'; SELECT RAISE(IGNORE); END;`);
  const response=operation==='create'?await f.create():operation==='submit'?await submit():operation==='accept'?await f.call(base+'/accept/r1',created.adminToken,'POST',{manifestHash:f.manifestHash}):await f.call(base,created.adminToken,'DELETE');
  assert.equal(response.status,503);
  assert.equal((await (await f.call(base,created.adminToken)).json()).recipients[0].state,expected);
  f.exec('DROP TRIGGER ignored');await f.stop();await f.start();
  assert.equal((await (await f.call(base,created.adminToken)).json()).recipients[0].state,expected);
  await f.stop();const db=new DatabaseSync(f.path);assert.equal(db.prepare('SELECT count(*) n FROM records').get().n,1);db.close();
});

test('SQLite write failure never publishes a submission or acceptance to RAM or disk',async t=>{
  const f=await fixture(t);const created=await (await f.create()).json();const base=`/api/requests/${created.id}`;
  function trigger(condition) {f.exec(`DROP TRIGGER IF EXISTS deny; CREATE TRIGGER deny BEFORE INSERT ON records WHEN ${condition} BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;`);}
  const submit=()=>f.call(base+'/recipients/r1/response',f.recipients[0].responseToken,'POST',{manifestHash:f.manifestHash,payload:f.payload});
  const state=async()=>(await (await f.call(base,created.adminToken)).json()).recipients[0].state;
  await trigger('1');assert.equal((await submit()).status,503);assert.equal(await state(),'waiting');
  f.exec('DROP TRIGGER deny');await f.stop();await f.start();assert.equal(await state(),'waiting');
  await trigger(`instr(NEW.value,'accepted')>0`);assert.equal((await submit()).status,201);
  assert.equal((await f.call(base+'/accept/r1',created.adminToken,'POST',{manifestHash:f.manifestHash})).status,503);assert.equal(await state(),'submitted');
  f.exec('DROP TRIGGER deny');await f.stop();await f.start();assert.equal(await state(),'submitted');
});
