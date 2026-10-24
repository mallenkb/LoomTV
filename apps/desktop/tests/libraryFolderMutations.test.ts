import assert from 'node:assert/strict';
import test from 'node:test';
import { createLibraryFolderMutations } from '../src/main/libraryFolderMutations.ts';

type Library = { libraryFolders: string[] };
function fixture() {
  let library: Library = {libraryFolders: ['/old']};
  let rejectNext = false;
  let commits = 0;
  const mutations = createLibraryFolderMutations({
    loadLibrary: () => library,
    saveLibraryMutation: (next: Library) => {
      if (rejectNext) { rejectNext = false; throw new Error('Disk full'); }
      library = next;
      commits += 1;
    },
    addFolderToLibrary: (current: Library,folder: string) => ({libraryFolders: [...new Set([...current.libraryFolders,folder])]}),
    removeFolderFromLibrary: (current: Library,folder: string) => ({libraryFolders: current.libraryFolders.filter(value=>value!==folder)}),
  });
  return {mutations,library:()=>library,commits:()=>commits,failNext:()=>{rejectNext=true;}};
}

test('folder replacement is one commit of the complete saved state',async()=>{
  const context = fixture();
  await context.mutations.update('/old','/new','movies');
  assert.deepEqual(context.library().libraryFolders,['/new']);
  assert.equal(context.commits(),1);
});

test('failed storage commit preserves the library and does not poison the queue',async()=>{
  const context = fixture();
  context.failNext();
  await assert.rejects(context.mutations.add('/bad','movies'),/Disk full/);
  assert.deepEqual(context.library().libraryFolders,['/old']);
  await context.mutations.add('/good','movies');
  assert.deepEqual(context.library().libraryFolders,['/old','/good']);
});

test('queued mutations read the latest committed library',async()=>{
  const context = fixture();
  await Promise.all([context.mutations.add('/one','movies'),context.mutations.add('/two','tvShows'),context.mutations.remove('/old')]);
  assert.deepEqual(context.library().libraryFolders,['/one','/two']);
  assert.equal(context.commits(),3);
});
