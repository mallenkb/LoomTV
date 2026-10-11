import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Play, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import TrailerDialog from '@/components/TrailerDialog';
import { useProfiles } from '@/contexts/ProfileContext';
import { desktopApi } from '@/lib/desktopApi';
import {
  StaleAddonSourceError, invalidateRequests, loadAddonSources, requireUsableSource,
  type AddonSourceGroup, type AddonVideoTarget,
} from '@/lib/addonPlayback';
import type { StremioStreamDescriptor } from '@/shared/desktopProtocol';

export type AddonStreamSelection = {
  /** The target the list was loaded for, after any inline-stream refresh. */
  target: AddonVideoTarget;
  addonId: string;
  addonName: string;
  stream: StremioStreamDescriptor;
  url: string;
};

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'the provider'; }
}

function streamNote(stream: StremioStreamDescriptor): string {
  if (stream.transport === 'peer-to-peer') return 'Torrent and peer-to-peer sources need a transport LoomTV does not include, so this source cannot play.';
  if (stream.transport === 'unsupported') return stream.reason || 'LoomTV cannot play this source type.';
  if (stream.requestHeadersRequired) return 'This source asks for request headers LoomTV does not send, so it may not play.';
  if (stream.transport === 'external') return `Opens ${hostOf(stream.externalUrl || '')} in your browser.`;
  return '';
}

/** `requested` is the target prop this list was loaded for; `target` may be its refreshed form. */
type LoadState = { requested: AddonVideoTarget; target: AddonVideoTarget; profileId: string; groups: AddonSourceGroup[] };

/**
 * Lists every source for one video, grouped by add-on, and starts the chosen
 * one. Sources resolve only when this opens; nothing is probed while browsing.
 * All state belongs to the current target and profile, and a source that
 * changed while the list was open is reloaded instead of used.
 */
