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
  strictRecord(input, new Set(['addonId', 'runtimeId', 'state', 'lifecycleEpoch', 'reasonCode']), PluginRuntimeLifecycleError, 'A host runtime lifecycle lease');
  const state = readEnum(input.state, PLUGIN_RUNTIME_STATES, '$.state', PluginRuntimeLifecycleError, 'runtime state');
  const lease = Object.freeze({
    lifecycleVersion: PLUGIN_RUNTIME_LIFECYCLE_VERSION,
    kind: 'host-runtime-lease',
    addonId: readReverseDnsId(input.addonId, '$.addonId', PluginRuntimeLifecycleError),
    runtimeId: readOpaqueReference(input.runtimeId, '$.runtimeId', PluginRuntimeLifecycleError),
    state,
    lifecycleEpoch: readInteger(input.lifecycleEpoch, '$.lifecycleEpoch', PluginRuntimeLifecycleError),
    ...(input.reasonCode === undefined ? {} : { reasonCode: readText(input.reasonCode, '$.reasonCode', PluginRuntimeLifecycleError, { maxLength: 128 }) }),
  });
  leaseRecords.set(lease, { state, addonId: lease.addonId, runtimeId: lease.runtimeId, lifecycleEpoch: lease.lifecycleEpoch });
  return lease;
}

export function createHostRuntimeLease(input) {
  if (input?.state !== 'absent') fail('INITIAL_STATE_REQUIRED', 'A new host runtime lifecycle lease must begin in absent state.', '$.state');
  return makeLease(input);
}

export function transitionHostRuntimeLease(currentLease, nextState, reasonCode) {
  const current = leaseRecords.get(currentLease);
  if (!current) fail('HOST_LEASE_REQUIRED', 'A host runtime lease is required.');
  const state = readEnum(nextState, PLUGIN_RUNTIME_STATES, '$.nextState', PluginRuntimeLifecycleError, 'runtime state');
  if (!transitions.get(current.state).has(state)) fail('INVALID_TRANSITION', `Runtime state cannot transition from ${current.state} to ${state}.`, '$.nextState');
  return makeLease({
    addonId: current.addonId,
    runtimeId: current.runtimeId,
    state,
    lifecycleEpoch: current.lifecycleEpoch + 1,
    ...(reasonCode === undefined ? {} : { reasonCode }),
  });
}

export function isHostRuntimeLease(value) {
  return leaseRecords.has(value);
}

export function isReadyHostRuntimeLease(value) {
  const record = leaseRecords.get(value);
  return record?.state === 'ready';
}
