import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  FolderOpen,
  Headphones,
  Library as LibraryIcon,
  ListMusic,
  Music,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useConfirm } from '@/components/ConfirmProvider';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useProfiles } from '@/contexts/ProfileContext';
import { useTheme } from '@/components/ThemeProvider';
import { desktopApi } from '@/lib/desktopApi';
import type {
  MediaLibrariesApi,
  MediaLibraryItem,
  MediaLibraryKind,
  MediaLibraryPage,
  MediaLibraryRoot,
} from '@/shared/mediaLibraries';

type MediaViewId = 'library' | 'inProgress' | 'creators' | 'collections' | 'tracks' | 'folders';
type PublicationEntry = { name: string; url: string };
type Publication = { entries: PublicationEntry[] };
type ReaderItem = { kind: MediaLibraryKind; item: MediaLibraryItem; url?: string; publication?: Publication };

type MediaLibraryConfig = {
  title: string;
  singular: string;
  icon: LucideIcon;
  views: Array<{ id: MediaViewId; label: string }>;
  audio: boolean;
  trackNumbers?: boolean;
};

const MEDIA_CONFIGS: Record<MediaLibraryKind, MediaLibraryConfig> = {
  music: {
    title: 'Music',
    singular: 'track',
    icon: Music,
    views: [
      { id: 'library', label: 'Albums' },
      { id: 'creators', label: 'Artists' },
      { id: 'tracks', label: 'Tracks' },
      { id: 'folders', label: 'Folders' },
    ],
    audio: true,
    trackNumbers: true,
  },
  audiobooks: {
    title: 'Audiobooks',
    singular: 'audiobook',
    icon: Headphones,
    views: [
      { id: 'library', label: 'Library' },
      { id: 'inProgress', label: 'In progress' },
      { id: 'creators', label: 'Authors' },
      { id: 'folders', label: 'Folders' },
    ],
    audio: true,
  },
  books: {
    title: 'Books',
    singular: 'book',
    icon: BookOpen,
    views: [
      { id: 'library', label: 'Library' },
      { id: 'inProgress', label: 'In progress' },
      { id: 'creators', label: 'Authors' },
      { id: 'folders', label: 'Folders' },
    ],
    audio: false,
  },
  comics: {
    title: 'Comics and manga',
    singular: 'comic',
    icon: LibraryIcon,
    views: [
      { id: 'library', label: 'Series' },
      { id: 'inProgress', label: 'In progress' },
      { id: 'collections', label: 'Volumes' },
      { id: 'folders', label: 'Folders' },
    ],
    audio: false,
  },
};

const PAGE_SIZE_FALLBACK = 48;

function configFor(kind: MediaLibraryKind): MediaLibraryConfig {
  return MEDIA_CONFIGS[kind];
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  if (minutes < 60) return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function formatProgress(item: MediaLibraryItem): string {
  if (item.completed) return 'Finished';
  if (item.position > 0 && item.duration > 0) {
    return `${formatDuration(item.position)} of ${formatDuration(item.duration)}`;
  }
  if (item.position > 0) return `${formatDuration(item.position)} played`;
  return '';
}

function extensionLabel(extension: string): string {
  return extension.replace(/^\./, '').toUpperCase();
}

function dirname(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash > 0 ? relativePath.slice(0, slash) : 'Root folder';
}

function groupKey(kind: MediaLibraryKind, view: MediaViewId, item: MediaLibraryItem): string {
  if (view === 'folders') return dirname(item.relativePath);
  if (view === 'creators') return item.creator || 'Unknown creator';
  if (view === 'collections' || view === 'tracks') return item.collection || 'Unsorted';
  if (kind === 'music') return item.collection || 'Singles and loose tracks';
  if (kind === 'comics') return item.collection || 'Unsorted series';
  return item.creator || 'Unknown author';
}

function groupItems(kind: MediaLibraryKind, view: MediaViewId, items: MediaLibraryItem[]): Array<[string, MediaLibraryItem[]]> {
  const groups = new Map<string, MediaLibraryItem[]>();
  for (const item of items) {
    const key = groupKey(kind, view, item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function normalizeArchiveName(name: string): string {
  return name.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function elementsByLocalName(documentNode: Document, localName: string): Element[] {
  const expected = localName.toLowerCase();
  return [...documentNode.querySelectorAll('*')].filter((element) => (element.localName || element.tagName).toLowerCase() === expected);
}

function decodedArchiveNames(name: string): string[] {
  const normalized = normalizeArchiveName(name);
  try {
    const decoded = normalizeArchiveName(decodeURIComponent(normalized));
    return decoded === normalized ? [normalized] : [normalized, decoded];
  } catch {
    return [normalized];
  }
}

function findPublicationEntry(entries: PublicationEntry[], name: string): PublicationEntry | undefined {
  const candidates = decodedArchiveNames(name);
  return entries.find((entry) => candidates.includes(normalizeArchiveName(entry.name)))
    || entries.find((entry) => candidates.some((candidate) => candidate.toLowerCase() === normalizeArchiveName(entry.name).toLowerCase()));
}

function resolveArchiveName(baseName: string, href: string): string | null {
  const raw = href.split('#', 1)[0].trim();
  if (!raw || raw.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(raw)) return null;
  const parts = normalizeArchiveName(baseName).split('/');
  parts.pop();
  for (const part of normalizeArchiveName(raw).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] || character);
}

function safeChapterDocument(source: string, chapterName: string, entries: PublicationEntry[]): { title: string; srcDoc: string } {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(source, 'application/xhtml+xml');
  const hasParserError = parsed.querySelector('parsererror');
  const documentNode = hasParserError ? parser.parseFromString(source, 'text/html') : parsed;
  const removable = 'script, iframe, object, embed, form, input, button, link, meta, base, audio, video, source, canvas, style';
  documentNode.querySelectorAll(removable).forEach((node) => node.remove());
  documentNode.querySelectorAll('*').forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const attributeName = attribute.name.toLowerCase();
      if (attributeName.startsWith('on') || attributeName === 'srcset' || attributeName === 'formaction') {
        element.removeAttribute(attribute.name);
        return;
      }
      if (attributeName === 'src' || attributeName === 'poster' || attributeName === 'data' || attributeName.endsWith(':href')) {
        if (element.tagName.toLowerCase() !== 'img' || attributeName !== 'src') element.removeAttribute(attribute.name);
        return;
      }
      if (attributeName === 'href') {
        if (!attribute.value.startsWith('#')) element.removeAttribute(attribute.name);
        return;
      }
      if (attributeName === 'style') {
        element.setAttribute(attribute.name, attribute.value.replace(/url\s*\([^)]*\)/gi, ''));
      }
    });
    if (element.tagName.toLowerCase() === 'img') {
      const src = element.getAttribute('src');
      const resolved = src ? resolveArchiveName(chapterName, src) : null;
      const imageEntry = resolved ? findPublicationEntry(entries, resolved) : undefined;
      if (imageEntry) {
        element.setAttribute('src', imageEntry.url);
      } else {
        element.removeAttribute('src');
      }
    }
  });
  const title = documentNode.querySelector('title')?.textContent?.trim() || chapterName.split('/').pop() || 'Chapter';
  const body = documentNode.body?.innerHTML || documentNode.documentElement?.innerHTML || escapeHtml(source);
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src loomtv: data:; style-src 'unsafe-inline'; font-src 'none';"><style>html,body{background:#101114;color:#f4f4f5;margin:0;padding:1.5rem;font:16px/1.7 system-ui,sans-serif}body{max-width:52rem;margin:auto}img{max-width:100%;height:auto}a{color:#a5b4fc}blockquote{border-left:3px solid #52525b;padding-left:1rem;color:#d4d4d8}</style></head><body>${body}</body></html>`;
  return { title, srcDoc };
}

