import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDurableStore } from '../src/durable-store.js';
const canonical='CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL)';
for(const [name,sql] of Object.entries({
  trigger:"CREATE TRIGGER ignored BEFORE INSERT ON records BEGIN SELECT RAISE(IGNORE); END",
  view:'CREATE VIEW extra AS SELECT id FROM records',
  table:'CREATE TABLE extra (id TEXT)',
  index:'CREATE INDEX extra ON records(value)',
  extraColumn:'ALTER TABLE records ADD COLUMN extra TEXT',
  missingPK:'DROP TABLE records; CREATE TABLE records (id TEXT, value TEXT NOT NULL)',
  compositePK:'DROP TABLE records; CREATE TABLE records (id TEXT, value TEXT NOT NULL, PRIMARY KEY(id,value))',
  nullableValue:'DROP TABLE records; CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT)',
  uniqueValue:'DROP TABLE records; CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL UNIQUE)',
  checkConstraint:"DROP TABLE records; CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(value != ''))",
  collation:'DROP TABLE records; CREATE TABLE records (id TEXT PRIMARY KEY COLLATE NOCASE, value TEXT NOT NULL)',
  generated:'ALTER TABLE records ADD COLUMN extra TEXT GENERATED ALWAYS AS (id) VIRTUAL',
  withoutRowid:canonical.replace('CREATE TABLE records','DROP TABLE records; CREATE TABLE records')+' WITHOUT ROWID',
}))test(`schema drift ${name} fails closed without overwriting database`,async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pdfcraft-schema-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const initial=await openDurableStore(dir,true);initial.close();
  const path=join(dir,'relay.sqlite'),db=new DatabaseSync(path);db.exec(sql);db.close();
  const before=await readFile(path);let opened;
  try {await assert.rejects(async()=>{opened=await openDurableStore(dir,true);},/schema/i);}finally{opened?.close();}
  assert.deepEqual(await readFile(path),before);
});
test('lstat detects a dangling database entry even when existsSync says absent',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pdfcraft-link-model-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'relay.sqlite'),original=fs.lstatSync;let opened;
  const spy=t.mock.method(fs,'lstatSync',function(p,...args){return p===path?{isFile:()=>false,isSymbolicLink:()=>true}:original(p,...args);});
  syncBuiltinESMExports();
  try {await assert.rejects(async()=>{opened=await openDurableStore(dir,true);},/database file/);}
  finally{opened?.close();spy.mock.restore();syncBuiltinESMExports();}
  await assert.rejects(lstat(path),{code:'ENOENT'});
});
test('dangling database symlink is rejected without creating its target',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pdfcraft-link-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const target=join(dir,'absent.sqlite'),path=join(dir,'relay.sqlite');
  try {await symlink(target,path,'file');}catch(e){if(e.code==='EPERM'){t.skip('OS denies file symlink creation; deterministic lstat regression runs separately');return;}throw e;}let opened;
  try {await assert.rejects(async()=>{opened=await openDurableStore(dir,true);},/database file/);}finally{opened?.close();}
  assert((await lstat(path)).isSymbolicLink());await assert.rejects(lstat(target),{code:'ENOENT'});
});
for(const pageSize of [512,4096,65536])test(`physical file limit accounts for ${pageSize}-byte SQLite pages`,async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pdfcraft-pages-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const db=new DatabaseSync(join(dir,'relay.sqlite'));db.exec(`PRAGMA page_size=${pageSize}; ${canonical}; PRAGMA user_version=1;`);db.close();
  let connection;const prepare=DatabaseSync.prototype.prepare;
  const spy=t.mock.method(DatabaseSync.prototype,'prepare',function(...args){connection=this;return prepare.apply(this,args);});
  let store;try {store=await openDurableStore(dir,true);}finally{spy.mock.restore();}
  try {assert.equal(connection.prepare('PRAGMA max_page_count').get().max_page_count,Math.floor(64*1024*1024/pageSize));}finally{store.close();}
});
test('canonical schema accepts its SQLite-owned primary-key autoindex on reopen',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pdfcraft-schema-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  (await openDurableStore(dir,true)).close();(await openDurableStore(dir,true)).close();
});
