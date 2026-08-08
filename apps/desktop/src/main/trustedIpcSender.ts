/**
 * Sender identity for a single `ipcMain.handle` invocation, reduced to plain
 * values so the trust rule can be exercised without a live BrowserWindow.
 *
 * Every field is read from Electron by the caller. A field that could not be
 * read — a destroyed frame, a window that closed mid-call — is passed as
 * `null`, which this rule treats as untrusted.
 */
export interface IpcSenderIdentity {
  senderWebContentsId: number;
  senderFrameIsMainFrame: boolean;
  senderFrameUrl: string | null;
  mainWindowWebContentsId: number | null;
  mainWindowUrl: string | null;
  mainWindowDestroyed: boolean;
}

/**
 * Whether an IPC invocation came from the application's own main window frame.
 *
 * Both halves matter. The webContents id rejects any other window or view; the
 * frame URL rejects a subframe the main window may have been navigated into.
 * `file:` application URLs compare by pathname because every `file:` URL shares
 * the null origin.
 */
export function isTrustedIpcSender(identity: IpcSenderIdentity): boolean {
  const {
    senderWebContentsId,
    senderFrameIsMainFrame,
    senderFrameUrl,
    mainWindowWebContentsId,
    mainWindowUrl,
    mainWindowDestroyed,
  } = identity;

  if (mainWindowDestroyed) return false;
  if (mainWindowWebContentsId === null) return false;
  if (senderWebContentsId !== mainWindowWebContentsId) return false;
  if (!senderFrameIsMainFrame) return false;
  if (!senderFrameUrl || !mainWindowUrl) return false;

  try {
    const senderUrl = new URL(senderFrameUrl);
    const applicationUrl = new URL(mainWindowUrl);
    if (applicationUrl.protocol === 'file:') {
      return senderUrl.protocol === 'file:' && senderUrl.pathname === applicationUrl.pathname;
    }
    return senderUrl.origin === applicationUrl.origin;
  } catch {
    return false;
  }
}
