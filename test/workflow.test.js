import test from 'node:test';
import assert from 'node:assert/strict';
import * as workflow from '../src/workflow.js';

test('versioned manifest binds PDF bytes and assigns contiguous stages', async () => {
  assert.equal(typeof workflow.makeManifest, 'function');
  const m = await workflow.makeManifest(new Uint8Array([1,2,3]), ['Alice','Bob','Cara'], 'grouped', [0,0,1]);
  assert.equal(m.version, 'pdfcraft-approval-v1');
  assert.deepEqual(m.recipients.map(r => r.stage), [0,0,1]);
  assert.match(m.documentHash, /^[a-f0-9]{64}$/);
  assert.equal(await workflow.manifestHash(m), await workflow.manifestHash(structuredClone(m)));
  assert.throws(() => workflow.validateManifest({...m,version:'future'}));
  assert.throws(() => workflow.validateManifest({...m,recipients:[]}));
  await assert.rejects(workflow.makeManifest(new Uint8Array([1]), ['A','B'], 'grouped', [0,2]));
});
