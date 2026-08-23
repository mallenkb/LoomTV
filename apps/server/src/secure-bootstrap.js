import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEFAULT_BOOTSTRAP_SECRET_FILENAME = 'bootstrap-secret';
export const MIN_BOOTSTRAP_SECRET_BYTES = 32;

const MAX_BOOTSTRAP_SECRET_BYTES = 1_024;
const MAX_BOOTSTRAP_FAILURES = 5;
const BOOTSTRAP_WINDOW_MS = 15 * 60 * 1_000;
const BOOTSTRAP_LOCKOUT_MS = 15 * 60 * 1_000;

function bootstrapError(status, code, message, retryAfter) {
  return Object.assign(new Error(message), {
    status,
    code,
    ...(retryAfter ? { retryAfter } : {}),
  });
}

function normalizeSecret(value, source) {
  const secret = String(value ?? '').trim();
  const size = Buffer.byteLength(secret);
  if (size < MIN_BOOTSTRAP_SECRET_BYTES || size > MAX_BOOTSTRAP_SECRET_BYTES) {
    throw bootstrapError(
      500,
      'bootstrap_secret_invalid_configuration',
      `${source} must contain between ${MIN_BOOTSTRAP_SECRET_BYTES} and ${MAX_BOOTSTRAP_SECRET_BYTES} bytes.`,
    );
  }
  return secret;
}

function secretDigest(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

function constantTimeSecretEqual(left, right) {
  return timingSafeEqual(secretDigest(left), secretDigest(right));
}

function addressKey(address) {
  return createHash('sha256').update(String(address || 'unknown').slice(0, 256)).digest('hex');
}

export function createBootstrapSecurity(options) {
  const dataDir = path.resolve(options.dataDir);
  const required = options.required !== false;
  const configuredFile = options.secretFile ? path.resolve(options.secretFile) : null;
  const defaultFile = path.join(dataDir, DEFAULT_BOOTSTRAP_SECRET_FILENAME);
  const secretFile = configuredFile || defaultFile;
  const failures = new Map();
  let initialized = false;
  let activeSecret = null;
  let generatedFile = false;

  function retryAfterFor(key, now = Date.now()) {
    const entry = failures.get(key);
    if (!entry) return 0;
    if (entry.lockedUntil > now) return Math.ceil((entry.lockedUntil - now) / 1_000);
    if (entry.lastAttemptAt <= now - BOOTSTRAP_WINDOW_MS) failures.delete(key);
    return 0;
  }

  function rememberFailure(key, now = Date.now()) {
    const current = failures.get(key);
    if (!current || current.lastAttemptAt <= now - BOOTSTRAP_WINDOW_MS) {
      if (!current && failures.size >= 1_024) failures.delete(failures.keys().next().value);
      failures.set(key, { failures: 1, lastAttemptAt: now, lockedUntil: 0 });
      return;
    }
    current.failures = Math.min(MAX_BOOTSTRAP_FAILURES, current.failures + 1);
    current.lastAttemptAt = now;
    if (current.failures >= MAX_BOOTSTRAP_FAILURES) current.lockedUntil = now + BOOTSTRAP_LOCKOUT_MS;
  }

  async function readSecretFile(filePath, source) {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile()) {
      throw bootstrapError(500, 'bootstrap_secret_invalid_configuration', `${source} must point to a regular file.`);
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw bootstrapError(
        500,
        'bootstrap_secret_invalid_permissions',
        `${source} must not be accessible by group or other users.`,
      );
    }
    return normalizeSecret(await fs.readFile(filePath, 'utf8'), source);
  }

  return {
    async initialize({ ownerConfigured }) {
      if (initialized) return;
      if (!required) {
        activeSecret = null;
        initialized = true;
        return;
      }
      if (ownerConfigured) {
        activeSecret = null;
        if (!configuredFile) {
          await fs.rm(defaultFile, { force: true }).catch((error) => {
            try { options.onWarning?.(`Could not remove the obsolete bootstrap secret file ${defaultFile}.`, error); } catch { /* logging must not block startup */ }
          });
        }
        initialized = true;
        return;
      }
      if (options.secret !== undefined && configuredFile) {
        throw bootstrapError(
          500,
          'bootstrap_secret_invalid_configuration',
          'Configure the bootstrap secret with either the environment value or a file, not both.',
        );
      }
      if (options.secret !== undefined) {
        activeSecret = normalizeSecret(options.secret, 'The bootstrap secret environment value');
        initialized = true;
        return;
      }
      const existing = await readSecretFile(
        secretFile,
        configuredFile ? 'The configured bootstrap secret file' : 'The persisted bootstrap secret file',
      );
      if (existing) {
        activeSecret = existing;
        generatedFile = !configuredFile;
        initialized = true;
        return;
      }
      if (configuredFile) {
        throw bootstrapError(
          500,
          'bootstrap_secret_file_missing',
          `The configured bootstrap secret file does not exist: ${configuredFile}`,
        );
      }
      await fs.mkdir(dataDir, { recursive: true });
      const generated = randomBytes(MIN_BOOTSTRAP_SECRET_BYTES).toString('base64url');
      try {
        await fs.writeFile(defaultFile, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        activeSecret = generated;
        generatedFile = true;
        initialized = true;
        try {
          options.onGenerated?.({ secret: generated, file: defaultFile });
        } catch (error) {
          try { options.onWarning?.('Could not emit the generated bootstrap secret to the operator log.', error); } catch { /* logging must not break bootstrap */ }
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        activeSecret = await readSecretFile(defaultFile, 'The persisted bootstrap secret file');
        generatedFile = true;
        initialized = true;
      }
    },

    authorize(presentedSecret, address) {
      if (!required) return;
      if (!initialized || !activeSecret) {
        throw bootstrapError(409, 'bootstrap_unavailable', 'Owner bootstrap is no longer available.');
      }
      const key = addressKey(address);
      const retryAfter = retryAfterFor(key);
      if (retryAfter) {
        throw bootstrapError(429, 'bootstrap_locked', 'Too many owner bootstrap attempts. Try again later.', retryAfter);
      }
      if (!constantTimeSecretEqual(activeSecret, presentedSecret)) {
        rememberFailure(key);
        const lockedFor = retryAfterFor(key);
        throw bootstrapError(
          lockedFor ? 429 : 401,
          lockedFor ? 'bootstrap_locked' : 'bootstrap_secret_invalid',
          lockedFor ? 'Too many owner bootstrap attempts. Try again later.' : 'The bootstrap secret is missing or invalid.',
          lockedFor,
        );
      }
      failures.delete(key);
    },

    async invalidate() {
      activeSecret = null;
      failures.clear();
      if (!generatedFile) return;
      generatedFile = false;
      await fs.rm(defaultFile, { force: true }).catch((error) => {
        try { options.onWarning?.(`Could not remove the generated bootstrap secret file ${defaultFile}.`, error); } catch { /* logging must not change owner state */ }
      });
    },
  };
}
