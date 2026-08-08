const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseReleaseTag,
  verifyReleaseIdentity,
} = require('./release-identity.cjs');

function fixtureWorkspace(version = '1.2.3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-release-identity-'));
  fs.mkdirSync(path.join(root, 'apps', 'desktop'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'releases'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({
    version,
    productName: 'LoomTV',
    build: {
      artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
      publish: [{ provider: 'github', owner: 'mallenkb', repo: 'LoomTV', releaseType: 'release' }],
    },
  }));
  fs.writeFileSync(path.join(root, 'docs', 'releases', `v${version}.md`), `# LoomTV ${version}\n`);
  return root;
}

test('release identity fixture accepts only the stable tag and matching package metadata', () => {
  const root = fixtureWorkspace();
  assert.deepEqual(parseReleaseTag('v1.2.3'), { tag: 'v1.2.3', version: '1.2.3' });
  assert.deepEqual(verifyReleaseIdentity(root, 'v1.2.3').failures, []);
});

test('release identity fixture rejects prerelease tags and package drift', () => {
  const root = fixtureWorkspace();
  assert.throws(() => parseReleaseTag('v1.2.3-rc.1'), /prerelease tags are forbidden/);
  fs.writeFileSync(path.join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({
    version: '1.2.4',
    productName: 'LoomTV',
    build: { artifactName: '${productName}-${version}-${os}-${arch}.${ext}' },
  }));
  assert.ok(verifyReleaseIdentity(root, 'v1.2.3').failures.some((message) => message.includes('version must be 1.2.3')));
});
