import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * The name and location each file had before LoomTV first renamed or moved
 * it, recorded once and never changed afterwards.
 *
 * Files are identified by device, inode and size, which a rename or a move on
 * the same drive keeps, so a file renamed twice still maps to its first name.
 * The size guards against the drive reusing an inode for a different file.
 */

type Move = { from: string; to: string };
type LoggedMove = Move & { role: string };

export function fileIdentity(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? `${stat.dev}:${stat.ino}:${stat.size}` : null;
  } catch {
    return null;
  }
}

export function createOriginalNameStore(getDatabase: () => BetterSqlite3.Database) {
  /** Call after files have moved. A file already on record keeps its first name. */
  function recordMoves(moves: readonly Move[], now = Date.now()): void {
    const database = getDatabase();
    const insert = database.prepare('INSERT OR IGNORE INTO media_original_names (identity, original_path, current_path, recorded_at) VALUES (?, ?, ?, ?)');
    const update = database.prepare('UPDATE media_original_names SET current_path = ? WHERE identity = ?');
    database.transaction(() => {
      for (const move of moves) {
        const identity = fileIdentity(move.to);
        if (!identity) continue;
        if (insert.run(identity, move.from, move.to, now).changes === 0) update.run(move.to, identity);
      }
    })();
  }

  /** The file's first recorded path, or null when LoomTV never renamed it. */
  function originalPath(filePath: string): string | null {
    const identity = fileIdentity(filePath);
    if (!identity) return null;
    const row = getDatabase().prepare('SELECT original_path FROM media_original_names WHERE identity = ?').get(identity) as { original_path?: string } | undefined;
    return row?.original_path && path.resolve(row.original_path) !== path.resolve(filePath) ? row.original_path : null;
  }

  /**
   * Fill the record from rename history kept before this table existed:
   * replay every batch oldest first, following renamed folders, and record
   * each file that is still where history left it. Undone batches put files
   * back, so they are skipped. Returns the number of files recorded.
   */
  function backfillFromHistory(batches: ReadonlyArray<{ undoneAt: number; operations: readonly LoggedMove[] }>): number {
    const origin = new Map<string, string>();
    for (const batch of batches) {
      if (batch.undoneAt) continue;
      for (const operation of batch.operations) {
        if (!operation.from || !operation.to) continue;
        if (operation.role === 'folder') {
          const prefix = operation.from + path.sep;
          for (const [current, first] of [...origin]) {
            if (!current.startsWith(prefix)) continue;
            origin.delete(current);
            origin.set(operation.to + current.slice(operation.from.length), first);
          }
          continue;
        }
        if (operation.role !== 'video' && operation.role !== 'sidecar') continue;
        const first = origin.get(operation.from) ?? operation.from;
        origin.delete(operation.from);
        origin.set(operation.to, first);
      }
    }
    const moves = [...origin].map(([to, from]) => ({ from, to })).filter((move) => fileIdentity(move.to));
    recordMoves(moves);
    return moves.length;
  }

  function isEmpty(): boolean {
    return !getDatabase().prepare('SELECT 1 FROM media_original_names LIMIT 1').get();
  }

  return { recordMoves, originalPath, backfillFromHistory, isEmpty };
}
