import type { LibraryData, LibraryFolderGroups, LibraryFolderStatus } from './appContracts.ts';
import { durableArtworkSource, durableArtworkSources } from './artworkSources.ts';
import type { MediaItem } from './metadata/types.ts';
import type {
  LibraryCard,
  LibraryIndexPayload,
  LibraryItemDetailsPayload,
  LibraryPlaybackReference,
} from '../shared/desktopProtocol.ts';

type SubtitleRecord = NonNullable<MediaItem['subtitles']>[number];

export type RemoteProfileIdentity = {
  deviceId: string;
  profileId: string;
  selectionRevision: number;
};

export type LibraryProjectionDependencies = {
  artworkDeliveryUrl: (source?: string | null) => string;
  artworkDeliveryUrls: (sources?: string[]) => string[];
  remoteArtworkDeliveryUrl: (source: string, base: string, identity?: RemoteProfileIdentity) => string;
  subtitleRecordsForRenderer: (subtitles?: SubtitleRecord[]) => SubtitleRecord[] | undefined;
  subtitleRecordsForLocalNetwork: (
    subtitles: SubtitleRecord[] | undefined,
    base: string,
    identity?: RemoteProfileIdentity,
    mediaScopePath?: string,
  ) => SubtitleRecord[] | undefined;
  getRemoteThumbnailUrl: (filePath: string, base: string, time?: string, identity?: RemoteProfileIdentity) => string;
  signedStreamUrlForRemote: (base: string, filePath: string, identity?: RemoteProfileIdentity) => string;
  localMetadataWithTracks: (filePath: string, metadata: MediaItem['localMetadata']) => MediaItem['localMetadata'];
  progressKeyFor: (filePath: string) => string;
  normalizeLibraryFolderGroups: (data?: Partial<LibraryData>) => LibraryFolderGroups;
  flattenLibraryFolders: (groups: LibraryFolderGroups) => string[];
  libraryFolderStatusesFor: (groups: LibraryFolderGroups) => LibraryFolderStatus[];
};

export function stripInlineArtworkFromItem(item: MediaItem): MediaItem {
  return {
    ...item,
    poster: durableArtworkSource(item.poster),
    backdrop: durableArtworkSource(item.backdrop),
    logo: durableArtworkSource(item.logo),
    posterCandidates: durableArtworkSources(item.posterCandidates),
    backdropCandidates: durableArtworkSources(item.backdropCandidates),
    logoCandidates: durableArtworkSources(item.logoCandidates),
    episodes: item.episodes?.map((episode) => ({
      ...episode,
      still: durableArtworkSource(episode.still),
    })),
  };
}

export function stripInlineArtworkFromLibrary(data: LibraryData): LibraryData {
  return {
    ...data,
    movies: (data.movies || []).map(stripInlineArtworkFromItem),
    tvShows: (data.tvShows || []).map(stripInlineArtworkFromItem),
    animeShows: (data.animeShows || []).map(stripInlineArtworkFromItem),
  };
}

