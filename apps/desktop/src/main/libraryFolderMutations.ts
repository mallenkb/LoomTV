import path from 'node:path';

type FolderKind = 'movies' | 'tvShows' | 'anime' | 'others';
type Dependencies<T> = {
  loadLibrary: () => T;
  saveLibraryMutation: (library: T) => void;
  addFolderToLibrary: (library: T, folder: string, kind: FolderKind) => T;
  removeFolderFromLibrary: (library: T, folder: string) => T;
};

/** One canonical SQLite commit replaces cross-store compensation and journals. */
export function createLibraryFolderMutations<T>(deps: Dependencies<T>) {
  let queue: Promise<void> = Promise.resolve();
  function change(previous: string | null, next: string | null, kind: FolderKind) {
    const pending = queue.then(() => {
      let updated = deps.loadLibrary();
      if (previous && previous !== next) updated = deps.removeFolderFromLibrary(updated, previous);
      if (next) updated = deps.addFolderToLibrary(updated, next, kind);
      deps.saveLibraryMutation(updated);
    });
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  return {
    add: (folder: string, kind: FolderKind) => change(null,path.resolve(folder),kind),
    remove: (folder: string) => change(path.resolve(folder),null,'others'),
    update: (previous: string, next: string, kind: FolderKind) => change(path.resolve(previous),path.resolve(next),kind),
  };
}
