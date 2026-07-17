#!/usr/bin/env node

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packagePath = require.resolve('@electron-forge/cli/package.json');
const cliPath = path.join(path.dirname(packagePath), 'dist', 'electron-forge.js');
const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Failed to launch Electron Forge: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
