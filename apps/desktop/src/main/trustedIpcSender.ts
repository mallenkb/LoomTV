/**
 * Sender identity for a single `ipcMain.handle` invocation, reduced to plain
 * values so the trust rule can be exercised without a live BrowserWindow.
 *
 * Sender fields are read from Electron by the caller. The expected app URL is
 * captured when the window is created and is never replaced by the current
 * document URL. A field that could not be read — a destroyed frame, a window
 * that closed mid-call — is passed as `null`, which this rule treats as
 * untrusted.
 */
export interface IpcSenderIdentity {
  senderWebContentsId: number;
  senderFrameIsMainFrame: boolean;
  senderFrameUrl: string | null;
  mainWindowWebContentsId: number | null;
  expectedAppUrl: string | null;
  mainWindowDestroyed: boolean;
}

const TRUSTED_APPLICATION_PROTOCOLS = new Set(['file:', 'http:', 'https:']);

/**
 * Compare a navigation or sender URL with the immutable application identity
 * captured when the main window was created. Never use the window's current
 * URL as the expected value: a compromised navigation would make that value
 * self-justifying.
 */
export function isExpectedAppUrl(candidateUrl: string | null, expectedAppUrl: string | null): boolean {
  if (!candidateUrl || !expectedAppUrl) return false;

  try {
    const candidate = new URL(candidateUrl);
    const expected = new URL(expectedAppUrl);
    if (!TRUSTED_APPLICATION_PROTOCOLS.has(expected.protocol)
      || !TRUSTED_APPLICATION_PROTOCOLS.has(candidate.protocol)
      || candidate.protocol !== expected.protocol) return false;
    if (expected.protocol === 'file:') {
      return candidate.hostname === expected.hostname && candidate.pathname === expected.pathname;
    }
    return candidate.origin === expected.origin;
  } catch {
    return false;
  }
}

/**
 * Whether an IPC invocation came from the application's own main window frame.
 *
 * Both halves matter. The webContents id rejects any other window or view; the
 * frame URL is compared with the immutable app identity so a navigated window
 * cannot make an attacker URL trusted. `file:` application URLs compare by
 * host and pathname because every `file:` URL shares the null origin.
 */
export function isTrustedIpcSender(identity: IpcSenderIdentity): boolean {
  const {
    senderWebContentsId,
    senderFrameIsMainFrame,
    senderFrameUrl,
    mainWindowWebContentsId,
    expectedAppUrl,
    mainWindowDestroyed,
  } = identity;

  if (mainWindowDestroyed) return false;
  if (mainWindowWebContentsId === null) return false;
  if (senderWebContentsId !== mainWindowWebContentsId) return false;
  if (!senderFrameIsMainFrame) return false;
  return isExpectedAppUrl(senderFrameUrl, expectedAppUrl);
}
