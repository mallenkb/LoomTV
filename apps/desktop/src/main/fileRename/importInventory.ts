import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { MediaItem } from '../metadata/types.ts';
import { isVideoFileName, subtitleMatchesVideo } from '../fileClassification.ts';
import { createPathMapper } from './renamePlanner.ts';
import type { LoggedOperation } from './renameExecutor.ts';

export type InventoryEntry = {
  original: string;
  current: string;
  identity: string;
  kind: 'file' | 'directory' | 'symlink';
  video: boolean;
  held?: boolean;
  expired?: boolean;
};
export type ImportRecord = {
  id: string;
  title: string;
  category: 'movie' | 'tv' | 'anime';
  root: string;
  createdAt: number;
  removedAt: number;
  restoreRequestedAt: number;
  restoredAt: number;
  originalQuality: 'captured' | 'historical-partial';
  entries: InventoryEntry[];
  createdDirectories: Array<{ path: string; identity: string }>;
};
export type RestoreIssue = { path: string; reason: string };
export type OriginalRestorePlan = {
  importId: string;
  operations: LoggedOperation[];
  issues: RestoreIssue[];
  alreadyOriginal: number;
};

export function within(file: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Identity survives our renames, but does not use a title or path as identity. */
export function inventoryIdentity(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}${stat.isFile() ? `:${stat.size}:${stat.mtimeMs}` : ''}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Do not traverse symlinks, including a link inserted into a recorded parent path. */
export function assertLibraryPath(file: string, root: string): void {
  if (!within(file, root) || path.resolve(file) === path.resolve(root)) throw new Error('The operation must stay inside its library folder.');
  fs.accessSync(root, fs.constants.R_OK);
  let parent = path.dirname(file);
  for (;;) {
    try {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`The parent folder is unavailable or is a link: ${parent}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (path.resolve(parent) === path.resolve(root)) break;
    parent = path.dirname(parent);
  }
}

export function inventoryTree(target: string): InventoryEntry[] {
  const stat = fs.lstatSync(target);
  const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file';
  const entry: InventoryEntry = {
    original: target, current: target, identity: inventoryIdentity(target) || '', kind,
    video: kind === 'file' && isVideoFileName(path.basename(target)),
  };
  if (kind !== 'directory') return [entry];
  return [entry, ...fs.readdirSync(target).flatMap((name) => inventoryTree(path.join(target, name)))];
}

export function createImportInventory(getDatabase: () => BetterSqlite3.Database) {
  const all = (): ImportRecord[] => (getDatabase().prepare('SELECT record_json FROM library_imports ORDER BY created_at, id').all() as Array<{ record_json: string }>).map((row) => JSON.parse(row.record_json) as ImportRecord);
  const save = (record: ImportRecord) => getDatabase().prepare('INSERT INTO library_imports (id, created_at, removed_at, record_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET removed_at = excluded.removed_at, record_json = excluded.record_json')
    .run(record.id, record.createdAt, record.removedAt, JSON.stringify(record));
  const get = (id: string): ImportRecord | null => {
    const row = getDatabase().prepare('SELECT record_json FROM library_imports WHERE id = ?').get(id) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as ImportRecord : null;
  };

  function capture(target: string, root: string, title: string, category: ImportRecord['category'], records: ImportRecord[], now: number): ImportRecord | null {
    assertLibraryPath(target, root);
    const tracked = new Map(records.filter((record) => !record.removedAt).flatMap((record) => record.entries.map((entry) => [entry.current, entry.identity] as const)));
    const entries = inventoryTree(target).filter((entry) => tracked.get(entry.current) !== entry.identity);
    if (!entries.length) return null;
    // A directory shared with an earlier import is not owned by this import.
    const owned = entries.filter((entry) => entry.kind !== 'directory' || ![...tracked.keys()].some((current) => within(current, entry.current)));
    if (!owned.length) return null;
    let historical = false;
    for (const entry of owned) {
      if (entry.kind !== 'file') continue;
      const stat = fs.statSync(entry.current);
      const legacy = getDatabase().prepare('SELECT original_path FROM media_original_names WHERE identity = ? AND current_path = ?')
        .get(`${stat.dev}:${stat.ino}:${stat.size}`, entry.current) as { original_path: string } | undefined;
      if (legacy && within(legacy.original_path, root)) {
        entry.original = legacy.original_path;
        historical = true;
      }
    }
    // Recover paths affected only by a historical parent rename. Never infer
    // names for files created after that rename, and report the partial provenance.
    const history = getDatabase().prepare('SELECT created_at, undone_at, operations_json FROM media_rename_batches ORDER BY created_at DESC').all() as Array<{ created_at: number; undone_at: number; operations_json: string }>;
    for (const entry of owned) {
      if (entry.original !== entry.current) continue;
      const born = fs.lstatSync(entry.current).birthtimeMs;
      for (const batch of history) {
        if (batch.undone_at || !born || born > batch.created_at) continue;
        for (const operation of (JSON.parse(batch.operations_json) as LoggedOperation[]).reverse()) {
          if (!operation.from || !operation.to || !within(operation.from, root)) continue;
          if (entry.original === operation.to || (operation.role === 'folder' && within(entry.original, operation.to))) {
            entry.original = operation.from + entry.original.slice(operation.to.length);
            historical = true;
          }
        }
      }
    }
    // Older cleanup rows are the only record of extras no longer on disk.
    // Attach them only to the same pre-existing folder, never a later download.
    if (fs.lstatSync(target).isDirectory()) {
      const born = fs.lstatSync(target).birthtimeMs;
      const folders = owned.filter((entry) => entry.kind === 'directory').flatMap((entry) => [entry.original, entry.current]);
      const cleanup = getDatabase().prepare('SELECT created_at, items_json FROM library_cleanup_batches WHERE restored_at = 0').all() as Array<{ created_at: number; items_json: string }>;
      for (const batch of cleanup) {
        if (!born || born > batch.created_at) continue;
        const items = JSON.parse(batch.items_json) as Array<{ from: string; held: string; state?: string }>;
        for (const item of items) {
          if (item.state === 'restored' || !folders.some((folder) => within(item.from, folder))) continue;
          if (records.some((value) => value.entries.some((entry) => within(entry.current, item.held)))) continue;
          historical = true;
          const heldIdentity = inventoryIdentity(item.held);
          if (!heldIdentity) {
            owned.push({ original: item.from, current: item.held, identity: '', kind: 'file', video: false, held: true, expired: true });
            continue;
          }
          for (const entry of inventoryTree(item.held).filter((value) => value.kind !== 'directory')) {
            owned.push({ ...entry, original: item.from + entry.current.slice(item.held.length), held: true });
          }
        }
      }
    }
    const record: ImportRecord = {
      id: randomUUID(), title, category, root, createdAt: now, removedAt: 0,
      restoreRequestedAt: 0, restoredAt: 0, originalQuality: historical ? 'historical-partial' : 'captured',
      entries: owned, createdDirectories: [],
    };
    save(record);
    records.push(record);
    return record;
  }

  /** Capture first-seen content before any operation, including hidden entries. */
  function captureLibrary(items: readonly MediaItem[], roots: readonly string[], now = Date.now()): void {
    getDatabase().transaction(() => {
      const records = all();
      for (const item of items) {
        const videos = item.type === 'movie' ? [item.filePath] : (item.episodeFiles?.map((episode) => episode.filePath) || []);
        if (!videos.length && isVideoFileName(path.basename(item.filePath))) videos.push(item.filePath);
        for (const video of videos) {
          const root = [...roots].map((value) => path.resolve(value)).sort((a, b) => b.length - a.length).find((value) => within(video, value));
          if (!root) continue;
          assertLibraryPath(video, root);
          const identity = inventoryIdentity(video);
          if (!identity) continue;
          const active = records.filter((record) => !record.removedAt);
          if (active.some((record) => record.entries.some((entry) => entry.current === video && entry.identity === identity))) continue;
          let target = video;
          for (let parent = path.dirname(video); parent !== root && within(parent, root); parent = path.dirname(parent)) {
            if (active.some((record) => record.entries.some((entry) => within(entry.current, parent)))) break;
            target = parent;
          }
          const record = capture(target, root, item.title, item.type, records, now);
          if (target === video && record) {
            // Sidecars imported alongside a loose episode belong to that episode.
            for (const name of fs.readdirSync(path.dirname(video))) {
              const candidate = path.join(path.dirname(video), name);
              if (candidate === video || !subtitleMatchesVideo(name, path.basename(video)) || isVideoFileName(name)) continue;
              if (fs.lstatSync(candidate).isDirectory() || active.some((value) => value.entries.some((entry) => entry.current === candidate))) continue;
              record.entries.push(...inventoryTree(candidate));
            }
            save(record);
          }
        }
      }
    })();
  }

  function capturePaths(paths: readonly string[], roots: readonly string[]): void {
    getDatabase().transaction(() => {
      const records = all();
      for (const target of paths) {
        const root = [...roots].sort((a, b) => b.length - a.length).find((value) => within(target, value));
        if (!root) throw new Error('A cleanup candidate is outside the configured libraries.');
        capture(target, root, path.basename(target), 'movie', records, Date.now());
      }
    })();
  }

  /** Called in the same database transaction as the rename journal commit. */
  function moved(operations: readonly LoggedOperation[], held = false, recordCreations = true): void {
    const moves = operations.filter((operation) => operation.from && operation.to);
    const mapper = createPathMapper(moves);
    for (const record of all()) {
      if (record.removedAt) continue;
      let changed = false;
      for (const entry of record.entries) {
        const next = mapper(entry.current);
        if (next === entry.current) continue;
        entry.current = next;
        entry.identity = inventoryIdentity(next) || entry.identity;
        entry.held = held;
        changed = true;
      }
      for (const directory of record.createdDirectories) directory.path = mapper(directory.path);
      if (changed) {
        for (const operation of operations.filter((op) => recordCreations && op.role === 'mkdir')) {
          const folder = mapper(operation.to);
          if (!record.entries.some((entry) => within(entry.current, folder))) continue;
          const identity = inventoryIdentity(folder);
          if (identity) {
            const previous = record.createdDirectories.find((value) => value.path === folder);
            if (previous) previous.identity = identity;
            else record.createdDirectories.push({ path: folder, identity });
          }
        }
        record.restoredAt = 0;
        save(record);
      }
    }
  }

  /** Only the scanner's successful roots can establish that a file disappeared. */
  function reconcile(completedRoots: readonly string[], now = Date.now()): void {
    getDatabase().transaction(() => {
      for (const record of all()) {
        if (record.removedAt || !completedRoots.some((root) => within(record.root, root))) continue;
        const videos = record.entries.filter((entry) => entry.video);
        if (!videos.length) continue;
        try {
          fs.accessSync(record.root, fs.constants.R_OK);
          if (videos.every((entry) => { assertLibraryPath(entry.current, record.root); return inventoryIdentity(entry.current) !== entry.identity; })) {
            record.removedAt = now;
            save(record);
          }
        } catch { /* An inaccessible drive or folder is not a deletion. */ }
      }
    })();
  }

  /** Build once per planning pass, rather than rereading history for every file. */
  function protection(exceptImportId?: string): (target: string) => boolean {
    const paths = new Set<string>();
    for (const record of all().filter((value) => value.id !== exceptImportId && !value.removedAt && value.restoreRequestedAt > 0)) {
      for (const entry of record.entries) {
        if (entry.held) continue;
        for (let target = entry.current; within(target, record.root); target = path.dirname(target)) {
          paths.add(path.resolve(target));
          if (path.resolve(target) === path.resolve(record.root)) break;
        }
      }
    }
    return (target) => paths.has(path.resolve(target));
  }

  function preview(id: string): OriginalRestorePlan {
    const record = get(id);
    if (!record) throw new Error('That import could not be found.');
    const result: OriginalRestorePlan = { importId: id, operations: [], issues: [], alreadyOriginal: 0 };
    if (record.removedAt) {
      result.issues.push({ path: record.root, reason: 'This import was removed. Its history does not contain a backup of the video.' });
      return result;
    }
    const directories = new Set<string>();
    const destinations = new Set<string>();
    for (const entry of record.entries) {
      try {
        assertLibraryPath(entry.original, record.root);
        if (entry.kind === 'directory') {
          if (!fs.existsSync(entry.original)) directories.add(entry.original);
          else if (!fs.lstatSync(entry.original).isDirectory()) throw new Error('The original directory is occupied by a file.');
          continue;
        }
        if (entry.expired || inventoryIdentity(entry.current) !== entry.identity) throw new Error('The original content is missing, expired, or has been replaced.');
        if (entry.current === entry.original) { result.alreadyOriginal += 1; continue; }
        if (entry.kind === 'symlink') throw new Error('Restore this recorded symbolic link manually.');
        if (entry.held) continue;
        assertLibraryPath(entry.current, record.root);
        if (fs.existsSync(entry.original) || destinations.has(entry.original.toLocaleLowerCase())) throw new Error('The original destination is occupied.');
        destinations.add(entry.original.toLocaleLowerCase());
        for (let parent = path.dirname(entry.original); parent !== record.root && !fs.existsSync(parent); parent = path.dirname(parent)) directories.add(parent);
        result.operations.push({ from: entry.current, to: entry.original, role: entry.video ? 'video' : 'sidecar', expectedIdentity: entry.identity });
      } catch (error) {
        result.issues.push({ path: entry.original, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    result.operations.unshift(...[...directories].sort((a, b) => a.length - b.length).map((to): LoggedOperation => ({ role: 'mkdir', from: '', to, restore: true })));
    return result;
  }

  function requestRestore(id: string): void {
    const record = get(id);
    if (!record || record.removedAt) throw new Error('Only an available import can be restored.');
    record.restoreRequestedAt = Date.now();
    save(record);
  }

  function finishRestore(id: string): void {
    const record = get(id);
    if (!record) return;
    for (const folder of [...record.createdDirectories, ...record.entries.filter((entry) => entry.kind === 'directory' && entry.current !== entry.original).map((entry) => ({ path: entry.current, identity: entry.identity }))].sort((a, b) => b.path.length - a.path.length)) {
      try {
        assertLibraryPath(folder.path, record.root);
        if (inventoryIdentity(folder.path) === folder.identity && fs.readdirSync(folder.path).length === 0) fs.rmdirSync(folder.path);
      } catch { /* Never remove nonempty, replaced, or unavailable folders. */ }
    }
    for (const entry of record.entries.filter((value) => value.kind === 'directory')) {
      if (fs.existsSync(entry.original) && fs.lstatSync(entry.original).isDirectory()) {
        entry.current = entry.original;
        entry.identity = inventoryIdentity(entry.original) || entry.identity;
      }
    }
    if (record.entries.every((entry) => entry.current === entry.original && inventoryIdentity(entry.current) === entry.identity && !entry.expired)) record.restoredAt = Date.now();
    save(record);
  }

  /** Final checks also reject symlink parents and children added since capture. */
  function operationValidator(operations: readonly LoggedOperation[]): (operation: LoggedOperation) => void {
    const records = all().filter((record) => !record.removedAt);
    const roots = [...new Set(records.map((record) => record.root))];
    const known = new Set(records.flatMap((record) => record.entries.map((entry) => entry.identity)));
    return (operation) => {
      for (const target of [operation.from, operation.to].filter(Boolean)) {
        const root = roots.find((value) => within(target, value));
        if (!root) throw new Error('The operation is outside the recorded library.');
        assertLibraryPath(target, root);
      }
      if (operation.role !== 'folder') return;
      for (const created of operations.filter((op) => op.role === 'mkdir')) {
        const identity = inventoryIdentity(created.to);
        if (identity) known.add(identity);
      }
      if (inventoryTree(operation.from).some((entry) => !known.has(entry.identity))) throw new Error('This folder gained unrecorded content. Refresh the library before organizing it.');
    };
  }

  function originalPath(file: string): string | null {
    const identity = inventoryIdentity(file);
    const entry = all().filter((record) => !record.removedAt).flatMap((record) => record.entries).find((value) => value.current === file && value.identity === identity);
    return entry && entry.original !== file ? entry.original : null;
  }

  return { all, get, save, captureLibrary, capturePaths, moved, reconcile, protection, preview, requestRestore, finishRestore, originalPath, operationValidator };
}
