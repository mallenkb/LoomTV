import fs from 'node:fs';
import path from 'node:path';
import { isImageFileName, normalizedArtworkBaseName } from './fileClassification';
import type { ProbeMediaFileResult } from './mediaProbeFile';

export interface ArtworkFindersDeps {
  getLocalImageUrl: (filePath: string) => string;
  getEmbeddedThumbnailUrl: (filePath: string, streamIndex?: number) => string;
}

export function createArtworkFinders(deps: ArtworkFindersDeps) {
  const { getLocalImageUrl, getEmbeddedThumbnailUrl } = deps;

  function findLocalArtworkFile(folderPath: string, preferredBaseNames: string[]): string {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folderPath, { withFileTypes: true });
    } catch {
      return '';
    }

    const preferred = preferredBaseNames.map((name) => normalizedArtworkBaseName(name)).filter(Boolean);
    const candidates = entries
      .filter((entry) => !entry.isDirectory() && isImageFileName(entry.name))
      .map((entry) => {
        const baseName = normalizedArtworkBaseName(entry.name);
        const exactIndex = preferred.findIndex((name) => baseName === name);
        const prefixIndex = preferred.findIndex((name) => baseName.startsWith(`${name} `));
        const containsIndex = preferred.findIndex((name) => baseName.includes(name));
        const score = exactIndex >= 0
          ? exactIndex
          : prefixIndex >= 0
            ? 50 + prefixIndex
            : containsIndex >= 0
              ? 100 + containsIndex
              : 1000;
        return { name: entry.name, score };
      })
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

    return candidates[0] ? path.join(folderPath, candidates[0].name) : '';
  }

  function getLocalFolderArtworkUrl(folderPath: string, kind: 'poster' | 'backdrop'): string {
    const preferred = kind === 'poster'
      ? ['poster', 'folder', 'cover', 'thumbnail', 'thumb', 'default', 'movie']
      : ['backdrop', 'fanart', 'background', 'landscape', 'banner'];
    const imagePath = findLocalArtworkFile(folderPath, preferred);
    return imagePath ? getLocalImageUrl(imagePath) : '';
  }

  function getLocalMovieArtworkUrl(videoPath: string, kind: 'poster' | 'backdrop'): string {
    const folderPath = path.dirname(videoPath);
    const baseName = path.basename(videoPath, path.extname(videoPath));
    const preferred = kind === 'poster'
      ? [baseName, `${baseName} poster`, 'poster', 'folder', 'cover', 'thumbnail', 'thumb', 'default', 'movie']
      : [`${baseName} backdrop`, `${baseName} fanart`, 'backdrop', 'fanart', 'background', 'landscape', 'banner'];
    const imagePath = findLocalArtworkFile(folderPath, preferred);
    return imagePath ? getLocalImageUrl(imagePath) : '';
  }

  function getEmbeddedArtworkUrl(filePath: string, probe: ProbeMediaFileResult): string {
    return probe.embeddedThumbnailStreamIndex !== undefined
      ? getEmbeddedThumbnailUrl(filePath, probe.embeddedThumbnailStreamIndex)
      : '';
  }

  function hasPlayableVideoTrack(probe: ProbeMediaFileResult): boolean {
    return Boolean(probe.localMetadata?.videoCodec);
  }

  return {
    findLocalArtworkFile,
    getLocalFolderArtworkUrl,
    getLocalMovieArtworkUrl,
    getEmbeddedArtworkUrl,
    hasPlayableVideoTrack,
  };
}
