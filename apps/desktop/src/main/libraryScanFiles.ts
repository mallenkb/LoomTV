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

export type MediaFileProbe = (filePath: string) => ProbeMediaFileResult;
const EMPTY_MEDIA_FILE_PROBE: MediaFileProbe = () => ({});

const SKIPPED_EPISODE_DIRECTORIES = new Set([
  'nc', 'nced', 'ncop', 'bonus', 'extras', 'extra', 'special', 'specials',
  'behind the scenes', 'featurettes', 'interviews', 'scenes', 'shorts',
  'trailers', 'featurette', 'sample', 'samples', 'subs', 'subtitles',
]);

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

function seasonFromRelativePath(root: string, directory: string): number | null {
  const relativeParts = path.relative(root, directory).split(path.sep).filter(Boolean).reverse();
  for (const part of relativeParts) {
    const match = part.match(/(?:season|series|s)\s*0*(\d{1,2})/i);
    if (match) return parseInt(match[1], 10);
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
        const parsed = parseEpisodeFileName(entry.name, mediaProbe.season || seasonFromRelativePath(folderPath, directory) || 1);
        if (!parsed) continue;
        files.push({
          season: mediaProbe.season || parsed.season,
          episode: mediaProbe.episode || parsed.episode,
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

    if (directories.some((directory) => /season/i.test(directory.name))) {
      for (const directory of directories) {
        const match = directory.name.match(/season\s*(\d+)/i);
        const number = match ? parseInt(match[1], 10) : 1;
        const directoryPath = path.join(folderPath, directory.name);
        const episodeCount = scanEpisodeFiles(directoryPath, probe).length
          || fs.readdirSync(directoryPath).filter(isVideoFileName).length;
        seasons.push({ number, title: directory.name, episodeCount });
      }
    } else {
      const match = folderName.match(/[Ss](\d{1,2})/);
      const fallbackSeason = match ? parseInt(match[1], 10) : 1;
      const episodeFiles = scanEpisodeFiles(folderPath, probe);
      const grouped = new Map<number, number>();
      episodeFiles.forEach((file) => grouped.set(file.season, (grouped.get(file.season) || 0) + 1));
      if (grouped.size > 0) {
        grouped.forEach((episodeCount, number) => {
          seasons.push({ number, title: `Season ${String(number).padStart(2, '0')}`, episodeCount });
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

export function createLibraryScanFiles(probe: MediaFileProbe) {
  return {
    extractSeasons: (folderPath: string, folderName: string) => extractSeasons(folderPath, folderName, probe),
    scanEpisodeFiles: (folderPath: string) => scanEpisodeFiles(folderPath, probe),
  };
}
