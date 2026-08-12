import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { parseDatabaseRow, parseDatabaseRows } from './databaseRows.ts';
import { parseStoredJson } from './runtimeValidation.ts';
import { resolveCandidates } from './skipSegments/normalize.ts';
import type {
  MediaSegment,
  MediaSegmentCandidate,
  MediaSegmentSource,
  ProviderCacheEntry,
} from './skipSegments/types.ts';
import { canTransitionSegmentAnalysisJob, type SegmentAnalysisJob, type SegmentAnalysisJobState } from './skipSegments/analysisJobs.ts';

export type StoredMediaFingerprint = {
  fileRevision: string;
  audioTrack: number;
  windowType: 'intro' | 'credits' | 'recap' | 'preview';
  algorithmVersion: string;
  fingerprintJson: string;
  durationMs: number;
  updatedAt: number;
};

export type SegmentAnalysisInventory = {
  fileRevision: string;
  mediaId: string;
  season: number;
  episode: number;
  configHash: string;
  fingerprintVersion: string;
  analyzedAt: number;
};

const finiteNumber = z.number().finite();
const segmentTypeSchema = z.enum(['intro', 'recap', 'outro', 'credits', 'preview']);
const segmentSourceSchema = z.enum(['manual', 'chapter', 'theintrodb', 'aniskip', 'chromaprint']);
const segmentAnalysisMetadataSchema = z.object({
  detector: z.enum(['chromaprint', 'blackframe', 'chapter']).optional(),
  peerSupport: finiteNumber.optional(),
  originalStartMs: finiteNumber.optional(),
  originalEndMs: finiteNumber.nullable().optional(),
  startSnap: z.enum(['chapter', 'silence', 'keyframe', 'media-edge', 'original']).optional(),
  endSnap: z.enum(['chapter', 'silence', 'keyframe', 'media-edge', 'original']).optional(),
  confidenceComponents: z.record(z.string(), finiteNumber).optional(),
  userDecision: z.object({
    status: z.enum(['active', 'rejected']).optional(),
    type: segmentTypeSchema.optional(),
  }).optional(),
});
const normalizedSegmentInputSchema = z.object({
  type: segmentTypeSchema,
  startMs: finiteNumber,
  endMs: finiteNumber.nullable(),
  source: segmentSourceSchema,
  confidence: finiteNumber,
});
const segmentCandidateSchema = z.object({
  id: z.string(),
  type: segmentTypeSchema,
  startMs: finiteNumber,
  endMs: finiteNumber.nullable(),
  confidence: finiteNumber,
  source: segmentSourceSchema,
  mediaDurationMs: finiteNumber,
  updatedAt: z.string(),
  analysisMetadata: segmentAnalysisMetadataSchema.optional(),
  mediaId: z.string(),
  season: finiteNumber,
  episode: finiteNumber,
  filePath: z.string(),
  fileRevision: z.string(),
  releaseKey: z.string().optional(),
  status: z.enum(['active', 'review', 'rejected']),
  expiresAt: finiteNumber.optional(),
});
const segmentCandidateRowSchema = z.object({
  id: z.string(),
  media_id: z.string(),
  season: finiteNumber,
  episode: finiteNumber,
  file_path: z.string(),
  file_revision: z.string(),
  release_key: z.string().nullable(),
  type: segmentTypeSchema,
  start_ms: finiteNumber,
  end_ms: finiteNumber.nullable(),
  confidence: finiteNumber,
  source: segmentSourceSchema,
  status: z.enum(['active', 'review', 'rejected']),
  media_duration_ms: finiteNumber,
  updated_at: finiteNumber,
  expires_at: finiteNumber.nullable(),
  analysis_metadata_json: z.string().nullable(),
});
type SegmentCandidateRow = z.infer<typeof segmentCandidateRowSchema>;
const segmentSourceCacheRowSchema = z.object({
  provider: z.enum(['theintrodb', 'aniskip']),
  lookup_key: z.string(),
  duration_bucket: finiteNumber,
  status: z.enum(['success', 'empty']),
  segments_json: z.string(),
  fetched_at: finiteNumber,
  expires_at: finiteNumber,
  stale_until: finiteNumber,
});
const candidateIdentityRowSchema = z.object({ id: z.string(), file_revision: z.string() });
const manualHistoryRowSchema = z.object({ history_id: z.number().int(), snapshot_json: z.string() });
const fingerprintRowSchema = z.object({
  file_revision: z.string(),
  audio_track: finiteNumber,
  window_type: z.enum(['intro', 'credits', 'recap', 'preview']),
  algorithm_version: z.string(),
  fingerprint_json: z.string(),
  duration_ms: finiteNumber,
  updated_at: finiteNumber,
});
const analysisJobKindSchema = z.enum(['manual', 'incremental', 'hash-recompute', 'cleanup']);
const analysisJobStateSchema = z.enum(['pending', 'running', 'waiting_for_peers', 'complete', 'error', 'cancelled']);
const analysisJobRowSchema = z.object({
  job_key: z.string(),
  kind: analysisJobKindSchema,
  media_id: z.string(),
  season: finiteNumber,
  episode: finiteNumber,
  file_revision: z.string(),
  config_hash: z.string(),
  state: analysisJobStateSchema,
  detail: z.string(),
  created_at: finiteNumber,
  updated_at: finiteNumber,
});
const analysisJobCountRowSchema = z.object({ state: analysisJobStateSchema, count: finiteNumber });
const analysisJobStateRowSchema = z.object({ state: analysisJobStateSchema });
const analysisInventoryRowSchema = z.object({
  file_revision: z.string(),
  media_id: z.string(),
  season: finiteNumber,
  episode: finiteNumber,
  config_hash: z.string(),
  fingerprint_version: z.string(),
  analyzed_at: finiteNumber,
});
const fileRevisionRowSchema = z.object({ file_revision: z.string() });
const countRowSchema = z.object({ count: finiteNumber });
const byteCountRowSchema = z.object({ bytes: finiteNumber });
const analysisStateRowSchema = z.object({
  job_key: z.string(),
  media_id: z.string(),
  season: finiteNumber,
  state: z.string(),
  detail: z.string(),
  updated_at: finiteNumber,
});

