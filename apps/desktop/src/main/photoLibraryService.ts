import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createPhotoRepository, type PhotoDirectory, type PhotoRecord } from './databasePhotoRepository.ts';
import { getPhotoDatabase } from './database.ts';
import { findFFmpeg } from './mediaBinaries.ts';
import { PHOTO_EXTENSIONS } from './photoLibraryScanner.ts';
import { getDesktopActiveProfileState, requireOwner } from './profileService.ts';
import type { PhotoBrowseRequest, PhotoLibraryApi, PhotoRoot } from '../shared/photoLibrary.ts';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CATALOG_PHOTOS = 100_000;
const MAX_CATALOG_DIRECTORIES = 50_000;
const MAX_SCAN_DEPTH = 64;
const MAX_IMAGE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_QUEUE = 160;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const photoCacheDirectory = () => path.join(app.getPath('userData'), 'cache', 'photos');

type ScanJob = { cancelled: boolean; discovered: number };

function isInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== ''
    && !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`);
}

function ownerSession(): string {
  const owner = requireOwner();
  return `${owner.id}:${getDesktopActiveProfileState().selectionRevision}`;
}

function requireOwnerSession(expected: string): void {
  if (ownerSession() !== expected) throw new Error('The active profile changed. Open Photos again.');
}

export type PhotoLibraryService = PhotoLibraryApi & {
  imageResponse: (request: Request) => Promise<Response>;
};

export function createPhotoLibraryService(chooseFolder: () => Promise<string | null>): PhotoLibraryService {
  const repository = () => createPhotoRepository(getPhotoDatabase());
  const scanJobs = new Map<string, ScanJob>();
  const currentMessages = new Map<string, string>();
  const imageJobs = new Map<string, Promise<Buffer>>();
  const imageQueue: Array<() => void> = [];
  let activeImageWorkers = 0;
  let lastCacheCleanup = 0;

  function rootViews(): PhotoRoot[] {
    ownerSession();
    return repository().roots().map((root) => ({
      ...root,
      scanning: scanJobs.has(root.id),
      discovered: scanJobs.get(root.id)?.discovered ?? root.count,
      message: currentMessages.get(root.id) ?? root.message,
    }));
  }

  async function scanRoot(rootId: string, job: ScanJob): Promise<void> {
    const root = repository().root(rootId);
    if (!root) return;
    const photos: PhotoRecord[] = [];
    const directories: PhotoDirectory[] = [];

    const checkLimits = () => {
      if (job.cancelled) throw new Error('Scan cancelled. The previous photo catalog was kept.');
      if (photos.length > MAX_CATALOG_PHOTOS || directories.length > MAX_CATALOG_DIRECTORIES) {
        throw new Error('This photo folder exceeds the current scan limit. Add smaller folders instead.');
      }
    };

    const walk = async (folderPath: string, relativeFolder: string, depth: number): Promise<void> => {
      checkLimits();
      if (depth > MAX_SCAN_DEPTH) throw new Error('This folder structure is too deep to scan.');
      const resolvedFolder = await fs.realpath(folderPath);
      if (resolvedFolder !== root.path && !isInside(root.path, resolvedFolder)) {
        throw new Error('A folder points outside the configured photo library.');
      }
      const directory = await fs.opendir(folderPath);
      for await (const entry of directory) {
        checkLimits();
        if (entry.isSymbolicLink()) continue;
        const relativePath = relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name;
        const absolutePath = path.join(folderPath, entry.name);
        if (entry.isDirectory()) {
          directories.push({ relativePath, parent: relativeFolder, name: entry.name });
          await walk(absolutePath, relativePath, depth + 1);
          continue;
        }
        if (!entry.isFile() || !PHOTO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const stat = await fs.lstat(absolutePath);
        if (!stat.isFile()) continue;
        photos.push({
          id: digest(`${rootId}\0${relativePath}`),
          rootId,
          relativePath,
          parent: relativeFolder,
          name: entry.name,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        });
        job.discovered = photos.length;
      }
    };

    try {
      if (await fs.realpath(root.path) !== root.path) {
        throw new Error('The photo folder location changed. Remove it and add it again.');
      }
      await walk(root.path, '', 0);
      checkLimits();
      await fs.access(root.path);
      repository().commitScan(rootId, photos, directories);
      currentMessages.delete(rootId);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'The folder could not be read. The previous photo catalog was kept.';
      currentMessages.set(rootId, message);
      if (!job.cancelled) repository().markUnavailable(rootId, message);
    } finally {
      scanJobs.delete(rootId);
    }
  }

  async function trimPreviewCache(): Promise<void> {
    if (Date.now() - lastCacheCleanup < 60_000) return;
    lastCacheCleanup = Date.now();
    const cachePath = photoCacheDirectory();
    const names = await fs.readdir(cachePath).catch(() => []);
    const files: Array<{ path: string; size: number; modifiedAt: number }> = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.jpg$/.test(name)) continue;
      const filePath = path.join(cachePath, name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat?.isFile()) files.push({ path: filePath, size: stat.size, modifiedAt: stat.mtimeMs });
    }
    let totalBytes = files.reduce((total, file) => total + file.size, 0);
    files.sort((a, b) => a.modifiedAt - b.modifiedAt);
    for (const file of files) {
      if (totalBytes <= MAX_CACHE_BYTES) break;
      await fs.unlink(file.path).catch(() => undefined);
      totalBytes -= file.size;
    }
  }

  async function renderImage(photo: PhotoRecord, variant: 'thumb' | 'view'): Promise<Buffer> {
    const root = repository().root(photo.rootId);
    if (!root) throw new Error('Photo library was removed.');
    if (await fs.realpath(root.path) !== root.path) throw new Error('Photo folder is unavailable.');
    const requestedPath = path.join(root.path, ...photo.relativePath.split('/'));
    const filePath = await fs.realpath(requestedPath);
    if (!isInside(root.path, filePath)) throw new Error('Photo is outside the configured library.');
    const file = await fs.open(filePath, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('This photo exceeds the 64 MB preview limit.');
      const currentPath = await fs.realpath(requestedPath);
      const current = await fs.stat(currentPath);
      if (!isInside(root.path, currentPath) || current.dev !== stat.dev || current.ino !== stat.ino) {
        throw new Error('Photo changed while opening.');
      }
      const cacheKey = digest(`photo-v1:${photo.id}:${stat.size}:${stat.mtimeMs}:${variant}`);
      const destination = path.join(photoCacheDirectory(), `${cacheKey}.jpg`);
      const cached = await fs.readFile(destination).catch(() => null);
      if (cached) return cached;
      const ffmpeg = findFFmpeg();
      if (!ffmpeg) throw new Error('FFmpeg is required to create photo previews.');
      const longestSide = variant === 'thumb' ? 480 : 2560;
      const data = await new Promise<Buffer>((resolve, reject) => {
        const decoder = spawn(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-max_alloc', '134217728', '-threads', '1',
          '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-map', '0:v:0', '-frames:v', '1',
          '-vf', `scale=${longestSide}:${longestSide}:force_original_aspect_ratio=decrease`,
          '-map_metadata', '-1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
        ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        const chunks: Buffer[] = [];
        let outputBytes = 0;
        let failure: Error | null = null;
        const source = file.createReadStream({ autoClose: false, start: 0, end: Math.max(0, stat.size - 1) });
        const fail = (message: string) => {
          failure = new Error(message);
          decoder.kill('SIGKILL');
        };
        const timeout = setTimeout(() => fail('Photo preview took too long.'), 20_000);
        source.on('error', () => fail('Photo could not be read.'));
        decoder.stdin.on('error', () => undefined);
        decoder.stdout.on('data', (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > MAX_IMAGE_OUTPUT_BYTES) fail('Photo preview exceeded the output limit.');
          else chunks.push(chunk);
        });
        decoder.on('error', () => {
          clearTimeout(timeout);
          source.destroy();
          reject(new Error('Photo decoder could not start.'));
        });
        decoder.on('close', (code) => {
          clearTimeout(timeout);
          source.destroy();
          if (failure || code !== 0 || outputBytes === 0) reject(failure ?? new Error('This photo could not be decoded.'));
          else resolve(Buffer.concat(chunks));
        });
        source.pipe(decoder.stdin);
      });
      await fs.mkdir(photoCacheDirectory(), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, data);
      await fs.rename(temporary, destination).catch(async (error) => {
        await fs.unlink(temporary).catch(() => undefined);
        throw error;
      });
      void trimPreviewCache().catch(() => undefined);
      return data;
    } finally {
      await file.close();
    }
  }

  function imageUrl(photoId: string, variant: 'thumb' | 'view', session: string): string {
    return `loomtv://photos/${photoId}/${variant}?session=${encodeURIComponent(session)}`;
  }

  return {
    roots: async () => rootViews(),
    async add(folderPath?: string) {
      const session = ownerSession();
      const selectedFolder = folderPath || await chooseFolder();
      requireOwnerSession(session);
      if (!selectedFolder) return null;
      const folder = await fs.realpath(selectedFolder);
      if (!(await fs.stat(folder)).isDirectory()) throw new Error('Choose a folder.');
      requireOwnerSession(session);
      const existing = repository().roots().find((root) => root.path === folder);
      const root = repository().add(existing?.id ?? randomUUID(), folder, path.basename(folder) || folder);
      return rootViews().find((entry) => entry.id === root.id) ?? null;
    },
    async remove(rootId) {
      ownerSession();
      if (scanJobs.has(rootId)) throw new Error('Cancel the scan before removing this folder.');
      repository().remove(rootId);
      currentMessages.delete(rootId);
    },
    async scan(rootId) {
      ownerSession();
      if (!repository().root(rootId)) throw new Error('Photo folder was not found.');
      if (scanJobs.has(rootId)) return;
      if (scanJobs.size >= 1) throw new Error('Wait for the current photo scan to finish.');
      const job = { cancelled: false, discovered: 0 };
      scanJobs.set(rootId, job);
      currentMessages.delete(rootId);
      void scanRoot(rootId, job);
    },
    async cancel(rootId) {
      ownerSession();
      const job = scanJobs.get(rootId);
      if (job) job.cancelled = true;
    },
    async browse(request: PhotoBrowseRequest) {
      const session = ownerSession();
      if (request.folder !== null && !request.rootId) throw new Error('Select a photo library before opening a folder.');
      const result = repository().browse(request);
      return {
        entries: result.rows.map(({ coverId, ...entry }) => ({
          ...entry,
          imageUrl: coverId ? imageUrl(coverId, 'thumb', session) : null,
        })),
        total: result.total,
        offset: result.offset,
        pageSize: result.pageSize,
      };
    },
    async read(photoId) {
      const session = ownerSession();
      if (!repository().photo(photoId)) throw new Error('Photo not found.');
      return imageUrl(photoId, 'view', session);
    },
    async imageResponse(request) {
      try {
        const url = new URL(request.url);
        const session = url.searchParams.get('session') ?? '';
        requireOwnerSession(session);
        const match = /^\/([a-f0-9]{64})\/(thumb|view)$/.exec(url.pathname);
        if (request.method !== 'GET' || !match) return new Response(null, { status: 404 });
        const photo = repository().photo(match[1]);
        if (!photo) return new Response(null, { status: 404 });
        const jobKey = `${session}:${match[1]}:${match[2]}`;
        let job = imageJobs.get(jobKey);
        if (!job) {
          if (imageQueue.length >= MAX_IMAGE_QUEUE) return new Response(null, { status: 429 });
          job = (async () => {
            if (activeImageWorkers >= 2) await new Promise<void>((resolve) => imageQueue.push(resolve));
            else activeImageWorkers += 1;
            try {
              requireOwnerSession(session);
              return await renderImage(photo, match[2] as 'thumb' | 'view');
            } finally {
              const next = imageQueue.shift();
              if (next) next();
              else activeImageWorkers -= 1;
            }
          })();
          imageJobs.set(jobKey, job);
        }
        try {
          const bytes = await job;
          requireOwnerSession(session);
          if (!repository().photo(photo.id)) return new Response(null, { status: 404 });
          return new Response(new Uint8Array(bytes), {
            headers: {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            },
          });
        } finally {
          imageJobs.delete(jobKey);
        }
      } catch {
        return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
      }
    },
  };
}
