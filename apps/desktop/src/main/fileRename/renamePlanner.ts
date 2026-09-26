import { createHash } from 'node:crypto';
import path from 'node:path';
import { isVideoFileName } from '../fileClassification.ts';
import { parseEpisodeFileName } from '../scanClassification.ts';
import type { MediaItem } from '../metadata/types.ts';

/**
 * Plans renames of matched media files to the names LoomTV shows for them:
 *
 *   Inception (2010)/Inception (2010).mkv
 *   Lanterns (2026)/Season 01/S01E06 - Bad Optics.mp4
 *
 * Nothing here touches the disk beyond listing directories. A file is only
 * planned when every check agrees; anything doubtful is reported as skipped
 * with the reason, and left exactly as it is.
 */

export type RenameOperation = { from: string; to: string };

export type RenamePlanEntry = {
  /** Stable for a given source path, so a preview selection survives a re-plan. */
  id: string;
  kind: 'file' | 'folder';
  mediaId: string;
  mediaType: MediaItem['type'];
  mediaTitle: string;
  /** "Movie", "S01E03", "Season folder", or "Show folder". */
  label: string;
  from: string;
  to: string;
  /** Subtitles, .nfo, and thumbnails renamed with a video. */
  sidecars: RenameOperation[];
  /** A folder the move needs that does not exist yet ("Season 02"). */
  createFolder?: string;
};

export type RenameSkip = {
  mediaId: string;
  mediaTitle: string;
  filePath: string;
  reason: string;
};

export type RenamePlan = {
  entries: RenamePlanEntry[];
  skipped: RenameSkip[];
};

export type RenamePlannerInput = {
  items: readonly MediaItem[];
  /** Library folders the user added; these are never renamed. */
  libraryRoots: readonly string[];
  /** Entry names in a directory, or null when it cannot be read. */
  listDirectory: (directory: string) => string[] | null;
  /** True when an undone rename locked this file against this name. */
  isLocked: (filePath: string, targetName: string) => boolean;
  /** True when both paths are on the same drive, so a move is a single atomic rename. */
  sameDrive: (left: string, right: string) => boolean;
  /** Give a movie that shares a folder with others a folder of its own. */
  movieFolders?: boolean;
  /**
   * Automatic runs only: true for a file changed moments ago, which may still
   * be downloading or seeding. Such a file waits for a later sync.
   */
  isRecentlyModified?: (filePath: string) => boolean;
};

const SIDECAR_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx', '.sup', '.nfo', '.jpg', '.jpeg', '.png', '.webp']);
const SUBTITLE_TAG = /^(?:[a-z]{2,3}(?:-[a-z]{2,4})?|forced|sdh|cc|hi|default|full|signs|songs|commentary|opensubtitles|loomtv-clean-(?:signs|dialogue|honorific)|english|spanish|french|german|italian|portuguese|japanese|korean|chinese|arabic|russian|hindi)$/i;
// A bare number is a real title too (Lioness S02E06 is "2831"); only "Episode 6"-style numbers are placeholders.
const PLACEHOLDER_TITLE = /^(?:tba|tbd|to be announced|untitled|episode\s*#?\d+|ep\.?\s*\d+)$/i;
const SAMPLE_NAME = /(?:^|[\s._-])sample(?:[\s._-]|$)/i;
const MAX_BASE_LENGTH = 200;
/** Tokens that start the release-tag part of a name: quality, source, codec, language, group markers. */
const RELEASE_TAG = /^(?:\d{3,4}p|4k|uhd|hdr\d*\+?|dv|dovi|sdr|web|web-?dl|webrip|nfrip|amzn|nf|hmax|dsnp|atvp|hulu|pcok|bluray|blu-ray|brrip|bdrip|dvdrip|hdtv|hdrip|remux|x26[45]|h\.?26[45]|hevc|avc|av1|xvid|aac\d?(?:\.\d)?|ac3|dd\+?\d?(?:\.\d)?|ddp\d?(?:\.\d)?|eac3|dts(?:-hd)?|truehd|atmos|flac|opus|mp3|10bit|8bit|ita|eng|esub|multi|dual|subs?|proper|repack|internal|complete|limited)$/i;
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'is', 'at', 'for', 'with']);
/** A special or recap between regular episodes: "E11.5", "[SP]", "OVA". */
const SPECIAL_EPISODE = /[Ee]\d{1,3}\.\d(?!\d)|\[(?:sp|special|ova|oad)\]|(?:^|[\s._-])(?:ova|oad|special)(?:[\s._-]|$)/i;

const EDITIONS: Array<[RegExp, string]> = [
  [/director'?s[\s._-]*cut/i, "Director's Cut"],
  [/final[\s._-]*cut/i, 'Final Cut'],
  [/extended(?:[\s._-]*(?:edition|cut))?/i, 'Extended'],
  [/ultimate[\s._-]*(?:edition|cut)/i, 'Ultimate'],
  [/theatrical(?:[\s._-]*cut)?/i, 'Theatrical'],
  [/unrated/i, 'Unrated'],
  [/remastered/i, 'Remastered'],
  [/\bimax\b/i, 'IMAX'],
];

/**
 * An entry's ID covers the exact operation: source, destination, sidecars,
 * and any folder it creates. Approving a preview approves these IDs, so if
 * the plan has changed by the time it is applied, the ID no longer matches.
 */
function entryId(kind: 'file' | 'folder', from: string, to: string, sidecars: readonly RenameOperation[] = [], createFolder = ''): string {
  const parts = [kind, from, to, createFolder, ...sidecars.flatMap((sidecar) => [sidecar.from, sidecar.to])];
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 20);
}

