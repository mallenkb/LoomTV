import { app } from 'electron';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { LIBVLC_INSTANCE_ARGUMENTS } from './libvlcRuntimeConfig.ts';
import { recordPlaybackDiagnostic } from './playbackDiagnostics.ts';

/**
 * Keep one LibVLC instance alive for the lifetime of the desktop process.
 *
 * LibVLC discovers and loads its plugin bank inside libvlc_new(). Doing that
 * after the user clicks Play puts module discovery directly on the
 * click-to-first-frame path. Playback sessions borrow this process-lifetime
 * instance, while media descriptors, media players, audio tracks and subtitle
 * state remain session-owned and are released normally between videos.
 */

type NativeValue = string | number | bigint | boolean | null | undefined
  | Record<string, unknown>
  | readonly (string | null)[];
type DynamicFunction = (...args: NativeValue[]) => NativeValue;
type KoffiLibrary = {
  func: (name: string, returnType: string, argumentTypes: readonly string[]) => DynamicFunction;
};
type KoffiRuntime = {
  load: (libraryPath: string) => KoffiLibrary;
};
export type SharedLibVlcInstance = bigint | number;
type NativeHandle = SharedLibVlcInstance | null;

type WarmRuntime = {
  instance: SharedLibVlcInstance;
  release: DynamicFunction;
  libraries: KoffiLibrary[];
  libraryPath: string;
};

const require = createRequire(__filename);
let warmRuntime: WarmRuntime | null = null;
let warmupStarted = false;

function truthy(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function explicitBoolean(value: unknown): boolean | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function enabled(): boolean {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return false;
  if (truthy(process.env.LOOMTV_DISABLE_EXPERIMENTAL_LIBVLC)) return false;
  if (truthy(process.env.LOOMTV_DISABLE_LIBVLC)) return false;
  const configured = explicitBoolean(process.env.LOOMTV_EXPERIMENTAL_LIBVLC);
  const legacyConfigured = explicitBoolean(process.env.LOOMTV_ENABLE_LIBVLC);
  return configured ?? legacyConfigured ?? true;
}

function nativeHandle(value: NativeValue): NativeHandle {
  return typeof value === 'bigint' || typeof value === 'number' ? value : null;
}

function libraryFileName(): string {
  return process.platform === 'win32' ? 'libvlc.dll' : 'libvlc.dylib';
}

function architectureVariants(): string[] {
  if (process.arch === 'arm64') return ['arm64', 'aarch64'];
  if (process.arch === 'x64') return ['x64', 'amd64'];
  if (process.arch === 'ia32') return ['ia32', 'x86'];
  if (process.arch === 'arm') return ['arm', 'armv7'];
  return [process.arch];
}

function platformVariants(): string[] {
  return process.platform === 'darwin'
    ? ['darwin', 'mac', 'macos']
    : ['win32', 'win', 'windows'];
}

function resourceRoots(): string[] {
  const roots: string[] = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.trim()) {
    roots.push(path.join(process.resourcesPath, 'libvlc'));
  }
  if ((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp) {
    roots.push(path.resolve(__dirname, '../../resources/libvlc'));
  }
  return [...new Set(roots)];
}

function bundledCandidates(): string[] {
  const fileName = libraryFileName();
  const layoutRoots: string[] = [];
  for (const root of resourceRoots()) {
    for (const platform of platformVariants()) {
      for (const architecture of architectureVariants()) {
        layoutRoots.push(path.join(root, platform, architecture));
      }
      layoutRoots.push(path.join(root, platform));
    }
    for (const architecture of architectureVariants()) layoutRoots.push(path.join(root, architecture));
    layoutRoots.push(root);
  }

  return layoutRoots.flatMap((root) => [
    path.join(root, fileName),
    path.join(root, 'lib', fileName),
    path.join(root, 'Frameworks', fileName),
    path.join(root, 'MacOS', fileName),
    path.join(root, 'MacOS', 'lib', fileName),
    path.join(root, 'Contents', 'Frameworks', fileName),
    path.join(root, 'Contents', 'MacOS', fileName),
    path.join(root, 'Contents', 'MacOS', 'lib', fileName),
    path.join(root, 'VLC.app', 'Contents', 'Frameworks', fileName),
    path.join(root, 'VLC.app', 'Contents', 'MacOS', fileName),
    path.join(root, 'VLC.app', 'Contents', 'MacOS', 'lib', fileName),
  ]);
}

function systemCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/VLC.app/Contents/MacOS/lib/libvlc.dylib',
      '/Applications/VLC.app/Contents/Frameworks/libvlc.dylib',
      '/opt/homebrew/lib/libvlc.dylib',
      '/usr/local/lib/libvlc.dylib',
    ];
  }
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  return [
    path.join(programFiles, 'VideoLAN', 'VLC', 'libvlc.dll'),
    path.join(programFilesX86, 'VideoLAN', 'VLC', 'libvlc.dll'),
    ...(localAppData ? [path.join(localAppData, 'Programs', 'VideoLAN', 'VLC', 'libvlc.dll')] : []),
  ];
}

