import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { isImageFileName, isSubtitleFileName, isVideoFileName, normalizedArtworkBaseName, subtitleMatchesVideo } from './fileClassification.ts';
import { subtitleLanguageFromFileName } from './subtitleLanguage.ts';
import { fileStamp, planFileTransfer, resumeFileTransfer, type FileTransfer } from './fileRename/recoverableFileMove.ts';
import { assertLibraryPath, inventoryIdentity, type ImportRecord } from './fileRename/importInventory.ts';
import { PARTIAL_EXTENSIONS, hasPartialSibling } from './fileRename/fileSettling.ts';

/** Recognized clutter and covered subtitles are held for 30 days, with a durable journal. */

export const CLEANUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const JUNK_EXTENSIONS = new Set(['.url', '.webloc', '.website', '.torrent', '.sfv', '.md5', '.nzb']);
const JUNK_NAMES = new Set(['thumbs.db', 'desktop.ini']);
const ARTWORK_WORDS = ['poster', 'folder', 'cover', 'thumbnail', 'thumb', 'default', 'movie', 'backdrop', 'fanart', 'background', 'landscape', 'banner', 'logo', 'clearlogo', 'clearart', 'disc', 'season', 'specials'];

export type CleanupReason = 'download-note' | 'not-artwork' | 'only-junk' | 'embedded-copy' | 'episode-copy' | 'embedded-coverage';

export const CLEANUP_REASON_LABELS: Record<CleanupReason, string> = {
  'embedded-coverage': 'Embedded subtitles cover this language and purpose',
  'download-note': 'Text or link file left by a download',
  'not-artwork': 'Image that is not artwork',
  'only-junk': 'Folder holding only such files',
  'embedded-copy': 'Exact copy of a subtitle built into the video',
  'episode-copy': 'The same subtitle file copied onto other episodes',
};

export type CleanupCandidate = { path: string; reason: CleanupReason; stamp?: string; video?: string; videoStamp?: string };

type Entry = { name: string; isDirectory: boolean; isSymbolicLink?: boolean };
export type CleanupFileSystem = {
  list: (directory: string) => Entry[] | null;
};

const defaultFileSystem: CleanupFileSystem = {
  list: (directory) => {
    try {
      return fs.readdirSync(directory, { withFileTypes: true }).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink() }));
    } catch {
      return null;
    }
  },
};

function junkReason(name: string, directory: string, videoStems: readonly string[]): CleanupReason | null {
  const lower = name.toLowerCase();
  if (name.startsWith('.') || isVideoFileName(name) || isSubtitleFileName(name) || PARTIAL_EXTENSIONS.has(path.extname(lower) || lower)) return null;
  if (JUNK_NAMES.has(lower) || JUNK_EXTENSIONS.has(path.extname(lower)) || (/\.(?:txt|html?|lnk)$/i.test(lower) && /downloaded[ ._-]?from|visit[ ._-]?(?:us|our)|website|torrent|advert|sample[ ._-]?url/.test(lower))) return 'download-note';
  if (isImageFileName(name)) {
    const base = normalizedArtworkBaseName(name);
    const folder = normalizedArtworkBaseName(path.basename(directory));
    const isArtwork = ARTWORK_WORDS.some((word) => base === word || base.startsWith(`${word} `) || base.endsWith(` ${word}`) || base.includes(`${word} `))
      || videoStems.some((stem) => base === stem || base.startsWith(`${stem} `))
      || (folder && base === folder);
    return !isArtwork && /website|advert|downloaded[ ._-]?from|torrent|visit[ ._-]?us|www\.[a-z0-9-]+\.(?:com|org|net|to|mx)/i.test(name) ? 'not-artwork' : null;
  }
  return null;
}

/** Individual files only. A stale directory candidate must never sweep new content. */
export function findLeftovers(roots: readonly string[], fileSystem: CleanupFileSystem = defaultFileSystem): CleanupCandidate[] {
  const candidates: CleanupCandidate[] = [];
  const visit = (directory: string) => {
    const entries = fileSystem.list(directory);
    if (!entries) return;
    const files = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name);
    const videoStems = entries.filter((entry) => !entry.isDirectory && isVideoFileName(entry.name)).map((entry) => normalizedArtworkBaseName(entry.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory) { visit(target); continue; }
      if (hasPartialSibling(entry.name, files)) continue;
      const reason = junkReason(entry.name, directory, videoStems);
      if (reason) {
        try { candidates.push({ path: target, reason, stamp: fileStamp(target) }); } catch { /* Inaccessible files stay. */ }
      }
    }
  };
  for (const root of roots) visit(path.resolve(root));
  return candidates;
}

