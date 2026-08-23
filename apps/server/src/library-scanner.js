import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { classifyVideoFile, createMediaItemId, isVideoFilePath } from '@loom-media-server/media-core';
import { isPathWithin } from './media-path-guard.js';
const CHECKPOINT_EVERY_FILES = 50;
const SUBTITLE_FORMATS = Object.freeze({ '.srt': 'subrip', '.vtt': 'webvtt', '.ass': 'ass', '.ssa': 'ssa' });

async function subtitleSidecarsFor(entries, videoPath) {
  const directory = path.dirname(videoPath);
  const videoBase = path.basename(videoPath, path.extname(videoPath));
  const candidates = entries.filter((entry) => entry.isFile()).flatMap((entry) => {
    const extension = path.extname(entry.name).toLowerCase();
    const codec = SUBTITLE_FORMATS[extension];
    const stem = path.basename(entry.name, extension);
    if (!codec || (stem !== videoBase && !stem.startsWith(`${videoBase}.`))) return [];
    const suffix = stem === videoBase ? [] : stem.slice(videoBase.length + 1).split('.').filter(Boolean);
    const forced = suffix.some((part) => part.toLowerCase() === 'forced');
    const defaultTrack = suffix.some((part) => ['default', 'sdh'].includes(part.toLowerCase()));
    const language = suffix.find((part) => /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/.test(part));
    const sidecarPath = path.join(directory, entry.name);
    return [{
      id: `sidecar:${createHash('sha256').update(sidecarPath).digest('hex').slice(0, 24)}`,
      path: sidecarPath,
      relativeName: entry.name.slice(0, 500),
      format: extension.slice(1), codec,
      ...(language ? { language: language.toLowerCase() } : {}),
      title: suffix.filter((part) => !['forced','default'].includes(part.toLowerCase()) && part !== language).join(' ').slice(0, 200) || undefined,
      forced,
      default: defaultTrack,
      origin: 'local',
    }];
  });
  const sidecars = [];
  for (const candidate of candidates.slice(0, 64)) {
    const stats = await fs.stat(candidate.path).catch(() => null);
    if (stats?.isFile()) sidecars.push({ ...candidate, sizeBytes: stats.size, modifiedAtMs: stats.mtimeMs });
  }
  return sidecars;
}

function scanCancelledError() {
  return Object.assign(new Error('The library scan was cancelled.'), { code: 'scan_cancelled' });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw scanCancelledError();
}

function mediaRecord(root, filePath, stats, subtitleSidecars = []) {
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
    // Keep the hosted client’s coarse card model in sync with the richer
    // classifier vocabulary used by the series endpoint.
    type: classification.kind === 'episode' ? 'tv' : 'movie',
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
    ...(subtitleSidecars.length ? { subtitleSidecars } : {}),
  };
}

/**
 * Walk the root for video files without ever leaving it.
 *
 * `readdir` Dirents carry lstat semantics, so a symlinked file or directory is
 * neither indexed nor descended into and the catalog cannot acquire an entry
 * that points outside the root in the first place. `containmentRoot` adds the
 * second half of that guarantee: every path handed to `onFile` is checked
 * against the root's canonical path, so a directory replaced mid-scan cannot
 * smuggle an entry into the catalog either.
 */
async function walkVideoFiles(rootPath, containmentRoot, onFile, onError, { signal } = {}) {
  const pending = [rootPath];
  while (pending.length > 0) {
    throwIfAborted(signal);
    const current = pending.pop();
    // One canonicalization per directory rather than per file: the Dirent
    // filter already rules out symlinked files, so a directory that resolves
    // outside the root is the only way a discovered path can escape.
    const currentReal = await fs.realpath(current).catch(() => null);
    if (currentReal === null || !isPathWithin(containmentRoot, currentReal)) {
      onError(current, Object.assign(new Error('Directory escapes its library root.'), { code: 'EESCAPE' }));
      continue;
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      onError(current, error);
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !isVideoFilePath(entry.name)) continue;
      try {
        throwIfAborted(signal);
        await onFile(fullPath, await fs.stat(fullPath), await subtitleSidecarsFor(entries, fullPath));
      } catch (error) {
        if (error?.code === 'scan_cancelled') throw error;
        onError(fullPath, error);
      }
    }
  }
}

