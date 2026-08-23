import { app } from 'electron';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Keep one idle LibVLC instance alive for the lifetime of the desktop process.
 *
 * LibVLC discovers and loads its plugin bank inside libvlc_new(). Doing that
 * after the user clicks Play puts module discovery directly on the
 * click-to-first-frame path. The real playback session still owns its media,
 * player, audio tracks and subtitles. This idle instance only pays the runtime
 * and plugin startup cost during LoomTV startup, before playback is requested.
 */

type NativeValue = string | number | bigint | boolean | null | undefined | Record<string, unknown>;
type DynamicFunction = (...args: NativeValue[]) => NativeValue;
type KoffiLibrary = {
  func: (name: string, returnType: string, argumentTypes: readonly string[]) => DynamicFunction;
};
type KoffiRuntime = {
  load: (libraryPath: string) => KoffiLibrary;
};
type NativeHandle = bigint | number | null;

type WarmRuntime = {
  instance: Exclude<NativeHandle, null>;
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

function enabled(): boolean {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return false;
  if (truthy(process.env.LOOMTV_DISABLE_EXPERIMENTAL_LIBVLC)) return false;
  if (truthy(process.env.LOOMTV_DISABLE_LIBVLC)) return false;
  return true;
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
    path.join(root, 'MacOS', 'lib', fileName),
    path.join(root, 'Contents', 'Frameworks', fileName),
    path.join(root, 'Contents', 'MacOS', 'lib', fileName),
    path.join(root, 'VLC.app', 'Contents', 'Frameworks', fileName),
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
    const create = library.func('libvlc_new', 'void *', ['int', 'void *']);
    const release = library.func('libvlc_release', 'void', ['void *']);
    const previousPluginPath = process.env.VLC_PLUGIN_PATH;
    const pluginPath = pluginPathForLibrary(libraryPath);
    if (pluginPath) process.env.VLC_PLUGIN_PATH = pluginPath;
    try {
      const instance = nativeHandle(create(0, null));
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
  try {
    const koffi = require('koffi') as KoffiRuntime;
    for (const candidate of existingLibraryCandidates()) {
      const loaded = loadCandidate(koffi, candidate);
      if (!loaded) continue;
      warmRuntime = loaded;
      console.info(`[playback] LibVLC runtime warmed before playback (${candidate})`);
      return true;
    }
  } catch {
    // The normal availability path reports a useful failure if playback is requested.
  }
  return false;
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
