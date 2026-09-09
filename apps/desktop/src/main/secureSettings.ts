import type { SettingsData } from './databasePlaybackRepository.ts';

export const SECURE_SETTINGS_FIELD = '__loomtvSecureSettings';
export const SECURE_SETTINGS_RECOVERY_FIELD = '__loomtvSecureSettingsRecovery';
export const SECURE_SETTINGS_VERSION = 1;
export const SECRET_SETTINGS_KEYS = [
  'metadataApiKeys',
  'omdbApiKey',
  'tmdbApiKey',
  'openSubtitlesUsername',
  'openSubtitlesPassword',
  'localNetworkHmacSecret',
  'localNetworkShareToken',
] as const;

type SecretSettingsKey = typeof SECRET_SETTINGS_KEYS[number];

export interface SecureSettingsCodec {
  isEncryptionAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export class SecureSettingsUnavailableError extends Error {
  readonly code = 'secure_settings_unavailable';

  constructor(message = 'The operating system secret store is unavailable.') {
    super(message);
    this.name = 'SecureSettingsUnavailableError';
  }
}

export class SecureSettingsCorruptError extends Error {
  readonly code = 'secure_settings_corrupt';

  constructor(message = 'The encrypted settings could not be recovered.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'SecureSettingsCorruptError';
  }
}

export type SecureSettingsRead = {
  settings: SettingsData;
  needsMigration: boolean;
};

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSecretSettingsKey(value: string): value is SecretSettingsKey {
  return (SECRET_SETTINGS_KEYS as readonly string[]).includes(value);
}

function collectSecrets(settings: SettingsData): Record<string, unknown> {
  const secrets: Record<string, unknown> = {};
  for (const key of SECRET_SETTINGS_KEYS) {
    if (hasOwn(settings, key) && settings[key] !== undefined) secrets[key] = settings[key];
  }
  return secrets;
}

export function parseSettingsJson(value: string): SettingsData {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new SecureSettingsCorruptError('Settings must contain an object.');
  return parsed;
}

export function assertValidSettingsSecrets(settings: SettingsData): void {
  for (const key of SECRET_SETTINGS_KEYS) {
    const value = settings[key];
    if (value === undefined) continue;
    if (key === 'metadataApiKeys') {
      if (isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')) continue;
    } else if (typeof value === 'string') {
      if (key === 'localNetworkHmacSecret' && !/^[0-9a-f]{32,}$/i.test(value)) {
        throw new SecureSettingsCorruptError('The saved LAN signing secret is invalid.');
      }
      if (key === 'localNetworkShareToken' && !/^\d{6}$/.test(value)) {
        throw new SecureSettingsCorruptError('The saved LAN share code is invalid.');
      }
      continue;
    }
    throw new SecureSettingsCorruptError('A saved credential has an invalid type.');
  }
}

// Keep orchestration pure so failed legacy reads and secure writes can be tested
// without importing Electron. Only absence of both sources permits defaults.
export function loadOrInitializeSettings<T>(deps: {
  loadDatabase: () => SettingsData | null;
  readLegacy: () => SettingsData | null;
  normalize: (settings: SettingsData) => T;
  save: (settings: T) => void;
}): T {
  const database = deps.loadDatabase();
  const stored = database ?? deps.readLegacy();
  if (stored) assertValidSettingsSecrets(stored);
  const normalized = deps.normalize(stored ?? {});
  if (!database || Number(database.localNetworkSecurityEpoch) !== 2) deps.save(normalized);
  return normalized;
}

function decryptEnvelope(value: unknown, codec: SecureSettingsCodec): Record<string, unknown> {
  if (!isRecord(value) || value.version !== SECURE_SETTINGS_VERSION || typeof value.encrypted !== 'string' || !value.encrypted) {
    throw new SecureSettingsCorruptError();
  }
  if (!codec.isEncryptionAvailable()) throw new SecureSettingsUnavailableError();

  let plaintext: string;
  try {
    plaintext = codec.decrypt(value.encrypted);
  } catch (error) {
    if (!codec.isEncryptionAvailable()) throw new SecureSettingsUnavailableError();
    throw new SecureSettingsCorruptError('The encrypted settings could not be decrypted.', { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (error) {
    throw new SecureSettingsCorruptError('The encrypted settings payload is invalid JSON.', { cause: error });
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => !isSecretSettingsKey(key))) {
    throw new SecureSettingsCorruptError('The encrypted settings payload contains unsupported fields.');
  }
  assertValidSettingsSecrets(parsed);
  return parsed;
}

export function readSecureSettings(stored: SettingsData, codec: SecureSettingsCodec): SecureSettingsRead {
  const raw = { ...stored };
  const envelope = raw[SECURE_SETTINGS_FIELD];
  delete raw[SECURE_SETTINGS_FIELD];
  delete raw[SECURE_SETTINGS_RECOVERY_FIELD];

  const legacySecrets = collectSecrets(raw);
  for (const key of SECRET_SETTINGS_KEYS) delete raw[key];

  if (hasOwn(stored, SECURE_SETTINGS_FIELD)) {
    const decrypted = decryptEnvelope(envelope, codec);
    assertValidSettingsSecrets(legacySecrets);
    const merged = { ...decrypted };
    // Older releases preserve unknown fields, including the encrypted envelope,
    // while saving their current credentials at the top level. Keep those
    // nonempty values and recover credentials absent from the older release.
    for (const [key, value] of Object.entries(legacySecrets)) {
      if (key === 'metadataApiKeys' && isRecord(value)) {
        const keys = { ...(isRecord(decrypted[key]) ? decrypted[key] : {}) };
        for (const [provider, credential] of Object.entries(value)) {
          if (credential !== '' || !hasOwn(keys, provider)) keys[provider] = credential;
        }
        merged[key] = keys;
      } else if (value !== '' || !hasOwn(merged, key)) {
        merged[key] = value;
      }
    }
    const settings = { ...raw, ...merged };
    assertValidSettingsSecrets(settings);
    return {
      settings,
      needsMigration: Object.keys(legacySecrets).length > 0,
    };
  }

  if (Object.keys(legacySecrets).length === 0) return { settings: raw, needsMigration: false };
  assertValidSettingsSecrets(stored);
  if (!codec.isEncryptionAvailable()) throw new SecureSettingsUnavailableError();
  return { settings: { ...raw, ...legacySecrets }, needsMigration: true };
}

export function writeSecureSettings(settings: SettingsData, codec: SecureSettingsCodec): SettingsData {
  if (hasOwn(settings, SECURE_SETTINGS_FIELD)) throw new SecureSettingsCorruptError('Settings must be decrypted before saving.');
  assertValidSettingsSecrets(settings);
  const output = { ...settings };
  delete output[SECURE_SETTINGS_RECOVERY_FIELD];
  const secrets = collectSecrets(settings);
  for (const key of SECRET_SETTINGS_KEYS) delete output[key];

  if (Object.keys(secrets).length === 0) return output;
  if (!codec.isEncryptionAvailable()) throw new SecureSettingsUnavailableError();

  const encrypted = codec.encrypt(JSON.stringify(secrets));
  if (!encrypted) throw new SecureSettingsCorruptError('The secret store returned empty ciphertext.');
  output[SECURE_SETTINGS_FIELD] = {
    version: SECURE_SETTINGS_VERSION,
    encrypted,
  };
  return output;
}

export function createSecureSettingsPersistence(store: {
  load: () => SettingsData | null;
  save: (settings: SettingsData) => void;
  transaction: <T>(action: () => T) => T;
}, codec: SecureSettingsCodec) {
  function protectedRecord(settings: SettingsData, stored: SettingsData | null): SettingsData {
    const output = writeSecureSettings(settings, codec);
    const previous = stored?.[SECURE_SETTINGS_RECOVERY_FIELD];
    const recovery = Array.isArray(previous) ? [...previous] : [];
    if (stored && hasOwn(stored, SECURE_SETTINGS_FIELD)) {
      const legacy = collectSecrets(stored);
      if (Object.keys(legacy).length > 0) {
        recovery.push({
          encrypted: stored[SECURE_SETTINGS_FIELD],
          legacy: writeSecureSettings(legacy, codec)[SECURE_SETTINGS_FIELD],
        });
      }
    }
    if (recovery.length) output[SECURE_SETTINGS_RECOVERY_FIELD] = recovery;
    return output;
  }
  return {
    load: (): SettingsData | null => store.transaction(() => {
      const stored = store.load();
      if (!stored) return null;
      const result = readSecureSettings(stored, codec);
      if (result.needsMigration) store.save(protectedRecord(result.settings, stored));
      return result.settings;
    }),
    save: (settings: SettingsData): void => store.transaction(() => {
      const stored = store.load();
      const current = stored ? readSecureSettings(stored, codec).settings : {};
      const retainedSecrets = Object.fromEntries(SECRET_SETTINGS_KEYS
        .filter((key) => hasOwn(current, key))
        .map((key) => [key, current[key]]));
      const incoming = { ...settings };
      for (const key of SECRET_SETTINGS_KEYS) {
        if (incoming[key] === undefined) delete incoming[key];
      }
      store.save(protectedRecord({ ...retainedSecrets, ...incoming }, stored));
    }),
  };
}