export default function AddonSourcePicker({ target, onClose, onPlay }: {
  target: AddonVideoTarget | null;
  onClose: () => void;
  onPlay: (selection: AddonStreamSelection) => void;
}) {
  const { activeProfile } = useProfiles();
  const profileId = activeProfile?.id || '';
  const [loaded, setLoaded] = useState<LoadState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');
  // Bound to the target and profile that opened it, so a later target or
  // profile never shows it, even for the render before the reset runs.
  const [youtube, setYoutube] = useState<{ id: string; title: string; target: AddonVideoTarget; profileId: string } | null>(null);
  const request = useRef(0);

  const load = useCallback((message = '') => {
    const current = ++request.current;
    setLoaded(null); setError(''); setNotice(message); setBusyId(''); setYoutube(null);
    if (!target || !profileId) return;
    void loadAddonSources(target).then((result) => {
      if (current === request.current) setLoaded({ ...result, requested: target, profileId });
    }).catch((failure) => {
      if (current === request.current) setError(failure instanceof Error ? failure.message : 'Sources could not be loaded.');
    });
  }, [profileId, target]);

  useEffect(() => {
    load();
    return () => invalidateRequests(request);
  }, [load]);

  // A list loaded for another target or profile is never shown or used.
  const visibleList = loaded && loaded.requested === target && loaded.profileId === profileId ? loaded : null;

  const choose = async (group: AddonSourceGroup, stream: StremioStreamDescriptor) => {
    const list = visibleList;
    if (!list || busyId) return;
    const requestId = request.current;
    setBusyId(stream.id); setError(''); setNotice('');
    try {
      // Access, approval, manifest, or configuration can change while the list is open.
      await requireUsableSource(group.addonId, group.revision);
      if (requestId !== request.current || list.profileId !== profileId) return;
      if ((stream.transport === 'media' || stream.transport === 'hls') && stream.url) {
        onPlay({ target: list.target, addonId: group.addonId, addonName: group.addonName, stream, url: stream.url });
      } else if (stream.transport === 'youtube' && stream.ytId) {
        if (target) setYoutube({ id: stream.ytId, title: list.target.title, target, profileId });
      } else if (stream.transport === 'external' && stream.externalUrl) {
        desktopApi.openExternal(stream.externalUrl);
      }
    } catch (failure) {
      if (requestId !== request.current) return;
      if (failure instanceof StaleAddonSourceError) load(`${failure.message} The list was reloaded.`);
      else setError(failure instanceof Error ? failure.message : 'This source could not be opened.');
    } finally {
      if (requestId === request.current) setBusyId('');
    }
  };

  if (youtube && target && youtube.target === target && youtube.profileId === profileId && visibleList) {
    return <TrailerDialog open title={youtube.title} label={`${youtube.title} on YouTube`} trailerUrl={youtube.id} onClose={() => setYoutube(null)} />;
  }

  const groups = visibleList?.groups || null;
  const readyGroups = groups?.filter(group => group.status === 'ready') || [];
  const streamCount = readyGroups.reduce((count, group) => count + group.streams.length, 0);
  const allFailed = Boolean(groups?.length) && readyGroups.length === 0;
  const summary = !groups ? (error ? 'Sources could not be loaded.' : 'Asking your sources…')
    : groups.length === 0 ? 'None of your enabled add-ons provide streams for this title.'
      : allFailed ? 'Your sources could not be reached.'
        : streamCount === 0 ? 'Your sources found nothing for this title.'
          : `${streamCount} ${streamCount === 1 ? 'source' : 'sources'}`;

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(open) => { if (!open) onClose(); }}
      contentClassName="max-w-[min(92vw,44rem)] border border-[var(--loom-border)] bg-[var(--loom-surface)] p-0 text-[var(--loom-text)] shadow-2xl"
    >
      <DialogContent className="space-y-4 p-6">
        <DialogHeader>
          <DialogTitle className="text-white">{target?.title || 'Sources'}</DialogTitle>
          <DialogDescription className="text-[var(--loom-muted)]" aria-live="polite">{summary}</DialogDescription>
        </DialogHeader>
        {notice ? <p role="status" className="rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-4 py-3 text-sm text-[var(--loom-muted)]">{notice}</p> : null}
        {error ? <p role="alert" className="rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</p> : null}
        {groups?.map(group => (
          <section key={group.addonId} aria-label={group.addonName} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--loom-faint)]">{group.addonName}</h3>
            {group.status === 'error' ? (
              <p className="text-sm text-red-200">{group.error}</p>
            ) : group.streams.length === 0 ? (
              <p className="text-sm text-[var(--loom-muted)]">No sources for this title.</p>
            ) : (
              <ul className="space-y-2">
                {group.streams.map(stream => {
                  const note = streamNote(stream);
                  const actionable = stream.transport === 'media' || stream.transport === 'hls' || stream.transport === 'youtube' || stream.transport === 'external';
                  return (
                    <li key={stream.id} className="flex items-start gap-3 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-3">
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-line break-words text-sm font-medium text-white">{stream.name || group.addonName}</p>
                        {stream.description ? <p className="mt-1 line-clamp-4 whitespace-pre-line break-words text-xs text-[var(--loom-muted)]">{stream.description}</p> : null}
                        {note ? <p className="mt-1 text-xs text-[var(--loom-faint)]">{note}</p> : null}
                      </div>
                      {actionable ? (
                        <Button size="sm" disabled={Boolean(busyId)} onClick={() => void choose(group, stream)} className="shrink-0 gap-1.5">
                          {stream.transport === 'external' ? <ExternalLink className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 fill-current" />}
                          {busyId === stream.id ? 'Opening…' : stream.transport === 'external' ? 'Open' : 'Play'}
                        </Button>
                      ) : <span className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/70">Can’t play</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
        <div className="flex justify-end gap-2">
          {(error && !groups) || groups?.some(group => group.status === 'error') ? (
            <Button variant="outline" size="sm" onClick={() => load()} className="gap-1.5"><RefreshCw className="h-3.5 w-3.5" /> Try again</Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
