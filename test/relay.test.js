import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { encryptBytes, decryptBytes } from '../src/client-crypto.js';

async function start(t, options = {}) {
  assert.ok(existsSync(new URL('../src/relay.js', import.meta.url)), 'relay module exists');
  const { startRelay } = await import('../src/relay.js');
  const bootstrapToken = randomBytes(32).toString('base64url');
  const relay = await startRelay({ bootstrapToken, port: 0, ...options });
  t.after(() => relay.close());
  const request = (path, { token, body, method = 'GET', headers = {} } = {}) => fetch(relay.url + path, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const create = (payload, ttlSeconds = 60) => request('/v1/envelopes', { method: 'POST', token: bootstrapToken, body: { payload, ttlSeconds } });
  return { ...relay, request, create, bootstrapToken };
}

test('capability authorization isolates bootstrap, reader and administrator; revoke removes access', async t => {
  const { create, request, bootstrapToken } = await start(t);
  const { payload } = await encryptBytes(new Uint8Array([1]));
  for (const token of [undefined, 'wrong']) {
    assert.equal((await request('/v1/envelopes', { method: 'POST', token, body: { payload, ttlSeconds: 60 } })).status, 401);
  }
  const envelope = await (await create(payload)).json();
  const path = `/v1/envelopes/${envelope.id}`;
  for (const token of [undefined, 'wrong', envelope.adminToken, bootstrapToken]) {
    assert.equal((await request(path, { token })).status, 401);
  }
  assert.equal((await request(path, { method: 'DELETE', token: envelope.readToken })).status, 401);
  assert.equal((await request(`${path}?token=${envelope.readToken}`)).status, 400);
  assert.equal((await request(path, { method: 'DELETE', token: envelope.adminToken })).status, 204);
  assert.equal((await request(path, { token: envelope.readToken })).status, 404);
});

test('expiry denies reads and reclaims bounded capacity', async t => {
  const { create, request } = await start(t, { maxEnvelopes: 1 });
  const { payload } = await encryptBytes(new Uint8Array([1]));
  const envelope = await (await create(payload, 1)).json();
  assert.equal((await create(payload)).status, 507);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await request(`/v1/envelopes/${envelope.id}`, { token: envelope.readToken })).status, 404);
  assert.equal((await create(payload)).status, 201);
});

test('creation rejects malformed, unsupported and oversized request bodies without crashing', async t => {
  const { request, bootstrapToken, create } = await start(t, { maxBodyBytes: 512 });
  const { payload } = await encryptBytes(new Uint8Array([1]));
  const invalid = [
    [{ payload: { ...payload, protocol: 'future' }, ttlSeconds: 60 }, 400],
    ['{broken', 400], [null, 400],
    [{ payload, ttlSeconds: 0 }, 400], [{ payload, ttlSeconds: 86401 }, 400],
    [{ payload, ttlSeconds: 1.5 }, 400], [{ payload, ttlSeconds: '60' }, 400],
    [{ payload, ttlSeconds: 60, key: 'forbidden' }, 400],
    [{ payload: { ...payload, key: 'forbidden' }, ttlSeconds: 60 }, 400],
    [{ payload: { ...payload, nonce: 'bad' }, ttlSeconds: 60 }, 400],
    [{ payload: { ...payload, ciphertext: 'AAAA' }, ttlSeconds: 60 }, 400],
    [' '.repeat(513), 413],
  ];
  for (const [body, status] of invalid) {
    const result = await request('/v1/envelopes', { method: 'POST', token: bootstrapToken, body });
    assert.equal(result.status, status);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await request('/v1/envelopes', { method: 'POST', token: bootstrapToken, body: { payload, ttlSeconds: 60 }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await create(payload)).status, 201);
});

test('total encoded payload byte budget is enforced and released by revoke', async t => {
  const { payload } = await encryptBytes(new Uint8Array(100));
  const size = Buffer.byteLength(JSON.stringify(payload));
  const { create, request } = await start(t, { maxTotalBytes: size });
  const envelope = await (await create(payload)).json();
  assert.equal((await create(payload)).status, 507);
  assert.equal((await request(`/v1/envelopes/${envelope.id}`, { method: 'DELETE', token: envelope.adminToken })).status, 204);
  assert.equal((await create(payload)).status, 201);
});

test('unsafe bootstrap credentials, listen host and bounds are rejected before listening', async () => {
  const { startRelay } = await import('../src/relay.js');
  const valid = { bootstrapToken: randomBytes(32).toString('base64url') };
  for (const bootstrapToken of [undefined, '', 'weak', 'a'.repeat(44)]) {
    await assert.rejects(startRelay({ bootstrapToken }), /bootstrapToken/);
  }
  for (const options of [{ host: '0.0.0.0' }, { maxEnvelopes: 0 }, { maxBodyBytes: Infinity }, { maxTotalBytes: -1 }, { port: -1 }]) {
    await assert.rejects(startRelay({ ...valid, ...options }), /Invalid/);
  }
});

test('browser origin and rebinding host requests are refused without CORS', async t => {
  const { request, url } = await start(t);
  const response = await request('/health', { headers: { Origin: 'https://attacker.example' } });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  // fetch normalizes Host; use the actual HTTP client to exercise rebinding.
  const status = await new Promise((resolve, reject) => {
    http.get(url + '/health', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('chunked uploads enforce the byte limit and bodyless routes reject bodies', async t => {
  const { url, bootstrapToken } = await start(t, { maxBodyBytes: 256 });
  const send = (method, path, headers, data) => new Promise((resolve, reject) => {
    const req = http.request(url + path, { method, headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
  assert.equal(await send('POST', '/v1/envelopes', { Authorization: `Bearer ${bootstrapToken}`, 'Content-Type': 'application/json' }, ' '.repeat(257)), 413);
  assert.equal(await send('GET', '/health', { 'Content-Length': '1' }, 'x'), 400);
});

test('real loopback HTTP relays opaque client ciphertext with independent capabilities', async t => {
  const { create, request } = await start(t);
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, '0.1.0');
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('access-control-allow-origin'), null);
  const bytes = new TextEncoder().encode('SYNTHETIC ONLY — NOT A SIGNED PDF');
  const encrypted = await encryptBytes(bytes);
  const response = await create(encrypted.payload);
  assert.equal(response.status, 201);
  const envelope = await response.json();
  assert.notEqual(envelope.readToken, envelope.adminToken);
  assert.match(envelope.id, /^[a-f0-9]{32}$/);
  const fetched = await request(`/v1/envelopes/${envelope.id}`, { token: envelope.readToken });
  assert.equal(fetched.status, 200);
  assert.deepEqual(await decryptBytes((await fetched.json()).payload, encrypted.key), bytes);
});
