#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const mainBundlePath = path.join(packageRoot, '.vite', 'build', 'main.js');

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

console.log('Production renderer binding verified: bundled file only.');
