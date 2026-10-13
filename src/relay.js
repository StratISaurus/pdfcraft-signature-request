import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest();
const token = () => randomBytes(32).toString('base64url');

export async function startRelay({ bootstrapToken, host = '127.0.0.1', port = 0, maxEnvelopes = 100, maxBodyBytes = 1024 * 1024, maxTotalBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof bootstrapToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(bootstrapToken) || Buffer.from(bootstrapToken, 'base64url').toString('base64url') !== bootstrapToken) throw new Error('bootstrapToken must be 32 random bytes encoded as base64url');
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 0 || port > 65535 ||
      !Number.isSafeInteger(maxEnvelopes) || maxEnvelopes < 1 || maxEnvelopes > 100 ||
      !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1024 * 1024 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 8 * 1024 * 1024) throw new Error('Invalid relay configuration');
  const records = new Map();
  const bootstrapHash = hash(bootstrapToken);
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.origin !== undefined || ![`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`].includes(req.headers.host)) return send(403, { error: 'origin_or_host_forbidden' });
    for (const [id, record] of records) if (record.expiresAt <= Date.now()) records.delete(id);
    if (req.method !== 'POST' && (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0)) return send(400, { error: 'unexpected_body' });
    if (req.url.includes('?')) return send(400, { error: 'query_not_allowed' });
    const authorized = expected => {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
      return match && timingSafeEqual(hash(match[1]), expected);
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', version: '0.1.0' });
    if (req.method === 'POST' && req.url === '/v1/envelopes') {
      if (!authorized(bootstrapHash)) return send(401, { error: 'unauthorized' });
      if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) return send(415, { error: 'unsupported_media_type' });
      if (Number(req.headers['content-length']) > maxBodyBytes) return send(413, { error: 'body_too_large' });
      const chunks = [];
      let length = 0;
      let body;
      try {
        // destroyOnReturn:false allows a bounded 413 response for chunked input.
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          length += chunk.length;
          if (length > maxBodyBytes) return send(413, { error: 'body_too_large' });
          chunks.push(chunk);
        }
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch { return send(400, { error: 'invalid_body' }); }
      const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;
      const base64 = value => typeof value === 'string' && value.length > 0 && Buffer.from(value, 'base64').toString('base64') === value;
      if (!exact(body, 'payload,ttlSeconds')) return send(400, { error: 'invalid_body' });
      const { payload, ttlSeconds } = body;
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400 ||
          !exact(payload, 'ciphertext,nonce,protocol') || payload.protocol !== 'pdfcraft-relay-experimental-v1' ||
          !base64(payload.nonce) || Buffer.from(payload.nonce, 'base64').length !== 12 ||
          !base64(payload.ciphertext) || Buffer.from(payload.ciphertext, 'base64').length < 16) return send(400, { error: 'invalid_body' });
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      const used = Array.from(records.values()).reduce((sum, record) => sum + record.bytes, 0);
      if (used + bytes > maxTotalBytes || records.size >= maxEnvelopes) return send(507, { error: 'capacity_exceeded' });
      const id = randomBytes(16).toString('hex');
      const readToken = token();
      const adminToken = token();
      const expiresAt = Date.now() + ttlSeconds * 1000;
      records.set(id, { payload, bytes, readHash: hash(readToken), adminHash: hash(adminToken), expiresAt });
      return send(201, { id, readToken, adminToken, expiresAt });
    }
    const match = /^\/v1\/envelopes\/([a-f0-9]{32})$/.exec(req.url);
    const record = match && records.get(match[1]);
    if (record && ['GET', 'DELETE'].includes(req.method)) {
      if (!authorized(req.method === 'GET' ? record.readHash : record.adminHash)) return send(401, { error: 'unauthorized' });
      if (req.method === 'DELETE') { records.delete(match[1]); return send(204); }
      return send(200, { payload: record.payload, expiresAt: record.expiresAt });
    }
    send(404, { error: 'not_found' });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
