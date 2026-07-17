import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCreditCard } from '../src/main/skipSegments/creditCardClassifier.ts';

test('white and grey low-entropy cards with text edges are accepted', () => {
  assert.equal(classifyCreditCard({ mean: 235, entropy: 1.1, saturation: 0.02, edgeDensity: 0.10 }).matches, true);
  assert.equal(classifyCreditCard({ mean: 145, entropy: 1.4, saturation: 0.03, edgeDensity: 0.09 }).matches, true);
});

test('high-entropy saturated footage is rejected', () => {
  assert.equal(classifyCreditCard({ mean: 110, entropy: 7.2, saturation: 0.8, edgeDensity: 0.16 }).matches, false);
});
