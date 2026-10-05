#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const mainEntryPath = path.join(packageRoot, '.vite', 'build', 'main.js');
const mainBundlePath = path.join(packageRoot, '.vite', 'build', 'main-bundle.js');

const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
if (packageJson.main !== '.vite/build/main.js' || !fs.existsSync(mainEntryPath)
  || fs.readFileSync(mainEntryPath, 'utf8') !== fs.readFileSync(path.join(packageRoot, 'src', 'mainEntry.cjs'), 'utf8')) {
  console.error('Missing or incorrect compile-cache entry. Refusing to package an app that bypasses the main bootstrap.');
  process.exit(1);
}

if (!fs.existsSync(mainBundlePath)) {
  console.error(`Missing production main bundle: ${mainBundlePath}`);
  process.exit(1);
}

const mainBundle = fs.readFileSync(mainBundlePath, 'utf8');
const embeddedDevRenderer = /MAIN_WINDOW_DEV_SERVER_URL(?:\$\d+)?\s*=\s*["']https?:\/\/(?:localhost|127\.0\.0\.1):\d+/;

if (embeddedDevRenderer.test(mainBundle)) {
  console.error('The production Electron bundle contains a development renderer URL. Refusing to build an app that could open another local project.');
  process.exit(1);
}

console.log('Production renderer binding verified: bundled assets only.');
