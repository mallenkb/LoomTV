import fs from 'node:fs';
import path from 'node:path';
import {
  X509Certificate,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';

export type LanTlsIdentity = {
  certificatePem: string;
  privateKeyPem: string;
  certFingerprint: string;
};

const IDENTITY_FILE_VERSION = 1;
const MIN_REMAINING_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

function encodedLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), encodedLength(body.length), body]);
}

function sequence(...parts: Buffer[]): Buffer { return der(0x30, ...parts); }
function set(...parts: Buffer[]): Buffer { return der(0x31, ...parts); }
function explicit(tag: number, value: Buffer): Buffer { return der(0xa0 + tag, value); }
function octetString(value: Buffer): Buffer { return der(0x04, value); }
function utf8String(value: string): Buffer { return der(0x0c, Buffer.from(value, 'utf8')); }
function boolean(value: boolean): Buffer { return der(0x01, Buffer.from([value ? 0xff : 0x00])); }
function integer(value: Buffer | number): Buffer {
  let bytes = typeof value === 'number'
    ? (() => {
        const output: number[] = [];
        for (let current = value; current > 0; current >>>= 8) output.unshift(current & 0xff);
        return Buffer.from(output.length ? output : [0]);
      })()
    : Buffer.from(value);
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) bytes = bytes.subarray(1);
  if ((bytes[0] & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return der(0x02, bytes);
}

function base128(value: number): number[] {
  const bytes = [value & 0x7f];
  for (let current = Math.floor(value / 128); current > 0; current = Math.floor(current / 128)) {
    bytes.unshift((current & 0x7f) | 0x80);
  }
  return bytes;
}

function objectIdentifier(value: string): Buffer {
  const parts = value.split('.').map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Invalid object identifier: ${value}`);
  }
  const bytes = [parts[0] * 40 + parts[1], ...parts.slice(2).flatMap(base128)];
  return der(0x06, Buffer.from(bytes));
}

function bitString(value: Buffer, unusedBits = 0): Buffer {
  return der(0x03, Buffer.concat([Buffer.from([unusedBits]), value]));
}

function utcTime(date: Date): Buffer {
  const two = (value: number) => String(value).padStart(2, '0');
  const year = date.getUTCFullYear();
  const value = `${two(year % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`
    + `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(value, 'ascii'));
}

function pem(label: string, value: Buffer): string {
  const lines = value.toString('base64').match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function extension(oid: string, value: Buffer, critical = false): Buffer {
  return sequence(
    objectIdentifier(oid),
    ...(critical ? [boolean(true)] : []),
    octetString(value),
  );
}

function createSelfSignedIdentity(): LanTlsIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const subjectPublicKeyInfo = publicKey.export({ type: 'spki', format: 'der' });
  const signatureAlgorithm = sequence(objectIdentifier('1.2.840.10045.4.3.2'));
  const commonName = sequence(set(sequence(objectIdentifier('2.5.4.3'), utf8String('LoomTV LAN'))));
  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 10);
  const serial = randomBytes(16);
  serial[0] &= 0x7f;

  const extensions = sequence(
    // The installation-local certificate is also its own trust anchor. Marking
    // it as a constrained CA lets native trust evaluators validate its dates
    // and signature after the client has independently matched the leaf pin.
    extension('2.5.29.19', sequence(boolean(true), integer(0)), true),
    extension('2.5.29.15', bitString(Buffer.from([0x84]), 2), true),
    extension('2.5.29.37', sequence(objectIdentifier('1.3.6.1.5.5.7.3.1'))),
    extension('2.5.29.17', sequence(der(0x82, Buffer.from('localhost', 'ascii')))),
  );
  const tbsCertificate = sequence(
    explicit(0, integer(2)),
    integer(serial),
    signatureAlgorithm,
    commonName,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    commonName,
    subjectPublicKeyInfo,
    explicit(3, extensions),
  );
  const signature = sign('sha256', tbsCertificate, privateKey);
  const certificateDer = sequence(tbsCertificate, signatureAlgorithm, bitString(signature));
  const certificatePem = pem('CERTIFICATE', certificateDer);
  const certificate = new X509Certificate(certificatePem);
  if (!certificate.checkPrivateKey(privateKey)) throw new Error('Generated LAN TLS key does not match its certificate.');

  return {
    certificatePem,
    privateKeyPem,
    certFingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
  };
}

function parseStoredIdentity(value: unknown): LanTlsIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== IDENTITY_FILE_VERSION
    || typeof record.certificatePem !== 'string'
    || typeof record.privateKeyPem !== 'string'
  ) return null;

  try {
    const certificate = new X509Certificate(record.certificatePem);
    const privateKey = createPrivateKey(record.privateKeyPem);
    if (!certificate.checkPrivateKey(privateKey)) return null;
    if (Date.parse(certificate.validTo) < Date.now() + MIN_REMAINING_VALIDITY_MS) return null;
    return {
      certificatePem: record.certificatePem,
      privateKeyPem: record.privateKeyPem,
      certFingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
    };
  } catch {
    return null;
  }
}

function replaceIdentityFile(temporaryPath: string, identityPath: string): void {
  try {
    fs.renameSync(temporaryPath, identityPath);
    return;
  } catch (error) {
    // POSIX rename replaces an existing file atomically; Windows rename does
    // not. Keep the old identity recoverable until the replacement lands.
    const backupPath = `${identityPath}.${process.pid}.previous`;
    let backedUp = false;
    try {
      fs.renameSync(identityPath, backupPath);
      backedUp = true;
      fs.renameSync(temporaryPath, identityPath);
      fs.unlinkSync(backupPath);
      return;
    } catch (replacementError) {
      if (backedUp && !fs.existsSync(identityPath)) {
        try { fs.renameSync(backupPath, identityPath); } catch { /* Preserve the original replacement error. */ }
      }
      try { fs.unlinkSync(temporaryPath); } catch { /* Best-effort temporary-file cleanup. */ }
      throw replacementError instanceof Error ? replacementError : error;
    }
  }
}

export function loadOrCreateLanTlsIdentity(userDataPath: string): LanTlsIdentity {
  const identityPath = path.join(userDataPath, 'lan-tls-identity.json');
  try {
    const stored = parseStoredIdentity(JSON.parse(fs.readFileSync(identityPath, 'utf8')));
    if (stored) return stored;
  } catch {
    // A missing, malformed, or expired identity is replaced atomically below.
  }

  const identity = createSelfSignedIdentity();
  fs.mkdirSync(userDataPath, { recursive: true });
  const temporaryPath = `${identityPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify({
    version: IDENTITY_FILE_VERSION,
    certificatePem: identity.certificatePem,
    privateKeyPem: identity.privateKeyPem,
  }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  replaceIdentityFile(temporaryPath, identityPath);
  try { fs.chmodSync(identityPath, 0o600); } catch { /* Windows ACLs do not use POSIX modes. */ }
  return identity;
}
