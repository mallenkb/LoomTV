import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../src/web-app.html', import.meta.url), 'utf8');

test('the web app can create a child profile and edit its limits', () => {
  assert.match(html, /<select id="profileKind">[\s\S]*value="child"/);
  assert.match(html, /kind: \$\('profileKind'\)\.value === 'child' \? 'child' : 'adult'/);
  // Only child profiles get a Limits button.
  assert.match(html, /profile\.kind === 'child' \? `<button type="button" class="ghost" data-limits=/);
  assert.match(html, /api\(`\/api\/v1\/profiles\/\$\{encodeURIComponent\(profileId\)\}\/restrictions`\)/);
  assert.match(html, /\/restrictions`, \{\s*method: 'PATCH'/);
  // The age choices stay inside the server's accepted range for a child.
  const ages = [...html.matchAll(/<select id="restrictionsAge">([\s\S]*?)<\/select>/g)][0][1]
    .match(/value="(\d+)"/g).map((value) => Number(value.slice(7, -1)));
  assert.ok(ages.length > 0 && ages.every((age) => Number.isInteger(age) && age >= 0 && age <= 18));
});
