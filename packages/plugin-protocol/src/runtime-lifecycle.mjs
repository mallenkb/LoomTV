/**
 * Pre-phase runtime lifecycle vocabulary for the future Phase 5 host.
 *
 * This is a host-only state model, not a runtime. Playback ticket issuance
 * may depend on a ready lease later, but this package does not start or stop
 * a process and no current Desktop or Headless service consumes this model.
 */

import {
  failWith,
  readEnum,
  readInteger,
  readOpaqueReference,
  readReverseDnsId,
  readText,
  strictRecord,
} from './validation.mjs';

export const PLUGIN_RUNTIME_LIFECYCLE_VERSION = 1;
export const PLUGIN_RUNTIME_STATES = Object.freeze(['absent', 'starting', 'ready', 'draining', 'stopped', 'failed', 'revoked']);

const leaseRecords = new WeakMap();
const currentRuntimeRecords = new Map();

export class PluginRuntimeLifecycleError extends Error {
  constructor(issues) {
    const normalizedIssues = Object.freeze(issues.map((entry) => Object.freeze({ ...entry })));
    const detail = normalizedIssues.map((entry) => `${entry.path}: ${entry.message}`).join('; ');
    super(`Invalid plugin runtime lifecycle value${detail ? `: ${detail}` : '.'}`);
    this.name = 'PluginRuntimeLifecycleError';
    this.code = 'PLUGIN_RUNTIME_LIFECYCLE_INVALID';
    this.issues = normalizedIssues;
  }
}

function fail(code, message, path = '$') {
  failWith(PluginRuntimeLifecycleError, code, message, path);
}

const transitions = new Map([
  ['absent', new Set(['starting'])],
  ['starting', new Set(['ready', 'failed', 'revoked'])],
  ['ready', new Set(['draining', 'failed', 'revoked'])],
  ['draining', new Set(['stopped', 'revoked', 'failed'])],
  ['stopped', new Set()],
  ['failed', new Set()],
  ['revoked', new Set()],
]);

function makeLease(input) {
  strictRecord(input, new Set([
    'addonId',
    'runtimeId',
    'state',
    'lifecycleEpoch',
    'authorizationEpoch',
    'revocationEpoch',
    'reasonCode',
  ]), PluginRuntimeLifecycleError, 'A host runtime lifecycle lease');
  const state = readEnum(input.state, PLUGIN_RUNTIME_STATES, '$.state', PluginRuntimeLifecycleError, 'runtime state');
  const lease = Object.freeze({
    lifecycleVersion: PLUGIN_RUNTIME_LIFECYCLE_VERSION,
    kind: 'host-runtime-lease',
    addonId: readReverseDnsId(input.addonId, '$.addonId', PluginRuntimeLifecycleError),
    runtimeId: readOpaqueReference(input.runtimeId, '$.runtimeId', PluginRuntimeLifecycleError),
    state,
    lifecycleEpoch: readInteger(input.lifecycleEpoch, '$.lifecycleEpoch', PluginRuntimeLifecycleError),
    authorizationEpoch: readInteger(input.authorizationEpoch, '$.authorizationEpoch', PluginRuntimeLifecycleError),
    revocationEpoch: readInteger(input.revocationEpoch, '$.revocationEpoch', PluginRuntimeLifecycleError),
    ...(input.reasonCode === undefined ? {} : { reasonCode: readText(input.reasonCode, '$.reasonCode', PluginRuntimeLifecycleError, { maxLength: 128 }) }),
  });
  const record = Object.freeze({
    state,
    addonId: lease.addonId,
    runtimeId: lease.runtimeId,
    lifecycleEpoch: lease.lifecycleEpoch,
    authorizationEpoch: lease.authorizationEpoch,
    revocationEpoch: lease.revocationEpoch,
  });
  leaseRecords.set(lease, record);
  currentRuntimeRecords.set(lease.runtimeId, record);
  return lease;
}

export function createHostRuntimeLease(input) {
  if (input?.state !== 'absent') fail('INITIAL_STATE_REQUIRED', 'A new host runtime lifecycle lease must begin in absent state.', '$.state');
  if (input?.lifecycleEpoch !== 0) fail('INITIAL_EPOCH_REQUIRED', 'A new host runtime lifecycle lease must begin at lifecycle epoch zero.', '$.lifecycleEpoch');
  if (typeof input?.runtimeId === 'string' && currentRuntimeRecords.has(input.runtimeId)) {
    fail('RUNTIME_ID_REUSED', 'A runtime ID cannot be reused while a lifecycle record exists.', '$.runtimeId');
  }
  return makeLease(input);
}

export function transitionHostRuntimeLease(currentLease, nextState, reasonCode) {
  const current = leaseRecords.get(currentLease);
  if (!current) fail('HOST_LEASE_REQUIRED', 'A host runtime lease is required.');
  if (currentRuntimeRecords.get(current.runtimeId) !== current) fail('STALE_RUNTIME_LEASE', 'A stale runtime lease cannot transition the current runtime.', '$');
  const state = readEnum(nextState, PLUGIN_RUNTIME_STATES, '$.nextState', PluginRuntimeLifecycleError, 'runtime state');
  if (!transitions.get(current.state).has(state)) fail('INVALID_TRANSITION', `Runtime state cannot transition from ${current.state} to ${state}.`, '$.nextState');
  return makeLease({
    addonId: current.addonId,
    runtimeId: current.runtimeId,
    state,
    lifecycleEpoch: current.lifecycleEpoch + 1,
    authorizationEpoch: current.authorizationEpoch,
    revocationEpoch: current.revocationEpoch + (state === 'revoked' ? 1 : 0),
    ...(reasonCode === undefined ? {} : { reasonCode }),
  });
}

export function isHostRuntimeLease(value) {
  return leaseRecords.has(value);
}

export function isReadyHostRuntimeLease(value) {
  const record = leaseRecords.get(value);
  const current = record && currentRuntimeRecords.get(record.runtimeId);
  return record?.state === 'ready'
    && current === record
    && current.lifecycleEpoch === record.lifecycleEpoch
    && current.revocationEpoch === record.revocationEpoch;
}

/** @internal Host-only exact binding check used before issuing a ticket. */
export function readCurrentReadyHostRuntimeLease(value, expected) {
  const record = leaseRecords.get(value);
  if (!record || !isReadyHostRuntimeLease(value)) fail('RUNTIME_NOT_READY', 'A current host runtime lease in ready state is required.');
  strictRecord(expected, new Set(['addonId', 'authorizationEpoch', 'revocationEpoch']), PluginRuntimeLifecycleError, 'An expected runtime binding');
  const addonId = readReverseDnsId(expected.addonId, '$.addonId', PluginRuntimeLifecycleError);
  const authorizationEpoch = readInteger(expected.authorizationEpoch, '$.authorizationEpoch', PluginRuntimeLifecycleError);
  const revocationEpoch = readInteger(expected.revocationEpoch, '$.revocationEpoch', PluginRuntimeLifecycleError);
  if (record.addonId !== addonId) fail('RUNTIME_ADDON_MISMATCH', 'The runtime lease belongs to a different add-on.', '$.addonId');
  if (record.authorizationEpoch !== authorizationEpoch) fail('RUNTIME_AUTHORIZATION_STALE', 'The runtime lease authorization epoch is stale.', '$.authorizationEpoch');
  if (record.revocationEpoch !== revocationEpoch) fail('RUNTIME_REVOCATION_STALE', 'The runtime lease revocation epoch is stale.', '$.revocationEpoch');
  return record;
}
