from pathlib import Path
import re

ROOT = Path('.')

def edit(name, transform):
    path = ROOT / name
    old = path.read_text()
    new = transform(old)
    if new == old:
        raise RuntimeError(f'No changes produced for {name}')
    path.write_text(new)
    print(f'Updated {name}')

def once(text, old, new):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'Expected exactly one match, got {count}: {old[:120]!r}')
    return text.replace(old, new, 1)

edit('apps/desktop/src/components/VideoPlayer.tsx', lambda s: once(s,
    'void MpvPlaybackEngine.available().catch(() => false);\n',
    '// MPV is a fallback. Detection and initialization happen only when it is selected.\n'))

def lazy_player(s):
    start = s.index('// Parse the player while the library screen is idle')
    end = s.index('type LazyVideoPlayerProps', start)
    return s[:start] + '// LibVLC warms in main. Import the renderer player only when it is mounted.\n\n' + s[end:]
edit('apps/desktop/src/components/VideoPlayer/LazyVideoPlayer.tsx', lazy_player)

def routes(s):
    start = s.index('  useEffect(() => {\n    if (!startupReady || !window.desktopApi) return undefined;')
    end = s.index('  }, [startupReady]);', start) + len('  }, [startupReady]);')
    assert 'component.preload' in s[start:end]
    return s[:start] + '  // Routes load on navigation or existing hover/focus intent, never a blanket idle preload.\n' + s[end:]
edit('apps/desktop/src/App.tsx', routes)

def mpv(s):
    s = once(s, "import { BrowserWindow, type WebContents } from 'electron';", "import { BrowserWindow, type WebContents } from 'electron';\nimport { recordMemoryCheckpoint } from './memoryMetrics.ts';")
    start = s.index('export function libMpvAvailability(')
    end = s.index('function commandList(', start)
    replacement = '''/** Presence is not proof of successful playback. Never load native code for a probe. */
export function libMpvAvailability(force = false): MpvAvailability {
  if (disabled()) return { available: false, surface: 'unavailable', reason: 'Native libmpv playback is disabled for this run.' };
  // Refresh may retry a failed load, but must not discard an active runtime.
  if (force && cachedRuntime === null) { cachedRuntime = undefined; cachedWarning = ''; }
  if (cachedRuntime === null) return { available: false, surface: 'unavailable', reason: cachedWarning || 'libmpv could not load.' };
  const paths = configuredPaths();
  if (!paths) return { available: false, surface: 'unavailable', reason: 'The bundled libmpv library or native bridge is missing.' };
  return {
    available: true,
    surface: 'composited-window',
    libraryPath: paths.libraryPath,
    runtimeSource: 'bundled',
    verification: cachedRuntime ? 'loaded' : 'detected',
    ...(cachedRuntime ? { version: 'libmpv client API 2' } : {}),
  };
}

export function libMpvRuntimeSummary(): string {
  const availability = libMpvAvailability();
  return availability.available
    ? `[playback] libmpv fallback detected at ${availability.libraryPath}; loads only when selected`
    : `[playback] libmpv fallback unavailable: ${availability.reason}`;
}

'''
    s = s[:start] + replacement + s[end:]
    s = once(s, "    currentSession = session;\n    return { ok: true, sessionId: session.id, surface: 'composited-window' as const };", "    currentSession = session;\n    recordMemoryCheckpoint('mpv.session.started');\n    return { ok: true, sessionId: session.id, surface: 'composited-window' as const };")
    s = once(s, "      try { cleanup(); } catch (error) { console.warn('[playback] libmpv cleanup failed', error); }\n    }", "      try { cleanup(); } catch (error) { console.warn('[playback] libmpv cleanup failed', error); }\n    }\n    recordMemoryCheckpoint('mpv.session.released');")
    return s
edit('apps/desktop/src/main/libmpvPlayback.ts', mpv)
edit('apps/desktop/src/shared/desktopProtocol.ts', lambda s: once(s,
    'export type MpvAvailability = {\n  available: boolean;',
    "export type MpvAvailability = {\n  available: boolean;\n  /** Detection does not load the bridge or establish playback readiness. */\n  verification?: 'detected' | 'loaded';"))

def warm(s):
    s = once(s, "import { recordPlaybackDiagnostic } from './playbackDiagnostics.ts';", "import { recordPlaybackDiagnostic } from './playbackDiagnostics.ts';\nimport { recordMemoryCheckpoint } from './memoryMetrics.ts';\nimport type { DynamicFunction, KoffiLibrary, KoffiRuntime, NativeValue } from './libvlcNativeTypes.ts';")
    start = s.index('type NativeValue =')
    end = s.index('export type SharedLibVlcInstance', start)
    s = s[:start] + s[end:]
    s = once(s, 'type WarmRuntime = {\n  instance:', 'type WarmRuntime = {\n  library: KoffiLibrary;\n  instance:')
    s = once(s, 'return { instance, release, libraries, libraryPath };', 'return { instance, release, libraries, libraryPath, library };')
    s = once(s, "      recordPlaybackDiagnostic('vlc.warmup.ready');", "      recordPlaybackDiagnostic('vlc.warmup.ready');\n      recordMemoryCheckpoint('vlc.warmup.ready');")
    marker = 'export function releaseWarmLibVlcRuntime(): void {'
    addition = '''/** Reuse the startup library handles instead of dlopening VLC again for availability. */
export function getWarmLibVlcLibraries(libraryPath: string): { library: KoffiLibrary; libraries: readonly KoffiLibrary[] } | null {
  if (!warmRuntime || !sameLibraryPath(warmRuntime.libraryPath, libraryPath)) return null;
  return { library: warmRuntime.library, libraries: warmRuntime.libraries };
}

'''
    return once(s, marker, addition + marker)
