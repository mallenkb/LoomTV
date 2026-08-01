import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHeadlessServer, readServerVersion } from './server.js';
import { resolveRuntimePaths } from '@loom-media-server/runtime-paths';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `Usage: loomtv-server [options]

Starts the LoomTV headless HTTP service. The service exposes the runtime
health contract, authenticated administration, catalog scanning, direct media
delivery, and on-demand HLS transcoding without Electron.

Options:
  --host <address>       Bind address (default: HOST or 127.0.0.1)
  --port <number>        Bind port (default: PORT or 3847)
  --data-dir <path>      Persistent application data directory
  --cache-dir <path>     Cache directory
  --media-dir <path>     Optional media root (may be offline at startup)
  --ffmpeg-path <path>   FFmpeg executable used for transcoding probes
  --require-secure-transport  Reject admin and credential requests over HTTP
  --trust-proxy           Trust X-Forwarded-Proto from a TLS reverse proxy
  --help                 Show this help

Environment aliases:
  HOST / LOOMTV_HOST, PORT / LOOMTV_PORT,
  DATA_DIR / LOOMTV_DATA_DIR, CACHE_DIR / LOOMTV_CACHE_DIR,
  MEDIA_DIR / LOOMTV_MEDIA_DIR, FFMPEG_PATH / LOOMTV_FFMPEG_PATH,
  REQUIRE_SECURE_TRANSPORT / LOOMTV_REQUIRE_SECURE_TRANSPORT,
  TRUST_PROXY / LOOMTV_TRUST_PROXY
`;

function usageError(message) {
  const error = new Error(`${message}\n\n${HELP}`);
  error.code = 'USAGE';
  return error;
}

function readOptionValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw usageError(`${option} requires a value.`);
  return value;
}

function parsePort(value, source) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw usageError(`${source} must be an integer between 0 and 65535.`);
  }
  return port;
}

function readEnvironmentValue(shortName, longName) {
  const shortValue = process.env[shortName]?.trim();
  if (shortValue) return shortValue;
  const longValue = process.env[longName]?.trim();
  return longValue || undefined;
}

function parseBoolean(value, source) {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw usageError(`${source} must be true or false when a value is provided.`);
}

function parseArgs(args) {
  const values = {};
  const booleanOptions = new Set(['--require-secure-transport', '--trust-proxy']);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    const equalsIndex = argument.indexOf('=');
    const name = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
    const inlineValue = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : undefined;
    if (![ '--host', '--port', '--data-dir', '--cache-dir', '--media-dir', '--ffmpeg-path', ...booleanOptions ].includes(name)) {
      throw usageError(`Unknown option: ${argument}`);
    }
    if (booleanOptions.has(name)) {
      values[name.slice(2).replaceAll('-', '')] = parseBoolean(inlineValue, name);
      continue;
    }
    const value = inlineValue ?? readOptionValue(args, index++, name);
    if (!value.trim()) throw usageError(`${name} requires a non-empty value.`);
    values[name.slice(2).replaceAll('-', '')] = value;
  }
  return values;
}

async function ensureRuntimeDirectories(paths) {
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.cacheDir, { recursive: true });
}

function buildConfig(cliValues) {
  const host = cliValues.host
    || readEnvironmentValue('HOST', 'LOOMTV_HOST')
    || '127.0.0.1';
  const port = parsePort(
    cliValues.port || readEnvironmentValue('PORT', 'LOOMTV_PORT') || '3847',
    'Port',
  );
  const paths = resolveRuntimePaths({
    dataDir: cliValues.datadir,
    cacheDir: cliValues.cachedir,
    mediaDir: cliValues.mediadir,
  });
  const ffmpegPath = cliValues.ffmpegpath
    || readEnvironmentValue('FFMPEG_PATH', 'LOOMTV_FFMPEG_PATH');
  const requireSecureTransport = cliValues.requiresecuretransport !== undefined
    ? cliValues.requiresecuretransport
    : ['1', 'true', 'yes'].includes((readEnvironmentValue('REQUIRE_SECURE_TRANSPORT', 'LOOMTV_REQUIRE_SECURE_TRANSPORT') || '').toLowerCase());
  const trustProxy = cliValues.trustproxy !== undefined
    ? cliValues.trustproxy
    : ['1', 'true', 'yes'].includes((readEnvironmentValue('TRUST_PROXY', 'LOOMTV_TRUST_PROXY') || '').toLowerCase());
  return { host, port, paths, ffmpegPath, requireSecureTransport, trustProxy };
}

async function run() {
  const cliValues = parseArgs(process.argv.slice(2));
  if (cliValues.help) {
    process.stdout.write(HELP);
    return;
  }
  const config = buildConfig(cliValues);
  await ensureRuntimeDirectories(config.paths);
  const version = await readServerVersion(PACKAGE_ROOT);
  const service = createHeadlessServer({ ...config, version });
  let stopping = false;

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`[loomtv-server] received ${signal}; shutting down\n`);
    try {
      await service.stop();
      process.exitCode = 0;
    } catch (error) {
      process.exitCode = 1;
      console.error('[loomtv-server] shutdown failed:', error);
    }
  };
  process.once('SIGINT', () => { void stop('SIGINT'); });
  process.once('SIGTERM', () => { void stop('SIGTERM'); });

  await service.start();
  const address = service.address();
  process.stdout.write(`[loomtv-server] listening on http://${address.host}:${address.port}\n`);
  process.stdout.write(`[loomtv-server] data=${config.paths.dataDir} cache=${config.paths.cacheDir}`
    + `${config.paths.mediaDir ? ` media=${config.paths.mediaDir}` : ''}\n`);
}

run().catch((error) => {
  if (error?.code === 'USAGE') {
    console.error(error.message);
  } else {
    console.error('[loomtv-server] failed to start:', error);
  }
  process.exitCode = 1;
});
