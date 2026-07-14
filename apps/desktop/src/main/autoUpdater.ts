import { app, BrowserWindow, Menu, dialog, autoUpdater as electronAutoUpdater } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { stopAllTranscodes } from './transcodeManager';
import { destroyLanDiscovery } from './lanDiscovery';
import { createUpdateAdapter } from './updateAdapter';

const UPDATE_OWNER = 'mallenkb';
const UPDATE_REPO = 'LoomTV';
const execFileAsync = promisify(execFile);
export type UpdateStatus =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'not-available'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  supported: boolean;
  downloadPercent?: number;
  latestVersion?: string;
  releaseUrl?: string;
  message?: string;
  checkedAt?: string;
}

/**
 * The auto-updater needs two things from the main module: a way to reach the
 * main window (for dialogs) and a way to drain the local media server before
 * quitAndInstall. These are injected so this stays decoupled from main.ts.
 */
interface AutoUpdaterDeps {
  getMainWindow: () => BrowserWindow | null;
  closeMediaServer: () => Promise<void>;
}

let deps: AutoUpdaterDeps = {
  getMainWindow: () => null,
  closeMediaServer: async () => { /* replaced by initAutoUpdater */ },
};

export function initAutoUpdater(injected: AutoUpdaterDeps): void {
  deps = injected;
}

function isUpdaterSupportedPlatform(): boolean {
  return process.platform === 'darwin'
    || process.platform === 'win32'
    || (process.platform === 'linux' && Boolean(process.env.APPIMAGE));
}

let updateState: UpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  supported: isUpdaterSupportedPlatform(),
};
let updaterConfigured = false;
let updateCheckInFlight = false;
let updateCheckPromise: Promise<UpdateState> | null = null;
let updateInstallStarted = false;
let updatePromptInFlight = false;
let updateMenu: Menu | null = null;
let updateQuitFallbackTimer: NodeJS.Timeout | null = null;
let updateQuitFallbackCleanup: (() => void) | null = null;
let downloadedUpdateFilePath: string | null = null;
let updateAdapter: ReturnType<typeof createUpdateAdapter<UpdateState>> | null = null;

export function getUpdateState(): UpdateState {
  return updateState;
}

export function isUpdateInstalling(): boolean {
  return updateInstallStarted;
}

export function stopUpdateCheckTimer(): void {
  updateAdapter?.stop();
  updateAdapter = null;
}

function emitUpdateState() {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('updates:state', updateState);
  });
  void refreshUpdateMenu();
}

function setUpdateState(nextState: Partial<UpdateState>) {
  updateState = {
    ...updateState,
    ...nextState,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    supported: isUpdaterSupportedPlatform(),
  };
  emitUpdateState();
  return updateState;
}

function showUpdateDialog(message: string, detail: string, type: 'info' | 'warning' | 'error' = 'info'): void {
  const mainWindow = deps.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void dialog.showMessageBox(mainWindow, {
    type,
    title: 'Loom Media Server Updates',
    message,
    detail,
    buttons: ['OK'],
  });
}

function getUpdateErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingUpdateFeedError(error: unknown): boolean {
  const message = getUpdateErrorMessage(error).toLowerCase();
  return (
    message.includes('cannot find latest-')
    || message.includes('could not fetch a valid release')
    || message.includes('404')
    || message.includes('not found')
  );
}

function handleUpdateError(error: unknown): UpdateState {
  if (isMissingUpdateFeedError(error)) {
    return setUpdateState({
      status: 'not-available',
      message: 'No published update is available yet. Please try again shortly.',
      checkedAt: new Date().toISOString(),
    });
  }

  console.warn('[updates] Failed to check for or download an update:', error);
  return setUpdateState({
    status: 'error',
    message: 'Could not check for updates. Please try again later.',
    checkedAt: new Date().toISOString(),
  });
}

function normalizeReleaseVersion(value?: string): string {
  return String(value || '').trim().replace(/^v/i, '');
}

function compareReleaseVersions(left?: string, right?: string): number {
  const leftParts = normalizeReleaseVersion(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeReleaseVersion(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index++) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }

  return 0;
}

