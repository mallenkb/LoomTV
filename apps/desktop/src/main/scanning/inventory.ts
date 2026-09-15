import { scanMetrics } from './scanMetrics.ts';
import type { MediaItem } from '../metadata/types.ts';
import { filenameHints } from './filename.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { discoveryEntrySchema, type DiscoveryEntry } from './discoveryTypes.ts';

export function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

class InventoryDirent implements fs.Dirent {
  readonly name: string;
  readonly parentPath: string;
  private readonly kind: string;
  constructor(name: string, kind: string, parentPath: string) { this.name = name; this.kind = kind; this.parentPath = parentPath; }
  get path(): string { return this.parentPath; }
  isDirectory(): boolean { return this.kind === 'directory'; }
  isFile(): boolean { return this.kind === 'file'; }
  isSymbolicLink(): boolean { return false; }
  isBlockDevice(): boolean { return false; }
  isCharacterDevice(): boolean { return false; }
  isFIFO(): boolean { return false; }
  isSocket(): boolean { return false; }
}

/** Attempt-local inventory and disk staging, never the user's catalog. Discard on failure. */
export class DiscoveryInventory {
  readonly root: string;
  private readonly directory = fs.mkdtempSync(path.join(os.tmpdir(), `loom-scan-${process.pid}-`));
  private readonly statements = new Map<string, BetterSqlite3.Statement>();
  private readonly database = new BetterSqlite3(path.join(this.directory, 'inventory.sqlite'));
  // Keep ordinary roots in memory. Spill larger inventories before their size
  // can grow without bound; staged MediaItems always remain on disk.
  private memoryEntries: Map<string, DiscoveryEntry> | null = new Map();
  private memoryChildren: Map<string, string[]> | null = new Map();
  private static readonly MEMORY_ENTRY_LIMIT = 4_096;
  private static readonly MEMORY_BYTE_LIMIT = 4 * 1024 * 1024;
  private readonly directoryIds = new Map<string, number>();
  private memoryBytes = 0;
  private fileCount = 0;
  private workerSignature?: { signature: string; fileCount: number };
  complete = false;
  signal?: AbortSignal;
  constructor(root: string) {
    this.root = path.resolve(root);
    this.database.pragma('journal_mode = OFF');
    // This database is discarded on failure. Only the catalog checkpoint needs
    // durable writes; syncing every discovery batch stalls large quick scans.
    this.database.pragma('synchronous = OFF');
    this.database.pragma('cache_size = -2048');
    this.database.exec('CREATE TABLE directories (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL); CREATE TABLE entries (parent INTEGER, name TEXT, kind TEXT, size TEXT, mtime TEXT, hints TEXT, PRIMARY KEY (parent, name)) WITHOUT ROWID; CREATE TABLE staged_items (id TEXT PRIMARY KEY, item TEXT);');
  }
  private prepare(sql: string): BetterSqlite3.Statement {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.database.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  add(entries: DiscoveryEntry[]): void {
    if (this.complete) throw new Error('Discovery already completed.');
    const validated = entries.map((raw) => {
      const entry = discoveryEntrySchema.parse(raw);
      if (!path.isAbsolute(entry.path) || path.resolve(entry.path) !== entry.path || entry.path === this.root || !withinRoot(this.root, entry.path)) {
        throw new Error('Scanner returned a path outside its root.');
      }
      return entry;
    });
    if (this.memoryEntries) {
      // Use a conservative string/record bound so long paths and subtitle keys
      // cannot turn the entry-count limit into gigabytes of retained data.
      this.memoryBytes += validated.reduce((total, entry) => total + 256
        + 3 * (entry.path.length + (entry.hints?.title.length || 0)
          + (entry.hints?.subtitleKeys?.reduce((sum, key) => sum + key.length + 16, 0) || 0)), 0);
      if (this.memoryEntries.size + validated.length > DiscoveryInventory.MEMORY_ENTRY_LIMIT
        || this.memoryBytes > DiscoveryInventory.MEMORY_BYTE_LIMIT) this.spillEntries();
    }
    if (this.memoryEntries && this.memoryChildren) {
      for (const entry of validated) {
        if (this.memoryEntries.has(entry.path)) throw new Error('Scanner returned a duplicate path.');
        this.memoryEntries.set(entry.path, entry);
        const parent = path.dirname(entry.path);
        const children = this.memoryChildren.get(parent) || [];
        children.push(entry.path);
        this.memoryChildren.set(parent, children);
        if (entry.kind === 'file') this.fileCount++;
      }
      return;
    }
    this.writeEntries(validated);
    this.fileCount += validated.filter((entry) => entry.kind === 'file').length;
  }
  acceptWorkerSignature(signature: string, fileCount: number): void {
    if (!this.complete || fileCount !== this.fileCount || !signature.startsWith(`inventory-v1:${fileCount}:`)) {
      throw new Error('Scanner signature does not match its inventory.');
    }
    this.workerSignature = { signature, fileCount };
  }
  private directoryId(directory: string, create = false): number | undefined {
    const cached = this.directoryIds.get(directory);
    if (cached !== undefined) return cached;
    let row = this.prepare('SELECT id FROM directories WHERE path = ?').get(directory) as { id: number } | undefined;
    if (!row && create) row = { id: Number(this.prepare('INSERT INTO directories (path) VALUES (?)').run(directory).lastInsertRowid) };
    if (!row) return undefined;
    // Bound the lookup cache even when a root has millions of directories.
    if (this.directoryIds.size >= 512) {
      const oldest = this.directoryIds.keys().next().value;
      if (oldest !== undefined) this.directoryIds.delete(oldest);
    }
    this.directoryIds.set(directory, row.id);
    return row.id;
  }
  private writeEntries(entries: Iterable<DiscoveryEntry>): void {
    const insert = this.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)');
    this.database.transaction(() => {
      for (const entry of entries) insert.run(this.directoryId(path.dirname(entry.path), true), path.basename(entry.path),
        entry.kind, entry.size, entry.mtime, entry.hints ? JSON.stringify(entry.hints) : null);
    })();
  }
  private spillEntries(): void {
    if (!this.memoryEntries) return;
    this.writeEntries(this.memoryEntries.values());
    this.memoryEntries = null;
    this.memoryChildren = null;
    this.memoryBytes = 0;
  }
  get(filePath: string): DiscoveryEntry | undefined {
    const entry = this.readEntry(filePath, true);
    return entry && !entry.hints ? { ...entry, hints: filenameHints(path.basename(entry.path)) } : entry;
  }
  facts(filePath: string): DiscoveryEntry | undefined {
    return this.readEntry(filePath, false);
  }
  private readEntry(filePath: string, includeHints: boolean): DiscoveryEntry | undefined {
    const resolved = path.resolve(filePath);
    if (this.memoryEntries) return this.memoryEntries.get(resolved);
    const row = this.prepare(`SELECT kind, size, mtime${includeHints ? ', hints' : ''} FROM entries WHERE parent = ? AND name = ?`).get(this.directoryId(path.dirname(resolved)) ?? -1, path.basename(resolved)) as (Omit<DiscoveryEntry, 'path' | 'hints'> & { hints?: string }) | undefined;
    if (!includeHints) return row ? { path: resolved, kind: row.kind, size: row.size, mtime: row.mtime } : undefined;
    return row ? { ...row, path: resolved, hints: row.hints ? JSON.parse(row.hints) || undefined : undefined } : undefined;
  }
  entries(directory: string): fs.Dirent[] {
    this.signal?.throwIfAborted();
    if (!this.complete) throw new Error('Discovery is incomplete.');
    if (!withinRoot(this.root, directory)) throw new Error('Directory is outside discovery root.');
    const memoryEntries = this.memoryEntries;
    const rows = this.memoryChildren && memoryEntries
      ? [...(this.memoryChildren.get(path.resolve(directory)) || [])]
        .map((filePath) => ({ filePath, sortKey: Buffer.from(filePath) }))
        .sort((left, right) => Buffer.compare(left.sortKey, right.sortKey))
        .map(({ filePath }) => {
          const entry = memoryEntries.get(filePath);
          if (!entry) throw new Error('Inventory entry disappeared.');
          return { name: path.basename(filePath), kind: entry.kind };
        })
      : this.prepare('SELECT name, kind FROM entries WHERE parent = ? ORDER BY name').all(this.directoryId(path.resolve(directory)) ?? -1) as { name: string; kind: string }[];
    return rows.map(({ name, kind }) => new InventoryDirent(name, kind, directory));
  }
  signature() {
    if (!this.complete) throw new Error('Discovery is incomplete.');
    if (this.workerSignature) return this.workerSignature;
    const hash = createHash('sha256');
    let fileCount = 0;
    // UTF-8 binary ordering is independent of OS locale and worker arrival order.
    for (const row of this.signatureRows()) {
      hash.update(JSON.stringify([path.relative(this.root, row.path).split(path.sep).join('/'), row.size, row.mtime]));
      hash.update('\n');
      fileCount++;
    }
    return { signature: `inventory-v1:${fileCount}:${hash.digest('hex')}`, fileCount };
  }
  stageItems(items: MediaItem[]): void {
    const insert = this.prepare('INSERT OR IGNORE INTO staged_items VALUES (?, ?)');
    this.database.transaction(() => { for (const item of items) insert.run(item.id, JSON.stringify(item)); })();
  }
  stagedItemCount(): number { return (this.prepare('SELECT count(*) AS n FROM staged_items').get() as { n: number }).n; }
  *stagedItems(): Generator<MediaItem> {
    for (const row of this.prepare('SELECT item FROM staged_items ORDER BY rowid').iterate() as Iterable<{ item: string }>) yield JSON.parse(row.item);
  }
  async signatureAsync() {
    if (!this.complete) throw new Error('Discovery is incomplete.');
    if (this.workerSignature) return this.workerSignature;
    const hash = createHash('sha256'); let fileCount = 0;
    for (const row of this.signatureRows()) {
      this.signal?.throwIfAborted();
      hash.update(JSON.stringify([path.relative(this.root, row.path).split(path.sep).join('/'), row.size, row.mtime]));
      hash.update('\n'); fileCount++;
      if (fileCount % 128 === 0) await yieldToEventLoop();
    }
    return { signature: `inventory-v1:${fileCount}:${hash.digest('hex')}`, fileCount };
  }
  private *signatureRows(): IterableIterator<DiscoveryEntry> {
    if (this.memoryEntries) {
      const rows = [...this.memoryEntries.values()].filter((entry) => entry.kind === 'file')
        .map((entry) => ({ entry, sortKey: Buffer.from(entry.path) }));
      rows.sort((left, right) => Buffer.compare(left.sortKey, right.sortKey));
      for (const row of rows) yield row.entry;
    } else {
      yield* this.prepare(`SELECT CASE WHEN substr(d.path, -1) = ? THEN d.path || e.name ELSE d.path || ? || e.name END AS path,
        e.size, e.mtime FROM entries e JOIN directories d ON d.id = e.parent WHERE e.kind = 'file' ORDER BY path`)
        .iterate(path.sep, path.sep) as Iterable<DiscoveryEntry>;
    }
  }
  async validateFile(filePath: string): Promise<void> {
    this.signal?.throwIfAborted();
    const original = this.facts(filePath);
    if (!original || original.kind !== 'file') throw new Error('File was not discovered.');
    const metrics = scanMetrics.getStore();
    if (metrics) metrics.rechecks++;
    const current = await fs.promises.stat(filePath, { bigint: true });
    if (String(current.size) !== original.size || String(current.mtimeNs / 1_000_000n) !== original.mtime) throw new Error('Library file changed during scanning.');
  }
  close(): void {
    this.memoryEntries?.clear();
    this.memoryChildren?.clear();
    this.memoryEntries = null;
    this.memoryChildren = null;
    this.statements.clear();
    this.directoryIds.clear();
    this.workerSignature = undefined;
    this.memoryBytes = 0;
    this.database.close();
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}

export const scanInventory = new AsyncLocalStorage<DiscoveryInventory>();
export async function readScanDirectory(directory: string): Promise<fs.Dirent[]> {
  const inventory = scanInventory.getStore();
  return inventory ? inventory.entries(directory) : fs.promises.readdir(directory, { withFileTypes: true });
}
export async function scanFileSize(filePath: string): Promise<number> {
  const inventory = scanInventory.getStore();
  const entry = inventory?.facts(filePath);
  const size = entry ? Number(entry.size) : (await fs.promises.stat(filePath)).size;
  if (!Number.isSafeInteger(size)) throw new Error('File size exceeds the supported range.');
  return size;
}
export async function verifyDiscoveredFile(filePath: string): Promise<void> {
  await scanInventory.getStore()?.validateFile(filePath);
}

export function scanFilenameHints(filePath: string, fallbackName: string) {
  return scanInventory.getStore()?.get(filePath)?.hints || filenameHints(fallbackName);
}

let stagingCleaned = false;
export function cleanupAbandonedInventories(): void {
  if (stagingCleaned) return;
  stagingCleaned = true;
  for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
    const match = entry.name.match(/^loom-scan-([0-9]+)-[a-zA-Z0-9]+$/);
    if (!entry.isDirectory() || !match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') fs.rmSync(path.join(os.tmpdir(), entry.name), { recursive: true, force: true });
    }
  }
}
