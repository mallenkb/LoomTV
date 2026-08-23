import assert from 'node:assert/strict';
import test from 'node:test';

import { MEDIA_PROTOCOL_SCHEMES, mediaSchemePrivileges } from '../src/main/loomtvProtocol.ts';

test('uses loomtv as the primary media protocol and retains one legacy alias', () => {
  assert.deepEqual([...MEDIA_PROTOCOL_SCHEMES], ['loomtv', 'plexserver']);
});

test('allows HLS.js to request media through both media protocols', () => {
  assert.equal(mediaSchemePrivileges.standard, true);
  assert.equal(mediaSchemePrivileges.secure, true);
  assert.equal(mediaSchemePrivileges.supportFetchAPI, true);
  assert.equal(mediaSchemePrivileges.stream, true);
  assert.equal(mediaSchemePrivileges.corsEnabled, true);
});
