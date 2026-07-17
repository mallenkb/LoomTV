import type { EpisodeFile } from './types';

export function episodeFileKey(season: number, episode: number): string {
  return `${season}:${episode}`;
}

export function indexEpisodeFiles(episodeFiles: EpisodeFile[]): Map<string, EpisodeFile> {
  return new Map(
    episodeFiles.map((file) => [episodeFileKey(file.season, file.episode), file] as const),
  );
}
