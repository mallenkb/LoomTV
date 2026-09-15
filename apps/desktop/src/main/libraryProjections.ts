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

function mapArtworkRecords<T>(items: T[], project: (item: T) => T, reuseUnchanged: boolean): T[] {
  if (!reuseUnchanged) return items.map(project);
  let changed: T[] | undefined;
  for (let index = 0; index < items.length; index++) {
    const result = project(items[index]);
    if (result !== items[index]) {
      changed ||= items.slice();
      changed[index] = result;
    }
  }
  return changed || items;
}

function projectArtworkSources(sources: string[] | undefined, reuseUnchanged: boolean): string[] {
  if (reuseUnchanged && sources?.length === 0) return sources;
  const normalized = durableArtworkSources(sources);
  return reuseUnchanged && sources && normalized.length === sources.length
    && normalized.every((source, index) => source === sources[index]) ? sources : normalized;
}

export function stripInlineArtworkFromItem(item: MediaItem, reuseUnchanged = false): MediaItem {
  const poster = durableArtworkSource(item.poster);
  const backdrop = durableArtworkSource(item.backdrop);
  const logo = durableArtworkSource(item.logo);
  const posterCandidates = projectArtworkSources(item.posterCandidates, reuseUnchanged);
  const backdropCandidates = projectArtworkSources(item.backdropCandidates, reuseUnchanged);
  const logoCandidates = projectArtworkSources(item.logoCandidates, reuseUnchanged);
  const cast = mapArtworkRecords(item.cast, (credit) => {
    const image = durableArtworkSource(credit.image);
    const characterImage = durableArtworkSource(credit.characterImage);
    const voiceActorImage = durableArtworkSource(credit.voiceActorImage);
    return reuseUnchanged && image === credit.image && characterImage === credit.characterImage && voiceActorImage === credit.voiceActorImage
      ? credit : { ...credit, image, characterImage, voiceActorImage };
  }, reuseUnchanged);
  const episodes = item.episodes && mapArtworkRecords(item.episodes, (episode) => {
    const still = durableArtworkSource(episode.still);
    return reuseUnchanged && still === episode.still ? episode : { ...episode, still };
  }, reuseUnchanged);
  const episodeFiles = item.episodeFiles && mapArtworkRecords(item.episodeFiles, (file) => {
    const still = file.still ? durableArtworkSource(file.still) : file.still;
    const thumbnail = file.thumbnail ? durableArtworkSource(file.thumbnail) : file.thumbnail;
    return reuseUnchanged && still === file.still && thumbnail === file.thumbnail ? file : {
      ...file,
      ...(file.still ? { still } : {}),
      ...(file.thumbnail ? { thumbnail } : {}),
    };
  }, reuseUnchanged);
  if (reuseUnchanged && poster === item.poster && backdrop === item.backdrop && logo === item.logo
    && posterCandidates === item.posterCandidates && backdropCandidates === item.backdropCandidates
    && logoCandidates === item.logoCandidates && cast === item.cast && episodes === item.episodes && episodeFiles === item.episodeFiles
    && Object.hasOwn(item, 'episodes') && Object.hasOwn(item, 'episodeFiles')) return item;
  return { ...item, poster, backdrop, logo, posterCandidates, backdropCandidates, logoCandidates, cast, episodes, episodeFiles };
}

/** Reuse is for synchronous reads of committed state; queued snapshots still copy. */
export function stripInlineArtworkFromLibrary(data: LibraryData, reuseUnchanged = false): LibraryData {
  const project = (item: MediaItem) => stripInlineArtworkFromItem(item, reuseUnchanged);
  const movies = mapArtworkRecords(data.movies || [], project, reuseUnchanged);
  const tvShows = mapArtworkRecords(data.tvShows || [], project, reuseUnchanged);
  const animeShows = mapArtworkRecords(data.animeShows || [], project, reuseUnchanged);
  if (reuseUnchanged && movies === data.movies && tvShows === data.tvShows && animeShows === data.animeShows) return data;
  return { ...data, movies, tvShows, animeShows };
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

function itemsOutsideOtherFolders(items: MediaItem[], groups: LibraryFolderGroups): MediaItem[] {
  const folderPrefixes = groups.others.map(normalizedPathPrefix).filter(Boolean);
  if (folderPrefixes.length === 0) return items;
  return items.filter((item) => !itemBelongsToOtherFolders(item, folderPrefixes));
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
    const cast = item.cast.map((credit) => ({
      ...credit,
      image: artworkDeliveryUrl(credit.image),
      characterImage: artworkDeliveryUrl(credit.characterImage),
      voiceActorImage: artworkDeliveryUrl(credit.voiceActorImage),
    }));

    return {
      ...item,
      poster,
      backdrop,
      logo,
      posterCandidates,
      backdropCandidates,
      logoCandidates,
      cast,
      subtitles: subtitleRecordsForRenderer(item.subtitles),
      episodes: item.episodes?.map((episode) => ({
        ...episode,
        still: artworkDeliveryUrl(episode.still),
      })),
      episodeFiles: item.episodeFiles?.map((episodeFile) => ({
        ...episodeFile,
        ...(episodeFile.still ? { still: artworkDeliveryUrl(episodeFile.still) } : {}),
        ...(episodeFile.thumbnail ? { thumbnail: artworkDeliveryUrl(episodeFile.thumbnail) } : {}),
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
      providerRatings: item.providerRatings,
      contentRatings: item.contentRatings,
      contentRating: item.contentRating,
      streamingProviders: item.streamingProviders,
      originPlatform: item.originPlatform,
      trailerUrl: item.trailerUrl,
      runtime: item.runtime,
      seasonCount: item.seasonCount,
      episodeCount: item.episodeCount,
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
      providerRatings: item.providerRatings,
      contentRatings: item.contentRatings,
      contentRating: item.contentRating,
      streamingProviders: item.streamingProviders,
      originPlatform: item.originPlatform,
      trailerUrl: item.trailerUrl,
      runtime: item.runtime,
      seasonCount: item.seasonCount,
      episodeCount: item.episodeCount,
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
      movies: itemsOutsideOtherFolders(data.movies || [], libraryFolderGroups).map(cardForRenderer),
      tvShows: itemsOutsideOtherFolders(data.tvShows || [], libraryFolderGroups).map(cardForRenderer),
      animeShows: itemsOutsideOtherFolders(data.animeShows || [], libraryFolderGroups).map(cardForRenderer),
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
      movies: itemsOutsideOtherFolders(data.movies || [], libraryFolderGroups)
        .map((item) => cardForLocalNetwork(item, base, identity)),
      tvShows: itemsOutsideOtherFolders(data.tvShows || [], libraryFolderGroups)
        .map((item) => cardForLocalNetwork(item, base, identity)),
      animeShows: itemsOutsideOtherFolders(data.animeShows || [], libraryFolderGroups)
        .map((item) => cardForLocalNetwork(item, base, identity)),
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
    const cast = item.cast.map((credit) => ({
      ...credit,
      image: remoteArtworkDeliveryUrl(artworkDeliveryUrl(credit.image), base, identity),
      characterImage: remoteArtworkDeliveryUrl(artworkDeliveryUrl(credit.characterImage), base, identity),
      voiceActorImage: remoteArtworkDeliveryUrl(artworkDeliveryUrl(credit.voiceActorImage), base, identity),
    }));

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
      cast,
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
