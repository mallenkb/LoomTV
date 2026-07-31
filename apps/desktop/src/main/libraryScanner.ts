import fs from 'node:fs';
import path from 'node:path';
import { isSubtitleFileName, isVideoFileName } from './fileClassification.ts';
import { detectLibraryFolderKind } from './libraryFolders.ts';
import { createMediaItemId } from './libraryItemHelpers.ts';
import type { ProbeMediaFileResult } from './mediaProbeFile.ts';
import {
  getBoundedLibraryProbe,
  LIBRARY_ITEM_CONCURRENCY,
  processWithConcurrencyInOrder,
  runBoundedLibraryItemTask,
} from './libraryScanConcurrency.ts';
import { cleanMediaTitle } from './metadata/helpers.ts';
import type { EpisodeFile, MediaItem } from './metadata/types.ts';
import {
  downloadMissingOpenSubtitlesForVideo,
  openSubtitlesIsConfigured,
  type OpenSubtitlesScanOptions,
} from './openSubtitles.ts';
import {
  createSubtitleRecords,
  isLikelyAnimePath,
  isTVPattern,
  shouldTreatAsTV,
} from './scanClassification.ts';

export type ScanFolderKind = 'movies' | 'tv' | 'anime';

export interface ScanContext {
  omdbApiKey?: string;
  tmdbApiKey?: string;
  fanartApiKey?: string;
  openSubtitles?: OpenSubtitlesScanOptions;
  folderKind?: ScanFolderKind;
}

type SubtitleRecord = { lang: string; label: string; url: string };

export type BuildTVItemRequest = {
  fullPath: string;
  entryName: string;
  id: string;
  subtitles: SubtitleRecord[];
  year: number;
  cleanTitle: string;
  omdbApiKey?: string;
  itemType?: 'tv' | 'anime';
  tmdbApiKey?: string;
  fanartApiKey?: string;
  openSubtitles?: OpenSubtitlesScanOptions;
};

export type BuildMovieItemRequest = {
  fullPath: string;
  fileName: string;
  titleFallback: string;
  subtitles: SubtitleRecord[];
  year: number;
  omdbApiKey?: string;
  tmdbApiKey?: string;
  fanartApiKey?: string;
  forcedType?: 'movie' | 'tv' | 'anime';
};

type BuildTVItem = (request: BuildTVItemRequest) => Promise<MediaItem | null>;
type BuildMovieItem = (request: BuildMovieItemRequest) => Promise<MediaItem>;

export type LibraryScannerDependencies = {
  buildMovieItemFromFile: BuildMovieItem;
  buildTVItemFromFolder: BuildTVItem;
  probeMediaFile: (filePath: string) => Promise<ProbeMediaFileResult>;
  scanEpisodeFiles: (folderPath: string) => Promise<EpisodeFile[]>;
  shouldSplitContainerFolder: (folderPath: string, folderName: string, subDirectories: fs.Dirent[]) => Promise<boolean>;
};

export function createLibraryScanner(deps: LibraryScannerDependencies) {
  const {
    buildMovieItemFromFile: unboundedBuildMovieItemFromFile,
    buildTVItemFromFolder: unboundedBuildTVItemFromFolder,
    probeMediaFile: unboundedProbeMediaFile,
    scanEpisodeFiles,
    shouldSplitContainerFolder,
  } = deps;
  const probeMediaFile = getBoundedLibraryProbe(unboundedProbeMediaFile);
  const buildMovieItemFromFile: BuildMovieItem = (request) => (
    runBoundedLibraryItemTask(() => unboundedBuildMovieItemFromFile(request))
  );
  const buildTVItemFromFolder: BuildTVItem = (request) => (
    runBoundedLibraryItemTask(() => unboundedBuildTVItemFromFolder(request))
  );

  async function subtitleFilesInDirectory(folderPath: string): Promise<string[]> {
    return (await fs.promises.readdir(folderPath, { withFileTypes: true }))
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name)
      .filter(isSubtitleFileName);
  }

  async function downloadOpenSubtitlesForVideos(folderPath: string, videoFiles: string[], ctx: ScanContext): Promise<void> {
    if (!openSubtitlesIsConfigured(ctx.openSubtitles) || videoFiles.length === 0) return;

    for (const videoFile of videoFiles) {
      const videoPath = path.join(folderPath, videoFile);
      const results = await downloadMissingOpenSubtitlesForVideo(videoPath, ctx.openSubtitles);
      results
        .filter((result) => result.status === 'error')
        .forEach((result) => console.warn('[OpenSubtitles]', result.videoPath, result.message));
    }
  }

