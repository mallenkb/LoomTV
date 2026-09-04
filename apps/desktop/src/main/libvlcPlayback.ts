import { BrowserWindow, type WebContents } from 'electron';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PlaybackCommand, PlaybackStartOptions, PlaybackState, PlaybackTrack, PlaybackViewport } from '../shared/playbackProtocol';
import {
  releaseNativePlaybackDisplaySleep,
  syncNativePlaybackDisplaySleep,
} from './nativePlaybackPower';
import {
  libVlcPlatformBinding,
  libVlcPlatformVariants,
  orderWindowsLibVlcChildren,
} from './libvlcPlatform.ts';
import { getWarmLibVlcInstance } from './libvlcWarmup.ts';
import { LIBVLC_INSTANCE_ARGUMENTS } from './libvlcRuntimeConfig.ts';
import {
  captureLibVlcTrackSelection,
  restoreLibVlcTrackSelection,
  type LibVlcTrackSelection,
} from './libvlcSessionState.ts';

/**
 * A koffi type descriptor. `koffi.struct(...)` returns one of these opaque
 * objects, and it may appear anywhere a primitive type name like `'void *'` is
 * accepted — including a function's return type.
 */
type KoffiType = object;
type KoffiTypeSpec = string | KoffiType;

/**
 * Values that cross the FFI boundary. koffi marshals a `void *` as a BigInt
 * address (or `null` for NULL), primitives as themselves, and a struct as a
 * plain object matching its descriptor.
 */
type NativeValue = string | number | bigint | boolean | null | undefined
  | Record<string, unknown>
  | readonly (string | null)[];
type DynamicFunction = (...args: NativeValue[]) => NativeValue;

type KoffiLibrary = {
  func: (name: string, returnType: KoffiTypeSpec, argumentTypes: readonly KoffiTypeSpec[]) => DynamicFunction;
};
type KoffiRuntime = {
  load: (libraryPath: string) => KoffiLibrary;
  struct: (fields: Record<string, KoffiTypeSpec>) => KoffiType;
  decode: (value: NativeValue, type: KoffiTypeSpec) => Record<string, NativeValue>;
};
type NativeDrawable = bigint | number;
/** A native pointer result: an address, or null when the call returned NULL. */
type NativeHandle = NativeDrawable | null;

export type LibVlcSurface = 'composited-window' | 'unavailable';

export type LibVlcAvailability = {
  available: boolean;
  enabled?: boolean;
  surface?: LibVlcSurface;
  libraryPath?: string;
  version?: string;
  runtimeSource?: 'environment' | 'bundled' | 'system';
  warning?: string;
  reason?: string;
};

export type LibVlcStartOptions = PlaybackStartOptions;
export type LibVlcPlaybackState = PlaybackState;
export type LibVlcCommand = PlaybackCommand;

type LibVlcApi = {
  newInstance: DynamicFunction;
  releaseInstance: DynamicFunction;
  getVersion: DynamicFunction;
  mediaNewPath: DynamicFunction;
  mediaNewLocation: DynamicFunction;
  mediaAddOption: DynamicFunction;
  mediaRelease: DynamicFunction;
  playerNewFromMedia: DynamicFunction;
  playerRelease: DynamicFunction;
  playerPlay: DynamicFunction;
  playerStop: DynamicFunction;
  playerSetPause: DynamicFunction;
  playerGetState: DynamicFunction;
  playerGetTime: DynamicFunction;
  playerGetLength: DynamicFunction;
  playerSetTime: DynamicFunction;
  audioSetVolume: DynamicFunction;
  audioSetMute: DynamicFunction;
  audioGetTrack?: DynamicFunction;
  playerSetRate: DynamicFunction;
  setDrawable: DynamicFunction;
  videoSetMouseInput?: DynamicFunction;
  videoSetKeyInput?: DynamicFunction;
  videoSetTrack?: DynamicFunction;
  videoGetTrack?: DynamicFunction;
  videoGetTrackDescription?: DynamicFunction;
  videoSetAspectRatio?: DynamicFunction;
  videoSetCropGeometry?: DynamicFunction;
  audioSetTrack?: DynamicFunction;
  audioGetTrackDescription?: DynamicFunction;
  subtitleSetTrack?: DynamicFunction;
  subtitleGetTrack?: DynamicFunction;
  subtitleGetTrackDescription?: DynamicFunction;
  trackDescriptionListRelease?: DynamicFunction;
  subtitleSetDelay?: DynamicFunction;
  audioSetDelay?: DynamicFunction;
};

type LibVlcRuntime = {
  api: LibVlcApi;
  loadedLibraries: KoffiLibrary[];
  libraryPath: string;
  version?: string;
  source: 'environment' | 'bundled' | 'system';
  decode: KoffiRuntime['decode'];
  trackDescriptionType: KoffiType;
};

type RuntimeCache = {
  key: string;
  runtime: LibVlcRuntime | null;
  warning?: string;
  resolvedAt: number;
};

const require = createRequire(__filename);
const MISSING_RUNTIME_CACHE_MS = 5_000;
let runtimeCache: RuntimeCache | null = null;
let currentSession: LibVlcPlaybackSession | null = null;

/**
 * Narrow an FFI result to a pointer. koffi returns a BigInt address for a
 * `void *` and `null` for NULL, so anything else means the binding's declared
 * signature and the C symbol disagree; treat that as a null pointer rather
 * than letting an unexpected value reach another native call.
 */
function nativeHandle(value: NativeValue): NativeHandle {
  return typeof value === 'bigint' || typeof value === 'number' ? value : null;
}

