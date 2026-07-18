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
  return item.type === 'movie'
    ? item.filePath
    : item.episodeFiles?.slice().sort((a, b) => a.season - b.season || a.episode - b.episode)[0]?.filePath || item.filePath;
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
  return [item.title, item.year ? String(item.year) : '', ...(item.genres || []), item.summary || '']
    .some((value) => value.toLowerCase().includes(needle));
}

export function matchesMobileSearchScope(item: MediaItem, scope: MobileSearchScope): boolean {
  if (scope === 'all') return true;
  const genre = scope.replace('genre:', '').replace('-', ' ');
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
  const episodeStates = (item.episodeFiles || []).map((episode) => (
    progressStateFor(progress, episode.filePath, episode.localMetadata?.durationSeconds)
  ));
  const watchedCount = episodeStates.filter((state) => state.watched).length;
  const inProgress = episodeStates.some((state) => state.inProgress);
  const watched = episodeStates.length > 0 && watchedCount === episodeStates.length;
  const partiallyWatched = watchedCount > 0;
  if (filter === 'in-progress') return inProgress;
  if (filter === 'watched') return watched;
  return !inProgress && !partiallyWatched;
}
