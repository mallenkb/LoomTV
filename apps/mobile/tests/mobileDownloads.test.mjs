import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../mobileDownloads.ts', import.meta.url), 'utf8');

test('mobile download capabilities stay in Authorization headers', () => {
  assert.match(source, /`LoomDownload \$\{capability\.credential\.id\}\.\$\{capability\.credential\.secret\}`/);
  assert.doesNotMatch(source, /searchParams\.set\([^\n]*secret/);
});

test('mobile downloads use document storage and remove missing database rows', () => {
  assert.match(source, /Paths\.document/);
  assert.match(source, /if \(file\.exists\) available\.push/);
  assert.match(source, /DELETE FROM mobile_downloads/);
});

test('mobile download paths discard traversal and separator characters', () => {
  assert.match(source, /replace\(\/\[\^a-zA-Z0-9\._-\]\/g, '_'/);
});
