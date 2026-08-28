#!/usr/bin/env node

const path = require('node:path');
const { spawn } = require('node:child_process');

const electronPath = require('electron');
const packageRoot = path.resolve(__dirname, '..');
const child = spawn(electronPath, [packageRoot], {
  cwd: packageRoot,
  env: process.env,
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(`Could not launch LoomTV: ${error.message}`);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