function normalizedPathPrefix(value: string | undefined): string {
  return (value || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function itemBelongsToOtherFolders(item: MediaItem, folderPrefixes: string[]): boolean {
  const belongs = (candidate: string | undefined) => {
    const normalized = normalizedPathPrefix(candidate);
    return folderPrefixes.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`));
  };
  if (item.type === 'movie') return belongs(item.filePath);
  return item.episodeFiles?.length
    ? item.episodeFiles.some((episode) => belongs(episode.filePath))
    : belongs(item.filePath);
}

function itemsInOtherFolders(data: LibraryData, groups: LibraryFolderGroups): MediaItem[] {
  const folderPrefixes = groups.others.map(normalizedPathPrefix).filter(Boolean);
  if (folderPrefixes.length === 0) return [];
  return [...(data.movies || []), ...(data.tvShows || []), ...(data.animeShows || [])]
    .filter((item) => itemBelongsToOtherFolders(item, folderPrefixes));
}

export function createLibraryDeliveryProjections(deps: LibraryProjectionDependencies) {
  const {
    artworkDeliveryUrl,
    artworkDeliveryUrls,
    flattenLibraryFolders,
    getRemoteThumbnailUrl,
    libraryFolderStatusesFor,
    localMetadataWithTracks,
    normalizeLibraryFolderGroups,
    progressKeyFor,
    remoteArtworkDeliveryUrl,
    signedStreamUrlForRemote,
    subtitleRecordsForLocalNetwork,
    subtitleRecordsForRenderer,
  } = deps;

  const itemWithArtworkDeliveryUrls = (item: MediaItem): MediaItem => {
    const logo = artworkDeliveryUrl(item.logo);
    const posterCandidates = artworkDeliveryUrls(item.posterCandidates);
    const backdropCandidates = artworkDeliveryUrls(item.backdropCandidates);
    const logoCandidates = artworkDeliveryUrls(item.logoCandidates);
    const poster = artworkDeliveryUrl(item.poster) || posterCandidates[0] || '';
    const backdrop = artworkDeliveryUrl(item.backdrop) || backdropCandidates[0] || poster;

    return {
      ...item,
      poster,
      backdrop,
      logo,
      posterCandidates,
      backdropCandidates,
      logoCandidates,
      subtitles: subtitleRecordsForRenderer(item.subtitles),
      episodes: item.episodes?.map((episode) => ({
        ...episode,
        still: artworkDeliveryUrl(episode.still),
      })),
      episodeFiles: item.episodeFiles?.map((episodeFile) => ({
        ...episodeFile,
        subtitles: subtitleRecordsForRenderer(episodeFile.subtitles),
      })),
    };
  };

  const libraryForRenderer = (data: LibraryData): LibraryData => {
    const libraryFolderGroups = normalizeLibraryFolderGroups(data);
    return {
      ...data,
      libraryFolders: flattenLibraryFolders(libraryFolderGroups),
      libraryFolderGroups,
      libraryFolderStatuses: libraryFolderStatusesFor(libraryFolderGroups),
      movies: (data.movies || []).map(itemWithArtworkDeliveryUrls),
      tvShows: (data.tvShows || []).map(itemWithArtworkDeliveryUrls),
      animeShows: (data.animeShows || []).map(itemWithArtworkDeliveryUrls),
    };
  };

  const playbackReferencesFor = (item: MediaItem): LibraryPlaybackReference[] => {
    const episodeReferences = (item.episodeFiles || []).map((episodeFile) => ({
      progressKey: progressKeyFor(episodeFile.filePath),
      season: episodeFile.season,
      episode: episodeFile.episode,
      ...(episodeFile.localMetadata?.durationSeconds
        ? { durationSeconds: episodeFile.localMetadata.durationSeconds }
        : {}),
    }));
    if (episodeReferences.length > 0) return episodeReferences;
    if (!item.filePath) return [];
    return [{
      progressKey: progressKeyFor(item.filePath),
      ...(item.localMetadata?.durationSeconds ? { durationSeconds: item.localMetadata.durationSeconds } : {}),
    }];
  };

  const cardForRenderer = (item: MediaItem): LibraryCard => {
    const posterCandidates = artworkDeliveryUrls(item.posterCandidates);
    const backdropCandidates = artworkDeliveryUrls(item.backdropCandidates);
    const logoCandidates = artworkDeliveryUrls(item.logoCandidates);
    const poster = artworkDeliveryUrl(item.poster) || posterCandidates[0] || '';
    const backdrop = artworkDeliveryUrl(item.backdrop) || backdropCandidates[0] || poster;
    return {
      id: item.id,
      type: item.type,
      format: item.format,
      title: item.title,
      year: item.year,
      poster,
      backdrop,
      logo: artworkDeliveryUrl(item.logo) || logoCandidates[0] || '',
      posterCandidates,
      backdropCandidates,
      logoCandidates,
      summary: item.summary,
      rating: item.rating,
      contentRatings: item.contentRatings,
      streamingProviders: item.streamingProviders,
      originPlatform: item.originPlatform,
      genres: item.genres,
      lastPlayed: item.lastPlayed,
      seasons: item.seasons,
      // Desktop progress is keyed by local paths. The LAN projection below keeps
      // using opaque resource identifiers, so host paths never cross the network.
      playbackReferences: (item.episodeFiles || []).length > 0
        ? (item.episodeFiles || []).map((episodeFile) => ({
            progressKey: episodeFile.filePath,
            season: episodeFile.season,
            episode: episodeFile.episode,
            ...(episodeFile.localMetadata?.durationSeconds
              ? { durationSeconds: episodeFile.localMetadata.durationSeconds }
              : {}),
          }))
        : item.filePath
          ? [{
              progressKey: item.filePath,
              ...(item.localMetadata?.durationSeconds ? { durationSeconds: item.localMetadata.durationSeconds } : {}),
            }]
          : [],
    };
  };

  const cardForLocalNetwork = (
    item: MediaItem,
    base: string,
    identity?: RemoteProfileIdentity,
  ): LibraryCard => {
    const episodeThumbnailFallback = item.episodeFiles?.[0]
      ? getRemoteThumbnailUrl(item.episodeFiles[0].filePath, base, undefined, identity)
      : '';
    const posterCandidates = artworkDeliveryUrls(item.posterCandidates)
      .map((url) => remoteArtworkDeliveryUrl(url, base, identity));
    const backdropCandidates = artworkDeliveryUrls(item.backdropCandidates)
      .map((url) => remoteArtworkDeliveryUrl(url, base, identity));
    const logoCandidates = artworkDeliveryUrls(item.logoCandidates)
      .map((url) => remoteArtworkDeliveryUrl(url, base, identity));
    const poster = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.poster), base, identity)
      || posterCandidates[0]
      || episodeThumbnailFallback;
    const backdrop = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.backdrop), base, identity)
      || backdropCandidates[0]
      || poster;

    return {
      id: item.id,
      type: item.type,
      format: item.format,
      title: item.title,
      year: item.year,
      poster,
      backdrop,
      logo: remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.logo), base, identity),
      posterCandidates,
      backdropCandidates,
      logoCandidates,
      summary: item.summary,
      rating: item.rating,
      contentRatings: item.contentRatings,
      streamingProviders: item.streamingProviders,
      originPlatform: item.originPlatform,
      genres: item.genres,
      lastPlayed: item.lastPlayed,
      seasons: item.seasons,
      playbackReferences: playbackReferencesFor(item),
    };
  };

  const libraryIndexForRenderer = (data: LibraryData, revision: number): LibraryIndexPayload => {
    const libraryFolderGroups = normalizeLibraryFolderGroups(data);
    return {
      catalogVersion: 1,
      revision,
      libraryFolders: flattenLibraryFolders(libraryFolderGroups),
      libraryFolderGroups,
      libraryFolderStatuses: libraryFolderStatusesFor(libraryFolderGroups),
      movies: (data.movies || []).map(cardForRenderer),
      tvShows: (data.tvShows || []).map(cardForRenderer),
      animeShows: (data.animeShows || []).map(cardForRenderer),
      others: itemsInOtherFolders(data, libraryFolderGroups).map(cardForRenderer),
    };
  };

  const libraryIndexForLocalNetwork = (
    data: LibraryData,
    base: string,
    revision: number,
    identity?: RemoteProfileIdentity,
  ): LibraryIndexPayload => {
    const libraryFolderGroups = normalizeLibraryFolderGroups(data);
    return {
      catalogVersion: 1,
      revision,
      movies: (data.movies || []).map((item) => cardForLocalNetwork(item, base, identity)),
      tvShows: (data.tvShows || []).map((item) => cardForLocalNetwork(item, base, identity)),
      animeShows: (data.animeShows || []).map((item) => cardForLocalNetwork(item, base, identity)),
      others: itemsInOtherFolders(data, libraryFolderGroups)
        .map((item) => cardForLocalNetwork(item, base, identity)),
    };
  };

  const libraryItemForRenderer = (item: MediaItem, revision: number): LibraryItemDetailsPayload => ({
    catalogVersion: 1,
    revision,
    item: itemWithArtworkDeliveryUrls(item),
  });

  const itemForLocalNetwork = (item: MediaItem, base: string, identity?: RemoteProfileIdentity): MediaItem => {
    const episodeThumbnailFallback = item.episodeFiles?.[0] ? getRemoteThumbnailUrl(item.episodeFiles[0].filePath, base, undefined, identity) : '';
    const posterCandidates = artworkDeliveryUrls(item.posterCandidates).map((url) => remoteArtworkDeliveryUrl(url, base, identity));
    const backdropCandidates = artworkDeliveryUrls(item.backdropCandidates).map((url) => remoteArtworkDeliveryUrl(url, base, identity));
    const logoCandidates = artworkDeliveryUrls(item.logoCandidates).map((url) => remoteArtworkDeliveryUrl(url, base, identity));
    const poster = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.poster), base, identity)
      || posterCandidates[0]
      || episodeThumbnailFallback;
    const backdrop = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.backdrop), base, identity)
      || backdropCandidates[0]
      || poster;
    const logo = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.logo), base, identity);

    const stillByEpisode = new Map(
      (item.episodes || []).map((episode) => [
        `${episode.season}-${episode.number}`,
        remoteArtworkDeliveryUrl(artworkDeliveryUrl(episode.still), base, identity),
      ]),
    );

    return {
      ...item,
      filePath: signedStreamUrlForRemote(base, item.filePath, identity),
      poster,
      backdrop,
      logo,
      posterCandidates,
      backdropCandidates,
      logoCandidates,
      localMetadata: localMetadataWithTracks(item.filePath, item.localMetadata),
      subtitles: subtitleRecordsForLocalNetwork(item.subtitles, base, identity, item.filePath),
      episodes: item.episodes?.map((episode) => ({
        ...episode,
        still: remoteArtworkDeliveryUrl(artworkDeliveryUrl(episode.still), base, identity),
      })),
      episodeFiles: item.episodeFiles?.map((episodeFile) => ({
        ...episodeFile,
        filePath: signedStreamUrlForRemote(base, episodeFile.filePath, identity),
        still: stillByEpisode.get(`${episodeFile.season}-${episodeFile.episode}`) || '',
        thumbnail: getRemoteThumbnailUrl(episodeFile.filePath, base, undefined, identity),
        localMetadata: localMetadataWithTracks(episodeFile.filePath, episodeFile.localMetadata),
        subtitles: subtitleRecordsForLocalNetwork(episodeFile.subtitles, base, identity, episodeFile.filePath),
      })),
    };
  };

  const libraryForLocalNetwork = (data: LibraryData, base: string, identity?: RemoteProfileIdentity): LibraryData => {
    const libraryFolderGroups = normalizeLibraryFolderGroups(data);
    return {
      ...data,
      libraryFolders: flattenLibraryFolders(libraryFolderGroups),
      libraryFolderGroups,
      libraryFolderStatuses: libraryFolderStatusesFor(libraryFolderGroups),
      movies: (data.movies || []).map((item) => itemForLocalNetwork(item, base, identity)),
      tvShows: (data.tvShows || []).map((item) => itemForLocalNetwork(item, base, identity)),
      animeShows: (data.animeShows || []).map((item) => itemForLocalNetwork(item, base, identity)),
    };
  };

  const libraryItemForLocalNetwork = (
    item: MediaItem,
    base: string,
    revision: number,
    identity?: RemoteProfileIdentity,
  ): LibraryItemDetailsPayload => ({
    catalogVersion: 1,
    revision,
    item: itemForLocalNetwork(item, base, identity),
  });

  return {
    itemForLocalNetwork,
    itemWithArtworkDeliveryUrls,
    libraryForLocalNetwork,
    libraryForRenderer,
    libraryIndexForLocalNetwork,
    libraryIndexForRenderer,
    libraryItemForLocalNetwork,
    libraryItemForRenderer,
  };
}
