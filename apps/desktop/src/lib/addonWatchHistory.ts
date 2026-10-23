import type { AddonVideoTarget, AddonStreamArtwork } from './addonPlayback';
import { z } from 'zod';
import { addonResolutionOptions, type AddonResolution } from './addonSourcePreferences';
import { successfulSourceKey } from './addonSourceHistory';

export type AddonWatchEntry = { target: AddonVideoTarget; artwork?: AddonStreamArtwork };
// Whitelist display metadata and stable identities. Streams and grants are never persisted.
const seriesMetadataSchema = z.object({
  id: z.string(), type: z.string(), title: z.string(), genres: z.array(z.string()),
  source: z.string().optional(), providerId: z.string().optional(), metaKey: z.string().optional(),
  imdbId: z.string().optional(), tmdbId: z.string().optional(),
  videos: z.array(z.object({
    id: z.string(), title: z.string(), season: z.number().int().nonnegative().optional(),
    episode: z.number().int().nonnegative().optional(), available: z.boolean().optional(),
    released: z.string().optional(), overview: z.string().optional(), thumbnail: z.string().optional(),
  })).optional(),
});
const historyTargetSchema = z.object({
  type: z.string(), videoId: z.string(), title: z.string(), sourceAddonId: z.string().optional(),
  detailId: z.string().optional(), detailType: z.string().optional(),
  season: z.number().int().nonnegative().optional(), episode: z.number().int().nonnegative().optional(),
  metaItem: seriesMetadataSchema.optional(), metadataNeedsRefresh: z.boolean().optional(),
  sourceRestriction: z.string().optional(),
  preferredSource: z.object({ addonId: z.string(), resolution: z.string()
    .refine(value => addonResolutionOptions.some(option => option.value === value))
    .transform(value => value as AddonResolution) }).optional(),
});
const historyKey = (profileId: string) => `loom:addon-watch-history:${profileId}`;
export const addonProgressKey = (target: AddonVideoTarget) => `addon-video:${encodeURIComponent(target.type)}:${encodeURIComponent(target.videoId)}`;

export function readAddonWatchHistory(profileId: string): AddonWatchEntry[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(historyKey(profileId)) || '[]');
    if (!Array.isArray(value)) return [];
    return value.flatMap(entry => {
      const target = historyTargetSchema.safeParse(entry?.target);
      return target.success ? [{ target: { ...target.data, ...(target.data.metaItem ? { metadataNeedsRefresh: true } : {}) }, artwork: entry.artwork }] : [];
    }).slice(0, 60);
  } catch { return []; }
}

export function rememberAddonVideo(profileId: string, target: AddonVideoTarget, artwork?: AddonStreamArtwork): void {
  // Retain display metadata and stable identity, never temporary playback grants.
  const metadata = seriesMetadataSchema.safeParse(target.metaItem);
  const entry: AddonWatchEntry = { target: {
    type: target.type, videoId: target.videoId, title: target.title,
    sourceAddonId: target.sourceAddonId, season: target.season, episode: target.episode,
    detailId: target.detailId, detailType: target.detailType,
    preferredSource: target.preferredSource, sourceRestriction: target.sourceRestriction,
    ...(metadata.success ? { metaItem: metadata.data, metadataNeedsRefresh: true } : {}),
  }, artwork };
  if (target.selectedSourceFingerprint) {
    try { localStorage.setItem(successfulSourceKey(profileId, target.type, target.videoId), target.selectedSourceFingerprint); } catch { /* Storage can be unavailable. */ }
  }
  const previous = readAddonWatchHistory(profileId);
  const key = addonProgressKey(target);
  if (JSON.stringify(previous[0]) === JSON.stringify(entry)) return;
  try { localStorage.setItem(historyKey(profileId), JSON.stringify([entry, ...previous.filter(item => addonProgressKey(item.target) !== key
    && !(target.season !== undefined && target.detailId && item.target.detailId === target.detailId
      && item.target.type === target.type && item.target.sourceAddonId === target.sourceAddonId))].slice(0, 60))); } catch { /* Storage can be unavailable. */ }
}
