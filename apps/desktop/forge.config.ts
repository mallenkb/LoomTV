import type { ForgeConfig, IForgeMaker } from '@electron-forge/shared-types';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as asar from '@electron/asar';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import type { MakerSquirrelConfig } from '@electron-forge/maker-squirrel';
import { z } from 'zod';

const runtimeManifestSchema = z.object({
  manifestVersion: z.number().optional(),
  application: z.object({ license: z.string().optional() }).optional(),
  pathsAreRelativeTo: z.string().optional(),
  distributionPolicy: z.object({
    mpvBundled: z.boolean().optional(),
    mpvDownloadedByLoomTV: z.boolean().optional(),
    mpvLinkedByLoomTV: z.boolean().optional(),
  }).optional(),
  components: z.array(z.unknown()).optional(),
});
const runtimePackageSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
});

function hasBinary(binary: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [binary], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function quoteSignToolValue(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function squirrelSigningConfig(): Pick<MakerSquirrelConfig, 'certificateFile' | 'certificatePassword' | 'signWithParams'> {
  const certificateFile = process.env.WINDOWS_CERTIFICATE_FILE || undefined;
  const certificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD || undefined;
  const subjectName = process.env.WINDOWS_CERTIFICATE_SUBJECT || undefined;
  const sha1 = process.env.WINDOWS_CERTIFICATE_SHA1 || undefined;
  const signParams = [
    subjectName ? `/n ${quoteSignToolValue(subjectName)}` : '',
    sha1 ? `/sha1 ${quoteSignToolValue(sha1)}` : '',
  ].filter(Boolean).join(' ');

  return {
    certificateFile,
    certificatePassword,
    signWithParams: !certificateFile && signParams ? signParams : undefined,
  };
}

function makeTargets(): IForgeMaker[] {
  const makers: IForgeMaker[] = [
    new MakerZIP({}, ['darwin', 'win32', 'linux']),
    new MakerDMG({
      icon: 'resources/icon.icns',
    }, ['darwin']),
  ];

  if (process.platform === 'win32' || (hasBinary('wine') && hasBinary('mono'))) {
    makers.push(new MakerSquirrel({
      setupIcon: 'resources/icon.ico',
      ...squirrelSigningConfig(),
    }));
  }

  if (process.platform === 'linux' || hasBinary('rpmbuild')) {
    makers.push(new MakerRpm({
      options: {
        bin: 'loomtv',
      },
    }));
  }

  if (process.platform === 'linux' || (hasBinary('dpkg') && hasBinary('fakeroot'))) {
    makers.push(new MakerDeb({
      options: {
        bin: 'loomtv',
      },
    }));
  }

  return makers;
}

function platformFolder(platform: string): 'win' | 'mac' | 'linux' {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  return 'linux';
}

function resourcesPath(outputPath: string, platform: string): string {
  if (platform === 'darwin') {
    const appBundleName = fs.existsSync(path.join(outputPath, 'LoomTV.app'))
      ? 'LoomTV.app'
      : 'Loom Media Server.app';
    return path.join(outputPath, appBundleName, 'Contents', 'Resources');
  }
  return path.join(outputPath, 'resources');
}

function prunePackagedFfmpegResources(outputPath: string, platform: string): void {
  const keepFolder = platformFolder(platform);
  const ffmpegPath = path.join(resourcesPath(outputPath, platform), 'ffmpeg');
  for (const folder of ['win', 'mac', 'linux']) {
    if (folder !== keepFolder) {
      fs.rmSync(path.join(ffmpegPath, folder), { recursive: true, force: true });
    }
  }
}

function nativeRuntimeFileName(engine: 'libvlc' | 'mpv', platform: string): string {
  if (engine === 'mpv') return platform === 'win32' ? 'mpv.exe' : 'mpv';
  if (platform === 'win32') return 'libvlc.dll';
  if (platform === 'darwin') return 'libvlc.dylib';
  return 'libvlc.so';
}

function nativeEnginesForPlatform(platform: string): Array<'libvlc' | 'mpv'> {
  // The LibVLC surface is currently wired only for macOS. MPV remains the
  // cross-platform native fallback wherever its payload is supplied.
  return platform === 'darwin' ? ['libvlc', 'mpv'] : ['mpv'];
}

function containsFile(root: string, expectedName: string): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isFile() && entry.name === expectedName) return true;
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(candidate);
    }
  }
  return false;
}