// ── Subtitle copies ────────────────────────────────────────────────────────

export type EmbeddedTrack = { index: number; codec: string; language: string; title: string; forced: boolean };

const TEXT_CODECS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
let languageNames: Intl.DisplayNames | null = null;

/** "en", "eng" and "English" all compare equal. */
export function sameLanguage(left: string, right: string): boolean {
  const name = (code: string) => {
    const value = code.trim().toLowerCase();
    if (!value || value === 'und') return '';
    try {
      languageNames ??= new Intl.DisplayNames(['en'], { type: 'language' });
      return (languageNames.of(value) || value).toLowerCase();
    } catch {
      return value;
    }
  };
  const a = name(left);
  return Boolean(a) && a === name(right);
}

function isFullTrack(track: EmbeddedTrack): boolean {
  return !track.forced && !/sign|song|forced|commentary/i.test(track.title)
    && /\b(?:full|dialogue|dialog|complete)\b/i.test(track.title);
}

type Cue = { start: number; text: string };

function toMs(value: string): number {
  const match = value.match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  return match ? ((+match[1] * 60 + +match[2]) * 60 + +match[3]) * 1000 + Number(match[4].padEnd(3, '0').slice(0, 3)) : Number.NaN;
}

/** Cues from SRT text (ffmpeg converts every text format to SRT first). */
export function parseSrtCues(srt: string): Cue[] {
  return srt.split(/\r?\n\r?\n/).map((block) => {
    const lines = block.trim().split(/\r?\n/);
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing < 0) return null;
    const text = lines.slice(timing + 1).join(' ')
      .replace(/\{[^}]*\}/g, '').replace(/<[^>]*>/g, '').replace(/\\N/gi, ' ')
      .replace(/[^a-z0-9 ]/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
    return text ? { start: toMs(lines[timing].split('-->')[0]), text } : null;
  }).filter((cue): cue is Cue => Boolean(cue));
}

/**
 * Whether a sidecar holds the same subtitles as a built-in track: nearly
 * every line present, at the same times (median gap a quarter second).
 */
export function sameSubtitles(sidecar: readonly Cue[], embedded: readonly Cue[]): boolean {
  if (sidecar.length === 0 || embedded.length === 0) return false;
  const starts = new Map<string, number>();
  for (const cue of embedded) if (!starts.has(cue.text)) starts.set(cue.text, cue.start);
  const matched = sidecar.filter((cue) => starts.has(cue.text));
  if (matched.length / sidecar.length < 0.95) return false;
  const gaps = matched.map((cue) => Math.abs(cue.start - (starts.get(cue.text) ?? 0))).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] <= 250;
}

export type SubtitleTools = {
  /** Subtitle tracks built into a video, or null when it cannot be read. */
  probe: (video: string) => Promise<EmbeddedTrack[] | null>;
  /** A built-in text track converted to SRT. */
  extract: (video: string, trackIndex: number) => Promise<string>;
  /** A sidecar file converted to SRT. */
  convert: (sidecar: string) => Promise<string>;
  /** Stop early, for example when playback starts. */
  shouldStop?: () => boolean;
};

export type SubtitleCache = {
  get: (sidecar: string, signature: string) => CleanupReason | 'keep' | undefined;
  set: (sidecar: string, signature: string, verdict: CleanupReason | 'keep') => void;
};

