/**
 * Media identity resolution.
 *
 * Legacy media IDs on both desktop and headless are `sha256(path.resolve(file))`
 * truncated to 32 characters, so a move or a rename changes identity. The canonical
 * store keeps the opaque ID and moves the source underneath it, which is what this
 * resolver produces:
 *
 * - Every legacy media ID is preserved verbatim as the canonical `mediaId`.
 * - Every legacy path hash is preserved as a `desktop-path-hash` alias, so a later
 *   canonical rescan that recomputes the path hash lands back on the same item.
 * - A moved file is reconnected only on content-sha256, then filesystem-id, then
 *   quick-hash, and never on size or modification time.
 * - Ambiguity is preserved rather than guessed: when one evidence value matches more
 *   than one record or more than one candidate, nothing is reconnected and the
 *   collision is reported.
 */

import { createMediaItemId } from '@loom-media-server/media-core';
import { RELINK_EVIDENCE_ORDER } from './evidence.mjs';
import { locatorFingerprint } from './redaction.mjs';

function groupByValue(entries) {
  const groups = new Map();
  for (const { key, value } of entries) {
    if (!value) continue;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(key);
  }
  return groups;
}

function priorEvidenceIndex(priorEvidence) {
  const index = new Map();
  for (const entry of priorEvidence || []) {
    if (!entry || typeof entry.legacyMediaId !== 'string' || typeof entry.value !== 'string') continue;
    if (!RELINK_EVIDENCE_ORDER.includes(entry.kind)) continue;
    if (!index.has(entry.kind)) index.set(entry.kind, new Map());
    index.get(entry.kind).set(entry.legacyMediaId, entry.value);
  }
  return index;
}

/**
 * @param {object} input
 * @param {Array<{legacyMediaId: string, locator: string}>} input.records legacy catalog rows
 * @param {string[]} [input.candidateLocators] files present on disk that no intact record claims
 * @param {Array<{legacyMediaId: string, kind: string, value: string}>} [input.priorEvidence]
 *        evidence captured before the files moved, from an earlier migration report or a
 *        canonical export. Without it a moved file cannot be reconnected on any kind.
 * @param {object} input.provider evidence provider from `createFilesystemEvidenceProvider`
 */
