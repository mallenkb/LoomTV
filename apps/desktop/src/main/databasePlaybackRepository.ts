import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { parseStoredJson, unknownRecordSchema } from './runtimeValidation.ts';

export type SettingsData = Record<string, unknown>;

export type StoredProgress = {
  position: number;
  duration: number;
  updatedAt: number;
  watched: boolean;
};

type TrackPreference = {
  enabled: boolean;
  index?: number;
  language?: string;
  title?: string;
  codec?: string;
  forced?: boolean;
};

export type PlaybackTrackPreferences = {
  audio?: TrackPreference;
  subtitle?: TrackPreference;
};

type ProgressRow = {
  file_path: string;
  position: number;
  duration: number;
  updated_at: number;
  watched: number;
};

type PlaybackTrackPreferenceRow = {
  scope: string;
  preferences_json: string;
  updated_at: number;
};

const trackPreferenceInputSchema = z.object({
  enabled: z.boolean().optional(),
  index: z.number().finite().optional(),
  language: z.string().optional(),
  title: z.string().optional(),
  codec: z.string().optional(),
  forced: z.boolean().optional(),
});
const trackPreferencesInputSchema = z.object({
  audio: z.unknown().optional(),
  subtitle: z.unknown().optional(),
});

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function normalizeTrackPreference(value: unknown): TrackPreference | undefined {
  const result = trackPreferenceInputSchema.safeParse(value);
  if (!result.success) return undefined;
  const preference = result.data;
  return {
    enabled: Boolean(preference.enabled),
    ...(typeof preference.index === 'number' && Number.isFinite(preference.index) ? { index: preference.index } : {}),
    ...(typeof preference.language === 'string' ? { language: preference.language.trim().toLowerCase() } : {}),
    ...(typeof preference.title === 'string' ? { title: preference.title.trim().toLowerCase() } : {}),
    ...(typeof preference.codec === 'string' ? { codec: preference.codec.trim().toLowerCase() } : {}),
    ...(typeof preference.forced === 'boolean' ? { forced: preference.forced } : {}),
  };
}

function normalizeTrackPreferences(value: unknown): PlaybackTrackPreferences {
  const result = trackPreferencesInputSchema.safeParse(value);
  const preferences = result.success ? result.data : {};
  return {
    ...(preferences.audio ? { audio: normalizeTrackPreference(preferences.audio) } : {}),
    ...(preferences.subtitle ? { subtitle: normalizeTrackPreference(preferences.subtitle) } : {}),
  };
}

export function loadSettings(database: BetterSqlite3.Database): SettingsData | null {
  const row = database.prepare('SELECT data_json FROM app_settings WHERE id = 1').get() as { data_json: string } | undefined;
  return row ? parseStoredJson(row.data_json, unknownRecordSchema, {}) : null;
}

export function saveSettings(database: BetterSqlite3.Database, settings: SettingsData): void {
  database.prepare('INSERT OR REPLACE INTO app_settings (id, data_json, updated_at) VALUES (1, ?, ?)').run(jsonString(settings), Date.now());
}

export function getProgress(database: BetterSqlite3.Database, profileId: string, filePath: string): StoredProgress | null {
  const row = database.prepare('SELECT * FROM playback_progress WHERE profile_id = ? AND file_path = ?').get(profileId, filePath) as ProgressRow | undefined;
  if (!row) return null;
  return { position: row.position, duration: row.duration, updatedAt: row.updated_at, watched: Boolean(row.watched) };
}

export function getAllProgress(database: BetterSqlite3.Database, profileId: string): Record<string, StoredProgress> {
  return Object.fromEntries((database.prepare('SELECT * FROM playback_progress WHERE profile_id = ?').all(profileId) as ProgressRow[]).map((row): [string, StoredProgress] => [
    row.file_path,
    { position: row.position, duration: row.duration, updatedAt: row.updated_at, watched: Boolean(row.watched) },
  ]));
}

export function getPlaybackTrackPreferences(
  database: BetterSqlite3.Database,
  profileId: string,
  scope?: string,
): PlaybackTrackPreferences | Record<string, PlaybackTrackPreferences> {
  if (scope) {
    const row = database.prepare('SELECT preferences_json FROM playback_track_preferences WHERE profile_id = ? AND scope = ?').get(profileId, scope) as Pick<PlaybackTrackPreferenceRow, 'preferences_json'> | undefined;
    return row ? normalizeTrackPreferences(parseStoredJson(row.preferences_json, unknownRecordSchema, {})) : {};
  }

  return Object.fromEntries((database.prepare('SELECT * FROM playback_track_preferences WHERE profile_id = ?').all(profileId) as PlaybackTrackPreferenceRow[])
    .map((row): [string, PlaybackTrackPreferences] => [
      row.scope,
      normalizeTrackPreferences(parseStoredJson(row.preferences_json, unknownRecordSchema, {})),
    ]));
}

export function savePlaybackTrackPreferences(
  database: BetterSqlite3.Database,
  profileId: string,
  scope: string,
  preferences: PlaybackTrackPreferences,
): PlaybackTrackPreferences {
  const safeScope = String(scope || '').trim();
  if (!safeScope) return {};
  const stored = normalizeTrackPreferences(preferences);
  database.prepare(`
    INSERT OR REPLACE INTO playback_track_preferences (profile_id, scope, preferences_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(profileId, safeScope, jsonString(stored), Date.now());
  return stored;
}

export function saveProgress(
  database: BetterSqlite3.Database,
  profileId: string,
  filePath: string,
  position: number,
  duration: number,
): StoredProgress {
  const safePosition = Number.isFinite(position) ? Math.max(0, position) : 0;
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const watched = safeDuration > 0 && safePosition / safeDuration >= 0.9;
  const stored: StoredProgress = {
    position: watched ? safeDuration : safePosition,
    duration: safeDuration,
    updatedAt: Date.now(),
    watched,
  };
  database.prepare(`
    INSERT OR REPLACE INTO playback_progress (profile_id, file_path, position, duration, updated_at, watched)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(profileId, filePath, stored.position, stored.duration, stored.updatedAt, stored.watched ? 1 : 0);
  return stored;
}

export function importProgress(
  database: BetterSqlite3.Database,
  profileId: string,
  progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>,
): void {
  const upsert = database.prepare(`
    INSERT INTO playback_progress (profile_id, file_path, position, duration, updated_at, watched)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, file_path) DO UPDATE SET
      position = excluded.position,
      duration = excluded.duration,
      updated_at = excluded.updated_at,
      watched = excluded.watched
    WHERE excluded.updated_at > playback_progress.updated_at
  `);
  const tx = database.transaction(() => {
    for (const [filePath, value] of Object.entries(progress || {})) {
      const position = typeof value === 'number' ? value : Number(value.position || 0);
      const duration = typeof value === 'object' ? Number(value.duration || 0) : 0;
      const updatedAt = typeof value === 'object' && value.updatedAt ? Number(value.updatedAt) : Date.now();
      const watched = duration > 0 && position / duration >= 0.9;
      upsert.run(profileId, filePath, watched ? duration : position, duration, updatedAt, watched ? 1 : 0);
    }
  });
  tx();
}
