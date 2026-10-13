import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
const token = () => randomBytes(32).toString('base64url');
const hash = s => createHash('sha256').update(s).digest();
const isToken = s => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s) && Buffer.from(s,'base64url').toString('base64url') === s;
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === keys;
function validPayload(p) {
  const b64 = s => typeof s === 'string' && Buffer.from(s,'base64').toString('base64') === s;
  return exact(p,'ciphertext,nonce,protocol') && p.protocol === 'pdfcraft-relay-experimental-v1' && b64(p.nonce) && Buffer.from(p.nonce,'base64').length === 12 && b64(p.ciphertext) && Buffer.from(p.ciphertext,'base64').length >= 16;
}
export async function startLocalApp({port=0, assets = new Map(), ttlMs=3600000}={}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 86400000) throw Error('Invalid local app configuration');
  const launchToken = token(), launchHash = hash(launchToken), records = new Map();
  const server = http.createServer(async (req,res) => {
    const send = (status, body) => { res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(body === undefined ? undefined : JSON.stringify(body)); };
    const origin = `http://127.0.0.1:${server.address().port}`;
    const auth = expected => { const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || ''); return m && timingSafeEqual(hash(m[1]),expected); };
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return send(403,{error:'origin_or_host_forbidden'});
    if (req.url.includes('?')) return send(400,{error:'query_not_allowed'});
    if (req.method !== 'POST' && (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0)) return send(400,{error:'unexpected_body'});
    for (const [id,r] of records) if (r.expiresAt <= Date.now()) records.delete(id);
    if (req.method === 'GET' && req.url === '/health') return send(200,{status:'ok',app:'local-approval-demo',version:'pdfcraft-approval-v1'});
    if (req.method === 'GET' && assets.has(req.url)) {
      const a = assets.get(req.url);
      res.writeHead(200,{'Content-Type':a.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
      return res.end(a.bytes);
    }
    let body;
    const readBody = async () => {
      if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) throw {status:415};
      let size=0; const chunks=[];
      for await (const c of req.iterator({destroyOnReturn:false})) { size+=c.length; if(size>4*1024*1024) throw {status:413}; chunks.push(c); }
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    };
    const used = () => [...records.values()].reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r)),0);
    try {
      if (req.url === '/api/requests' && req.method === 'POST') {
        if (!auth(launchHash)) return send(401,{error:'unauthorized'});
        body = await readBody();
        if (!exact(body,'manifestHash,recipients,version') || body.version !== 'pdfcraft-approval-v1' || !/^[a-f0-9]{64}$/.test(body.manifestHash) || !Array.isArray(body.recipients) || !body.recipients.length || body.recipients.length>12) return send(400,{error:'invalid_request'});
        const seen = new Set();
        for (const [i,r] of body.recipients.entries()) {
          if (!exact(r,'id,payload,readToken,responseToken,stage') || r.id !== `r${i+1}` || !Number.isInteger(r.stage) || r.stage<0 || r.stage>i || (i && (r.stage<body.recipients[i-1].stage || r.stage>body.recipients[i-1].stage+1)) || !isToken(r.readToken) || !isToken(r.responseToken) || !validPayload(r.payload)) return send(400,{error:'invalid_recipient'});
          for (const t of [r.readToken,r.responseToken]) { if(seen.has(t)) return send(400,{error:'duplicate_capability'}); seen.add(t); }
        }
        if (records.size>=20 || used()+Buffer.byteLength(JSON.stringify(body))>32*1024*1024) return send(507,{error:'capacity_exceeded'});
        const id=randomBytes(16).toString('hex'), adminToken=token();
        records.set(id,{manifestHash:body.manifestHash,adminHash:hash(adminToken),expiresAt:Date.now()+ttlMs,recipients:body.recipients.map(r=>({id:r.id,stage:r.stage,payload:r.payload,readHash:hash(r.readToken),responseHash:hash(r.responseToken),state:'waiting'}))});
        return send(201,{id,adminToken});
      }
      const m = /^\/api\/requests\/([a-f0-9]{32})(?:\/(recipients|accept)\/(r[1-9][0-9]?)(\/response)?)?$/.exec(req.url);
      const record = m && records.get(m[1]);
      if (!record) return send(404,{error:'not_found'});
      if (!m[2]) {
        if (!auth(record.adminHash)) return send(401,{error:'unauthorized'});
        if (req.method === 'DELETE') {records.delete(m[1]);return send(204);}
        if (req.method === 'GET') return send(200,{manifestHash:record.manifestHash,expiresAt:record.expiresAt,recipients:record.recipients.map(r=>({id:r.id,stage:r.stage,state:r.state,response:r.response}))});
      }
      const r=record.recipients.find(r=>r.id===m[3]);
      if (!r) return send(404,{error:'not_found'});
      if (m[2] === 'accept' && req.method === 'POST' && !m[4]) {
        if (!auth(record.adminHash)) return send(401,{error:'unauthorized'});
        body=await readBody();
        if (records.get(m[1])!==record || record.expiresAt<=Date.now()) return send(404,{error:'not_found'});
        if (!exact(body,'manifestHash') || body.manifestHash!==record.manifestHash) return send(400,{error:'binding_mismatch'});
        if(r.state!=='submitted') return send(409,{error:'not_pending'});
        r.state='accepted';return send(200,{state:r.state});
      }
      if (m[2] === 'recipients') {
        if (!auth(m[4] ? r.responseHash : r.readHash)) return send(401,{error:'unauthorized'});
        const eligible = () => !record.recipients.some(other=>other.stage<r.stage && other.state!=='accepted');
        if (!eligible()) return send(423,{error:'stage_locked'});
        if (req.method === 'GET' && !m[4]) return send(200,{manifestHash:record.manifestHash,payload:r.payload,state:r.state});
        if (req.method === 'POST' && m[4]) {
          body=await readBody();
          if (records.get(m[1])!==record || record.expiresAt<=Date.now()) return send(404,{error:'not_found'});
          if (!exact(body,'manifestHash,payload') || body.manifestHash!==record.manifestHash || !validPayload(body.payload)) return send(400,{error:'binding_mismatch'});
          // Recheck after the await: simultaneous submissions cannot replace evidence.
          if (!eligible() || r.state!=='waiting') return send(409,{error:'already_submitted'});
          if (used()+Buffer.byteLength(JSON.stringify(body))>32*1024*1024) return send(507,{error:'capacity_exceeded'});
          r.response=body.payload;r.state='submitted';return send(201,{state:r.state});
        }
      }
      return send(405,{error:'method_not_allowed'});
    } catch(e) { return send(e.status || 400,{error:'invalid_body'}); }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxConnections=30;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}`,launchToken,close:()=>new Promise(resolve=>server.close(resolve))};
}
