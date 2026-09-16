import { app, safeStorage } from 'electron';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAGIC = Buffer.from('LOOMLOCAL01', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const AAD = Buffer.from('com.mallenkb.loommediaserver/local-secret/v1', 'utf8');
const KEY_FILE = 'loomtv-local-secrets.key';

let cachedKey: Buffer | null = null;

function keyPath(): string {
  return path.join(app.getPath('userData'), KEY_FILE);
}

function loadOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey;
  const target = keyPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The local secret key path is unsafe.');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('The local secret key belongs to another operating-system user.');
    }
    const key = fs.readFileSync(target);
    if (key.length !== KEY_BYTES) throw new Error('The local secret key is invalid.');
    try { fs.chmodSync(target, 0o600); } catch { /* Windows protects the user profile with ACLs. */ }
    cachedKey = key;
    return key;
  }

  const key = randomBytes(KEY_BYTES);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, key, { flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* Best effort cleanup. */ }
    if (!fs.existsSync(target)) throw error;
    return loadOrCreateKey();
  }
  try { fs.chmodSync(target, 0o600); } catch { /* Windows protects the user profile with ACLs. */ }
  cachedKey = key;
  return key;
}

export function isLocalSecretCiphertext(value: Buffer): boolean {
  return value.length >= MAGIC.length + NONCE_BYTES + TAG_BYTES
    && value.subarray(0, MAGIC.length).equals(MAGIC);
}

export function encryptLocalSecret(value: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', loadOrCreateKey(), nonce);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}

export function decryptLocalSecret(value: Buffer): { plaintext: string; needsMigration: boolean } {
  if (!isLocalSecretCiphertext(value)) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The legacy operating-system secret store is unavailable.');
    return { plaintext: safeStorage.decryptString(value), needsMigration: true };
  }
  const nonceStart = MAGIC.length;
  const tagStart = nonceStart + NONCE_BYTES;
  const dataStart = tagStart + TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', loadOrCreateKey(), value.subarray(nonceStart, tagStart));
  decipher.setAAD(AAD);
  decipher.setAuthTag(value.subarray(tagStart, dataStart));
  return {
    plaintext: Buffer.concat([decipher.update(value.subarray(dataStart)), decipher.final()]).toString('utf8'),
    needsMigration: false,
  };
}

export const localSecretStorage = {
  isEncryptionAvailable: (): boolean => {
    try { loadOrCreateKey(); return true; } catch { return false; }
  },
  encryptString: encryptLocalSecret,
  decryptString: (value: Buffer): string => decryptLocalSecret(value).plaintext,
};
