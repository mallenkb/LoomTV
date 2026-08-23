import assert from 'node:assert/strict';
import test from 'node:test';
import { discoveredTvServer } from '../src/discovery.ts';

test('TV discovery accepts only pinned LoomTV protocol advertisements', () => {
  const server = discoveredTvServer({
    name: 'Living room server',
    addresses: ['192.168.1.25'],
    port: 3848,
    txt: { protocolVersion: '2', instanceId: 'server-a', certFingerprint: 'ab'.repeat(32) },
  });
  assert.deepEqual(server, {
    id: 'server-a',
    name: 'Living room server',
    baseUrl: 'https://192.168.1.25:3848',
    certificateFingerprint: 'ab'.repeat(32),
  });
  assert.equal(discoveredTvServer({ name: 'Wrong', port: 3848, txt: { protocolVersion: '1' } }), null);
  assert.equal(discoveredTvServer({ name: 'Unpinned', port: 3848, txt: { protocolVersion: '2', instanceId: 'x' } }), null);
});
