import type { LibraryData, LibraryFolderGroups, LibraryFolderStatus } from './appContracts.ts';
import { durableArtworkSource, durableArtworkSources } from './artworkSources.ts';
import type { MediaItem } from './metadata/types.ts';

type SubtitleRecord = NonNullable<MediaItem['subtitles']>[number];

export type LibraryProjectionDependencies = {
  artworkDeliveryUrl: (source?: string | null) => string;
  artworkDeliveryUrls: (sources?: string[]) => string[];
  remoteArtworkDeliveryUrl: (source: string, base: string) => string;
  subtitleRecordsForRenderer: (subtitles?: SubtitleRecord[]) => SubtitleRecord[] | undefined;
  subtitleRecordsForLocalNetwork: (subtitles: SubtitleRecord[] | undefined, base: string) => SubtitleRecord[] | undefined;
  getRemoteThumbnailUrl: (filePath: string, base: string) => string;
  signedStreamUrlForRemote: (base: string, filePath: string) => string;
  localMetadataWithTracks: (filePath: string, metadata: MediaItem['localMetadata']) => MediaItem['localMetadata'];
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

export function createLibraryDeliveryProjections(deps: LibraryProjectionDependencies) {
  const {
    artworkDeliveryUrl,
    artworkDeliveryUrls,
    flattenLibraryFolders,
    getRemoteThumbnailUrl,
    libraryFolderStatusesFor,
    localMetadataWithTracks,
    normalizeLibraryFolderGroups,
    remoteArtworkDeliveryUrl,
    signedStreamUrlForRemote,
    subtitleRecordsForLocalNetwork,
    subtitleRecordsForRenderer,
  } = deps;

  const itemWithArtworkDeliveryUrls = (item: MediaItem): MediaItem => {
    const poster = artworkDeliveryUrl(item.poster);
    const backdrop = artworkDeliveryUrl(item.backdrop);
    const logo = artworkDeliveryUrl(item.logo);
    const posterCandidates = artworkDeliveryUrls(item.posterCandidates);
    const backdropCandidates = artworkDeliveryUrls(item.backdropCandidates);
    const logoCandidates = artworkDeliveryUrls(item.logoCandidates);

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

  const itemForLocalNetwork = (item: MediaItem, base: string): MediaItem => {
    const episodeThumbnailFallback = item.episodeFiles?.[0] ? getRemoteThumbnailUrl(item.episodeFiles[0].filePath, base) : '';
    const posterCandidates = artworkDeliveryUrls(item.posterCandidates).map((url) => remoteArtworkDeliveryUrl(url, base));
    const backdropCandidates = artworkDeliveryUrls(item.backdropCandidates).map((url) => remoteArtworkDeliveryUrl(url, base));
    const logoCandidates = artworkDeliveryUrls(item.logoCandidates).map((url) => remoteArtworkDeliveryUrl(url, base));
    const poster = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.poster), base)
      || posterCandidates[0]
      || episodeThumbnailFallback;
    const backdrop = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.backdrop), base)
      || backdropCandidates[0]
      || poster;
    const logo = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.logo), base);

    const stillByEpisode = new Map(
      (item.episodes || []).map((episode) => [
        `${episode.season}-${episode.number}`,
        remoteArtworkDeliveryUrl(artworkDeliveryUrl(episode.still), base),
      ]),
    );

    return {
      ...item,
      filePath: signedStreamUrlForRemote(base, item.filePath),
      poster,
      backdrop,
      logo,
      posterCandidates,
      backdropCandidates,
      logoCandidates,
      localMetadata: localMetadataWithTracks(item.filePath, item.localMetadata),
      subtitles: subtitleRecordsForLocalNetwork(item.subtitles, base),
      episodes: item.episodes?.map((episode) => ({
        ...episode,
        still: remoteArtworkDeliveryUrl(artworkDeliveryUrl(episode.still), base),
      })),
      episodeFiles: item.episodeFiles?.map((episodeFile) => ({
        ...episodeFile,
        filePath: signedStreamUrlForRemote(base, episodeFile.filePath),
        still: stillByEpisode.get(`${episodeFile.season}-${episodeFile.episode}`) || '',
        thumbnail: getRemoteThumbnailUrl(episodeFile.filePath, base),
        localMetadata: localMetadataWithTracks(episodeFile.filePath, episodeFile.localMetadata),
        subtitles: subtitleRecordsForLocalNetwork(episodeFile.subtitles, base),
      })),
    };
  };

  const libraryForLocalNetwork = (data: LibraryData, base: string): LibraryData => ({
    ...data,
    libraryFolders: [],
    libraryFolderGroups: { movies: [], tvShows: [], anime: [], others: [] },
    libraryFolderStatuses: [],
    movies: (data.movies || []).map((item) => itemForLocalNetwork(item, base)),
    tvShows: (data.tvShows || []).map((item) => itemForLocalNetwork(item, base)),
    animeShows: (data.animeShows || []).map((item) => itemForLocalNetwork(item, base)),
  });

  return { itemForLocalNetwork, itemWithArtworkDeliveryUrls, libraryForLocalNetwork, libraryForRenderer };
}
