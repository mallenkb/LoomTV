import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const PIN_PATTERN = /^\d{4}$/;
const KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function deriveKey(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function isValidProfilePin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

export async function hashProfilePin(pin: string): Promise<{ hash: string; salt: string }> {
  if (!isValidProfilePin(pin)) throw new Error('PINs must contain exactly four digits.');
  const salt = randomBytes(16);
  const key = await deriveKey(pin, salt);
  return { hash: key.toString('base64'), salt: salt.toString('base64') };
}

export async function verifyProfilePin(pin: string, credentials: { hash: string; salt: string }): Promise<boolean> {
  if (!isValidProfilePin(pin)) return false;
  const expected = Buffer.from(credentials.hash, 'base64');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await deriveKey(pin, Buffer.from(credentials.salt, 'base64'));
  return timingSafeEqual(actual, expected);
}