async function scanDirectoryAsItem(folderPath: string, ctx: ScanContext): Promise<MediaItem | null> {
  const dirEntries = await fs.promises.readdir(folderPath, { withFileTypes: true });

  const folderName = path.basename(folderPath);
  const videoFiles = dirEntries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => entry.name)
    .filter(isVideoFileName);
  await downloadOpenSubtitlesForVideos(folderPath, videoFiles, ctx);
  const subtitleFiles = await subtitleFilesInDirectory(folderPath);
  const subDirs = dirEntries.filter((entry) => entry.isDirectory());
  const hasSeasonDirs = subDirs.some((entry) => /season|series/i.test(entry.name));
  const nestedEpisodeFiles = videoFiles.length === 0 && !hasSeasonDirs ? await scanEpisodeFiles(folderPath) : [];
  const detectedFolderKind = detectLibraryFolderKind(folderPath);

  if (ctx.folderKind && detectedFolderKind) return null;
  if (ctx.folderKind === 'movies' && videoFiles.length > 1) return null;

  if (videoFiles.length === 0 && !hasSeasonDirs && nestedEpisodeFiles.length === 0) return null;

  const parsedFolder = cleanMediaTitle(folderName);
  const subtitles = createSubtitleRecords(folderPath, subtitleFiles);
  const id = createMediaItemId(folderPath);
  const representativeProbe = videoFiles[0] ? await probeMediaFile(path.join(folderPath, videoFiles[0])) : undefined;
  const isTV = nestedEpisodeFiles.length > 0
    || shouldTreatAsTV(folderName, videoFiles, hasSeasonDirs, representativeProbe);

  if (videoFiles.length === 0 && !hasSeasonDirs && nestedEpisodeFiles.length > 0 && await shouldSplitContainerFolder(folderPath, folderName, subDirs)) {
    return null;
  }

  if (ctx.folderKind === 'movies') {
    if (videoFiles.length === 0) return null;
    return buildMovieItemFromFile({
      fullPath: path.join(folderPath, videoFiles[0]),
      fileName: videoFiles[0],
      titleFallback: parsedFolder.title,
      subtitles,
      year: parsedFolder.year,
      omdbApiKey: ctx.omdbApiKey,
      tmdbApiKey: ctx.tmdbApiKey,
      fanartApiKey: ctx.fanartApiKey,
      forcedType: 'movie',
    });
  }

  if ((ctx.folderKind === 'tv' || ctx.folderKind === 'anime') && !isTV && videoFiles.length > 0) {
    return buildMovieItemFromFile({
      fullPath: path.join(folderPath, videoFiles[0]),
      fileName: videoFiles[0],
      titleFallback: parsedFolder.title,
      subtitles,
      year: parsedFolder.year,
      omdbApiKey: ctx.omdbApiKey,
      tmdbApiKey: ctx.tmdbApiKey,
      fanartApiKey: ctx.fanartApiKey,
      forcedType: ctx.folderKind === 'anime' ? 'anime' : 'tv',
    });
  }

  if (isTV || ctx.folderKind === 'tv' || ctx.folderKind === 'anime') {
    return buildTVItemFromFolder({
      fullPath: folderPath,
      entryName: folderName,
      id,
      subtitles,
      year: parsedFolder.year,
      cleanTitle: parsedFolder.title,
      omdbApiKey: ctx.omdbApiKey,
      itemType: ctx.folderKind === 'anime' || isLikelyAnimePath(folderPath, parsedFolder.title) ? 'anime' : 'tv',
      tmdbApiKey: ctx.tmdbApiKey,
      fanartApiKey: ctx.fanartApiKey,
      openSubtitles: ctx.openSubtitles,
    });
  }

  return buildMovieItemFromFile({
    fullPath: path.join(folderPath, videoFiles[0]),
    fileName: videoFiles[0],
    titleFallback: parsedFolder.title,
    subtitles,
    year: parsedFolder.year,
    omdbApiKey: ctx.omdbApiKey,
    tmdbApiKey: ctx.tmdbApiKey,
    fanartApiKey: ctx.fanartApiKey,
    forcedType: ctx.folderKind === 'anime' ? 'anime' : undefined,
  });
}

