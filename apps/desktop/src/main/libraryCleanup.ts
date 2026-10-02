import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { isImageFileName, isSubtitleFileName, isVideoFileName, normalizedArtworkBaseName, subtitleMatchesVideo } from './fileClassification.ts';
import { subtitleLanguageFromFileName } from './subtitleLanguage.ts';

/**
 * Keeps library folders to the videos and what helps play them.
 *
 * Removed: text and link files left by downloads, images that are not
 * artwork (site logos), folders holding nothing else, subtitle files that
 * are exact copies of a track built into the video, and the same subtitle
 * file copied onto several episodes when each episode has its own built-in
 * track in that language. Kept: videos, every other subtitle, artwork,
 * .nfo files, unfinished downloads, files whose type is unknown, and
 * anything hidden.
 *
 * Nothing is deleted outright. Files move to a holding folder in LoomTV's
 * data, each cleanup is listed in Settings where it can be restored, and
 * held files are removed for good after 30 days.
 */

export const CLEANUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const JUNK_EXTENSIONS = new Set(['.txt', '.url', '.webloc', '.lnk', '.website', '.html', '.htm', '.exe', '.bat', '.cmd', '.scr', '.torrent', '.sfv', '.md5', '.nzb']);
const JUNK_NAMES = new Set(['thumbs.db', 'desktop.ini']);
const PARTIAL_SUFFIX = /\.(?:part|partial|crdownload|download|fdmdownload|opdownload)$/i;
const ARTWORK_WORDS = ['poster', 'folder', 'cover', 'thumbnail', 'thumb', 'default', 'movie', 'backdrop', 'fanart', 'background', 'landscape', 'banner', 'logo', 'clearlogo', 'clearart', 'disc', 'season', 'specials'];

export type CleanupReason = 'download-note' | 'not-artwork' | 'only-junk' | 'embedded-copy' | 'episode-copy';

export const CLEANUP_REASON_LABELS: Record<CleanupReason, string> = {
  'download-note': 'Text or link file left by a download',
  'not-artwork': 'Image that is not artwork',
  'only-junk': 'Folder holding only such files',
  'embedded-copy': 'Exact copy of a subtitle built into the video',
  'episode-copy': 'The same subtitle file copied onto other episodes',
};

export type CleanupCandidate = { path: string; reason: CleanupReason };

type Entry = { name: string; isDirectory: boolean };
export type CleanupFileSystem = {
  list: (directory: string) => Entry[] | null;
};

const defaultFileSystem: CleanupFileSystem = {
  list: (directory) => {
    try {
      return fs.readdirSync(directory, { withFileTypes: true }).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
    } catch {
      return null;
    }
  },
};

function junkReason(name: string, directory: string, videoStems: readonly string[]): CleanupReason | null {
  const lower = name.toLowerCase();
  if (name.startsWith('.') || isVideoFileName(name) || isSubtitleFileName(name) || PARTIAL_SUFFIX.test(name)) return null;
  if (JUNK_NAMES.has(lower) || JUNK_EXTENSIONS.has(path.extname(lower))) return 'download-note';
  if (isImageFileName(name)) {
    const base = normalizedArtworkBaseName(name);
    const folder = normalizedArtworkBaseName(path.basename(directory));
    const isArtwork = ARTWORK_WORDS.some((word) => base === word || base.startsWith(`${word} `) || base.endsWith(` ${word}`) || base.includes(`${word} `))
      || videoStems.some((stem) => base === stem || base.startsWith(`${stem} `))
      || (folder && base === folder);
    return isArtwork ? null : 'not-artwork';
  }
  return null;
}

/**
 * Leftover files and folders under the library folders. A folder whose every
 * file is a leftover is reported once, as a folder. Library folders
 * themselves are never candidates.
 */
