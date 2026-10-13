import { mkdirSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const MAX_BYTES=32*1024*1024;
const MAX_FILE_BYTES=64*1024*1024;
const TABLE_SQL='CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL)';
function validateSchema(db) {
  const same=(sql,expected)=>JSON.stringify(db.prepare(sql).all())===JSON.stringify(expected);
  // Deliberately exact v1 DDL: constraints not represented by table_xinfo (CHECK,
  // conflict clauses, collations, etc.) must not slip through a column-only check.
  if(!same('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY name',[
    {type:'table',name:'records',tbl_name:'records',sql:TABLE_SQL},
    {type:'index',name:'sqlite_autoindex_records_1',tbl_name:'records',sql:null},
  ]) || !same('PRAGMA main.table_xinfo(records)',[
    {cid:0,name:'id',type:'TEXT',notnull:0,dflt_value:null,pk:1,hidden:0},
    {cid:1,name:'value',type:'TEXT',notnull:1,dflt_value:null,pk:0,hidden:0},
  ]) || !same('PRAGMA main.index_list(records)',[
    {seq:0,name:'sqlite_autoindex_records_1',unique:1,origin:'pk',partial:0},
  ]) || !same('PRAGMA main.index_xinfo(sqlite_autoindex_records_1)',[
    {seqno:0,cid:0,name:'id',desc:0,coll:'BINARY',key:1},
    {seqno:1,cid:-1,name:null,desc:0,coll:'BINARY',key:0},
  ]))throw Error('Unsupported durable store schema');
}
const exact=(v,keys)=>v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).sort().join(',')===keys;
const hash=v=>exact(v,'data,type') && v.type==='Buffer' && Array.isArray(v.data) && v.data.length===32 && v.data.every(x=>Number.isInteger(x)&&x>=0&&x<=255);
const b64=s=>typeof s==='string' && Buffer.from(s,'base64').toString('base64')===s;
const payload=v=>exact(v,'ciphertext,nonce,protocol') && v.protocol==='pdfcraft-relay-experimental-v1' && b64(v.nonce) && Buffer.from(v.nonce,'base64').length===12 && b64(v.ciphertext) && Buffer.from(v.ciphertext,'base64').length>=16;
function decode(id,text) {
  const v=JSON.parse(text);
  if(!/^[a-f0-9]{32}$/.test(id) || !exact(v,'adminHash,expiresAt,manifestHash,recipients') || !/^[a-f0-9]{64}$/.test(v.manifestHash) || !hash(v.adminHash) || !Number.isSafeInteger(v.expiresAt) || v.expiresAt<1 || !Array.isArray(v.recipients) || !v.recipients.length || v.recipients.length>12)throw Error('Invalid durable record');
  for(const [i,r] of v.recipients.entries()) {
    const keys=r.state==='waiting'?'id,payload,readHash,responseHash,stage,state':'id,payload,readHash,response,responseHash,stage,state';
    if(!exact(r,keys) || r.id!==`r${i+1}` || !Number.isInteger(r.stage) || r.stage<0 || r.stage>i || (i && (r.stage<v.recipients[i-1].stage || r.stage>v.recipients[i-1].stage+1)) || !hash(r.readHash) || !hash(r.responseHash) || !payload(r.payload) || !['waiting','submitted','accepted'].includes(r.state) || (r.state!=='waiting' && !payload(r.response)))throw Error('Invalid durable record');
    if(r.state!=='waiting' && v.recipients.some(x=>x.stage<r.stage && x.state!=='accepted'))throw Error('Invalid durable record stage');
    r.readHash=Buffer.from(r.readHash.data);r.responseHash=Buffer.from(r.responseHash.data);
  }
  v.adminHash=Buffer.from(v.adminHash.data);return v;
}

