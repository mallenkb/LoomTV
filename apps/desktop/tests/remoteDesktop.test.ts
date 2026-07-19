import assert from 'node:assert/strict';
import test from 'node:test';

import { remoteProfileSessionPatch } from '../src/lib/remoteDesktop.ts';

test('remote profile state refreshes the cached selection identity used by playback', () => {
  assert.deepEqual(remoteProfileSessionPatch({
    profileId: 'profile-2',
    selectionRevision: 7,
  }), {
    selectedProfileId: 'profile-2',
    selectionRevision: 7,
  });
});
