import { useEffect, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ToastProvider';
import { SettingsDisclosure, SettingsGroup, SettingsList, SettingsPageHeader, SettingsRow, SettingsStatus } from '@/components/settings/SettingsLayout';
import { APP_VERSION, desktopApi } from '@/lib/desktopApi';
import { APP_LICENSE, METADATA_ATTRIBUTIONS, THIRD_PARTY_DEPENDENCIES, isBundledFFmpegPath } from './Settings.helpers';
import type { SettingsController } from './useSettingsController';

export type AboutController = Pick<SettingsController,
  'updateState' | 'updateDownloadPercent' | 'isUpdateBusy' | 'updateButtonLabel' |
  'handleUpdateAction' | 'ffmpegStatus' | 'libvlcAvailability' | 'mpvAvailability' |
  'refreshLibvlcAvailability' | 'refreshMpvAvailability' | 'isRemoteLibraryMode'
>;

function runtimeSourceLabel(source: string | undefined): string {
  return source === 'bundled' ? `Bundled with ${APP_LICENSE.name}` : 'Installed on this computer';
}

export default function AboutSettingsSection({ controller }: { controller: AboutController }) {
  const { showToast } = useToast();
  const update = controller.updateState;
  const status = update?.status;
  const version = update?.currentVersion ?? APP_VERSION;
  const wasChecking = useRef(false);
  const { ffmpegStatus: ffmpeg, libvlcAvailability, mpvAvailability, refreshLibvlcAvailability, refreshMpvAvailability, isRemoteLibraryMode } = controller;

  // About can open before Playback has checked the native engines.
  useEffect(() => {
    if (libvlcAvailability === null && !isRemoteLibraryMode) void refreshLibvlcAvailability();
  }, [isRemoteLibraryMode, libvlcAvailability, refreshLibvlcAvailability]);
  useEffect(() => {
    if (mpvAvailability === null && !isRemoteLibraryMode) void refreshMpvAvailability();
  }, [isRemoteLibraryMode, mpvAvailability, refreshMpvAvailability]);

  // A check that finds nothing new ends with a short confirmation.
  useEffect(() => {
    if (status === 'checking') wasChecking.current = true;
    else if (wasChecking.current) {
      wasChecking.current = false;
      if (status === 'not-available' || status === 'idle') showToast({ title: `${APP_LICENSE.name} is up to date`, tone: 'success' });
    }
  }, [showToast, status]);

  const updateText = status === 'available'
    ? `Version ${update?.latestVersion ?? 'new'} is ready to download.`
    : status === 'downloaded'
      ? 'Update downloaded. Restart to finish.'
      : status === 'downloading'
        ? `Downloading ${update?.latestVersion ?? 'the update'}…`
        : status === 'installing'
          ? 'Restarting to install…'
          : status === 'checking'
            ? 'Checking for updates…'
            : status === 'error'
              ? update?.message || 'The last update check failed.'
              : 'You have the latest version.';
  const updateButtonLabel = status === 'downloading'
    ? controller.updateDownloadPercent > 0 ? `Downloading ${controller.updateDownloadPercent}%` : 'Downloading...'
    : controller.updateButtonLabel;

  const engine = (name: string, availability: { available: boolean; runtimeSource?: string; reason?: string } | null) => (
    <SettingsRow
      title={name}
      description={isRemoteLibraryMode ? 'Used for local files on the desktop.' : availability?.available ? runtimeSourceLabel(availability.runtimeSource) : availability?.reason}
    >
      {isRemoteLibraryMode
        ? <SettingsStatus tone="muted">Local desktop only</SettingsStatus>
        : availability === null
          ? <SettingsStatus tone="muted">Checking…</SettingsStatus>
          : availability.available
            ? <SettingsStatus tone="ok">Installed</SettingsStatus>
            : <SettingsStatus tone="warning">Unavailable</SettingsStatus>}
    </SettingsRow>
  );

  return (
    <div>
      <SettingsPageHeader title="About" description="Version, updates, bundled media tools, and licenses." />

      <SettingsGroup title="Updates">
        <SettingsRow title={APP_LICENSE.name} description={status === 'downloading' ? undefined : <span role="status">{updateText}</span>}>
          <span className="text-sm tabular-nums text-[var(--loom-muted)]">{version}</span>
          <Button
            type="button"
            size="sm"
            variant={status === 'downloading' ? 'secondary' : 'default'}
            disabled={controller.isUpdateBusy && status !== 'downloading'}
            onClick={() => void controller.handleUpdateAction()}
            aria-busy={status === 'downloading'}
            aria-label={status === 'downloading' ? `Downloading update, ${controller.updateDownloadPercent}% complete` : undefined}
            className={status === 'downloading' ? 'relative isolate h-9 min-w-40 overflow-hidden rounded-full bg-[var(--loom-surface-3)] px-4 text-[var(--loom-text)] hover:bg-[var(--loom-surface-3)]' : undefined}
          >
            {status === 'downloading' ? (
              <>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-[var(--loom-accent)] transition-[width] duration-300"
                  style={{ width: `${controller.updateDownloadPercent}%` }}
                />
                <span className="relative z-10" aria-live="polite">{updateButtonLabel}</span>
              </>
            ) : updateButtonLabel}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Bundled media tools">
        <SettingsRow title="FFmpeg" description={ffmpeg?.available ? (isBundledFFmpegPath(ffmpeg.path) ? `Bundled with ${APP_LICENSE.name}` : 'Installed on this computer') : 'Needed for thumbnails, probing, and transcoding.'}>
          {ffmpeg === null ? <SettingsStatus tone="muted">Checking…</SettingsStatus> : ffmpeg.available ? <SettingsStatus tone="ok">Installed</SettingsStatus> : <SettingsStatus tone="warning">Not found</SettingsStatus>}
        </SettingsRow>
        {engine('LibVLC', libvlcAvailability)}
        {engine('libmpv', mpvAvailability)}
      </SettingsGroup>

      <SettingsGroup title="Legal">
        <SettingsRow title="The Movie Database (TMDB)" description="This product uses the TMDB API but is not endorsed or certified by TMDB.">
          <Button type="button" size="sm" variant="outline" onClick={() => void desktopApi.openExternal('https://www.themoviedb.org/')}>
            TMDB <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </SettingsRow>
        <SettingsDisclosure title="License" description={`${APP_LICENSE.name}-authored source code uses the ${APP_LICENSE.license} license.`}>
          <div className="space-y-2 py-1 text-xs leading-5 text-[var(--loom-muted)]">
            <p>{APP_LICENSE.copyright}</p>
            <p>Bundled media tools keep their own licenses. LibVLC uses LGPL terms; its plugins and dependencies may use other licenses. libmpv and FFmpeg builds can carry GPL terms. The packaged media notices document the bundled versions and dependencies.</p>
          </div>
        </SettingsDisclosure>
        <SettingsDisclosure title="Third-party libraries" summary={THIRD_PARTY_DEPENDENCIES.length}>
          <SettingsList label="Third-party libraries">
            {THIRD_PARTY_DEPENDENCIES.map((dependency) => (
              <li key={dependency.name}>
                <button type="button" onClick={() => void desktopApi.openExternal(dependency.url)} className="group flex w-full items-center justify-between gap-3 py-2.5 text-left text-sm text-[var(--loom-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]">
                  <span className="min-w-0 truncate group-hover:underline">{dependency.name}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--loom-muted)]">
                    {dependency.license}
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                </button>
              </li>
            ))}
          </SettingsList>
        </SettingsDisclosure>
        <SettingsDisclosure title="Metadata, ratings and online services" summary={METADATA_ATTRIBUTIONS.length}>
          <p className="py-2 text-xs text-[var(--loom-muted)]">LoomTV is not affiliated with these services. Their data, artwork and brands remain subject to their respective terms.</p>
          <SettingsList label="Metadata, ratings and online services">
            {METADATA_ATTRIBUTIONS.map((source) => (
              <li key={source.name}>
                <button type="button" onClick={() => void desktopApi.openExternal(source.url)} className="group flex w-full items-start justify-between gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]">
                  <span className="min-w-0">
                    <span className="block text-sm text-[var(--loom-text)] group-hover:underline">{source.name}</span>
                    <span className="mt-0.5 block text-xs text-[var(--loom-muted)]">{source.details}</span>
                  </span>
                  <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--loom-muted)]" aria-hidden="true" />
                </button>
              </li>
            ))}
          </SettingsList>
        </SettingsDisclosure>
      </SettingsGroup>
    </div>
  );
}
