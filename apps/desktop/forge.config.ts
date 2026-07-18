import type { ForgeConfig, IForgeMaker } from '@electron-forge/shared-types';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import type { MakerSquirrelConfig } from '@electron-forge/maker-squirrel';

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

function copyRuntimeModule(moduleName: string, targetNodeModules: string, copied = new Set<string>()): void {
  if (copied.has(moduleName)) return;
  copied.add(moduleName);

  const sourcePath = path.join(process.cwd(), 'node_modules', moduleName);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing runtime module ${moduleName} at ${sourcePath}`);
  }

  const packageJsonPath = path.join(sourcePath, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
    dependencies?: Record<string, string>;
  };

  const targetPath = path.join(targetNodeModules, moduleName);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });

  for (const dependencyName of Object.keys(packageJson.dependencies || {})) {
    copyRuntimeModule(dependencyName, targetNodeModules, copied);
  }
}

function copyDirectRuntimeModule(moduleName: string, targetNodeModules: string): void {
  const sourcePath = path.join(process.cwd(), 'node_modules', moduleName);
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
      }
    },
  },
  packagerConfig: {
    asar: {
      unpack: '**/{*.node,ffmpeg,ffmpeg.exe,ffprobe,ffprobe.exe}',
    },
    osxSign: {
      identity: process.env.MACOS_SIGNING_IDENTITY || '-',
    },
    icon: 'resources/icon',
    executableName: 'LoomTV',
    extraResource: [
      'resources/ffmpeg',
      'resources/icon.png',
      'resources/icon.ico',
      'resources/icon.icns',
      'resources/lmtv-icon-nobg.svg.png',
      'resources/DICEBEAR_GLYPHS_LICENSE.md',
    ],
    afterPrune: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        try {
          const directRuntimeModules = ['better-sqlite3', 'bindings', 'file-uri-to-path', 'ffmpeg-static', 'ffprobe-static'];
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
    new AutoUnpackNativesPlugin({}),
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