export function createDatabaseSegmentsRepository(database: BetterSqlite3.Database) {
  const getDb = (): BetterSqlite3.Database => database;
  const jsonString = (value: unknown): string => JSON.stringify(value ?? null);

  function candidateFromRow(row: SegmentCandidateRow): MediaSegmentCandidate {
    return {
      id: row.id,
      mediaId: row.media_id,
      season: row.season,
      episode: row.episode,
      filePath: row.file_path,
      fileRevision: row.file_revision,
      releaseKey: row.release_key || undefined,
      type: row.type,
      startMs: row.start_ms,
      endMs: row.end_ms,
      confidence: row.confidence,
      source: row.source,
      status: row.status,
      mediaDurationMs: row.media_duration_ms,
      updatedAt: new Date(row.updated_at).toISOString(),
      expiresAt: row.expires_at || undefined,
      analysisMetadata: parseStoredJson(row.analysis_metadata_json, segmentAnalysisMetadataSchema.optional(), undefined),
    };
  }

  function insertSegmentCandidate(database: BetterSqlite3.Database, candidate: MediaSegmentCandidate): void {
    database.prepare(`
      INSERT OR REPLACE INTO media_segment_candidates (
        id, media_id, season, episode, file_path, file_revision, release_key,
        type, start_ms, end_ms, confidence, source, status, media_duration_ms,
        updated_at, expires_at, analysis_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.id,
      candidate.mediaId,
      candidate.season,
      candidate.episode,
      candidate.filePath,
      candidate.fileRevision,
      candidate.releaseKey || null,
      candidate.type,
      candidate.startMs,
      candidate.endMs,
      candidate.confidence,
      candidate.source,
      candidate.status,
      candidate.mediaDurationMs,
      Date.parse(candidate.updatedAt) || Date.now(),
      candidate.expiresAt || null,
      candidate.analysisMetadata ? jsonString(candidate.analysisMetadata) : null,
    );
  }

  function getSegmentSourceCache(
    provider: ProviderCacheEntry['provider'],
    lookupKey: string,
    durationBucket: number,
  ): ProviderCacheEntry | null {
    const row = parseDatabaseRow(
      getDb().prepare(`
        SELECT provider, lookup_key, duration_bucket, status, segments_json, fetched_at, expires_at, stale_until
        FROM segment_source_cache
        WHERE provider = ? AND lookup_key = ? AND duration_bucket = ?
      `).get(provider, lookupKey, durationBucket),
      segmentSourceCacheRowSchema.optional(),
      'segment source cache',
    );
    if (!row) return null;
    return {
      provider: row.provider,
      lookupKey: row.lookup_key,
      durationBucket: row.duration_bucket,
      status: row.status,
      segments: parseStoredJson(row.segments_json, z.array(normalizedSegmentInputSchema), []),
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
      staleUntil: row.stale_until,
    };
  }

  function saveSegmentSourceCache(entry: ProviderCacheEntry): void {
    getDb().prepare(`
      INSERT OR REPLACE INTO segment_source_cache (
        provider, lookup_key, duration_bucket, status, segments_json, fetched_at, expires_at, stale_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.provider,
      entry.lookupKey,
      entry.durationBucket,
      entry.status,
      jsonString(entry.segments),
      entry.fetchedAt,
      entry.expiresAt,
      entry.staleUntil,
    );
  }

  function getSegmentCandidates(fileRevision: string): MediaSegmentCandidate[] {
    const rows = parseDatabaseRows(
      getDb().prepare(`
        SELECT * FROM media_segment_candidates
        WHERE file_revision = ? AND (expires_at IS NULL OR expires_at > ?)
      `).all(fileRevision, Date.now()),
      segmentCandidateRowSchema,
      'media segment candidate',
    );
    return rows.map(candidateFromRow);
  }

  function getManualSegmentCandidates(mediaId: string, season: number, episode: number): MediaSegmentCandidate[] {
    const rows = parseDatabaseRows(
      getDb().prepare(`
        SELECT * FROM media_segment_candidates
        WHERE media_id = ? AND season = ? AND episode = ? AND source = 'manual'
      `).all(mediaId, season, episode),
      segmentCandidateRowSchema,
      'manual media segment candidate',
    );
    return rows.map(candidateFromRow);
  }

  function getManagedSegmentCandidates(mediaId?: string, season?: number, episode?: number): MediaSegmentCandidate[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (mediaId) { clauses.push('media_id = ?'); values.push(mediaId); }
    if (season !== undefined) { clauses.push('season = ?'); values.push(season); }
    if (episode !== undefined) { clauses.push('episode = ?'); values.push(episode); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = parseDatabaseRows(
      getDb().prepare(`SELECT * FROM media_segment_candidates ${where} ORDER BY media_id, season, episode, start_ms LIMIT 5000`).all(...values),
      segmentCandidateRowSchema,
      'managed media segment candidate',
    );
    return rows.map(candidateFromRow);
  }

  function updateSegmentCandidate(
    candidateId: string,
    patch: { status?: MediaSegmentCandidate['status']; type?: MediaSegmentCandidate['type'] },
  ): boolean {
    const database = getDb();
    const row = parseDatabaseRow(
      database.prepare('SELECT * FROM media_segment_candidates WHERE id = ?').get(candidateId),
      segmentCandidateRowSchema.optional(),
      'media segment candidate',
    );
    if (!row) return false;
    const existing = candidateFromRow(row);
    if (existing.source === 'manual') return false;
    const assignments: string[] = [];
    const values: Array<string | number> = [];
    if (patch.status) { assignments.push('status = ?'); values.push(patch.status); }
    if (patch.type) { assignments.push('type = ?'); values.push(patch.type); }
    if (!assignments.length) return false;
    assignments.push('updated_at = ?');
    values.push(Date.now());
    const previousDecision = existing.analysisMetadata?.userDecision || {};
    const userDecision = {
      ...previousDecision,
      ...(patch.status ? { status: patch.status === 'review' ? undefined : patch.status } : {}),
      ...(patch.type ? { type: patch.type } : {}),
    };
    assignments.push('analysis_metadata_json = ?');
    values.push(jsonString({ ...existing.analysisMetadata, userDecision }));
    database.prepare(`UPDATE media_segment_candidates SET ${assignments.join(', ')} WHERE id = ?`).run(...values, candidateId);
    refreshResolvedSegments(row.file_revision, database);
    return true;
  }

  function eraseAutomaticSegmentCandidates(mediaId: string, season?: number, episode?: number): number {
    const database = getDb();
    const clauses = ["media_id = ?", "source != 'manual'"];
    const values: Array<string | number> = [mediaId];
    if (season !== undefined) { clauses.push('season = ?'); values.push(season); }
    if (episode !== undefined) { clauses.push('episode = ?'); values.push(episode); }
    const rows = parseDatabaseRows(
      database.prepare(`SELECT id, file_revision FROM media_segment_candidates WHERE ${clauses.join(' AND ')}`).all(...values),
      candidateIdentityRowSchema,
      'automatic media segment candidate',
    );
    if (!rows.length) return 0;
    database.transaction(() => {
      const remove = database.prepare('DELETE FROM media_segment_candidates WHERE id = ?');
      for (const row of rows) remove.run(row.id);
      for (const revision of new Set(rows.map((row) => row.file_revision))) refreshResolvedSegments(revision, database);
    })();
    return rows.length;
  }

  function replaceSegmentCandidatesForSource(
    fileRevision: string,
    source: Exclude<MediaSegmentSource, 'manual'>,
    candidates: MediaSegmentCandidate[],
  ): MediaSegment[] {
    const database = getDb();
    const existing = parseDatabaseRows(
      database.prepare('SELECT * FROM media_segment_candidates WHERE file_revision = ? AND source = ?').all(fileRevision, source),
      segmentCandidateRowSchema,
      'source media segment candidate',
    ).map(candidateFromRow);
    const existingById = new Map(existing.map((candidate) => [candidate.id, candidate]));
    const effectiveCandidates = candidates.map((candidate) => {
      const decision = existingById.get(candidate.id)?.analysisMetadata?.userDecision;
      if (!decision) return candidate;
      return {
        ...candidate,
        type: decision.type || candidate.type,
        status: decision.status || candidate.status,
        analysisMetadata: { ...candidate.analysisMetadata, userDecision: decision },
      };
    });
    const comparable = (candidate: MediaSegmentCandidate) => JSON.stringify({
      id: candidate.id,
      mediaId: candidate.mediaId,
      season: candidate.season,
      episode: candidate.episode,
      filePath: candidate.filePath,
      fileRevision: candidate.fileRevision,
      releaseKey: candidate.releaseKey || null,
      type: candidate.type,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      confidence: candidate.confidence,
      source: candidate.source,
      status: candidate.status,
      mediaDurationMs: candidate.mediaDurationMs,
      expiresAt: candidate.expiresAt || null,
      analysisMetadata: candidate.analysisMetadata || null,
    });
    if (existing.length === effectiveCandidates.length
      && existing.map(comparable).sort().join('\n') === effectiveCandidates.map(comparable).sort().join('\n')) {
      return getResolvedMediaSegments(fileRevision);
    }
    const tx = database.transaction(() => {
      database.prepare('DELETE FROM media_segment_candidates WHERE file_revision = ? AND source = ?').run(fileRevision, source);
      for (const candidate of effectiveCandidates) insertSegmentCandidate(database, candidate);
      return refreshResolvedSegments(fileRevision, database);
    });
    return tx();
  }

  function saveManualSegmentCandidate(candidate: MediaSegmentCandidate, replaceCandidateId?: string): MediaSegment[] {
    const database = getDb();
    const tx = database.transaction(() => {
      const rawExisting = replaceCandidateId || candidate.type === 'credits'
        ? database.prepare(`SELECT * FROM media_segment_candidates WHERE file_revision = ? AND id = ? AND source = 'manual'`)
          .all(candidate.fileRevision, replaceCandidateId || candidate.id)
        : database.prepare(`SELECT * FROM media_segment_candidates WHERE file_revision = ? AND type = ? AND source = 'manual'`)
          .all(candidate.fileRevision, candidate.type);
      const existing = parseDatabaseRows(rawExisting, segmentCandidateRowSchema, 'manual media segment candidate');
      for (const row of existing) {
        database.prepare(`
          INSERT INTO segment_manual_history (candidate_id, action, snapshot_json, changed_at)
          VALUES (?, 'replace', ?, ?)
        `).run(row.id, jsonString(candidateFromRow(row)), Date.now());
        database.prepare('DELETE FROM media_segment_candidates WHERE id = ?').run(row.id);
        if (row.file_revision !== candidate.fileRevision) refreshResolvedSegments(row.file_revision, database);
      }
      insertSegmentCandidate(database, candidate);
      return refreshResolvedSegments(candidate.fileRevision, database);
    });
    return tx();
  }

  function deleteManualSegmentCandidate(
    fileRevision: string,
    type: MediaSegmentCandidate['type'],
    candidateId?: string,
  ): MediaSegment[] {
    const database = getDb();
    const tx = database.transaction(() => {
      const rawRows = candidateId
        ? database.prepare(`SELECT * FROM media_segment_candidates WHERE file_revision = ? AND id = ? AND source = 'manual'`).all(fileRevision, candidateId)
        : database.prepare(`SELECT * FROM media_segment_candidates WHERE file_revision = ? AND type = ? AND source = 'manual'`).all(fileRevision, type);
      const rows = parseDatabaseRows(rawRows, segmentCandidateRowSchema, 'manual media segment candidate');
      const revisions = new Set(rows.map((row) => row.file_revision));
      for (const row of rows) {
        database.prepare(`
          INSERT INTO segment_manual_history (candidate_id, action, snapshot_json, changed_at)
          VALUES (?, 'delete', ?, ?)
        `).run(row.id, jsonString(candidateFromRow(row)), Date.now());
        database.prepare('DELETE FROM media_segment_candidates WHERE id = ?').run(row.id);
      }
      let resolved: MediaSegment[] = [];
      for (const revision of revisions) resolved = refreshResolvedSegments(revision, database);
      return resolved;
    });
    return tx();
  }

  function undoManualSegmentCandidate(
    fileRevision: string,
    type: MediaSegmentCandidate['type'],
    candidateId?: string,
  ): MediaSegment[] {
    const database = getDb();
    const tx = database.transaction(() => {
      const history = parseDatabaseRows(
        database.prepare(`
          SELECT history_id, snapshot_json FROM segment_manual_history
          WHERE snapshot_json IS NOT NULL ORDER BY changed_at DESC, history_id DESC LIMIT 200
        `).all(),
        manualHistoryRowSchema,
        'manual media segment history',
      );
      const match = history.map((row) => ({
        row,
        candidate: parseStoredJson(row.snapshot_json, segmentCandidateSchema.nullable(), null),
      })).find(({ candidate }) => candidate?.fileRevision === fileRevision && candidate.type === type
        && candidate.source === 'manual' && (!candidateId || candidate.id === candidateId));
      if (!match?.candidate) return getResolvedMediaSegments(fileRevision);
      if (candidateId) database.prepare(`DELETE FROM media_segment_candidates WHERE file_revision = ? AND id = ? AND source = 'manual'`).run(fileRevision, candidateId);
      else database.prepare(`DELETE FROM media_segment_candidates WHERE file_revision = ? AND type = ? AND source = 'manual'`).run(fileRevision, type);
      insertSegmentCandidate(database, { ...match.candidate, updatedAt: new Date().toISOString() });
      database.prepare('DELETE FROM segment_manual_history WHERE history_id = ?').run(match.row.history_id);
      return refreshResolvedSegments(fileRevision, database);
    });
    return tx();
  }

  function reassociateManualSegmentCandidate(
    candidateId: string,
    fileRevision: string,
    filePath: string,
  ): MediaSegment[] {
    const database = getDb();
    const tx = database.transaction(() => {
      database.prepare(`
        UPDATE media_segment_candidates SET file_revision = ?, file_path = ?, updated_at = ?
        WHERE id = ? AND source = 'manual'
      `).run(fileRevision, filePath, Date.now(), candidateId);
      return refreshResolvedSegments(fileRevision, database);
    });
    return tx();
  }

  function markManualSegmentCandidateForReview(candidateId: string): void {
    getDb().prepare(`
      UPDATE media_segment_candidates SET status = 'review', updated_at = ?
      WHERE id = ? AND source = 'manual' AND status != 'review'
    `).run(Date.now(), candidateId);
  }

  function refreshResolvedSegments(fileRevision: string, database = getDb()): MediaSegment[] {
    const candidates = parseDatabaseRows(
      database.prepare(`
        SELECT * FROM media_segment_candidates
        WHERE file_revision = ? AND (expires_at IS NULL OR expires_at > ?)
      `).all(fileRevision, Date.now()),
      segmentCandidateRowSchema,
      'media segment candidate',
    ).map(candidateFromRow);
    const segments = resolveCandidates(candidates);
    database.prepare('DELETE FROM media_segments WHERE file_revision = ?').run(fileRevision);
    const insert = database.prepare(`
      INSERT INTO media_segments (
        file_revision, type, id, start_ms, end_ms, confidence, source,
        media_duration_ms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const segment of segments) {
      insert.run(
        fileRevision,
        segment.type,
        segment.id,
        segment.startMs,
        segment.endMs,
        segment.confidence,
        segment.source,
        segment.mediaDurationMs,
        Date.parse(segment.updatedAt) || Date.now(),
      );
    }
    return segments;
  }

  function getResolvedMediaSegments(fileRevision: string): MediaSegment[] {
    return resolveCandidates(getSegmentCandidates(fileRevision));
  }

  function getMediaFingerprint(
    fileRevision: string,
    audioTrack: number,
    windowType: StoredMediaFingerprint['windowType'],
    algorithmVersion: string,
  ): StoredMediaFingerprint | null {
    const row = parseDatabaseRow(
      getDb().prepare(`
        SELECT file_revision, audio_track, window_type, algorithm_version, fingerprint_json, duration_ms, updated_at
        FROM media_fingerprints
        WHERE file_revision = ? AND audio_track = ? AND window_type = ? AND algorithm_version = ?
      `).get(fileRevision, audioTrack, windowType, algorithmVersion),
      fingerprintRowSchema.optional(),
      'media fingerprint',
    );
    return row ? {
      fileRevision: row.file_revision,
      audioTrack: row.audio_track,
      windowType: row.window_type,
      algorithmVersion: row.algorithm_version,
      fingerprintJson: row.fingerprint_json,
      durationMs: row.duration_ms,
      updatedAt: row.updated_at,
    } : null;
  }

  function saveMediaFingerprint(value: StoredMediaFingerprint): void {
    getDb().prepare(`
      INSERT OR REPLACE INTO media_fingerprints (
        file_revision, audio_track, window_type, algorithm_version, fingerprint_json, duration_ms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.fileRevision,
      value.audioTrack,
      value.windowType,
      value.algorithmVersion,
      value.fingerprintJson,
      value.durationMs,
      value.updatedAt,
    );
  }

  function getAuxiliaryFingerprint(
    fileRevision: string,
    audioTrack: number,
    windowType: string,
    algorithmVersion: string,
  ): StoredMediaFingerprint | null {
    const row = parseDatabaseRow(
      getDb().prepare(`
        SELECT file_revision, audio_track, window_type, algorithm_version, fingerprint_json, duration_ms, updated_at
        FROM media_auxiliary_fingerprints
        WHERE file_revision = ? AND audio_track = ? AND window_type = ? AND algorithm_version = ?
      `).get(fileRevision, audioTrack, windowType, algorithmVersion),
      fingerprintRowSchema.optional(),
      'auxiliary media fingerprint',
    );
    return row ? {
      fileRevision: row.file_revision,
      audioTrack: row.audio_track,
      windowType: row.window_type,
      algorithmVersion: row.algorithm_version,
      fingerprintJson: row.fingerprint_json,
      durationMs: row.duration_ms,
      updatedAt: row.updated_at,
    } : null;
  }

  function saveAuxiliaryFingerprint(value: StoredMediaFingerprint): void {
    getDb().prepare(`
      INSERT OR REPLACE INTO media_auxiliary_fingerprints (
        file_revision, audio_track, window_type, algorithm_version, fingerprint_json, duration_ms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(value.fileRevision, value.audioTrack, value.windowType, value.algorithmVersion,
      value.fingerprintJson, value.durationMs, value.updatedAt);
  }

  function enqueueSegmentAnalysisJob(job: SegmentAnalysisJob): void {
    if (job.kind === 'manual') {
      getDb().prepare(`UPDATE segment_analysis_jobs
        SET state = 'cancelled', detail = 'Superseded by manual scan', updated_at = ?
        WHERE file_revision = ? AND job_key != ? AND state IN ('pending', 'waiting_for_peers')`)
        .run(job.updatedAt, job.fileRevision, job.jobKey);
    }
    getDb().prepare(`
      INSERT INTO segment_analysis_jobs (
        job_key, kind, media_id, season, episode, file_revision, config_hash, state, detail, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_key) DO UPDATE SET
        state = CASE WHEN segment_analysis_jobs.state = 'complete' THEN excluded.state ELSE segment_analysis_jobs.state END,
        detail = CASE WHEN segment_analysis_jobs.state = 'complete' THEN excluded.detail ELSE segment_analysis_jobs.detail END,
        updated_at = CASE WHEN segment_analysis_jobs.state = 'complete' THEN excluded.updated_at ELSE segment_analysis_jobs.updated_at END
    `).run(job.jobKey, job.kind, job.mediaId, job.season, job.episode, job.fileRevision,
      job.configHash, job.state, job.detail, job.createdAt, job.updatedAt);
  }

  function analysisJobFromRow(row: z.infer<typeof analysisJobRowSchema>): SegmentAnalysisJob {
    return {
      jobKey: row.job_key, kind: row.kind, mediaId: row.media_id, season: row.season,
      episode: row.episode, fileRevision: row.file_revision, configHash: row.config_hash,
      state: row.state, detail: row.detail, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  function getSegmentAnalysisJobs(states?: SegmentAnalysisJobState[], limit = 500): SegmentAnalysisJob[] {
    const cappedLimit = Math.max(1, Math.min(1000, limit));
    const rows = states?.length
      ? getDb().prepare(`SELECT * FROM segment_analysis_jobs WHERE state IN (${states.map(() => '?').join(',')})
          ORDER BY CASE kind WHEN 'manual' THEN 0 WHEN 'incremental' THEN 1 WHEN 'hash-recompute' THEN 2 ELSE 3 END, created_at LIMIT ?`)
        .all(...states, cappedLimit)
      : getDb().prepare('SELECT * FROM segment_analysis_jobs ORDER BY updated_at DESC LIMIT ?').all(cappedLimit);
    return parseDatabaseRows(rows, analysisJobRowSchema, 'segment analysis job').map(analysisJobFromRow);
  }

  function getSegmentAnalysisJobCounts(kind?: SegmentAnalysisJob['kind']): Partial<Record<SegmentAnalysisJobState, number>> {
    const rawRows = kind
      ? getDb().prepare('SELECT state, COUNT(*) AS count FROM segment_analysis_jobs WHERE kind = ? GROUP BY state').all(kind)
      : getDb().prepare('SELECT state, COUNT(*) AS count FROM segment_analysis_jobs GROUP BY state').all();
    const rows = parseDatabaseRows(rawRows, analysisJobCountRowSchema, 'segment analysis job count');
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }

  function updateSegmentAnalysisJob(jobKey: string, state: SegmentAnalysisJobState, detail = ''): void {
    const current = parseDatabaseRow(
      getDb().prepare('SELECT state FROM segment_analysis_jobs WHERE job_key = ?').get(jobKey),
      analysisJobStateRowSchema.optional(),
      'segment analysis job state',
    );
    if (!current || !canTransitionSegmentAnalysisJob(current.state, state)) return;
    const now = Date.now();
    getDb().prepare(`UPDATE segment_analysis_jobs
      SET state = ?, detail = ?, updated_at = ?,
        created_at = CASE WHEN state = 'waiting_for_peers' AND ? = 'pending' THEN ? ELSE created_at END
      WHERE job_key = ?`)
      .run(state, detail.slice(0, 1000), now, state, now, jobKey);
  }

  function recoverRunningSegmentAnalysisJobs(): number {
    return getDb().prepare("UPDATE segment_analysis_jobs SET state = 'pending', detail = 'Recovered after restart', updated_at = ? WHERE state = 'running'")
      .run(Date.now()).changes;
  }

  function saveSegmentAnalysisInventory(value: SegmentAnalysisInventory): void {
    getDb().prepare(`
      INSERT OR REPLACE INTO segment_analysis_inventory (
        file_revision, media_id, season, episode, config_hash, fingerprint_version, analyzed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(value.fileRevision, value.mediaId, value.season, value.episode,
      value.configHash, value.fingerprintVersion, value.analyzedAt);
  }

  function getSegmentAnalysisInventory(fileRevisions?: string[]): SegmentAnalysisInventory[] {
    if (fileRevisions && !fileRevisions.length) return [];
    const rawRows = fileRevisions
      ? getDb().prepare(`SELECT * FROM segment_analysis_inventory WHERE file_revision IN (${fileRevisions.map(() => '?').join(',')}) ORDER BY analyzed_at DESC`).all(...fileRevisions)
      : getDb().prepare('SELECT * FROM segment_analysis_inventory ORDER BY analyzed_at DESC').all();
    const rows = parseDatabaseRows(rawRows, analysisInventoryRowSchema, 'segment analysis inventory');
    return rows.map((row) => ({
      fileRevision: row.file_revision, mediaId: row.media_id, season: row.season, episode: row.episode,
      configHash: row.config_hash, fingerprintVersion: row.fingerprint_version, analyzedAt: row.analyzed_at,
    }));
  }

  function cleanupOrphanedAnalysisData(activeRevisions: string[], limit = 250): number {
    const cappedLimit = Math.max(1, Math.min(1000, limit));
    const database = getDb();
    database.exec('CREATE TEMP TABLE IF NOT EXISTS active_analysis_revisions (file_revision TEXT PRIMARY KEY)');
    database.prepare('DELETE FROM active_analysis_revisions').run();
    const insertActive = database.prepare('INSERT OR IGNORE INTO active_analysis_revisions (file_revision) VALUES (?)');
    database.transaction(() => { for (const revision of activeRevisions) insertActive.run(revision); })();
    const rows = parseDatabaseRows(
      database.prepare(`
        SELECT file_revision FROM (
          SELECT file_revision FROM segment_analysis_inventory
          UNION SELECT file_revision FROM segment_analysis_jobs
          UNION SELECT file_revision FROM media_fingerprints
          UNION SELECT file_revision FROM media_auxiliary_fingerprints
        ) revisions
        WHERE NOT EXISTS (SELECT 1 FROM active_analysis_revisions active WHERE active.file_revision = revisions.file_revision)
        ORDER BY file_revision LIMIT ?
      `).all(cappedLimit),
      fileRevisionRowSchema,
      'orphaned segment analysis revision',
    );
    const candidates = rows.map((row) => row.file_revision);
    if (!candidates.length) return 0;
    database.transaction(() => {
      for (const revision of candidates) {
        database.prepare('DELETE FROM segment_analysis_inventory WHERE file_revision = ?').run(revision);
        database.prepare('DELETE FROM media_fingerprints WHERE file_revision = ?').run(revision);
        database.prepare('DELETE FROM media_auxiliary_fingerprints WHERE file_revision = ?').run(revision);
        database.prepare("DELETE FROM segment_analysis_jobs WHERE file_revision = ? AND state != 'running'").run(revision);
        database.prepare("DELETE FROM media_segment_candidates WHERE file_revision = ? AND source != 'manual'").run(revision);
        database.prepare('DELETE FROM media_segments WHERE file_revision = ?').run(revision);
      }
    })();
    return candidates.length;
  }

  function fingerprintCount(): number {
    const primary = parseDatabaseRow(getDb().prepare('SELECT COUNT(*) AS count FROM media_fingerprints').get(), countRowSchema, 'media fingerprint count');
    const auxiliary = parseDatabaseRow(getDb().prepare('SELECT COUNT(*) AS count FROM media_auxiliary_fingerprints').get(), countRowSchema, 'auxiliary media fingerprint count');
    return primary.count + auxiliary.count;
  }

  function fingerprintCacheBytes(): number {
    const primary = parseDatabaseRow(getDb().prepare('SELECT COALESCE(SUM(LENGTH(fingerprint_json)), 0) AS bytes FROM media_fingerprints').get(), byteCountRowSchema, 'media fingerprint byte count');
    const auxiliary = parseDatabaseRow(getDb().prepare('SELECT COALESCE(SUM(LENGTH(fingerprint_json)), 0) AS bytes FROM media_auxiliary_fingerprints').get(), byteCountRowSchema, 'auxiliary media fingerprint byte count');
    return primary.bytes + auxiliary.bytes;
  }

  function cancelSegmentAnalysisJobs(
    jobKey?: string,
    kind?: SegmentAnalysisJob['kind'],
    preserveWaiting = false,
  ): number {
    const database = getDb();
    const now = Date.now();
    const states: SegmentAnalysisJobState[] = preserveWaiting
      ? ['pending', 'running']
      : ['pending', 'running', 'waiting_for_peers'];
    const clauses = [`state IN (${states.map(() => '?').join(',')})`];
    const parameters: Array<string | number> = [now, ...states];
    if (jobKey) { clauses.push('job_key = ?'); parameters.push(jobKey); }
    if (kind) { clauses.push('kind = ?'); parameters.push(kind); }
    const result = database.prepare(`UPDATE segment_analysis_jobs
      SET state = 'cancelled', detail = 'Cancelled by user', updated_at = ?
      WHERE ${clauses.join(' AND ')}`).run(...parameters);
    return result.changes;
  }

  function requeueWaitingSegmentAnalysisJobs(mediaId: string, season: number): number {
    return getDb().prepare(`UPDATE segment_analysis_jobs
      SET state = 'pending', detail = 'Enough peer episodes are now available', created_at = ?, updated_at = ?
      WHERE media_id = ? AND season = ? AND state = 'waiting_for_peers'`)
      .run(Date.now(), Date.now(), mediaId, season).changes;
  }

  function resetAutomaticAnalysisData(): number {
    const database = getDb();
    const rows = parseDatabaseRows(
      database.prepare("SELECT DISTINCT file_revision FROM media_segment_candidates WHERE source != 'manual'").all(),
      fileRevisionRowSchema,
      'automatic media segment revision',
    );
    const removed = parseDatabaseRow(
      database.prepare("SELECT COUNT(*) AS count FROM media_segment_candidates WHERE source != 'manual'").get(),
      countRowSchema,
      'automatic media segment count',
    ).count;
    database.transaction(() => {
      database.prepare("DELETE FROM media_segment_candidates WHERE source != 'manual'").run();
      database.prepare('DELETE FROM segment_analysis_inventory').run();
      database.prepare('DELETE FROM media_fingerprints').run();
      database.prepare('DELETE FROM media_auxiliary_fingerprints').run();
      database.prepare("DELETE FROM segment_analysis_jobs WHERE state != 'running'").run();
      for (const row of rows) refreshResolvedSegments(row.file_revision, database);
    })();
    return removed;
  }

  function saveSegmentAnalysisState(
    jobKey: string,
    mediaId: string,
    season: number,
    state: string,
    detail = '',
  ): void {
    getDb().prepare(`
      INSERT OR REPLACE INTO segment_analysis_state (job_key, media_id, season, state, detail, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jobKey, mediaId, season, state, detail, Date.now());
  }

  function getSegmentAnalysisStates(mediaId?: string): Array<{
    jobKey: string; mediaId: string; season: number; state: string; detail: string; updatedAt: number;
  }> {
    const rawRows = mediaId
      ? getDb().prepare('SELECT * FROM segment_analysis_state WHERE media_id = ? ORDER BY updated_at DESC').all(mediaId)
      : getDb().prepare('SELECT * FROM segment_analysis_state ORDER BY updated_at DESC').all();
    const rows = parseDatabaseRows(rawRows, analysisStateRowSchema, 'segment analysis state');
    return rows.map((row) => ({
      jobKey: row.job_key,
      mediaId: row.media_id,
      season: row.season,
      state: row.state,
      detail: row.detail,
      updatedAt: row.updated_at,
    }));
  }

  function cleanupOrphanedAutomaticSegments(limit = 250): number {
    const database = getDb();
    const rows = parseDatabaseRows(
      database.prepare(`
        SELECT id, file_revision FROM media_segment_candidates
        WHERE source != 'manual'
          AND NOT EXISTS (
            SELECT 1 FROM episode_files WHERE episode_files.file_path = media_segment_candidates.file_path
          )
          AND NOT EXISTS (
            SELECT 1 FROM media_items
            WHERE media_items.file_path = media_segment_candidates.file_path
              AND media_items.file_path != ''
          )
        LIMIT ?
      `).all(Math.max(1, Math.min(1000, limit))),
      candidateIdentityRowSchema,
      'orphaned automatic media segment candidate',
    );
    if (!rows.length) return 0;
    const tx = database.transaction(() => {
      const remove = database.prepare('DELETE FROM media_segment_candidates WHERE id = ?');
      for (const row of rows) remove.run(row.id);
      for (const revision of new Set(rows.map((row) => row.file_revision))) refreshResolvedSegments(revision, database);
    });
    tx();
    return rows.length;
  }


  return {
    cancelSegmentAnalysisJobs,
    cleanupOrphanedAnalysisData,
    cleanupOrphanedAutomaticSegments,
    deleteManualSegmentCandidate,
    enqueueSegmentAnalysisJob,
    fingerprintCount,
    fingerprintCacheBytes,
    getAuxiliaryFingerprint,
    getManualSegmentCandidates,
    getManagedSegmentCandidates,
    getMediaFingerprint,
    getResolvedMediaSegments,
    getSegmentAnalysisInventory,
    getSegmentAnalysisJobs,
    getSegmentAnalysisJobCounts,
    getSegmentAnalysisStates,
    getSegmentCandidates,
    getSegmentSourceCache,
    markManualSegmentCandidateForReview,
    reassociateManualSegmentCandidate,
    recoverRunningSegmentAnalysisJobs,
    requeueWaitingSegmentAnalysisJobs,
    resetAutomaticAnalysisData,
    replaceSegmentCandidatesForSource,
    saveAuxiliaryFingerprint,
    saveManualSegmentCandidate,
    saveMediaFingerprint,
    saveSegmentAnalysisInventory,
    saveSegmentAnalysisState,
    saveSegmentSourceCache,
    undoManualSegmentCandidate,
    updateSegmentAnalysisJob,
    updateSegmentCandidate,
    eraseAutomaticSegmentCandidates,
  };
}
