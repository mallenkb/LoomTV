import type {
  EpisodeFile,
  LibraryPayload,
  LocalMediaDetails,
  MediaItem,
  MobileLibraryFilter,
  MobileSearchScope,
  PlayTarget,
  StoredProgress,
} from './mobileDomain';

const TRANSCODE_EXTENSIONS = ['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', '3gp', 'ts'];
const DIRECT_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm'];

export function filePathFromUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.searchParams.get('resourceId') || '';
  } catch {
    return /^\d{6}$/.test(value) ? value : '';
  }
}

export function streamPathFor(item: MediaItem): string {
  if (item.type === 'movie' || !item.episodeFiles?.length) return item.filePath;

  let earliestEpisode = item.episodeFiles[0];
  for (let index = 1; index < item.episodeFiles.length; index += 1) {
    const episode = item.episodeFiles[index];
    if (episode.season < earliestEpisode.season
      || (episode.season === earliestEpisode.season && episode.episode < earliestEpisode.episode)) {
      earliestEpisode = episode;
    }
  }
  return earliestEpisode.filePath;
}

export function needsTranscode(streamPath: string, meta?: LocalMediaDetails): boolean {
  const filePath = filePathFromUrl(streamPath);
  const extension = filePath.split('.').pop()?.toLowerCase() || '';
  if ((meta?.container || '').toLowerCase().includes('matroska') || TRANSCODE_EXTENSIONS.includes(extension)) return true;
  const audioCodec = (meta?.audioCodec || '').toLowerCase();
  return Boolean(audioCodec && !DIRECT_AUDIO_CODECS.some((codec) => audioCodec.includes(codec)));
}

export function shouldTranscode(item: MediaItem): boolean {
  return needsTranscode(streamPathFor(item), item.localMetadata);
}

export function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

export function sortedEpisodes(item: MediaItem): EpisodeFile[] {
  return (item.episodeFiles || []).slice().sort((a, b) => a.season - b.season || a.episode - b.episode);
}

export function progressStateFor(progress: Record<string, StoredProgress>, streamPath: string, durationHint = 0) {
  const stored = progress[filePathFromUrl(streamPath)] || progress[streamPath];
  const duration = stored?.duration || durationHint || 0;
  const position = Math.min(stored?.position || 0, duration || stored?.position || 0);
  const fraction = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const watched = Boolean(stored?.watched) || fraction >= 0.9;
  return { position, duration, fraction: watched ? 1 : fraction, watched, inProgress: position > 10 && !watched };
}

export function episodePlayTarget(
  item: MediaItem,
  episodeFile: EpisodeFile,
  progress?: Record<string, StoredProgress>,
): PlayTarget {
  const name = episodeFile.title || `Episode ${episodeFile.episode}`;
  const state = progress
    ? progressStateFor(progress, episodeFile.filePath, episodeFile.localMetadata?.durationSeconds)
    : null;
  return {
    title: name,
    subtitle: `${episodeCode(episodeFile.season, episodeFile.episode)} · ${item.title}`,
    streamPath: episodeFile.filePath,
    transcode: needsTranscode(episodeFile.filePath, episodeFile.localMetadata),
    localMetadata: episodeFile.localMetadata,
    subtitles: episodeFile.subtitles || item.subtitles,
    startPosition: state?.inProgress ? state.position : 0,
    mediaId: item.id,
    mediaType: item.type,
    season: episodeFile.season,
    episode: episodeFile.episode,
    thumbnail: episodeFile.still || episodeFile.thumbnail || item.backdrop || item.poster,
    thumbnailCandidates: [
      episodeFile.still,
      episodeFile.thumbnail,
      item.backdrop,
      ...(item.backdropCandidates || []),
      item.poster,
      ...(item.posterCandidates || []),
    ].filter(Boolean) as string[],
  };
}