/**
 * Make a title safe on Windows, macOS, and network shares: a colon becomes a
 * dash, reserved characters go, and trailing dots and spaces (which Windows
 * strips or rejects) are trimmed.
 */
export function sanitizeNamePart(value: string): string {
  return value
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[/\\?*"<>|]/g, '')
    .split('').filter((character) => character.charCodeAt(0) >= 0x20).join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.]+$/, '');
}

function withinLimit(base: string): string {
  return base.length <= MAX_BASE_LENGTH ? base : base.slice(0, MAX_BASE_LENGTH).replace(/[\s.-]+$/, '');
}

export function titleWithYear(title: string, year: number): string {
  return `${sanitizeNamePart(title)} (${year})`;
}

export function seasonFolderName(season: number): string {
  return `Season ${String(season).padStart(2, '0')}`;
}

export function episodeCode(season: number, episodes: readonly number[]): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const first = `S${pad(season)}E${pad(episodes[0])}`;
  return episodes.length > 1 ? `${first}-E${pad(episodes[episodes.length - 1])}` : first;
}

/**
 * The part of a sidecar's name that belongs to the sidecar rather than the
 * video: `.en.forced.srt`, `-thumb.jpg`, `.opensubtitles.es.srt`. Null when
 * the name carries nothing that identifies it beyond the extension and the
 * caller should fall back to the extension alone.
 */
export function sidecarSuffix(sidecarName: string, videoBase: string): string {
  const lowerName = sidecarName.toLowerCase();
  const lowerBase = videoBase.toLowerCase();
  if (lowerName.startsWith(lowerBase) && /^[.-]/.test(sidecarName.slice(videoBase.length))) {
    return sidecarName.slice(videoBase.length);
  }
  const extension = path.extname(sidecarName);
  const tokens = sidecarName.slice(0, sidecarName.length - extension.length).split('.');
  const tags: string[] = [];
  for (let index = tokens.length - 1; index > 0; index -= 1) {
    if (!SUBTITLE_TAG.test(tokens[index])) break;
    tags.unshift(tokens[index]);
  }
  return `${tags.map((tag) => `.${tag}`).join('')}${extension}`;
}

function runtimeMinutes(runtime?: string): number | null {
  const hours = Number((runtime || '').match(/(\d+)\s*h/i)?.[1] || 0);
  const minutes = Number((runtime || '').match(/(\d+)\s*m/i)?.[1] || 0);
  const total = hours * 60 + minutes;
  return total > 0 ? total : null;
}

/** Null when the lengths agree (or one is unknown), otherwise the reason. */
function runtimeMismatch(durationSeconds: number | undefined, runtime: string | undefined, low: number, high: number): string | null {
  const expected = runtimeMinutes(runtime);
  if (!expected || !durationSeconds) return null;
  const actual = durationSeconds / 60;
  const ratio = actual / expected;
  if (ratio >= low && ratio <= high) return null;
  return `The file runs ${Math.round(actual)} min but the match lists ${expected} min.`;
}

function hasMovieMatch(item: MediaItem): boolean {
  return Boolean(item.providerIds?.tmdbId || item.providerIds?.imdbId);
}

function hasShowMatch(item: MediaItem): boolean {
  const ids = item.providerIds;
  return Boolean(ids?.tvdbId || ids?.tmdbId || ids?.tvmazeId || ids?.malId || Object.keys(ids?.malIdBySeason || {}).length);
}

/**
 * The file name with release tags removed, for reading its episode number:
 * "[SubsPlease] Sousou no Frieren - 05 (1080p).mkv" becomes
 * "Sousou no Frieren - 05.mkv", which the scanner's parser understands.
 */
