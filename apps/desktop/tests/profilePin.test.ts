import assert from 'node:assert/strict';
import test from 'node:test';

import { hashProfilePin, verifyProfilePin } from '../src/main/profilePin.ts';

test('profile PINs use unique scrypt credentials and constant-shape verification', async () => {
  const first = await hashProfilePin('1234');
  const second = await hashProfilePin('1234');

  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(await verifyProfilePin('1234', first), true);
  assert.equal(await verifyProfilePin('0000', first), false);
  await assert.rejects(hashProfilePin('12345'), /four digits/i);
  await assert.rejects(hashProfilePin('12a4'), /four digits/i);
});