export function findLeftovers(roots: readonly string[], fileSystem: CleanupFileSystem = defaultFileSystem): CleanupCandidate[] {
  const candidates: CleanupCandidate[] = [];
  // Returns true when everything inside is a leftover (and there is something).
  const visit = (directory: string, isRoot: boolean): boolean => {
    const entries = fileSystem.list(directory);
    if (!entries) return false;
    const visible = entries.filter((entry) => !entry.name.startsWith('.'));
    const videoStems = visible.filter((entry) => !entry.isDirectory && isVideoFileName(entry.name))
      .map((entry) => normalizedArtworkBaseName(entry.name));
    const found: CleanupCandidate[] = [];
    let allJunk = visible.length > 0;
    for (const entry of visible) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory) {
        const before = candidates.length;
        if (visit(target, false)) {
          candidates.splice(before);
          found.push({ path: target, reason: 'only-junk' });
        } else {
          allJunk = false;
        }
        continue;
      }
      const reason = junkReason(entry.name, directory, videoStems);
      if (reason) found.push({ path: target, reason });
      else allJunk = false;
    }
    if (allJunk && !isRoot) return true;
    candidates.push(...found);
    return false;
  };
  for (const root of roots) visit(path.resolve(root), true);
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
  return !track.forced && !/sign|song|forced|commentary/i.test(track.title);
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

function signatureOf(...files: string[]): string {
  return files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
      return 'missing';
    }
  }).join('|');
}

/**
 * Sidecar subtitles that add nothing: exact copies of a built-in track, and
 * one file copied onto several episodes when each has a built-in track in
 * that language. LoomTV's own cleaned variants, forced and signs tracks,
 * hearing-impaired versions, and anything that differs are kept.
 */
export async function findRedundantSubtitles(
  roots: readonly string[],
  tools: SubtitleTools,
  cache?: SubtitleCache,
  fileSystem: CleanupFileSystem = defaultFileSystem,
): Promise<CleanupCandidate[]> {
  type Pair = { video: string; sidecar: string; language: string; hash: string };
  const pairs: Pair[] = [];
  const walk = (directory: string) => {
    const entries = fileSystem.list(directory) || [];
    const files = entries.filter((entry) => !entry.isDirectory && !entry.name.startsWith('.')).map((entry) => entry.name);
    const videos = files.filter(isVideoFileName);
    for (const name of files.filter(isSubtitleFileName)) {
      if (/\.loomtv-clean-/i.test(name) || /\.(?:forced|signs|songs|sdh|cc|hi)\./i.test(name)) continue;
      const video = videos.find((candidate) => subtitleMatchesVideo(name, candidate));
      if (!video) continue;
      const sidecar = path.join(directory, name);
      let hash: string;
      try {
        hash = createHash('sha1').update(fs.readFileSync(sidecar)).digest('hex');
      } catch {
        continue;
      }
      pairs.push({ video: path.join(directory, video), sidecar, language: subtitleLanguageFromFileName(name), hash });
    }
    for (const entry of entries) if (entry.isDirectory && !entry.name.startsWith('.')) walk(path.join(directory, entry.name));
  };
  for (const root of roots) walk(path.resolve(root));

  // One file's content on several different videos is right for one at most.
  const videosByHash = new Map<string, Set<string>>();
  for (const pair of pairs) videosByHash.set(pair.hash, (videosByHash.get(pair.hash) || new Set()).add(pair.video));

  const results: CleanupCandidate[] = [];
  const probes = new Map<string, EmbeddedTrack[] | null>();
  for (const pair of pairs) {
    if (tools.shouldStop?.()) break;
    const signature = signatureOf(pair.sidecar, pair.video) + `|${videosByHash.get(pair.hash)?.size || 1}`;
    const cached = cache?.get(pair.sidecar, signature);
    if (cached) {
      if (cached !== 'keep') results.push({ path: pair.sidecar, reason: cached });
      continue;
    }
    if (!probes.has(pair.video)) probes.set(pair.video, await tools.probe(pair.video));
    const tracks = (probes.get(pair.video) || []).filter((track) => isFullTrack(track) && sameLanguage(track.language, pair.language));
    const textTracks = tracks.filter((track) => TEXT_CODECS.has(track.codec));
    let verdict: CleanupReason | 'keep' = 'keep';
    if (tracks.length > 0 && (videosByHash.get(pair.hash)?.size || 0) > 1) {
      verdict = 'episode-copy';
    } else if (textTracks.length > 0) {
      try {
        const sidecarCues = parseSrtCues(await tools.convert(pair.sidecar));
        for (const track of textTracks) {
          if (tools.shouldStop?.()) break;
          if (sameSubtitles(sidecarCues, parseSrtCues(await tools.extract(pair.video, track.index)))) {
            verdict = 'embedded-copy';
            break;
          }
        }
      } catch {
        verdict = 'keep';
      }
    }
    if (tools.shouldStop?.()) break;
    cache?.set(pair.sidecar, signature, verdict);
    if (verdict !== 'keep') results.push({ path: pair.sidecar, reason: verdict });
  }
  return results;
}