async function scanFolder(
  folderPath: string,
  ctx: ScanContext,
  onItems?: (items: MediaItem[]) => void | Promise<void>,
): Promise<MediaItem[]> {
  const items: MediaItem[] = [];

  const addItems = async (nextItems: MediaItem[]) => {
    items.push(...nextItems);
    if (nextItems.length > 0) await onItems?.(nextItems);
  };

  try {
    const rootEntries = await fs.promises.readdir(folderPath, { withFileTypes: true });

    const rootVideoFiles = rootEntries
      .filter((entry) => !entry.isDirectory() && isVideoFileName(entry.name))
      .map((entry) => entry.name);
    await downloadOpenSubtitlesForVideos(folderPath, rootVideoFiles, ctx);
    const rootSubtitleFiles = await subtitleFilesInDirectory(folderPath);

    await processWithConcurrencyInOrder(
        rootVideoFiles,
        LIBRARY_ITEM_CONCURRENCY,
        async (videoFile): Promise<MediaItem | null> => {
          const fullVideoPath = path.join(folderPath, videoFile);
          const probe = await probeMediaFile(fullVideoPath);
          const isTVFile = shouldTreatAsTV(videoFile, [videoFile], false, probe);
          if (ctx.folderKind !== 'movies' && isTVFile) return null;

          const baseName = path.basename(videoFile, path.extname(videoFile));
          const matchingSubtitles = rootSubtitleFiles.filter((subtitle) =>
            path.basename(subtitle, path.extname(subtitle)).startsWith(baseName),
          );
          const forcedMovieType = ctx.folderKind === 'movies'
            ? 'movie'
            : ctx.folderKind === 'anime'
              ? 'anime'
              : ctx.folderKind === 'tv'
                ? 'tv'
                : undefined;
          const parsedVideo = cleanMediaTitle(videoFile);
          return buildMovieItemFromFile({
            fullPath: fullVideoPath,
            fileName: videoFile,
            titleFallback: parsedVideo.title,
            subtitles: createSubtitleRecords(folderPath, matchingSubtitles),
            year: parsedVideo.year,
            omdbApiKey: ctx.omdbApiKey,
            tmdbApiKey: ctx.tmdbApiKey,
            fanartApiKey: ctx.fanartApiKey,
            forcedType: forcedMovieType,
          });
        },
        async (item) => {
          if (item) await addItems([item]);
        },
    );

    const rootDirectories = rootEntries.filter((entry) => entry.isDirectory());
    await processWithConcurrencyInOrder(
        rootDirectories,
        LIBRARY_ITEM_CONCURRENCY,
        async (entry): Promise<MediaItem[]> => {
          const fullPath = path.join(folderPath, entry.name);
          const dirEntries = await fs.promises.readdir(fullPath, { withFileTypes: true });
          const videoFiles = dirEntries
            .filter((directoryEntry) => !directoryEntry.isDirectory())
            .map((directoryEntry) => directoryEntry.name)
            .filter(isVideoFileName);

          await downloadOpenSubtitlesForVideos(fullPath, videoFiles, ctx);
          const subtitleFiles = await subtitleFilesInDirectory(fullPath);
          const subDirs = dirEntries.filter((directoryEntry) => directoryEntry.isDirectory());
          const hasSeasonDirs = subDirs.some((directoryEntry) => /season|series/i.test(directoryEntry.name));

          // Container folder (e.g. "TV Shows/", "Anime/") - recurse.
          if (videoFiles.length === 0 && subDirs.length > 0 && !hasSeasonDirs) {
            const nestedEpisodeFiles = await scanEpisodeFiles(fullPath);
            if (ctx.folderKind !== 'movies' && nestedEpisodeFiles.length > 0) {
              const parsedFolder = cleanMediaTitle(entry.name);
              const subtitles = createSubtitleRecords(fullPath, subtitleFiles);
              if (!await shouldSplitContainerFolder(fullPath, entry.name, subDirs)) {
                const tvItem = await buildTVItemFromFolder({
                  fullPath,
                  entryName: entry.name,
                  id: createMediaItemId(fullPath),
                  subtitles,
                  year: parsedFolder.year,
                  cleanTitle: parsedFolder.title,
                  omdbApiKey: ctx.omdbApiKey,
                  itemType: ctx.folderKind === 'anime' || isLikelyAnimePath(fullPath, parsedFolder.title) ? 'anime' : 'tv',
                  tmdbApiKey: ctx.tmdbApiKey,
                  fanartApiKey: ctx.fanartApiKey,
                  openSubtitles: ctx.openSubtitles,
                });
                return tvItem ? [tvItem] : [];
              }
            }
            return scanFolder(fullPath, ctx);
          }

          const isTV = ctx.folderKind === 'tv'
            || ctx.folderKind === 'anime'
            || (ctx.folderKind !== 'movies' && (hasSeasonDirs || isTVPattern(entry.name, videoFiles)));
          const parsedFolder = cleanMediaTitle(entry.name);
          const subtitles = createSubtitleRecords(fullPath, subtitleFiles);

          if (isTV) {
            const tvItem = await buildTVItemFromFolder({
              fullPath,
              entryName: entry.name,
              id: createMediaItemId(fullPath),
              subtitles,
              year: parsedFolder.year,
              cleanTitle: parsedFolder.title,
              omdbApiKey: ctx.omdbApiKey,
              itemType: ctx.folderKind === 'anime' || isLikelyAnimePath(fullPath, parsedFolder.title) ? 'anime' : 'tv',
              tmdbApiKey: ctx.tmdbApiKey,
              fanartApiKey: ctx.fanartApiKey,
              openSubtitles: ctx.openSubtitles,
            });
            return tvItem ? [tvItem] : [];
          }

          if (videoFiles.length === 0) return [];
          return [await buildMovieItemFromFile({
            fullPath: path.join(fullPath, videoFiles[0]),
            fileName: videoFiles[0],
            titleFallback: parsedFolder.title,
            subtitles,
            year: parsedFolder.year,
            omdbApiKey: ctx.omdbApiKey,
            tmdbApiKey: ctx.tmdbApiKey,
            fanartApiKey: ctx.fanartApiKey,
            forcedType: ctx.folderKind === 'movies' ? 'movie' : undefined,
          })];
        },
        async (nextItems) => {
          for (const item of nextItems) await addItems([item]);
        },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to scan library folder "${folderPath}": ${message}`, { cause: error });
  }

  return items;
}

  return { scanDirectoryAsItem, scanFolder };
}
