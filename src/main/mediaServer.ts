import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Socket as NodeSocket } from 'node:net';
import { getImageMimeType, getMimeType, getSubtitleMimeType } from './mimeTypes';
import { appendH264EncoderOptions, findFFmpeg, findFFprobe, preferredH264HardwareEncoder } from './mediaBinaries';
import {
  hasBitmapSubtitleSelection,
  hasSubtitleSelection,
  parseSubtitleStyle,
  queryNumber,
  streamMap,
  subtitleFilterComplex,
  subtitleSelections,
  textSubtitleFilter,
} from './transcodeFilters';
import { parseIntegerTag } from './mediaTags';
import { probeMediaFile } from './mediaProbeFile';
import { srtToVtt } from './libraryItemHelpers';
import { serveHls, startTranscode, stopTranscode } from './transcodeManager';
import { buildEmbeddedSubtitleVttArgs } from './transcodePlan';
import { cachedArtworkResponseHeaders } from './artworkCache';
import { assertLocalMediaPath, probeMedia } from './mediaProbe';
import { trackServerConnections } from './updateInstall';
import {
  backupDatabase,
  getAllProgress,
  getCachedArtwork,
  getCustomArtworkData,
  getProgress,
  importCustomArtwork,
  importProgress,
  saveCustomArtwork,
  saveProgress,
} from './database';
import { getLocalNetworkAddresses, getLocalNetworkName } from './networkInfo';
import { testMetadataKeys } from './metadataKeys';
import type { TranscodeOptions } from './mediaTypes';
import type { AppSettings, LibraryFolderKind, OfficialMetadataCandidate } from '../main';

type MediaServerDeps = typeof import('../main').mediaServerDeps;

let mediaServer: http.Server | null = null;
let mediaServerPort = 3847;
const mediaServerSockets = new Set<NodeSocket>();

export function getMediaServer(): http.Server | null { return mediaServer; }
export function getMediaServerPort(): number { return mediaServerPort; }
export function getMediaServerSockets(): Set<NodeSocket> { return mediaServerSockets; }
export function setMediaServer(server: http.Server | null): void { mediaServer = server; }

function applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse, deps: MediaServerDeps): boolean {
  const { allowedCorsOrigin, ALLOWED_CORS_ORIGINS, LOCAL_ACCESS_HEADER } = deps;
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  const allowedOrigin = allowedCorsOrigin(origin, ALLOWED_CORS_ORIGINS);
  res.setHeader('Vary', 'Origin');
  if (!allowedOrigin) return !origin;

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', `Range, Content-Type, Authorization, ${LOCAL_ACCESS_HEADER}`);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  return true;
}

