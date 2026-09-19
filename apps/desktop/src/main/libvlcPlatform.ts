export type LibVlcPlatformHost = 'macos-child' | 'windows-child';

export type LibVlcPlatformBinding = {
  drawableSymbol: 'libvlc_media_player_set_nsobject' | 'libvlc_media_player_set_hwnd';
  mediaVoutOption: ':vout=macosx' | ':vout=direct3d11';
  host: LibVlcPlatformHost;
};

/**
 * Return the directory aliases accepted by the native-runtime packager.
 * Keep the canonical Electron target (`win32`) first so a bundled runtime is
 * found without relying on a legacy platform alias.
 */
export function libVlcPlatformVariants(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['darwin', 'mac', 'macos'];
  if (platform === 'win32') return ['win32', 'win', 'windows'];
  return ['linux'];
}

/**
 * Keep platform-specific LibVLC ABI choices in one small, testable contract.
 * A raw BrowserWindow handle is never used directly: both supported targets
 * create a child surface so Chromium can remain above the video controls.
 */
export function libVlcPlatformBinding(platform: NodeJS.Platform): LibVlcPlatformBinding | null {
  if (platform === 'darwin') {
    return {
      drawableSymbol: 'libvlc_media_player_set_nsobject',
      mediaVoutOption: ':vout=macosx',
      host: 'macos-child',
    };
  }
  if (platform === 'win32') {
    return {
      drawableSymbol: 'libvlc_media_player_set_hwnd',
      mediaVoutOption: ':vout=direct3d11',
      host: 'windows-child',
    };
  }
  return null;
}

/**
 * Set the video child at the bottom first, then the backdrop. SetWindowPos
 * moves each target to HWND_BOTTOM, so the second call leaves the backdrop
 * below the video while Chromium stays above both children.
 */
export function orderWindowsLibVlcChildren<T>(
  video: T,
  backdrop: T,
  moveToBottom: (child: T) => void,
): void {
  moveToBottom(video);
  moveToBottom(backdrop);
}
