import { CheckCircle, Download, ExternalLink, RefreshCw } from 'lucide-react';
import LoomLoader from '@/components/LoomLoader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { APP_VERSION, desktopApi, type UpdateState } from '@/lib/desktopApi';
import type { AppThemeSettings } from '@/lib/theme';
import type { TranscodeCapabilities } from '@loom-media-server/transcode-capabilities';
import { cn } from '@/lib/utils';
import {
  APP_LICENSE,
  METADATA_ATTRIBUTIONS,
  THIRD_PARTY_DEPENDENCIES,
  isBundledFFmpegPath,
} from './Settings.helpers';

type FFmpegStatus = {
  available: boolean;
  path: string | null;
  capabilities?: TranscodeCapabilities;
};

type AboutSettingsSectionProps = {
  ffmpegStatus: FFmpegStatus | null;
  updateState: UpdateState | null;
  theme: AppThemeSettings;
  isUpdateBusy: boolean;
  isUpdateChecking: boolean;
  isUpdateDownloading: boolean;
  updateDownloadPercent: number;
  updateButtonLabel: string;
  updateStatusCopy: string;
  onUpdateAction: () => void;
};

export default function AboutSettingsSection({
  ffmpegStatus,
  updateState,
  theme,
  isUpdateBusy,
  isUpdateChecking,
  isUpdateDownloading,
  updateDownloadPercent,
  updateButtonLabel,
  updateStatusCopy,
  onUpdateAction,
}: AboutSettingsSectionProps) {
  return (
    <div className="space-y-4">
      <div className="settings-panel relative overflow-hidden rounded-2xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-2xl font-bold tracking-tight text-white">{APP_LICENSE.name}</h2>
              <span className="rounded-full bg-[var(--loom-accent)]/15 px-2.5 py-0.5 text-xs font-semibold text-[var(--loom-accent)] ring-1 ring-[var(--loom-accent)]/25">
                v{updateState?.currentVersion ?? APP_VERSION}
              </span>
              <span className="rounded-full bg-[var(--loom-surface-3)] px-2.5 py-0.5 text-xs font-medium text-[var(--loom-faint)] ring-1 ring-[var(--loom-border)]">
                {APP_LICENSE.license}
              </span>
            </div>
            <p className="text-sm text-[var(--loom-muted)] max-w-md leading-relaxed">
              Local media library and playback app powered by Electron, React, and FFmpeg.
            </p>
            <div className={cn(
              'mt-3 inline-flex h-8 items-center gap-2 rounded-lg border px-3 text-xs font-medium',
              ffmpegStatus === null
                ? 'border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] text-[var(--loom-faint)]'
                : ffmpegStatus.available
                  ? 'settings-status-available border-green-400/35 bg-green-400/10'
                  : 'settings-status-unavailable border-yellow-500/30 bg-yellow-500/10',
            )}>
              {ffmpegStatus === null ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-[var(--loom-faint)]" />
                  Checking FFmpeg...
                </>
              ) : ffmpegStatus.available ? (
                <>
                  <CheckCircle className="h-3.5 w-3.5" />
                  {isBundledFFmpegPath(ffmpegStatus.path) ? 'Bundled FFmpeg' : 'System FFmpeg'}
                </>
              ) : (
                <>
                  <span className="h-2 w-2 rounded-full bg-yellow-400" />
                  FFmpeg not found
                </>
              )}
            </div>
            <p className="mt-3 text-xs text-[var(--loom-faint)]">{APP_LICENSE.copyright}</p>
            {ffmpegStatus?.capabilities && (
              <div className="mt-3 text-xs text-[var(--loom-faint)]">
                <span className="font-medium text-[var(--loom-muted)]">Transcoding:</span>{' '}
                {ffmpegStatus.capabilities.hardwareAcceleration
                  ? `${ffmpegStatus.capabilities.recommendedBackend} hardware encode`
                  : 'software fallback'}
                {' · '}
                H.264 {ffmpegStatus.capabilities.codecs.h264 ? 'hardware' : ffmpegStatus.capabilities.softwareCodecs.h264 ? 'software' : '—'}
                {' · '}HEVC {ffmpegStatus.capabilities.codecs.hevc ? 'hardware' : ffmpegStatus.capabilities.softwareCodecs.hevc ? 'software' : '—'}
                {' · '}AV1 {ffmpegStatus.capabilities.codecs.av1 ? 'hardware' : ffmpegStatus.capabilities.softwareCodecs.av1 ? 'software' : '—'}
                {ffmpegStatus.capabilities.toneMapping ? ' · HDR tone-map ready' : ''}
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col items-end gap-3">
            <div className="inline-flex rounded-lg bg-[var(--loom-surface-2)] p-1">
              <button
                type="button"
                onClick={onUpdateAction}
                disabled={isUpdateBusy}
                className={cn(
                  'relative inline-flex h-9 min-w-36 items-center justify-center gap-2 overflow-hidden whitespace-nowrap rounded-md bg-[var(--loom-accent)] px-3 text-xs font-semibold text-[var(--loom-accent-foreground)] transition-colors',
                  isUpdateBusy
                    ? 'cursor-wait shadow-inner shadow-black/20'
                    : 'hover:bg-[var(--loom-accent-hover)]',
                )}
                aria-busy={isUpdateBusy}
              >
                {isUpdateDownloading && (
                  <span
                    className="pointer-events-none absolute inset-y-0 left-0 bg-black/20 transition-[width] duration-300"
                    style={{ width: `${updateDownloadPercent}%` }}
                    aria-hidden="true"
                  />
                )}
                <span className="relative z-10 inline-flex items-center gap-2">
                  {isUpdateChecking ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : isUpdateDownloading ? (
                    <Download className="h-4 w-4 animate-pulse" />
                  ) : updateState?.status === 'installing' ? (
                    <LoomLoader
                      style={theme.loaderStyle}
                      className="grid h-4 w-4 place-items-center text-current"
                      markClassName={theme.loaderStyle === 'horizontal-logo' ? 'h-2.5 w-auto' : 'h-3.5 w-3.5'}
                      color="currentColor"
                    />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {isUpdateDownloading ? (
                    <>
                      <span>Downloading</span>
                      <span className="tabular-nums">{updateDownloadPercent}%</span>
                    </>
                  ) : updateButtonLabel}
                </span>
              </button>
            </div>
            {updateStatusCopy && (
              <p className="max-w-52 px-1 text-right text-[11px] leading-4 text-[var(--loom-faint)]" aria-live="polite">
                {updateStatusCopy}
              </p>
            )}
          </div>
        </div>
      </div>

      <Card className="settings-panel">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-white">Metadata &amp; Artwork Sources</CardTitle>
          <CardDescription className="text-[var(--loom-faint)] text-xs">
            Content data is fetched from these services at scan time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {METADATA_ATTRIBUTIONS.map((source) => (
              <button
                key={source.name}
                type="button"
                onClick={() => desktopApi.openExternal(source.url)}
                className="settings-action-tile group flex items-start gap-3 rounded-xl p-3 text-left transition-all"
              >
                <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--loom-accent)]/10 transition-colors group-hover:bg-[var(--loom-accent)]/18">
                  <ExternalLink className="h-3.5 w-3.5 text-[var(--loom-accent)]" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white leading-tight">{source.name}</p>
                  <p className="mt-0.5 text-xs leading-4 text-[var(--loom-faint)]">{source.details}</p>
                </div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-white">Bundled Media Tools</CardTitle>
          <CardDescription className="text-[var(--loom-faint)] text-xs leading-5">
            LoomTV bundles FFmpeg and FFprobe for macOS and Windows. These binaries include GPL
            components and are distributed under GNU GPL v3 or later. FFmpeg is a trademark of
            Fabrice Bellard; LoomTV is not affiliated with the FFmpeg project.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { label: 'macOS FFmpeg builds', sub: "Martin Riedl's FFmpeg Build Server", url: 'https://ffmpeg.martin-riedl.de/' },
              { label: 'Windows FFmpeg builds', sub: 'CODEX FFMPEG by Gyan Doshi', url: 'https://www.gyan.dev/ffmpeg/builds/' },
              { label: 'FFmpeg legal notes', sub: 'Licensing and compliance guidance', url: 'https://ffmpeg.org/legal.html' },
              { label: 'FFmpeg source code', sub: 'Official FFmpeg source repository', url: 'https://git.ffmpeg.org/ffmpeg.git' },
            ].map((link) => (
              <button
                key={link.label}
                type="button"
                onClick={() => desktopApi.openExternal(link.url)}
                className="settings-action-tile group flex items-center gap-3 rounded-xl px-3 py-3 text-left transition-all"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white leading-tight">{link.label}</p>
                  <p className="text-xs text-[var(--loom-faint)] mt-0.5">{link.sub}</p>
                </div>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[var(--loom-accent)] opacity-60 group-hover:opacity-100 transition-opacity" />
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-white">Third-Party Libraries</CardTitle>
          <CardDescription className="text-[var(--loom-faint)] text-xs">
            Direct dependencies and major development tools. Packaged builds also include Chromium/Electron notices.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="settings-panel-soft overflow-hidden rounded-xl">
            <div className="grid grid-cols-[minmax(0,1fr)_7rem_2.5rem] bg-[var(--loom-surface-3)] px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--loom-faint)]">
              <span>Project</span>
              <span>License</span>
              <span />
            </div>
            <div className="max-h-72 overflow-y-auto divide-y divide-[var(--loom-border)]">
              {THIRD_PARTY_DEPENDENCIES.map((dependency) => (
                <div
                  key={dependency.name}
                  className="grid grid-cols-[minmax(0,1fr)_7rem_2.5rem] items-center gap-2 px-3 py-2.5 transition-colors hover:bg-[var(--loom-surface-3)]/70"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">{dependency.name}</p>
                    <p className="truncate text-xs text-[var(--loom-faint)]">{dependency.owner}</p>
                  </div>
                  <span className="truncate text-xs text-[var(--loom-faint)]">{dependency.license}</span>
                  <button
                    type="button"
                    onClick={() => desktopApi.openExternal(dependency.url)}
                    aria-label={`Open ${dependency.name}`}
                    title={dependency.name}
                    className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-[var(--loom-accent)] opacity-50 transition-all hover:opacity-100 hover:bg-[var(--loom-surface-3)]"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