/** Narrow an FFI result to an `int`-style status code. */
function nativeInt(value: NativeValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function explicitBoolean(value: unknown): boolean | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function libVlcConfiguredEnabled(): boolean {
  const configured = explicitBoolean(process.env.LOOMTV_EXPERIMENTAL_LIBVLC);
  const legacyConfigured = explicitBoolean(process.env.LOOMTV_ENABLE_LIBVLC);
  return configured ?? legacyConfigured ?? true;
}

function libVlcKillSwitchEnabled(): boolean {
  // Keep LibVLC enabled by default in this branch.
  // Runtime kill switches are intentionally ignored so playback remains in native
  // path unless the runtime is missing or unsupported.
  return false;
}

// A raw BrowserWindow native drawable is not composited with WebContents, so
// the gate below is only open on platforms with a real child-surface host.
// LOOMTV_LIBVLC_COMPOSITED_SURFACE=0 still forces the fallback-only behavior.
function libVlcCompositionGateEnabled(): boolean {
  const configured = explicitBoolean(process.env.LOOMTV_LIBVLC_COMPOSITED_SURFACE);
  if (configured !== undefined) return configured;
  return libVlcPlatformBinding(process.platform) !== null;
}

function disabledReason(): string {
  if (libVlcKillSwitchEnabled()) {
    return 'Native LibVLC playback is disabled by the LoomTV kill switch. LoomTV is using compatible fallback playback.';
  }
  if (!libVlcConfiguredEnabled()) {
    return 'Native LibVLC playback was disabled by configuration. LoomTV is using MPV or Chromium/HLS fallback playback.';
  }
  if (!libVlcCompositionGateEnabled()) {
    return 'Native LibVLC playback has no in-window composition host on this platform. LoomTV is using MPV or Chromium/HLS fallback playback.';
  }
  return 'Native LibVLC playback is unavailable. LoomTV is using MPV or Chromium/HLS fallback playback.';
}

function runtimeCacheKey(): string {
  return [
    process.platform,
    process.arch,
    process.env.LOOMTV_EXPERIMENTAL_LIBVLC || '',
    process.env.LOOMTV_ENABLE_LIBVLC || '',
    process.env.LOOMTV_LIBVLC_COMPOSITED_SURFACE || '',
    process.env.LOOMTV_DISABLE_EXPERIMENTAL_LIBVLC || '',
    process.env.LOOMTV_DISABLE_LIBVLC || '',
    process.env.LOOMTV_LIBVLC_PATH || '',
    process.env.LOOMTV_LIBVLC_PLUGIN_PATH || '',
  ].join('\0');
}

function libraryFileName(): string {
  return process.platform === 'win32' ? 'libvlc.dll' : process.platform === 'darwin' ? 'libvlc.dylib' : 'libvlc.so';
}

function architectureVariants(): string[] {
  if (process.arch === 'arm64') return ['arm64', 'aarch64'];
  if (process.arch === 'x64') return ['x64', 'amd64'];
  if (process.arch === 'ia32') return ['ia32', 'x86'];
  if (process.arch === 'arm') return ['arm', 'armv7'];
  return [process.arch];
}

function bundledResourceRoots(): string[] {
  const roots: string[] = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.trim()) {
    roots.push(path.join(process.resourcesPath, 'libvlc'));
  }
  // Electron's development resources directory does not contain extraResources;
  // only inspect the repository resource folder when running the unpackaged app.
  if ((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp) {
    roots.push(path.resolve(__dirname, '../../resources/libvlc'));
  }
  return [...new Set(roots)];
}

function bundledLibraryPaths(): string[] {
  const name = libraryFileName();
  const layoutRoots: string[] = [];
  for (const root of bundledResourceRoots()) {
    for (const platform of libVlcPlatformVariants(process.platform)) {
      for (const architecture of architectureVariants()) {
        layoutRoots.push(path.join(root, platform, architecture));
      }
      layoutRoots.push(path.join(root, platform));
    }
    for (const architecture of architectureVariants()) layoutRoots.push(path.join(root, architecture));
    layoutRoots.push(root);
  }

  const candidates: string[] = [];
  for (const root of layoutRoots) {
    candidates.push(
      path.join(root, name),
      path.join(root, 'lib', name),
      path.join(root, 'Frameworks', name),
      path.join(root, 'MacOS', name),
      path.join(root, 'MacOS', 'lib', name),
      path.join(root, 'Contents', 'Frameworks', name),
      path.join(root, 'Contents', 'MacOS', name),
      path.join(root, 'Contents', 'MacOS', 'lib', name),
      path.join(root, 'VLC.app', 'Contents', 'Frameworks', name),
      path.join(root, 'VLC.app', 'Contents', 'MacOS', name),
      path.join(root, 'VLC.app', 'Contents', 'MacOS', 'lib', name),
    );
  }
  return candidates;
}

function candidateLibraryPaths(): Array<{ path: string; source: 'environment' | 'bundled' | 'system' }> {
  const configured = process.env.LOOMTV_LIBVLC_PATH?.trim();
  let configuredPath = configured;
  try {
    if (configured && fs.statSync(configured).isDirectory()) configuredPath = path.join(configured, libraryFileName());
  } catch {
    // Let the normal candidate-loading path report an unavailable override.
  }
  const candidates: Array<{ path: string; source: 'environment' | 'bundled' | 'system' }> = [];
  if (configuredPath) candidates.push({ path: configuredPath, source: 'environment' });
  candidates.push(...bundledLibraryPaths().map((libraryPath) => ({ path: libraryPath, source: 'bundled' as const })));

  if (process.platform === 'darwin') {
    candidates.push(
      { path: '/Applications/VLC.app/Contents/MacOS/lib/libvlc.dylib', source: 'system' },
      { path: '/Applications/VLC.app/Contents/Frameworks/libvlc.dylib', source: 'system' },
      { path: '/opt/homebrew/lib/libvlc.dylib', source: 'system' },
      { path: '/usr/local/lib/libvlc.dylib', source: 'system' },
      { path: 'libvlc.dylib', source: 'system' },
    );
  } else if (process.platform === 'win32') {
    const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates.push(
      { path: path.join(programFiles, 'VideoLAN', 'VLC', 'libvlc.dll'), source: 'system' },
      { path: path.join(programFilesX86, 'VideoLAN', 'VLC', 'libvlc.dll'), source: 'system' },
      ...(localAppData ? [{ path: path.join(localAppData, 'Programs', 'VideoLAN', 'VLC', 'libvlc.dll'), source: 'system' as const }] : []),
      { path: 'libvlc.dll', source: 'system' },
    );
  }
  return [...new Map(candidates.map((candidate) => [candidate.path, candidate])).values()];
}

/**
 * Inspect the configured/bundled library locations without loading anything.
 *
 * Startup diagnostics use this lightweight probe so that reporting the
 * configured LibVLC state does not require loading koffi or dlopening a
 * native library. The real runtime probe remains in loadRuntime(), which is
 * reached only by explicit availability refreshes or local playback startup.
 */
function configuredLibraryCandidate(): { path: string; source: 'environment' | 'bundled' | 'system' } | undefined {
  for (const candidate of candidateLibraryPaths()) {
    try {
      if (fs.statSync(candidate.path).isFile()) return candidate;
    } catch {
      // A missing candidate is expected while checking optional runtimes.
    }
  }
  return undefined;
}

function loadKoffi(): KoffiRuntime {
  return require('koffi') as KoffiRuntime;
}

function bind(library: KoffiLibrary, name: string, returnType: KoffiTypeSpec, argumentTypes: KoffiTypeSpec[]): DynamicFunction {
  return library.func(name, returnType, argumentTypes);
}

function optionalBind(library: KoffiLibrary, name: string, returnType: KoffiTypeSpec, argumentTypes: KoffiTypeSpec[]): DynamicFunction | undefined {
  try {
    return bind(library, name, returnType, argumentTypes);
  } catch {
    return undefined;
  }
}

function pluginPathForLibrary(libraryPath: string): string | undefined {
  const configured = process.env.LOOMTV_LIBVLC_PLUGIN_PATH?.trim();
  if (configured) return configured;
  const libraryDirectory = path.dirname(libraryPath);
  const candidates = [
    path.join(libraryDirectory, 'plugins'),
    path.join(libraryDirectory, 'Plugins'),
    path.resolve(libraryDirectory, '..', 'plugins'),
    path.resolve(libraryDirectory, '..', 'Plugins'),
    path.resolve(libraryDirectory, '..', '..', 'plugins'),
    path.resolve(libraryDirectory, '..', '..', 'Plugins'),
    // VLC.app layouts have used both Contents/MacOS/plugins and
    // Contents/Frameworks/plugins across macOS releases.
    path.resolve(libraryDirectory, '..', '..', 'Frameworks', 'plugins'),
    path.resolve(libraryDirectory, '..', '..', 'Frameworks', 'Plugins'),
    path.resolve(libraryDirectory, '..', 'MacOS', 'plugins'),
    path.resolve(libraryDirectory, '..', 'MacOS', 'Plugins'),
  ];
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}

function createLibVlcInstance(runtime: LibVlcRuntime): NativeHandle {
  // This is the fallback path when the process-lifetime instance could not be
  // warmed or the active runtime resolves a different libvlc image.
  const previousPluginPath = process.env.VLC_PLUGIN_PATH;
  const pluginPath = pluginPathForLibrary(runtime.libraryPath);
  if (pluginPath) process.env.VLC_PLUGIN_PATH = pluginPath;
  try {
    // Git checkouts and macOS signing do not preserve the mtimes embedded in
    // VLC's plugins.dat. Let the one process-wide instance scan its plugins
    // once during LoomTV's startup splash instead of validating a stale cache
    // every time the user presses Play.
    return nativeHandle(runtime.api.newInstance(
      LIBVLC_INSTANCE_ARGUMENTS.length,
      LIBVLC_INSTANCE_ARGUMENTS,
    ));
  } finally {
    if (previousPluginPath === undefined) delete process.env.VLC_PLUGIN_PATH;
    else process.env.VLC_PLUGIN_PATH = previousPluginPath;
  }
}

function loadRuntime(): { runtime: LibVlcRuntime | null; warning?: string } {
  if (!libVlcConfiguredEnabled() || libVlcKillSwitchEnabled() || !libVlcCompositionGateEnabled()) return { runtime: null };
  const platformBinding = libVlcPlatformBinding(process.platform);
  if (!platformBinding) return { runtime: null, warning: 'No LibVLC child-surface host is implemented for this platform.' };

  let koffi: KoffiRuntime;
  try {
    koffi = loadKoffi();
  } catch {
    return { runtime: null, warning: 'The optional koffi native binding is unavailable.' };
  }

  const rejected: string[] = [];
  for (const candidate of candidateLibraryPaths()) {
    try {
      const loadedLibraries: KoffiLibrary[] = [];
      // VLC's bundled libraries are normally loaded by the VLC executable,
      // which supplies the sibling core library and plugin path. Electron/
      // Koffi does not inherit that executable loader setup, so load the
      // sibling core first on both supported native platforms.
      if (process.platform === 'darwin' || process.platform === 'win32') {
        const corePath = path.join(
          path.dirname(candidate.path),
          process.platform === 'win32' ? 'libvlccore.dll' : 'libvlccore.dylib',
        );
        try {
          if (fs.statSync(corePath).isFile()) loadedLibraries.push(koffi.load(corePath));
        } catch {
          // Some system installations provide their own loader/rpath setup;
          // let the main library load attempt decide whether this candidate
          // is usable.
        }
      }
      const library = koffi.load(candidate.path);
      loadedLibraries.push(library);
      const trackDescriptionType = koffi.struct({
        i_id: 'int',
        psz_name: 'str',
        p_next: 'void *',
      });
      const api: LibVlcApi = {
        newInstance: bind(library, 'libvlc_new', 'void *', ['int', 'const char **']),
        releaseInstance: bind(library, 'libvlc_release', 'void', ['void *']),
        getVersion: bind(library, 'libvlc_get_version', 'str', []),
        mediaNewPath: bind(library, 'libvlc_media_new_path', 'void *', ['void *', 'str']),
        mediaNewLocation: bind(library, 'libvlc_media_new_location', 'void *', ['void *', 'str']),
        mediaAddOption: bind(library, 'libvlc_media_add_option', 'void', ['void *', 'str']),
        mediaRelease: bind(library, 'libvlc_media_release', 'void', ['void *']),
        playerNewFromMedia: bind(library, 'libvlc_media_player_new_from_media', 'void *', ['void *']),
        playerRelease: bind(library, 'libvlc_media_player_release', 'void', ['void *']),
        playerPlay: bind(library, 'libvlc_media_player_play', 'int', ['void *']),
        playerStop: bind(library, 'libvlc_media_player_stop', 'void', ['void *']),
        playerSetPause: bind(library, 'libvlc_media_player_set_pause', 'void', ['void *', 'int']),
        playerGetState: bind(library, 'libvlc_media_player_get_state', 'int', ['void *']),
        playerGetTime: bind(library, 'libvlc_media_player_get_time', 'int64', ['void *']),
        playerGetLength: bind(library, 'libvlc_media_player_get_length', 'int64', ['void *']),
        playerSetTime: bind(library, 'libvlc_media_player_set_time', 'void', ['void *', 'int64']),
        audioSetVolume: bind(library, 'libvlc_audio_set_volume', 'int', ['void *', 'int']),
        audioSetMute: bind(library, 'libvlc_audio_set_mute', 'void', ['void *', 'int']),
        audioGetTrack: optionalBind(library, 'libvlc_audio_get_track', 'int', ['void *']),
        playerSetRate: bind(library, 'libvlc_media_player_set_rate', 'int', ['void *', 'float']),
        setDrawable: bind(library, platformBinding.drawableSymbol, 'void', ['void *', 'void *']),
        videoSetMouseInput: optionalBind(library, 'libvlc_video_set_mouse_input', 'void', ['void *', 'int']),
        videoSetKeyInput: optionalBind(library, 'libvlc_video_set_key_input', 'void', ['void *', 'int']),
        videoSetTrack: optionalBind(library, 'libvlc_video_set_track', 'int', ['void *', 'int']),
        videoGetTrack: optionalBind(library, 'libvlc_video_get_track', 'int', ['void *']),
        videoGetTrackDescription: optionalBind(library, 'libvlc_video_get_track_description', 'void *', ['void *']),
        videoSetAspectRatio: optionalBind(library, 'libvlc_video_set_aspect_ratio', 'void', ['void *', 'str']),
        videoSetCropGeometry: optionalBind(library, 'libvlc_video_set_crop_geometry', 'void', ['void *', 'str']),
        audioSetTrack: optionalBind(library, 'libvlc_audio_set_track', 'int', ['void *', 'int']),
        audioGetTrackDescription: optionalBind(library, 'libvlc_audio_get_track_description', 'void *', ['void *']),
        subtitleSetTrack: optionalBind(library, 'libvlc_video_set_spu', 'int', ['void *', 'int']),
        subtitleGetTrack: optionalBind(library, 'libvlc_video_get_spu', 'int', ['void *']),
        subtitleGetTrackDescription: optionalBind(library, 'libvlc_video_get_spu_description', 'void *', ['void *']),
        trackDescriptionListRelease: optionalBind(library, 'libvlc_track_description_list_release', 'void', ['void *']),
        subtitleSetDelay: optionalBind(library, 'libvlc_video_set_spu_delay', 'int', ['void *', 'int64']),
        audioSetDelay: optionalBind(library, 'libvlc_audio_set_delay', 'int', ['void *', 'int64']),
      };
      const version = String(api.getVersion() || '').trim() || undefined;
      return { runtime: {
        api,
        loadedLibraries,
        libraryPath: candidate.path,
        version,
        source: candidate.source,
        decode: koffi.decode,
        trackDescriptionType,
      } };
    } catch (error) {
      rejected.push(`${candidate.path}: ${error instanceof Error ? error.message : 'could not load'}`);
    }
  }
  return { warning: rejected.length ? `LibVLC candidates could not be loaded: ${rejected.slice(0, 3).join('; ')}` : 'No LibVLC library candidate was found.', runtime: null };
}

function cachedRuntime(): RuntimeCache {
  const key = runtimeCacheKey();
  if (runtimeCache && runtimeCache.key === key && (runtimeCache.runtime || Date.now() - runtimeCache.resolvedAt < MISSING_RUNTIME_CACHE_MS)) {
    return runtimeCache;
  }
  const resolved = loadRuntime();
  runtimeCache = { key, runtime: resolved.runtime, warning: resolved.warning, resolvedAt: Date.now() };
  return runtimeCache;
}

export function invalidateLibVlcRuntimeCache(): void {
  runtimeCache = null;
}

export function libVlcAvailability(): LibVlcAvailability {
  if (!libVlcConfiguredEnabled() || libVlcKillSwitchEnabled() || !libVlcCompositionGateEnabled()) {
    return { available: false, enabled: false, surface: 'unavailable', reason: disabledReason() };
  }
  const cached = cachedRuntime();
  return cached.runtime
    ? { available: true, enabled: true, surface: 'composited-window', libraryPath: cached.runtime.libraryPath, version: cached.runtime.version, runtimeSource: cached.runtime.source, warning: cached.warning }
    : { available: false, enabled: true, surface: 'unavailable', warning: cached.warning, reason: 'The bundled or installed LibVLC runtime is unavailable. LoomTV will use MPV or Chromium/HLS fallback playback.' };
}

export function refreshLibVlcAvailability(): LibVlcAvailability {
  invalidateLibVlcRuntimeCache();
  return libVlcAvailability();
}

export function libVlcRuntimeSummary(): string {
  if (!libVlcConfiguredEnabled() || libVlcKillSwitchEnabled() || !libVlcCompositionGateEnabled()) {
    return `[playback] experimental LibVLC surface unavailable — ${disabledReason()}`;
  }

  const candidate = configuredLibraryCandidate();
  if (candidate) {
    return `[playback] LibVLC default — ${candidate.source} runtime detected at ${candidate.path}; one process-lifetime instance is warmed at app startup`;
  }

  return '[playback] LibVLC default — no bundled or installed runtime file detected; compatibility playback will be used if startup warmup cannot create the native runtime';
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nativeHandleForWindow(window: BrowserWindow): NativeDrawable {
  const handle = window.getNativeWindowHandle();
  if (!handle.length) throw new Error('The native LibVLC surface handle is unavailable.');
  const pointer = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  if (pointer === 0n) throw new Error('The native LibVLC surface handle is null.');
  return pointer;
}

type NativeViewHost = {
  drawable: NativeDrawable;
  setVisible: (visible: boolean) => void;
  /**
   * `animateSeconds` > 0 tweens the frame through Core Animation instead of
   * snapping it, so the native video travels on the window server at display
   * refresh. Match it to the renderer's chrome transition to keep the two in
   * step.
   */
  syncBounds: (viewport?: PlaybackViewport | null, animateSeconds?: number) => void;
  /** Hand frame sizing to AppKit so the view tracks an animated window resize. */
  setAutoresize: (enabled: boolean) => void;
  syncHierarchy: (forceRebind?: boolean) => boolean;
  destroy: () => void;
};

/**
 * Attach a LibVLC child surface to Electron's existing content view hierarchy.
 *
 * BrowserWindow/native-window drawables are not composited with WebContents:
 * LibVLC takes over that view and hides the renderer. The only supported
 * single-window route here is a real platform child surface, inserted at the
 * bottom of Electron's native view so the renderer remains the interactive
 * layer above it. Koffi is used only for the narrow platform calls; no second
 * BrowserWindow or owned window is created.
 */
function createMacOsNativeViewHost(koffi: KoffiRuntime, ownerWindow: BrowserWindow): NativeViewHost {
  if (process.platform !== 'darwin') throw new Error('The LibVLC NSView host is only available on macOS.');
  const ownerView = nativeHandleForWindow(ownerWindow);
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  // objc_getClass only resolves classes registered by an image already loaded
  // into this process. libobjc alone does not register AppKit, so NSView and
  // NSColor look up as NULL unless AppKit is resident. Electron normally links
  // it, but relying on that makes the host fail with a null class instead of a
  // real error whenever the host process differs. Load it explicitly.
  try {
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  } catch {
    // Already resident, or unavailable — the class lookups below report it.
  }
  const objcGetClass = objc.func('objc_getClass', 'void *', ['str']);
  const selRegisterName = objc.func('sel_registerName', 'void *', ['str']);
  const msgSend0 = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const msgSendVoid0 = objc.func('objc_msgSend', 'void', ['void *', 'void *']);
  const msgSendVoid1Bool = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'bool']);
  const msgSendVoid1Pointer = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *']);
  const msgSendVoid1UnsignedLong = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'ulong']);
  const msgSendVoid3PointerIntPointer = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *', 'int', 'void *']);
  const nsPoint = koffi.struct({ x: 'double', y: 'double' });
  const nsSize = koffi.struct({ width: 'double', height: 'double' });
  const nsRect = koffi.struct({ origin: nsPoint, size: nsSize });
  const msgSendVoid1Rect = objc.func('objc_msgSend', 'void', ['void *', 'void *', nsRect]);
  // Core Animation entry points. Animating the frame through NSAnimationContext
  // hands the tween to the window server, so the native video interpolates at
  // display refresh without an IPC round trip per frame — the only way it can
  // stay in step with a CSS transition running on Chromium's compositor.
  const msgSendVoid1Double = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'double']);
  const msgSendPointer4Float = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'float', 'float', 'float', 'float']);
  const animationContextClass = objcGetClass('NSAnimationContext');
  const timingFunctionClass = objcGetClass('CAMediaTimingFunction');

  const selector = (name: string): NativeHandle => nativeHandle(selRegisterName(name));
  const nsViewClass = objcGetClass('NSView');
  if (!nsViewClass) throw new Error('The macOS NSView class is unavailable.');
  const nsColorClass = objcGetClass('NSColor');
  const clearColor = nsColorClass ? msgSend0(nsColorClass, selector('clearColor')) as NativeDrawable : null;
  const blackColor = nsColorClass ? msgSend0(nsColorClass, selector('blackColor')) as NativeDrawable : null;
  const blackCgColor = blackColor ? msgSend0(blackColor, selector('CGColor')) as NativeDrawable : null;

  // Electron documents getNativeWindowHandle() as an NSView* on macOS. Use
  // that view only as the route to its NSWindow's contentView; attaching to
  // the renderer view itself is what gets detached/occluded by Chromium's
  // fullscreen surface.
  const ownerWindowObject = msgSend0(ownerView, selector('window')) as NativeDrawable;
  const ownerContentView = ownerWindowObject
    ? msgSend0(ownerWindowObject, selector('contentView')) as NativeDrawable
    : ownerView;
  if (!ownerContentView) throw new Error('The macOS Electron content view is unavailable.');

  // Electron's macOS native handle is commonly the WebContents view rather
  // than the window's root content view. Adding the LibVLC NSView as a child
  // of that handle puts it above Chromium even when NSWindowBelow is used;
  // the renderer then becomes a non-interactive-looking surface with its
  // controls painted underneath. When the handle has a superview, use that
  // superview as the native host and order LibVLC explicitly below the
  // renderer view. Older Electron layouts expose the root content view
  // directly, so retain the root as the safe fallback.
  const syncCompositingTransparency = (_contentView: NativeDrawable): void => {
    // The BrowserWindow must stay transparent for the MPV fallback and for
    // the LibVLC sibling view. A dedicated AppKit backing view below both
    // native surfaces hides whatever app is behind Loom without changing the
    // renderer's composition.
    try { ownerWindow.setBackgroundColor('#00000000'); } catch { /* best effort */ }
    try { msgSendVoid1Bool(ownerWindowObject, selector('setOpaque:'), false); } catch { /* best effort */ }
    try {
      if (clearColor) msgSendVoid1Pointer(ownerWindowObject, selector('setBackgroundColor:'), clearColor);
    } catch { /* best effort */ }
  };
  const restoreWindowTransparency = (): void => {
    try { ownerWindow.setBackgroundColor('#00000000'); } catch { /* best effort */ }
    try { msgSendVoid1Bool(ownerWindowObject, selector('setOpaque:'), false); } catch { /* best effort */ }
    try {
      if (clearColor) msgSendVoid1Pointer(ownerWindowObject, selector('setBackgroundColor:'), clearColor);
    } catch { /* best effort */ }
  };

  let nativeView: NativeDrawable | null = null;
  let backdropView: NativeDrawable | null = null;
  // Leave these unset until the first attach. The initial call uses the same
  // synchronizer as fullscreen reattachment, so it must perform a real insert
  // even when the first discovered hierarchy matches the preferred one.
  let parentView: NativeDrawable | null = null;
  let rendererView: NativeDrawable | null = null;
  try {
    backdropView = msgSend0(nsViewClass, selector('alloc')) as NativeDrawable;
    backdropView = msgSend0(backdropView, selector('init')) as NativeDrawable;
    if (!backdropView) throw new Error('The macOS LibVLC backdrop view could not be created.');
    msgSendVoid1Bool(backdropView, selector('setWantsLayer:'), true);
    const backdropLayer = msgSend0(backdropView, selector('layer')) as NativeDrawable;
    if (backdropLayer) {
      msgSendVoid1Bool(backdropLayer, selector('setOpaque:'), true);
      if (blackCgColor) msgSendVoid1Pointer(backdropLayer, selector('setBackgroundColor:'), blackCgColor);
    }

    nativeView = msgSend0(nsViewClass, selector('alloc')) as NativeDrawable;
    nativeView = msgSend0(nativeView, selector('init')) as NativeDrawable;
    if (!nativeView) throw new Error('The macOS LibVLC NSView could not be created.');

    // Seconds for the in-flight frame tween. Zero means apply immediately.
    let frameAnimationSeconds = 0;
    const setFrame = (view: NativeDrawable, x: number, y: number, width: number, height: number) => {
      const rect = {
        origin: { x, y },
        size: { width: Math.max(1, width), height: Math.max(1, height) },
      };
      if (frameAnimationSeconds > 0 && animationContextClass) {
        try {
          msgSendVoid0(animationContextClass, selector('beginGrouping'));
          try {
            const context = msgSend0(animationContextClass, selector('currentContext')) as NativeDrawable;
            if (context) {
              msgSendVoid1Double(context, selector('setDuration:'), frameAnimationSeconds);
              if (timingFunctionClass) {
                // Same curve as the renderer's chrome transition, so the video
                // and the controls travel together instead of merely starting
                // and ending together.
                const timing = msgSendPointer4Float(
                  timingFunctionClass,
                  selector('functionWithControlPoints::::'),
                  0.22, 0.8, 0.28, 1,
                ) as NativeDrawable;
                if (timing) msgSendVoid1Pointer(context, selector('setTimingFunction:'), timing);
              }
              const animator = msgSend0(view, selector('animator')) as NativeDrawable;
              if (animator) msgSendVoid1Rect(animator, selector('setFrame:'), rect);
              else msgSendVoid1Rect(view, selector('setFrame:'), rect);
            } else {
              msgSendVoid1Rect(view, selector('setFrame:'), rect);
            }
          } finally {
            msgSendVoid0(animationContextClass, selector('endGrouping'));
          }
          return;
        } catch {
          // Fall through to an immediate frame rather than losing the update.
        }
      }
      msgSendVoid1Rect(view, selector('setFrame:'), rect);
      try { msgSendVoid1Bool(view, selector('setNeedsLayout:'), true); } catch { /* best effort */ }
      try { msgSendVoid1Bool(view, selector('setNeedsDisplay:'), true); } catch { /* best effort */ }
      try { msgSendVoid0(view, selector('layoutSubtreeIfNeeded')); } catch { /* best effort */ }
      try { msgSendVoid0(view, selector('displayIfNeeded')); } catch { /* best effort */ }
    };
    const setHidden = (hidden: boolean) => msgSendVoid1Bool(nativeView, selector('setHidden:'), hidden);
    const setBackdropHidden = (hidden: boolean) => msgSendVoid1Bool(backdropView, selector('setHidden:'), hidden);
    let viewport: PlaybackViewport | null = null;
    const syncBounds = (nextViewport?: PlaybackViewport | null, animateSeconds = 0) => {
      if (!nativeView || !backdropView || ownerWindow.isDestroyed()) return;
      if (nextViewport !== undefined) viewport = nextViewport;
      frameAnimationSeconds = Math.max(0, animateSeconds);
      try {
        applyBounds();
      } finally {
        frameAnimationSeconds = 0;
      }
    };

    const applyBounds = () => {
      if (!nativeView || !backdropView || ownerWindow.isDestroyed()) return;
      const [contentWidth, contentHeight] = ownerWindow.getContentSize();
      const width = Math.max(1, contentWidth);
      const height = Math.max(1, contentHeight);
      if (!viewport) {
        setFrame(backdropView, 0, 0, width, height);
        setFrame(nativeView, 0, 0, width, height);
        return;
      }

      // Renderer coordinates have a top-left origin; NSView frames have a
      // bottom-left origin. Keep the native surface inside the actual video
      // frame instead of letting it cover the whole WebContents view.
      const left = clamp(viewport.x, 0, Math.max(0, width - 1));
      const top = clamp(viewport.y, 0, Math.max(0, height - 1));
      const frameWidth = clamp(viewport.width, 1, width - left);
      const frameHeight = clamp(viewport.height, 1, height - top);
      setFrame(backdropView, 0, 0, width, height);
      setFrame(nativeView, left, height - top - frameHeight, frameWidth, frameHeight);
    };

    const attachToContentView = (_forceRebind = false): boolean => {
      if (!nativeView || ownerWindow.isDestroyed()) throw new Error('The LoomTV native video view is unavailable.');
      const currentHandle = nativeHandleForWindow(ownerWindow);
      const currentWindowObject = msgSend0(currentHandle, selector('window')) as NativeDrawable;
      const currentContentView = currentWindowObject
        ? msgSend0(currentWindowObject, selector('contentView')) as NativeDrawable
        : currentHandle;
      if (!currentContentView) throw new Error('The macOS Electron content view is unavailable.');
      syncCompositingTransparency(currentContentView);
      const currentHandleSuperview = msgSend0(currentHandle, selector('superview')) as NativeDrawable;
      const nextParentView = currentHandleSuperview || currentContentView;
      const nextRendererView = currentHandleSuperview ? currentHandle : null;
      const hierarchyChanged = nextParentView !== parentView
        || nextRendererView !== rendererView;
      if (hierarchyChanged) {
        msgSendVoid0(nativeView, selector('removeFromSuperview'));
        msgSendVoid0(backdropView, selector('removeFromSuperview'));
        parentView = nextParentView;
        rendererView = nextRendererView;
      }
      if (!parentView) throw new Error('The macOS LibVLC native view host has no parent view.');
      // Re-assert bottom ordering only when the view hierarchy actually
      // changed. A confirmed fullscreen drawable rebind must not remove and
      // reinsert an already-correct NSView: AppKit/Chromium can promote that
      // reinsertion above WebContents, which hides Loom's controls. The
      // caller still uses forceRebind to refresh LibVLC's drawable without
      // disturbing this sibling order.
      if (hierarchyChanged) {
        msgSendVoid3PointerIntPointer(parentView, selector('addSubview:positioned:relativeTo:'), nativeView, -1, rendererView);
        msgSendVoid3PointerIntPointer(parentView, selector('addSubview:positioned:relativeTo:'), backdropView, -1, nativeView);
      }
      syncBounds();
      return hierarchyChanged;
    };

    // The renderer owns the viewport geometry. AppKit autoresizing would
    // stretch a letterboxed/cropped frame over Loom's controls between IPC
    // updates, so keep the child frame explicit and sync it from the renderer.
    //
    // The one exception is a native fullscreen transition: AppKit animates the
    // window over ~0.5s and the renderer cannot report a viewport until it
    // finishes, so an explicit frame would sit still and then snap. During
    // that window only, hand sizing to AppKit (see setAutoresize) so the view
    // scales in lockstep with the animation on the compositor.
    // NSViewMinXMargin|WidthSizable|MaxXMargin|MinYMargin|HeightSizable|MaxYMargin
    // makes both the size and all four margins flexible, so the frame grows
    // proportionally instead of pinning to a corner.
    const AUTORESIZE_PROPORTIONAL = 1 | 2 | 4 | 8 | 16 | 32;
    const setAutoresize = (enabled: boolean): void => {
      if (!nativeView || !backdropView) return;
      const mask = enabled ? AUTORESIZE_PROPORTIONAL : 0;
      msgSendVoid1UnsignedLong(nativeView, selector('setAutoresizingMask:'), mask);
      msgSendVoid1UnsignedLong(backdropView, selector('setAutoresizingMask:'), mask);
    };
    msgSendVoid1UnsignedLong(nativeView, selector('setAutoresizingMask:'), 0);
    msgSendVoid1UnsignedLong(backdropView, selector('setAutoresizingMask:'), 0);
    syncBounds();
    setBackdropHidden(true);
    setHidden(true);
    // Insert LibVLC below the renderer sibling, then place the black backing
    // below LibVLC so it cannot obscure the native video. Going through the
    // same hierarchy synchronizer here also avoids a first-frame ordering
    // difference between initial playback and fullscreen rebinds.
    attachToContentView(true);
    setBackdropHidden(false);
    setHidden(false);

    let destroyed = false;
    return {
      drawable: nativeView,
      setVisible: (visible) => {
        if (!destroyed && nativeView && backdropView) {
          setBackdropHidden(!visible);
          setHidden(!visible);
        }
      },
      syncBounds,
      setAutoresize,
      syncHierarchy: attachToContentView,
      destroy: () => {
        if (destroyed || !nativeView) return;
        destroyed = true;
        try { msgSendVoid0(nativeView, selector('removeFromSuperview')); } catch { /* best effort */ }
        try { msgSendVoid0(backdropView, selector('removeFromSuperview')); } catch { /* best effort */ }
        try { msgSendVoid0(nativeView, selector('release')); } catch { /* best effort */ }
        try { msgSendVoid0(backdropView, selector('release')); } catch { /* best effort */ }
        restoreWindowTransparency();
        nativeView = null;
        backdropView = null;
      },
    };
  } catch (error) {
    if (nativeView) {
      try { msgSendVoid0(nativeView, selector('removeFromSuperview')); } catch { /* best effort */ }
      try { msgSendVoid0(nativeView, selector('release')); } catch { /* best effort */ }
    }
    if (backdropView) {
      try { msgSendVoid0(backdropView, selector('removeFromSuperview')); } catch { /* best effort */ }
      try { msgSendVoid0(backdropView, selector('release')); } catch { /* best effort */ }
    }
    restoreWindowTransparency();
    throw error;
  }
}

