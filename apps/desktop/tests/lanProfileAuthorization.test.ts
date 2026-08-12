import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  resolveLanProfileAuthorization,
  type StoredProfileSelection,
} from '../src/main/lanProfileAuthorization.ts';

const normalizedSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const storedSelection = (profileId: string): StoredProfileSelection => ({
  profileId,
  selectionRevision: 4,
  automaticSignIn: true,
});

/** The body of a named top-level function, used for invariant assertions. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `Expected to find ${signature}.`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `Expected to find the end of ${signature}.`);
  return source.slice(start, end);
}

test('a LAN device that has never selected a profile is refused instead of defaulting to Owner', () => {
  assert.deepEqual(
    resolveLanProfileAuthorization({
      deviceId: 'phone-a',
      selection: null,
      selectedProfileExists: false,
    }),
    { kind: 'selection-required', reason: 'no-selection' },
  );
});

test('the profile API version header cannot change the outcome for an unselected device', () => {
  // The header is gone from the decision entirely: the input has no field for
  // it, so a client that omits it and a client that sends it are indistinguishable.
  const inputs = ['phone-with-header', 'phone-without-header'].map((deviceId) => (
    resolveLanProfileAuthorization({ deviceId, selection: null, selectedProfileExists: false })
  ));

  assert.deepEqual(inputs[0], inputs[1]);
});

test('an explicit valid selection is preserved for owner and non-owner profiles alike', () => {
  for (const profileId of ['owner-profile', 'kid-profile', 'standard-profile']) {
    assert.deepEqual(
      resolveLanProfileAuthorization({
        deviceId: 'phone-a',
        selection: storedSelection(profileId),
        selectedProfileExists: true,
      }),
      { kind: 'device-profile', selection: storedSelection(profileId) },
      profileId,
    );
  }
});

test('a selection whose profile was deleted or revoked is refused, not silently replaced', () => {
  assert.deepEqual(
    resolveLanProfileAuthorization({
      deviceId: 'phone-a',
      selection: storedSelection('deleted-profile'),
      selectedProfileExists: false,
    }),
    { kind: 'selection-required', reason: 'unknown-profile' },
  );
});

test('pre-fix LAN selections are covered by a one-time migration instead of trusted indefinitely', () => {
  const source = normalizedSource('../src/main/databaseMigrations.ts');
  const migrationBody = functionBody(source, 'function migrateLanProfileSelections(');

  assert.match(migrationBody, /DELETE FROM device_profile_selections WHERE device_id <> \?/);
  assert.match(migrationBody, /device_profile_selection_revisions/);
  assert.match(migrationBody, /LAN_PROFILE_SELECTION_RESET_MIGRATION_VERSION/);
});

test('a verified local desktop request keeps using the active desktop profile', () => {
  assert.deepEqual(
    resolveLanProfileAuthorization({
      deviceId: null,
      selection: null,
      selectedProfileExists: false,
    }),
    { kind: 'desktop-profile' },
  );
});

test('resolving a LAN profile never writes a selection', () => {
  const source = normalizedSource('../src/main/profileService.ts');
  const resolveBody = functionBody(source, 'export function resolveLanProfileId(');

  assert.equal(
    resolveBody.includes('selectDeviceProfile('),
    false,
    'Resolution must not persist a selection; only selectProfile may write one.',
  );
  assert.equal(
    resolveBody.includes('getOwnerProfile('),
    false,
    'Resolution must not fall back to the Owner profile.',
  );
  assert.equal(
    normalizedSource('../src/main/lanProfileAuthorization.ts').includes('selectDeviceProfile'),
    false,
    'The authorization decision must have no write path available to it.',
  );
});

test('the refusal and the client picker signal come from the same decision', () => {
  const source = normalizedSource('../src/main/profileService.ts');

  for (const [signature, description] of [
    ['export function resolveLanProfileId(', 'the 409 profile_required path'],
    ['export function getActiveProfileState(', 'the selectionRequired path clients read'],
  ] as const) {
    assert.equal(
      functionBody(source, signature).includes('resolveLanProfileAuthorization('),
      true,
      `${description} must use the shared authorization decision.`,
    );
  }
});

test('no caller-controlled profile API header reaches a media server authorization branch', () => {
  const source = normalizedSource('../src/main/mediaServer.ts');

  // The header stays allowed by CORS so existing clients keep working; it is
  // simply never read, so it cannot select a weaker authorization branch.
  assert.equal(
    /headers\[['"]x-loom-profile-api-version/i.test(source),
    false,
    'The profile API version header must not be read on any request path.',
  );
  assert.equal(
    source.includes('usesProfileApi'),
    false,
    'No authorization branch may depend on whether the client claims profile support.',
  );
});

test('pairing hands a new device no library content before it selects a profile', () => {
  const source = normalizedSource('../src/main/lanSecurity.ts');

  assert.equal(
    source.includes('libraryForLocalNetwork'),
    false,
    'Pairing must not project a profile-scoped library for a device with no selection.',
  );
  assert.equal(
    /headers\[['"]x-loom-profile-api-version/i.test(source),
    false,
    'Pairing must not vary its payload on a caller-controlled header.',
  );
});

test('profile-scoped segment discovery cannot probe restricted media IDs', () => {
  const source = normalizedSource('../src/main/mediaServer.ts');
  const routeStart = source.indexOf("reqUrl.pathname === '/api/v2/playback/segments'");
  assert.notEqual(routeStart, -1, 'Expected the v2 playback-segments route.');
  const routeBody = source.slice(routeStart, source.indexOf("reqUrl.pathname === '/api/cached-artwork'", routeStart));

  assert.match(routeBody, /const profileId = profileIdForRequest\(\)/);
  assert.match(routeBody, /canProfileAccessMediaId\(profileId, mediaId\)/);
  assert.match(routeBody, /writeJson\(res, 404, \{ error: 'media_not_found' \}\)/);
});

test('profile lists and progress filter stale media identifiers after a profile switch', () => {
  const source = normalizedSource('../src/main/mediaServer.ts');

  const listsStart = source.indexOf("reqUrl.pathname === '/api/v2/profile-lists'");
  const listsBody = source.slice(listsStart, source.indexOf("reqUrl.pathname === '/api/v2/artwork/official-candidates'", listsStart));
  assert.match(listsBody, /getProfileLists\(profileId, kind\)\.filter/);
  assert.match(listsBody, /req\.method === 'PUT' && !canProfileAccessMediaId\(profileId, mediaId\)/);

  const progressStart = source.indexOf("reqUrl.pathname === '/api/v2/progress' && req.method === 'GET'");
  const progressBody = source.slice(progressStart, source.indexOf("reqUrl.pathname === '/api/v2/playback-track-preferences'", progressStart));
  assert.match(progressBody, /assertProfileCanAccessPath\(profileId, storedPath\)/);
  assert.match(progressBody, /assertProfileCanAccessPath\(profileId, file\)/);
});
