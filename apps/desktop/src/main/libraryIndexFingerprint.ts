import { createHash } from 'node:crypto';
import type { LibraryIndexPayload, LibraryIndexUnchanged } from '../shared/desktopProtocol';

/**
 * The renderer refreshes its catalog every 30 seconds and on focus, and most
 * of those refreshes find nothing new. Answer with a fingerprint instead of
 * sending the whole index again. The fingerprint covers the payload itself,
 * because folder status and lastPlayed change without a mutation version,
 * plus the profile scope it was built for.
 */
export function libraryIndexIfChanged(
  index: LibraryIndexPayload,
  scope: string,
  knownFingerprint?: string,
): LibraryIndexPayload | LibraryIndexUnchanged {
  // checkedAt records when each folder was last looked at, so it differs on
  // every build; the status itself is what the renderer shows.
  const comparable = {
    ...index,
    libraryFolderStatuses: index.libraryFolderStatuses?.map(({ checkedAt: _checkedAt, ...status }) => status),
  };
  const fingerprint = createHash('sha256')
    .update(`${scope}\n`)
    .update(JSON.stringify(comparable))
    .digest('hex')
    .slice(0, 32);
  if (knownFingerprint === fingerprint) return { catalogVersion: 1, unchanged: true, fingerprint };
  return { ...index, fingerprint };
}
