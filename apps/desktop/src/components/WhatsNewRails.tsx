import { useMemo } from 'react';
import MediaRail from '@/components/MediaRail';
import MediaPosterCard from '@/components/MediaPosterCard';
import type { MediaItem } from '@/contexts/LibraryContext';
import { airsLabel, useEpisodeUpdates } from '@/lib/useEpisodeUpdates';

/**
 * "New Episodes" (unwatched episodes that arrived this week, and what airs
 * next) and "Recently Added" rows for Home. Both only list titles the page
 * already has, so profile restrictions and folder groups carry over.
 */
export default function WhatsNewRails({
  items,
  from,
  variant,
}: {
  items: MediaItem[];
  from: string;
  variant?: 'modern';
}) {
  const updates = useEpisodeUpdates();
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  const newEpisodes = useMemo(() => updates.shows
    .filter((show) => show.newEpisodes.length > 0 && byId.has(show.mediaId))
    .map((show) => {
      const count = show.newEpisodes.length;
      const next = show.nextAirs?.airDate ? ` · Next: ${airsLabel(show.nextAirs.airDate).replace(/^Airs /, '')}` : '';
      return { item: byId.get(show.mediaId) as MediaItem, meta: `${count} new ${count === 1 ? 'episode' : 'episodes'}${next}` };
    }), [byId, updates.shows]);

  const recentlyAdded = useMemo(() => {
    const seen = new Set<string>();
    return updates.recentlyAdded
      .filter((entry) => byId.has(entry.mediaId) && !seen.has(entry.mediaId) && seen.add(entry.mediaId))
      .map((entry) => ({ item: byId.get(entry.mediaId) as MediaItem, meta: entry.label ? `Added ${entry.label}` : 'Added recently' }));
  }, [byId, updates.recentlyAdded]);

  const railClass = variant === 'modern' ? undefined : 'mb-8';
  return (
    <>
      {newEpisodes.length > 0 && (
        <MediaRail title="New Episodes" className={railClass} variant={variant}>
          {newEpisodes.map(({ item, meta }) => (
            <MediaPosterCard key={item.id} item={item} from={from} variant="home" metaLine={meta} />
          ))}
        </MediaRail>
      )}
      {recentlyAdded.length > 0 && (
        <MediaRail title="Recently Added" className={railClass} variant={variant}>
          {recentlyAdded.map(({ item, meta }) => (
            <MediaPosterCard key={item.id} item={item} from={from} variant="home" metaLine={meta} />
          ))}
        </MediaRail>
      )}
    </>
  );
}
