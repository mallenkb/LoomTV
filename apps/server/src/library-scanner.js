import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyVideoFile, createMediaItemId, isVideoFilePath } from '@loom-media-server/media-core';
const CHECKPOINT_EVERY_FILES = 50;

function mediaRecord(root, filePath, stats) {
  const relativePath = path.relative(root.path, filePath);
  // Shared classification keeps the headless catalog structurally identical
  // to what the desktop scanner derives for the same mounted files.
  const classification = classifyVideoFile(relativePath);
  return {
    // The shared identity algorithm is also used by the Electron scanner.
    // This keeps a mounted library portable between desktop and headless
    // runtimes instead of creating duplicate catalog IDs.
    id: createMediaItemId(filePath),
    rootId: root.id,
    path: filePath,
    relativePath,
    title: classification.title,
    kind: classification.kind,
    ...(classification.year ? { year: classification.year } : {}),
    ...(classification.animeLikely ? { animeLikely: true } : {}),
    ...(classification.series ? { series: classification.series } : {}),
    extension: path.extname(filePath).slice(1).toLowerCase(),
    sizeBytes: stats.size,
    modifiedAtMs: stats.mtimeMs,
    available: true,
    indexedAt: Date.now(),
  };
}

async function walkVideoFiles(rootPath, onFile, onError) {
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      onError(current, error);
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !isVideoFilePath(entry.name)) continue;
      try {
        await onFile(fullPath, await fs.stat(fullPath));
      } catch (error) {
        onError(fullPath, error);
      }
    }
  }
}

