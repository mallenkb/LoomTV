import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { createMediaItemId } from '../libraryItemHelpers.ts';
import { mediaFileRevision } from '../skipSegments/fileIdentity.ts';
import type { LibraryData } from '../appContracts.ts';
import type { MediaItem } from '../metadata/types.ts';
import {
  createPathMapper,
  orderOperations,
  planRenames,
  type RenameOperation,
  type RenamePlan,
  type RenamePlanEntry,
} from './renamePlanner.ts';



/**
 * Performs a planned rename batch and carries every piece of LoomTV state that
 * is keyed by a file path along with it: media IDs (derived from the path),
 * watch progress, track preferences, custom artwork, skip segments and
 * fingerprints (keyed by a revision hash that includes the path), and the
 * subtitle and artwork URLs stored inside library items.
 */

/**
 * One logged step. Renames and moves carry `from` and `to`; a created folder
 * is `mkdir` with only `to`, a removed empty folder is `rmdir` with only
 * `from`. Undo replays the log backwards with every step inverted.
 */
export type LoggedOperation = RenameOperation & {
  role: 'video' | 'sidecar' | 'folder' | 'mkdir' | 'rmdir';
  /** Recreating a removed folder: one that is already there is fine. */
  restore?: boolean;
};

function invert(operation: LoggedOperation): LoggedOperation {
  if (operation.role === 'mkdir') return { role: 'rmdir', from: operation.to, to: '' };
  if (operation.role === 'rmdir') return { role: 'mkdir', from: '', to: operation.from, restore: true };
  return { ...operation, from: operation.to, to: operation.from };
}

/** Do not treat permissions or I/O errors as proof that a path is absent. */
function pathExists(value: string): boolean {
  try {
    fs.lstatSync(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Inspect only after later steps have been reversed, restoring parent paths. */
function stepIsOnDisk(operation: LoggedOperation): boolean {
  if (operation.role === 'mkdir' || operation.role === 'rmdir') {
    const target = operation.role === 'mkdir' ? operation.to : operation.from;
    // A missing/unavailable parent is not evidence that recovery succeeded.
    fs.statSync(path.dirname(target));
    const exists = pathExists(target);
    return operation.role === 'mkdir' ? exists : !exists;
  }
  let sourceExists: boolean;
  let targetExists: boolean;
  if (operation.from.toLowerCase() === operation.to.toLowerCase()) {
    const names = fs.readdirSync(path.dirname(operation.to));
    sourceExists = names.includes(path.basename(operation.from));
    targetExists = names.includes(path.basename(operation.to));
  } else {
    sourceExists = pathExists(operation.from);
    targetExists = pathExists(operation.to);
  }
  if (sourceExists === targetExists) {
    throw new RenameError(`Cannot safely recover "${operation.from}": ${sourceExists ? 'both paths exist' : 'neither path is available'}. The recovery record has been kept.`);
  }
  return targetExists;
}

/** Perform one step with no checks beyond the file system's own. */
function performStep(operation: LoggedOperation): void {
  if (operation.role === 'mkdir') {
    if (operation.restore && fs.existsSync(operation.to)) return;
    fs.mkdirSync(operation.to);
  } else if (operation.role === 'rmdir') {
    if (fs.existsSync(operation.from)) fs.rmdirSync(operation.from);
  } else {
    fs.renameSync(operation.from, operation.to);
  }
}

function inverted(operations: readonly LoggedOperation[]): LoggedOperation[] {
  return [...operations].reverse().map(invert);
}

/** Renames and moves only; folder creation and removal do not move any path. */
function pathMoves(operations: readonly LoggedOperation[]): RenameOperation[] {
  return operations.filter((operation) => operation.role !== 'mkdir' && operation.role !== 'rmdir');
}

function nearestExisting(target: string): string | null {
  let current = path.resolve(target);
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Both paths on one drive, so moving between them is a single atomic rename. */
export function onSameDrive(left: string, right: string): boolean {
  const a = nearestExisting(left);
  const b = nearestExisting(right);
  if (!a || !b) return false;
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false;
  }
}

export type RenameBatchRecord = {
  id: string;
  createdAt: number;
  undoneAt: number;
  operations: LoggedOperation[];
};

export type RenameExecutorDeps = {
  getDatabase: () => BetterSqlite3.Database;
  loadLibrary: () => LibraryData;
  /** Persist the library and reconcile skip analysis, exactly like other library edits. */
  saveLibraryMutation: (data: LibraryData) => void;
  /** Move watch lists, custom artwork, and metadata state from old media IDs to new ones. */
  remapMediaIds: (aliases: ReadonlyMap<string, string>) => void;
  isScanRunning: () => boolean;
  libraryRoots: (data: LibraryData) => string[];
  /** Called after each disk step is journaled; lets a test stop the process mid-batch. */
  onStepCompleted?: (completed: number) => void;
};

export class RenameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenameError';
  }
}

function allItems(data: LibraryData): MediaItem[] {
  return [...(data.movies || []), ...(data.tvShows || []), ...(data.animeShows || [])];
}

/**
 * Rewrite a stored string that names a path: a bare path, or a URL carrying it
 * in a `path=` query parameter, encoded either way LoomTV writes them
 * (`%20` from encodeURIComponent, `+` from URLSearchParams).
 */
export function rewritePathReference(value: string, mapPath: (value: string) => string): string {
  // "/subtitle?path=..." starts with a slash too; a query makes it a URL.
  if (!/[?&]path=/.test(value)) return path.isAbsolute(value) ? mapPath(value) : value;
  // Absolute URLs (thumbnails, local images) are built with URLSearchParams;
  // relative ones (subtitles) with encodeURIComponent. Keep each in its style.
  const formStyle = /^https?:/i.test(value);
  return value.replace(/([?&]path=)([^&#]*)/g, (match, prefix: string, encoded: string) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded.replace(/\+/g, ' '));
    } catch {
      return match;
    }
    const mapped = mapPath(decoded);
    if (mapped === decoded) return match;
    const reencoded = formStyle || encoded.includes('+')
      ? new URLSearchParams({ p: mapped }).toString().slice(2)
      : encodeURIComponent(mapped);
    return `${prefix}${reencoded}`;
  });
}

function rewriteDeep<T>(value: T, mapPath: (value: string) => string): T {
  if (typeof value === 'string') return rewritePathReference(value, mapPath) as T;
  if (Array.isArray(value)) return value.map((entry) => rewriteDeep(entry, mapPath)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteDeep(entry, mapPath)])) as T;
  }
  return value;
}