function configuredCandidate(): string[] {
  const configured = process.env.LOOMTV_LIBVLC_PATH?.trim();
  if (!configured) return [];
  try {
    return fs.statSync(configured).isDirectory()
      ? [path.join(configured, libraryFileName())]
      : [configured];
  } catch {
    return [configured];
  }
}

function existingLibraryCandidates(): string[] {
  const candidates = [
    ...configuredCandidate(),
    ...bundledCandidates(),
    ...systemCandidates(),
  ];
  return [...new Set(candidates)].filter((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
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

function normalizedLibraryPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function sameLibraryPath(left: string, right: string): boolean {
  return normalizedLibraryPath(left) === normalizedLibraryPath(right);
}

function loadCandidate(koffi: KoffiRuntime, libraryPath: string): WarmRuntime | null {
  const libraries: KoffiLibrary[] = [];
  try {
    const corePath = path.join(
      path.dirname(libraryPath),
      process.platform === 'win32' ? 'libvlccore.dll' : 'libvlccore.dylib',
    );
    try {
      if (fs.statSync(corePath).isFile()) libraries.push(koffi.load(corePath));
    } catch {
      // System packages can provide their own loader path.
    }

    const library = koffi.load(libraryPath);
    libraries.push(library);
    const create = library.func('libvlc_new', 'void *', ['int', 'const char **']);
    const release = library.func('libvlc_release', 'void', ['void *']);
    const previousPluginPath = process.env.VLC_PLUGIN_PATH;
    const pluginPath = pluginPathForLibrary(libraryPath);
    if (pluginPath) process.env.VLC_PLUGIN_PATH = pluginPath;
    try {
      const instance = nativeHandle(create(LIBVLC_INSTANCE_ARGUMENTS.length, LIBVLC_INSTANCE_ARGUMENTS));
      if (!instance) return null;
      return { instance, release, libraries, libraryPath };
    } finally {
      if (previousPluginPath === undefined) delete process.env.VLC_PLUGIN_PATH;
      else process.env.VLC_PLUGIN_PATH = previousPluginPath;
    }
  } catch {
    return null;
  }
}

export function warmLibVlcRuntime(): boolean {
  if (warmRuntime) return true;
  if (warmupStarted || !enabled()) return false;
  warmupStarted = true;
  recordPlaybackDiagnostic('vlc.warmup.start');
  try {
    const koffi = require('koffi') as KoffiRuntime;
    for (const candidate of existingLibraryCandidates()) {
      const loaded = loadCandidate(koffi, candidate);
      if (!loaded) continue;
      warmRuntime = loaded;
      recordPlaybackDiagnostic('vlc.warmup.ready');
      console.info(`[playback] LibVLC process instance ready (${candidate})`);
      return true;
    }
  } catch {
    // The normal availability path reports a useful failure if playback is requested.
  }
  recordPlaybackDiagnostic('vlc.warmup.failed');
  return false;
}

/**
 * Return the process-lifetime LibVLC instance only when the playback runtime
 * resolved the same native library. A different configured runtime must never
 * receive a pointer created by another libvlc image.
 */
export function getWarmLibVlcInstance(libraryPath: string): SharedLibVlcInstance | null {
  if (!warmRuntime && !warmupStarted) warmLibVlcRuntime();
  if (!warmRuntime || !sameLibraryPath(warmRuntime.libraryPath, libraryPath)) return null;
  return warmRuntime.instance;
}

export function releaseWarmLibVlcRuntime(): void {
  const loaded = warmRuntime;
  warmRuntime = null;
  if (!loaded) return;
  try {
    loaded.release(loaded.instance);
  } catch {
    // Best-effort shutdown. Electron is already quitting.
  }
}

function registerWarmup(): void {
  const electronApp = app as (typeof app | undefined);
  if (!electronApp || typeof electronApp.once !== 'function' || typeof electronApp.isReady !== 'function') return;
  if (!enabled()) return;
  if (electronApp.isReady()) warmLibVlcRuntime();
  else electronApp.once('ready', () => { warmLibVlcRuntime(); });
  electronApp.once('will-quit', () => { releaseWarmLibVlcRuntime(); });
}

registerWarmup();