// Opt-in, single process, trusted-account storage; never an ACL claim on Windows.
export async function openDurableStore(storageDir, trustedLocalAccount, maxStorageBytes=MAX_BYTES) {
  if (trustedLocalAccount !== true) throw Error('Durable storage requires explicit trustedLocalAccount boundary');
  if(typeof storageDir!=='string' || !isAbsolute(storageDir) || !Number.isSafeInteger(maxStorageBytes) || maxStorageBytes<1 || maxStorageBytes>MAX_BYTES)throw Error('Invalid durable storage configuration');
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(storageDir,{recursive:true,mode:0o700});
  if(!lstatSync(storageDir).isDirectory() || lstatSync(storageDir).isSymbolicLink())throw Error('Invalid durable storage directory');
  const path=join(storageDir,'relay.sqlite');
  let stat;try {stat=lstatSync(path);}catch(e){if(e.code!=='ENOENT')throw e;}
  const existed=stat!==undefined;
  if(existed && (!stat.isFile() || stat.isSymbolicLink() || stat.size<512 || stat.size>MAX_FILE_BYTES))throw Error('Invalid durable database file');
  const db=new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA locking_mode=EXCLUSIVE;');
    const version=db.prepare('PRAGMA user_version').get().user_version;
    if(existed && version!==1)throw Error('Unsupported durable store version');
    if(!existed)db.exec(`BEGIN EXCLUSIVE; ${TABLE_SQL}; PRAGMA user_version=1; COMMIT;`);
    else db.exec('BEGIN EXCLUSIVE; COMMIT;'); // Hold an exclusive connection lock: no divergent RAM mirrors.
    validateSchema(db);
    const pageSize=db.prepare('PRAGMA page_size').get().page_size;
    const maxPages=Math.floor(MAX_FILE_BYTES/pageSize);
    if(db.prepare(`PRAGMA max_page_count=${maxPages}`).get().max_page_count>maxPages)throw Error('Durable database file capacity exceeded');
    if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Corrupt durable database');
    const count=db.prepare('SELECT count(*) n, coalesce(sum(length(CAST(value AS BLOB))),0) bytes FROM records').get();
    if(count.n>20 || count.bytes>maxStorageBytes)throw Error('Durable store capacity exceeded');
    const records=new Map();
    for(const {id,value} of db.prepare('SELECT id,value FROM records').all()) {
      let decoded;try {decoded=decode(id,value);}catch {throw Error('Invalid durable record');}
      records.set(id,decoded);
    }
    const put=db.prepare('INSERT OR REPLACE INTO records(id,value) VALUES (?,?)');
    const del=db.prepare('DELETE FROM records WHERE id=?');
    const mutate=(statement,args,message)=>{
      try {
        db.exec('BEGIN IMMEDIATE');
        if(statement.run(...args).changes!==1)throw Error('Unexpected affected row count');
        db.exec('COMMIT');
      } catch {
        // IGNORE can retain trigger side effects; check BEFORE commit, not after.
        // SQLite may already have rolled back (e.g. SQLITE_FULL).
        if(db.isTransaction)db.exec('ROLLBACK');
        throw Object.assign(Error(message),{status:503});
      }
    };
    records.set=(id,value)=>{
      const text=JSON.stringify(value);decode(id,text);
      const bytes=Buffer.byteLength(text)+[...records].reduce((n,[key,r])=>n+(key===id?0:Buffer.byteLength(JSON.stringify(r))),0);
      if((!records.has(id) && records.size>=20) || bytes>maxStorageBytes)throw Object.assign(Error('Capacity exceeded'),{status:507});
      // Commit is durable before RAM publication and the HTTP ACK.
      mutate(put,[id,text],'Durable write failed');
      Map.prototype.set.call(records,id,value);return records;
    };
    records.delete=id=>{
      if(!records.has(id))return false;
      mutate(del,[id],'Durable delete failed');
      return Map.prototype.delete.call(records,id);
    };
    for(const [id,r] of records)if(r.expiresAt<=Date.now())records.delete(id);
    let closed=false;records.close=()=>{if(!closed){db.close();closed=true;}};
    return records;
  } catch(e) {db.close();throw e;}
}