function defaultAudioTrack(localMetadata: MediaItem['localMetadata']): number {
  return localMetadata?.tracks?.find((track) => track.type === 'audio' && track.default)?.index
    ?? localMetadata?.tracks?.find((track) => track.type === 'audio')?.index
    ?? 0;
}

/** The skip-segment revision for a video, or null when it has none yet. */
function revisionOf(filePath: string, localMetadata: MediaItem['localMetadata']): string | null {
  const durationMs = Math.round((localMetadata?.durationSeconds || 0) * 1000);
  if (!durationMs) return null;
  try {
    return mediaFileRevision(filePath, durationMs, defaultAudioTrack(localMetadata), localMetadata);
  } catch {
    return null;
  }
}

/**
 * Old and new skip-segment revisions for every video whose path changes.
 * Taken before the files move: a revision without stored size and time has
 * to stat the file at its current path.
 */
function revisionChanges(data: LibraryData, mapPath: (value: string) => string): Array<[string, string]> {
  const changes: Array<[string, string]> = [];
  const add = (filePath: string, localMetadata: MediaItem['localMetadata']) => {
    const next = mapPath(filePath);
    if (next === filePath) return;
    const before = revisionOf(filePath, localMetadata);
    if (!before) return;
    const stat = localMetadata?.fileSize !== undefined && localMetadata.modifiedAtMs !== undefined ? null : fs.statSync(filePath, { throwIfNoEntry: false });
    const known = stat ? { ...localMetadata, fileSize: stat.size, modifiedAtMs: stat.mtimeMs } : localMetadata;
    const after = revisionOf(next, known);
    if (after && after !== before) changes.push([before, after]);
  };
  for (const item of allItems(data)) {
    if (item.type === 'movie') add(item.filePath, item.localMetadata);
    for (const file of item.episodeFiles || []) add(file.filePath, file.localMetadata);
  }
  return changes;
}

