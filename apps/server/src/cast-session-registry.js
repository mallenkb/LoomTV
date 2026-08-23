import { randomUUID } from 'node:crypto';

const TRANSPORTS = new Set(['airplay', 'chromecast', 'dlna']);

function castError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function publicSession(entry) {
  return {
    id: entry.id,
    transport: entry.transport,
    receiverName: entry.receiverName,
    mediaId: entry.mediaId,
    state: entry.state,
    positionSeconds: entry.positionSeconds,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt,
  };
}

export function createCastSessionRegistry({ clock = Date.now, maxSessions = 1_024, ttlMs = 15 * 60 * 1000 } = {}) {
  const sessions = new Map();

  function sweep(now = clock()) {
    for (const [id, entry] of sessions) if (entry.expiresAt <= now) sessions.delete(id);
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
  }

  return {
    create(input) {
      sweep();
      if (!TRANSPORTS.has(input.transport)) throw castError(400, 'invalid_request', 'The cast transport is invalid.');
      for (const field of ['principalId','profileId','deviceId','mediaId','sourceId','fileVersion','playbackSessionId']) {
        if (typeof input[field] !== 'string' || !input[field]) throw castError(400, 'invalid_request', `Cast session ${field} is required.`);
      }
      const now = clock();
      const entry = {
        id: randomUUID(), transport: input.transport,
        receiverName: String(input.receiverName || input.transport).trim().slice(0, 120),
        principalId: input.principalId, invitationSessionId: input.invitationSessionId || null,
        authenticationSessionId: input.authenticationSessionId || null,
        profileId: input.profileId, deviceId: input.deviceId,
        selectionRevision: input.selectionRevision, mediaId: input.mediaId,
        sourceId: input.sourceId, fileVersion: input.fileVersion,
        playbackSessionId: input.playbackSessionId,
        state: 'playing', positionSeconds: Math.max(0, Number(input.positionSeconds) || 0),
        createdAt: now, updatedAt: now, expiresAt: now + ttlMs,
      };
      sessions.set(entry.id, entry);
      sweep(now);
      return { record: { ...entry }, session: publicSession(entry) };
    },
    read(id) {
      sweep();
      const entry = sessions.get(id);
      return entry ? { ...entry } : null;
    },
    update(id, input = {}) {
      sweep();
      const entry = sessions.get(id);
      if (!entry) return null;
      if (input.state !== undefined && !['playing','paused'].includes(input.state)) {
        throw castError(400, 'invalid_request', 'Cast state must be playing or paused.');
      }
      if (input.positionSeconds !== undefined && (!Number.isFinite(input.positionSeconds) || input.positionSeconds < 0)) {
        throw castError(400, 'invalid_request', 'Cast position must be a non-negative number.');
      }
      entry.state = input.state || entry.state;
      if (input.positionSeconds !== undefined) entry.positionSeconds = Number(input.positionSeconds);
      entry.updatedAt = clock();
      entry.expiresAt = entry.updatedAt + ttlMs;
      return { record: { ...entry }, session: publicSession(entry) };
    },
    remove(id) {
      const entry = sessions.get(id);
      if (!entry) return null;
      sessions.delete(id);
      return { ...entry };
    },
    sweep,
    size() { sweep(); return sessions.size; },
  };
}