export async function resolveMediaIdentity({
  records,
  candidateLocators = [],
  priorEvidence = [],
  provider,
  observedAt = Date.now(),
}) {
  const resolutions = new Map();
  const conflicts = [];
  const warnings = [];
  const decisions = [];
  const evidence = [];

  const ordered = [...records].sort((left, right) => left.legacyMediaId.localeCompare(right.legacyMediaId));
  const claimedLocators = new Set();
  const orphans = [];

  for (const record of ordered) {
    const present = await provider.exists(record.locator);
    resolutions.set(record.legacyMediaId, {
      legacyMediaId: record.legacyMediaId,
      mediaId: record.legacyMediaId,
      locator: record.locator,
      originalLocator: record.locator,
      state: present ? 'online' : 'missing',
      relink: null,
    });
    if (present) {
      claimedLocators.add(record.locator);
      // Capture the whole ladder, not just the cheapest rung. This migration can only
      // reconnect a file it has pre-move evidence for, so recording nothing but
      // filesystem-id now would leave the next move with nothing stronger than a device
      // and inode pair, which does not survive a copy to a different volume.
      for (const kind of RELINK_EVIDENCE_ORDER) {
        if (!provider.supports(kind)) continue;
        const value = await provider.evidence(record.locator, kind);
        if (value) evidence.push({ legacyMediaId: record.legacyMediaId, kind, value, observedAt });
      }
    } else {
      orphans.push(record);
    }
  }

  const unclaimedCandidates = [...new Set(candidateLocators)].filter((locator) => !claimedLocators.has(locator));

  if (orphans.length && !unclaimedCandidates.length) {
    warnings.push({
      code: 'relink_candidates_absent',
      category: 'identity',
      count: orphans.length,
      detail: 'Records point at files that are no longer present and no candidate locators were supplied.',
    });
  }

  const prior = priorEvidenceIndex(priorEvidence);
  const ambiguous = new Set();
  const pending = new Set(orphans.map((record) => record.legacyMediaId));

  for (const kind of RELINK_EVIDENCE_ORDER) {
    if (!pending.size || !unclaimedCandidates.length) break;
    if (!provider.supports(kind)) {
      warnings.push({ code: 'relink_evidence_kind_disabled', category: 'identity', count: pending.size, evidenceKind: kind });
      continue;
    }
    const priorForKind = prior.get(kind);
    if (!priorForKind) {
      warnings.push({
        code: 'relink_prior_evidence_missing',
        category: 'identity',
        count: pending.size,
        evidenceKind: kind,
        detail: 'No pre-move evidence of this kind was supplied, so it cannot reconnect a moved file.',
      });
      continue;
    }

    const orphanEntries = [];
    for (const legacyMediaId of pending) {
      if (ambiguous.has(legacyMediaId)) continue;
      const value = priorForKind.get(legacyMediaId);
      if (value) orphanEntries.push({ key: legacyMediaId, value });
    }
    if (!orphanEntries.length) continue;

    const candidateEntries = [];
    for (const locator of unclaimedCandidates) {
      if (claimedLocators.has(locator)) continue;
      candidateEntries.push({ key: locator, value: await provider.evidence(locator, kind) });
    }

    const orphanGroups = groupByValue(orphanEntries);
    const candidateGroups = groupByValue(candidateEntries);

    for (const [value, legacyMediaIds] of orphanGroups) {
      const matches = (candidateGroups.get(value) || []).filter((locator) => !claimedLocators.has(locator));
      if (!matches.length) continue;
      if (legacyMediaIds.length > 1 || matches.length > 1) {
        for (const legacyMediaId of legacyMediaIds) ambiguous.add(legacyMediaId);
        conflicts.push({
          code: 'ambiguous_media_relink',
          category: 'identity',
          count: legacyMediaIds.length,
          evidenceKind: kind,
          recordIds: legacyMediaIds.slice(0, 16),
          candidateCount: matches.length,
          resolution: 'preserved-unlinked',
          detail: 'One evidence value matched more than one record or more than one file, so nothing was reconnected.',
        });
        continue;
      }
      const [legacyMediaId] = legacyMediaIds;
      const [locator] = matches;
      const resolution = resolutions.get(legacyMediaId);
      resolution.locator = locator;
      resolution.state = 'online';
      resolution.relink = { evidenceKind: kind, reviewRequired: kind === 'quick-hash' };
      claimedLocators.add(locator);
      pending.delete(legacyMediaId);
      evidence.push({ legacyMediaId, kind, value, observedAt });
      const filesystem = await provider.evidence(locator, 'filesystem-id');
      if (filesystem) evidence.push({ legacyMediaId, kind: 'filesystem-id', value: filesystem, observedAt });
      if (kind === 'quick-hash') {
        warnings.push({
          code: 'relink_quick_hash_only',
          category: 'identity',
          count: 1,
          recordId: legacyMediaId,
          detail: 'Reconnected on quick-hash evidence only. Confirm the title before trusting its progress and lists.',
        });
      }
    }
  }

  const stillMissing = [...pending].filter((legacyMediaId) => resolutions.get(legacyMediaId).state === 'missing');
  if (stillMissing.length) {
    decisions.push({
      code: 'unreconnected_records_preserved',
      value: 'kept-offline',
      count: stillMissing.length,
      detail: 'Records whose file could not be reconnected keep their identity and are imported as offline sources.',
    });
  }

  const aliases = [];
  const aliasOwners = new Map();
  const claimAlias = (alias, mediaId, preferred) => {
    const existing = aliasOwners.get(alias);
    if (!existing) {
      aliasOwners.set(alias, { mediaId, preferred });
      return;
    }
    if (existing.mediaId === mediaId) {
      if (preferred) existing.preferred = true;
      return;
    }
    if (preferred && !existing.preferred) {
      conflicts.push({
        code: 'path_hash_alias_collision',
        category: 'identity',
        count: 2,
        recordIds: [existing.mediaId, mediaId],
        resolution: 'current-location-wins',
        detail: 'Two records claim one path hash because a file took over another file location.',
      });
      aliasOwners.set(alias, { mediaId, preferred });
      return;
    }
    conflicts.push({
      code: 'path_hash_alias_collision',
      category: 'identity',
      count: 2,
      recordIds: [existing.mediaId, mediaId],
      resolution: 'first-claim-kept',
      detail: 'Two records claim one path hash because a file took over another file location.',
    });
  };

  for (const resolution of resolutions.values()) {
    claimAlias(createMediaItemId(resolution.originalLocator), resolution.mediaId, resolution.state === 'online' && !resolution.relink);
    if (resolution.relink) claimAlias(createMediaItemId(resolution.locator), resolution.mediaId, true);
  }
  for (const [alias, owner] of aliasOwners) {
    aliases.push({ namespace: 'desktop-path-hash', alias, mediaId: owner.mediaId, createdAt: observedAt });
  }

  const relinked = [...resolutions.values()].filter((resolution) => resolution.relink);
  if (relinked.length) {
    decisions.push({
      code: 'moved_files_reconnected',
      value: 'strong-evidence-only',
      count: relinked.length,
      byEvidenceKind: Object.fromEntries(RELINK_EVIDENCE_ORDER.map((kind) => [
        kind,
        relinked.filter((resolution) => resolution.relink.evidenceKind === kind).length,
      ])),
    });
  }

  return {
    resolutions: [...resolutions.values()],
    aliases,
    evidence,
    conflicts,
    warnings,
    decisions,
    counts: {
      records: resolutions.size,
      intact: [...resolutions.values()].filter((resolution) => resolution.state === 'online' && !resolution.relink).length,
      relinked: relinked.length,
      missing: [...resolutions.values()].filter((resolution) => resolution.state === 'missing').length,
      ambiguous: ambiguous.size,
      unclaimedCandidates: unclaimedCandidates.filter((locator) => !claimedLocators.has(locator)).length,
    },
    /** Opaque fingerprints only, so a caller can log correlation without logging paths. */
    fingerprints: [...resolutions.values()].map((resolution) => ({
      recordId: resolution.mediaId,
      originalLocator: locatorFingerprint(resolution.originalLocator),
      currentLocator: locatorFingerprint(resolution.locator),
      state: resolution.state,
    })),
  };
}
