import assert from 'node:assert/strict';
import test from 'node:test';
import { createLibraryFolderMutations } from '../src/main/libraryFolderMutations.ts';

type Library = { libraryFolders: string[] };
function fixture() {
  let library: Library = { libraryFolders: ['/old'] };
  const server = new Set(['/old']);
  const deps = {
    loadLibrary: () => library,
    saveLibraryMutation: (next: Library) => { library = next; },
    addFolderToLibrary: (current: Library, folder: string) => ({ libraryFolders: [...new Set([...current.libraryFolders, folder])] }),
    removeFolderFromLibrary: (current: Library, folder: string) => ({ libraryFolders: current.libraryFolders.filter((entry) => entry !== folder) }),
    addUnifiedLibraryRoot: async (folder: string) => { server.add(folder); return true; },
    removeUnifiedLibraryRoot: async (folder: string) => { server.delete(folder); return true; },
  };
  return { deps, server, library: () => library };
}

test('server rejection leaves local folders unchanged', async () => {
  const context = fixture();
  context.deps.addUnifiedLibraryRoot = async () => { throw new Error('Server unavailable'); };
  await assert.rejects(createLibraryFolderMutations(context.deps).add('/new', 'movies'), /Server unavailable/);
  assert.deepEqual(context.library().libraryFolders, ['/old']);
});

test('failed local commit compensates a replacement in reverse order', async () => {
  const context = fixture();
  context.deps.saveLibraryMutation = () => { throw new Error('Disk full'); };
  await assert.rejects(createLibraryFolderMutations(context.deps).update('/old', '/new', 'movies'), /Disk full/);
  assert.deepEqual([...context.server], ['/old']);
  assert.deepEqual(context.library().libraryFolders, ['/old']);
});

test('concurrent adds preserve both folders and a rejected operation does not poison the queue', async () => {
  const context = fixture();
  const add = context.deps.addUnifiedLibraryRoot;
  context.deps.addUnifiedLibraryRoot = async (folder) => {
    if (folder === '/bad') throw new Error('Rejected');
    return add(folder);
  };
  const mutations = createLibraryFolderMutations(context.deps);
  const results = await Promise.allSettled([mutations.add('/bad', 'movies'), mutations.add('/one', 'movies'), mutations.add('/two', 'movies')]);
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.deepEqual(context.library().libraryFolders, ['/old', '/one', '/two']);
});