/** Prefer a full embedded track of the same language and purpose; unknown coverage stays. */
export async function findRedundantSubtitles(
  roots: readonly string[], tools: SubtitleTools, cache?: SubtitleCache,
  fileSystem: CleanupFileSystem = defaultFileSystem,
): Promise<CleanupCandidate[]> {
  const pairs: Array<{ video: string; sidecar: string; language: string; purpose: string }> = [];
  const purposeOf = (value: string) => /\b(?:sdh|cc|hearing impaired)\b/i.test(value) ? 'accessibility'
    : /\bcommentary\b/i.test(value) ? 'commentary'
      : /\b(?:signs|songs)\b/i.test(value) ? 'signs' : /\bforced\b/i.test(value) ? 'forced' : 'dialogue';
  const walk = (directory: string) => {
    const entries = (fileSystem.list(directory) || []).filter((entry) => !entry.isSymbolicLink);
    const files = entries.filter((entry) => !entry.isDirectory && !entry.name.startsWith('.')).map((entry) => entry.name);
    for (const name of files.filter(isSubtitleFileName)) {
      if (/\.loomtv-clean-/i.test(name)) continue;
      const language = subtitleLanguageFromFileName(name, '');
      if (!language) continue;
      const videos = files.filter((candidate) => isVideoFileName(candidate) && subtitleMatchesVideo(name, candidate));
      if (videos.length !== 1) continue;
      pairs.push({ video: path.join(directory, videos[0]), sidecar: path.join(directory, name), language, purpose: !sameLanguage(language, 'hi') && /\.hi\./i.test(name) ? 'accessibility' : purposeOf(name.replace(/[._-]/g, ' ')) });
    }
    for (const entry of entries) if (entry.isDirectory && !entry.name.startsWith('.')) walk(path.join(directory, entry.name));
  };
  for (const root of roots) walk(path.resolve(root));
  const results: CleanupCandidate[] = [];
  const probes = new Map<string, EmbeddedTrack[] | null>();
  for (const pair of pairs) {
    if (tools.shouldStop?.()) break;
    let stamp: string;
    let videoStamp: string;
    try { stamp = fileStamp(pair.sidecar); videoStamp = fileStamp(pair.video); } catch { continue; }
    const signature = `coverage-v2|${stamp}|${videoStamp}|${pair.purpose}`;
    const cached = cache?.get(pair.sidecar, signature);
    let verdict: CleanupReason | 'keep' = cached || 'keep';
    if (!cached) {
      if (!probes.has(pair.video)) probes.set(pair.video, await tools.probe(pair.video));
      const tracks = (probes.get(pair.video) || []).filter((track) => sameLanguage(track.language, pair.language));
      const covered = tracks.some((track) => {
        const labelled = purposeOf(track.title);
        const purpose = labelled === 'dialogue' && track.forced ? 'forced' : labelled;
        return purpose === pair.purpose && (purpose === 'dialogue' || purpose === 'accessibility' ? isFullTrack(track) : true);
      });
      if (covered) verdict = 'embedded-coverage';
      else {
        // An exact text match is also sufficient, without guessing full coverage.
        for (const track of tracks.filter((value) => TEXT_CODECS.has(value.codec) && !value.forced && purposeOf(value.title) === pair.purpose)) {
          if (tools.shouldStop?.()) break;
          try {
            if (sameSubtitles(parseSrtCues(await tools.convert(pair.sidecar)), parseSrtCues(await tools.extract(pair.video, track.index)) )) { verdict = 'embedded-copy'; break; }
          } catch { /* Probe/conversion failure keeps the sidecar. */ }
        }
      }
      // Retry transient failed probes on a later scan.
      if (probes.get(pair.video) !== null) cache?.set(pair.sidecar, signature, verdict);
    }
    if (tools.shouldStop?.()) break;
    if (verdict !== 'keep') results.push({ path: pair.sidecar, reason: verdict, stamp, video: pair.video, videoStamp });
  }
  return results;
}

// ── Holding, history and restore ──────────────────────────────────────────

export type CleanupItem = {
  from: string; held: string; reason: CleanupReason;
  state?: 'holding' | 'held' | 'restoring' | 'restored' | 'expired' | 'blocked';
  transfer?: FileTransfer;
  restoredTo?: string;
  error?: string;
};
export type CleanupBatch = { id: string; createdAt: number; restoredAt: number; items: CleanupItem[] };
type CleanupHooks = {
  beforeHold?: (paths: string[]) => void;
  moved?: (from: string, to: string, held: boolean) => void;
  validatePath?: (file: string) => void;
};