async function checkLatestGitHubRelease(): Promise<UpdateState> {
  setUpdateState({ status: 'checking', downloadPercent: undefined, message: 'Checking for updates...' });

  try {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `LoomMediaServer/${app.getVersion()}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Update check returned ${response.status}`);
    }

    const release = await response.json() as { tag_name?: string; html_url?: string };
    const latestVersion = normalizeReleaseVersion(release.tag_name);
    const currentVersion = app.getVersion();
    const hasUpdate = compareReleaseVersions(latestVersion, currentVersion) > 0;

    return setUpdateState({
      status: hasUpdate ? 'available' : 'not-available',
      latestVersion,
      releaseUrl: release.html_url,
      checkedAt: new Date().toISOString(),
      message: hasUpdate
        ? `Loom Media Server ${latestVersion} is available.`
        : `Loom Media Server is up to date at ${currentVersion}.`,
    });
  } catch (error) {
    return setUpdateState({
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    });
  }
}

export function showUpdateDownloadedPrompt() {
  const mainWindow = deps.getMainWindow();
  if (updatePromptInFlight || !mainWindow || mainWindow.isDestroyed()) return;
  updatePromptInFlight = true;

  const stateMessage = updateState.message || 'An update is available.';
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: 'Loom Media Server update downloaded',
    detail: `${stateMessage} Restart now to apply the update.`,
    buttons: ['Restart and Update', 'Later'],
    defaultId: 0,
    cancelId: 1,
  })
    .then((response) => {
      if (response.response === 0) {
        void installDownloadedUpdate();
      }
    })
    .finally(() => {
      updatePromptInFlight = false;
    });
}

export function clearUpdateQuitFallback(): void {
  if (updateQuitFallbackTimer) {
    clearTimeout(updateQuitFallbackTimer);
    updateQuitFallbackTimer = null;
  }
  if (updateQuitFallbackCleanup) {
    updateQuitFallbackCleanup();
    updateQuitFallbackCleanup = null;
  }
}

function scheduleUpdateQuitFallback(): void {
  clearUpdateQuitFallback();
  const fallbackDelayMs = process.platform === 'darwin' ? 15000 : 3000;

  const clearFallbackOnceQuitStarts = () => clearUpdateQuitFallback();
  app.once('before-quit', clearFallbackOnceQuitStarts);
  electronAutoUpdater.once('before-quit-for-update', clearFallbackOnceQuitStarts);
  updateQuitFallbackCleanup = () => {
    app.removeListener('before-quit', clearFallbackOnceQuitStarts);
    electronAutoUpdater.removeListener('before-quit-for-update', clearFallbackOnceQuitStarts);
  };

  updateQuitFallbackTimer = setTimeout(() => {
    updateQuitFallbackTimer = null;
    if (updateQuitFallbackCleanup) {
      updateQuitFallbackCleanup();
      updateQuitFallbackCleanup = null;
    }

    if (!updateInstallStarted) return;

    console.warn('[updates] quitAndInstall did not begin app shutdown; forcing Loom Media Server to quit.');
    app.quit();
  }, fallbackDelayMs);
  updateQuitFallbackTimer.unref?.();
}

function getMacUpdaterPendingInfoPath(updateFilePath: string): string {
  return path.join(path.dirname(updateFilePath), 'update-info.json');
}

async function sha512Base64(filePath: string): Promise<string> {
  const hash = createHash('sha512');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('base64');
}

