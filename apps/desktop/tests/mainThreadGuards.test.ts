import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { appendStall, createStallDetector, STALL_THRESHOLD_MS, type MainThreadStall } from '../src/main/mainThreadWatchdog.ts';
import { machOArchitectures } from '../src/main/machO.ts';

test('a late timer tick is reported as a stall, normal ticks are not', () => {
  let now = 0;
  const stalls: number[] = [];
  const detector = createStallDetector({ now: () => now, onStall: (ms) => stalls.push(ms), tickMs: 100 });
  for (const step of [100, 105, 130, 100 + STALL_THRESHOLD_MS - 1]) { now += step; detector.tick(); }
  assert.deepEqual(stalls, []);
  now += 100 + 900;
  detector.tick();
  assert.deepEqual(stalls, [900]);
});

test('the stall log keeps the newest twenty valid entries', () => {
  const stall = (n: number): MainThreadStall => ({ at: `t${n}`, durationMs: n, phase: 'idle', uptimeMs: n });
  let log: unknown = [{ bogus: true }, stall(0)];
  for (let n = 1; n <= 25; n += 1) log = appendStall(log, stall(n));
  const entries = log as MainThreadStall[];
  assert.equal(entries.length, 20);
  assert.equal(entries[0].durationMs, 6);
  assert.equal(entries.at(-1)?.durationMs, 25);
  assert.deepEqual(appendStall('damaged', stall(1)), [stall(1)]);
});

function thin(cpu: number): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeInt32LE(cpu, 4);
  return header;
}

function universal(cpus: number[]): Buffer {
  const header = Buffer.alloc(8 + cpus.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(cpus.length, 4);
  cpus.forEach((cpu, index) => header.writeInt32BE(cpu, 8 + index * 20));
  return header;
}

test('Mach-O headers give the architectures without running `file`', () => {
  assert.deepEqual(machOArchitectures(thin(0x0100000c)), ['arm64']);
  assert.deepEqual(machOArchitectures(thin(0x01000007)), ['x64']);
  assert.deepEqual(machOArchitectures(universal([0x01000007, 0x0100000c])), ['x64', 'arm64']);
  assert.equal(machOArchitectures(Buffer.from('#!/bin/sh\necho ffmpeg\n')), null, 'scripts are not binaries');
  const javaClass = Buffer.alloc(8);
  javaClass.writeUInt32BE(0xcafebabe, 0);
  javaClass.writeUInt32BE(52, 4);
  assert.equal(machOArchitectures(javaClass), null, 'Java class files share the universal magic');
});

test('a real system binary reports this Mac\'s architecture', { skip: process.platform !== 'darwin' }, () => {
  const header = fs.readFileSync('/bin/ls').subarray(0, 512);
  assert.ok(machOArchitectures(header)?.includes(process.arch));
});
