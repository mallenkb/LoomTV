import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  isImageFileName,
  isMacSidecarFile,
  isSubtitleFileName,
  isVideoFileName,
} from './fileClassification.ts';
import type { ProbeMediaFileResult } from './mediaProbeFile.ts';
import { createSubtitleRecords, parseEpisodeFileName } from './scanClassification.ts';
import type { EpisodeFile } from './metadata/types.ts';
import {
  getBoundedLibraryProbe,
  LIBRARY_PROBE_CONCURRENCY,
  mapWithConcurrency,
} from './libraryScanConcurrency.ts';

export type MediaFileProbe = (filePath: string) => ProbeMediaFileResult;
export type AsyncMediaFileProbe = (filePath: string) => Promise<ProbeMediaFileResult>;
const EMPTY_MEDIA_FILE_PROBE: MediaFileProbe = () => ({});

const SKIPPED_EPISODE_DIRECTORIES = new Set([
  'nc', 'nced', 'ncop', 'bonus', 'extras', 'extra',
  'behind the scenes', 'featurettes', 'interviews', 'scenes', 'shorts',
  'trailers', 'featurette', 'sample', 'samples', 'subs', 'subtitles',
]);
const SPECIALS_DIRECTORY_PATTERN = /^specials?(?=$|[\s.:()[\]{}–—])/i;
const SEASON_DIRECTORY_PATTERN = /^(?:season|series|s)[\s.:]*0*(\d{1,2})(?=$|[\s.:()[\]{}–—])/i;

/**
 * Jellyfin treats Season 00 as the Specials season. It also accepts the
 * common Specials directory alias, so keep that name in one place
 * for both classification and episode scanning.
 */
export function seasonNumberFromDirectoryName(name: string): number | null {
  const normalized = name.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (SPECIALS_DIRECTORY_PATTERN.test(normalized)) return 0;

  // Downloaded libraries commonly append an arc or subtitle to the season
  // number, for example "Season 02 - Entertainment District Arc". The
  // leading season marker remains authoritative as long as the number ends at
  // a separator, which avoids treating episode-like names such as S01E02 as a
  // season directory.
  const match = normalized.match(SEASON_DIRECTORY_PATTERN);
  return match ? parseInt(match[1], 10) : null;
}

export function isSeasonDirectoryName(name: string): boolean {
  return seasonNumberFromDirectoryName(name) !== null;
}

function seasonTitle(number: number, originalName?: string): string {
  return number === 0 ? 'Specials' : originalName || `Season ${String(number).padStart(2, '0')}`;
}

function matchingSubtitleFilesForVideo(directory: string, videoFileName: string): string[] {
  const baseName = path.basename(videoFileName, path.extname(videoFileName)).toLowerCase();
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && isSubtitleFileName(entry.name))
      .map((entry) => entry.name)
      .filter((fileName) => path.basename(fileName, path.extname(fileName)).toLowerCase().startsWith(baseName));
  } catch {
    return [];
  }
}

export function getLibraryFolderSignature(folderPath: string): { signature: string; fileCount: number } | null {
  if (!fs.existsSync(folderPath)) return null;

  const hash = createHash('sha256');
  const stack = [folderPath];
  let fileCount = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (isMacSidecarFile(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!isVideoFileName(entry.name) && !isSubtitleFileName(entry.name) && !isImageFileName(entry.name)) continue;
      try {
        const stats = fs.statSync(fullPath);
        hash.update(path.relative(folderPath, fullPath));
        hash.update('\0');
        hash.update(String(stats.size));
        hash.update('\0');
        hash.update(String(Math.round(stats.mtimeMs)));
        hash.update('\0');
        fileCount += 1;
      } catch {
        // A later scan will pick up files that disappear during traversal.
      }
    }
  }

  return { signature: `${fileCount}:${hash.digest('hex')}`, fileCount };
}

/**
 * Startup scans run in Electron's main process, so the recursive filesystem
 * walk must yield while the OS reads each directory and file. The synchronous
 * variant remains available for small, deterministic callers and tests.
 */
export async function getLibraryFolderSignatureAsync(
  folderPath: string,
): Promise<{ signature: string; fileCount: number } | null> {
  try {
    const root = await fs.promises.stat(folderPath);
    if (!root.isDirectory()) return null;
  } catch {
    return null;
  }

  const hash = createHash('sha256');
  const stack = [folderPath];
  let fileCount = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;

    let entries: fs.Dirent[];
    try {
      entries = (await fs.promises.readdir(current, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read library directory "${current}": ${message}`, { cause: error });
    }

    for (const entry of entries) {
      if (isMacSidecarFile(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!isVideoFileName(entry.name) && !isSubtitleFileName(entry.name) && !isImageFileName(entry.name)) continue;
      try {
        const stats = await fs.promises.stat(fullPath);
        hash.update(path.relative(folderPath, fullPath));
        hash.update('\0');
        hash.update(String(stats.size));
        hash.update('\0');
        hash.update(String(Math.round(stats.mtimeMs)));
        hash.update('\0');
        fileCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to inspect library file "${fullPath}": ${message}`, { cause: error });
      }
    }
  }

  return { signature: `${fileCount}:${hash.digest('hex')}`, fileCount };
}