async function verifyMacUpdateZip(updateFilePath: string): Promise<void> {
  const infoPath = getMacUpdaterPendingInfoPath(updateFilePath);
  const rawInfo = await fs.promises.readFile(infoPath, 'utf8');
  const info = JSON.parse(rawInfo) as { sha512?: string; fileName?: string };
  if (!info.sha512) throw new Error('Downloaded update metadata is missing a sha512 checksum.');

  const actualSha512 = await sha512Base64(updateFilePath);
  if (actualSha512 !== info.sha512) {
    throw new Error('Downloaded update checksum did not match the release metadata.');
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function extractMacUpdate(updateFilePath: string, extractDir: string): Promise<string> {
  await fs.promises.mkdir(extractDir, { recursive: true });
  await execFileAsync('/usr/bin/ditto', ['-x', '-k', updateFilePath, extractDir]);

  const entries = await fs.promises.readdir(extractDir, { withFileTypes: true });
  const appBundles = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(extractDir, entry.name));

  if (appBundles.length !== 1) {
    throw new Error(`Downloaded update must contain exactly one macOS app bundle; found ${appBundles.length}.`);
  }

  await fs.promises.access(path.join(appBundles[0], 'Contents', 'Info.plist'), fs.constants.R_OK);
  return appBundles[0];
}

async function waitForChildToSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

async function installMacUpdateWithoutSquirrel(updateFilePath: string): Promise<void> {
  await verifyMacUpdateZip(updateFilePath);

  const helperDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loomtv-update-install-'));
  const helperPath = path.join(helperDir, 'install-update.sh');
  const runningAppPath = app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '');
  if (!runningAppPath.endsWith('.app')) {
    throw new Error(`Could not resolve the running macOS app bundle from ${app.getPath('exe')}.`);
  }

  // Replace the bundle that was actually launched. The product was renamed
  // from LoomTV to Loom Media Server, so deriving this path from app.getName()
  // can install a second app while leaving the user's Dock icon on the old one.
  const targetAppPath = runningAppPath;
  const backupAppPath = path.join(helperDir, `${path.basename(targetAppPath)}.previous`);
  const extractDir = path.join(helperDir, 'extracted');
  const logPath = path.join(helperDir, 'install.log');
  const parentPid = String(process.pid);
  let sourceAppPath: string;

  try {
    sourceAppPath = await extractMacUpdate(updateFilePath, extractDir);

    // Fail while the current app is still open, so a permissions problem can
    // be shown instead of silently quitting and stranding the update.
    await fs.promises.access(path.dirname(targetAppPath), fs.constants.W_OK);
  } catch (error) {
    await fs.promises.rm(helperDir, { recursive: true, force: true });
    throw error;
  }

  const script = `#!/bin/sh
set -eu
LOG=${shellQuote(logPath)}
exec >> "$LOG" 2>&1
echo "Starting Loom Media Server macOS update install at $(date)"
PARENT_PID=${shellQuote(parentPid)}
SOURCE_APP=${shellQuote(sourceAppPath)}
TARGET_APP=${shellQuote(targetAppPath)}
BACKUP_APP=${shellQuote(backupAppPath)}

while kill -0 "$PARENT_PID" >/dev/null 2>&1; do
  sleep 0.25
done

rm -rf "$BACKUP_APP"
if [ -d "$TARGET_APP" ]; then
  /bin/mv "$TARGET_APP" "$BACKUP_APP"
fi

restore_previous_app() {
  echo "Restoring previous app bundle"
  rm -rf "$TARGET_APP"
  if [ -d "$BACKUP_APP" ]; then
    /bin/mv "$BACKUP_APP" "$TARGET_APP"
    /usr/bin/open -n "$TARGET_APP" || true
  fi
}

if ! /usr/bin/ditto "$SOURCE_APP" "$TARGET_APP"; then
  echo "Failed to copy updated app, restoring previous app"
  restore_previous_app
  exit 1
fi

/usr/bin/xattr -dr com.apple.quarantine "$TARGET_APP" >/dev/null 2>&1 || true

if ! /usr/bin/open -n "$TARGET_APP"; then
  echo "Failed to relaunch updated app"
  restore_previous_app
  exit 1
fi

TARGET_EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$TARGET_APP/Contents/Info.plist")
LAUNCHED=0
ATTEMPT=0
while [ "$ATTEMPT" -lt 20 ]; do
  if /usr/bin/pgrep -f "$TARGET_APP/Contents/MacOS/$TARGET_EXECUTABLE" >/dev/null 2>&1; then
    LAUNCHED=1
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 0.5
done

if [ "$LAUNCHED" -ne 1 ]; then
  echo "Updated app did not stay running after relaunch"
  restore_previous_app
  exit 1
fi

rm -rf "$BACKUP_APP" "$SOURCE_APP"
echo "Finished Loom Media Server macOS update install at $(date)"
`;

  let child: ReturnType<typeof spawn>;
  try {
    await fs.promises.writeFile(helperPath, script, { mode: 0o755 });
    child = spawn('/bin/sh', [helperPath], {
      detached: true,
      stdio: 'ignore',
    });
    await waitForChildToSpawn(child);
  } catch (error) {
    await fs.promises.rm(helperDir, { recursive: true, force: true });
    throw error;
  }
  child.unref();

  // app.quit() can emit before-quit yet remain alive because of a lingering
  // Electron/Node handle. The installer cannot replace the bundle until this
  // PID exits, so force the already-drained process down after a short grace.
  setTimeout(() => app.exit(0), 5000);
  app.quit();
}