async function fetchPublicationText(entry: PublicationEntry): Promise<string> {
  const response = await fetch(entry.url);
  if (!response.ok) throw new Error(`Could not read ${entry.name} (${response.status}).`);
  const text = await response.text();
  if (text.length > 4_000_000) throw new Error(`${entry.name} is too large to render in the reader.`);
  return text;
}

type MediaItemCardProps = {
  item: MediaLibraryItem;
  config: MediaLibraryConfig;
  onOpen: (item: MediaLibraryItem) => void;
  onPlay?: (item: MediaLibraryItem) => void;
  onQueue?: (item: MediaLibraryItem) => void;
  busy: boolean;
};

function MediaItemCard({ item, config, onOpen, onPlay, onQueue, busy }: MediaItemCardProps) {
  const Icon = config.icon;
  const progress = item.completed
    ? 100
    : item.duration > 0
      ? Math.min(100, Math.max(0, (item.position / item.duration) * 100))
      : item.position > 0 ? 15 : 0;
  const progressText = formatProgress(item);
  return (
    <article className="group min-w-0 overflow-hidden rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] transition-colors hover:border-[var(--loom-accent)]/60">
      <button type="button" onClick={() => onOpen(item)} className="block w-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--loom-accent)]">
        <div className="flex aspect-[1.55] items-center justify-center bg-[var(--loom-surface-2)] text-[var(--loom-muted)] transition-colors group-hover:bg-[var(--loom-surface-3)]">
          <Icon className="h-10 w-10" aria-hidden="true" />
        </div>
        <div className="space-y-1.5 p-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--loom-text)]" title={item.title}>{item.title}</h3>
            <span className="shrink-0 rounded bg-[var(--loom-surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--loom-muted)]">{extensionLabel(item.extension)}</span>
          </div>
          <p className="truncate text-xs text-[var(--loom-muted)]" title={item.creator || item.collection || item.relativePath}>{item.creator || item.collection || item.relativePath}</p>
          <div className="flex items-center gap-2 text-[11px] text-[var(--loom-muted)]">
            {config.trackNumbers && item.track > 0 ? <span>Track {item.track}</span> : null}
            {config.trackNumbers && item.disc && item.disc > 0 ? <span>Disc {item.disc}</span> : null}
            {item.duration > 0 ? <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" aria-hidden="true" />{formatDuration(item.duration)}</span> : null}
          </div>
          {progress > 0 ? <div className="space-y-1.5 pt-1"><div className="h-1 overflow-hidden rounded-full bg-[var(--loom-surface-3)]"><div className="h-full rounded-full bg-[var(--loom-accent)]" style={{ width: `${progress}%` }} /></div>{progressText ? <p className="text-[11px] text-[var(--loom-muted)]">{progressText}</p> : null}</div> : null}
        </div>
      </button>
      {config.audio && onPlay && onQueue ? (
        <div className="flex gap-2 border-t border-[var(--loom-border)] px-3 py-2">
          <button type="button" onClick={() => onPlay(item)} disabled={busy} className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--loom-accent)] px-2 py-1.5 text-xs font-medium text-[var(--loom-accent-foreground)] hover:bg-[var(--loom-accent-hover)] disabled:opacity-50"><Play className="h-3.5 w-3.5" aria-hidden="true" /> Play</button>
          <button type="button" onClick={() => onQueue(item)} disabled={busy} className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--loom-border)] px-2 py-1.5 text-xs font-medium text-[var(--loom-text)] hover:bg-[var(--loom-surface-2)] disabled:opacity-50"><ListMusic className="h-3.5 w-3.5" aria-hidden="true" /> Queue</button>
        </div>
      ) : null}
    </article>
  );
}