/**
 * Attach a LibVLC HWND below Chromium on Windows.
 *
 * `libvlc_media_player_set_hwnd` renders into a child HWND, not into a
 * BrowserWindow's compositor surface. Creating two ordinary child controls
 * keeps the black backdrop below the video and keeps both below Electron's
 * Chromium child window, so Loom's controls remain clickable and visible.
 */
function createWindowsNativeViewHost(koffi: KoffiRuntime, ownerWindow: BrowserWindow): NativeViewHost {
  if (process.platform !== 'win32') throw new Error('The LibVLC HWND host is only available on Windows.');
  const ownerHandle = nativeHandleForWindow(ownerWindow);
  const user32 = koffi.load('user32.dll');
  const createWindowEx = user32.func('CreateWindowExA', 'void *', [
    'uint32', 'str', 'str', 'uint32', 'int', 'int', 'int', 'int',
    'void *', 'void *', 'void *', 'void *',
  ]);
  const destroyWindow = user32.func('DestroyWindow', 'bool', ['void *']);
  const showWindow = user32.func('ShowWindow', 'bool', ['void *', 'int']);
  const setWindowPos = user32.func('SetWindowPos', 'bool', [
    'void *', 'void *', 'int', 'int', 'int', 'int', 'uint32',
  ]);

  const WS_CHILD = 0x40000000;
  const WS_VISIBLE = 0x10000000;
  const WS_CLIPSIBLINGS = 0x04000000;
  const WS_CLIPCHILDREN = 0x02000000;
  const WS_EX_NOACTIVATE = 0x08000000;
  const SS_BLACKRECT = 0x00000004;
  const SW_HIDE = 0;
  const SW_SHOW = 5;
  const SWP_NOSIZE = 0x0001;
  const SWP_NOMOVE = 0x0002;
  const SWP_NOZORDER = 0x0004;
  const SWP_NOACTIVATE = 0x0010;
  const SWP_SHOWWINDOW = 0x0040;
  const SWP_NOOWNERZORDER = 0x0200;
  const HWND_BOTTOM = 1n;

  const positionFlags = SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW;
  const moveToBottom = (windowHandle: NativeDrawable): void => {
    setWindowPos(windowHandle, HWND_BOTTOM, 0, 0, 0, 0, positionFlags | SWP_NOSIZE | SWP_NOMOVE);
  };

  let backdrop: NativeDrawable | null = null;
  let nativeView: NativeDrawable | null = null;
  let destroyed = false;
  let attached = false;

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (nativeView) {
      try { showWindow(nativeView, SW_HIDE); } catch { /* best effort */ }
      try { destroyWindow(nativeView); } catch { /* best effort */ }
    }
    if (backdrop) {
      try { showWindow(backdrop, SW_HIDE); } catch { /* best effort */ }
      try { destroyWindow(backdrop); } catch { /* best effort */ }
    }
    nativeView = null;
    backdrop = null;
  };

  try {
    const childStyle = WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN;
    backdrop = nativeHandle(createWindowEx(
      WS_EX_NOACTIVATE,
      'STATIC',
      '',
      childStyle | SS_BLACKRECT,
      0,
      0,
      1,
      1,
      ownerHandle,
      null,
      null,
      null,
    ));
    if (!backdrop) throw new Error('The Windows LibVLC backdrop child could not be created.');

    nativeView = nativeHandle(createWindowEx(
      WS_EX_NOACTIVATE,
      'STATIC',
      '',
      childStyle | SS_BLACKRECT,
      0,
      0,
      1,
      1,
      ownerHandle,
      null,
      null,
      null,
    ));
    if (!nativeView) throw new Error('The Windows LibVLC video child could not be created.');

    const setFrame = (windowHandle: NativeDrawable, x: number, y: number, width: number, height: number): void => {
      setWindowPos(
        windowHandle,
        null,
        Math.round(x),
        Math.round(y),
        Math.max(1, Math.round(width)),
        Math.max(1, Math.round(height)),
        positionFlags | SWP_NOZORDER,
      );
    };

    let viewport: PlaybackViewport | null = null;
    const syncBounds = (nextViewport?: PlaybackViewport | null): void => {
      if (destroyed || !nativeView || !backdrop || ownerWindow.isDestroyed()) return;
      if (nextViewport !== undefined) viewport = nextViewport;
      const [contentWidth, contentHeight] = ownerWindow.getContentSize();
      const width = Math.max(1, contentWidth);
      const height = Math.max(1, contentHeight);
      setFrame(backdrop, 0, 0, width, height);
      if (!viewport) {
        setFrame(nativeView, 0, 0, width, height);
        return;
      }
      const left = clamp(viewport.x, 0, Math.max(0, width - 1));
      const top = clamp(viewport.y, 0, Math.max(0, height - 1));
      const frameWidth = clamp(viewport.width, 1, width - left);
      const frameHeight = clamp(viewport.height, 1, height - top);
      setFrame(nativeView, left, top, frameWidth, frameHeight);
    };

    const syncHierarchy = (_forceRebind = false): boolean => {
      if (destroyed || !nativeView || !backdrop) return false;
      // Child z-order is relative to the top-level Electron client area.
      // Keep the black backdrop at the bottom and the LibVLC child directly
      // above it; Chromium's existing child window remains above both.
      orderWindowsLibVlcChildren(nativeView, backdrop, moveToBottom);
      const changed = !attached;
      attached = true;
      return changed;
    };

    syncBounds();
    syncHierarchy(true);
    showWindow(backdrop, SW_SHOW);
    showWindow(nativeView, SW_SHOW);

    return {
      drawable: nativeView,
      setVisible: (visible) => {
        if (destroyed || !nativeView || !backdrop) return;
        showWindow(backdrop, visible ? SW_SHOW : SW_HIDE);
        showWindow(nativeView, visible ? SW_SHOW : SW_HIDE);
      },
      syncBounds,
      setAutoresize: () => { /* Windows child bounds are synchronized explicitly. */ },
      syncHierarchy,
      destroy,
    };
  } catch (error) {
    destroy();
    throw error;
  }
}