function refreshUpdateMenu() {
  if (!updateMenu) return;

  const installMenuItem = updateMenu.getMenuItemById('loomtv-install-update');
  if (installMenuItem) {
    installMenuItem.enabled = updateState.status === 'downloaded';
    installMenuItem.visible = updateState.status === 'downloaded';
  }

  const checkMenuItem = updateMenu.getMenuItemById('loomtv-check-updates');
  if (checkMenuItem) {
    checkMenuItem.enabled = !updateCheckInFlight;
    checkMenuItem.label = updateCheckInFlight ? 'Checking for Updates...' : 'Check for Updates...';
  }
}

export function buildUpdateMenu() {
  const updateItems: MenuItemConstructorOptions[] = [
    {
      id: 'loomtv-check-updates',
      label: 'Check for Updates...',
      click: () => {
        void handleManualUpdateCheck();
      },
    },
    {
      id: 'loomtv-install-update',
      label: 'Install Downloaded Update...',
      visible: updateState.status === 'downloaded',
      enabled: updateState.status === 'downloaded',
      click: () => {
        if (updateState.status === 'downloaded') void installDownloadedUpdate();
      },
    },
  ];

  const template: MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            ...updateItems,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
        {
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' },
          ],
        },
      ]
    : [
        {
          label: 'File',
          submenu: [
            ...updateItems,
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
      ];

  updateMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(updateMenu);
}

export async function handleManualUpdateCheck() {
  const checkedState = await checkForUpdates();

  if (checkedState.status === 'checking') {
    showUpdateDialog(
      'Checking for updates',
      'Loom Media Server is already checking for an update. You’ll get notified when it completes.',
    );
    return;
  }

  if (checkedState.status === 'downloading' || checkedState.status === 'available') {
    showUpdateDialog(
      'Update check in progress',
      'An update is being checked and downloaded in the background.',
    );
    return;
  }

  if (checkedState.status === 'downloaded') {
    showUpdateDownloadedPrompt();
    return;
  }

  if (checkedState.status === 'not-available') {
    showUpdateDialog('No update found', `You’re already on Loom Media Server ${checkedState.currentVersion}.`);
    return;
  }

  if (checkedState.status === 'disabled') {
    showUpdateDialog('Updates are not available', checkedState.message || 'Updates are not available in this environment.');
    return;
  }

  if (checkedState.status === 'error') {
    showUpdateDialog('Update check failed', checkedState.message || 'Could not check for updates.', 'warning');
  }
}

export async function installDownloadedUpdate() {
  if (updateInstallStarted) return updateState;
  if (updateState.status !== 'downloaded') return updateState;
  updateInstallStarted = true;

  setUpdateState({ status: 'installing', message: 'Installing update and restarting Loom Media Server...' });

  // Drain playback/server work before quitAndInstall. Active HTTP streams can
  // keep the process alive after every window has closed, which leaves the
  // downloaded installer waiting for Loom Media Server to exit.
  try {
    stopAllTranscodes();
    destroyLanDiscovery();
    await deps.closeMediaServer();
    stopUpdateCheckTimer();
  } catch (error) {
    console.warn('[updates] pre-install cleanup failed:', error);
  }

  if (process.platform === 'darwin' && downloadedUpdateFilePath) {
    try {
      await installMacUpdateWithoutSquirrel(downloadedUpdateFilePath);
    } catch (error) {
      updateInstallStarted = false;
      setUpdateState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      });
    }
    return updateState;
  }

  // Let electron-updater own the window close and app quit sequence. Destroying
  // windows manually before this call can bypass the updater's normal restart
  // path and leave the app sitting on "Restarting...".
  // Force-restart after install. Without isForceRunAfter:true the NSIS/AppImage
  // installer can exit silently without relaunching the app.
  // - isSilent:true skips the NSIS UI on Windows (DMG on macOS ignores this).
  // - autoInstallOnAppQuit was set to false at configure time so this call is
  //   the single source of truth for installing.
  setTimeout(() => {
    try {
      scheduleUpdateQuitFallback();
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      clearUpdateQuitFallback();
      updateInstallStarted = false;
      setUpdateState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      });
    }
  }, 250);

  return updateState;
}

