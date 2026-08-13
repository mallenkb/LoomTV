import assert from 'node:assert/strict';
import test from 'node:test';

import { rankLocalNetworkAddresses } from '../src/main/networkInfo.ts';

const ipv4 = (address: string, internal = false) => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4' as const,
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
});

test('manual LAN address prefers private physical interfaces over VPN and virtual adapters', () => {
  const ranked = rankLocalNetworkAddresses({
    utun4: [ipv4('100.64.0.2')],
    bridge100: [ipv4('192.168.64.1')],
    en0: [ipv4('192.168.68.66')],
    lo0: [ipv4('127.0.0.1', true)],
  });
  assert.equal(ranked[0], '192.168.68.66');
  assert.deepEqual(new Set(ranked.slice(1)), new Set(['100.64.0.2', '192.168.64.1']));
});

test('wired and Wi-Fi addresses remain deterministic when several real interfaces exist', () => {
  assert.deepEqual(rankLocalNetworkAddresses({
    en7: [ipv4('10.0.0.20')],
    en0: [ipv4('192.168.1.20')],
  }), ['192.168.1.20', '10.0.0.20']);
});