edit('apps/desktop/src/main/libvlcWarmup.ts', warm)

def vlc(s):
    s = once(s, "import { getWarmLibVlcInstance } from './libvlcWarmup.ts';", "import { getWarmLibVlcInstance, getWarmLibVlcLibraries } from './libvlcWarmup.ts';\nimport { recordMemoryCheckpoint } from './memoryMetrics.ts';\nimport type { DynamicFunction, KoffiLibrary, KoffiRuntime, KoffiType, KoffiTypeSpec, NativeValue } from './libvlcNativeTypes.ts';\nexport type { KoffiLibrary, KoffiRuntime } from './libvlcNativeTypes.ts';")
    start = s.index('/**\n * A koffi type descriptor.')
    end = s.index('export type NativeDrawable', start)
    s = s[:start] + s[end:]
    s = once(s, '      const loadedLibraries: KoffiLibrary[] = [];', '      const warmed = getWarmLibVlcLibraries(candidate.path);\n      const loadedLibraries: KoffiLibrary[] = warmed ? [...warmed.libraries] : [];')
    s = once(s, "      if (process.platform === 'darwin' || process.platform === 'win32') {", "      if (!warmed && (process.platform === 'darwin' || process.platform === 'win32')) {")
    s = once(s, '      const library = koffi.load(candidate.path);\n      loadedLibraries.push(library);', '      const library = warmed?.library ?? koffi.load(candidate.path);\n      if (!warmed) loadedLibraries.push(library);')
    s = once(s, '    this.release();\n    this.destroyNativeView();\n    this.emit({', "    this.release();\n    this.destroyNativeView();\n    recordMemoryCheckpoint('vlc.session.released');\n    this.emit({")
    s = once(s, "    currentSession = session;\n    return { ok: true, sessionId: session.id, surface: 'composited-window' };", "    currentSession = session;\n    recordMemoryCheckpoint('vlc.session.started');\n    return { ok: true, sessionId: session.id, surface: 'composited-window' };")
    return s
edit('apps/desktop/src/main/libvlcPlayback.ts', vlc)