export function configureAutoUpdater() {
  if (updaterConfigured) return;
  updaterConfigured = true;

  if (!updateState.supported) {
    setUpdateState({
      status: 'disabled',
      message: 'Automatic updates are available in packaged macOS, Windows, and Linux AppImage builds.',
    });
    return;
  }

  if (!app.isPackaged) {
    setUpdateState({
      status: 'disabled',
      message: 'Automatic updates are enabled after Loom Media Server is packaged and published.',
    });
    return;
  }

  autoUpdater.autoDownload = true;
  // We control the install moment via quitAndInstall(true, true). Letting
  // electron-updater also install on natural app quit would double-install
  // and race the relaunch.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: UPDATE_OWNER,
    repo: UPDATE_REPO,
  });

  autoUpdater.on('checking-for-update', () => {
    setUpdateState({ status: 'checking', message: 'Checking for updates...' });
  });

  autoUpdater.on('update-available', () => {
    setUpdateState({ status: 'available', message: 'Update available, downloading...' });
  });

  autoUpdater.on('download-progress', (progress) => {
    if (!progress?.percent) return;
    setUpdateState({
      status: 'downloading',
      downloadPercent: Math.round(progress.percent),
      message: `Downloading update ${Math.round(progress.percent)}%`,
    });
  });

  autoUpdater.on('update-not-available', () => {
    setUpdateState({
      status: 'not-available',
      message: 'Loom Media Server is up to date.',
      checkedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on('update-downloaded', (event) => {
    downloadedUpdateFilePath = event.downloadedFile;
    setUpdateState({
      status: 'downloaded',
      message: 'Update downloaded. Restart Loom Media Server to install it.',
      checkedAt: new Date().toISOString(),
    });
    showUpdateDownloadedPrompt();
  });

  autoUpdater.on('error', (error) => {
    if (updateState.status === 'installing') {
      updateInstallStarted = false;
      clearUpdateQuitFallback();
    }
    handleUpdateError(error);
  });

}

export function startUpdateAdapter() {
  if (!updateAdapter) {
    updateAdapter = createUpdateAdapter({
      getState: getUpdateState,
      configure: configureAutoUpdater,
      checkForUpdates,
      promptForDownloadedUpdate: showUpdateDownloadedPrompt,
    });
  }
  updateAdapter.start();
}

export async function checkForUpdates(): Promise<UpdateState> {
  configureAutoUpdater();
  if (!updateState.supported || !app.isPackaged) {
    return checkLatestGitHubRelease();
  }
  if (updateCheckInFlight || updateState.status === 'downloading' || updateState.status === 'downloaded') {
    return updateCheckPromise || updateState;
  }

  updateCheckInFlight = true;
  setUpdateState({ status: 'checking', downloadPercent: undefined, message: 'Checking for updates...' });
  updateCheckPromise = autoUpdater.checkForUpdates()
    .then(() => updateState)
    .catch((error) => {
      return handleUpdateError(error);
    })
    .finally(() => {
      updateCheckInFlight = false;
      updateCheckPromise = null;
      refreshUpdateMenu();
    });
  return updateCheckPromise;
}