// ── Holding, history and restore ──────────────────────────────────────────

export type CleanupItem = { from: string; held: string; reason: CleanupReason };
export type CleanupBatch = { id: string; createdAt: number; restoredAt: number; items: CleanupItem[] };

function moveAcrossDrives(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export function createCleanupStore(getDatabase: () => BetterSqlite3.Database, holdingRoot: string) {
  function readBatch(row: { id: string; created_at: number; restored_at: number; items_json: string }): CleanupBatch {
    return { id: row.id, createdAt: row.created_at, restoredAt: row.restored_at, items: JSON.parse(row.items_json) as CleanupItem[] };
  }

  /** Move candidates to the holding folder and record them as one batch. */
  function hold(candidates: readonly CleanupCandidate[], now = Date.now()): CleanupBatch | null {
    if (candidates.length === 0) return null;
    const id = randomUUID();
    const items: CleanupItem[] = [];
    candidates.forEach((candidate, index) => {
      const held = path.join(holdingRoot, id, `${index}-${path.basename(candidate.path)}`);
      try {
        moveAcrossDrives(candidate.path, held);
        items.push({ from: candidate.path, held, reason: candidate.reason });
      } catch (error) {
        console.warn(`[cleanup] Left ${path.basename(candidate.path)} in place:`, error instanceof Error ? error.message : error);
      }
    });
    if (items.length === 0) return null;
    getDatabase()
      .prepare('INSERT INTO library_cleanup_batches (id, created_at, restored_at, items_json) VALUES (?, ?, 0, ?)')
      .run(id, now, JSON.stringify(items));
    return { id, createdAt: now, restoredAt: 0, items };
  }

  function history(limit = 20): CleanupBatch[] {
    return (getDatabase().prepare('SELECT * FROM library_cleanup_batches ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ id: string; created_at: number; restored_at: number; items_json: string }>)
      .map(readBatch);
  }

  /** Put a batch back. Anything now occupying an original path is never overwritten. */
  function restore(batchId: string, now = Date.now()): { restored: number; skipped: string[] } {
    const row = getDatabase().prepare('SELECT * FROM library_cleanup_batches WHERE id = ?').get(batchId) as { id: string; created_at: number; restored_at: number; items_json: string } | undefined;
    if (!row) throw new Error('That cleanup could not be found.');
    const batch = readBatch(row);
    if (batch.restoredAt) throw new Error('That cleanup was already restored.');
    let restored = 0;
    const skipped: string[] = [];
    for (const item of batch.items) {
      if (fs.existsSync(item.from) || !fs.existsSync(item.held)) {
        skipped.push(item.from);
        continue;
      }
      try {
        moveAcrossDrives(item.held, item.from);
        restored += 1;
      } catch {
        skipped.push(item.from);
      }
    }
    getDatabase().prepare('UPDATE library_cleanup_batches SET restored_at = ? WHERE id = ?').run(now, batchId);
    fs.rmSync(path.join(holdingRoot, batchId), { recursive: true, force: true });
    return { restored, skipped };
  }

  /** Remove held files for good once their batch is older than the retention period. */
  function purgeExpired(now = Date.now()): number {
    const expired = (getDatabase().prepare('SELECT id FROM library_cleanup_batches WHERE restored_at = 0 AND created_at < ?').all(now - CLEANUP_RETENTION_MS) as Array<{ id: string }>);
    for (const { id } of expired) fs.rmSync(path.join(holdingRoot, id), { recursive: true, force: true });
    return expired.length;
  }

  /** Files the viewer put back; cleanup leaves them alone from then on. */
  function restoredPaths(): Set<string> {
    const rows = getDatabase().prepare('SELECT items_json FROM library_cleanup_batches WHERE restored_at > 0').all() as Array<{ items_json: string }>;
    return new Set(rows.flatMap((row) => (JSON.parse(row.items_json) as CleanupItem[]).map((item) => path.resolve(item.from))));
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

  return { hold, history, restore, purgeExpired, restoredPaths, subtitleCache };
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
