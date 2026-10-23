import CardPlayContent, { CARD_PLAY_ACTION_CLASS, CARD_PLAY_OVERLAY_CLASS } from './CardPlayContent';
import { Star } from 'lucide-react';
import { useProfiles } from '@/contexts/ProfileContext';
import { getProgressState, useProgressSnapshot } from '@/lib/progress';
import { addonProgressKey, readAddonWatchHistory, type AddonWatchEntry } from '@/lib/addonWatchHistory';
import { addonContinueTarget } from '@/lib/addonEpisodeNavigation';
import { addonDetailRoute, type AddonStreamPlayer } from '@/lib/addonPlayback';
import { useNavigate } from '@/lib/navigation';
import { cacheDiscoverReturnRoute, getCachedExploreItem } from '@/lib/discoverNavigation';
import type { StremioPluginCatalogItem } from '@/lib/desktopApi';

export default function AddonKeepWatching({ addonId, onPlay }: { addonId: string; onPlay: AddonStreamPlayer }) {
  const { activeProfile } = useProfiles();
  const navigate = useNavigate();
  const openDetails = (entry: AddonWatchEntry) => {
    const { target, artwork } = entry;
    const type = target.detailType || (target.type === 'series' ? 'tv' : target.type);
    const id = target.detailId || (/^tt\d+:/.test(target.videoId) ? target.videoId.split(':')[0] : target.videoId);
    const item: StremioPluginCatalogItem = getCachedExploreItem(type, id) || target.metaItem || {
      id, type, title: target.title, genres: [], source: /^tt\d+$/.test(id) ? 'cinemeta' : addonId,
      providerId: id, imdbId: /^tt\d+$/.test(id) ? id : undefined,
      posterUrl: artwork?.poster, backgroundUrl: artwork?.backdrop, rating: artwork?.rating,
    };
    const from = `/addons/stremio/${encodeURIComponent(addonId)}`;
    cacheDiscoverReturnRoute(from);
    navigate(addonDetailRoute(item), { state: { from, addonId, streamAddonId: addonId, stremioCatalogItem: item } });
  };
  const progress = useProgressSnapshot();
  const seen = new Set<string>();
  const entries = readAddonWatchHistory(activeProfile?.id || '')
    .filter(entry => entry.target.sourceAddonId === addonId)
    .map(entry => ({ ...entry, previousProgress: progress[addonProgressKey(entry.target)] }))
    .sort((a, b) => (b.previousProgress?.updatedAt || 0) - (a.previousProgress?.updatedAt || 0))
    .flatMap(entry => {
      if (!entry.previousProgress || entry.previousProgress.position <= 10) return [];
      const series = JSON.stringify([entry.target.type, entry.target.detailId || entry.target.videoId]);
      if (seen.has(series)) return [];
      seen.add(series);
      const target = addonContinueTarget(entry.target);
      if (!target) return [];
      return [{ ...entry, target, progress: getProgressState(addonProgressKey(target)) }];
    });
  if (!entries.length) return null;
  return <section aria-label="Keep watching" className="my-6">
    <h2 className="mb-4 text-xl font-semibold">Keep watching</h2>
    <div className="flex gap-4 overflow-x-auto pb-3">
      {entries.map(entry => <div key={addonProgressKey(entry.target)}
        className="group relative aspect-video w-72 shrink-0 overflow-hidden rounded-2xl bg-[var(--loom-surface-2)] text-left sm:w-80">
        <button type="button" onClick={() => openDetails(entry)} className="absolute inset-0 h-full w-full text-left"
          aria-label={`View details for ${entry.target.title}`}>
        {entry.artwork?.backdrop || entry.artwork?.poster ? <img src={entry.artwork.backdrop || entry.artwork.poster} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none" /> : null}
        <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
        {typeof entry.artwork?.rating === 'number' && entry.artwork.rating > 0 ? <span aria-label={`Rating ${entry.artwork.rating.toFixed(1)} out of 10`} className="absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-black px-2.5 py-1.5 text-xs font-semibold text-yellow-400"><Star aria-hidden="true" className="h-3.5 w-3.5 fill-current" />{entry.artwork.rating.toFixed(1)}</span> : null}
        <span className="absolute bottom-4 left-3 right-3 truncate text-base font-semibold text-white">{entry.target.title}</span>
        {entry.progress.duration > 0 ? <span role="progressbar" aria-label="Watched" aria-valuemin={0} aria-valuemax={entry.progress.duration} aria-valuenow={entry.progress.position} className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
          <span className="block h-full bg-[var(--loom-accent)]" style={{ width: `${Math.min(100, Math.max(0, entry.progress.position / entry.progress.duration * 100))}%` }} />
        </span> : null}
        </button>
        <div className={`${CARD_PLAY_OVERLAY_CLASS} pointer-events-none`}>
          <button type="button" onClick={() => onPlay('', entry.target.title, entry.artwork, { addonTarget: entry.target, resumeLastSource: true })}
            aria-label={`Continue ${entry.target.title}`} className={`${CARD_PLAY_ACTION_CLASS} pointer-events-auto`}>
            <CardPlayContent />
          </button>
        </div>
      </div>)}
    </div>
  </section>;
}