function createNativeViewHost(koffi: KoffiRuntime, ownerWindow: BrowserWindow): NativeViewHost {
  const platformBinding = libVlcPlatformBinding(process.platform);
  if (platformBinding?.host === 'macos-child') return createMacOsNativeViewHost(koffi, ownerWindow);
  if (platformBinding?.host === 'windows-child') return createWindowsNativeViewHost(koffi, ownerWindow);
  throw new Error('No LibVLC native child-surface host is available for this platform.');
}

function nativeStateStatus(state: number): LibVlcPlaybackState['status'] {
  if (state === 3 || state === 4) return 'ready';
  if (state === 6) return 'ended';
  if (state === 7) return 'error';
  if (state === 5) return 'closed';
  return 'loading';
}

class LibVlcPlaybackSession {
  readonly id = crypto.randomUUID();
  private readonly instance: NativeHandle;
  private readonly ownsInstance: boolean;
  private readonly media: NativeHandle;
  private player: NativeHandle;
  private timer: NodeJS.Timeout | null = null;
  private readonly startupPollDeadline = Date.now() + 2500;
  private startupPolling = true;
  private nativeSyncTimer: NodeJS.Timeout | null = null;
  private nativeSyncRetryCount = 0;
  private nativeSyncForceRebind = false;
  private nativeViewHost: NativeViewHost | null = null;
  private viewport: PlaybackViewport | null = null;
  private viewportRevision = 0;
  private finalViewportSyncTimer: NodeJS.Timeout | null = null;
  private finalViewportSyncPending = false;
  private nativeFullscreenTransition = false;
  /** Seconds to tween the next bounds application; consumed once. Matches the
   *  renderer's chrome transition so the video and controls move together. */
  private pendingBoundsAnimationSeconds = 0;
  private awaitingFullscreenViewport = false;
  private nativeRearmOnNextViewportSync = false;
  private stopped = false;
  private ended = false;
  private startSeconds: number;
  private startApplied = false;
  private requestedPaused = false;
  private lastPauseCommand: boolean | null = null;
  private pauseAcknowledgementDeadline = 0;
  private preferredAudioTrackId: number | null;
  private initialAudioSelectionApplied = false;
  private initialAudioSelectionAttempts = 0;
  private pendingRearmTrackSelection: LibVlcTrackSelection | null = null;
  private rearmTrackSelectionAttempts = 0;
  private videoAspect: string | null = null;
  private videoCrop: string | null = null;
  private subtitleDelaySeconds: number;
  private audioDelaySeconds: number;
  private nativeRearmUntil = 0;
  private nativeTracksSignature = '';
  private lastNativeTrackRefreshAt = 0;
  private state: LibVlcPlaybackState;
  private readonly windowListeners: Array<() => void> = [];