type AudioPlayback = { current: MediaLibraryItem; url: string; queue: MediaLibraryItem[] };

type AudioPlayerProps = {
  kind: MediaLibraryKind;
  api: MediaLibrariesApi;
  playback: AudioPlayback;
  onClose: () => void;
  onNext: () => void;
  onQueueRemove: (itemId: string) => void;
  onQueueClear: () => void;
};

function AudioPlayer({ kind, api, playback, onClose, onNext, onQueueRemove, onQueueClear }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const savedPositionRef = useRef(0);
  const [position, setPosition] = useState(playback.current.position);
  const [speed, setSpeed] = useState(1);
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [audioError, setAudioError] = useState<string | null>(null);
  const currentId = playback.current.id;
  const initialPosition = playback.current.position;
  const playbackUrl = playback.url;

  useEffect(() => {
    setPosition(initialPosition);
    savedPositionRef.current = initialPosition;
    setAudioError(null);
  }, [currentId, initialPosition, playbackUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    audio.playbackRate = speed;
    return undefined;
  }, [speed, currentId]);

  useEffect(() => {
    if (!sleepMinutes) return undefined;
    const timer = window.setTimeout(() => {
      audioRef.current?.pause();
      setSleepMinutes(0);
    }, sleepMinutes * 60_000);
    return () => window.clearTimeout(timer);
  }, [sleepMinutes]);

  const savePosition = useCallback((nextPosition: number, completed = false) => {
    if (!Number.isFinite(nextPosition) || (Math.abs(nextPosition - savedPositionRef.current) < 5 && !completed)) return;
    savedPositionRef.current = nextPosition;
    void api.progress(kind, currentId, Math.max(0, nextPosition), completed).catch(() => undefined);
  }, [api, kind, currentId]);

  const seekToChapter = (start: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = start;
    setPosition(start);
    savePosition(start);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-[900] border-t border-[var(--loom-border)] bg-[var(--loom-surface)]/98 px-4 py-3 shadow-2xl backdrop-blur-md sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
        <button type="button" onClick={onClose} aria-label="Close player" className="rounded-full p-2 text-[var(--loom-muted)] hover:bg-[var(--loom-surface-2)] hover:text-[var(--loom-text)]"><X className="h-4 w-4" /></button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--loom-text)]">{playback.current.title}</p>
          <p className="truncate text-xs text-[var(--loom-muted)]">{playback.current.creator || playback.current.collection || playback.current.relativePath}</p>
        </div>
        <audio
          ref={audioRef}
          src={playback.url}
          controls
          autoPlay
          preload="metadata"
          className="h-9 w-full min-w-[220px] max-w-[420px]"
          onLoadedMetadata={(event) => {
            const resumeAt = playback.current.completed ? 0 : Math.max(0, playback.current.position);
            event.currentTarget.currentTime = resumeAt;
            setPosition(resumeAt);
            void event.currentTarget.play().catch(() => undefined);
          }}
          onTimeUpdate={(event) => {
            const next = event.currentTarget.currentTime;
            setPosition(next);
            savePosition(next);
          }}
          onEnded={() => {
            savePosition(audioRef.current?.duration || position, true);
            onNext();
          }}
          onError={() => setAudioError('Chromium could not play this file directly. Try MP3, AAC audio in M4A, or Opus.')}
        />
        <label className="inline-flex items-center gap-2 text-xs text-[var(--loom-muted)]">Speed<select value={speed} onChange={(event) => setSpeed(Number(event.target.value))} className="rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-2 py-1 text-[var(--loom-text)]"><option value={0.75}>0.75×</option><option value={1}>1×</option><option value={1.25}>1.25×</option><option value={1.5}>1.5×</option><option value={2}>2×</option></select></label>
        <label className="inline-flex items-center gap-2 text-xs text-[var(--loom-muted)]">Sleep<select value={sleepMinutes} onChange={(event) => setSleepMinutes(Number(event.target.value))} className="rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-2 py-1 text-[var(--loom-text)]"><option value={0}>Off</option><option value={15}>15 min</option><option value={30}>30 min</option><option value={60}>60 min</option></select></label>
      </div>
      {audioError ? <p role="alert" className="mx-auto mt-2 max-w-6xl text-xs text-red-300">{audioError}</p> : null}
      {playback.current.chapters.length > 0 ? <div className="mx-auto mt-3 flex max-w-6xl items-center gap-2 overflow-x-auto border-t border-[var(--loom-border)] pt-2"><span className="shrink-0 text-xs text-[var(--loom-muted)]">Chapters</span>{playback.current.chapters.map((chapter) => <button type="button" key={`${chapter.title}:${chapter.start}`} onClick={() => seekToChapter(chapter.start)} className="shrink-0 rounded-lg border border-[var(--loom-border)] px-2.5 py-1 text-xs text-[var(--loom-text)] hover:bg-[var(--loom-surface-2)]">{chapter.title}</button>)}</div> : null}
      {playback.queue.length > 0 ? <div className="mx-auto mt-3 flex max-w-6xl items-center gap-2 overflow-x-auto border-t border-[var(--loom-border)] pt-2"><span className="shrink-0 text-xs text-[var(--loom-muted)]">Up next</span>{playback.queue.map((item) => <span key={item.id} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[var(--loom-surface-2)] px-2.5 py-1 text-xs text-[var(--loom-text)]"><span className="max-w-40 truncate">{item.title}</span><button type="button" onClick={() => onQueueRemove(item.id)} aria-label={`Remove ${item.title} from queue`} className="rounded p-0.5 text-[var(--loom-muted)] hover:text-[var(--loom-text)]"><X className="h-3 w-3" /></button></span>)}<button type="button" onClick={onQueueClear} className="shrink-0 text-xs text-[var(--loom-muted)] hover:text-[var(--loom-text)]">Clear queue</button></div> : null}
    </div>
  );
}

type EpubChapter = { name: string; title: string; entry: PublicationEntry; srcDoc?: string };

async function loadEpubChapters(publication: Publication): Promise<EpubChapter[]> {
  const entries = publication.entries;
  const containerEntry = entries.find((entry) => normalizeArchiveName(entry.name).toLowerCase() === 'meta-inf/container.xml');
  if (!containerEntry) throw new Error('This EPUB is missing META-INF/container.xml.');

  const container = new DOMParser().parseFromString(await fetchPublicationText(containerEntry), 'application/xml');
  const rootfileName = elementsByLocalName(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!rootfileName) throw new Error('This EPUB does not declare an OPF package.');
  // container.xml stores the OPF path relative to the archive root.
  const opfName = normalizeArchiveName(rootfileName);
  const opfEntry = findPublicationEntry(entries, opfName);
  if (!opfEntry) throw new Error('The EPUB package file could not be found.');

  const opf = new DOMParser().parseFromString(await fetchPublicationText(opfEntry), 'application/xml');
  const manifest = new Map<string, { id: string; href: string; mediaType: string }>();
  elementsByLocalName(opf, 'item').forEach((element) => {
    const id = element.getAttribute('id');
    const href = element.getAttribute('href');
    if (id && href) manifest.set(id, { id, href, mediaType: element.getAttribute('media-type') || '' });
  });
  const spineIds = elementsByLocalName(opf, 'itemref')
    .map((element) => element.getAttribute('idref'))
    .filter((id): id is string => Boolean(id));
  const orderedItems = (spineIds.length > 0 ? spineIds.map((id) => manifest.get(id)).filter((item): item is { id: string; href: string; mediaType: string } => Boolean(item)) : [...manifest.values()].filter((item) => /xhtml|html/i.test(item.mediaType)));
  const chapters: EpubChapter[] = [];

  for (const item of orderedItems.slice(0, 300)) {
    const chapterName = resolveArchiveName(opfName, item.href);
    if (!chapterName) continue;
    const chapterEntry = findPublicationEntry(entries, chapterName);
    if (!chapterEntry) continue;
    chapters.push({ name: chapterName, title: item.id || chapterName.split('/').pop() || 'Chapter', entry: chapterEntry });
  }
  if (chapters.length === 0) throw new Error('No readable chapters were found in this EPUB.');
  return chapters;
}

type EpubReaderProps = {
  kind: MediaLibraryKind;
  item: MediaLibraryItem;
  publication: Publication;
  api: MediaLibrariesApi;
};

function EpubReader({ kind, item, publication, api }: EpubReaderProps) {
  const [chapters, setChapters] = useState<EpubChapter[]>([]);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(item.completed);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setChapters([]);
    void loadEpubChapters(publication)
      .then((nextChapters) => {
        if (!active) return;
        setChapters(nextChapters);
        setChapterIndex(Math.min(Math.max(0, Math.round(item.position)), nextChapters.length - 1));
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : 'The EPUB could not be opened.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [item.id, item.position, publication]);

  useEffect(() => {
    const chapter = chapters[chapterIndex];
    if (!chapter || chapter.srcDoc) return undefined;
    let active = true;
    setChapterLoading(true);
    void fetchPublicationText(chapter.entry)
      .then((source) => {
        if (!active) return;
        const loaded = safeChapterDocument(source, chapter.name, publication.entries);
        setChapters((current) => current.map((candidate, index) => index === chapterIndex ? { ...candidate, title: loaded.title, srcDoc: loaded.srcDoc } : candidate));
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : 'This chapter could not be opened.');
      })
      .finally(() => { if (active) setChapterLoading(false); });
    return () => { active = false; };
  }, [chapterIndex, chapters, publication.entries]);

  useEffect(() => {
    if (chapters.length === 0) return;
    void api.progress(kind, item.id, chapterIndex, completed).catch(() => undefined);
  }, [api, chapterIndex, chapters.length, completed, item.id, kind]);

  const markFinished = () => {
    setCompleted(true);
    void api.progress(kind, item.id, chapterIndex, true).catch(() => undefined);
  };

  const current = chapters[chapterIndex];
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--loom-border)] bg-[#101114]">
        {loading ? <div className="grid h-full place-items-center text-sm text-[var(--loom-muted)]">Preparing the EPUB reader…</div> : null}
        {!loading && error ? <div className="grid h-full place-items-center p-8 text-center"><div><AlertCircle className="mx-auto h-8 w-8 text-red-300" /><p role="alert" className="mt-3 max-w-md text-sm text-red-200">{error}</p></div></div> : null}
        {!loading && !error && chapterLoading ? <div className="grid h-full place-items-center text-sm text-[var(--loom-muted)]">Loading chapter…</div> : null}
        {!loading && !error && !chapterLoading && current?.srcDoc ? <iframe title={`${item.title} - ${current.title}`} sandbox="" srcDoc={current.srcDoc} className="h-full w-full border-0" /> : null}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[var(--loom-text)]">{current?.title || item.title}</p>
          {chapters.length > 0 ? <p className="text-xs text-[var(--loom-muted)]">Chapter {chapterIndex + 1} of {chapters.length}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={markFinished} disabled={completed || loading || chapters.length === 0} className="rounded-lg border border-[var(--loom-border)] px-3 py-2 text-xs text-[var(--loom-text)] hover:bg-[var(--loom-surface-2)] disabled:opacity-50">{completed ? 'Finished' : 'Mark finished'}</button>
          <button type="button" disabled={chapterIndex <= 0 || loading || chapterLoading} onClick={() => setChapterIndex((index) => Math.max(0, index - 1))} aria-label="Previous chapter" className="rounded-lg border border-[var(--loom-border)] p-2 text-[var(--loom-text)] hover:bg-[var(--loom-surface-2)] disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
          <select aria-label="Select chapter" value={chapterIndex} disabled={loading || chapterLoading || chapters.length === 0} onChange={(event) => setChapterIndex(Number(event.target.value))} className="max-w-52 rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3 py-2 text-sm text-[var(--loom-text)]">{chapters.map((chapter, index) => <option key={chapter.name} value={index}>{index + 1}. {chapter.title}</option>)}</select>
          <button type="button" disabled={chapterIndex >= chapters.length - 1 || loading || chapterLoading} onClick={() => setChapterIndex((index) => Math.min(chapters.length - 1, index + 1))} aria-label="Next chapter" className="rounded-lg border border-[var(--loom-border)] p-2 text-[var(--loom-text)] hover:bg-[var(--loom-surface-2)] disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </footer>
    </div>
  );
}

type ComicReaderProps = {
  kind: MediaLibraryKind;
  item: MediaLibraryItem;
  publication: Publication;
  api: MediaLibrariesApi;
};

function ComicReader({ kind, item, publication, api }: ComicReaderProps) {
  const pages = useMemo(() => publication.entries
    .filter((entry) => /\.(?:jpe?g|png|webp|gif|avif)$/i.test(entry.name))
    .sort((left, right) => naturalCompare(left.name, right.name)), [publication.entries]);
  const [pageIndex, setPageIndex] = useState(() => Math.min(Math.max(0, Math.round(item.position)), Math.max(0, pages.length - 1)));

  useEffect(() => {
    setPageIndex(Math.min(Math.max(0, Math.round(item.position)), Math.max(0, pages.length - 1)));
  }, [item.id, item.position, pages.length]);

  useEffect(() => {
    if (pages.length === 0) return;
    void api.progress(kind, item.id, pageIndex, pageIndex >= pages.length - 1).catch(() => undefined);
  }, [api, item.id, kind, pageIndex, pages.length]);

  const page = pages[pageIndex];
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-[var(--loom-border)] bg-[#101114] p-3 sm:p-6">
        {page ? <img src={page.url} alt={`${item.title}, page ${pageIndex + 1}`} className="mx-auto block max-h-full max-w-full object-contain" /> : <div className="grid h-full min-h-40 place-items-center text-center text-sm text-[var(--loom-muted)]">No page images were found in this CBZ.</div>}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--loom-muted)]">{pages.length > 0 ? `Page ${pageIndex + 1} of ${pages.length}` : 'CBZ reader'}</p>
        <div className="flex items-center gap-2">
          <button type="button" disabled={pageIndex <= 0 || pages.length === 0} onClick={() => setPageIndex((index) => Math.max(0, index - 1))} aria-label="Previous page" className="rounded-lg border border-[var(--loom-border)] p-2 text-[var(--loom-text)] hover:bg-[var(--loom-surface-2)] disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" disabled={pageIndex >= pages.length - 1 || pages.length === 0} onClick={() => setPageIndex((index) => Math.min(pages.length - 1, index + 1))} aria-label="Next page" className="rounded-lg border border-[var(--loom-border)] p-2 text-[var(--loom-text)] hover:bg-[var(--loom-surface-2)] disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </footer>
    </div>
  );
}