export function createHeadlessLibraryScanner({ loadState, saveState, appendLog }) {
  let activeScan = null;

  async function finish(scanId, update) {
    const state = await loadState();
    if (state.scan?.id !== scanId) return state.scan;
    state.scan = { ...state.scan, ...update };
    await saveState(state);
    return state.scan;
  }

  async function runScan(scanId, mode, roots) {
    const state = await loadState();
    const discoveredByRoot = new Map();
    const errors = [];
    const offlineRoots = [];
    let scannedFiles = 0;

    for (const root of roots) {
      let rootStat;
      try {
        rootStat = await fs.stat(root.path);
        if (!rootStat.isDirectory()) throw Object.assign(new Error('Path is not a directory.'), { code: 'ENOTDIR' });
        await fs.access(root.path);
      } catch (error) {
        offlineRoots.push(root.id);
        errors.push({ rootId: root.id, path: root.path, code: error?.code || 'EUNAVAILABLE', message: 'Library root is unavailable; existing records were preserved.' });
        continue;
      }

      const discovered = [];
      let rootHadTraversalErrors = false;
      await walkVideoFiles(
        root.path,
        async (filePath, stats) => {
          discovered.push(mediaRecord(root, filePath, stats));
          scannedFiles += 1;
          if (scannedFiles % CHECKPOINT_EVERY_FILES === 0) {
            const current = await loadState();
            if (current.scan?.id === scanId) {
              current.scan = { ...current.scan, scannedFiles, indexedFiles: state.catalog.length + discovered.length };
              await saveState(current);
            }
          }
        },
        (failedPath, error) => {
          rootHadTraversalErrors = true;
          errors.push({ rootId: root.id, path: failedPath, code: error?.code || 'EIO', message: 'A folder or file could not be read; existing records were preserved for that root.' });
        },
      );
      discoveredByRoot.set(root.id, { records: discovered, preserveExisting: rootHadTraversalErrors });
    }

    const existing = Array.isArray(state.catalog) ? state.catalog : [];
    // Scan modes share one traversal but differ in how records merge:
    // - quick: an unchanged file (same id, size, mtime) keeps its existing
    //   catalog record, so classification and enriched fields survive
    //   routine rescans.
    // - metadata/full: every discovered file gets a freshly rebuilt record
    //   with re-derived classification.
    const existingById = mode === 'quick' ? new Map(existing.map((item) => [item.id, item])) : null;
    const mergeRecord = (record) => {
      const previous = existingById?.get(record.id);
      return previous && previous.sizeBytes === record.sizeBytes && previous.modifiedAtMs === record.modifiedAtMs
        ? { ...previous, available: true, indexedAt: record.indexedAt }
        : record;
    };
    const selectedRootIds = new Set(roots.map((root) => root.id));
    const nextCatalog = existing.filter((item) => !selectedRootIds.has(item.rootId));
    for (const root of roots) {
      const result = discoveredByRoot.get(root.id);
      if (!result) {
        nextCatalog.push(...existing.filter((item) => item.rootId === root.id).map((item) => ({ ...item, available: false })));
        continue;
      }
      if (result.preserveExisting) {
        const discoveredIds = new Set(result.records.map((item) => item.id));
        nextCatalog.push(...existing.filter((item) => item.rootId === root.id && !discoveredIds.has(item.id)).map((item) => ({ ...item, available: false })));
      }
      nextCatalog.push(...result.records.map(mergeRecord));
    }

    const current = await loadState();
    if (current.scan?.id === scanId) {
      current.catalog = nextCatalog;
      current.roots = current.roots.map((root) => {
        if (!selectedRootIds.has(root.id)) return root;
        const wasOffline = offlineRoots.includes(root.id);
        return wasOffline ? root : { ...root, lastScanAt: Date.now() };
      });
      current.scan = {
        ...current.scan,
        state: 'completed',
        completedAt: Date.now(),
        scannedFiles,
        indexedFiles: nextCatalog.length,
        offlineRoots,
        errors: errors.slice(0, 100),
        warning: [
          offlineRoots.length || errors.length ? 'Some files or roots were unavailable. Existing records were preserved.' : null,
          // Classification (movie/episode structure, series grouping) is the
          // metadata this runtime can derive today. Online provider
          // enrichment is still desktop-only, and the scan must say so.
          mode === 'metadata' ? 'File classification was refreshed. Online metadata providers are not available on the headless server yet.' : null,
        ].filter(Boolean).join(' ') || undefined,
      };
      await saveState(current);
    }
    await appendLog(
      errors.length ? 'warn' : 'info',
      `Headless library scan completed: ${scannedFiles} media file${scannedFiles === 1 ? '' : 's'} indexed.`,
      { mode, roots: roots.length, offlineRoots: offlineRoots.length, errors: errors.length },
    );
    return (await loadState()).scan;
  }

  return {
    async listItems() {
      const state = await loadState();
      return Array.isArray(state.catalog) ? state.catalog : [];
    },

    async getItem(itemId) {
      const items = await this.listItems();
      return items.find((item) => item.id === itemId) || null;
    },

    async start(input = {}) {
      if (activeScan) return (await loadState()).scan;
      const state = await loadState();
      const roots = state.roots.filter((root) => !input.rootId || root.id === input.rootId);
      if (input.rootId && roots.length === 0) throw Object.assign(new Error('Library root was not found.'), { status: 404 });
      if (roots.length === 0) throw Object.assign(new Error('Add a library root before scanning.'), { status: 400 });
      const scanId = randomUUID();
      const mode = input.mode || 'quick';
      state.scan = {
        id: scanId,
        state: 'scanning',
        mode,
        rootId: input.rootId,
        startedAt: Date.now(),
        scannedFiles: 0,
        indexedFiles: Array.isArray(state.catalog) ? state.catalog.length : 0,
      };
      await saveState(state);
      activeScan = runScan(scanId, mode, roots)
        .catch(async (error) => {
          await finish(scanId, { state: 'failed', completedAt: Date.now(), error: 'Library scan failed before completion.' });
          await appendLog('error', 'Headless library scan failed.', { error: error instanceof Error ? error.message : String(error) });
          return (await loadState()).scan;
        })
        .finally(() => { activeScan = null; });
      return state.scan;
    },

    async stop() {
      // A scan is deliberately not force-killed: the checkpointed state remains
      // valid and the next scan can safely reconcile the affected roots.
      return (await loadState()).scan;
    },
  };
}
