import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

const SECRET_REF_PREFIX = 'loomtv-secret-v1_';
const MAX_SECRET_BYTES = 64 * 1024;
const SECRET_REF_PATTERN = /^loomtv-secret-v1_[A-Za-z0-9_-]{32}$/;

export type SecretCodec = {
  encrypt(value: string): string;
  decrypt(value: string): string;
};

export type PluginSecretReference = {
  ref: string;
  fieldKey: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export class PluginSecretStoreError extends Error {
  readonly code:
    | 'PLUGIN_SECRET_INVALID'
    | 'PLUGIN_SECRET_NOT_FOUND'
    | 'PLUGIN_SECRET_INTEGRITY_FAILED'
    | 'PLUGIN_SECRET_STORAGE_UNAVAILABLE';

  constructor(
    code: PluginSecretStoreError['code'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PluginSecretStoreError';
    this.code = code;
  }
}

type SecretRow = {
  ref: string;
  addon_id: string;
  field_key: string;
  ciphertext: string;
  revision: number;
  integrity_mac: string;
  created_at: number;
  updated_at: number;
};

function safeIdentity(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new PluginSecretStoreError('PLUGIN_SECRET_INVALID', `${label} is invalid.`);
  }
  return normalized;
}

function addonId(value: unknown): string {
  return safeIdentity(value, 'The add-on identity', 240);
}

function fieldKey(value: unknown): string {
  const key = safeIdentity(value, 'The configuration field', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) {
    throw new PluginSecretStoreError('PLUGIN_SECRET_INVALID', 'The configuration field contains unsupported characters.');
  }
  return key;
}

function secretValue(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
    throw new PluginSecretStoreError('PLUGIN_SECRET_INVALID', 'The configuration value is missing or too large.');
  }
  return value;
}

function createReference(): string {
  return `${SECRET_REF_PREFIX}${randomBytes(24).toString('base64url')}`;
}

function macPayload(row: Pick<SecretRow, 'ref' | 'addon_id' | 'field_key' | 'ciphertext' | 'revision'>): string {
  return [row.ref, row.addon_id, row.field_key, row.ciphertext, String(row.revision)].join('\u0000');
}

function macFor(key: Buffer, row: Pick<SecretRow, 'ref' | 'addon_id' | 'field_key' | 'ciphertext' | 'revision'>): string {
  return createHmac('sha256', key).update(macPayload(row), 'utf8').digest('hex');
}

