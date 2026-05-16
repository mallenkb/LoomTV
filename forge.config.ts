import type { ForgeConfig } from '@electron-forge/shared-types';
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

function hasBinary(binary: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [binary], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeTargets() {
  const makers = [
    new MakerZIP({}, ['darwin', 'win32', 'linux']),
    new MakerDMG({
      icon: 'resources/icon.icns',
    }, ['darwin']),
  ];

  if (process.platform === 'win32' || (hasBinary('wine') && hasBinary('mono'))) {
    makers.push(new MakerSquirrel({
      setupIcon: 'resources/icon.ico',
      certificateFile: process.env.WINDOWS_CERTIFICATE_FILE || undefined,
      certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD || undefined,
      certificateSubjectName: process.env.WINDOWS_CERTIFICATE_SUBJECT || undefined,
      certificateSha1: process.env.WINDOWS_CERTIFICATE_SHA1 || undefined,
    }));
  }

  if (process.platform === 'linux' || hasBinary('rpmbuild')) {
    makers.push(new MakerRpm({
      options: {
        bin: 'LoomTV',
      },
    }));
  }

  if (process.platform === 'linux' || (hasBinary('dpkg') && hasBinary('fakeroot'))) {
    makers.push(new MakerDeb({
      options: {
        bin: 'LoomTV',
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
    return path.join(outputPath, 'LoomTV.app', 'Contents', 'Resources');
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

const config: ForgeConfig = {
  hooks: {
    postPackage: async (_config, packageResult) => {
      for (const outputPath of packageResult.outputPaths) {
        prunePackagedFfmpegResources(outputPath, packageResult.platform);
      }

      if (packageResult.platform !== 'darwin') {
        return;
      }

      for (const outputPath of packageResult.outputPaths) {
        const appPath = path.join(outputPath, 'LoomTV.app');
        if (fs.existsSync(appPath)) {
          execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
            stdio: 'inherit',
          });
        }
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
    ],
    afterPrune: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        try {
          const runtimeModules = ['better-sqlite3', 'bindings', 'file-uri-to-path', 'ffmpeg-static', 'ffprobe-static'];
          const targetNodeModules = path.join(buildPath, 'node_modules');
          fs.mkdirSync(targetNodeModules, { recursive: true });

          for (const moduleName of runtimeModules) {
            fs.cpSync(
              path.join(process.cwd(), 'node_modules', moduleName),
              path.join(targetNodeModules, moduleName),
              { recursive: true, force: true },
            );
          }
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