  constructor(
    private readonly runtime: LibVlcRuntime,
    private readonly owner: WebContents,
    private readonly ownerWindow: BrowserWindow,
    filePath: string,
    options: LibVlcStartOptions,
    private readonly onTerminated: (session: LibVlcPlaybackSession) => void,
  ) {
    this.startSeconds = Math.max(0, finite(options.startSeconds, 0));
    this.preferredAudioTrackId = Number.isFinite(options.audioTrackId)
      ? Number(options.audioTrackId)
      : null;
    this.subtitleDelaySeconds = finite(options.subtitleDelay, 0);
    this.audioDelaySeconds = finite(options.audioDelay, 0);
    this.state = {
      sessionId: this.id,
      status: 'starting',
      paused: false,
      volume: clamp(finite(options.volume, 1), 0, 1),
      muted: options.muted === true,
      speed: clamp(finite(options.speed, 1), 0.25, 3),
    };

    const api = runtime.api;
    const sharedInstance = getWarmLibVlcInstance(runtime.libraryPath);
    this.instance = sharedInstance ?? createLibVlcInstance(runtime);
    this.ownsInstance = sharedInstance === null;
    if (!this.instance) throw new Error('LibVLC could not create a media instance.');
    const isRemoteLocation = /^https:\/\//i.test(filePath);
    let media: NativeHandle;
    try {
      media = nativeHandle(isRemoteLocation
        ? api.mediaNewLocation(this.instance, filePath)
        : api.mediaNewPath(this.instance, filePath));
    } catch (error) {
      this.releaseOwnedInstance();
      throw error;
    }
    if (!media) {
      this.releaseOwnedInstance();
      throw new Error(isRemoteLocation
        ? 'LibVLC could not open the live TV stream.'
        : 'LibVLC could not open the authorized local media path.');
    }
    try {
      const platformBinding = libVlcPlatformBinding(process.platform);
      if (!platformBinding) throw new Error('LibVLC playback is not supported on this platform.');
      api.mediaAddOption(media, platformBinding.mediaVoutOption);
      if (options.audioLanguage && /^[a-z0-9_-]+$/i.test(options.audioLanguage)) {
        api.mediaAddOption(media, `:audio-language=${options.audioLanguage}`);
      }
      if (this.preferredAudioTrackId !== null) {
        api.mediaAddOption(media, `:audio-track=${this.preferredAudioTrackId}`);
      }
      for (const subtitle of options.subtitleFiles || []) api.mediaAddOption(media, `:sub-file=${subtitle.path}`);
      if (options.nativeSubtitles === false) api.mediaAddOption(media, ':no-spu');
      if (finite(options.subtitleDelay, 0) !== 0) api.mediaAddOption(media, `:sub-delay=${Math.round(finite(options.subtitleDelay, 0) * 1_000_000)}`);
      this.media = media;
      this.player = nativeHandle(api.playerNewFromMedia(media));
    } catch (error) {
      try { api.mediaRelease(media); } catch { /* best effort */ }
      this.releaseOwnedInstance();
      throw error;
    }
    if (!this.player) {
      try { api.mediaRelease(this.media); } catch { /* best effort */ }
      this.releaseOwnedInstance();
      throw new Error('LibVLC could not create a media player.');
    }

    try {
      // Attach LibVLC to a real platform child view inside the existing
      // Electron window. Directly attaching to the owner WebContents view
      // replaces the renderer layer, while a sibling child ordered below it
      // preserves all Loom controls, subtitles, and panels in the same OS
      // window.
      this.nativeViewHost = createNativeViewHost(loadKoffi(), ownerWindow);
      this.configureNativePlayer(this.player);
      if (nativeInt(api.playerPlay(this.player)) < 0) throw new Error('LibVLC rejected the authorized local media source.');
    } catch (error) {
      this.clearWindowListeners();
      this.release();
      this.destroyNativeView();
      throw error instanceof Error ? error : new Error('LibVLC could not start local playback.');
    }

    this.attachNativeViewListeners();
    const stopForDestroyedOwner = () => this.stop();
    owner.once('destroyed', stopForDestroyedOwner);
    this.windowListeners.push(() => owner.removeListener('destroyed', stopForDestroyedOwner));
    const stopForClosedOwner = () => this.stop();
    this.ownerWindow.once('closed', stopForClosedOwner);
    this.windowListeners.push(() => this.ownerWindow.removeListener('closed', stopForClosedOwner));
    this.emit({ status: 'loading' });
    // Detect initial readiness and apply resume seeks without waiting for the
    // steady-state progress interval. Bound the faster polling for slow media.
    this.timer = setInterval(() => this.poll(), 32);
    this.timer.unref();
  }

