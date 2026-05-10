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

const config: ForgeConfig = {
  hooks: {
    postPackage: async (_config, packageResult) => {
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
      identity: '-',
    },
    icon: 'resources/icon',
    executableName: 'LoomTV',
    extraResource: [
      'resources/ffmpeg',
      'resources/mpv',
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
