'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  macDependencies, macRpaths, linuxDependencies, linuxSystem,
} = require('../scripts/libmpv-dependencies.cjs');

test('mac dependency parser keeps install names and finds loader rpaths', () => {
  const output = '/tmp/libmpv.dylib:\n'
    + '\t/opt/homebrew/opt/mpv/lib/libmpv.2.dylib (compatibility version 2.0.0, current version 2.0.0)\n'
    + '\t/opt/homebrew/opt/ffmpeg/lib/libavcodec.62.dylib (compatibility version 62.0.0, current version 62.1.0)\n'
    + '\t/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit (compatibility version 45.0.0, current version 2600.0.0)\n';
  assert.deepEqual(macDependencies(output), [
    '/opt/homebrew/opt/mpv/lib/libmpv.2.dylib',
    '/opt/homebrew/opt/ffmpeg/lib/libavcodec.62.dylib',
    '/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit',
  ]);
  assert.deepEqual(macRpaths('Load command 1\n          cmd LC_RPATH\n      cmdsize 48\n         path @loader_path/../lib (offset 12)\n'), ['@loader_path/../lib']);
});

test('Linux dependency parser detects missing codec libraries and leaves graphics drivers external', () => {
  const output = 'linux-vdso.so.1 (0x00007fff)\n'
    + 'libavcodec.so.62 => /usr/lib/x86_64-linux-gnu/libavcodec.so.62 (0x123)\n'
    + 'libplacebo.so.360 => not found\n'
    + 'libX11.so.6 => /lib/x86_64-linux-gnu/libX11.so.6 (0x456)\n'
    + '/lib64/ld-linux-x86-64.so.2 (0x789)\n';
  assert.deepEqual(linuxDependencies(output), [
    { name: 'libavcodec.so.62', location: '/usr/lib/x86_64-linux-gnu/libavcodec.so.62' },
    { name: 'libplacebo.so.360', location: null },
    { name: 'libX11.so.6', location: '/lib/x86_64-linux-gnu/libX11.so.6' },
  ]);
  assert.equal(linuxSystem('libX11.so.6'), true);
  assert.equal(linuxSystem('libEGL.so.1'), true);
  assert.equal(linuxSystem('libc.so.6'), true);
  assert.equal(linuxSystem('libavcodec.so.62'), false);
  assert.equal(linuxSystem('libplacebo.so.360'), false);
  assert.equal(linuxSystem('libx264.so.165'), false);
});