  private configureNativePlayer(player: NativeHandle): void {
    const api = this.runtime.api;
    if (!this.nativeViewHost) throw new Error('The LoomTV native video view is unavailable.');
    api.setDrawable(player, this.nativeViewHost.drawable);
    // LibVLC must not handle input; the native view is below WebContents and
    // all user interaction remains in Loom's renderer controls.
    api.videoSetMouseInput?.(player, 0);
    api.videoSetKeyInput?.(player, 0);
    // `volume` is optional on the shared playback state; fall back to full
    // volume rather than asserting, so a state without it cannot send NaN.
    api.audioSetVolume(player, Math.round((this.state.volume ?? 1) * 100));
    api.audioSetMute(player, this.state.muted ? 1 : 0);
    api.playerSetRate(player, this.state.speed);
    if (api.videoSetAspectRatio) api.videoSetAspectRatio(player, this.videoAspect);
    if (api.videoSetCropGeometry) api.videoSetCropGeometry(player, this.videoCrop);
    if (api.subtitleSetDelay) api.subtitleSetDelay(player, Math.round(this.subtitleDelaySeconds * 1_000_000));
    if (api.audioSetDelay) api.audioSetDelay(player, Math.round(this.audioDelaySeconds * 1_000_000));
  }

  private attachNativeViewListeners(): void {
    const syncBounds = () => {
      if (!this.syncNativeViewBounds()) this.scheduleNativeViewSync(false, 32);
    };
    // A fullscreen transition resizes the existing NSView hierarchy. Rebinding
    // the LibVLC drawable on every AppKit event can tear down VLC's vout and
    // leave a black surface, especially when the player is paused. The host
    // still rebinds when AppKit actually gives us a different content view;
    // otherwise only the final frame is committed.
    // Chromium may replace the fullscreen backing surface without changing
    // either the NSWindow contentView or its immediate child pointers. The
    // hierarchy can therefore compare equal while LibVLC remains bound to the
    // retired surface (audio/subtitles continue, picture turns black). The
    // final renderer handshake rebinds that drawable once after layout commits.
    // The renderer handshake owns the final drawable rebind. Native and HTML
    // events can both fire for the same transition, so only check geometry here.
    const syncHierarchy = () => this.scheduleNativeViewSync(false, 32);
    const syncVisibility = () => this.syncNativeViewVisibility();
    const restoreNativeSurface = () => {
      this.syncNativeViewVisibility();
      // A long idle, display sleep, minimize, or app switch can retire the
      // backing surface without changing the NSView pointers. Refresh the
      // existing drawable when the window becomes usable again so playback
      // cannot return as audio/subtitles over a black picture.
      this.scheduleNativeViewSync(true, 32);
    };
    this.ownerWindow.on('move', syncBounds);
    this.ownerWindow.on('resize', syncBounds);
    this.ownerWindow.on('maximize', syncBounds);
    this.ownerWindow.on('unmaximize', syncBounds);
    this.ownerWindow.on('enter-full-screen', syncHierarchy);
    this.ownerWindow.on('leave-full-screen', syncHierarchy);
    this.ownerWindow.on('enter-html-full-screen', syncHierarchy);
    this.ownerWindow.on('leave-html-full-screen', syncHierarchy);
    this.ownerWindow.on('minimize', syncVisibility);
    this.ownerWindow.on('restore', restoreNativeSurface);
    this.ownerWindow.on('hide', syncVisibility);
    this.ownerWindow.on('show', restoreNativeSurface);
    this.ownerWindow.on('focus', restoreNativeSurface);
    this.windowListeners.push(() => {
      this.ownerWindow.removeListener('move', syncBounds);
      this.ownerWindow.removeListener('resize', syncBounds);
      this.ownerWindow.removeListener('maximize', syncBounds);
      this.ownerWindow.removeListener('unmaximize', syncBounds);
      this.ownerWindow.removeListener('enter-full-screen', syncHierarchy);
      this.ownerWindow.removeListener('leave-full-screen', syncHierarchy);
      this.ownerWindow.removeListener('enter-html-full-screen', syncHierarchy);
      this.ownerWindow.removeListener('leave-html-full-screen', syncHierarchy);
      this.ownerWindow.removeListener('minimize', syncVisibility);
      this.ownerWindow.removeListener('restore', restoreNativeSurface);
      this.ownerWindow.removeListener('hide', syncVisibility);
      this.ownerWindow.removeListener('show', restoreNativeSurface);
      this.ownerWindow.removeListener('focus', restoreNativeSurface);
    });
    this.syncNativeViewVisibility();
  }

  private syncNativeViewVisibility(): void {
    if (!this.nativeViewHost || this.ownerWindow.isDestroyed()) return;
    if (this.ownerWindow.isMinimized() || !this.ownerWindow.isVisible()) {
      this.nativeViewHost.setVisible(false);
      return;
    }
    if (this.nativeFullscreenTransition || this.awaitingFullscreenViewport) {
      // Stay visible: AppKit is autoresizing the view in lockstep with the
      // animated window, so the video scales with it. Hiding here is what made
      // the transition read as a blackout followed by a snap.
      this.nativeViewHost.setVisible(true);
      return;
    }
    if (!this.syncNativeViewHost(false)) {
      this.nativeViewHost.setVisible(false);
      this.scheduleNativeViewSync(true, 32);
      return;
    }
    this.nativeViewHost.setVisible(true);
  }

