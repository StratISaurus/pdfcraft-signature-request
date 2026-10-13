import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('client rejects unsupported protocol before decryption', async () => {
  const { encryptBytes, decryptBytes } = await moduleUnderTest();
  const encrypted = await encryptBytes(new Uint8Array([1, 2, 3]));
  await assert.rejects(decryptBytes({ ...encrypted.payload, protocol: 'other' }, encrypted.key), /Unsupported protocol/);
});

test('client authenticates ciphertext, nonce and key', async () => {
  const { encryptBytes, decryptBytes } = await moduleUnderTest();
  const a = await encryptBytes(new Uint8Array([1, 2, 3]));
  const b = await encryptBytes(new Uint8Array([1, 2, 3]));
  const tampered = Buffer.from(a.payload.ciphertext, 'base64');
  tampered[0] ^= 1;
  await assert.rejects(decryptBytes({ ...a.payload, ciphertext: tampered.toString('base64') }, a.key));
  await assert.rejects(decryptBytes({ ...a.payload, nonce: b.payload.nonce }, a.key));
  await assert.rejects(decryptBytes(a.payload, b.key));
});

async function moduleUnderTest() {
  assert.ok(existsSync(new URL('../src/client-crypto.js', import.meta.url)), 'client crypto module exists');
  return import('../src/client-crypto.js');
}

test('client encrypts synthetic bytes with fresh keys and nonces and decrypts locally', async () => {
  const { encryptBytes, decryptBytes } = await moduleUnderTest();
  const bytes = new TextEncoder().encode('SYNTHETIC BYTES — NOT A SIGNED PDF');
  const a = await encryptBytes(bytes);
  const b = await encryptBytes(bytes);
  assert.equal(a.payload.protocol, 'pdfcraft-relay-experimental-v1');
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.payload.nonce, b.payload.nonce);
  assert.notEqual(a.payload.ciphertext, b.payload.ciphertext);
  assert.deepEqual(await decryptBytes(a.payload, a.key), bytes);
  assert.deepEqual(Object.keys(a.payload).sort(), ['ciphertext', 'nonce', 'protocol']);
});
