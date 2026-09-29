import assert from 'node:assert/strict';
import test from 'node:test';
import { identityEvidenceStrength } from '../src/index.mjs';

test('identity evidence accepts normalized known kinds', () => {
  assert.equal(identityEvidenceStrength('legacy-path-hash'), 1);
  assert.equal(identityEvidenceStrength('quick-hash'), 2);
  assert.equal(identityEvidenceStrength('filesystem-id'), 3);
  assert.equal(identityEvidenceStrength(' CONTENT-SHA256 '), 4);
});

test('identity evidence rejects inherited property names and unknown kinds', () => {
  for (const kind of ['constructor', '__proto__', 'unknown', '', null, undefined]) {
    assert.throws(() => identityEvidenceStrength(kind), { code: 'unknown_identity_evidence_kind' });
  }
});