function withoutReleaseTags(name: string): string {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${stem}${extension}`;
}

function words(value: string): string[] {
  return value.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
}

/** "stone" and "stones", "emerge" and "emerges" count as the same word. */
function sameWord(left: string, right: string): boolean {
  return left === right || (Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left)));
}

/**
 * The episode title a file name carries after its SxxEyy, if any:
 * "Show.S02E04.The.Water.Falls.ITA.1080p" gives "The Water Falls".
 */
function fileEpisodeTitle(name: string): string[] {
  const stem = name.slice(0, name.length - path.extname(name).length);
  const after = stem.match(/[Ss]\d{1,2}[Ee]\d{1,3}(?:-?[Ee]\d{1,3})?(.*)$/)?.[1];
  if (!after) return [];
  const tokens = after.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').split(/[\s._]+|\s-\s|^-|-$/).filter(Boolean);
  const title: string[] = [];
  for (const token of tokens) {
    if (RELEASE_TAG.test(token) || /^[a-z0-9]+-[a-z0-9]+$/i.test(token) && RELEASE_TAG.test(token.split('-')[0])) break;
    title.push(token);
  }
  return words(title.join(' ')).filter((word) => !STOPWORDS.has(word));
}

/** True when the words a file name gives its episode mostly appear in the matched title. */
function episodeTitlesAgree(fileWords: readonly string[], matchedTitle: string): boolean {
  if (fileWords.length === 0) return true;
  const matched = words(matchedTitle);
  const hits = fileWords.filter((word) => matched.some((candidate) => sameWord(word, candidate))).length;
  return hits / fileWords.length >= 0.5;
}

/**
 * The words of a movie file name before its year: the title part. Release
 * tags after the year (edition, part, quality) are not part of it.
 */
function splitAtYear(stem: string, year: number): { titleTokens: string[]; tagText: string } {
  const tokens = stem.split(/[\s._]+/).filter(Boolean);
  const index = tokens.findIndex((token) => {
    const bare = token.replace(/[()[\]]/g, '');
    return /^(?:19|20)\d{2}$/.test(bare) && Math.abs(Number(bare) - year) <= 1;
  });
  if (index < 0) return { titleTokens: tokens, tagText: '' };
  return { titleTokens: tokens.slice(0, index), tagText: tokens.slice(index + 1).join(' ') };
}

/**
 * The library title with words missing from the middle of the file's own
 * title ("Grand Theft Auto VI An Look" from "...An.Extended.Look.2026"):
 * a local clean-up went too far, and that name should not be written to disk.
 */
function titleLostWords(title: string, fileTitleTokens: readonly string[]): boolean {
  const target = words(title);
  const source = words(fileTitleTokens.join(' '));
  if (target.length === 0 || source.length <= target.length) return false;
  const positions: number[] = [];
  let cursor = 0;
  for (const word of target) {
    const found = source.indexOf(word, cursor);
    if (found < 0) return false;
    positions.push(found);
    cursor = found + 1;
  }
  return positions[positions.length - 1] - positions[0] + 1 > target.length;
}

type LocalDetails = MediaItem['localMetadata'];

function resolutionLabel(details: LocalDetails): string | null {
  const width = details?.width || 0;
  const height = details?.height || 0;
  if (!width && !height) return null;
  if (height >= 2000 || width >= 3800) return '2160p';
  if (height >= 1000 || width >= 1900) return '1080p';
  if (height >= 700 || width >= 1270) return '720p';
  if (height >= 560) return '576p';
  return '480p';
}

function codecLabel(details: LocalDetails): string {
  const codec = (details?.videoCodec || '').toLowerCase();
  if (codec === 'hevc' || codec === 'h265') return 'HEVC';
  if (codec === 'h264' || codec === 'avc') return 'H.264';
  if (codec === 'av1') return 'AV1';
  return codec.toUpperCase();
}

/**
 * Names that tell copies of the same title apart by quality: "1080p" and
 * "720p", then "1080p HEVC" and "1080p H.264" when the resolution matches,
 * then a number. Null when a copy's quality is unknown, in which case the
 * copies are left as they are rather than named by guesswork.
 */
export function versionLabels(copies: readonly LocalDetails[]): string[] | null {
  const resolutions = copies.map(resolutionLabel);
  if (resolutions.some((label) => !label)) return null;
  let labels = resolutions as string[];
  if (new Set(labels).size !== labels.length) {
    labels = labels.map((label, index) => {
      const same = labels.filter((other) => other === label).length > 1;
      const codec = codecLabel(copies[index]);
      return same && codec ? `${label} ${codec}` : label;
    });
  }
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const total = labels.filter((other) => other === label).length;
    if (total === 1) return label;
    const count = (seen.get(label) || 0) + 1;
    seen.set(label, count);
    return `${label} (${count})`;
  });
}

/** The season a folder is named for ("Season 2", "S02", "Specials"), or null. */
function seasonOfFolder(name: string): number | null {
  if (/^specials?$/i.test(name.trim())) return 0;
  const match = name.match(/^(?:season|series|staffel|saison|temporada)\s*0*(\d{1,3})$/i) || name.match(/^s0*(\d{1,3})$/i);
  return match ? Number(match[1]) : null;
}

function isSameOrAncestor(candidate: string, of: string): boolean {
  const relative = path.relative(candidate, of);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function planRenames(input: RenamePlannerInput): RenamePlan {
  const entries: RenamePlanEntry[] = [];
  const skipped: RenameSkip[] = [];
  const listings = new Map<string, string[] | null>();
  const list = (directory: string) => {
    if (!listings.has(directory)) listings.set(directory, input.listDirectory(directory));
    return listings.get(directory) ?? null;
  };
  const roots = input.libraryRoots.map((root) => path.resolve(root));
  const isProtectedFolder = (folder: string) => roots.some((root) => isSameOrAncestor(folder, root));

  // Every path the plan will create, so two moves never land on one name.
  const plannedTargets = new Set<string>();
  const claimTarget = (target: string) => plannedTargets.add(target.toLowerCase());

  /**
   * Another entry in the folder already has this name, or another planned
   * rename is headed there. The file's own current name (a case-only change)
   * does not count.
   */
  const nameTaken = (directory: string, name: string, own: string) => {
    if (plannedTargets.has(path.join(directory, name).toLowerCase())) return true;
    const names = list(directory) || [];
    return names.some((entry) => entry.toLowerCase() === name.toLowerCase() && entry !== own);
  };

  const sidecarsFor = (
    videoPath: string,
    newBase: string,
    recorded: readonly string[],
    targetDirectory: string,
  ): RenameOperation[] | string => {
    const directory = path.dirname(videoPath);
    const names = list(directory) || [];
    const videoName = path.basename(videoPath);
    const videoBase = videoName.slice(0, videoName.length - path.extname(videoName).length);
    const otherVideoBases = names
      .filter((name) => name !== videoName && isVideoFileName(name))
      .map((name) => name.slice(0, name.length - path.extname(name).length).toLowerCase());
    const candidates = new Set<string>();
    for (const recordedPath of recorded) {
      if (path.dirname(recordedPath) === directory && names.includes(path.basename(recordedPath))) candidates.add(path.basename(recordedPath));
    }
    for (const name of names) {
      if (!SIDECAR_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
      const lower = name.toLowerCase();
      if (!lower.startsWith(videoBase.toLowerCase()) || !/^[.-]/.test(name.slice(videoBase.length))) continue;
      // "Dune.Part.Two.en.srt" also starts with "Dune"; it belongs to the
      // longer-named video beside it.
      const claimedByLonger = otherVideoBases.some((base) => base.length > videoBase.length && lower.startsWith(base));
      if (!claimedByLonger) candidates.add(name);
    }
    const operations: RenameOperation[] = [];
    const targets = new Set<string>();
    const moving = targetDirectory !== directory;
    for (const name of candidates) {
      const target = `${newBase}${sidecarSuffix(name, videoBase)}`;
      if (target === name && !moving) continue;
      if (targets.has(target.toLowerCase())) return `Two subtitle files would both become "${target}".`;
      if (nameTaken(targetDirectory, target, moving ? '' : name)) return `"${target}" already exists.`;
      targets.add(target.toLowerCase());
      operations.push({ from: path.join(directory, name), to: path.join(targetDirectory, target) });
    }
    return operations;
  };

  const subtitlePaths = (records?: readonly { url: string }[]) => (records || []).flatMap((record) => {
    const match = record.url.match(/[?&]path=([^&#]*)/);
    if (!match) return [];
    try {
      return [decodeURIComponent(match[1].replace(/\+/g, ' '))];
    } catch {
      return [];
    }
  });

  /**
   * Plan a video's rename, and its move when `targetDirectory` differs.
   * "unchanged" means it already has the right name and place; "rejected"
   * means a check stopped it and a skip reason was recorded.
   */
  const planFile = (
    item: MediaItem,
    label: string,
    filePath: string,
    newBase: string,
    recordedSubtitles: readonly string[],
    targetDirectory = path.dirname(filePath),
    createFolder?: string,
  ): 'planned' | 'unchanged' | 'rejected' => {
    const skip = (reason: string): 'rejected' => {
      skipped.push({ mediaId: item.id, mediaTitle: item.title, filePath, reason });
      return 'rejected';
    };
    const directory = path.dirname(filePath);
    const name = path.basename(filePath);
    const moving = targetDirectory !== directory;
    if (!(list(directory) || []).includes(name)) return skip('The file is no longer where the library expects it.');
    if (input.isRecentlyModified?.(filePath)) {
      return skip('The file changed in the last few minutes and may still be downloading, so it waits for the next sync.');
    }
    const base = withinLimit(newBase);
    const target = `${base}${path.extname(name).toLowerCase()}`;
    if (target === name && !moving) return 'unchanged';
    if (input.isLocked(filePath, target)) return skip('You undid this rename, so it is not renamed again unless its match changes.');
    if (moving && !input.sameDrive(directory, createFolder ? path.dirname(createFolder) : targetDirectory)) {
      return skip('The destination folder is on a different drive, so the file is not moved.');
    }
    if (nameTaken(targetDirectory, target, moving ? '' : name)) return skip(`"${target}" already exists in "${path.basename(targetDirectory)}".`);
    const sidecars = sidecarsFor(filePath, base, recordedSubtitles, targetDirectory);
    if (typeof sidecars === 'string') return skip(sidecars);
    claimTarget(path.join(targetDirectory, target));
    for (const sidecar of sidecars) claimTarget(sidecar.to);
    entries.push({
      id: entryId('file', filePath, path.join(targetDirectory, target), sidecars, createFolder),
      kind: 'file',
      mediaId: item.id,
      mediaType: item.type,
      mediaTitle: item.title,
      label,
      from: filePath,
      to: path.join(targetDirectory, target),
      sidecars,
      ...(createFolder ? { createFolder } : {}),
    });
    return 'planned';
  };

  /**
   * Plan a group of copies as one unit: when any member is rejected, every
   * entry and destination claim the group made is taken back, so a group is
   * either renamed whole or left whole.
   */
  const planAsGroup = (plan: () => boolean): boolean => {
    const entryMark = entries.length;
    const claims = new Set(plannedTargets);
    if (plan()) return true;
    entries.length = entryMark;
    plannedTargets.clear();
    for (const claim of claims) plannedTargets.add(claim);
    return false;
  };

  const planFolder = (item: MediaItem, label: string, folder: string, targetName: string): void => {
    if (isProtectedFolder(folder)) return;
    const name = path.basename(folder);
    if (name === targetName) return;
    const parent = path.dirname(folder);
    if (nameTaken(parent, targetName, name)) {
      skipped.push({ mediaId: item.id, mediaTitle: item.title, filePath: folder, reason: `A folder named "${targetName}" already exists.` });
      return;
    }
    entries.push({
      id: entryId('folder', folder, path.join(parent, targetName)),
      kind: 'folder',
      mediaId: item.id,
      mediaType: item.type,
      mediaTitle: item.title,
      label,
      from: folder,
      to: path.join(parent, targetName),
      sidecars: [],
    });
  };

  /** Every check a movie file must pass, and the name it gets when it does. */
  const checkMovie = (item: MediaItem): { base: string; part?: string } | { reason: string } => {
    if (!item.title?.trim() || !(item.year > 0)) return { reason: 'The match has no title or year.' };
    if (!hasMovieMatch(item)) return { reason: 'No metadata match.' };
    const name = path.basename(item.filePath);
    const stem = name.slice(0, name.length - path.extname(name).length);
    const titleDigits = new Set(item.title.match(/\d{4}/g) || []);
    const namedYears = [...stem.matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?![0-9p])/gi)]
      .map((match) => match[1])
      .filter((year) => !titleDigits.has(year));
    if (namedYears.length && !namedYears.some((year) => Math.abs(Number(year) - item.year) <= 1)) {
      return { reason: `The file name says ${namedYears[0]}, but the match is from ${item.year}.` };
    }
    const mismatch = runtimeMismatch(item.localMetadata?.durationSeconds, item.runtime, 0.6, 1.6);
    if (mismatch) return { reason: mismatch };
    const { titleTokens, tagText } = splitAtYear(stem, item.year);
    if (titleLostWords(item.title, titleTokens)) {
      return { reason: `The library title "${item.title}" is missing words from the file's own title.` };
    }
    // Editions and split parts only count in the release-tag part after the
    // year; before it they are the title ("The Godfather Part 2").
    const edition = EDITIONS.find(([pattern]) => pattern.test(tagText))?.[1];
    const part = ` ${tagText} `.match(/[\s-](?:cd|part|pt|disc)[\s-]?([1-9])[\s-]/i)?.[1];
    return {
      base: `${titleWithYear(item.title, item.year)}${edition ? ` {edition-${edition}}` : ''}${part ? ` - part${part}` : ''}`,
      part,
    };
  };

  // Copies of one movie (the same metadata ID) are kept side by side as
  // versions, "Inception (2010) - 1080p.mkv" beside "... - 720p.mkv". Only the
  // ID counts, never a similar title, so a remake is never taken for a copy.
  const duplicateMovies = new Set<string>();
  const movieGroups = new Map<string, MediaItem[]>();
  for (const item of input.items) {
    if (item.type !== 'movie') continue;
    const key = item.providerIds?.tmdbId ? `tmdb:${item.providerIds.tmdbId}` : item.providerIds?.imdbId ? `imdb:${item.providerIds.imdbId}` : '';
    if (key) movieGroups.set(key, [...(movieGroups.get(key) || []), item]);
  }
  for (const copies of movieGroups.values()) {
    if (copies.length < 2) continue;
    for (const copy of copies) duplicateMovies.add(copy.id);
    const skipAll = (reason: string) => {
      for (const copy of copies) skipped.push({ mediaId: copy.id, mediaTitle: copy.title, filePath: copy.filePath, reason });
    };
    const checks = copies.map(checkMovie);
    const failed = checks.find((check): check is { reason: string } => 'reason' in check);
    if (failed) {
      skipAll(`One copy of this movie needs a closer look, so no copy is renamed: ${failed.reason}`);
      continue;
    }
    const folders = new Set(copies.map((copy) => path.dirname(copy.filePath)));
    if (folders.size !== 1) {
      skipAll('Copies of this movie are in different folders, so they are left as they are.');
      continue;
    }
    const bases = checks.map((check) => (check as { base: string }).base);
    // Different editions or parts already have different names.
    let names = bases;
    if (new Set(bases).size !== bases.length) {
      const labels = versionLabels(copies.map((copy) => copy.localMetadata));
      if (!labels) {
        skipAll("A copy's video quality is unknown, so the copies cannot be told apart by name.");
        continue;
      }
      names = bases.map((base, index) => `${base} - ${labels[index]}`);
    }
    const folder = [...folders][0];
    const videos = (list(folder) || []).filter((entry) => isVideoFileName(entry) && !SAMPLE_NAME.test(entry));
    const ownFolderName = titleWithYear(copies[0].title, copies[0].year);
    const dedicated = videos.length === copies.length && !roots.includes(path.resolve(folder));
    const ownFolder = path.join(folder, ownFolderName);
    if (!dedicated && (list(ownFolder) !== null || plannedTargets.has(ownFolder.toLowerCase()))) {
      skipAll(`A folder named "${ownFolderName}" already exists, so the copies are not moved into it.`);
      continue;
    }
    let rejected: MediaItem | null = null;
    const planned = planAsGroup(() => {
      for (const [index, copy] of copies.entries()) {
        const result = dedicated
          ? planFile(copy, 'Movie', copy.filePath, names[index], subtitlePaths(copy.subtitles))
          : planFile(copy, 'Movie', copy.filePath, names[index], subtitlePaths(copy.subtitles), ownFolder, ownFolder);
        if (result === 'rejected') {
          rejected = copy;
          return false;
        }
      }
      return true;
    });
    if (!planned) {
      for (const copy of copies) {
        if (copy === rejected) continue;
        skipped.push({ mediaId: copy.id, mediaTitle: copy.title, filePath: copy.filePath, reason: 'Another copy of this movie could not be renamed, so no copy is.' });
      }
      continue;
    }
    if (dedicated) planFolder(copies[0], 'Movie folder', folder, ownFolderName);
    else claimTarget(ownFolder);
  }

  // One show found in two folders is reported, never merged: merging two
  // library entries could not be undone cleanly.
  const splitShows = new Map<string, MediaItem[]>();
  for (const item of input.items) {
    if (item.type === 'movie') continue;
    const ids = item.providerIds;
    const key = ids?.tvdbId ? `tvdb:${ids.tvdbId}` : ids?.tmdbId ? `tmdb:${ids.tmdbId}` : ids?.tvmazeId ? `tvmaze:${ids.tvmazeId}` : '';
    if (key) splitShows.set(`${item.type}:${key}`, [...(splitShows.get(`${item.type}:${key}`) || []), item]);
  }
  const splitShowIds = new Map<string, string>();
  for (const items of splitShows.values()) {
    if (items.length < 2) continue;
    for (const item of items) {
      const others = items.filter((other) => other !== item).map((other) => `"${path.basename(other.filePath)}"`).join(', ');
      splitShowIds.set(item.id, `This show is also in ${others}. Folders for one show are not merged automatically, so both are left as they are.`);
    }
  }

  for (const item of input.items) {
    const skipItem = (reason: string) => skipped.push({ mediaId: item.id, mediaTitle: item.title, filePath: item.filePath, reason });
    if (splitShowIds.has(item.id)) {
      skipItem(splitShowIds.get(item.id) as string);
      continue;
    }
    if (item.type === 'movie' && duplicateMovies.has(item.id)) continue;
    if (!item.title?.trim() || !(item.year > 0)) {
      skipItem('The match has no title or year.');
      continue;
    }

    if (item.type === 'movie') {
      if (duplicateMovies.has(item.id)) continue;
      const checked = checkMovie(item);
      if ('reason' in checked) {
        skipItem(checked.reason);
        continue;
      }
      const { base, part } = checked;
      // A folder holding just this movie (plus samples and extras) is named
      // after it too. In a shared folder the movie stays put, unless the
      // user asked for each movie to get a folder of its own.
      const folder = path.dirname(item.filePath);
      const videos = (list(folder) || []).filter((entry) => isVideoFileName(entry) && !SAMPLE_NAME.test(entry));
      const shared = videos.length > 1 || roots.includes(path.resolve(folder));
      const ownFolderName = titleWithYear(item.title, item.year);
      if (input.movieFolders && shared && !part) {
        const ownFolder = path.join(folder, ownFolderName);
        if (list(ownFolder) !== null || plannedTargets.has(ownFolder.toLowerCase())) {
          skipItem(`A folder named "${ownFolderName}" already exists, so the movie is not moved into it.`);
          continue;
        }
        if (planFile(item, 'Movie', item.filePath, base, subtitlePaths(item.subtitles), ownFolder, ownFolder) === 'planned') claimTarget(ownFolder);
        continue;
      }
      planFile(item, 'Movie', item.filePath, base, subtitlePaths(item.subtitles));
      if (videos.length === 1 && !part) planFolder(item, 'Movie folder', folder, ownFolderName);
      continue;
    }

    // TV and anime.
    if (!hasShowMatch(item)) {
      skipItem('No metadata match.');
      continue;
    }
    const showFolder = path.resolve(item.filePath);
    const files = item.episodeFiles || [];
    const dedicated = !isProtectedFolder(showFolder)
      && files.length > 0
      && files.every((file) => isSameOrAncestor(showFolder, path.dirname(file.filePath)) && path.resolve(file.filePath) !== showFolder);
    const metadataEpisodes = new Map((item.episodes || []).map((episode) => [`${episode.season}:${episode.number}`, episode]));
    const metadataSeasonSizes = new Map<number, number>();
    for (const episode of item.episodes || []) {
      metadataSeasonSizes.set(episode.season, Math.max(metadataSeasonSizes.get(episode.season) || 0, episode.number));
    }
    const regularSeasons = [...metadataSeasonSizes.keys()].filter((season) => season > 0);

    // One file can hold two episodes (S01E01-E02); group by file first.
    const byFile = new Map<string, typeof files[number][]>();
    for (const file of files) byFile.set(file.filePath, [...(byFile.get(file.filePath) || []), file]);
    const claims = new Map<string, number>();
    for (const file of files) claims.set(`${file.season}:${file.episode}`, (claims.get(`${file.season}:${file.episode}`) || 0) + 1);
    // Distinct episodes, so a second copy of one episode is not an extra file.
    const episodesPerSeason = new Map<number, Set<number>>();
    for (const file of files) episodesPerSeason.set(file.season, (episodesPerSeason.get(file.season) || new Set<number>()).add(file.episode));

    // Season folders directly inside the show folder, by the season they name.
    const seasonFolders = new Map<number, string[]>();
    if (dedicated) {
      for (const entry of list(showFolder) || []) {
        const season = seasonOfFolder(entry);
        const full = path.join(showFolder, entry);
        if (season === null || list(full) === null) continue;
        seasonFolders.set(season, [...(seasonFolders.get(season) || []), full]);
      }
    }
    const movedOut = new Set<string>();
    const movedIn = new Map<string, number[]>();
    const confirmedFolders = new Set<string>();
    const passed: Array<{
      filePath: string;
      first: typeof files[number];
      code: string;
      base: string;
      recorded: string[];
      targetDirectory: string;
      createFolder: string | undefined;
      directory: string;
    }> = [];
    // A show folder is only renamed once an episode has confirmed the match.
    let confirmedEpisodes = 0;
    for (const [filePath, group] of byFile) {
      const sorted = [...group].sort((left, right) => left.episode - right.episode);
      const first = sorted[0];
      const skip = (reason: string) => skipped.push({ mediaId: item.id, mediaTitle: item.title, filePath, reason });
      const name = path.basename(filePath);
      const parsed = parseEpisodeFileName(name, first.season) || parseEpisodeFileName(withoutReleaseTags(name), first.season);
      if (!parsed) {
        skip('The file name has no episode number to confirm the match against.');
        continue;
      }
      if (SPECIAL_EPISODE.test(name)) {
        skip('The file looks like a special or in-between episode, which is not renamed automatically.');
        continue;
      }
      if (parsed.season !== first.season || parsed.episode !== first.episode) {
        skip(`The file name says ${episodeCode(parsed.season, [parsed.episode])}, but it is matched as ${episodeCode(first.season, [first.episode])}.`);
        continue;
      }
      const seasonSize = metadataSeasonSizes.get(first.season) || 0;
      if ((episodesPerSeason.get(first.season)?.size || 0) > seasonSize) {
        skip(`Season ${first.season} has more files than the match lists episodes.`);
        continue;
      }
      if (item.type === 'anime' && !/[Ss]\s*\d{1,2}\s*[._ -]*[Ee]\s*\d/.test(name)) {
        const seasonFolderNamed = new RegExp(`season\\s*0*${first.season}(?!\\d)`, 'i').test(path.basename(path.dirname(filePath)));
        if (!seasonFolderNamed && regularSeasons.length > 1) {
          skip('The file only has an episode number, and this anime has several seasons, so the season cannot be confirmed.');
          continue;
        }
      }
      const titles: string[] = [];
      let missingTitle = false;
      for (const file of sorted) {
        const title = metadataEpisodes.get(`${file.season}:${file.episode}`)?.title?.trim() || '';
        if (!title || PLACEHOLDER_TITLE.test(title)) missingTitle = true;
        titles.push(title);
      }
      if (missingTitle) {
        skip('The episode title has not been published yet.');
        continue;
      }
      const namedWords = fileEpisodeTitle(name);
      if (!episodeTitlesAgree(namedWords, titles.join(' '))) {
        skip(`The file name calls this episode "${namedWords.join(' ')}", but the match is "${titles.join(' & ')}".`);
        continue;
      }
      const mismatch = runtimeMismatch(first.localMetadata?.durationSeconds, item.runtime, 0.4, 2.6);
      if (mismatch) {
        skip(mismatch);
        continue;
      }

      const directory = path.dirname(path.resolve(filePath));
      // Within the show's own folder, an episode belongs in its season's
      // folder: a loose one moves in, and one in another season's folder
      // moves over. Episodes in any other subfolder stay where they are.
      let targetDirectory = directory;
      let createFolder: string | undefined;
      const currentSeason = directory === showFolder ? null : seasonOfFolder(path.basename(directory));
      const misplaced = dedicated && (
        directory === showFolder
        || (path.dirname(directory) === showFolder && currentSeason !== null && currentSeason !== first.season)
      );
      if (misplaced) {
        const existing = seasonFolders.get(first.season) || [];
        if (existing.length > 1) {
          skip(`Season ${first.season} has more than one folder in this show, so the file is not moved.`);
          continue;
        }
        targetDirectory = existing[0] || path.join(showFolder, first.season === 0 ? 'Specials' : seasonFolderName(first.season));
        if (!existing[0]) createFolder = targetDirectory;
      }
      const inShowFolder = dedicated && (targetDirectory === showFolder || path.dirname(targetDirectory) === showFolder);
      const code = episodeCode(first.season, sorted.map((file) => file.episode));
      const episodeTitle = sanitizeNamePart([...new Set(titles)].join(' & '));
      const base = inShowFolder
        ? `${code} - ${episodeTitle}`
        : `${titleWithYear(item.title, item.year)} - ${code} - ${episodeTitle}`;
      if (sorted.length > 1 && sorted.some((file) => (claims.get(`${file.season}:${file.episode}`) || 0) > 1)) {
        skip(`This file holds ${code}, and another file also holds one of those episodes.`);
        continue;
      }
      const recorded = sorted.flatMap((file) => subtitlePaths(file.subtitles));
      passed.push({ filePath, first, code, base, recorded, targetDirectory, createFolder, directory });
    }

    // Copies of one episode are kept side by side as versions, but only when
    // every copy passed its checks and their qualities tell them apart.
    const byEpisode = new Map<string, typeof passed>();
    for (const candidate of passed) byEpisode.set(candidate.code, [...(byEpisode.get(candidate.code) || []), candidate]);
    for (const [code, copies] of byEpisode) {
      const expected = claims.get(`${copies[0].first.season}:${copies[0].first.episode}`) || 1;
      const skipCopies = (reason: string) => {
        for (const copy of copies) skipped.push({ mediaId: item.id, mediaTitle: item.title, filePath: copy.filePath, reason });
      };
      if (expected > 1 || copies.length > 1) {
        if (copies.length !== expected) {
          skipCopies(`Another copy of ${code} needs a closer look, so no copy is renamed.`);
          continue;
        }
        const labels = versionLabels(copies.map((copy) => copy.first.localMetadata));
        if (!labels) {
          skipCopies(`The video quality of a copy of ${code} is unknown, so the copies cannot be told apart by name.`);
          continue;
        }
        copies.forEach((copy, index) => { copy.base = `${copy.base} - ${labels[index]}`; });
      }
      const results = new Map<typeof copies[number], 'planned' | 'unchanged' | 'rejected'>();
      let rejected: typeof copies[number] | null = null;
      const grouped = planAsGroup(() => {
        for (const copy of copies) {
          const result = planFile(item, code, copy.filePath, copy.base, copy.recorded, copy.targetDirectory, copy.createFolder);
          results.set(copy, result);
          if (result === 'rejected') {
            rejected = copy;
            return false;
          }
        }
        return true;
      });
      if (!grouped) {
        if (copies.length > 1) {
          for (const copy of copies) {
            if (copy === rejected) continue;
            skipped.push({ mediaId: item.id, mediaTitle: item.title, filePath: copy.filePath, reason: `Another copy of ${code} could not be renamed, so no copy is.` });
          }
        }
        continue;
      }
      for (const copy of copies) {
        // The file passed every match check, whether or not it needed a change.
        confirmedEpisodes += 1;
        if (results.get(copy) === 'planned' && copy.targetDirectory !== copy.directory) {
          movedOut.add(path.resolve(copy.filePath));
          movedIn.set(copy.targetDirectory, [...(movedIn.get(copy.targetDirectory) || []), copy.first.season]);
          confirmedFolders.add(copy.targetDirectory);
        } else {
          confirmedFolders.add(copy.directory);
        }
      }
    }

    if (!dedicated || confirmedEpisodes === 0) continue;
    // Name a season folder only when everything left in it after the moves
    // is this show's episodes of one season.
    for (const [season, folders] of seasonFolders) {
      if (folders.length !== 1 || !confirmedFolders.has(folders[0])) continue;
      const folder = folders[0];
      const ownHere = files.filter((file) => path.dirname(path.resolve(file.filePath)) === folder);
      const staying = ownHere.filter((file) => !movedOut.has(path.resolve(file.filePath)));
      const seasons = new Set([...staying.map((file) => file.season), ...(movedIn.get(folder) || [])]);
      const ownNames = new Set(ownHere.map((file) => path.basename(file.filePath)));
      const videos = (list(folder) || []).filter((entry) => isVideoFileName(entry) && !SAMPLE_NAME.test(entry));
      if (seasons.size !== 1 || !seasons.has(season) || videos.some((video) => !ownNames.has(video))) continue;
      planFolder(item, 'Season folder', folder, season === 0 ? 'Specials' : seasonFolderName(season));
    }
    planFolder(item, 'Show folder', showFolder, titleWithYear(item.title, item.year));
  }

  return { entries, skipped };
}

/**
 * Where a path ends up after a set of renames: file renames apply to the
 * exact path, folder renames to everything inside them, deepest first — the
 * order the executor performs them in.
 */
export function orderOperations(entries: readonly RenamePlanEntry[]): RenameOperation[] {
  const files = entries.filter((entry) => entry.kind === 'file')
    .flatMap((entry) => [...entry.sidecars, { from: entry.from, to: entry.to }]);
  const folders = entries.filter((entry) => entry.kind === 'folder')
    .sort((left, right) => right.from.split(path.sep).length - left.from.split(path.sep).length)
    .map((entry) => ({ from: entry.from, to: entry.to }));
  return [...files, ...folders];
}

/** Apply performed operations, in order, to any path. */
export function createPathMapper(operations: readonly RenameOperation[]): (value: string) => string {
  return (value: string) => {
    let current = value;
    for (const operation of operations) {
      if (current === operation.from) current = operation.to;
      else if (current.startsWith(`${operation.from}${path.sep}`)) current = `${operation.to}${current.slice(operation.from.length)}`;
    }
    return current;
  };
}
