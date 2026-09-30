import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHeadlessMediaService } from '../src/media-service.js';

test('invitation plans cannot cross invitation, device, profile, or issuer-account boundaries', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-invitation-plan-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  let resolved = 0;
  const marker = new Error('Valid binding reached source resolution');
  const service = createHeadlessMediaService({
    cacheDir,
    cacheQuotaOptions: { sweepIntervalMs: 0 },
    authorize: async () => false,
    adminService: { resolveMediaPath: async () => { resolved += 1; throw marker; } },
  });
  t.after(() => service.stop());
  const principal = {
    id: 'issuer', type: 'user', authentication: 'invitation-session',
    invitationSessionId: 'invite-a', invitationProfileId: 'profile-a', deviceId: 'tv-a',
  };
  const binding = { profileId: 'profile-a', deviceId: 'tv-a', invitationSessionId: 'invite-a', selectionRevision: 0 };
  const plan = { sourceId: 'source-a', mode: 'transcode', codec: 'h264', copyVideo: false, copyAudio: false };
  const { token } = service.issueTranscodePlan('media-a', 'issuer', plan, {}, {}, binding);
  for (const other of [
    { ...principal, invitationSessionId: 'invite-b' },
    { ...principal, deviceId: 'tv-b' },
    { ...principal, invitationProfileId: 'profile-b' },
    { id: 'issuer', type: 'owner' },
  ]) {
    await assert.rejects(service.startTranscodePlan('media-a', token, other), { status: 403, code: 'permission_denied' });
  }
  assert.equal(resolved, 0, 'invalid bindings cannot resolve sources or consume the valid plan');
  await assert.rejects(service.startTranscodePlan('media-a', token, principal), (error) => error === marker);
  assert.equal(resolved, 1);
  const { token: accountToken } = service.issueTranscodePlan('media-a', 'issuer', plan, {}, {}, { profileId: 'profile-a', deviceId: 'tv-a' });
  await assert.rejects(service.startTranscodePlan('media-a', accountToken, principal), { status: 403, code: 'permission_denied' });
  assert.equal(resolved, 1, 'an invitation cannot execute an account-issued plan');
});

test('invitation stream permission does not authorize legacy unscoped transcode', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-invitation-legacy-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const principal = { id: 'issuer', type: 'user', authentication: 'invitation-session', permissions: ['library.read', 'stream'] };
  const service = createHeadlessMediaService({
    cacheDir,
    cacheQuotaOptions: { sweepIntervalMs: 0 },
    adminService: {
      authenticateRequest: async () => principal,
      authorizePrincipal: async (actor, permission) => actor.permissions.includes(permission),
      resolveMediaPath: async () => { throw new Error('Must not resolve unscoped media'); },
    },
  });
  t.after(() => service.stop());
  const response = { statusCode: 0, body: '', writeHead(status) { this.statusCode = status; }, end(body = '') { this.body = String(body); } };
  await service.handle({ method: 'POST', headers: { authorization: 'Bearer invitation' } }, response,
    new URL('http://localhost/api/media/transcode?itemId=media-a'));
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).error, 'permission_denied');
});