type PdfReaderProps = {
  kind: MediaLibraryKind;
  item: MediaLibraryItem;
  url: string;
  api: MediaLibrariesApi;
};

function PdfReader({ kind, item, url, api }: PdfReaderProps) {
  const [completed, setCompleted] = useState(item.completed);
  const markFinished = () => {
    setCompleted(true);
    void api.progress(kind, item.id, 1, true).catch(() => undefined);
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--loom-border)] bg-white">
        <iframe title={item.title} src={url} className="h-full w-full border-0" />
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--loom-muted)]">PDF progress is saved when you mark this file finished.</p>
        <button type="button" onClick={markFinished} disabled={completed} className="inline-flex items-center gap-2 rounded-lg bg-[var(--loom-accent)] px-4 py-2 text-sm font-medium text-[var(--loom-accent-foreground)] hover:bg-[var(--loom-accent-hover)] disabled:opacity-60"><FileText className="h-4 w-4" aria-hidden="true" />{completed ? 'Finished' : 'Mark finished'}</button>
      </footer>
    </div>
  );
}

type DocumentReaderProps = {
  reader: ReaderItem;
  api: MediaLibrariesApi;
  close: () => void;
};

function DocumentReader({ reader, api, close }: DocumentReaderProps) {
  const { item, kind } = reader;
  const isPdf = item.extension.toLowerCase() === '.pdf';
  const isEpub = item.extension.toLowerCase() === '.epub';
  const isCbz = item.extension.toLowerCase() === '.cbz';
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }} className="bg-black/85">
      <DialogContent className="!h-[92dvh] !max-h-[92dvh] !max-w-6xl !overflow-hidden !rounded-2xl !border-[var(--loom-border)] !bg-[var(--loom-surface)] !p-4 sm:!p-6">
        <div className="flex h-full min-h-0 flex-col gap-4">
          <DialogHeader className="shrink-0 pr-10 text-left">
            <DialogTitle className="truncate text-base font-semibold text-[var(--loom-text)]">{item.title}</DialogTitle>
            <DialogDescription className="truncate text-sm text-[var(--loom-muted)]">{item.relativePath}</DialogDescription>
          </DialogHeader>
          <button type="button" onClick={close} aria-label="Close reader" className="absolute right-4 top-4 rounded-full p-2 text-[var(--loom-muted)] hover:bg-[var(--loom-surface-2)] hover:text-[var(--loom-text)]"><X className="h-5 w-5" /></button>
          <div className="min-h-0 flex-1">
            {isPdf && reader.url ? <PdfReader key={item.id} kind={kind} item={item} url={reader.url} api={api} /> : null}
            {isEpub && reader.publication ? <EpubReader key={item.id} kind={kind} item={item} publication={reader.publication} api={api} /> : null}
            {isCbz && reader.publication ? <ComicReader key={item.id} kind={kind} item={item} publication={reader.publication} api={api} /> : null}
            {!isPdf && !isEpub && !isCbz ? <div className="grid h-full place-items-center text-sm text-[var(--loom-muted)]">This file type does not have a reader yet.</div> : null}
            {(isEpub || isCbz) && !reader.publication ? <div className="grid h-full place-items-center p-8 text-center text-sm text-[var(--loom-muted)]">Publication data is unavailable for this file.</div> : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function MediaLibrary({ kind }: { kind: MediaLibraryKind }) {
  const confirm = useConfirm();
  const { activeProfile } = useProfiles();
  const { theme } = useTheme();
  const config = configFor(kind);
  const frameClass = theme.homeStyle === 'modern' ? 'loom-modern-content-frame' : 'loom-frame';
  const topPaddingClass = theme.homeStyle === 'modern' ? 'pt-28' : 'pt-24';
  const mediaApi = !desktopApi.isRemoteLibraryMode() && activeProfile?.type === 'owner'
    ? window.desktopApi?.mediaLibraries
    : undefined;

  const [roots, setRoots] = useState<MediaLibraryRoot[]>([]);
  const [selectedRootId, setSelectedRootId] = useState<string>();
  const [showAllRoots, setShowAllRoots] = useState(false);
  const [view, setView] = useState<MediaViewId>(config.views[0].id);
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<MediaLibraryPage | null>(null);
  const [loadingRoots, setLoadingRoots] = useState(Boolean(mediaApi));
  const [loadingPage, setLoadingPage] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [openingItemId, setOpeningItemId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reader, setReader] = useState<ReaderItem | null>(null);
  const [audioPlayback, setAudioPlayback] = useState<AudioPlayback | null>(null);

  const loadRoots = useCallback(async () => {
    if (!mediaApi) return;
    const nextRoots = await mediaApi.roots(kind);
    setRoots(nextRoots);
    setSelectedRootId((current) => showAllRoots ? undefined : current && nextRoots.some((root) => root.id === current) ? current : nextRoots[0]?.id);
    setLoadingRoots(false);
  }, [kind, mediaApi, showAllRoots]);

  useEffect(() => {
    let active = true;
    void loadRoots().catch((cause) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : `${config.title} folders could not be loaded.`);
      setLoadingRoots(false);
    });
    return () => { active = false; };
  }, [config.title, loadRoots]);

  const scanning = roots.some((root) => root.scanning);
  useEffect(() => {
    if (!scanning) return undefined;
    const timer = window.setInterval(() => void loadRoots().catch(() => undefined), 1200);
    return () => window.clearInterval(timer);
  }, [loadRoots, scanning]);

  const catalogRevision = roots.map((root) => `${root.id}:${root.scannedAt}:${root.scanning}:${root.discovered}:${root.message || ''}`).join('|');
  useEffect(() => {
    if (!mediaApi || roots.length === 0) {
      setPage(null);
      return undefined;
    }
    let active = true;
    setLoadingPage(true);
    setError('');
    void mediaApi.browse(kind, { query: query || undefined, offset, rootId: showAllRoots ? undefined : selectedRootId, inProgress: view === 'inProgress' ? true : undefined })
      .then((nextPage) => { if (active) setPage(nextPage); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : `${config.title} could not be loaded.`); })
      .finally(() => { if (active) setLoadingPage(false); });
    return () => { active = false; };
  }, [catalogRevision, config.title, kind, mediaApi, offset, query, roots.length, selectedRootId, showAllRoots, view]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(queryInput.trim());
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    setOffset(0);
  }, [selectedRootId, view]);

  const selectedRoot = roots.find((root) => root.id === selectedRootId);
  const visibleItems = useMemo(() => page?.items || [], [page]);
  const groups = useMemo(() => groupItems(kind, view, visibleItems), [kind, view, visibleItems]);

  const addRoot = async () => {
    if (!mediaApi) return;
    setActionBusy(true);
    setError('');
    try {
      const root = await mediaApi.add(kind);
      if (!root) return;
      window.dispatchEvent(new Event('loomtv:library-roots-changed'));
      setShowAllRoots(false);
      setSelectedRootId(root.id);
      await mediaApi.scan(kind, root.id);
      await loadRoots();
      setOffset(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The ${config.singular} folder could not be added.`);
    } finally {
      setActionBusy(false);
    }
  };

  const scanRoot = async () => {
    if (!mediaApi || !selectedRootId) return;
    setActionBusy(true);
    setError('');
    try {
      await mediaApi.scan(kind, selectedRootId);
      await loadRoots();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The ${config.singular} folder could not be scanned.`);
    } finally {
      setActionBusy(false);
    }
  };

  const cancelScan = async () => {
    if (!mediaApi || !selectedRootId) return;
    setActionBusy(true);
    try {
      await mediaApi.cancel(kind, selectedRootId);
      await loadRoots();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The ${config.singular} scan could not be cancelled.`);
    } finally {
      setActionBusy(false);
    }
  };

  const removeRoot = async () => {
    if (!mediaApi || !selectedRoot) return;
    const approved = await confirm({
      title: `Remove ${selectedRoot.name}?`,
      description: `Loom will remove this folder from ${config.title}. Your original files will stay on disk.`,
      confirmLabel: 'Remove folder',
      destructive: true,
    });
    if (!approved) return;
    setActionBusy(true);
    setError('');
    try {
      await mediaApi.remove(kind, selectedRoot.id);
      window.dispatchEvent(new Event('loomtv:library-roots-changed'));
      setPage(null);
      setOffset(0);
      await loadRoots();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The ${config.singular} folder could not be removed.`);
    } finally {
      setActionBusy(false);
    }
  };

  const startAudio = useCallback(async (item: MediaLibraryItem, queue: MediaLibraryItem[] = []) => {
    if (!mediaApi) return;
    setOpeningItemId(item.id);
    setError('');
    try {
      const url = await mediaApi.open(kind, item.id);
      setAudioPlayback({ current: item, url, queue });
      setReader(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The ${config.singular} could not be opened.`);
    } finally {
      setOpeningItemId(null);
    }
  }, [config.singular, kind, mediaApi]);

  const openItem = useCallback(async (item: MediaLibraryItem) => {
    if (!mediaApi) return;
    if (config.audio) {
      await startAudio(item);
      return;
    }
    setOpeningItemId(item.id);
    setError('');
    try {
      const url = await mediaApi.open(kind, item.id);
      if (item.extension.toLowerCase() === '.pdf') {
        setReader({ kind, item, url });
      } else {
        const publication = await mediaApi.publication(kind, item.id);
        setReader({ kind, item, url, publication });
      }
      setAudioPlayback(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The ${config.singular} could not be opened.`);
    } finally {
      setOpeningItemId(null);
    }
  }, [config.audio, config.singular, kind, mediaApi, startAudio]);

  const queueAudio = useCallback((item: MediaLibraryItem) => {
    if (!audioPlayback) {
      void startAudio(item);
      return;
    }
    if (audioPlayback.current.id === item.id || audioPlayback.queue.some((queued) => queued.id === item.id)) return;
    setAudioPlayback((current) => current ? { ...current, queue: [...current.queue, item] } : current);
  }, [audioPlayback, startAudio]);

  const playNextAudio = useCallback(() => {
    const next = audioPlayback?.queue[0];
    if (!next) {
      setAudioPlayback(null);
      return;
    }
    void startAudio(next, audioPlayback.queue.slice(1));
  }, [audioPlayback, startAudio]);

  const pageSize = page?.pageSize || PAGE_SIZE_FALLBACK;
  const total = page?.total || 0;
  const pageCount = Math.ceil(total / pageSize);
  const pageNumber = Math.floor(offset / pageSize) + 1;
  const Icon = config.icon;

  if (!mediaApi) {
    return <main className="loom-page h-full overflow-y-auto"><div className={`${frameClass} loom-library-page-frame ${topPaddingClass} px-8 pb-8`}><h1 className="text-3xl font-semibold text-[var(--loom-text)]">{config.title}</h1><p className="mt-4 text-[var(--loom-muted)]">{config.title} are available in the local Electron app with the owner profile.</p></div></main>;
  }

  return (
    <div className="loom-page loom-library-page h-full overflow-y-auto">
      <div className={`${frameClass} loom-library-page-frame page-bottom-safe page-list-bottom-safe ${topPaddingClass} px-6 pb-6 md:px-10 md:pb-10`}>
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="sr-only">{config.title}</h1>
          {roots.length > 0 ? <div className="flex min-w-0 basis-full flex-wrap items-center gap-2 sm:basis-0 sm:flex-1" aria-label={`${config.title} folders`}>
            {roots.map((root) => <button key={root.id} type="button" onClick={() => { setShowAllRoots(false); setSelectedRootId(root.id); setOffset(0); }} aria-pressed={!showAllRoots && root.id === selectedRootId} className={`rounded-lg px-3 py-2 text-sm ${!showAllRoots && root.id === selectedRootId ? 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'bg-[var(--loom-surface)] text-[var(--loom-muted)] hover:bg-[var(--loom-surface-2)]'}`}>{root.name}<span className="ml-2 text-xs opacity-70">{root.count.toLocaleString()}</span></button>)}
            <button type="button" onClick={() => { setShowAllRoots(true); setSelectedRootId(undefined); setOffset(0); }} aria-pressed={showAllRoots} className={`rounded-lg px-3 py-2 text-sm ${showAllRoots ? 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'bg-[var(--loom-surface)] text-[var(--loom-muted)] hover:bg-[var(--loom-surface-2)]'}`}>All folders</button>
          </div> : null}
          <div className="flex max-w-full flex-wrap items-center gap-2 sm:ml-auto">
            <button type="button" onClick={() => void addRoot()} disabled={actionBusy || scanning} className="loom-button-primary inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-50"><Plus className="h-4 w-4" /> Add folder</button>
            {selectedRoot ? <>{selectedRoot.scanning ? <button type="button" onClick={() => void cancelScan()} disabled={actionBusy} className="rounded-lg px-3 py-2 text-[var(--loom-text)] hover:bg-[var(--loom-surface-2)] disabled:opacity-40">Cancel</button> : <button type="button" onClick={() => void scanRoot()} disabled={actionBusy} aria-label={`Scan ${selectedRoot.name}`} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface)] p-2 text-[var(--loom-muted)] hover:bg-[var(--loom-surface-2)] hover:text-[var(--loom-text)] disabled:opacity-40"><RefreshCw className="h-4 w-4" /></button>}
            <button type="button" onClick={() => void removeRoot()} disabled={actionBusy || selectedRoot.scanning} aria-label={`Remove ${selectedRoot.name} from ${config.title}`} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface)] p-2 text-red-300 hover:bg-red-400/10 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button></> : null}
          </div>
        </header>

        {error ? <p role="alert" className="mt-5 flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p> : null}
        {loadingRoots ? <p role="status" className="mt-8 text-sm text-[var(--loom-muted)]">Loading {config.title.toLowerCase()} folders…</p> : null}

        {!loadingRoots && roots.length === 0 ? <section className="mt-10 rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-10 text-center">
          <Icon className="mx-auto h-10 w-10 text-[var(--loom-muted)]" aria-hidden="true" />
          <h2 className="mt-4 text-lg font-medium text-[var(--loom-text)]">Add a {config.singular} folder</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--loom-muted)]">Choose a folder to scan. Loom keeps the folder structure and does not move or change the original files.</p>
          <button type="button" onClick={() => void addRoot()} disabled={actionBusy} className="loom-button-primary mt-6 rounded-lg px-4 py-2 text-sm disabled:opacity-50">Choose folder</button>
        </section> : null}

        {roots.length > 0 ? <>
          {selectedRoot ? <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <FolderOpen className="h-4 w-4 shrink-0 text-[var(--loom-muted)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[var(--loom-muted)]" title={selectedRoot.path}>{selectedRoot.path}</span>
            {selectedRoot.scanning ? <span role="status" className="text-[var(--loom-muted)]">Scanning, {selectedRoot.discovered.toLocaleString()} found</span> : <span className="text-[var(--loom-muted)]">{selectedRoot.count.toLocaleString()} {config.singular}{selectedRoot.count === 1 ? '' : 's'}</span>}
            {selectedRoot.message ? <span className="w-full text-xs text-[var(--loom-muted)]">{selectedRoot.message}</span> : null}
          </div> : null}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <nav aria-label={`${config.title} views`} className="flex flex-wrap gap-2">
              {config.views.map((option) => <button key={option.id} type="button" onClick={() => setView(option.id)} aria-pressed={view === option.id} className={`rounded-lg px-3 py-2 text-sm ${view === option.id ? 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'bg-[var(--loom-surface)] text-[var(--loom-muted)] hover:bg-[var(--loom-surface-2)]'}`}>{option.label}</button>)}
            </nav>
            <label className="relative block min-w-0 basis-full sm:basis-56 sm:flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)]" aria-hidden="true" /><span className="sr-only">Search {config.title}</span><input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder={`Search ${config.title.toLowerCase()}`} className="h-9 w-full rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface)] pl-9 pr-3 text-sm text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-muted)] focus:border-[var(--loom-accent)]" /></label>
          </div>

          {loadingPage ? <p role="status" className="mt-8 text-sm text-[var(--loom-muted)]">Loading {config.title.toLowerCase()}…</p> : null}
          {!loadingPage && visibleItems.length === 0 ? <div className="mt-10 rounded-2xl border border-dashed border-[var(--loom-border)] p-10 text-center"><Icon className="mx-auto h-8 w-8 text-[var(--loom-muted)]" aria-hidden="true" /><p className="mt-3 text-sm text-[var(--loom-muted)]">{view === 'inProgress' ? `No ${config.title.toLowerCase()} are in progress.` : `No ${config.title.toLowerCase()} match this view.`}</p></div> : null}

          {groups.length > 0 ? <div className="mt-8 space-y-10">{groups.map(([group, items]) => <section key={group} aria-labelledby={`media-group-${kind}-${group}`}><div className="mb-4 flex items-center justify-between gap-3"><h2 id={`media-group-${kind}-${group}`} className="truncate text-lg font-semibold text-[var(--loom-text)]">{group}</h2><span className="shrink-0 text-xs text-[var(--loom-muted)]">{items.length} {items.length === 1 ? config.singular : `${config.singular}s`}</span></div><div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{items.map((item) => <MediaItemCard key={item.id} item={item} config={config} onOpen={(nextItem) => void openItem(nextItem)} onPlay={config.audio ? (nextItem) => void startAudio(nextItem) : undefined} onQueue={config.audio ? queueAudio : undefined} busy={openingItemId === item.id} />)}</div></section>)}</div> : null}

          {page && pageCount > 1 ? <div className="mt-10 flex items-center justify-center gap-4"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))} className="inline-flex items-center gap-1 rounded-lg border border-[var(--loom-border)] px-4 py-2 text-sm text-[var(--loom-text)] hover:bg-[var(--loom-surface-2)] disabled:opacity-40"><ChevronLeft className="h-4 w-4" /> Previous</button><span className="text-sm text-[var(--loom-muted)]">Page {pageNumber} of {pageCount}</span><button type="button" disabled={offset + pageSize >= total} onClick={() => setOffset(offset + pageSize)} className="inline-flex items-center gap-1 rounded-lg border border-[var(--loom-border)] px-4 py-2 text-sm text-[var(--loom-text)] hover:bg-[var(--loom-surface-2)] disabled:opacity-40">Next <ChevronRight className="h-4 w-4" /></button></div> : null}
        </> : null}
      </div>
      {reader ? <DocumentReader reader={reader} api={mediaApi} close={() => setReader(null)} /> : null}
      {audioPlayback ? <AudioPlayer kind={kind} api={mediaApi} playback={audioPlayback} onClose={() => setAudioPlayback(null)} onNext={playNextAudio} onQueueRemove={(itemId) => setAudioPlayback((current) => current ? { ...current, queue: current.queue.filter((item) => item.id !== itemId) } : current)} onQueueClear={() => setAudioPlayback((current) => current ? { ...current, queue: [] } : current)} /> : null}
    </div>
  );
}
