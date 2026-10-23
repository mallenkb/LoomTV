import { addonEpisodes, addonVideoTarget, isSeriesLikeType, type AddonVideoTarget, type AddonEpisode } from './addonPlayback';
import { addonProgressKey } from './addonWatchHistory';
import { getProgressState } from './progress';
import { episodeCode } from './episodeTitles';
import type { StremioPluginCatalogItem } from './desktopApi';

/** Keep provider video IDs. Only numbering and ordering are shared with local episodes. */
export function playableAddonEpisodes(item: StremioPluginCatalogItem | undefined, now = Date.now()): AddonEpisode[] {
  return addonEpisodes(item?.videos).filter(({ video }) => {
    const released = video.released ? Date.parse(video.released) : NaN;
    return video.available !== false && (!Number.isFinite(released) || released <= now);
  }).sort((a, b) => a.season - b.season || a.number - b.number);
}

export function addonEpisodeTarget(current: AddonVideoTarget, season: number, episode: number): AddonVideoTarget | null {
  const item = current.metaItem;
  const entry = playableAddonEpisodes(item).find(candidate => candidate.season === season && candidate.number === episode);
  if (!item || !entry) return null;
  return {
    ...addonVideoTarget(item, entry.video.id, `${item.title} · ${episodeCode(season, episode)}`, entry.video, { season, episode }),
    sourceAddonId: current.sourceRestriction,
    sourceRestriction: current.sourceRestriction,
    preferredSource: current.preferredSource,
  };
}

/** These filePath values are progress/selection keys, never media URLs or grants. */
export function addonPlayerEpisodeList(target: AddonVideoTarget) {
  const entries = isSeriesLikeType(target.type) ? playableAddonEpisodes(target.metaItem) : [];
  // An unresolved current video must not auto-advance into an unrelated list.
  const current = entries.find(entry => entry.video.id === target.videoId);
  if (!current) return undefined;
  return {
    currentSeason: current.season, currentEpisode: current.number,
    episodes: entries.map(({ season, number, video }) => ({
      season, number, title: video.title, summary: video.overview || '', still: video.thumbnail || '',
      rating: 0, airDate: video.released?.slice(0, 10) || '',
    })),
    episodeFiles: entries.map(({ season, number, video }) => ({
      season, episode: number, filePath: addonProgressKey({ ...target, videoId: video.id }),
      title: video.title, still: video.thumbnail,
    })),
  };
}

/** Continue the latest episode, or advance past completed episodes in the same series. */
export function addonContinueTarget(target: AddonVideoTarget): AddonVideoTarget | null {
  if (!getProgressState(addonProgressKey(target)).watched) return target;
  if (!isSeriesLikeType(target.type)) return null;
  const entries = playableAddonEpisodes(target.metaItem);
  const index = entries.findIndex(entry => entry.video.id === target.videoId);
  if (index < 0) return null;
  const next = entries.slice(index + 1).find(entry => (
    (target.season === 0 || entry.season > 0)
    && !getProgressState(addonProgressKey({ ...target, videoId: entry.video.id })).watched
  ));
  const candidate = next ? addonEpisodeTarget(target, next.season, next.number) : null;
  return candidate ? { ...candidate, metadataNeedsRefresh: target.metadataNeedsRefresh } : null;
}