export function createCleanupStore(getDatabase: () => BetterSqlite3.Database, holdingRoot: string, hooks: CleanupHooks = {}) {
  function readBatch(row: { id: string; created_at: number; restored_at: number; items_json: string }): CleanupBatch {
    return { id: row.id, createdAt: row.created_at, restoredAt: row.restored_at, items: JSON.parse(row.items_json) as CleanupItem[] };
  }
  function save(batch: CleanupBatch): void {
    getDatabase().prepare('INSERT INTO library_cleanup_batches (id, created_at, restored_at, items_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET restored_at = excluded.restored_at, items_json = excluded.items_json')
      .run(batch.id, batch.createdAt, batch.restoredAt, JSON.stringify(batch.items));
  }
  function complete(batch: CleanupBatch, item: CleanupItem): void {
    const transfer = item.transfer;
    if (!transfer) throw new Error('The file has no transfer journal.');
    resumeFileTransfer(transfer, () => save(batch));
    const previousState = item.state;
    try {
      getDatabase().transaction(() => {
        hooks.moved?.(transfer.from, transfer.to, previousState === 'holding');
        item.state = previousState === 'holding' ? 'held' : 'restored';
        item.error = undefined;
        save(batch);
      })();
    } catch (error) {
      item.state = previousState;
      throw error;
    }
  }
  function history(limit = 20): CleanupBatch[] {
    return (getDatabase().prepare('SELECT * FROM library_cleanup_batches ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ id: string; created_at: number; restored_at: number; items_json: string }>).map(readBatch);
  }
  function recoverInterrupted(): void {
    for (const batch of history(Number.MAX_SAFE_INTEGER)) {
      if (!batch.restoredAt) {
        expandLegacyDirectories(batch);
        for (const item of batch.items) {
          if (item.state || !fs.existsSync(item.held) || !fs.lstatSync(item.held).isFile()) continue;
          item.state = 'held';
          if (isVideoFileName(path.basename(item.from))) item.error = 'A video was found in older cleanup storage. It is kept for recovery and will not expire.';
          item.transfer = { from: item.from, to: item.held, sourceIdentity: '', sourceStamp: '', staging: `${item.held}.legacy-staging`, publishedIdentity: inventoryIdentity(item.held) || '', phase: 'moved' };
          save(batch);
        }
      }
      for (const item of batch.items) {
        if (!item.transfer || (item.state !== 'holding' && item.state !== 'restoring')) continue;
        try {
          hooks.validatePath?.(item.state === 'holding' ? item.from : item.transfer.to);
          complete(batch, item);
        } catch (error) {
          item.error = error instanceof Error ? error.message : String(error);
          save(batch);
        }
      }
      if (batch.items.every((item) => item.state === 'restored')) { batch.restoredAt ||= Date.now(); save(batch); }
    }
  }
  function hold(candidates: readonly CleanupCandidate[], now = Date.now()): CleanupBatch | null {
    if (!candidates.length) return null;
    hooks.beforeHold?.(candidates.map((candidate) => candidate.path));
    const batch: CleanupBatch = { id: randomUUID(), createdAt: now, restoredAt: 0, items: [] };
    for (const candidate of candidates) {
      try {
        hooks.validatePath?.(candidate.path);
        if (isVideoFileName(path.basename(candidate.path))) continue;
        if (!candidate.stamp || fileStamp(candidate.path) !== candidate.stamp) continue;
        if (candidate.video && fileStamp(candidate.video) !== candidate.videoStamp) continue;
        const held = path.join(holdingRoot, batch.id, `${batch.items.length}-${path.basename(candidate.path)}`);
        const item: CleanupItem = { from: candidate.path, held, reason: candidate.reason, state: 'holding', transfer: planFileTransfer(candidate.path, held) };
        batch.items.push(item);
        save(batch); // Persist before the first filesystem mutation.
        try { complete(batch, item); } catch (error) { item.error = error instanceof Error ? error.message : String(error); save(batch); }
      } catch (error) { console.warn('[cleanup] Kept a changed or unavailable file:', error instanceof Error ? error.message : error); }
    }
    return batch.items.length ? batch : null;
  }
  function restoreItem(batch: CleanupBatch, item: CleanupItem, target: string): boolean {
    try {
      hooks.validatePath?.(target);
      if (item.state === 'expired') return false;
      if (item.state === 'restored') return true;
      if (item.state === 'holding') complete(batch, item);
      if (item.state !== 'restoring') {
        if (fs.existsSync(target)) throw new Error('The original destination is occupied.');
        item.transfer = planFileTransfer(item.held, target);
        item.restoredTo = target;
        item.state = 'restoring';
        save(batch);
      }
      complete(batch, item);
      return true;
    } catch (error) { item.error = error instanceof Error ? error.message : String(error); save(batch); return false; }
  }
  function expandLegacyDirectories(batch: CleanupBatch): void {
    const expanded: CleanupItem[] = [];
    let changed = false;
    const visit = (item: CleanupItem) => {
      if (item.state || !fs.existsSync(item.held) || !fs.lstatSync(item.held).isDirectory()) { expanded.push(item); return; }
      changed = true;
      for (const name of fs.readdirSync(item.held)) {
        visit({ from: path.join(item.from, name), held: path.join(item.held, name), reason: item.reason });
      }
    };
    for (const item of batch.items) visit(item);
    if (changed && expanded.length) { batch.items = expanded; save(batch); }
  }
  function restore(batchId: string, now = Date.now()): { restored: number; skipped: string[] } {
    const batch = history(Number.MAX_SAFE_INTEGER).find((value) => value.id === batchId);
    if (!batch) throw new Error('That cleanup could not be found.');
    expandLegacyDirectories(batch);
    let restored = 0;
    const skipped: string[] = [];
    for (const item of batch.items) {
      if (item.state === 'restored' || batch.restoredAt) continue;
      if (restoreItem(batch, item, item.from)) restored += 1;
      else skipped.push(item.from);
    }
    if (!skipped.length && batch.items.every((item) => item.state === 'restored')) batch.restoredAt = now;
    save(batch);
    // Never remove the holding directory of a partial restore.
    return { restored, skipped };
  }
  function restoreImport(record: ImportRecord): void {
    for (const batch of history(Number.MAX_SAFE_INTEGER)) {
      expandLegacyDirectories(batch);
      for (const entry of record.entries.filter((value) => value.held)) {
        const item = batch.items.find((value) => value.held === entry.current && value.state !== 'restored');
        if (!item) continue;
        assertLibraryPath(entry.original, record.root);
        if (inventoryIdentity(entry.current) !== entry.identity) continue;
        restoreItem(batch, item, entry.original);
      }
      if (batch.items.every((item) => item.state === 'restored')) { batch.restoredAt ||= Date.now(); save(batch); }
    }
  }
  function purgeExpired(now = Date.now()): number {
    let purged = 0;
    for (const batch of history(Number.MAX_SAFE_INTEGER)) {
      if (batch.restoredAt || batch.createdAt >= now - CLEANUP_RETENTION_MS) continue;
      for (const item of batch.items) {
        // Pending or failed restores stay recoverable until resolved.
        if (item.state !== 'held' || item.error || !item.transfer || isVideoFileName(path.basename(item.from))) continue;
        if (inventoryIdentity(item.held) !== item.transfer.publishedIdentity) continue;
        fs.unlinkSync(item.held);
        item.state = 'expired';
        save(batch);
        purged += 1;
      }
    }
    return purged;
  }
  function restoredPaths(): Set<string> {
    return new Set(history(Number.MAX_SAFE_INTEGER).flatMap((batch) => batch.items.filter((item) => item.state === 'restored' || batch.restoredAt).map((item) => path.resolve(item.restoredTo || item.from))));
  }

  const subtitleCache: SubtitleCache = {
    get: (sidecar, signature) => {
      const row = getDatabase().prepare('SELECT signature, verdict_json FROM subtitle_check_cache WHERE sidecar_path = ?').get(sidecar) as { signature: string; verdict_json: string } | undefined;
      if (!row || row.signature !== signature) return undefined;
      try {
        return JSON.parse(row.verdict_json) as CleanupReason | 'keep';
      } catch {
        return undefined;
      }
    },
    set: (sidecar, signature, verdict) => {
      getDatabase()
        .prepare('INSERT OR REPLACE INTO subtitle_check_cache (sidecar_path, signature, verdict_json, checked_at) VALUES (?, ?, ?, ?)')
        .run(sidecar, signature, JSON.stringify(verdict), Date.now());
    },
  };

  const hasPending = () => history(Number.MAX_SAFE_INTEGER).some((batch) => batch.items.some((item) => item.state === 'holding' || item.state === 'restoring'));
  return { hold, history, restore, restoreImport, recoverInterrupted, hasPending, purgeExpired, restoredPaths, subtitleCache };
}

/** The subtitle file a stored subtitle URL points at, if any. */
function subtitlePath(url: string): string | null {
  try {
    return new URL(url, 'http://localhost').searchParams.get('path');
  } catch {
    return null;
  }
}

/**
 * The library without catalog entries for subtitle files that were moved
 * away, so the player stops offering them before the next scan.
 */
export function withoutRemovedSubtitles<T extends { subtitles?: Array<{ url: string }>; episodeFiles?: Array<{ subtitles?: Array<{ url: string }> }> }>(
  items: readonly T[],
  removed: ReadonlySet<string>,
): { items: T[]; changed: boolean } {
  let changed = false;
  const keep = (subtitle: { url: string }) => {
    const target = subtitlePath(subtitle.url);
    const gone = Boolean(target && removed.has(path.resolve(target)));
    if (gone) changed = true;
    return !gone;
  };
  const next = items.map((item) => ({
    ...item,
    ...(item.subtitles ? { subtitles: item.subtitles.filter(keep) } : {}),
    ...(item.episodeFiles ? { episodeFiles: item.episodeFiles.map((file) => (file.subtitles ? { ...file, subtitles: file.subtitles.filter(keep) } : file)) } : {}),
  }));
  return { items: next, changed };
}
