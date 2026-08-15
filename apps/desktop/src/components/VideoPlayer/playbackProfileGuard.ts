/**
 * Electron serializes errors thrown by a main-process IPC handler into a
 * single message. Keep the check narrow so codec, filesystem, and FFmpeg
 * failures still reach the player's normal retry UI.
 */
export function isProfileSelectionRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /(?:profile_required|no profile is selected on this device|select a profile(?: from the host)? first)/i.test(message);
}