function seasonFromRelativePath(root: string, directory: string): number | null {
  const relativeParts = path.relative(root, directory).split(path.sep).filter(Boolean).reverse();
  for (const part of [...relativeParts, path.basename(root)].filter(Boolean)) {
    const season = seasonNumberFromDirectoryName(part);
    if (season !== null) return season;
  }
  return null;
}

export function scanEpisodeFiles(folderPath: string, probe: MediaFileProbe = EMPTY_MEDIA_FILE_PROBE): EpisodeFile[] {
  const files: EpisodeFile[] = [];

  const scanDirectory = (directory: string): void => {
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_EPISODE_DIRECTORIES.has(entry.name.toLowerCase())) scanDirectory(fullPath);
          continue;
        }
        if (!isVideoFileName(entry.name)) continue;
        const mediaProbe = probe(fullPath);
        if (!mediaProbe.localMetadata?.videoCodec) continue;
        const folderSeason = seasonFromRelativePath(folderPath, directory);
        const parsed = parseEpisodeFileName(entry.name, mediaProbe.season ?? folderSeason ?? 1);
        if (!parsed) continue;
        // A named Season 00/Specials folder is authoritative. This keeps
        // files such as an AOT finale stored in Season 00 out of Season 4,
        // even when the filename still contains its original S04E29 code.
        const season = folderSeason === 0
          ? 0
          : mediaProbe.season ?? parsed.season ?? folderSeason ?? 1;
        files.push({
          season,
          episode: mediaProbe.episode ?? parsed.episode,
          filePath: fullPath,
          title: mediaProbe.embeddedTitle,
          subtitles: createSubtitleRecords(directory, matchingSubtitleFilesForVideo(directory, entry.name)),
          localMetadata: mediaProbe.localMetadata,
        });
      }
    } catch (error) {
      console.error('scanDir error:', error);
    }
  };

  scanDirectory(folderPath);
  return files.sort((left, right) => left.season !== right.season
    ? left.season - right.season
    : left.episode - right.episode);
}

export function extractSeasons(
  folderPath: string,
  folderName: string,
  probe: MediaFileProbe = EMPTY_MEDIA_FILE_PROBE,
): Array<{ number: number; title: string; episodeCount: number }> {
  const seasons: Array<{ number: number; title: string; episodeCount: number }> = [];
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    const videoFiles = entries.filter((entry) => !entry.isDirectory() && isVideoFileName(entry.name));

    const seasonDirectories = directories.filter((directory) => isSeasonDirectoryName(directory.name));
    if (seasonDirectories.length > 0) {
      for (const directory of seasonDirectories) {
        const number = seasonNumberFromDirectoryName(directory.name) ?? 1;
        const directoryPath = path.join(folderPath, directory.name);
        const episodeCount = scanEpisodeFiles(directoryPath, probe).length
          || fs.readdirSync(directoryPath).filter(isVideoFileName).length;
        seasons.push({ number, title: seasonTitle(number, directory.name), episodeCount });
      }
    } else {
      const match = folderName.match(/[Ss](\d{1,2})/);
      const fallbackSeason = match ? parseInt(match[1], 10) : 1;
      const episodeFiles = scanEpisodeFiles(folderPath, probe);
      const grouped = new Map<number, number>();
      episodeFiles.forEach((file) => grouped.set(file.season, (grouped.get(file.season) || 0) + 1));
      if (grouped.size > 0) {
        grouped.forEach((episodeCount, number) => {
          seasons.push({ number, title: seasonTitle(number), episodeCount });
        });
      } else {
        seasons.push({ number: fallbackSeason, title: `Season ${fallbackSeason}`, episodeCount: videoFiles.length });
      }
    }
  } catch (error) {
    console.error('extractSeasons error:', error);
  }
  return seasons.sort((left, right) => left.number - right.number);
}

async function matchingSubtitleFilesForVideoAsync(directory: string, videoFileName: string): Promise<string[]> {
  const baseName = path.basename(videoFileName, path.extname(videoFileName)).toLowerCase();
  return (await fs.promises.readdir(directory, { withFileTypes: true }))
    .filter((entry) => !entry.isDirectory() && isSubtitleFileName(entry.name))
    .map((entry) => entry.name)
    .filter((fileName) => path.basename(fileName, path.extname(fileName)).toLowerCase().startsWith(baseName));
}