function assertNativeRuntimesOutsideAsar(outputPath: string, platform: string): void {
  const resources = resourcesPath(outputPath, platform);
  const appAsar = path.join(resources, 'app.asar');
  if (!fs.existsSync(appAsar)) return;

  try {
    const embedded = asar.listPackage(appAsar, { isPack: false }).filter((entry) => (
      /(?:^|[\\/])(?:libvlc|mpv)(?:[\\/]|$)/i.test(entry)
    ));
    if (embedded.length > 0) {
      throw new Error(`Native LibVLC/MPV payloads must remain outside app.asar:\n${embedded.join('\n')}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Native LibVLC/MPV payloads')) throw error;
    throw new Error(`Could not inspect packaged app.asar for native runtime files: ${String(error)}`, { cause: error });
  }
}

function prunePackagedNativeResources(outputPath: string, platform: string, arch: string): void {
  const resources = resourcesPath(outputPath, platform);
  for (const engine of ['libvlc', 'mpv']) {
    const engineRoot = path.join(resources, engine);
    if (!fs.existsSync(engineRoot)) continue;
    for (const entry of fs.readdirSync(engineRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const platformRoot = path.join(engineRoot, entry.name);
      if (entry.name !== platform) {
        fs.rmSync(platformRoot, { recursive: true, force: true });
        continue;
      }
      for (const architecture of fs.readdirSync(platformRoot, { withFileTypes: true })) {
        if (architecture.isDirectory() && !architecture.isSymbolicLink() && architecture.name !== arch) {
          fs.rmSync(path.join(platformRoot, architecture.name), { recursive: true, force: true });
        }
      }
    }
  }
}

function syncFileTimestamps(sourceRoot: string, targetRoot: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      if (fs.existsSync(targetPath)) syncFileTimestamps(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || !fs.existsSync(targetPath)) continue;

    const sourceStats = fs.statSync(sourcePath);
    fs.utimesSync(targetPath, sourceStats.atime, sourceStats.mtime);
  }
}

function findFilesNamed(root: string, name: string): string[] {
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === name) matches.push(candidate);
    }
  }
  return matches;
}

function preservePackagedLibVlcPluginTimestamps(outputPath: string, platform: string, arch: string): void {
  if (platform !== 'darwin') return;

  const sourceRoot = path.join(__dirname, 'resources', 'libvlc', platform, arch);
  const targetRoot = path.join(resourcesPath(outputPath, platform), 'libvlc', platform, arch);
  for (const sourceCache of findFilesNamed(sourceRoot, 'plugins.dat')) {
    const sourcePluginDirectory = path.dirname(sourceCache);
    const relativePluginDirectory = path.relative(sourceRoot, sourcePluginDirectory);
    const targetPluginDirectory = path.join(targetRoot, relativePluginDirectory);
    if (fs.existsSync(targetPluginDirectory)) {
      // VLC's generated cache embeds each plugin's source mtime. Forge's
      // extraResource copy gives those files a new mtime, causing noisy stale
      // cache warnings on every packaged startup. Restore the staged mtimes
      // before the final macOS signing pass.
      syncFileTimestamps(sourcePluginDirectory, targetPluginDirectory);
    }
  }
}

function resignPackagedMacApp(outputPath: string): void {
  const appBundleName = fs.existsSync(path.join(outputPath, 'LoomTV.app'))
    ? 'LoomTV.app'
    : 'Loom Media Server.app';
  const appBundle = path.join(outputPath, appBundleName);
  const identity = process.env.MACOS_SIGNING_IDENTITY || '-';

  try {
    // Forge signs before postPackage. The architecture-specific pruning above
    // changes the signed bundle, so seal it again after all resource changes.
    execFileSync('/usr/bin/codesign', [
      '--force',
      '--deep',
      '--sign',
      identity,
      appBundle,
    ], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Could not re-sign packaged macOS app ${appBundle}: ${String(error)}`, { cause: error });
  }
}

function assertPackagedNativeRuntimes(outputPath: string, platform: string, arch: string): void {
  const target = `${platform}/${arch}`;
  const missing: string[] = [];
  for (const engine of nativeEnginesForPlatform(platform)) {
    const runtimeRoot = path.join(resourcesPath(outputPath, platform), engine, platform, arch);
    const expectedName = nativeRuntimeFileName(engine, platform);
    if (!fs.existsSync(runtimeRoot) || !containsFile(runtimeRoot, expectedName)) {
      missing.push(`${engine}/${platform}/${arch}/${expectedName}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Packaged native runtime staging is incomplete for ${target}. Missing:\n${missing.join('\n')}`);
  }
  assertNativeRuntimesOutsideAsar(outputPath, platform);
}

function requireRuntimeManifest(outputPath: string, platform: string): void {
  const manifestPath = path.join(resourcesPath(outputPath, platform), 'ffmpeg', 'runtime-provenance.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing FFmpeg runtime provenance manifest: ${manifestPath}`);
  }

  let manifest: z.output<typeof runtimeManifestSchema>;
  try {
    const payload: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest = runtimeManifestSchema.parse(payload);
  } catch (error) {
    throw new Error(`Invalid FFmpeg runtime provenance manifest ${manifestPath}: ${String(error)}`, { cause: error });
  }
  if (
    manifest.manifestVersion !== 1
    || manifest.application?.license !== 'MIT'
    || manifest.pathsAreRelativeTo !== 'resources'
    || manifest.distributionPolicy?.mpvBundled !== true
    || manifest.distributionPolicy?.mpvDownloadedByLoomTV !== false
    || manifest.distributionPolicy?.mpvLinkedByLoomTV !== false
    || !Array.isArray(manifest.components)
    || manifest.components.length === 0
  ) {
    throw new Error(`FFmpeg runtime provenance manifest is missing required fields: ${manifestPath}`);
  }
}

function copyRuntimeModule(moduleName: string, targetNodeModules: string, copied = new Set<string>()): void {
  if (copied.has(moduleName)) return;
  copied.add(moduleName);

  const sourcePath = runtimeModuleSourcePath(moduleName);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing runtime module ${moduleName} at ${sourcePath}`);
  }

  const packageJsonPath = path.join(sourcePath, 'package.json');
  const packagePayload: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const packageJson = runtimePackageSchema.parse(packagePayload);

  const targetPath = path.join(targetNodeModules, moduleName);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });

  for (const dependencyName of Object.keys(packageJson.dependencies || {})) {
    copyRuntimeModule(dependencyName, targetNodeModules, copied);
  }
}

function runtimeModuleSourcePath(moduleName: string): string {
  const candidates = [
    path.join(process.cwd(), 'node_modules', moduleName),
    path.resolve(process.cwd(), '..', 'node_modules', moduleName),
    path.resolve(process.cwd(), '..', '..', 'node_modules', moduleName),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function copyDirectRuntimeModule(moduleName: string, targetNodeModules: string): void {
  const sourcePath = runtimeModuleSourcePath(moduleName);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing runtime module ${moduleName} at ${sourcePath}`);
  }

  const targetPath = path.join(targetNodeModules, moduleName);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
}

