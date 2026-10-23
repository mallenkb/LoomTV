import { SourceListShimmer } from './ContentShimmer';
import SourceFilterDropdown from './SourceFilterDropdown';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addonResolutionOptions, sourceResolution, filterAddonSources, sortAddonSources, torrentSource, type AddonSourceSort, useAddonSourcePreferences, type AddonResolution } from '@/lib/addonSourcePreferences';
import { ArrowLeft, Download, ExternalLink, Link, LoaderCircle, Magnet, Play, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import TrailerDialog from '@/components/TrailerDialog';
import { useProfiles } from '@/contexts/ProfileContext';
import { desktopApi } from '@/lib/desktopApi';
import { addonProgressKey } from '@/lib/addonWatchHistory';
import { useProgressSnapshot } from '@/lib/progress';
import { sourceFingerprint, successfulSourceKey } from '@/lib/addonSourceHistory';
import {
  StaleAddonSourceError, invalidateRequests, loadAddonSources, requireUsableSource,
  type AddonSourceGroup, type AddonVideoTarget,
} from '@/lib/addonPlayback';
import type { StremioStreamDescriptor } from '@/shared/desktopProtocol';
import type { StremioServiceStatus, StremioTorrentPreparation } from '@/shared/stremioService';

type SourceAction = 'copy-stream' | 'copy-magnet' | 'download';

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

function SourceDescriptionLine({ line }: { line: string }) {
  // Keep the provider's values intact; only separate its metadata groups.
  if (!/👤|💾|⚙/u.test(line)) return <span className="block truncate" title={line}>{line}</span>;
  const parts = line.split(/(?=👤|💾|⚙)/u).map(part => part.trim()).filter(Boolean);
  return <span className="flex flex-wrap items-center gap-x-5 gap-y-1.5 py-0.5 tabular-nums">
    {parts.map((part, index) => {
      const match = /^(👤|💾|⚙\uFE0F?)\s*(.*)$/u.exec(part);
      return <span key={index} className="inline-flex min-w-0 items-center gap-1.5">
        {match ? <><span aria-hidden="true" className="shrink-0">{match[1]}</span><span className="break-words" title={match[1] === '👤' ? 'Reported seeders' : match[1] === '💾' ? 'File size' : 'Source'}>{match[2]}</span></> : part}
      </span>;
    })}
  </span>;
}

function streamNote(stream: StremioStreamDescriptor): string {
  if (stream.transport === 'torrent') return 'Plays in LoomTV. Loading may take longer while connecting to peers.';
  if (stream.transport === 'peer-to-peer') return stream.reason || 'This peer-to-peer reference is not supported.';
  if (stream.transport === 'unsupported') return stream.reason || 'LoomTV cannot play this source type.';
  if (stream.requestHeadersRequired) return 'This source requires request headers LoomTV does not support.';
  if (stream.transport === 'external') return `Opens ${hostOf(stream.externalUrl || '')} in your browser.`;
  return '';
}

/** `requested` is the target prop this list was loaded for; `target` may be its refreshed form. */
type LoadState = { requested: AddonVideoTarget; target: AddonVideoTarget; profileId: string; generation: number; groups: AddonSourceGroup[] };

/**
 * Lists every source for one video, grouped by add-on, and starts the chosen
 * one. A movie page can show this inline; episodes open it after selection.
 * Loading a source list does not start torrent connections or playback.
 * All state belongs to the current target and profile, and a source that
 * changed while the list was open is reloaded instead of used.
 */
export default function AddonSourcePicker({ target, onClose, onPlay, presentation = 'dialog', autoPlay = false, resumeLastSource = false, hideResumeLoader = false, compact = false, onShowSources, compactRows = false, selectedSourceId }: {
  target: AddonVideoTarget | null;
  onClose?: () => void;
  onPlay: (selection: AddonStreamSelection) => void;
  presentation?: 'dialog' | 'inline' | 'player';
  autoPlay?: boolean;
  resumeLastSource?: boolean;
  hideResumeLoader?: boolean;
  compact?: boolean;
  compactRows?: boolean;
  selectedSourceId?: string;
  onShowSources?: () => void;
}) {
  const { activeProfile, generation } = useProfiles();
  const sourcePreferences = useAddonSourcePreferences();
  const progress = useProgressSnapshot();
  const watched = target ? progress[addonProgressKey(target)] : undefined;
  const watchedPercent = watched && watched.duration > 0
    ? Math.min(100, Math.max(0, watched.position / watched.duration * 100)) : 0;
  const watchedBar = watchedPercent > 0 ? (
    <span role="progressbar" aria-label="Watched" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(watchedPercent)}
      className="mt-3 block h-1 w-full overflow-hidden rounded-full bg-white/20">
      <span className="block h-full rounded-full bg-[var(--loom-accent)]" style={{ width: `${watchedPercent}%` }} />
    </span>
  ) : null;
  const [providerFilter, setProviderFilter] = useState('all');
  const [torrentSources, setTorrentSources] = useState<string[]>([]);
  const [sortOrder, setSortOrder] = useState<AddonSourceSort>('preferred');
  const [quality, setQuality] = useState<AddonResolution[] | null>(null);
  const attempted = useRef(new Set<string>());
  const playbackStarted = useRef(false);
  const profileId = activeProfile?.id || '';
  const recentKey = successfulSourceKey(profileId, target?.type, target?.videoId);
  const [resumePending, setResumePending] = useState(resumeLastSource);
  const lastSource = useMemo(() => {
    try { return localStorage.getItem(recentKey); } catch { return null; }
  }, [recentKey]);
  const startPlayback = useCallback((selection: AddonStreamSelection) => {
    onPlay(selection);
  }, [onPlay]);
  const [loaded, setLoaded] = useState<LoadState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');
  const [service, setService] = useState<StremioServiceStatus | null>(null);
  const [checkingService, setCheckingService] = useState(false);
  const [torrentConsent, setTorrentConsent] = useState(false);
  const [torrent, setTorrent] = useState<{ requestId: number; list: LoadState; group: AddonSourceGroup; stream: StremioStreamDescriptor; prepared: StremioTorrentPreparation; action?: SourceAction } | null>(null);
  // Bound to the target and profile that opened it, so a later target or
  // profile never shows it, even for the render before the reset runs.
  const [youtube, setYoutube] = useState<{ id: string; title: string; target: AddonVideoTarget; profileId: string } | null>(null);
  const request = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const preparedReference = useRef<string | null>(null);
  const releasePreparation = useCallback(() => {
    const reference = preparedReference.current;
    preparedReference.current = null;
    if (reference) void desktopApi.stopStremioPlayback(reference).catch(() => { /* Host shutdown also releases preparations. */ });
  }, []);
  const close = useCallback(() => {
    invalidateRequests(request);
    pending.current?.abort();
    releasePreparation();
    playbackStarted.current = true;
    onClose?.();
  }, [onClose, releasePreparation]);

  const load = useCallback((message = '', refreshInline = false) => {
    releasePreparation();
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const current = ++request.current;
    attempted.current.clear(); playbackStarted.current = false;
    setResumePending(resumeLastSource);
    setLoaded(null); setError(''); setNotice(message); setBusyId(''); setYoutube(null);
    setTorrent(null); setTorrentConsent(false); setService(null); setCheckingService(false);
    if (!target || !profileId) return;
    const update = (result: { target: AddonVideoTarget; groups: AddonSourceGroup[] }) => {
      if (current === request.current && !controller.signal.aborted) setLoaded({ ...result, requested: target, profileId, generation });
    };
    void loadAddonSources(target, { signal: controller.signal, refreshInline, onUpdate: update }).then((result) => {
      update(result);
    }).catch((failure) => {
      if (current === request.current) { setResumePending(false); setError(failure instanceof Error ? failure.message : 'Sources could not be loaded.'); }
    });
  }, [profileId, generation, target, releasePreparation, resumeLastSource]);

  useEffect(() => {
    load();
    return () => { invalidateRequests(request); pending.current?.abort(); releasePreparation(); };
  }, [load, releasePreparation]);

  // A list loaded for another target or profile is never shown or used.
  const visibleList = loaded && loaded.requested === target && loaded.profileId === profileId && loaded.generation === generation ? loaded : null;

  const choose = useCallback(async (group: AddonSourceGroup, stream: StremioStreamDescriptor) => {
    const list = visibleList;
    if (!list || busyId) return;
    const requestId = request.current;
    setBusyId(stream.id); setError(''); setNotice('');
    try {
      // Access, approval, manifest, or configuration can change while the list is open.
      await requireUsableSource(group.addonId, group.revision);
      if (requestId !== request.current || list.profileId !== profileId) return;
      if (stream.transport === 'torrent' && stream.playbackReference) {
        if (!torrentConsent && !autoPlay && !compactRows) throw new Error('Allow torrent connections before continuing.');
        const signal = pending.current?.signal;
        if (!signal) return;
        releasePreparation();
        preparedReference.current = stream.playbackReference;
        setNotice('Connecting to peers…');
        const prepared = await desktopApi.prepareStremioTorrent(stream.playbackReference, signal);
        if (requestId !== request.current || signal.aborted) return;
        if ((autoPlay || compactRows) && prepared.suggestedIndex !== undefined && prepared.selectionReason !== 'choose') {
          const reference = await desktopApi.selectStremioTorrent(stream.playbackReference, prepared.suggestedIndex);
          if (requestId !== request.current || signal.aborted) { await desktopApi.stopStremioPlayback(reference); return; }
          preparedReference.current = null;
          playbackStarted.current = true;
          startPlayback({ target: list.target, addonId: group.addonId, addonName: group.addonName,
            stream: { ...stream, playbackReference: reference }, url: reference });
        } else {
          setResumePending(false);
          setTorrent({ requestId, list, group, stream, prepared }); setNotice('');
        }
      } else if ((stream.transport === 'media' || stream.transport === 'hls') && stream.playbackReference) {
        const valid = await desktopApi.validateStremioPlayback(stream.playbackReference);
        if (requestId !== request.current) return;
        if (!valid) {
          if (autoPlay) throw new Error('This source expired. Refresh sources to request a new link.');
          load('This source expired. Choose a source from the refreshed list.', true); return;
        }
        playbackStarted.current = true;
        startPlayback({ target: list.target, addonId: group.addonId, addonName: group.addonName, stream, url: stream.playbackReference });
      } else if (stream.transport === 'youtube' && stream.ytId) {
        if (target) setYoutube({ id: stream.ytId, title: list.target.title, target, profileId });
      } else if (stream.transport === 'external' && stream.externalUrl) {
        desktopApi.openExternal(stream.externalUrl);
      }
    } catch (failure) {
      if (requestId !== request.current) return;
      setResumePending(false);
      if (failure instanceof StaleAddonSourceError && !autoPlay) load(`${failure.message} The list was reloaded.`, true);
      else { releasePreparation(); setError(failure instanceof Error ? failure.message : 'This source could not be opened.'); }
    } finally {
      if (requestId === request.current) { setBusyId(''); if (stream.transport === 'torrent') setNotice(''); }
    }
  }, [visibleList, busyId, profileId, torrentConsent, autoPlay, compactRows, releasePreparation, startPlayback, load, target]);

  const checkService = async () => {
    const current = request.current;
    setCheckingService(true);
    try {
      const status = await desktopApi.getStremioServiceStatus();
      if (request.current === current) setService(status);
    } catch { if (request.current === current) setService({ available: false, message: 'The torrent engine could not be checked.' }); }
    finally { if (request.current === current) setCheckingService(false); }
  };

  const finishSourceAction = async (reference: string, action: SourceAction, title: string, ownsReference = false) => {
    try {
      await desktopApi.stremioSourceAction(reference, action, title.slice(0, 256));
    } catch (error) {
      if (ownsReference) await desktopApi.stopStremioPlayback(reference);
      throw error;
    }
    return action === 'copy-magnet' ? 'Magnet link copied.' : action === 'copy-stream'
      ? 'Stream link copied. It works while LoomTV is running and source access remains available.' : 'Download requested. Torrent sources open in your default torrent app; direct videos use the save dialog.';
  };

  const runSourceAction = async (group: AddonSourceGroup, stream: StremioStreamDescriptor, action: SourceAction) => {
    const list = visibleList;
    if (!list || busyId || !stream.playbackReference) return;
    const current = request.current;
    setBusyId(stream.id); setError(''); setNotice('');
    try {
      await requireUsableSource(group.addonId, group.revision);
      if (current !== request.current) return;
      let reference = stream.playbackReference;
      let ownsReference = false;
      if (stream.transport === 'torrent' && action === 'copy-stream') {
        if (!torrentConsent && !autoPlay && !compactRows) throw new Error('Allow torrent connections before continuing.');
        const signal = pending.current?.signal;
        if (!signal) return;
        releasePreparation();
        preparedReference.current = reference;
        setNotice('Connecting to peers…');
        const prepared = await desktopApi.prepareStremioTorrent(reference, signal);
        if (current !== request.current || signal.aborted) return;
        if (prepared.suggestedIndex === undefined || prepared.selectionReason === 'choose') {
          setTorrent({ requestId: current, list, group, stream, prepared, action });
          setNotice('Choose the video file for this action.');
          return;
        }
        reference = await desktopApi.selectStremioTorrent(reference, prepared.suggestedIndex);
        ownsReference = true;
        preparedReference.current = null;
        if (current !== request.current || signal.aborted) { await desktopApi.stopStremioPlayback(reference); return; }
      }
      const message = await finishSourceAction(reference, action, list.target.title, ownsReference);
      if (current === request.current) setNotice(message);
    } catch (failure) {
      if (current === request.current) { releasePreparation(); setError(failure instanceof Error ? failure.message : 'The source action failed.'); }
    } finally { if (current === request.current) setBusyId(''); }
  };

  const playTorrentFile = async (index: number) => {
    if (!torrent || !visibleList || torrent.requestId !== request.current || torrent.list.profileId !== profileId
      || torrent.list.generation !== generation || torrent.list.requested !== target || !torrent.stream.playbackReference || busyId) return;
    const current = request.current;
    setBusyId(torrent.stream.id); setError('');
    try {
      await requireUsableSource(torrent.group.addonId, torrent.group.revision);
      if (current !== request.current) return;
      const reference = await desktopApi.selectStremioTorrent(torrent.stream.playbackReference, index);
      if (current !== request.current) { await desktopApi.stopStremioPlayback(reference); return; }
      preparedReference.current = null;
      if (torrent.action) {
        const message = await finishSourceAction(reference, torrent.action, torrent.list.target.title, true);
        if (current === request.current) { setTorrent(null); setNotice(message); }
      } else {
        startPlayback({ target: torrent.list.target, addonId: torrent.group.addonId, addonName: torrent.group.addonName,
          stream: { ...torrent.stream, playbackReference: reference }, url: reference });
      }
    } catch (failure) {
      if (current === request.current) setError(failure instanceof Error ? failure.message : 'The selected file could not be opened.');
    } finally { if (current === request.current) setBusyId(''); }
  };

  const torrentSourceOptions = useMemo(() => [...new Set(visibleList?.groups.flatMap(group => group.streams.map(torrentSource)) || [])].sort((a, b) => a.localeCompare(b)), [visibleList]);
  const groups = useMemo(() => visibleList?.groups.map(group => ({
    ...group, streams: filterAddonSources(group.streams.filter(stream => !torrentSources.length || torrentSources.includes(torrentSource(stream))), quality ? { ...sourcePreferences, resolutions: quality } : sourcePreferences),
  })) || null, [visibleList, sourcePreferences, quality, torrentSources]);

  const displayGroups = useMemo(() => {
    const filtered = groups?.filter(group => !compactRows || providerFilter === 'all' || group.addonId === providerFilter) || [];
    const recentGroup = filtered.find(group => group.streams.some(stream => sourceFingerprint(group.addonId, stream) === lastSource));
    const recentStream = recentGroup?.streams.find(stream => sourceFingerprint(recentGroup.addonId, stream) === lastSource);
    return [
      ...(recentGroup && recentStream ? [{ ...recentGroup, sectionTitle: 'Last played', sectionKey: 'last-played', streams: [recentStream] }] : []),
      ...filtered.map(group => ({ ...group, sectionTitle: group.addonName, sectionKey: group.addonId,
        streams: sortAddonSources(group.streams.filter(stream => !(group === recentGroup && stream === recentStream)), sortOrder) })),
    ].filter(group => group.streams.length || group.status !== 'ready' || !recentStream);
  }, [groups, compactRows, providerFilter, lastSource, sortOrder]);

  useEffect(() => {
    if (!resumePending || !visibleList || busyId || torrent || playbackStarted.current) return;
    const eligible = (stream: StremioStreamDescriptor) => Boolean(stream.playbackReference)
      && !stream.requestHeadersRequired && ['media', 'hls', 'torrent'].includes(stream.transport);
    const candidates = visibleList.groups.map(group => ({ ...group,
      streams: filterAddonSources(group.streams, sourcePreferences).filter(eligible),
    }));
    let group = candidates.find(candidate => candidate.status === 'ready'
      && candidate.streams.some(stream => sourceFingerprint(candidate.addonId, stream) === lastSource));
    let stream: StremioStreamDescriptor | undefined;
    if (group) {
      const groupId = group.addonId;
      stream = group.streams.find(candidate => sourceFingerprint(groupId, candidate) === lastSource);
    }
    const complete = visibleList.groups.every(candidate => candidate.status !== 'loading');
    const preference = visibleList.target.preferredSource;
    if (!stream && complete && preference) {
      group = candidates.find(candidate => candidate.addonId === preference.addonId && candidate.status === 'ready');
      stream = group?.streams.find(candidate => sourceResolution(candidate) === preference.resolution) || group?.streams[0];
    }
    if (group && stream) {
      const key = `${group.addonId}:${stream.id}`;
      if (attempted.current.has(key)) { setResumePending(false); return; }
      attempted.current.add(key);
      void choose(group, stream);
    } else if (complete || (!lastSource && !preference)) {
      setResumePending(false);
    }
  }, [resumePending, visibleList, busyId, torrent, lastSource, choose, sourcePreferences]);

  useEffect(() => {
    if (!autoPlay || !groups || groups.some(group => group.status === 'loading') || busyId || torrent || playbackStarted.current) return;
    for (const group of groups) {
      if (group.status !== 'ready') continue;
      const stream = group.streams.find(candidate => candidate.playbackReference && !candidate.requestHeadersRequired
        && ['media', 'hls', 'torrent'].includes(candidate.transport) && !attempted.current.has(`${group.addonId}:${candidate.id}`));
      if (!stream) continue;
      attempted.current.add(`${group.addonId}:${stream.id}`);
      void choose(group, stream);
      break;
    }
  }, [autoPlay, groups, busyId, torrent, choose]);

  if (resumePending && hideResumeLoader) return null;
  if (resumePending) return <Dialog open={Boolean(target)} onOpenChange={open => { if (!open) close(); }}
    contentClassName="max-w-lg border border-[var(--loom-border)] bg-[var(--loom-surface)] text-[var(--loom-text)]">
    <DialogContent className="p-8 text-center">
      <DialogTitle className="loom-player-loading-title text-xl">{target?.title}</DialogTitle>
      <DialogDescription className="sr-only">Resuming your last played source.</DialogDescription>
      <Button variant="outline" className="mt-6" onClick={close}>Cancel</Button>
    </DialogContent>
  </Dialog>;

  if (youtube && target && youtube.target === target && youtube.profileId === profileId && visibleList) {
    return <TrailerDialog open title={youtube.title} label={`${youtube.title} on YouTube`} trailerUrl={youtube.id} onClose={() => setYoutube(null)} />;
  }

  const totalStreamCount = visibleList?.groups.reduce((count, group) => count + group.streams.length, 0) || 0;
  const qualityLabel = addonResolutionOptions.filter(option => (quality ?? sourcePreferences.resolutions).includes(option.value)).map(option => option.label).join(', ');
  const readyGroups = groups?.filter(group => group.status === 'ready') || [];
  const streamCount = readyGroups.reduce((count, group) => count + group.streams.length, 0);
  const pendingCount = groups?.filter(group => group.status === 'loading').length || 0;
  const allFailed = Boolean(groups?.length) && groups?.every(group => group.status === 'error');
  const hasTorrents = groups?.some(group => group.streams.some(stream => stream.transport === 'torrent'));
  const selectedTorrent = torrent && visibleList
    && torrent.list.profileId === profileId && torrent.list.generation === generation && torrent.list.requested === target ? torrent : null;
  const summary = !groups ? (error ? 'Sources could not be loaded.' : 'Asking your sources…')
    : groups.length === 0 ? 'None of your enabled add-ons provide streams for this title.'
      : pendingCount ? `${streamCount} sources found. Waiting for ${pendingCount} ${pendingCount === 1 ? 'addon' : 'addons'}...`
      : allFailed ? 'Your sources could not be reached.'
        : streamCount === 0 ? totalStreamCount > 0 ? `No sources match ${qualityLabel}. Choose another quality below or show all resolutions.` : 'Your sources found nothing for this title.'
          : (quality ?? sourcePreferences.resolutions).includes('all') ? `${streamCount} ${streamCount === 1 ? 'source' : 'sources'}` : `${streamCount} of ${totalStreamCount} sources · ${qualityLabel}`;

  const defaultSourceOrderLabel = sourcePreferences.suggestedFirst ? 'Suggested first' : 'Provider order';
  const sortOptions: { value: AddonSourceSort; label: string }[] = [
    { value: 'preferred', label: defaultSourceOrderLabel },
    { value: 'source-asc', label: 'Torrent source: A to Z' },
    { value: 'size-asc', label: 'Size: smallest first' },
    { value: 'size-desc', label: 'Size: largest first' },
    { value: 'seeders-desc', label: 'Seeders: most first' },
    { value: 'seeders-asc', label: 'Seeders: fewest first' },
  ];
  const inline = presentation === 'inline';
  const dialogHeader = (
    <DialogHeader className="shrink-0 bg-[var(--loom-surface)] pb-4 text-left">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1.5">
              <DialogTitle className="text-white">{target?.title || 'Sources'}</DialogTitle>
              <DialogDescription className="text-[var(--loom-muted)]" aria-live="polite">{summary}</DialogDescription>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close sources"
              title="Close sources"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--loom-muted)] hover:text-[var(--loom-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </DialogHeader>
  );
  const content = (
      <div className="loom-source-picker space-y-4">
        {inline ? (
          <header className="space-y-1">
            {!compactRows ? <h2 className="text-lg font-semibold text-[var(--loom-text)]">Sources</h2> : null}
            <p className="text-sm text-[var(--loom-muted)]" aria-live="polite">{summary}</p>
          </header>
        ) : null}
        <div className={`sticky top-0 z-20 -mx-3 grid gap-3 bg-[var(--loom-surface)] px-3 pb-4 ${compactRows ? 'grid-cols-4' : 'grid-cols-3'}`}>
          {compactRows ? <SourceFilterDropdown label="Add-on" selected={[providerFilter]}
            valueLabel={groups?.find(group => group.addonId === providerFilter)?.addonName || 'All add-ons'}
            options={[{ value: 'all', label: 'All add-ons' }, ...(groups?.map(group => ({ value: group.addonId, label: group.addonName })) || [])]}
            onSelect={setProviderFilter} /> : null}
          <SourceFilterDropdown label="Resolution" multiple selected={quality ?? sourcePreferences.resolutions}
            valueLabel={qualityLabel}
            disabled={Boolean(busyId) || Boolean(selectedTorrent)} options={addonResolutionOptions}
            onSelect={value => {
              attempted.current.clear();
              setQuality(current => {
                if (value === 'all') return ['all'];
                const selected: AddonResolution[] = (current ?? sourcePreferences.resolutions).filter(item => item !== 'all');
                const next = selected.includes(value as AddonResolution) ? selected.filter(item => item !== value) : [...selected, value as AddonResolution];
                return next.length ? next : ['all'];
              });
            }} />
          <SourceFilterDropdown label="Sort by" selected={[sortOrder]}
            valueLabel={sortOptions.find(option => option.value === sortOrder)?.label || defaultSourceOrderLabel}
            options={sortOptions} onSelect={value => setSortOrder(value as AddonSourceSort)} />
          <SourceFilterDropdown label="Torrent source" multiple selected={torrentSources.length ? torrentSources : ['']}
            valueLabel={torrentSources.length > 1 ? `${torrentSources.length} sources` : torrentSources[0] || 'All sources'}
            options={[{ value: '', label: 'All sources' }, ...torrentSourceOptions.map(source => ({ value: source, label: source }))]}
            onSelect={source => setTorrentSources(current => !source ? [] : current.includes(source) ? current.filter(item => item !== source) : [...current, source])} />
        </div>
        {streamCount === 0 && totalStreamCount > 0 ? <Button variant="outline" size="sm" onClick={() => { attempted.current.clear(); setQuality(['all']); }}>Show all resolutions</Button> : null}
        {busyId ? <span role="status" aria-live="polite" className="sr-only">{notice || 'Opening source...'}</span> : notice ? <p role="status" className="text-sm text-[var(--loom-muted)]">{notice}</p> : null}
        {error ? <p role="alert" className="rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</p> : null}
        {hasTorrents && !selectedTorrent && !autoPlay && !compactRows ? (
          <section aria-label="Torrent playback" className="space-y-3 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-4 text-sm">
            <p>LoomTV uses the local Stremio service when available, or its built-in torrent engine. The built-in engine limits temporary storage to 16 GB per source.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={checkingService} onClick={() => void checkService()}>{checkingService ? 'Checking...' : 'Check engine'}</Button>
            </div>
            {service ? <p role="status">{service.message}</p> : null}
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={torrentConsent} disabled={Boolean(busyId)} onChange={event => setTorrentConsent(event.target.checked)} className="mt-1" />
              <span>Allow torrent connections for this selection. Peers can see my public IP. Closing playback stops LoomTV's transfers; a shared Stremio service manages its own transfers and cache.</span>
            </label>
          </section>
        ) : null}
        {!groups && !error ? <SourceListShimmer /> : null}
        {selectedTorrent ? (
          <section aria-label="Choose video file" className="space-y-3">
            <h3 className="font-medium">Choose a video file</h3>
            <p className="text-sm text-[var(--loom-muted)]">{selectedTorrent.prepared.notice}</p>
            <ul className="max-h-[45vh] space-y-2 overflow-y-auto">
              {selectedTorrent.prepared.files.map(file => (
                <li key={file.index} className="flex items-center gap-3 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm">{file.name}</p>
                    <p className="text-xs text-[var(--loom-muted)]">{(file.size / 1024 ** 3).toFixed(2)} GB{file.index === selectedTorrent.prepared.suggestedIndex ? selectedTorrent.prepared.selectionReason === 'provider' ? ' · Selected by add-on' : ' · Main video' : ''}</p>
                  </div>
                  <Button size="sm" disabled={Boolean(busyId)} onClick={() => void playTorrentFile(file.index)}>{selectedTorrent.action === 'download' ? 'Download' : selectedTorrent.action === 'copy-stream' ? 'Copy link' : 'Play'}</Button>
                </li>
              ))}
            </ul>
            <Button variant="ghost" size="sm" disabled={Boolean(busyId)} onClick={() => { releasePreparation(); setTorrent(null); }}>Back to sources</Button>
          </section>
        ) : <div className={inline && !compactRows ? 'max-h-[32rem] space-y-4 overflow-y-auto overscroll-contain pr-1' : 'space-y-4'}>{displayGroups.map(group => (
          <section key={group.sectionKey} aria-label={group.sectionTitle} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--loom-faint)]">{group.sectionTitle}</h3>
            {group.status === 'loading' ? (
              <SourceListShimmer count={3} />
            ) : group.status === 'error' ? (
              <p className="text-sm text-red-200">{group.error}</p>
            ) : group.streams.length === 0 ? (
              <p className="text-sm text-[var(--loom-muted)]">{(quality ?? sourcePreferences.resolutions).includes('all') ? 'No sources for this title.' : `No ${qualityLabel} sources. Choose another quality below or show all resolutions.`}</p>
            ) : (
              <ul className="space-y-2">
                {group.streams.map(stream => {
                  const note = streamNote(stream);
                  const selected = selectedSourceId === stream.id || target?.selectedSourceFingerprint === sourceFingerprint(group.addonId, stream);
                  const played = sourceFingerprint(group.addonId, stream) === lastSource;
                  const actionable = stream.transport === 'media' || stream.transport === 'hls' || stream.transport === 'torrent' || stream.transport === 'youtube' || stream.transport === 'external';
                  const sourceActions = stream.playbackReference && ['media', 'hls', 'torrent'].includes(stream.transport) ? <SourceFilterDropdown
                    actions label={`Source actions for ${stream.name || group.addonName}`} valueLabel="Source actions" selected={[]}
                    disabled={Boolean(busyId)} options={[
                      { value: 'copy-stream', label: 'Copy stream link', icon: <Link aria-hidden="true" className="h-4 w-4 shrink-0" /> },
                      ...(stream.transport === 'torrent' ? [{ value: 'copy-magnet', label: 'Copy magnet link', icon: <Magnet aria-hidden="true" className="h-4 w-4 shrink-0" /> }] : []),
                      { value: 'download', label: stream.transport === 'torrent' ? 'Download via magnet link' : 'Download video', disabled: stream.transport === 'hls', icon: <Download aria-hidden="true" className="h-4 w-4 shrink-0" /> },
                    ]} onSelect={value => void runSourceAction(group, stream, value as SourceAction)} /> : null;
                  if (compactRows) return (
                    <li key={stream.id} className="relative -mx-3">
                      <button type="button" disabled={!actionable || Boolean(busyId)} onClick={() => void choose(group, stream)}
                        aria-label={`${stream.transport === 'external' ? 'Open provider' : stream.transport === 'youtube' ? 'Play trailer' : 'Play'} ${stream.name || group.addonName}: ${stream.description?.split('\n')[0] || 'source'}`}
                        aria-pressed={selected}
                        aria-busy={busyId === stream.id}
                        className={`grid w-full grid-cols-[112px_minmax(0,1fr)_auto] gap-4 rounded-xl py-4 pl-3 pr-14 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${busyId === stream.id ? 'bg-[var(--loom-surface-2)] disabled:opacity-100' : group.sectionKey === 'last-played' ? 'bg-[var(--loom-surface-2)] disabled:opacity-60' : 'disabled:opacity-60'} ${selected ? 'bg-[var(--loom-surface-2)] ring-1 ring-[var(--loom-accent)]' : 'hover:bg-[var(--loom-surface-2)]'}`}>
                        <span className="min-w-0 text-sm font-medium"><span className="whitespace-pre-line break-words">{stream.name || group.addonName}</span>{played && actionable && stream.transport !== 'youtube' && stream.transport !== 'external' ? watchedBar : null}</span>
                        <span className="min-w-0 space-y-1 text-sm text-[var(--loom-muted)]">
                          {stream.description?.split('\n').map((line, index) => index === 0
                            ? <span key={index} className="block truncate text-[var(--loom-text)]" title={line}>{line}</span>
                            : <SourceDescriptionLine key={index} line={line} />)}
                          {selected ? <span className="block text-[var(--loom-accent)]">Selected</span> : !actionable ? <span className="block">{note}</span> : null}
                        </span>
                        {actionable ? <span aria-hidden="true" className="inline-flex h-10 w-10 shrink-0 items-center justify-center self-center rounded-full bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]">
                          {busyId === stream.id ? <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" />
                            : stream.transport === 'external' ? <ExternalLink className="h-4 w-4" />
                            : <Play className="h-4 w-4 fill-current" />}
                        </span> : null}
                      </button>
                      {sourceActions ? <div className="absolute right-3 top-1/2 -translate-y-1/2">{sourceActions}</div> : null}
                    </li>
                  );
                  return (
                    <li key={stream.id} className="flex items-start gap-3 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-3">
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-line break-words text-sm font-medium text-white">{stream.name || group.addonName}</p>
                        {played && actionable && stream.transport !== 'youtube' && stream.transport !== 'external' ? <div className="max-w-28">{watchedBar}</div> : null}
                        {stream.description ? <div className="mt-1 space-y-1 text-xs text-[var(--loom-muted)]">{stream.description.split('\n').map((line, index) => <SourceDescriptionLine key={index} line={line} />)}</div> : null}
                        {note ? <p className="mt-1 text-xs text-[var(--loom-faint)]">{note}</p> : null}
                      </div>
                      {actionable ? (
                        <Button size="icon" aria-label={`${busyId === stream.id ? 'Opening' : stream.transport === 'external' ? 'Open provider' : stream.transport === 'torrent' ? 'Choose file' : 'Play'} ${stream.name || group.addonName}`} disabled={Boolean(busyId) || (stream.transport === 'torrent' && !torrentConsent && !autoPlay && !compactRows)} onClick={() => void choose(group, stream)} className="shrink-0 rounded-full">
                          {busyId === stream.id ? <LoaderCircle aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" /> : stream.transport === 'external' ? <ExternalLink aria-hidden="true" className="h-4 w-4" /> : <Play aria-hidden="true" className="h-4 w-4 fill-current" />}
                        </Button>
                      ) : <span className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/70">Can’t play</span>}
                      {sourceActions}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}</div>}
        <div className="flex justify-end gap-2">
          {groups || error ? (
            <Button variant="outline" size="sm" disabled={Boolean(busyId)} onClick={() => load('', true)} className="gap-1.5"><RefreshCw className="h-3.5 w-3.5" /> Refresh sources</Button>
          ) : null}
          {!inline ? <Button variant="ghost" size="sm" onClick={close}>Close</Button> : null}
        </div>
      </div>
  );

  if (compact && !selectedTorrent) return (
    <div className="mx-auto max-w-lg space-y-4 rounded-2xl bg-[var(--loom-bg)] p-5 text-center text-[var(--loom-text)]">
      <p role="status">{busyId ? notice || 'Opening source…' : !groups || pendingCount ? 'Finding playback sources…' : error || summary}</p>
      {groups?.filter(group => group.status === 'error').map(group => <p key={group.addonId} role="alert" className="text-sm text-[var(--loom-muted)]">{group.addonName}: {group.error}</p>)}
      <Button variant="outline" onClick={onShowSources}>Sources / Quality</Button>
      {!busyId && !pendingCount && (error || allFailed) ? <Button className="ml-2" onClick={() => load('', true)}>Retry sources</Button> : null}
      {streamCount === 0 && totalStreamCount > 0 && !pendingCount ? <Button className="ml-2" onClick={() => { attempted.current.clear(); setQuality(['all']); }}>Try all resolutions</Button> : null}
    </div>
  );

  if (inline) return target ? (
    <section aria-label={`Sources for ${target.title}`} className="rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-5 text-[var(--loom-text)]">
      {content}
    </section>
  ) : null;

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(open) => { if (!open) close(); }}
      className={presentation === 'player' ? 'p-0' : undefined}
      contentClassName={presentation === 'player' ? 'h-dvh max-h-none w-screen max-w-none rounded-none border-0 bg-black p-0 text-[var(--loom-text)]' : '!overflow-hidden max-w-[min(92vw,44rem)] border border-[var(--loom-border)] bg-[var(--loom-surface)] p-0 text-[var(--loom-text)] shadow-2xl'}
    >
      <DialogContent className={presentation === 'player' ? 'flex h-full min-h-0 flex-col' : 'flex max-h-[calc(85vh-40px)] min-h-0 flex-col'}>
        {presentation === 'player' ? (
          <div className="shrink-0 border-b border-[var(--loom-border)] bg-[var(--loom-bg)] px-5 pb-3 pt-10">
            <Button variant="outline" onClick={close} className="gap-2"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Back</Button>
          </div>
        ) : null}
        {presentation !== 'player' ? dialogHeader : null}
        <div className={presentation === 'player' ? 'min-h-0 flex-1 overflow-y-auto p-5' : 'min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain -mx-3 px-3'}>
          {presentation === 'player' ? dialogHeader : null}
          <div className={presentation === 'player' ? 'mx-auto max-w-4xl' : undefined}>{content}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
