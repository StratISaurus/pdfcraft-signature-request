import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startRelay } from './relay.js';
import { encryptBytes, decryptBytes } from './client-crypto.js';

const bootstrapToken = randomBytes(32).toString('base64url');
const relay = await startRelay({ bootstrapToken });
try {
  console.log('SYNTHETIC BYTES ONLY — NOT A REAL SIGNED PDF');
  const bytes = new Uint8Array(randomBytes(256));
  const { payload, key } = await encryptBytes(bytes);
  const body = JSON.stringify({ payload, ttlSeconds: 60 });
  assert.ok(!body.includes(key), 'encryption key must not enter HTTP body');
  const created = await fetch(`${relay.url}/v1/envelopes`, {
    method: 'POST', headers: { Authorization: `Bearer ${bootstrapToken}`, 'Content-Type': 'application/json' }, body,
  });
  assert.equal(created.status, 201);
  const { id, readToken, adminToken } = await created.json();
  const endpoint = `${relay.url}/v1/envelopes/${id}`;
  assert.equal((await fetch(endpoint)).status, 401);
  const fetched = await fetch(endpoint, { headers: { Authorization: `Bearer ${readToken}` } });
  assert.equal(fetched.status, 200);
  assert.deepEqual(await decryptBytes((await fetched.json()).payload, key), bytes);
  console.log('PASS: local encrypt → HTTP create → authorized fetch → local decrypt');
  const revoked = await fetch(endpoint, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(revoked.status, 204);
  assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${readToken}` } })).status, 404);
  console.log('PASS: revoked envelope returns 404');
  console.log('No keys, capabilities or plaintext logged. No PDF signing implemented.');
} finally {
  await relay.close();
}