  private syncNativeViewBounds(): boolean {
    if (!this.nativeViewHost || this.ownerWindow.isDestroyed()) return false;
    if (this.nativeFullscreenTransition) return true;
    try {
      // A fullscreen flip is the one resize the user watches, so tween it.
      // Every other resize (window drag, panel open) must stay immediate or
      // the video would lag the pointer.
      const animateSeconds = this.pendingBoundsAnimationSeconds;
      this.pendingBoundsAnimationSeconds = 0;
      this.nativeViewHost.syncBounds(this.viewport, animateSeconds);
      return true;
    } catch (error) {
      console.warn('[libvlc] native viewport sync failed:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  private syncNativeViewHost(forceRebind = false, viewportOverride?: PlaybackViewport | null): boolean {
    if (!this.nativeViewHost || this.ownerWindow.isDestroyed()) return false;
    if (this.nativeFullscreenTransition || this.awaitingFullscreenViewport) {
      return true;
    }
    try {
      // Always reassert the AppKit hierarchy and drawable on a surface sync.
      // macOS can retain the same contentView pointer while replacing the
      // backing surface during fullscreen, so pointer equality is not enough.
      // Pass the session's latest viewport explicitly: viewport IPC may arrive
      // during an AppKit transition while the native host intentionally holds
      // off applying frames until the transition has completed.
      const nextViewport = viewportOverride === undefined ? this.viewport : viewportOverride;
      if (process.env.LOOMTV_DEBUG_LIBVLC === '1') {
        console.log('[libvlc] native surface sync', {
          forceRebind,
          fullscreen: this.ownerWindow.isFullScreen(),
          contentSize: this.ownerWindow.getContentSize(),
          viewport: nextViewport,
        });
      }
      this.nativeViewHost.syncBounds(nextViewport);
      const hierarchyChanged = this.nativeViewHost.syncHierarchy(forceRebind);
      const drawableNeedsRebind = forceRebind || hierarchyChanged;
      if (hierarchyChanged) {
        // The host may still be hidden from the transition guard when the
        // AppKit hierarchy is finally reattached. LibVLC's macOS vout can
        // initialize against a hidden NSView and remain black even though
        // playback time continues to advance. Make the confirmed host
        // visible before rebinding/recreating the vout.
        if (!this.ownerWindow.isMinimized() && this.ownerWindow.isVisible()) {
          this.nativeViewHost.setVisible(true);
        }
      }
      if (drawableNeedsRebind) {
        this.runtime.api.setDrawable(this.player, this.nativeViewHost.drawable);
        // AppKit can invalidate LibVLC's vout on both sides of a fullscreen
        // transition. Re-arm only after the confirmed post-transition
        // hierarchy/viewport sync, but do it for enter and exit alike.
        if (hierarchyChanged && this.nativeRearmOnNextViewportSync) {
          this.rearmNativeVideoOutput();
          this.nativeRearmOnNextViewportSync = false;
        }
      }
      return true;
    } catch (error) {
      console.warn('[libvlc] native surface sync failed:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  private rearmNativeVideoOutput(): void {
    const api = this.runtime.api;
    const positionMs = Number(api.playerGetTime(this.player));
    const previousPlayer = this.player;
    const previousState = Number(api.playerGetState(previousPlayer));
    const wasPaused = this.requestedPaused || previousState === 4;
    this.pendingRearmTrackSelection = captureLibVlcTrackSelection({
      video: {
        get: api.videoGetTrack ? () => api.videoGetTrack?.(previousPlayer) : undefined,
      },
      audio: {
        get: api.audioGetTrack ? () => api.audioGetTrack?.(previousPlayer) : undefined,
      },
      subtitle: {
        get: api.subtitleGetTrack ? () => api.subtitleGetTrack?.(previousPlayer) : undefined,
      },
    });
    this.rearmTrackSelectionAttempts = 0;
    // LibVLC's macOS vout can keep its old CALayer after an NSView is moved
    // through Electron's fullscreen hierarchy. Rebinding the drawable and
    // calling stop/play is not sufficient: the decoder runs, but the old vout
    // remains black. Create a fresh media player from the same authorized
    // descriptor so the vout is constructed against the final NSView.
    // A macOS vout can report `closed` briefly while the new decoder and
    // surface are being constructed. Keep the session alive long enough for
    // that legitimate re-arm state instead of tearing the Loom player down.
    this.nativeRearmUntil = Date.now() + 5_000;
    try { api.playerStop(previousPlayer); } catch { /* release still runs */ }
    try { api.playerRelease(previousPlayer); } catch { /* recreate below */ }
    this.player = null;
    const nextPlayer = nativeHandle(api.playerNewFromMedia(this.media));
    if (!nextPlayer) throw new Error('LibVLC could not recreate the native video output.');
    this.player = nextPlayer;
    this.lastPauseCommand = null;
    this.configureNativePlayer(nextPlayer);
    this.initialAudioSelectionApplied = this.preferredAudioTrackId === null;
    this.initialAudioSelectionAttempts = 0;
    if (Number(api.playerPlay(nextPlayer)) < 0) throw new Error('LibVLC could not re-arm the native video output.');
    const restorePosition = () => {
      if (this.stopped || this.player !== nextPlayer || positionMs < 0) return;
      try { api.playerSetTime(nextPlayer, Math.round(positionMs)); } catch { /* best effort */ }
    };
    const seekTimer = setTimeout(restorePosition, 180);
    seekTimer.unref();
    if (wasPaused) {
      const pauseTimer = setTimeout(() => {
        if (this.stopped || this.player !== nextPlayer) return;
        try {
          api.playerSetPause(nextPlayer, 1);
          this.lastPauseCommand = true;
          this.state = { ...this.state, paused: true };
        } catch { /* best effort */ }
      }, 360);
      pauseTimer.unref();
    }
  }

  private scheduleFinalViewportSync(delayMs = 140): void {
    if (this.stopped || !this.nativeViewHost || this.ownerWindow.isDestroyed() || this.finalViewportSyncPending) return;
    this.finalViewportSyncPending = true;
    const timer = setTimeout(() => {
      this.finalViewportSyncTimer = null;
      this.finalViewportSyncPending = false;
      if (this.stopped || !this.nativeViewHost || this.ownerWindow.isDestroyed()) return;
      this.awaitingFullscreenViewport = false;
      // The animation is over and the renderer has reported its confirmed
      // rectangle, so take frame ownership back before applying it. Leaving
      // the mask on would let a later window resize stretch the letterboxed
      // frame over Loom's controls between IPC updates.
      this.nativeViewHost.setAutoresize(false);
      const synced = this.syncNativeViewHost(true, this.viewport);
      if (synced) {
        this.nativeViewHost.setVisible(!this.ownerWindow.isMinimized() && this.ownerWindow.isVisible());
        return;
      }
      // Keep the renderer cover in place until a later attempt really
      // reattaches the native vout; returning a premature success here would
      // expose the transparent BrowserWindow backing as a black/white flash.
      this.awaitingFullscreenViewport = true;
      this.scheduleFinalViewportSync(180);
    }, Math.max(0, delayMs));
    this.finalViewportSyncTimer = timer;
    timer.unref();
  }

  private scheduleNativeViewSync(forceRebind: boolean, delayMs: number): void {
    if (this.stopped || !this.nativeViewHost || this.ownerWindow.isDestroyed()) return;
    this.nativeSyncForceRebind = this.nativeSyncForceRebind || forceRebind;
    if (this.nativeSyncTimer) return;
    this.nativeSyncTimer = setTimeout(() => {
      this.nativeSyncTimer = null;
      const shouldRebind = this.nativeSyncForceRebind;
      this.nativeSyncForceRebind = false;
      if (this.syncNativeViewHost(shouldRebind)) {
        this.nativeSyncRetryCount = 0;
        if (!this.nativeFullscreenTransition && !this.awaitingFullscreenViewport) {
          this.nativeViewHost?.setVisible(!this.ownerWindow.isMinimized() && this.ownerWindow.isVisible());
        }
        return;
      }
      if (this.nativeSyncRetryCount < 4) {
        const retryDelay = [32, 96, 240, 500][this.nativeSyncRetryCount] || 500;
        this.nativeSyncRetryCount += 1;
        this.scheduleNativeViewSync(shouldRebind, retryDelay);
        return;
      }
      console.warn('[libvlc] native surface sync did not succeed after retries.');
      this.nativeSyncRetryCount = 0;
    }, Math.max(0, delayMs));
    this.nativeSyncTimer.unref();
  }

  syncSurface(sender: WebContents): boolean {
    if (this.stopped || this.owner !== sender) return false;
    if (this.nativeFullscreenTransition || this.awaitingFullscreenViewport) return false;
    // This handshake is called only after the renderer has committed a
    // fullscreen layout. Force LibVLC to acknowledge the current drawable even
    // when AppKit reused the same NSView pointers around the transition.
    const synced = this.syncNativeViewHost(true);
    return synced;
  }

  isOwnedBy(sender: WebContents): boolean {
    return !this.stopped && this.owner === sender;
  }

  setFullscreenTransition(sender: WebContents, transitioning: boolean, waitForFinalViewport = true): boolean {
    if (this.stopped || this.owner !== sender) return false;
    this.nativeFullscreenTransition = transitioning;
    if (transitioning) {
      if (this.finalViewportSyncTimer) clearTimeout(this.finalViewportSyncTimer);
      this.finalViewportSyncTimer = null;
      this.finalViewportSyncPending = false;
      // Let AppKit resize the already-attached native view with the same
      // transaction as the Electron window. This avoids holding the old
      // viewport during a macOS fullscreen animation and then snapping it to
      // the final size after the event. No drawable rebind occurs here; the
      // one exact viewport/drawable sync happens after the confirmed event.
      this.nativeViewHost?.setAutoresize(true);
      return true;
    }

    // A failed/timed-out window request did not change fullscreen state. In
    // that case the current renderer viewport is still authoritative; restore
    // it immediately instead of leaving the native surface hidden while
    // waiting for a ResizeObserver event that can never arrive.
    if (!waitForFinalViewport) {
      this.awaitingFullscreenViewport = false;
      this.nativeViewHost?.setAutoresize(false);
      const synced = this.syncNativeViewHost(false);
      if (synced) {
        this.nativeViewHost?.setVisible(!this.ownerWindow.isMinimized() && this.ownerWindow.isVisible());
      } else {
        this.nativeViewHost?.setVisible(false);
        this.scheduleNativeViewSync(true, 32);
      }
      return synced;
    }

    // Do not guess a frame from the pre-transition viewport. ResizeObserver
    // must report the renderer's confirmed post-transition video rectangle;
    // the renderer's readiness handshake calls setViewport even when the
    // rectangle's values did not change, so this remains event-driven without
    // exposing an old-aspect frame or forcing a second corrective resize.
    //
    // No unconditional re-arm here. Re-arming builds a whole new media player
    // (rearmNativeVideoOutput), which restarts the VideoToolbox decoder and
    // stalls playback on every transition. That was only necessary while the
    // view was hidden and detached across the transition; it now stays
    // attached and visible for the whole resize, so the vout and its CALayer
    // remain valid. syncNativeViewHost still re-arms if syncHierarchy reports
    // a genuine reparent, which is the case this guarded against.
    //
    // Do not set awaitingFullscreenViewport either: the renderer's CSS
    // animation is about to stream intermediate rectangles through
    // setViewport, and deferring them until one "final" sync is exactly what
    // stopped the video from scaling with the window.
    this.awaitingFullscreenViewport = false;
    this.nativeViewHost?.setAutoresize(false);
    // Deliberately 0: do not tween the native frame.
    //
    // syncBounds still supports a Core Animation tween (animateSeconds), and it
    // does animate the NSView correctly — but LibVLC's caopengllayer vout does
    // not redraw at the intermediate sizes, so the picture goes black for the
    // whole tween while the chrome glides. Measured directly: chrome scaled
    // smoothly across three consecutive frames with no video behind it.
    //
    // The native surface cannot be interpolated. Snapping it, and snapping the
    // chrome layout with it, is the only combination where the two stay
    // coherent. See the note on .loom-player-controls in index.css.
    this.pendingBoundsAnimationSeconds = 0;
    this.syncNativeViewHost(true, this.viewport);
    return true;
  }

  setViewport(sender: WebContents, viewport: PlaybackViewport): boolean {
    if (this.stopped || this.owner !== sender || !this.nativeViewHost) return false;
    const [contentWidth, contentHeight] = this.ownerWindow.getContentSize();
    // ResizeObserver callbacks from the old fullscreen layout can arrive
    // after AppKit has already restored the window. Do not let that stale
    // rectangle stretch the native view back over the new content bounds.
    if (contentWidth > 0 && contentHeight > 0
      && (viewport.width > contentWidth * 1.25 + 8 || viewport.height > contentHeight * 1.25 + 8)) {
      return false;
    }
    this.viewport = viewport;
    this.viewportRevision += 1;
    if (this.nativeFullscreenTransition) return true;
    if (this.awaitingFullscreenViewport) {
      // AppKit's fullscreen event is emitted before the window's final
      // compositor transaction has settled on some macOS versions. Defer the
      // one deliberate rebind until after that transaction, and keep the
      // renderer's opaque transition cover up until the native surface is
      // actually ready.
      this.scheduleFinalViewportSync();
      return false;
    }
    if (this.syncNativeViewBounds()) return true;
    this.scheduleNativeViewSync(false, 32);
    return false;
  }

  private emit(patch: Partial<LibVlcPlaybackState>): void {
    this.state = { ...this.state, ...patch };
    syncNativePlaybackDisplaySleep(this.id, this.state);
    if (!this.owner.isDestroyed()) this.owner.send('libvlc:state', this.state);
  }

  private applyPendingRearmTrackSelection(): void {
    if (!this.pendingRearmTrackSelection || !this.player) return;
    const api = this.runtime.api;
    this.rearmTrackSelectionAttempts += 1;
    const restored = restoreLibVlcTrackSelection(this.pendingRearmTrackSelection, {
      video: {
        get: api.videoGetTrack ? () => api.videoGetTrack?.(this.player) : undefined,
        set: api.videoSetTrack ? (trackId) => api.videoSetTrack?.(this.player, trackId) : undefined,
      },
      audio: {
        get: api.audioGetTrack ? () => api.audioGetTrack?.(this.player) : undefined,
        set: api.audioSetTrack ? (trackId) => api.audioSetTrack?.(this.player, trackId) : undefined,
      },
      subtitle: {
        get: api.subtitleGetTrack ? () => api.subtitleGetTrack?.(this.player) : undefined,
        set: api.subtitleSetTrack ? (trackId) => api.subtitleSetTrack?.(this.player, trackId) : undefined,
      },
    });
    if (!restored && this.rearmTrackSelectionAttempts < 8) return;
    if (!restored) console.warn('[libvlc] native track selection could not be fully restored after fullscreen re-arm.');
    this.pendingRearmTrackSelection = null;
    this.rearmTrackSelectionAttempts = 0;
    this.refreshNativeTracks(true);
  }

  private applyInitialAudioSelection(): void {
    if (this.initialAudioSelectionApplied || this.preferredAudioTrackId === null || !this.player) return;
    const api = this.runtime.api;
    if (api.audioGetTrack) {
      try {
        if (Number(api.audioGetTrack(this.player)) === this.preferredAudioTrackId) {
          this.initialAudioSelectionApplied = true;
          return;
        }
      } catch {
        // Retry through the setter while the decoder is becoming ready.
      }
    }
    if (!api.audioSetTrack || this.initialAudioSelectionAttempts >= 8) return;
    this.initialAudioSelectionAttempts += 1;
    try {
      const accepted = Number(api.audioSetTrack(this.player, this.preferredAudioTrackId)) >= 0;
      if (accepted && !api.audioGetTrack) this.initialAudioSelectionApplied = true;
    } catch {
      // LibVLC can reject track changes during its opening state. The 250 ms
      // poll retries after the decoder exposes its elementary streams.
    }
  }

  private readNativeTrackDescriptions(
    type: PlaybackTrack['type'],
    getDescriptions: DynamicFunction | undefined,
    getSelected: DynamicFunction | undefined,
  ): PlaybackTrack[] {
    const release = this.runtime.api.trackDescriptionListRelease;
    if (!getDescriptions || !release || !this.player) return [];
    const head = nativeHandle(getDescriptions(this.player));
    if (!head) return [];
    const selectedId = getSelected ? Number(getSelected(this.player)) : Number.NaN;
    const tracks: PlaybackTrack[] = [];
    let cursor: NativeHandle = head;
    try {
      for (let count = 0; cursor && count < 256; count += 1) {
        const description = this.runtime.decode(cursor, this.runtime.trackDescriptionType);
        const id = Number(description.i_id);
        if (Number.isFinite(id) && id >= 0) {
          tracks.push({
            id,
            type,
            title: typeof description.psz_name === 'string' ? description.psz_name : undefined,
            selected: id === selectedId,
            source: 'embedded',
          });
        }
        cursor = nativeHandle(description.p_next);
      }
    } finally {
      release(head);
    }
    return tracks;
  }

  private refreshNativeTracks(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastNativeTrackRefreshAt < 500) return;
    this.lastNativeTrackRefreshAt = now;
    const api = this.runtime.api;
    const tracks = [
      ...this.readNativeTrackDescriptions('video', api.videoGetTrackDescription, api.videoGetTrack),
      ...this.readNativeTrackDescriptions('audio', api.audioGetTrackDescription, api.audioGetTrack),
      ...this.readNativeTrackDescriptions('subtitle', api.subtitleGetTrackDescription, api.subtitleGetTrack),
    ];
    if (tracks.length === 0) return;
    const signature = JSON.stringify(tracks.map((track) => [track.type, track.id, track.title, track.selected]));
    if (signature === this.nativeTracksSignature) return;
    this.nativeTracksSignature = signature;
    this.emit({ tracks });
  }

  private poll(): void {
    if (this.stopped) return;
    try {
      const api = this.runtime.api;
      const nativeState = Number(api.playerGetState(this.player));
      const status = nativeStateStatus(nativeState);
      if (this.startupPolling && (status === 'ready' || Date.now() >= this.startupPollDeadline)) {
        this.startupPolling = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.poll(), 250);
        this.timer.unref();
      }
      if (status === 'closed' && Date.now() < this.nativeRearmUntil) return;
      const durationMs = Number(api.playerGetLength(this.player));
      const positionMs = Number(api.playerGetTime(this.player));
      if (status === 'ready') {
        this.applyPendingRearmTrackSelection();
        this.applyInitialAudioSelection();
        this.refreshNativeTracks();
      }
      if (status === 'ready' && this.startSeconds > 0 && !this.startApplied) {
        api.playerSetTime(this.player, Math.round(this.startSeconds * 1_000));
        this.startApplied = true;
      }
      const nativePaused = nativeState === 4;
      if (nativePaused === this.requestedPaused) this.pauseAcknowledgementDeadline = 0;
      this.emit({
        status,
        duration: durationMs > 0 ? durationMs / 1_000 : undefined,
        position: positionMs >= 0 ? positionMs / 1_000 : undefined,
        // set_pause is asynchronous inside VLC. Do not undo the acknowledged
        // button state with a poll from before the decoder applied the command.
        paused: Date.now() < this.pauseAcknowledgementDeadline ? this.requestedPaused : nativePaused,
      });
      if (status === 'ended') {
        this.ended = true;
        this.finish();
      } else if (status === 'closed') {
        this.finish('closed');
      } else if (status === 'error') {
        this.finish('error', 'LibVLC reported a playback error.');
      }
    } catch (error) {
      this.finish('error', error instanceof Error ? error.message : 'LibVLC playback failed.');
    }
  }

  command(command: LibVlcCommand): boolean {
    if (this.stopped) return false;
    try {
      const api = this.runtime.api;
      switch (command.type) {
        case 'set-paused':
          if (this.lastPauseCommand === command.paused
            && (Date.now() < this.pauseAcknowledgementDeadline
              || (Number(api.playerGetState(this.player)) === 4) === command.paused)) return true;
          api.playerSetPause(this.player, command.paused ? 1 : 0);
          this.lastPauseCommand = command.paused;
          this.requestedPaused = command.paused;
          this.pauseAcknowledgementDeadline = Date.now() + 750;
          this.emit({ paused: command.paused });
          return true;
        case 'seek': api.playerSetTime(this.player, Math.round(Math.max(0, finite(command.position, 0)) * 1_000)); return true;
        case 'set-volume': {
          const volume = clamp(finite(command.volume, 1), 0, 1);
          const applied = Number(api.audioSetVolume(this.player, Math.round(volume * 100))) >= 0;
          if (applied) this.emit({ volume });
          return applied;
        }
        case 'set-muted':
          api.audioSetMute(this.player, command.muted ? 1 : 0);
          this.emit({ muted: command.muted });
          return true;
        case 'set-speed': {
          const speed = clamp(finite(command.speed, 1), 0.25, 3);
          const applied = Number(api.playerSetRate(this.player, speed)) >= 0;
          if (applied) this.emit({ speed });
          return applied;
        }
        case 'set-video-track': {
          const applied = api.videoSetTrack ? Number(api.videoSetTrack(this.player, command.trackId ?? -1)) >= 0 : false;
          if (applied) this.refreshNativeTracks(true);
          return applied;
        }
        case 'set-audio-track': {
          if (!api.audioSetTrack) return false;
          const applied = Number(api.audioSetTrack(this.player, command.trackId ?? -1)) >= 0;
          if (applied) {
            this.preferredAudioTrackId = command.trackId;
            this.initialAudioSelectionApplied = true;
            this.initialAudioSelectionAttempts = 0;
            this.refreshNativeTracks(true);
          }
          return applied;
        }
        case 'set-subtitle-track': {
          const applied = api.subtitleSetTrack ? Number(api.subtitleSetTrack(this.player, command.trackId ?? -1)) >= 0 : false;
          if (applied) this.refreshNativeTracks(true);
          return applied;
        }
        case 'set-subtitle-delay': {
          if (!api.subtitleSetDelay) return false;
          const applied = Number(api.subtitleSetDelay(this.player, Math.round(command.seconds * 1_000_000))) >= 0;
          if (applied) this.subtitleDelaySeconds = command.seconds;
          return applied;
        }
        case 'set-audio-delay': {
          if (!api.audioSetDelay) return false;
          const applied = Number(api.audioSetDelay(this.player, Math.round(command.seconds * 1_000_000))) >= 0;
          if (applied) this.audioDelaySeconds = command.seconds;
          return applied;
        }
        case 'set-video-aspect': {
          if (!api.videoSetAspectRatio) return false;
          api.videoSetAspectRatio(this.player, command.aspect);
          this.videoAspect = command.aspect;
          return true;
        }
        case 'set-video-crop': {
          if (!api.videoSetCropGeometry) return false;
          api.videoSetCropGeometry(this.player, command.crop);
          this.videoCrop = command.crop;
          return true;
        }
        case 'set-video-rotation': return command.degrees === 0;
        default: return false;
      }
    } catch {
      return false;
    }
  }

  stop(): boolean {
    if (this.stopped) return false;
    try { this.runtime.api.playerStop(this.player); } catch { /* release still runs */ }
    this.finish();
    return true;
  }

  private releaseOwnedInstance(): void {
    if (!this.ownsInstance || !this.instance) return;
    try { this.runtime.api.releaseInstance(this.instance); } catch { /* best effort */ }
  }

  private release(): void {
    if (this.player) {
      try { this.runtime.api.playerRelease(this.player); } catch { /* best effort */ }
      this.player = null;
    }
    try { this.runtime.api.mediaRelease(this.media); } catch { /* best effort */ }
    this.releaseOwnedInstance();
  }

  private destroyNativeView(): void {
    const nativeViewHost = this.nativeViewHost;
    this.nativeViewHost = null;
    nativeViewHost?.destroy();
  }

  private clearWindowListeners(): void {
    for (const removeListener of this.windowListeners.splice(0)) removeListener();
    if (this.nativeSyncTimer) clearTimeout(this.nativeSyncTimer);
    this.nativeSyncTimer = null;
    if (this.finalViewportSyncTimer) clearTimeout(this.finalViewportSyncTimer);
    this.finalViewportSyncTimer = null;
    this.finalViewportSyncPending = false;
    this.nativeSyncForceRebind = false;
    this.nativeSyncRetryCount = 0;
    this.nativeRearmOnNextViewportSync = false;
  }

  private finish(finalStatus?: 'ended' | 'error' | 'closed', error?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    releaseNativePlaybackDisplaySleep(this.id);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clearWindowListeners();
    this.release();
    this.destroyNativeView();
    this.emit({
      status: finalStatus || (this.ended ? 'ended' : 'closed'),
      paused: true,
      ...(error ? { error } : {}),
    });
    this.onTerminated(this);
  }
}

export function startLibVlcPlayback(
  owner: WebContents,
  filePath: string,
  options: LibVlcStartOptions = {},
  sourcePolicy: { allowRemoteHttps?: boolean } = {},
): { ok: boolean; sessionId?: string; surface?: LibVlcSurface; error?: string } {
  if (!libVlcConfiguredEnabled() || libVlcKillSwitchEnabled() || !libVlcCompositionGateEnabled()) return { ok: false, surface: 'unavailable', error: disabledReason() };
  const isRemoteHttps = /^https:\/\//i.test(filePath);
  if ((/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath) && !(isRemoteHttps && sourcePolicy.allowRemoteHttps)) || /^\\\\/.test(filePath)) {
    return { ok: false, surface: 'unavailable', error: 'LibVLC only accepts an authorized local file.' };
  }
  const cached = cachedRuntime();
  const ownerWindow = BrowserWindow.fromWebContents(owner);
  if (!cached.runtime) return { ok: false, surface: 'unavailable', error: cached.warning || 'LibVLC is unavailable.' };
  if (!ownerWindow || ownerWindow.isDestroyed()) return { ok: false, surface: 'unavailable', error: 'The LoomTV window is unavailable.' };
  try {
    currentSession?.stop();
    const session = new LibVlcPlaybackSession(cached.runtime, owner, ownerWindow, filePath, options, (terminated) => {
      if (currentSession === terminated) currentSession = null;
    });
    currentSession = session;
    return { ok: true, sessionId: session.id, surface: 'composited-window' };
  } catch (error) {
    invalidateLibVlcRuntimeCache();
    return { ok: false, surface: 'unavailable', error: error instanceof Error ? error.message : 'LibVLC could not start local playback.' };
  }
}

export function commandLibVlcPlayback(sessionId: string, command: LibVlcCommand): boolean {
  return currentSession?.id === sessionId ? currentSession.command(command) : false;
}

export function syncLibVlcPlaybackSurface(owner: WebContents): boolean {
  return currentSession?.syncSurface(owner) ?? false;
}

export function setLibVlcPlaybackViewport(owner: WebContents, viewport: PlaybackViewport): boolean {
  return currentSession?.setViewport(owner, viewport) ?? false;
}

export function setLibVlcPlaybackFullscreenTransition(
  owner: WebContents,
  transitioning: boolean,
  waitForFinalViewport = true,
): boolean {
  return currentSession?.setFullscreenTransition(owner, transitioning, waitForFinalViewport) ?? false;
}

export function stopLibVlcPlayback(sessionId?: string): boolean {
  if (!currentSession || (sessionId && currentSession.id !== sessionId)) return false;
  const stopped = currentSession.stop();
  currentSession = null;
  return stopped;
}

export function stopAllLibVlcPlayback(): void {
  stopLibVlcPlayback();
  invalidateLibVlcRuntimeCache();
}