const config: ForgeConfig = {
  hooks: {
    postPackage: async (_config, packageResult) => {
      for (const outputPath of packageResult.outputPaths) {
        prunePackagedFfmpegResources(outputPath, packageResult.platform);
        prunePackagedNativeResources(outputPath, packageResult.platform, packageResult.arch);
        preservePackagedLibVlcPluginTimestamps(outputPath, packageResult.platform, packageResult.arch);
        if (packageResult.platform === 'darwin') {
          resignPackagedMacApp(outputPath);
        }
        requireRuntimeManifest(outputPath, packageResult.platform);
        assertPackagedNativeRuntimes(outputPath, packageResult.platform, packageResult.arch);
      }
    },
  },
  packagerConfig: {
    asar: {
      // FFmpeg, LibVLC, and MPV are copied through extraResource below and
      // therefore already live outside app.asar. Keep the native Node module
      // unpack rule here without the brace glob, which is incompatible with
      // the minimatch/brace-expansion versions resolved by this workspace.
      unpack: '**/*.node',
    },
    osxSign: {
      identity: process.env.MACOS_SIGNING_IDENTITY || '-',
    },
    icon: 'resources/icon',
    executableName: 'LoomTV',
    extraResource: [
      'resources/ffmpeg',
      'resources/fpcalc',
      'resources/icon.png',
      'resources/icon.ico',
      'resources/icon.icns',
      'resources/lmtv-icon-nobg.svg.png',
      'resources/trayIcon.png',
      'resources/trayIcon@2x.png',
      'resources/libvlc',
      'resources/mpv',
      'resources/DICEBEAR_GLYPHS_LICENSE.md',
      '../server/src/web-app.html',
      'src/headless/admin.html',
      'src/headless/lucide-icons.svg',
    ],
    afterPrune: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        try {
          const directRuntimeModules = ['better-sqlite3', 'bindings', 'file-uri-to-path', 'koffi'];
          const targetNodeModules = path.join(buildPath, 'node_modules');
          fs.mkdirSync(targetNodeModules, { recursive: true });

          for (const moduleName of directRuntimeModules) {
            copyDirectRuntimeModule(moduleName, targetNodeModules);
          }
          copyRuntimeModule('electron-updater', targetNodeModules);
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    ],
  },
  rebuildConfig: {},
  makers: makeTargets(),
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