export async function scanEpisodeFilesAsync(
  folderPath: string,
  probe: AsyncMediaFileProbe,
): Promise<EpisodeFile[]> {
  type EpisodeCandidate = { directory: string; fileName: string; fullPath: string };
  const candidates: EpisodeCandidate[] = [];

  const collectVideoFiles = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_EPISODE_DIRECTORIES.has(entry.name.toLowerCase())) await collectVideoFiles(fullPath);
        continue;
      }
      if (!isVideoFileName(entry.name)) continue;
      candidates.push({ directory, fileName: entry.name, fullPath });
    }
  };

  await collectVideoFiles(folderPath);
  const files = await mapWithConcurrency(
    candidates,
    LIBRARY_PROBE_CONCURRENCY,
    async ({ directory, fileName, fullPath }): Promise<EpisodeFile | null> => {
      const mediaProbe = await probe(fullPath);
      if (!mediaProbe.localMetadata?.videoCodec) return null;
      const folderSeason = seasonFromRelativePath(folderPath, directory);
      const parsed = parseEpisodeFileName(fileName, mediaProbe.season ?? folderSeason ?? 1);
      if (!parsed) return null;
      const season = folderSeason === 0
        ? 0
        : mediaProbe.season ?? parsed.season ?? folderSeason ?? 1;
      return {
        season,
        episode: mediaProbe.episode ?? parsed.episode,
        filePath: fullPath,
        title: mediaProbe.embeddedTitle,
        subtitles: createSubtitleRecords(directory, await matchingSubtitleFilesForVideoAsync(directory, fileName)),
        localMetadata: mediaProbe.localMetadata,
      };
    },
  );

  return files.filter((file): file is EpisodeFile => file !== null).sort((left, right) => left.season !== right.season
    ? left.season - right.season
    : left.episode - right.episode);
}

export async function extractSeasonsAsync(
  folderPath: string,
  folderName: string,
  probe: AsyncMediaFileProbe,
  knownEpisodeFiles?: EpisodeFile[],
): Promise<Array<{ number: number; title: string; episodeCount: number }>> {
  const seasons: Array<{ number: number; title: string; episodeCount: number }> = [];
  const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  const videoFiles = entries.filter((entry) => !entry.isDirectory() && isVideoFileName(entry.name));

  const seasonDirectories = directories.filter((directory) => isSeasonDirectoryName(directory.name));
  if (seasonDirectories.length > 0) {
    for (const directory of seasonDirectories) {
      const number = seasonNumberFromDirectoryName(directory.name) ?? 1;
      const directoryPath = path.join(folderPath, directory.name);
      const knownEpisodeCount = knownEpisodeFiles?.filter((file) => {
        const relativePath = path.relative(directoryPath, file.filePath);
        return relativePath !== ''
          && relativePath !== '..'
          && !relativePath.startsWith(`..${path.sep}`)
          && !path.isAbsolute(relativePath);
      }).length;
      const episodeCount = (knownEpisodeCount ?? (await scanEpisodeFilesAsync(directoryPath, probe)).length)
        || (await fs.promises.readdir(directoryPath)).filter(isVideoFileName).length;
      seasons.push({ number, title: seasonTitle(number, directory.name), episodeCount });
    }
  } else {
    const match = folderName.match(/[Ss](\d{1,2})/);
    const fallbackSeason = match ? parseInt(match[1], 10) : 1;
    const episodeFiles = knownEpisodeFiles ?? await scanEpisodeFilesAsync(folderPath, probe);
    const grouped = new Map<number, number>();
    episodeFiles.forEach((file) => grouped.set(file.season, (grouped.get(file.season) || 0) + 1));
    if (grouped.size > 0) {
      grouped.forEach((episodeCount, number) => {
        seasons.push({ number, title: seasonTitle(number), episodeCount });
      });
    } else {
      seasons.push({ number: fallbackSeason, title: `Season ${fallbackSeason}`, episodeCount: videoFiles.length });
    }
  }

  return seasons.sort((left, right) => left.number - right.number);
}

export function createLibraryScanFiles(probe: MediaFileProbe) {
  return {
    extractSeasons: (folderPath: string, folderName: string) => extractSeasons(folderPath, folderName, probe),
    scanEpisodeFiles: (folderPath: string) => scanEpisodeFiles(folderPath, probe),
  };
}

export function createLibraryScanFilesAsync(probe: AsyncMediaFileProbe) {
  const boundedProbe = getBoundedLibraryProbe(probe);
  return {
    extractSeasons: (folderPath: string, folderName: string, episodeFiles?: EpisodeFile[]) => (
      extractSeasonsAsync(folderPath, folderName, boundedProbe, episodeFiles)
    ),
    scanEpisodeFiles: (folderPath: string) => scanEpisodeFilesAsync(folderPath, boundedProbe),
  };
}