def catalog(s):
    s = "import { IdleValueCache, MemoryLruCache } from './main/boundedMemoryCache.ts';\n" + s
    s = once(s, 'let cachedLibrary: LibraryData | null = null;', '''// Full metadata is an expiring read-through snapshot, never the durable store.
const libraryCache = new IdleValueCache<LibraryData>(30_000);
const rendererIndexCache = new MemoryLruCache<string, ReturnType<typeof projectLibraryIndexForRenderer>>({
  maxEntries: 2, maxBytes: 8 * 1024 * 1024, idleMs: 60_000,
});
const rendererDetailCache = new MemoryLruCache<string, ReturnType<typeof projectLibraryItemForRenderer>>({
  maxEntries: 50, maxBytes: 8 * 1024 * 1024, idleMs: 30_000,
});
let rendererReadScope: string | null = null;

function clearRendererReadCaches(): void {
  rendererIndexCache.clear();
  rendererDetailCache.clear();
  rendererReadScope = null;
}

function clearFullLibraryCache(): void {
  libraryCache.clear();
  clearRendererReadCaches();
}

function rendererReadCacheKey(revision: number, mediaId?: string): string {
  const scope = getRendererCatalogIdentity();
  // Profile/restriction/transport changes must never reuse another scope's payload.
  if (scope !== rendererReadScope) {
    clearRendererReadCaches();
    rendererReadScope = scope;
  }
  return JSON.stringify([scope, revision, mediaId ?? null]);
}

app.once('will-quit', () => { libraryCache.clear(); clearRendererReadCaches(); });''')
    # Preserve every existing invalidation and mutation site, changing only storage ownership.
    s = re.sub(r'\bcachedLibrary\b', 'libraryCache.value', s)
    s = s.replace('libraryCache.value = null;', 'clearFullLibraryCache();')
    s = once(s, 'function advanceLibraryMutationVersion(): void {\n  libraryMutationVersion++;', 'function advanceLibraryMutationVersion(): void {\n  libraryMutationVersion++;\n  clearRendererReadCaches();')
    s = once(s, '''function loadLibrary(): LibraryData {
  if (!libraryCache.value) libraryCache.value = loadLibraryUncached();
  return libraryCache.value;
}''', '''function loadLibrary(): LibraryData {
  const cached = libraryCache.value;
  if (cached) return cached;
  const loaded = loadLibraryUncached();
  libraryCache.value = loaded;
  return loaded;
}''')
    s = once(s, '''function compactLibraryIndexForRenderer(revision = libraryMutationVersion) {
  const profileId = getDesktopActiveProfileId();
  const data = loadLibrary();
  const scoped = profileId
    ? filterLibraryForProfile(data, profileId)
    : { ...data, movies: [], tvShows: [], animeShows: [] };
  return projectLibraryIndexForRenderer(scoped, revision);
}''', '''function compactLibraryIndexForRenderer(revision = libraryMutationVersion) {
  const profileId = getDesktopActiveProfileId();
  const key = rendererReadCacheKey(revision);
  const cached = rendererIndexCache.get(key);
  if (cached) {
    // Folder availability may change without a catalog mutation.
    const groups = normalizeLibraryFolderGroups({ libraryFolderGroups: cached.libraryFolderGroups });
    return { ...cached, libraryFolderStatuses: libraryFolderStatusesFor(groups) };
  }
  const data = loadLibrary();
  const scoped = profileId
    ? filterLibraryForProfile(data, profileId)
    : { ...data, movies: [], tvShows: [], animeShows: [] };
  const result = projectLibraryIndexForRenderer(scoped, revision);
  rendererIndexCache.set(key, result, Buffer.byteLength(JSON.stringify(result)));
  return result;
}''')
    s = once(s, '''function compactLibraryItemForRenderer(mediaId: string, revision = libraryMutationVersion) {
  const profileId = getDesktopActiveProfileId();
  if (!profileId) return null;
  const item = findLibraryItem(filterLibraryForProfile(loadLibrary(), profileId), mediaId);
  return item ? projectLibraryItemForRenderer(item, revision) : null;
}''', '''function compactLibraryItemForRenderer(mediaId: string, revision = libraryMutationVersion) {
  const profileId = getDesktopActiveProfileId();
  if (!profileId) return null;
  const key = rendererReadCacheKey(revision, mediaId);
  const cached = rendererDetailCache.get(key);
  if (cached) return cached;
  const item = findLibraryItem(filterLibraryForProfile(loadLibrary(), profileId), mediaId);
  if (!item) return null;
  const result = projectLibraryItemForRenderer(item, revision);
  rendererDetailCache.set(key, result, Buffer.byteLength(JSON.stringify(result)));
  return result;
}''')
    s = once(s, '    saveLibraryToDatabase(nextLibrary);\n    libraryCache.value = nextLibrary;', '    saveLibraryToDatabase(nextLibrary);\n    clearRendererReadCaches();\n    libraryCache.value = nextLibrary;')
    return s
edit('apps/desktop/src/main.ts', catalog)

def library_context(s):
    s = once(s, "import { hydrateProgressFromDatabase } from '@/lib/progress';", "import { hydrateProgressFromDatabase } from '@/lib/progress';\nimport { hasActivePlayback } from '@/lib/playbackLifecycle';")
    start = s.index('    const intervalMs = state.autoSyncIntervalHours * 60 * 60 * 1000;')
    end = s.index('  }, [activeProfile?.type, applyScanCatalog, beginLibraryMutation, runLibraryScan, state.autoSyncIntervalHours]);', start)
    block = s[start:end]
    block = once(block, '    const intervalId = window.setInterval(() => {', '    let retryTimer: ReturnType<typeof setTimeout> | undefined;\n    const runAutoSync = () => {')
    block = once(block,
        "      if (activeProfile?.type !== 'owner' || isScanningRef.current || !hasConfiguredFoldersRef.current) return;",
        "      if (activeProfile?.type !== 'owner' || isScanningRef.current || !hasConfiguredFoldersRef.current) return;\n      // User-requested scans still work. Do not start automatic work behind playback.\n      if (document.hidden || hasActivePlayback()) {\n        clearTimeout(retryTimer);\n        retryTimer = setTimeout(runAutoSync, 15 * 60 * 1000);\n        return;\n      }")
    block = once(block, '    }, intervalMs);\n\n    return () => window.clearInterval(intervalId);', '    };\n    const intervalId = window.setInterval(runAutoSync, intervalMs);\n\n    return () => {\n      window.clearInterval(intervalId);\n      clearTimeout(retryTimer);\n    };')
    s = s[:start] + block + s[end:]
    s = once(s, '      if (pending || disposed || document.hidden || isScanningRef.current) return;', '      if (pending || disposed || document.hidden || isScanningRef.current || hasActivePlayback()) return;')
    return s
edit('apps/desktop/src/contexts/LibraryContext.tsx', library_context)

# The one-time editing script is not part of the implementation.
# The branch-only workflow is removed via the GitHub connector after this run.
Path('scripts/apply-memory-branch.py').unlink()
