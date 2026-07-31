import type { EpisodeFile, EpisodeMeta } from './types';

export function episodeFileKey(season: number, episode: number): string {
  return `${season}:${episode}`;
}

export function indexEpisodeFiles(episodeFiles: EpisodeFile[]): Map<string, EpisodeFile> {
  return new Map(
    episodeFiles.map((file) => [episodeFileKey(file.season, file.episode), file] as const),
  );
}

export function groupEpisodesBySeason(episodes: EpisodeMeta[]): Record<number, EpisodeMeta[]> {
  return episodes.reduce((grouped, episode) => {
    if (!grouped[episode.season]) grouped[episode.season] = [];
    grouped[episode.season].push(episode);
    return grouped;
  }, {} as Record<number, EpisodeMeta[]>);
}

export function sortedSeasonNumbers(groupedEpisodes: Record<number, EpisodeMeta[]>): number[] {
  return Object.keys(groupedEpisodes).map(Number).sort((left, right) => left - right);
}

export function sortedPlayableEpisodeFiles(episodeFiles: EpisodeFile[]): EpisodeFile[] {
  return episodeFiles
    .filter((episode) => Boolean(episode.filePath))
    .slice()
    .sort((left, right) => left.season - right.season || left.episode - right.episode);
}

export function nextPlayableEpisodeFile(
  episodeFiles: EpisodeFile[],
  currentSeason: number,
  currentEpisode: number,
  currentFilePath: string,
): EpisodeFile | null {
  const nextByEpisodeNumber = episodeFiles.find((episode) =>
    episode.season > currentSeason
    || (episode.season === currentSeason && episode.episode > currentEpisode),
  );
  if (nextByEpisodeNumber) return nextByEpisodeNumber;

  // Playback sources can use a normalized URL while the index retains the
  // local path. Path matching remains a fallback, not the navigation key.
  const currentIndex = episodeFiles.findIndex((episode) => episode.filePath === currentFilePath);
  if (currentIndex < 0) return null;
  return episodeFiles.slice(currentIndex + 1).find((episode) => episode.filePath !== currentFilePath) || null;
}
