#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const COMPILERS = [
  { name: 'tsrs', package: 'tsrs' },
  { name: 'TypeScript 7.1 beta', package: '@loom-typescript/beta' },
  { name: 'TypeScript 7.0.2', package: '@loom-typescript/stable' },
];

async function resolveCompiler(packageName) {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // The pinned packages expose their native resolver through this import map.
  // Reuse it for platform, libc, optional dependency, and TSRS_BINARY handling.
  const resolver = manifest.imports?.['#getExePath'];
  if (typeof resolver !== 'string' || !resolver.startsWith('./')) {
    throw new Error('The installed compiler has no native executable resolver.');
  }
  const { default: getExePath } = await import(pathToFileURL(path.resolve(path.dirname(manifestPath), resolver)).href);
  return getExePath();
}

function probeCompiler(executable) {
  // A loader error or unsupported CPU can exit without a spawn error. Probe
  // startup separately so real compiler diagnostics never trigger substitution.
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Compiler startup failed (${result.signal || result.status}).`);
  }
}

function runCompiler(executable, args) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: 'inherit', windowsHide: true });
    const handlers = new Map();
    let interrupted = false;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        interrupted = true;
        child.kill(signal);
      };
      process.on(signal, handler);
      handlers.set(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once('error', (error) => {
      cleanup();
      resolve({ error, interrupted });
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve({ code, signal, interrupted });
    });
  });
}

function failureReason(error) {
  return String(error?.message || error).split('\n')[0].slice(0, 240);
}

async function main(args = process.argv.slice(2)) {
  for (const compiler of COMPILERS) {
    let executable;
    try {
      executable = await resolveCompiler(compiler.package);
      probeCompiler(executable);
    } catch (error) {
      console.error(`[typescript] ${compiler.name} unavailable: ${failureReason(error)}`);
      continue;
    }
    console.error(`[typescript] Using ${compiler.name}.`);
    const result = await runCompiler(executable, args);
    if (result.error && !result.interrupted) {
      console.error(`[typescript] ${compiler.name} could not start: ${failureReason(result.error)}`);
      continue;
    }
    // Once compilation starts, preserve errors, crashes, and cancellation.
    // A different compiler must not turn an unsuccessful check into a pass.
    return result.signal ? 128 + (os.constants.signals[result.signal] || 1) : result.code ?? 1;
  }
  console.error('[typescript] No compiler could start. Reinstall workspace dependencies with optional packages enabled.');
  return 1;
}

module.exports = { COMPILERS, resolveCompiler, probeCompiler, runCompiler, main };
if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[typescript] ${failureReason(error)}`);
    process.exitCode = 1;
  });
}