export function playTargetForItem(item: MediaItem, progress: Record<string, StoredProgress>): PlayTarget {
  const episodes = sortedEpisodes(item);
  if (item.type !== 'movie' && episodes.length > 0) {
    const nextUp = episodes.find((episode) => (
      !progressStateFor(progress, episode.filePath, episode.localMetadata?.durationSeconds).watched
    )) || episodes[0];
    return episodePlayTarget(item, nextUp, progress);
  }

  const streamPath = streamPathFor(item);
  const state = progressStateFor(progress, streamPath, item.localMetadata?.durationSeconds);
  return {
    title: item.title,
    subtitle: item.year ? String(item.year) : undefined,
    streamPath,
    transcode: needsTranscode(streamPath, item.localMetadata),
    localMetadata: item.localMetadata,
    subtitles: item.subtitles,
    startPosition: state.inProgress ? state.position : 0,
    mediaId: item.id,
    mediaType: item.type,
    thumbnail: item.poster || item.backdrop,
    thumbnailCandidates: [
      item.poster,
      ...(item.posterCandidates || []),
      item.backdrop,
      ...(item.backdropCandidates || []),
    ].filter(Boolean) as string[],
  };
}

export function libraryWithPlayedItem(library: LibraryPayload, streamPath: string, playedAt: number): LibraryPayload {
  const filePath = filePathFromUrl(streamPath);
  const markItems = (items?: MediaItem[]) => items?.map((item) => {
    const itemPath = filePathFromUrl(item.filePath);
    const episodeMatch = item.episodeFiles?.some((episode) => filePathFromUrl(episode.filePath) === filePath);
    return itemPath === filePath || episodeMatch ? { ...item, lastPlayed: playedAt } : item;
  });
  return {
    ...library,
    movies: markItems(library.movies),
    tvShows: markItems(library.tvShows),
    animeShows: markItems(library.animeShows),
  };
}

export function collections(library: LibraryPayload) {
  return {
    anime: library.animeShows || [],
    tv: library.tvShows || [],
    movies: library.movies || [],
    others: [] as MediaItem[],
  };
}

export function allItems(library: LibraryPayload): MediaItem[] {
  const grouped = collections(library);
  return [...grouped.anime, ...grouped.tv, ...grouped.movies, ...grouped.others];
}

export function matchesQuery(item: MediaItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (item.title.toLowerCase().includes(needle)) return true;
  if (item.year && String(item.year).includes(needle)) return true;
  if (item.summary?.toLowerCase().includes(needle)) return true;
  return item.genres?.some((genre) => genre.toLowerCase().includes(needle)) ?? false;
}

export function matchesMobileSearchScope(item: MediaItem, scope: MobileSearchScope): boolean {
  if (scope === 'all') return true;
  const genre = scope.slice('genre:'.length).replace('-', ' ');
  return (item.genres || []).some((itemGenre) => itemGenre.toLowerCase().includes(genre));
}

export function matchesMobileLibraryFilter(
  item: MediaItem,
  filter: MobileLibraryFilter,
  progress: Record<string, StoredProgress>,
): boolean {
  if (filter === 'all') return true;
  if (item.type === 'movie') {
    const state = progressStateFor(progress, item.filePath, item.localMetadata?.durationSeconds);
    if (filter === 'in-progress') return state.inProgress;
    if (filter === 'watched') return state.watched;
    return !state.inProgress && !state.watched;
  }
  const episodes = item.episodeFiles || [];
  let watchedCount = 0;
  let inProgress = false;
  for (const episode of episodes) {
    const state = progressStateFor(progress, episode.filePath, episode.localMetadata?.durationSeconds);
    if (state.watched) watchedCount += 1;
    if (state.inProgress) inProgress = true;
  }
  const watched = episodes.length > 0 && watchedCount === episodes.length;
  const partiallyWatched = watchedCount > 0;
  if (filter === 'in-progress') return inProgress;
  if (filter === 'watched') return watched;
  return !inProgress && !partiallyWatched;
}