/** Everything in the database that is keyed by a path, an ID, or a revision. */
function remapStoredState(
  database: BetterSqlite3.Database,
  mapPath: (value: string) => string,
  aliases: ReadonlyMap<string, string>,
  revisions: ReadonlyArray<[string, string]>,
): void {
  database.transaction(() => {
    const progressRows = database.prepare('SELECT DISTINCT file_path FROM playback_progress').all() as Array<{ file_path: string }>;
    const moveProgress = database.prepare('UPDATE OR IGNORE playback_progress SET file_path = ? WHERE file_path = ?');
    for (const { file_path: filePath } of progressRows) {
      const next = mapPath(filePath);
      if (next !== filePath) moveProgress.run(next, filePath);
    }

    const scopes = database.prepare('SELECT DISTINCT scope FROM playback_track_preferences').all() as Array<{ scope: string }>;
    const moveScope = database.prepare('UPDATE OR IGNORE playback_track_preferences SET scope = ? WHERE scope = ?');
    for (const { scope } of scopes) {
      let next = scope;
      if (scope.startsWith('media:')) next = `media:${aliases.get(scope.slice(6)) || scope.slice(6)}`;
      else if (scope.startsWith('file:')) next = `file:${mapPath(scope.slice(5))}`;
      if (next !== scope) moveScope.run(next, scope);
    }

    const candidatePaths = database.prepare('SELECT DISTINCT file_path FROM media_segment_candidates').all() as Array<{ file_path: string }>;
    const moveCandidatePath = database.prepare('UPDATE media_segment_candidates SET file_path = ? WHERE file_path = ?');
    for (const { file_path: filePath } of candidatePaths) {
      const next = mapPath(filePath);
      if (next !== filePath) moveCandidatePath.run(next, filePath);
    }

    const revisionTables = [
      'media_segments',
      'media_fingerprints',
      'media_auxiliary_fingerprints',
      'segment_analysis_inventory',
      'segment_analysis_jobs',
      'media_segment_candidates',
    ];
    const revisionStatements = revisionTables.map((table) => (
      database.prepare(`UPDATE OR IGNORE ${table} SET file_revision = ? WHERE file_revision = ?`)
    ));
    for (const [before, after] of revisions) {
      for (const statement of revisionStatements) statement.run(after, before);
    }

    const mediaIdTables = ['media_segment_candidates', 'segment_analysis_inventory', 'segment_analysis_jobs', 'segment_analysis_state'];
    const mediaIdStatements = mediaIdTables.map((table) => database.prepare(`UPDATE ${table} SET media_id = ? WHERE media_id = ?`));
    for (const [before, after] of aliases) {
      for (const statement of mediaIdStatements) statement.run(after, before);
    }

    const artwork = database.prepare('SELECT media_id, target, data_url FROM custom_artwork').all() as Array<{ media_id: string; target: string; data_url: string }>;
    const updateArtwork = database.prepare('UPDATE custom_artwork SET data_url = ? WHERE media_id = ? AND target = ?');
    for (const row of artwork) {
      const next = rewritePathReference(row.data_url, mapPath);
      if (next !== row.data_url) updateArtwork.run(next, row.media_id, row.target);
    }
  })();
}

/** The library with every stored path moved, and IDs re-derived from the new paths. */
function remapLibrary(data: LibraryData, mapPath: (value: string) => string): { data: LibraryData; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  const remapItem = (item: MediaItem): MediaItem => {
    let next = rewriteDeep(item, mapPath);
    if (next.filePath !== item.filePath && item.id === createMediaItemId(item.filePath)) {
      const nextId = createMediaItemId(next.filePath);
      if (nextId !== item.id) {
        aliases.set(item.id, nextId);
        // Custom artwork is addressed by media ID; its rows move with the
        // alias, so the item's references to it have to follow.
        const oldRef = `loomtv-custom-artwork://artwork/${item.id}/`;
        const newRef = `loomtv-custom-artwork://artwork/${nextId}/`;
        next = JSON.parse(JSON.stringify(next).split(oldRef).join(newRef)) as MediaItem;
        next.id = nextId;
      }
    }
    return next;
  };
  return {
    data: {
      ...data,
      movies: (data.movies || []).map(remapItem),
      tvShows: (data.tvShows || []).map(remapItem),
      animeShows: (data.animeShows || []).map(remapItem),
    },
    aliases,
  };
}