export function createHeadlessLibraryScanner({ loadState, saveState, appendLog, probeMedia = null }) {
  let activeScan = null;

  async function finish(scanId, update) {
    const state = await loadState();
    if (state.scan?.id !== scanId) return state.scan;
    state.scan = { ...state.scan, ...update };
    await saveState(state);
    return state.scan;
  }

  async function runScan(scanId, mode, roots, signal) {
    const state = await loadState();
    const existing = Array.isArray(state.catalog) ? state.catalog : [];
    const existingById = new Map(existing.map((item) => [item.id, item]));
    const discoveredByRoot = new Map();
    const errors = [];
    const offlineRoots = [];
    let scannedFiles = 0;

    for (const root of roots) {
      throwIfAborted(signal);
      let rootReal;
      try {
        rootReal = await fs.realpath(root.path);
        const rootStat = await fs.stat(rootReal);
        if (!rootStat.isDirectory()) throw Object.assign(new Error('Path is not a directory.'), { code: 'ENOTDIR' });
        await fs.access(rootReal);
      } catch (error) {
        offlineRoots.push(root.id);
        // Scan status is readable by any account holding library.read, so the
        // reported path stays root-relative. The root itself is identified by
        // rootId, which the caller is already allowed to see.
        errors.push({ rootId: root.id, path: '.', code: error?.code || 'EUNAVAILABLE', message: 'Library root is unavailable; existing records were preserved.' });
        continue;
      }

      const discovered = [];
      let rootHadTraversalErrors = false;
      await walkVideoFiles(
        root.path,
        rootReal,
        async (filePath, stats, subtitleSidecars) => {
          throwIfAborted(signal);
          const record = mediaRecord(root, filePath, stats, subtitleSidecars);
          record.sourceId = `${record.id}:primary`;
          const previous = existingById.get(record.id);
          const sameFileIdentity = previous?.sizeBytes === record.sizeBytes
            && previous?.modifiedAtMs === record.modifiedAtMs;
          const unchangedProbe = mode === 'quick'
            && sameFileIdentity
            && Array.isArray(previous?.localMetadata?.tracks);
          if (unchangedProbe) {
            record.localMetadata = previous.localMetadata;
          } else if (probeMedia) {
            try {
              const probe = await probeMedia(filePath, { sourceId: record.sourceId, signal });
              if (probe && Array.isArray(probe.tracks)) record.localMetadata = probe;
              else if (sameFileIdentity && Array.isArray(previous?.localMetadata?.tracks)) {
                record.localMetadata = previous.localMetadata;
              }
            } catch (error) {
              if (error?.code === 'scan_cancelled' || signal?.aborted) throw scanCancelledError();
              if (sameFileIdentity && Array.isArray(previous?.localMetadata?.tracks)) {
                record.localMetadata = previous.localMetadata;
              }
              const relative = path.relative(root.path, filePath);
              errors.push({
                rootId: root.id,
                path: !relative || relative.startsWith('..') || path.isAbsolute(relative) ? path.basename(filePath) : relative,
                code: error?.code || 'EPROBE',
                message: 'Media analysis failed; the file was indexed and can be analysed later.',
              });
            }
          }
          discovered.push(record);
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
          if (error?.code === 'scan_cancelled') return;
          rootHadTraversalErrors = true;
          const relative = path.relative(root.path, failedPath);
          errors.push({
            rootId: root.id,
            path: !relative || relative.startsWith('..') || path.isAbsolute(relative) ? path.basename(failedPath) : relative,
            code: error?.code || 'EIO',
            message: 'A folder or file could not be read; existing records were preserved for that root.',
          });
        },
        { signal },
      );
      throwIfAborted(signal);
      discoveredByRoot.set(root.id, { records: discovered, preserveExisting: rootHadTraversalErrors });
    }

    // Scan modes share one traversal but differ in how records merge:
    // - quick: an unchanged file (same id, size, mtime) keeps its existing
    //   catalog record, so classification and enriched fields survive
    //   routine rescans.
    // - metadata/full: every discovered file gets a freshly rebuilt record
    //   with re-derived classification.
    const mergeRecord = (record) => {
      const previous = mode === 'quick' ? existingById.get(record.id) : null;
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
    throwIfAborted(signal);
    if (current.scan?.id === scanId) {
      const completedState = {
        ...current,
        catalog: nextCatalog,
        roots: current.roots.map((root) => {
          if (!selectedRootIds.has(root.id)) return root;
          const wasOffline = offlineRoots.includes(root.id);
          return wasOffline ? root : { ...root, lastScanAt: Date.now() };
        }),
        scan: {
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
        },
      };
      // Do not expose a completed scan through the shared in-memory state
      // until its catalog has reached disk. Slower Windows filesystem writes
      // otherwise let status observers race ahead of durable persistence.
      await saveState(completedState);
      Object.assign(current, completedState);
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
      const controller = new AbortController();
      const promise = runScan(scanId, mode, roots, controller.signal)
        .catch(async (error) => {
          if (error?.code === 'scan_cancelled') {
            await finish(scanId, { state: 'interrupted', completedAt: Date.now(), warning: 'The scan was interrupted during server shutdown; the existing catalog was preserved.' });
            return (await loadState()).scan;
          }
          await finish(scanId, { state: 'failed', completedAt: Date.now(), error: 'Library scan failed before completion.' });
          await appendLog('error', 'Headless library scan failed.', { error: error instanceof Error ? error.message : String(error) });
          return (await loadState()).scan;
        })
        .finally(() => {
          if (activeScan?.promise === promise) activeScan = null;
        });
      activeScan = { controller, promise };
      return state.scan;
    },

    async stop() {
      if (activeScan) {
        activeScan.controller.abort();
        await activeScan.promise;
      }
      return (await loadState()).scan;
    },
  };
}
