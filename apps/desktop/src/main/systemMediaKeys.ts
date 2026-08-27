import { app, BrowserWindow, type WebContents } from 'electron';
import path from 'node:path';
import type { MediaSessionDiagnostics, MediaSessionSnapshot } from '../shared/mediaControlProtocol.ts';
import { commandLibVlcPlayback } from './libvlcPlayback.ts';
import { commandMpvPlayback } from './mpvPlayback.ts';
import { createArtworkStaging } from './mediaControl/artworkStaging.ts';
import { mediaSessionAdapterCandidates } from './mediaControl/adapters.ts';
import { createEngineDispatcher } from './mediaControl/engineDispatch.ts';
import { createMediaSessionController } from './mediaControl/service.ts';

/**
 * Electron glue for LoomTV's system media session.
 *
 * The main process owns the session. A VideoPlayer publishes snapshots while it
 * plays; commands come back through the controller, which runs LibVLC and mpv
 * transport here and forwards everything else to the owning renderer. Nothing
 * on this path reopens the media, switches engine, starts a transcode, or calls
 * a metadata provider.
 *
 * Session ownership is deliberately separate from the FFmpeg activity lease on
 * `playback:activity`: one governs transcoder scheduling, the other governs who
 * owns the operating system's media session.
 */

const logWarning = (message: string, error?: unknown) => {
  if (error === undefined) console.warn(message);
  else console.warn(message, error);
};

let artworkStaging: ReturnType<typeof createArtworkStaging> | null = null;

function artwork() {
  if (!artworkStaging) {
    artworkStaging = createArtworkStaging({
      cacheDirectory: path.join(app.getPath('temp'), 'loomtv-media-artwork'),
      logWarning,
    });
  }
  return artworkStaging;
}

const controller = createMediaSessionController({
  platform: process.platform,
  logWarning,
  candidates: () => mediaSessionAdapterCandidates({
    platform: process.platform,
    // Windows binds the session to LoomTV's own top-level window. The owning
    // renderer's window is the one the user is watching in.
    getWindowHandle: () => {
      const owner = ownerWindow ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
      if (!owner || owner.isDestroyed()) return null;
      return owner.getNativeWindowHandle();
    },
    logWarning,
  }),
  engine: createEngineDispatcher({
    libvlc: commandLibVlcPlayback,
    mpv: commandMpvPlayback,
  }),
  resolveArtworkPath: (snapshot) => artwork().filePathFor(snapshot.artworkUrl),
});

/** Renderers already wired for release-on-destroy. */
const watchedOwners = new Set<number>();
/** The window the current owner renders into, used for the Windows binding. */
let ownerWindow: BrowserWindow | null = null;

function watchOwner(webContents: WebContents): void {
  if (watchedOwners.has(webContents.id)) return;
  watchedOwners.add(webContents.id);
  const ownerId = webContents.id;
  webContents.once('destroyed', () => {
    watchedOwners.delete(ownerId);
    controller.release(ownerId);
  });
}

/**
 * Resolve artwork in the background and republish once it lands.
 *
 * The snapshot is published immediately without an image, so a media command is
 * never waiting on a file read.
 */
function stageArtwork(snapshot: MediaSessionSnapshot): void {
  if (!snapshot.artworkUrl || artwork().filePathFor(snapshot.artworkUrl)) return;
  void artwork().stage(snapshot.artworkUrl).then((staged) => {
    if (staged) controller.refresh();
  });
}

/**
 * Publish the player's current snapshot and take ownership of the session.
 *
 * The first snapshot of a session claims it; later ones update it. A newer
 * player replaces the previous owner.
 */
export function publishMediaSessionSnapshot(
  webContents: WebContents,
  snapshot: unknown,
): MediaSessionDiagnostics {
  watchOwner(webContents);
  ownerWindow = BrowserWindow.fromWebContents(webContents);
  const diagnostics = controller.publish(
    {
      id: webContents.id,
      isAlive: () => !webContents.isDestroyed(),
      notify: (command, handledInMain) => {
        if (webContents.isDestroyed()) return;
        webContents.send('media-control:command', command, handledInMain);
      },
    },
    snapshot,
  );

  const published = controller.snapshot();
  if (published) stageArtwork(published);
  return diagnostics;
}

/** Release the session held by this renderer, if it holds it. */
export function releaseMediaSession(webContents: WebContents): boolean {
  return controller.release(webContents.id);
}

/** Tear the session down completely. Used on quit. */
export function releaseAllMediaSessions(): void {
  watchedOwners.clear();
  ownerWindow = null;
  artworkStaging?.clear();
  controller.releaseAll();
}

/** Current adapter selection, for diagnostics and the runtime smoke check. */
export function mediaSessionDiagnostics(): MediaSessionDiagnostics {
  return controller.diagnostics();
}