function sameFile(left: string, right: string): boolean {
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/** Execute forward steps; the caller owns durable rollback. */
function performOnDisk(operations: readonly LoggedOperation[], onStep: (completed: number) => void): void {
  let completed = 0;
  const stepDone = () => onStep(++completed);
  for (const operation of operations) {
    if (operation.role === 'mkdir') {
      if (fs.existsSync(operation.to)) throw new RenameError(`"${operation.to}" already exists.`);
      try {
        fs.mkdirSync(operation.to);
      } catch (error) {
        throw new RenameError(`The folder "${path.basename(operation.to)}" could not be created: ${error instanceof Error ? error.message : String(error)}`);
      }
      stepDone();
      continue;
    }
    if (operation.role === 'rmdir') {
      // Only ever an empty folder; one that has gained anything is kept and
      // the step fails rather than deleting what is inside.
      try {
        fs.rmdirSync(operation.from);
      } catch (error) {
        throw new RenameError(`The folder "${path.basename(operation.from)}" could not be removed: ${error instanceof Error ? error.message : String(error)}`);
      }
      stepDone();
      continue;
    }
    if (!fs.existsSync(operation.from)) throw new RenameError(`"${operation.from}" no longer exists.`);
    // A case-only change ("inception.mkv" to "Inception.mkv") names the same
    // file on a case-insensitive disk; anything else already there is kept.
    if (fs.existsSync(operation.to) && !sameFile(operation.from, operation.to)) {
      throw new RenameError(`"${operation.to}" already exists.`);
    }
    try {
      fs.renameSync(operation.from, operation.to);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RenameError(`"${path.basename(operation.from)}" could not be renamed: ${reason}`);
    }
    stepDone();
  }
}

/** A file changed more recently than this is left for a later automatic run. */
const RECENT_CHANGE_MS = 10 * 60 * 1000;

export function createRenameExecutor(deps: RenameExecutorDeps) {
  const lockedTargets = (): Map<string, string> => new Map(
    (deps.getDatabase().prepare('SELECT file_path, rejected_name FROM media_rename_locks').all() as Array<{ file_path: string; rejected_name: string }>)
      .map((row) => [row.file_path, row.rejected_name.toLowerCase()]),
  );

  function plan(options: { automatic?: boolean } = {}): RenamePlan {
    const data = deps.loadLibrary();
    const locks = lockedTargets();
    const now = Date.now();
    return planRenames({
      ...(options.automatic ? {
        isRecentlyModified: (filePath: string) => {
          try {
            return now - fs.statSync(filePath).mtimeMs < RECENT_CHANGE_MS;
          } catch {
            return true;
          }
        },
      } : {}),
      // A movie that shares a folder with others gets a folder of its own.
      movieFolders: true,
      sameDrive: onSameDrive,
      items: allItems(data),
      libraryRoots: deps.libraryRoots(data),
      listDirectory: (directory) => {
        try {
          return fs.readdirSync(directory);
        } catch {
          return null;
        }
      },
      isLocked: (filePath, targetName) => locks.get(filePath) === targetName.toLowerCase(),
    });
  }

  const openJournal = (batchId: string, direction: 'apply' | 'undo', operations: readonly LoggedOperation[]): string => {
    const id = randomUUID();
    deps.getDatabase()
      .prepare('INSERT INTO media_rename_journal (id, batch_id, direction, operations_json, completed, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, batchId, direction, JSON.stringify(operations), Date.now());
    return id;
  };
  const closeJournal = (id: string) => deps.getDatabase().prepare('DELETE FROM media_rename_journal WHERE id = ?').run(id);

  function reverseJournal(id: string, operations: readonly LoggedOperation[], attempted: number): void {
    const remaining = operations.slice(0, attempted);
    const save = deps.getDatabase().prepare('UPDATE media_rename_journal SET operations_json = ?, completed = ? WHERE id = ?');
    // Persist the rollback boundary before touching disk. Removing each restored
    // step makes recovery restartable even if a second crash interrupts rollback.
    save.run(JSON.stringify(remaining), remaining.length, id);
    while (remaining.length > 0) {
      const operation = remaining[remaining.length - 1];
      if (stepIsOnDisk(operation)) performStep(invert(operation));
      remaining.pop();
      save.run(JSON.stringify(remaining), remaining.length, id);
    }
    closeJournal(id);
  }
  /**
   * Move files on disk, then every record that points at them.
   *
   * The steps are journaled before the disk is touched and each completed
   * step is recorded as it happens. Every database change, including
   * `finalize` (the batch record) and removing the journal row, commits in
   * one transaction. A crash before that commit leaves the journal row, and
   * startup recovery reverses exactly the steps that reached the disk.
   */
  function execute(
    operations: readonly LoggedOperation[],
    batchId: string,
    direction: 'apply' | 'undo',
    finalize: (database: BetterSqlite3.Database) => void,
  ): void {
    if (deps.isScanRunning()) throw new RenameError('A library scan is running. Try again when it finishes.');
    const database = deps.getDatabase();
    if (database.prepare('SELECT 1 FROM media_rename_journal LIMIT 1').get()) {
      throw new RenameError('An unfinished rename needs recovery. Restore access to the affected files and restart LoomTV before renaming again.');
    }
    const data = deps.loadLibrary();
    const mapPath = createPathMapper(pathMoves(operations));
    const revisions = revisionChanges(data, mapPath);
    const { data: next, aliases } = remapLibrary(data, mapPath);
    // Undo may find that a removed empty folder has already been recreated.
    // Do not journal a no-op as a creation that rollback should remove.
    const diskOperations = operations.filter((operation) => !(
      operation.role === 'mkdir' && operation.restore && pathExists(operation.to)
    ));
    const journalId = openJournal(batchId, direction, diskOperations);
    const recordStep = database.prepare('UPDATE media_rename_journal SET completed = ? WHERE id = ?');
    let completedOnDisk = 0;
    try {
      performOnDisk(diskOperations, (completed) => {
        completedOnDisk = completed;
        recordStep.run(completed, journalId);
        deps.onStepCompleted?.(completed);
      });
    } catch (error) {
      reverseJournal(journalId, diskOperations, completedOnDisk);
      throw error;
    }
    try {
      database.transaction(() => {
        remapStoredState(database, mapPath, aliases, revisions);
        deps.remapMediaIds(aliases);
        finalize(database);
        database.prepare('DELETE FROM media_rename_journal WHERE id = ?').run(journalId);
        deps.saveLibraryMutation(next);
      })();
    } catch (error) {
      // Nothing in the database changed. Put the files back; if that fails
      // too, the journal row stays and startup recovery finishes the job.
      reverseJournal(journalId, diskOperations, diskOperations.length);
      throw error;
    }
  }

  /**
   * Folders a move left completely empty are removed, walking up while the
   * parent is empty too, but never a library folder or anything above one.
   * A folder with anything left in it, even a stray image, is kept.
   */
  function removeEmptiedFolders(
    entries: readonly RenamePlanEntry[],
    mapPath: (value: string) => string,
    batchId: string,
    operations: LoggedOperation[],
  ): void {
    const roots = deps.libraryRoots(deps.loadLibrary()).map((root) => path.resolve(root));
    const protectedFolder = (folder: string) => roots.some((root) => {
      const relative = path.relative(folder, root);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    const candidates = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== 'file') continue;
      const source = path.dirname(entry.from);
      if (path.dirname(entry.to) !== source) candidates.add(mapPath(source));
    }
    // Each removal is logged before it happens, so undo can always recreate
    // the folder; a logged folder that turns out to still exist is fine.
    const saveLog = deps.getDatabase().prepare('UPDATE media_rename_batches SET operations_json = ? WHERE id = ?');
    const tryRemove = (folder: string) => {
      if (protectedFolder(folder)) return;
      try {
        if (fs.readdirSync(folder).length > 0) return;
      } catch {
        return;
      }
      operations.push({ role: 'rmdir', from: folder, to: '' });
      saveLog.run(JSON.stringify(operations), batchId);
      try {
        fs.rmdirSync(folder);
      } catch {
        operations.pop();
        saveLog.run(JSON.stringify(operations), batchId);
        return;
      }
      tryRemove(path.dirname(folder));
    };
    for (const folder of [...candidates].sort((left, right) => right.length - left.length)) tryRemove(folder);
  }

  function readBatch(batchId: string): RenameBatchRecord | null {
    const row = deps.getDatabase()
      .prepare('SELECT id, created_at, undone_at, operations_json FROM media_rename_batches WHERE id = ?')
      .get(batchId) as { id: string; created_at: number; undone_at: number; operations_json: string } | undefined;
    if (!row) return null;
    return { id: row.id, createdAt: row.created_at, undoneAt: row.undone_at, operations: JSON.parse(row.operations_json) as LoggedOperation[] };
  }

  return {
    plan,

    /**
     * Rename the chosen preview entries. The plan is rebuilt from the current
     * library and disk first, so an entry that no longer applies is dropped
     * rather than acted on from a stale preview.
     */
    /**
     * The automatic run after a sync: every change that passes all checks, as
     * one undoable batch through the same journal as a reviewed apply. Files
     * changed in the last few minutes wait. Null when there is nothing to do.
     */
    applyAutomatic(): { batchId: string; renamed: number } | null {
      const entries = plan({ automatic: true }).entries;
      if (entries.length === 0) return null;
      return this.apply(entries.map((entry) => entry.id));
    },

    apply(entryIds: readonly string[]): { batchId: string; renamed: number } {
      const wanted = new Set(entryIds);
      const entries = plan().entries.filter((entry) => wanted.has(entry.id));
      // An entry's ID covers its exact source and destination. Any approved
      // entry missing from the fresh plan changed since the preview, so
      // nothing runs until the new plan has been reviewed.
      if (entries.length !== wanted.size) {
        const stale = wanted.size - entries.length;
        throw new RenameError(`${stale} of the approved ${stale === 1 ? 'change has' : 'changes have'} changed since the preview. Refresh the preview and review it again.`);
      }
      const videos = new Set(entries.filter((entry) => entry.kind === 'file').map((entry) => entry.from));
      const folders = new Set(entries.filter((entry) => entry.kind === 'folder').map((entry) => entry.from));
      // Folders a move needs are created first, parents before children.
      const created = [...new Set(entries.flatMap((entry) => (entry.createFolder ? [entry.createFolder] : [])))]
        .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length)
        .map((folder): LoggedOperation => ({ role: 'mkdir', from: '', to: folder }));
      const operations: LoggedOperation[] = [
        ...created,
        ...orderOperations(entries).map((operation): LoggedOperation => ({
          ...operation,
          role: folders.has(operation.from) ? 'folder' : videos.has(operation.from) ? 'video' : 'sidecar',
        })),
      ];
      const batchId = randomUUID();
      execute(operations, batchId, 'apply', (database) => {
        database
          .prepare('INSERT INTO media_rename_batches (id, created_at, undone_at, operations_json) VALUES (?, ?, 0, ?)')
          .run(batchId, Date.now(), JSON.stringify(operations));
      });
      removeEmptiedFolders(entries, createPathMapper(pathMoves(operations)), batchId, operations);
      return { batchId, renamed: videos.size };
    },

    /**
     * Put a batch back, newest step first, and lock each video against the
     * name it was given so the same match cannot rename it again.
     */
    undo(batchId: string): { restored: number } {
      const batch = readBatch(batchId);
      if (!batch) throw new RenameError('That rename could not be found.');
      if (batch.undoneAt) throw new RenameError('That rename was already undone.');
      execute(inverted(batch.operations), batchId, 'undo', (database) => {
        const now = Date.now();
        database.prepare('UPDATE media_rename_batches SET undone_at = ? WHERE id = ?').run(now, batchId);
        const lock = database.prepare('INSERT OR REPLACE INTO media_rename_locks (file_path, rejected_name, created_at) VALUES (?, ?, ?)');
        for (const operation of batch.operations) {
          if (operation.role === 'video') lock.run(operation.from, path.basename(operation.to), now);
        }
      });
      return { restored: batch.operations.filter((operation) => operation.role === 'video').length };
    },

    /**
     * Reverse any batch a crash interrupted. Only steps that actually reached
     * the disk are reversed, judged from the disk: the step after the last
     * one journaled may or may not have happened. The database never saw the
     * batch, so the files end up matching it again. Returns batches repaired.
     */
    recoverInterrupted(): number {
      const database = deps.getDatabase();
      const rows = database.prepare('SELECT id, operations_json, completed FROM media_rename_journal ORDER BY created_at ASC').all() as Array<{ id: string; operations_json: string; completed: number }>;
      for (const row of rows) {
        const operations = JSON.parse(row.operations_json) as LoggedOperation[];
        // Only the next unacknowledged step could also have reached disk.
        // Inspect in reverse order, never prefilter using unrestored paths.
        reverseJournal(row.id, operations, Math.min(row.completed + 1, operations.length));
      }
      return rows.length;
    },

    history(limit = 20): RenameBatchRecord[] {
      const rows = deps.getDatabase()
        .prepare('SELECT id, created_at, undone_at, operations_json FROM media_rename_batches ORDER BY created_at DESC LIMIT ?')
        .all(limit) as Array<{ id: string; created_at: number; undone_at: number; operations_json: string }>;
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        undoneAt: row.undone_at,
        operations: JSON.parse(row.operations_json) as LoggedOperation[],
      }));
    },
  };
}
