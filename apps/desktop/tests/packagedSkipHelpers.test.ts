import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('desktop packaging fetches and bundles fpcalc for every supported platform', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const packageJson = JSON.parse(fs.readFileSync(path.join(directory, '..', 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
    build?: { mac?: { extraResources?: Array<{ from?: string }> }; win?: { extraResources?: Array<{ from?: string }> }; linux?: { extraResources?: Array<{ from?: string }> } };
  };
  assert.match(packageJson.scripts?.prepackage || '', /fetch-fpcalc/);
  assert.equal(packageJson.build?.mac?.extraResources?.some((entry) => entry.from?.includes('fpcalc/mac')), true);
  assert.equal(packageJson.build?.win?.extraResources?.some((entry) => entry.from?.includes('fpcalc/win')), true);
  assert.equal(packageJson.build?.linux?.extraResources?.some((entry) => entry.from?.includes('fpcalc/linux')), true);
});