export function startMediaServer(deps: MediaServerDeps): Promise<number> {
  const {
    LOCAL_ACCESS_TOKEN,
    addFolderToLibrary,
    appendLocalAccessTokenToUrl,
    applyOfficialMetadataCandidate,
    authorizeLanRequest,
    authorizeLocalRequest,
    cacheArtworkNow,
    clearAppData,
    customArtworkForRenderer,
    decodeDataUrl,
    getLanServerBase,
    getLanShareToken,
    getLibraryMutationVersion,
    getOfficialMetadataCandidates,
    getPlaybackLogo,
    handleLanPairRequest,
    isExternalArtworkUrl,
    isImageFileName,
    isLanSharingEnabled,
    isLoopbackRequest,
    isSignedLanRequestValid,
    libraryEtagFor,
    libraryForLocalNetwork,
    libraryForRenderer,
    loadLibrary,
    loadSettings,
    localAccessQuery,
    needsBrowserTranscoding,
    readJsonBody,
    redirectToArtworkSource,
    refreshOfficialArtwork,
    removeFolderFromLibrary,
    requireLocalOrLanAccess,
    requireStreamAccess,
    safeEndResponse,
    safeResult,
    saveLibraryFromScan,
    saveLibraryMutation,
    saveSettings,
    scanLibrary,
    showOpenFolderDialog,
    writeJson,
  } = deps;
  return new Promise((resolve, reject) => {
    const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const corsAllowed = applyCorsHeaders(req, res, deps);

      if (req.method === 'OPTIONS') {
        res.writeHead(corsAllowed ? 204 : 403);
        res.end();
        return;
      }

      const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${mediaServerPort}`);
      const filePath = decodeURIComponent(reqUrl.searchParams.get('path') || '');
      const startSec = parseFloat(reqUrl.searchParams.get('t') || '0');

      if (reqUrl.pathname === '/api/ping') {
        writeJson(res, 200, { ok: true, port: mediaServerPort });
        return;
      }

      if (reqUrl.pathname === '/api/lan/info') {
        const settings = loadSettings();
        writeJson(res, 200, {
          ok: true,
          app: 'LoomTV',
          deviceId: settings.localNetworkDeviceId,
          deviceName: settings.localNetworkDeviceName || os.hostname(),
          sharingEnabled: Boolean(settings.localNetworkSharingEnabled),
          networkName: getLocalNetworkName(),
          port: mediaServerPort,
          addresses: getLocalNetworkAddresses(),
        });
        return;
      }

      if (reqUrl.pathname === '/api/lan/status') {
        if (!isLoopbackRequest(req)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('LAN status is only available on this device.');
          return;
        }

        const settings = loadSettings();
        const token = getLanShareToken();
        const base = getLanServerBase();
        writeJson(res, 200, {
          sharingEnabled: isLanSharingEnabled(),
          token,
          deviceId: settings.localNetworkDeviceId,
          deviceName: settings.localNetworkDeviceName || os.hostname(),
          networkName: getLocalNetworkName(),
          port: mediaServerPort,
          addresses: getLocalNetworkAddresses(),
          baseUrl: base,
          libraryUrl: base ? `${base}/api/lan/library` : null,
          pairedDevices: settings.localNetworkPairedDevices || [],
        });
        return;
      }

      if (reqUrl.pathname === '/api/lan/pair' && req.method === 'POST') {
        handleLanPairRequest(req, res).catch((error) => {
          console.error('[lan/pair] error', error);
          writeJson(res, 500, { error: 'Pairing failed' });
        });
        return;
      }

      if (reqUrl.pathname === '/api/lan/unpair' && req.method === 'POST') {
        if (!requireLocalOrLanAccess(reqUrl, req, res)) return;
        const authResult = authorizeLanRequest(reqUrl, req);
        // Devices may self-revoke; loopback can revoke any device.
        readJsonBody(req)
          .catch((): Record<string, unknown> => ({}))
          .then((body) => {
            const settings = loadSettings();
            const requestedId = String(body?.deviceId || authResult.device?.id || '');
            if (!requestedId) {
              writeJson(res, 400, { error: 'deviceId required' });
              return;
            }
            if (!isLoopbackRequest(req) && authResult.device && authResult.device.id !== requestedId) {
              writeJson(res, 403, { error: 'Cannot revoke other devices' });
              return;
            }
            const remaining = (settings.localNetworkPairedDevices || []).filter((device) => device.id !== requestedId);
            saveSettings({ ...settings, localNetworkPairedDevices: remaining });
            writeJson(res, 200, { ok: true });
          })
          .catch((error) => {
            console.error('[lan/unpair] error', error);
            writeJson(res, 500, { error: 'Unpair failed' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/lan/library') {
        if (!requireLocalOrLanAccess(reqUrl, req, res)) return;
        const payload = libraryForLocalNetwork();
        const etag = `"${libraryEtagFor(payload)}"`;
        const requestEtag = (req.headers['if-none-match'] || '') as string;
        if (requestEtag && requestEtag === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'no-cache');
        writeJson(res, 200, payload);
        return;
      }

      // Stream-like endpoints accept signed LAN URLs.
      const isStreamRoute = reqUrl.pathname === '/stream'
        || reqUrl.pathname === '/subtitle'
        || reqUrl.pathname.startsWith('/hls/');
      const isArtworkRoute = reqUrl.pathname === '/api/cached-artwork'
        || reqUrl.pathname === '/api/local-image'
        || reqUrl.pathname === '/api/thumbnail';
      const hasValidSignature = isLanSharingEnabled() && isSignedLanRequestValid(reqUrl);
      const hasLocalAccess = authorizeLocalRequest(reqUrl, req);
      if (!isStreamRoute && !(isArtworkRoute && (hasLocalAccess || hasValidSignature)) && !requireLocalOrLanAccess(reqUrl, req, res)) return;

      if (reqUrl.pathname === '/api/library' && req.method === 'GET') {
        writeJson(res, 200, libraryForRenderer());
        return;
      }

      if (reqUrl.pathname === '/api/library/scan' && req.method === 'POST') {
        const scanVersion = getLibraryMutationVersion();
        readJsonBody(req)
          .catch((): Record<string, unknown> => ({}))
          .then((body) => scanLibrary(loadLibrary(), {
            force: Boolean(body.force),
            mode: body.mode === 'metadata' || body.mode === 'full' ? body.mode : 'quick',
          }))
          .then(async (scanned) => {
            if (saveLibraryFromScan(scanned, scanVersion)) {
              await cacheArtworkNow(scanned);
            }
            writeJson(res, 200, libraryForRenderer());
          })
          .catch((error) => {
            console.error('scan library API error:', error);
            writeJson(res, 500, { error: 'Failed to scan library' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/library/add-folder' && req.method === 'POST') {
        readJsonBody(req)
          .catch((): Record<string, unknown> => ({}))
          .then((body) => {
            const requestedKind = String(body.kind || '');
            const kind: LibraryFolderKind = requestedKind === 'tvShows' || requestedKind === 'anime' || requestedKind === 'movies' || requestedKind === 'others'
              ? requestedKind
              : 'movies';
            return showOpenFolderDialog({ properties: ['openDirectory'] }).then((result) => ({ result, kind }));
          })
          .then(async (result) => {
            if (result.result.canceled || result.result.filePaths.length === 0) {
              writeJson(res, 200, null);
              return;
            }

            const data = loadLibrary();
            const newFolder = result.result.filePaths[0];
            const updated = addFolderToLibrary(data, newFolder, result.kind);
            saveLibraryMutation(updated);
            const scanVersion = getLibraryMutationVersion();
            const scanned = await scanLibrary(updated, { mode: 'quick' });
            if (saveLibraryFromScan(scanned, scanVersion)) {
              await cacheArtworkNow(scanned);
            }
            writeJson(res, 200, libraryForRenderer());
          })
          .catch((error) => {
            console.error('add folder API error:', error);
            writeJson(res, 500, { error: 'Failed to add folder' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/library/remove-folder' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            const data = loadLibrary();
            const updated = removeFolderFromLibrary(data, String(body.folderPath || ''));
            saveLibraryMutation(updated);
            writeJson(res, 200, libraryForRenderer());
          })
          .catch((error) => {
            console.error('remove folder API error:', error);
            writeJson(res, 500, { error: 'Failed to remove folder' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/settings' && req.method === 'GET') {
        writeJson(res, 200, loadSettings());
        return;
      }

      if (reqUrl.pathname === '/api/settings' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            saveSettings({ ...loadSettings(), ...(body as AppSettings) });
            writeJson(res, 200, { ok: true });
          })
          .catch((error) => {
            console.error('save settings API error:', error);
            writeJson(res, 500, { error: 'Failed to save settings' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/metadata/test-keys' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => testMetadataKeys((body.keys || {}) as Record<string, string>))
          .then((results) => writeJson(res, 200, results))
          .catch((error) => {
            console.error('metadata key test API error:', error);
            writeJson(res, 500, { error: 'Failed to test metadata keys' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/artwork/playback-logo' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => getPlaybackLogo(String(body.mediaId || '')))
          .then((result) => writeJson(res, 200, result))
          .catch((error) => {
            console.error('playback logo API error:', error);
            writeJson(res, 500, { error: 'Failed to fetch playback logo' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/progress' && req.method === 'GET') {
        const requestedPath = reqUrl.searchParams.get('filePath') || '';
        writeJson(res, 200, requestedPath ? getProgress(requestedPath) : getAllProgress());
        return;
      }

      if (reqUrl.pathname === '/api/progress' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            const file = String(body.filePath || '');
            if (!file) {
              writeJson(res, 400, { error: 'filePath is required' });
              return;
            }
            writeJson(res, 200, saveProgress(file, Number(body.position) || 0, Number(body.duration) || 0));
          })
          .catch((error) => {
            console.error('save progress API error:', error);
            writeJson(res, 500, { error: 'Failed to save progress' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/progress/import' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            importProgress((body.progress || {}) as Record<string, number | { position?: number; duration?: number; updatedAt?: number }>);
            writeJson(res, 200, { ok: true });
          })
          .catch((error) => {
            console.error('import progress API error:', error);
            writeJson(res, 500, { error: 'Failed to import progress' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/artwork' && req.method === 'GET') {
        writeJson(res, 200, customArtworkForRenderer(reqUrl.searchParams.get('mediaId') || ''));
        return;
      }

      if (reqUrl.pathname === '/api/artwork' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            saveCustomArtwork(String(body.mediaId || ''), String(body.target || ''), String(body.dataUrl || ''));
            writeJson(res, 200, customArtworkForRenderer(String(body.mediaId || '')));
          })
          .catch((error) => {
            console.error('save artwork API error:', error);
            writeJson(res, 500, { error: 'Failed to save artwork' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/artwork/refresh-official' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => refreshOfficialArtwork(String(body.mediaId || '')))
          .then((artwork) => writeJson(res, 200, artwork))
          .catch((error) => {
            console.error('refresh official artwork API error:', error);
            writeJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to refresh official artwork' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/artwork/official-candidates' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => getOfficialMetadataCandidates(String(body.mediaId || '')))
          .then((candidates) => writeJson(res, 200, candidates))
          .catch((error) => {
            console.error('official metadata candidates API error:', error);
            writeJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to fetch official metadata candidates' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/artwork/apply-official' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => applyOfficialMetadataCandidate(String(body.mediaId || ''), body.candidate as OfficialMetadataCandidate))
          .then((artwork) => writeJson(res, 200, artwork))
          .catch((error) => {
            console.error('apply official metadata API error:', error);
            writeJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to apply official metadata' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/artwork/import' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            importCustomArtwork((body.entries || {}) as Record<string, Record<string, string>>);
            writeJson(res, 200, { ok: true });
          })
          .catch((error) => {
            console.error('import artwork API error:', error);
            writeJson(res, 500, { error: 'Failed to import artwork' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/database/backup' && req.method === 'POST') {
        backupDatabase()
          .then((result) => writeJson(res, result.ok ? 200 : 400, result))
          .catch((error) => {
            console.error('database backup API error:', error);
            writeJson(res, 500, { ok: false, error: 'Failed to back up database' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/database/clear' && req.method === 'POST') {
        try {
          writeJson(res, 200, libraryForRenderer(clearAppData()));
        } catch (error) {
          console.error('database clear API error:', error);
          writeJson(res, 500, { error: 'Failed to clear app data' });
        }
        return;
      }

      if (reqUrl.pathname === '/api/ffmpeg') {
        const ffmpegPath = findFFmpeg();
        writeJson(res, 200, { available: ffmpegPath !== null, path: ffmpegPath });
        return;
      }

      if (reqUrl.pathname === '/api/cached-artwork') {
        const sourceUrl = reqUrl.searchParams.get('source') || '';
        if (!sourceUrl || !isExternalArtworkUrl(sourceUrl)) {
          res.writeHead(400);
          res.end('Invalid artwork source');
          return;
        }

        const cachedArtwork = getCachedArtwork(sourceUrl);
        if (!cachedArtwork) {
          redirectToArtworkSource(res, sourceUrl);
          return;
        }

        if (cachedArtwork.cachePath) {
          res.writeHead(200, cachedArtworkResponseHeaders(
            cachedArtwork.mimeType,
            cachedArtwork.byteLength,
          ));
          const stream = fs.createReadStream(cachedArtwork.cachePath);
          stream.once('error', () => redirectToArtworkSource(res, sourceUrl));
          stream.pipe(res);
          return;
        }

        if (!cachedArtwork.dataUrl) {
          redirectToArtworkSource(res, sourceUrl);
          return;
        }

        const decoded = decodeDataUrl(cachedArtwork.dataUrl);
        if (!decoded) {
          redirectToArtworkSource(res, sourceUrl);
          return;
        }

        res.writeHead(200, cachedArtworkResponseHeaders(
          cachedArtwork.mimeType || decoded.mimeType,
          decoded.buffer.byteLength,
        ));
        res.end(decoded.buffer);
        return;
      }

      if (reqUrl.pathname === '/api/custom-artwork') {
        const mediaId = reqUrl.searchParams.get('mediaId') || '';
        const target = reqUrl.searchParams.get('target') || '';
        const artwork = mediaId && target ? getCustomArtworkData(mediaId, target) : null;
        if (!artwork) {
          res.writeHead(404);
          res.end();
          return;
        }

        const decoded = decodeDataUrl(artwork.dataUrl);
        if (!decoded) {
          res.writeHead(404);
          res.end();
          return;
        }

        res.writeHead(200, {
          ...cachedArtworkResponseHeaders(decoded.mimeType, decoded.buffer.byteLength),
          ETag: `"${createHash('sha1').update(artwork.dataUrl).digest('hex')}"`,
        });
        res.end(decoded.buffer);
        return;
      }

      if (reqUrl.pathname === '/api/local-image') {
        if (!filePath || !isImageFileName(path.basename(filePath)) || !fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end();
          return;
        }

        res.writeHead(200, {
          'Content-Type': getImageMimeType(filePath),
          'Cache-Control': 'public, max-age=3600',
        });
        const stream = fs.createReadStream(filePath);
        stream.once('error', () => safeEndResponse(res));
        stream.pipe(res);
        return;
      }

      if (reqUrl.pathname === '/api/thumbnail') {
        const time = reqUrl.searchParams.get('t') || '00:01:00';
        const embedded = reqUrl.searchParams.get('embedded') === '1';
        const streamIndex = parseIntegerTag(reqUrl.searchParams.get('stream') || undefined);
        const ffmpegPath = findFFmpeg();
        if (!ffmpegPath || !filePath) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        const args = embedded
          ? [
              '-i', filePath,
              ...(streamIndex !== undefined ? ['-map', `0:${streamIndex}`] : ['-map', '0:v:0']),
              '-frames:v', '1',
              '-f', 'image2',
              '-vcodec', 'mjpeg',
              '-q:v', '2',
              'pipe:1',
            ]
          : ['-ss', time, '-i', filePath, '-vframes', '1', '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '2', 'pipe:1'];
        try {
          const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          proc.stdout?.on('error', () => safeEndResponse(res));
          proc.stdout?.pipe(res);
          proc.once('error', (error) => {
            console.error('thumbnail FFmpeg spawn error:', error);
            safeEndResponse(res);
          });
          proc.stderr?.on('data', () => { /* drain stderr so the pipe never stalls */ });
          req.on('close', () => {
            if (!proc.killed) proc.kill('SIGKILL');
          });
        } catch (error) {
          console.error('thumbnail FFmpeg spawn failed:', error);
          safeEndResponse(res);
        }
        return;
      }

      if (reqUrl.pathname === '/api/ffprobe') {
        const ffprobePath = findFFprobe();
        writeJson(res, 200, { available: ffprobePath !== null, path: ffprobePath });
        return;
      }

      if (reqUrl.pathname === '/api/media-server-port') {
        writeJson(res, 200, { port: mediaServerPort });
        return;
      }

      if (reqUrl.pathname === '/api/media/probe' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => safeResult(() => probeMedia(String(body.filePath || ''))))
          .then((result) => writeJson(res, result.ok ? 200 : 400, result))
          .catch((error) => {
            console.error('probe media API error:', error);
            writeJson(res, 500, { ok: false, error: 'Failed to probe media' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/media/start-transcode' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => safeResult(() => startTranscode(
            String(body.filePath || ''),
            (body.options || {}) as TranscodeOptions,
            `http://127.0.0.1:${mediaServerPort}`,
          )))
          .then((result) => result.ok && result.data
            ? { ...result, data: { ...result.data, playlistUrl: appendLocalAccessTokenToUrl(result.data.playlistUrl) } }
            : result)
          .then((result) => writeJson(res, result.ok ? 200 : 400, result))
          .catch((error) => {
            console.error('start transcode API error:', error);
            writeJson(res, 500, { ok: false, error: 'Failed to start transcoding' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/media/stop-transcode' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => safeResult(() => stopTranscode(String(body.sessionId || ''))))
          .then((result) => writeJson(res, result.ok ? 200 : 400, result))
          .catch((error) => {
            console.error('stop transcode API error:', error);
            writeJson(res, 500, { ok: false, error: 'Failed to stop transcoding' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/play-media' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            assertLocalMediaPath(String(body.filePath || ''));
            writeJson(res, 200, {
              ok: false,
              error: 'Direct external playback is disabled. Use the in-app player.',
            });
          })
          .catch((error) => {
            console.error('play media API error:', error);
            writeJson(res, 400, { ok: false, error: 'Invalid media path.' });
          });
        return;
      }

      if (reqUrl.pathname === '/subtitle') {
        if (!requireStreamAccess(reqUrl, req, res)) return;

        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const streamOrdinal = queryNumber(reqUrl.searchParams.get('streamOrdinal'));
        if (typeof streamOrdinal === 'number' && streamOrdinal >= 0) {
          const ffmpegPath = findFFmpeg();
          if (!ffmpegPath) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('FFmpeg is not available');
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'text/vtt; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          try {
            const proc = spawn(ffmpegPath, buildEmbeddedSubtitleVttArgs(filePath, streamOrdinal), { stdio: ['ignore', 'pipe', 'pipe'] });
            proc.stdout?.on('error', () => safeEndResponse(res));
            proc.stdout?.pipe(res);
            proc.once('error', (error) => {
              console.error('subtitle FFmpeg spawn error:', error);
              safeEndResponse(res);
            });
            proc.stderr?.on('data', () => { /* drain stderr so the pipe never stalls */ });
            req.on('close', () => {
              if (!proc.killed) proc.kill('SIGKILL');
            });
          } catch (error) {
            console.error('subtitle FFmpeg spawn failed:', error);
            safeEndResponse(res);
          }
          return;
        }

        try {
          const ext = path.extname(filePath).toLowerCase();
          const body = fs.readFileSync(filePath, 'utf-8');
          res.writeHead(200, {
            'Content-Type': ext === '.srt' ? 'text/vtt; charset=utf-8' : getSubtitleMimeType(filePath),
            'Cache-Control': 'no-store',
          });
          res.end(ext === '.srt' ? srtToVtt(body) : body);
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Could not read subtitle');
        }
        return;
      }

      if (reqUrl.pathname.startsWith('/hls/') && !requireStreamAccess(reqUrl, req, res)) return;
      if (serveHls(reqUrl, res, localAccessQuery(LOCAL_ACCESS_TOKEN))) return;

      if (reqUrl.pathname !== '/stream') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      if (!requireStreamAccess(reqUrl, req, res)) return;

      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const ffmpegPath = findFFmpeg();
      const streamOptions: TranscodeOptions = {
        startSeconds: Number.isFinite(startSec) && startSec > 0 ? startSec : undefined,
        videoTrackIndex: queryNumber(reqUrl.searchParams.get('video')),
        audioTrackIndex: queryNumber(reqUrl.searchParams.get('audio')),
        subtitleTrackIndex: queryNumber(reqUrl.searchParams.get('subtitle')),
        subtitleStreamOrdinal: queryNumber(reqUrl.searchParams.get('subtitleOrdinal')),
        subtitleCodec: reqUrl.searchParams.get('subtitleCodec') || undefined,
        secondarySubtitleTrackIndex: queryNumber(reqUrl.searchParams.get('secondarySubtitle')),
        secondarySubtitleStreamOrdinal: queryNumber(reqUrl.searchParams.get('secondarySubtitleOrdinal')),
        secondarySubtitleCodec: reqUrl.searchParams.get('secondarySubtitleCodec') || undefined,
        subtitleStyle: parseSubtitleStyle(reqUrl.searchParams.get('subtitleStyle')),
        forceTranscode: reqUrl.searchParams.get('forceTranscode') === '1',
      };
      const hasSelectedTracks = typeof streamOptions.videoTrackIndex === 'number'
        || typeof streamOptions.audioTrackIndex === 'number'
        || typeof streamOptions.subtitleTrackIndex === 'number'
        || typeof streamOptions.secondarySubtitleTrackIndex === 'number';

      if ((streamOptions.forceTranscode || hasSelectedTracks || needsBrowserTranscoding(filePath)) && ffmpegPath) {
        // ── Smart remux/transcode ────────────────────────────────────────────
        // Probe to decide what actually needs re-encoding vs what can be copied.
        // Copying streams is nearly instant (just remux); re-encoding is slow.
        const probe = probeMediaFile(filePath);
        const videoCodec = (probe.localMetadata?.videoCodec || '').toLowerCase();
        const videoProfile = (probe.localMetadata?.videoProfile || '').toLowerCase();
        const pixelFormat = (probe.localMetadata?.pixelFormat || '').toLowerCase();
        const audioCodec = (probe.localMetadata?.audioCodec || '').toLowerCase();

        // Keep browser-safe streams; everything else becomes H264/AAC.
        const hasSubtitle = hasSubtitleSelection(streamOptions);
        const bitmapSubtitle = hasBitmapSubtitleSelection(streamOptions);
        const copyVideo = !hasSubtitle
          && videoCodec === 'h264'
          && pixelFormat === 'yuv420p'
          && !videoProfile.includes('10');
        const copyAudio = audioCodec === 'aac' || audioCodec === 'mp3';
        const hardwareEncoder = copyVideo ? null : preferredH264HardwareEncoder(ffmpegPath);

        console.log(`[stream] ${path.basename(filePath)} | video:${videoCodec}/${pixelFormat || 'unknown'}(${copyVideo ? 'copy' : hardwareEncoder || 'libx264'}) audio:${audioCodec}(${copyAudio ? 'copy' : 'encode'})`);

        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Transfer-Encoding': 'chunked',
          'X-Video-Codec': videoCodec,
          'X-Audio-Codec': audioCodec,
        });

        const args: string[] = ['-nostdin'];
        if (typeof streamOptions.startSeconds === 'number' && streamOptions.startSeconds > 0) {
          args.push('-ss', String(Math.floor(streamOptions.startSeconds)));
        }
        args.push('-i', filePath);

        if (hasSubtitle && bitmapSubtitle) {
          const subtitleFilter = subtitleFilterComplex(filePath, streamOptions);
          args.push('-filter_complex', subtitleFilter.filter, '-map', `[${subtitleFilter.output}]`);
        } else {
          args.push('-map', streamMap('v', streamOptions.videoTrackIndex));
        }

        if (streamOptions.audioTrackIndex !== -1) {
          args.push('-map', streamMap('a', streamOptions.audioTrackIndex, true));
        }

        args.push('-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1');

        if (hasSubtitle && !bitmapSubtitle) {
          const textSelections = subtitleSelections(streamOptions);
          const primarySubtitle = textSelections.find((selection) => selection.placement === 'primary') || textSelections[0];
          const secondarySubtitle = textSelections.find((selection) => selection !== primarySubtitle);
          args.push('-vf', textSubtitleFilter(
            filePath,
            primarySubtitle.streamOrdinal,
            streamOptions.subtitleStyle,
            streamOptions.startSeconds,
            secondarySubtitle?.streamOrdinal,
          ));
        } else if (!copyVideo && !bitmapSubtitle) {
          args.push('-vf', 'format=yuv420p');
        }

        args.push('-c:v', copyVideo ? 'copy' : hardwareEncoder || 'libx264');
        if (hardwareEncoder) {
          appendH264EncoderOptions(args, hardwareEncoder);
        } else if (!copyVideo) {
          args.push('-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'main');
        }

        if (streamOptions.audioTrackIndex === -1) {
          args.push('-an');
        } else {
          args.push('-c:a', copyAudio ? 'copy' : 'aac');
          if (!copyAudio) args.push('-b:a', '192k', '-ac', '2');
        }

        args.push(
          '-f', 'mp4',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          'pipe:1',
        );

        try {
          const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          proc.stdout?.on('error', () => safeEndResponse(res));
          proc.stdout?.pipe(res);
          req.on('close', () => {
            if (!proc.killed) proc.kill('SIGKILL');
          });
          proc.stderr?.on('data', (d: Buffer) => console.log('[ffmpeg]', d.toString().trim().split('\n').pop()));
          proc.once('error', (err) => {
            console.error('FFmpeg spawn error:', err);
            safeEndResponse(res);
          });
          proc.once('exit', (code) => {
            if (code !== 0 && code !== null) console.warn(`[ffmpeg] exited with code ${code}`);
            safeEndResponse(res);
          });
        } catch (error) {
          console.error('FFmpeg spawn failed:', error);
          safeEndResponse(res);
        }
      } else {
        // Direct streaming with range request support (essential for seeking)
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          res.writeHead(500);
          res.end();
          return;
        }

        const fileSize = stat.size;
        const mimeType = getMimeType(filePath);
        const range = req.headers.range;

        if (range) {
          const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
          const start = parseInt(startStr, 10);
          const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
          const chunkSize = end - start + 1;

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mimeType,
          });

          const stream = fs.createReadStream(filePath, { start, end });
          stream.pipe(res);
          req.on('close', () => stream.destroy());
        } else {
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Accept-Ranges': 'bytes',
            'Content-Type': mimeType,
          });

          const stream = fs.createReadStream(filePath);
          stream.pipe(res);
          req.on('close', () => stream.destroy());
        }
      }
    };

    const server = http.createServer(requestHandler);
    mediaServer = server;
    trackServerConnections(server, mediaServerSockets);

    const tryListen = (port: number) => {
      server.listen(port, '0.0.0.0', () => {
        mediaServerPort = port;
        console.log(`Media server on port ${port}`);
        resolve(port);
      });
    };

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        tryListen(mediaServerPort + 1);
      } else {
        reject(err);
      }
    });

    tryListen(mediaServerPort);
  });
}
