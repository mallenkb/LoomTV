/**
 * One source of truth for first-run setup.
 *
 * Both entry points — the desktop window and the headless browser admin —
 * redirect to `/setup` and drive it through `/api/v1/setup/*`, so neither can
 * hold private setup progress that the other cannot see. Progress lives in the
 * canonical state database next to the accounts it creates, which is what makes
 * setup resumable after a refresh, a sign-out, or a server restart.
 */

export const SETUP_META_KEY = 'setup.state';
export const SETUP_STEPS = ['account', 'libraries', 'metadata', 'ready'];
export const SETUP_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'sv', label: 'Svenska' },
  { code: 'pl', label: 'Polski' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '中文' },
];

/** The desktop metadata defaults: TMDB supplies artwork and ratings. */
export const DEFAULT_METADATA_SETTINGS = {
  provider: 'tmdb',
  artworkProvider: 'tmdb',
  ratingSource: 'tmdb',
  offlineMode: false,
};

const MAX_NAME_LENGTH = 80;

function setupError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function normalizeLanguage(value) {
  const language = String(value || '').trim();
  if (!language) return 'en';
  const match = SETUP_LANGUAGES.find((entry) => entry.code === language.slice(0, 2).toLowerCase());
  return match ? match.code : 'en';
}

function normalizeStep(value) {
  return SETUP_STEPS.includes(value) ? value : 'account';
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
  const rawApiKeys = metadata.apiKeys && typeof metadata.apiKeys === 'object' ? metadata.apiKeys : {};
  const apiKeys = Object.fromEntries(
    ['tmdb', 'fanart', 'omdb', 'opensubtitles'].flatMap((provider) => {
      const value = provider === 'tmdb' && !rawApiKeys[provider] ? metadata.apiKey : rawApiKeys[provider];
      return typeof value === 'string' && value.trim() ? [[provider, value.trim().slice(0, 512)]] : [];
    }),
  );
  return {
    version: 1,
    step: normalizeStep(raw.step),
    serverName: typeof raw.serverName === 'string' ? raw.serverName.slice(0, MAX_NAME_LENGTH) : '',
    language: normalizeLanguage(raw.language),
    ownerName: typeof raw.ownerName === 'string' ? raw.ownerName.slice(0, MAX_NAME_LENGTH) : '',
    metadata: {
      ...DEFAULT_METADATA_SETTINGS,
      ...(typeof metadata.provider === 'string' ? { provider: metadata.provider.slice(0, 32) } : {}),
      apiKeys,
      ...(metadata.offlineMode === true ? { offlineMode: true } : {}),
      skipped: metadata.skipped === true,
    },
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : Date.now(),
    completedAt: Number.isFinite(raw.completedAt) ? raw.completedAt : null,
    scanStarted: raw.scanStarted === true,
  };
}

function freshRecord() {
  return normalizeRecord({ step: 'account', startedAt: Date.now(), metadata: {} });
}

export function createSetupService({ store, isOwnerConfigured }) {
  if (!store) throw new Error('createSetupService requires the canonical state store.');
  if (typeof isOwnerConfigured !== 'function') throw new Error('createSetupService requires an owner-state reader.');

  function readRecord() {
    try {
      const raw = store.readMeta(SETUP_META_KEY);
      return raw ? normalizeRecord(JSON.parse(raw)) : null;
    } catch {
      // A corrupt progress record must never block an install. Setup restarts
      // from the first step; nothing else in the database depends on it.
      return null;
    }
  }

  function writeRecord(record) {
    store.writeMeta(SETUP_META_KEY, JSON.stringify(record));
    return record;
  }

  return {
    /**
     * Public status. `required` is what `/app` and `/admin` redirect on, and it
     * stays false for every installation that already had an owner before this
     * flow existed: those have no progress record and are treated as finished.
     */
    async status() {
      const ownerConfigured = await isOwnerConfigured();
      const record = readRecord();
      if (!record) {
        return {
          ownerConfigured,
          required: !ownerConfigured,
          completed: ownerConfigured,
          step: ownerConfigured ? 'ready' : 'account',
          serverName: '',
          language: 'en',
        };
      }
      const completed = Boolean(record.completedAt) && ownerConfigured;
      return {
        ownerConfigured,
        required: !completed,
        completed,
        step: completed ? 'ready' : ownerConfigured ? normalizeStep(record.step) : 'account',
        serverName: record.serverName,
        language: record.language,
        metadataConfigured: Object.keys(record.metadata.apiKeys || {}).length > 0,
        metadataSkipped: record.metadata.skipped === true,
        scanStarted: record.scanStarted,
      };
    },

    /** The saved record, or a fresh one. Callers must not leak `metadata.apiKey`. */
    read() {
      return readRecord() || freshRecord();
    },

    /** Server identity and language, for clients that render the server name. */
    identity() {
      const record = readRecord();
      return {
        serverName: record?.serverName || '',
        language: record?.language || 'en',
      };
    },

    metadataSettings() {
      const record = readRecord();
      const metadata = record?.metadata || { ...DEFAULT_METADATA_SETTINGS };
      const { apiKey: _legacyApiKey, apiKeys = {}, ...rest } = metadata;
      const configuredProviders = Object.keys(apiKeys).filter((provider) => Boolean(apiKeys[provider]));
      return { ...rest, configured: configuredProviders.length > 0, configuredProviders };
    },

    begin({ ownerName, serverName, language }) {
      const record = readRecord() || freshRecord();
      return writeRecord({
        ...record,
        ownerName: String(ownerName || '').trim().slice(0, MAX_NAME_LENGTH),
        serverName: String(serverName || '').trim().slice(0, MAX_NAME_LENGTH),
        language: normalizeLanguage(language),
        step: 'libraries',
      });
    },

    setStep(step) {
      const next = normalizeStep(step);
      if (!SETUP_STEPS.includes(step)) throw setupError(400, 'invalid_request', 'Unknown setup step.');
      const record = readRecord() || freshRecord();
      if (record.completedAt) return record;
      return writeRecord({ ...record, step: next });
    },

    saveMetadata({ provider, apiKey, keys, skipped }) {
      const record = readRecord() || freshRecord();
      const nextKeys = keys && typeof keys === 'object'
        ? Object.fromEntries(['tmdb', 'fanart', 'omdb', 'opensubtitles'].flatMap((providerId) => {
          const value = keys[providerId];
          return typeof value === 'string' && value.trim() ? [[providerId, value.trim().slice(0, 512)]] : [];
        }))
        : apiKey ? { tmdb: String(apiKey).trim().slice(0, 512) } : {};
      const metadata = {
        ...record.metadata,
        ...(provider ? { provider: String(provider).slice(0, 32) } : {}),
        apiKeys: skipped ? {} : { ...(record.metadata.apiKeys || {}), ...nextKeys },
        skipped: skipped === true,
      };
      delete metadata.apiKey;
      return writeRecord({ ...record, metadata, step: 'ready' });
    },

    complete({ scanStarted }) {
      const record = readRecord() || freshRecord();
      return writeRecord({
        ...record,
        step: 'ready',
        scanStarted: scanStarted === true || record.scanStarted,
        completedAt: record.completedAt || Date.now(),
      });
    },
  };
}
