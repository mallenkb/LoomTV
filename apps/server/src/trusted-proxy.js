import { isIP } from 'node:net';

const IPV4_BITS = 32;
const IPV6_BITS = 128;
const MAX_FORWARDED_HOPS = 32;
const MAX_FORWARDED_HEADER_BYTES = 2_048;
const MAX_FORWARDED_PROTO_BYTES = 32;

function parseIpv4(value) {
  if (isIP(value) !== 4) return null;
  const octets = value.split('.').map(Number);
  const numeric = octets.reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
  return { family: 4, originalFamily: 4, bits: IPV4_BITS, numeric, canonical: octets.join('.') };
}

function parseIpv6Numeric(value) {
  let expanded = value;
  if (expanded.includes('.')) {
    const lastColon = expanded.lastIndexOf(':');
    if (lastColon < 0) return null;
    const ipv4 = parseIpv4(expanded.slice(lastColon + 1));
    if (!ipv4) return null;
    const high = Number((ipv4.numeric >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4.numeric & 0xffffn).toString(16);
    expanded = `${expanded.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = expanded.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const hasCompression = halves.length === 2;
  if ((!hasCompression && left.length !== 8) || (hasCompression && left.length + right.length >= 8)) return null;
  const groups = hasCompression
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function canonicalIpv6(numeric) {
  const groups = Array.from({ length: 8 }, (_, index) => (
    Number((numeric >> BigInt((7 - index) * 16)) & 0xffffn).toString(16)
  ));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== '0') {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === '0') end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestLength < 2) return groups.join(':');
  const left = groups.slice(0, bestStart).join(':');
  const right = groups.slice(bestStart + bestLength).join(':');
  if (!left && !right) return '::';
  if (!left) return `::${right}`;
  if (!right) return `${left}::`;
  return `${left}::${right}`;
}

function parseAddress(value, { allowZone = false } = {}) {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1);
  const zoneIndex = candidate.indexOf('%');
  if (zoneIndex >= 0) {
    if (!allowZone || zoneIndex === 0 || !candidate.slice(zoneIndex + 1)) return null;
    candidate = candidate.slice(0, zoneIndex);
  }
  const ipv4 = parseIpv4(candidate);
  if (ipv4) return ipv4;
  if (isIP(candidate) !== 6) return null;
  const numeric = parseIpv6Numeric(candidate);
  if (numeric === null) return null;

  // Node commonly reports IPv4 peers as IPv4-mapped IPv6. Collapse those to
  // the same canonical address and throttle bucket as their IPv4 spelling.
  if ((numeric >> 32n) === 0xffffn) {
    const mapped = numeric & 0xffffffffn;
    const octets = [24n, 16n, 8n, 0n].map((shift) => Number((mapped >> shift) & 0xffn));
    return {
      family: 4,
      originalFamily: 6,
      bits: IPV4_BITS,
      numeric: mapped,
      canonical: octets.join('.'),
      mapped: true,
    };
  }
  return {
    family: 6,
    originalFamily: 6,
    bits: IPV6_BITS,
    numeric,
    canonical: canonicalIpv6(numeric),
  };
}

function prefixMask(bits, prefix) {
  if (prefix === 0) return 0n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
}

function parseAllowlistEntry(value) {
  const parts = value.split('/');
  if (parts.length > 2 || !parts[0]) throw new Error(`Invalid trusted proxy address or CIDR: ${value}`);
  const address = parseAddress(parts[0]);
  if (!address) throw new Error(`Invalid trusted proxy address or CIDR: ${value}`);
  let prefix = parts.length === 1
    ? (address.originalFamily === 6 ? IPV6_BITS : IPV4_BITS)
    : Number(parts[1]);
  const sourceBits = address.originalFamily === 6 ? IPV6_BITS : IPV4_BITS;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > sourceBits
    || (parts.length === 2 && !/^\d+$/.test(parts[1]))) {
    throw new Error(`Invalid trusted proxy CIDR prefix: ${value}`);
  }
  if (address.mapped) {
    if (prefix < 96) throw new Error(`IPv4-mapped trusted proxy CIDRs must use a prefix between 96 and 128: ${value}`);
    prefix -= 96;
  }
  const mask = prefixMask(address.bits, prefix);
  const network = address.numeric & mask;
  const canonicalAddress = address.family === 4
    ? [24n, 16n, 8n, 0n].map((shift) => Number((network >> shift) & 0xffn)).join('.')
    : canonicalIpv6(network);
  return Object.freeze({
    family: address.family,
    bits: address.bits,
    prefix,
    mask,
    network,
    canonical: `${canonicalAddress}/${prefix}`,
  });
}

export function parseTrustedProxyAllowlist(value = []) {
  if (value === undefined || value === null || value === '') return Object.freeze([]);
  const sources = Array.isArray(value) ? value : [value];
  const rawEntries = [];
  for (const source of sources) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('Trusted proxy entries must be non-empty IP addresses or CIDRs.');
    const entries = source.split(',');
    if (entries.some((entry) => !entry.trim())) throw new Error('Trusted proxy entries must not contain empty values.');
    rawEntries.push(...entries.map((entry) => entry.trim()));
  }
  const deduplicated = new Map();
  for (const entry of rawEntries) {
    const parsed = parseAllowlistEntry(entry);
    deduplicated.set(`${parsed.family}:${parsed.canonical}`, parsed);
  }
  return Object.freeze([...deduplicated.values()]);
}

export function normalizeIpAddress(value) {
  return parseAddress(value, { allowZone: true })?.canonical || null;
}

function rawHeader(req, name) {
  const value = req?.headers?.[name];
  return Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
}

export function createTrustedProxyPolicy(value = []) {
  const allowlist = parseTrustedProxyAllowlist(value);

  function parsedTrusted(address) {
    if (!address) return false;
    return allowlist.some((entry) => (
      entry.family === address.family && (address.numeric & entry.mask) === entry.network
    ));
  }

  function isTrustedAddress(valueToCheck) {
    return parsedTrusted(parseAddress(valueToCheck, { allowZone: true }));
  }

  function clientAddress(req) {
    const peer = parseAddress(req?.socket?.remoteAddress, { allowZone: true });
    if (!peer) return 'unknown';
    if (!parsedTrusted(peer)) return peer.canonical;

    const forwarded = rawHeader(req, 'x-forwarded-for');
    if (!forwarded || forwarded.length > MAX_FORWARDED_HEADER_BYTES) return peer.canonical;
    const hops = forwarded.split(',').map((entry) => entry.trim());
    if (hops.length > MAX_FORWARDED_HOPS || hops.some((entry) => !entry)) return peer.canonical;

    let selected = peer;
    for (let index = hops.length - 1; index >= 0; index -= 1) {
      const candidate = parseAddress(hops[index]);
      if (!candidate) return selected.canonical;
      selected = candidate;
      if (!parsedTrusted(candidate)) break;
    }
    return selected.canonical;
  }

  function isSecureRequest(req) {
    if (req?.socket?.encrypted) return true;
    if (!isTrustedAddress(req?.socket?.remoteAddress)) return false;
    const forwardedProto = rawHeader(req, 'x-forwarded-proto');
    // The immediate peer is the only party authorized to assert the original
    // transport. Require it to replace, rather than append to, this header so
    // an inherited client value can never become an ambiguous trust signal.
    if (!forwardedProto || forwardedProto.length > MAX_FORWARDED_PROTO_BYTES || forwardedProto.includes(',')) return false;
    return forwardedProto.trim().toLowerCase() === 'https';
  }

  return Object.freeze({
    trustedProxies: Object.freeze(allowlist.map((entry) => entry.canonical)),
    isTrustedAddress,
    clientAddress,
    isSecureRequest,
  });
}