function validMac(key: Buffer, row: SecretRow): boolean {
  if (!SECRET_REF_PATTERN.test(row.ref) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(row.field_key)) return false;
  if (!/^[a-f0-9]{64}$/i.test(row.integrity_mac)) return false;
  const expected = Buffer.from(macFor(key, row), 'hex');
  const actual = Buffer.from(row.integrity_mac, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class PluginSecretStore {
  private readonly macKey: Buffer;

  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly codec: SecretCodec,
    macKey: Buffer | string,
  ) {
    this.macKey = Buffer.isBuffer(macKey) ? Buffer.from(macKey) : Buffer.from(macKey, 'utf8');
    if (this.macKey.length < 32) {
      throw new PluginSecretStoreError('PLUGIN_SECRET_STORAGE_UNAVAILABLE', 'The host secret-store integrity key is unavailable.');
    }
  }

  getRevision(): number {
    const row = this.database.prepare('SELECT revision FROM plugin_secret_revisions WHERE id = 1').get() as { revision?: number } | undefined;
    return Number.isSafeInteger(row?.revision) && Number(row?.revision) >= 0 ? Number(row?.revision) : 0;
  }

  put(addonIdentity: string, fieldIdentity: string, rawValue: unknown): PluginSecretReference {
    const addon = addonId(addonIdentity);
    const field = fieldKey(fieldIdentity);
    const value = secretValue(rawValue);
    const existing = this.values(addon);
    existing[field] = value;
    return this.replace(addon, existing).find((reference) => reference.fieldKey === field)!;
  }

  /** Replace one add-on's host-only configuration atomically. */
  replace(addonIdentity: string, rawValues: Readonly<Record<string, unknown>>): readonly PluginSecretReference[] {
    const addon = addonId(addonIdentity);
    const values = Object.entries(rawValues).map(([rawField, rawValue]) => ({
      field: fieldKey(rawField),
      value: secretValue(rawValue),
    }));
    let ciphertext: string;
    const protectedValues = values.map(({ field, value }) => {
      try {
        ciphertext = this.codec.encrypt(value);
      } catch (error) {
        throw new PluginSecretStoreError('PLUGIN_SECRET_STORAGE_UNAVAILABLE', 'The host could not protect this configuration value.', { cause: error });
      }
      if (!ciphertext || Buffer.byteLength(ciphertext, 'utf8') > 1024 * 1024) {
        throw new PluginSecretStoreError('PLUGIN_SECRET_STORAGE_UNAVAILABLE', 'The protected configuration value is invalid.');
      }
      return { field, ciphertext, ref: createReference() };
    });
    const transaction = this.database.transaction(() => {
      const existing = this.database.prepare('SELECT COUNT(*) AS count FROM plugin_secrets WHERE addon_id = ?').get(addon) as { count: number };
      if (existing.count > 0 || protectedValues.length > 0) {
        this.database.prepare('UPDATE plugin_secret_revisions SET revision = revision + 1 WHERE id = 1').run();
      }
      const revision = this.getRevision();
      this.database.prepare('DELETE FROM plugin_secrets WHERE addon_id = ?').run(addon);
      const now = Date.now();
      const insert = this.database.prepare(`
        INSERT INTO plugin_secrets
          (ref, addon_id, field_key, ciphertext, revision, integrity_mac, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      return protectedValues.map(({ ref, field, ciphertext: protectedValue }) => {
        const row = {
          ref,
          addon_id: addon,
          field_key: field,
          ciphertext: protectedValue,
          revision,
          created_at: now,
          updated_at: now,
        };
        insert.run(row.ref, row.addon_id, row.field_key, row.ciphertext, row.revision, macFor(this.macKey, row), row.created_at, row.updated_at);
        return row;
      });
    });
    const rows = transaction() as Array<{
      ref: string;
      field_key: string;
      revision: number;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      ref: row.ref,
      fieldKey: row.field_key,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  get(addonIdentity: string, refIdentity: string, expectedField?: string): string {
    const addon = addonId(addonIdentity);
    const ref = safeIdentity(refIdentity, 'The secret reference', 160);
    if (!SECRET_REF_PATTERN.test(ref)) {
      throw new PluginSecretStoreError('PLUGIN_SECRET_INVALID', 'The secret reference is not a host-issued opaque reference.');
    }
    const row = this.database.prepare('SELECT * FROM plugin_secrets WHERE ref = ? AND addon_id = ?').get(ref, addon) as SecretRow | undefined;
    if (!row || (expectedField !== undefined && row.field_key !== fieldKey(expectedField))) {
      throw new PluginSecretStoreError('PLUGIN_SECRET_NOT_FOUND', 'The requested host secret is unavailable.');
    }
    if (!validMac(this.macKey, row)) {
      throw new PluginSecretStoreError('PLUGIN_SECRET_INTEGRITY_FAILED', 'The host secret failed its integrity check.');
    }
    try {
      return secretValue(this.codec.decrypt(row.ciphertext));
    } catch (error) {
      throw new PluginSecretStoreError('PLUGIN_SECRET_INTEGRITY_FAILED', 'The host secret could not be recovered safely.', { cause: error });
    }
  }

  list(addonIdentity: string): readonly PluginSecretReference[] {
    const addon = addonId(addonIdentity);
    return (this.database.prepare(`
      SELECT ref, field_key, revision, created_at, updated_at
      FROM plugin_secrets WHERE addon_id = ? ORDER BY field_key COLLATE NOCASE
    `).all(addon) as Array<{ ref: string; field_key: string; revision: number; created_at: number; updated_at: number }>).map((row) => ({
      ref: row.ref,
      fieldKey: row.field_key,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  hasRequired(addonIdentity: string, requiredFields: readonly string[]): boolean {
    const addon = addonId(addonIdentity);
    return requiredFields.every((field) => {
      const row = this.list(addon).find((candidate) => candidate.fieldKey === fieldKey(field));
      if (!row) return false;
      try {
        return this.get(addon, row.ref, row.fieldKey).length > 0;
      } catch {
        return false;
      }
    });
  }

  values(addonIdentity: string): Record<string, string> {
    const addon = addonId(addonIdentity);
    const values: Record<string, string> = {};
    for (const reference of this.list(addon)) values[reference.fieldKey] = this.get(addon, reference.ref, reference.fieldKey);
    return values;
  }

  remove(addonIdentity: string, fieldIdentity: string): number {
    const addon = addonId(addonIdentity);
    const field = fieldKey(fieldIdentity);
    const transaction = this.database.transaction(() => {
      const removed = this.database.prepare('DELETE FROM plugin_secrets WHERE addon_id = ? AND field_key = ?').run(addon, field).changes;
      if (removed > 0) this.database.prepare('UPDATE plugin_secret_revisions SET revision = revision + 1 WHERE id = 1').run();
      return removed;
    });
    return Number(transaction());
  }

  /** Delete corrupt entries explicitly; invalid rows are never silently used. */
  repair(addonIdentity?: string): { removed: number; revision: number } {
    const addon = addonIdentity === undefined ? undefined : addonId(addonIdentity);
    const rows = (addon
      ? this.database.prepare('SELECT * FROM plugin_secrets WHERE addon_id = ?').all(addon)
      : this.database.prepare('SELECT * FROM plugin_secrets').all()) as SecretRow[];
    const transaction = this.database.transaction(() => {
      let removed = 0;
      const remove = this.database.prepare('DELETE FROM plugin_secrets WHERE ref = ?');
      for (const row of rows) {
        let valid = validMac(this.macKey, row);
        if (valid) {
          try { secretValue(this.codec.decrypt(row.ciphertext)); } catch { valid = false; }
        }
        if (!valid) {
          remove.run(row.ref);
          removed += 1;
        }
      }
      if (removed > 0) this.database.prepare('UPDATE plugin_secret_revisions SET revision = revision + 1').run();
      return removed;
    });
    const removed = Number(transaction());
    return { removed, revision: this.getRevision() };
  }
}

export type PluginAuditEntry = {
  id: number;
  addonId: string;
  eventType: string;
  detail: Readonly<Record<string, unknown>>;
  createdAt: number;
};

export function recordPluginAudit(database: BetterSqlite3.Database, addonIdentity: string, eventType: string, detail: Record<string, unknown> = {}): void {
  const addon = addonId(addonIdentity);
  const event = safeIdentity(eventType, 'The audit event', 64);
  const detailJson = JSON.stringify(detail);
  if (Buffer.byteLength(detailJson, 'utf8') > 16_384) throw new PluginSecretStoreError('PLUGIN_SECRET_INVALID', 'The audit detail is too large.');
  database.prepare('INSERT INTO stremio_plugin_audit (addon_id, event_type, detail_json, created_at) VALUES (?, ?, ?, ?)')
    .run(addon, event, detailJson, Date.now());
}

export function listPluginAudit(database: BetterSqlite3.Database, addonIdentity: string, limit = 100): readonly PluginAuditEntry[] {
  const addon = addonId(addonIdentity);
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
  return (database.prepare(`
    SELECT id, addon_id, event_type, detail_json, created_at
    FROM stremio_plugin_audit WHERE addon_id = ? ORDER BY id DESC LIMIT ?
  `).all(addon, boundedLimit) as Array<{ id: number; addon_id: string; event_type: string; detail_json: string; created_at: number }>).flatMap((row) => {
    try {
      const detail = JSON.parse(row.detail_json) as unknown;
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return [];
      return [{ id: row.id, addonId: row.addon_id, eventType: row.event_type, detail: detail as Record<string, unknown>, createdAt: row.created_at }];
    } catch {
      return [];
    }
  });
}
