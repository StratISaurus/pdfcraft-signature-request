import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

function run(file, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { cwd: new URL('../', import.meta.url), env: { ...process.env, ...env }, timeout: 10000 });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

test('demo exercises real HTTP and synthetic local decryption, then revokes', async () => {
  assert.ok(existsSync(new URL('../src/demo.js', import.meta.url)), 'demo exists');
  const result = await run('src/demo.js');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /SYNTHETIC BYTES ONLY — NOT A REAL SIGNED PDF/);
  assert.match(result.output, /PASS: local encrypt → HTTP create → authorized fetch → local decrypt/);
  assert.match(result.output, /PASS: revoked envelope returns 404/);
});

test('CLI refuses missing bootstrap credential without printing secrets', async () => {
  assert.ok(existsSync(new URL('../src/cli.js', import.meta.url)), 'CLI exists');
  const missing = await run('src/cli.js', { RELAY_BOOTSTRAP_TOKEN: '' });
  assert.equal(missing.code, 1);
  assert.match(missing.output, /Relay startup failed/);
  const secret = randomBytes(32).toString('base64url');
  const invalid = await run('src/cli.js', { RELAY_BOOTSTRAP_TOKEN: secret, PORT: '-1' });
  assert.equal(invalid.code, 1);
  assert.ok(!invalid.output.includes(secret));
});
