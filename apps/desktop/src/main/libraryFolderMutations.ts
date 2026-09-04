import path from 'node:path';

type FolderKind = 'movies' | 'tvShows' | 'anime' | 'others';
type Dependencies<T> = {
  loadLibrary: () => T;
  saveLibraryMutation: (library: T) => void;
  addFolderToLibrary: (library: T, folder: string, kind: FolderKind) => T;
  removeFolderFromLibrary: (library: T, folder: string) => T;
  addUnifiedLibraryRoot: (folder: string, kind: FolderKind) => Promise<boolean>;
  removeUnifiedLibraryRoot: (folder: string) => Promise<boolean>;
};

function storedKind(library: unknown, folder: string): FolderKind | null {
  if (!library || typeof library !== 'object') return null;
  const value = library as { libraryFolders?: string[]; libraryFolderGroups?: Partial<Record<FolderKind, string[]>> };
  const matches = (candidate: string) => path.resolve(candidate) === path.resolve(folder);
  for (const kind of ['movies', 'tvShows', 'anime', 'others'] as const) {
    if (value.libraryFolderGroups?.[kind]?.some(matches)) return kind;
  }
  return value.libraryFolders?.some(matches) ? 'others' : null;
}

// Serialize folder operations separately from long-running scans. Read the
// latest library again at commit so scan checkpoints cannot be overwritten.
export function createLibraryFolderMutations<T>(deps: Dependencies<T>) {
  let queue: Promise<void> = Promise.resolve();
  function change(previous: string | null, next: string | null, kind: FolderKind) {
    const run = async () => {
      const original = deps.loadLibrary();
      const undo: Array<() => Promise<boolean>> = [];
      try {
        if (next) {
          const oldKind = storedKind(original, next);
          if (await deps.addUnifiedLibraryRoot(next, kind)) {
            undo.push(() => oldKind ? deps.addUnifiedLibraryRoot(next, oldKind) : deps.removeUnifiedLibraryRoot(next));
          }
        }
        if (previous && previous !== next) {
          const oldKind = storedKind(original, previous);
          if (await deps.removeUnifiedLibraryRoot(previous)) {
            if (oldKind) undo.push(() => deps.addUnifiedLibraryRoot(previous, oldKind));
          }
        }
        let updated = deps.loadLibrary();
        if (previous && previous !== next) updated = deps.removeFolderFromLibrary(updated, previous);
        if (next) updated = deps.addFolderToLibrary(updated, next, kind);
        deps.saveLibraryMutation(updated);
      } catch (error) {
        const failures: unknown[] = [];
        for (const restore of undo.reverse()) {
          try {
            if (!await restore()) throw new Error('The server became unavailable during folder rollback.', { cause: error });
          } catch (failure) { failures.push(failure); }
        }
        if (failures.length) throw new AggregateError([error, ...failures], 'Folder synchronization failed and could not be rolled back. Check the server library folders before retrying.', { cause: error });
        throw error;
      }
    };
    const pending = queue.then(run);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  return {
    add: (folder: string, kind: FolderKind) => change(null, path.resolve(folder), kind),
    remove: (folder: string) => change(path.resolve(folder), null, 'others'),
    update: (previous: string, next: string, kind: FolderKind) => change(path.resolve(previous), path.resolve(next), kind),
  };
}
