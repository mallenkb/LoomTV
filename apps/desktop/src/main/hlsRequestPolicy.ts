import {
  createSessionBindingStore,
  type SessionDisposalSubscription,
} from './sessionBindingStore.ts';

export interface HlsProfileBinding {
  deviceId: string;
  profileId: string;
  selectionRevision: number;
  filePath: string;
  lastAccessAt: number;
}

const MAX_HLS_PROFILE_BINDINGS = 8;
const HLS_START_BUDGET_WINDOW_MS = 60 * 1000;
const MAX_HLS_STARTS_PER_DEVICE_PER_WINDOW = 30;
const MAX_TRACKED_HLS_START_DEVICES = 128;
const HLS_START_BUDGET_PRUNE_INTERVAL_MS = 1_000;

const hlsProfileBindings = createSessionBindingStore<HlsProfileBinding>(MAX_HLS_PROFILE_BINDINGS);
const hlsStartsByDevice = new Map<string, number[]>();
let nextHlsStartBudgetPruneAt = 0;

function pruneHlsStartBudget(now: number, force = false): void {
  if (!force && now < nextHlsStartBudgetPruneAt) return;
  nextHlsStartBudgetPruneAt = now + HLS_START_BUDGET_PRUNE_INTERVAL_MS;
  const cutoff = now - HLS_START_BUDGET_WINDOW_MS;
  for (const [trackedDeviceId, timestamps] of hlsStartsByDevice) {
    const activeTimestamps = timestamps.filter((timestamp) => timestamp > cutoff);
    if (activeTimestamps.length === 0) {
      hlsStartsByDevice.delete(trackedDeviceId);
    } else if (activeTimestamps.length !== timestamps.length) {
      hlsStartsByDevice.set(trackedDeviceId, activeTimestamps);
    }
  }
}


export function bindHlsProfileDisposal(subscribe: SessionDisposalSubscription): () => void {
  return hlsProfileBindings.bindDisposal(subscribe);
}

export function getHlsProfileBinding(sessionId: string): HlsProfileBinding | undefined {
  return hlsProfileBindings.get(sessionId);
}

export function touchHlsProfileBinding(sessionId: string): HlsProfileBinding | undefined {
  return hlsProfileBindings.touch(sessionId);
}

export function bindHlsProfile(
  sessionId: string,
  identity: { deviceId: string; profileId: string; selectionRevision: number },
  filePath: string,
): void {
  hlsProfileBindings.bind(sessionId, { ...identity, filePath });
}

export function consumeHlsStartBudget(deviceId: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const cutoff = now - HLS_START_BUDGET_WINDOW_MS;
  pruneHlsStartBudget(now);
  if (!hlsStartsByDevice.has(deviceId) && hlsStartsByDevice.size >= MAX_TRACKED_HLS_START_DEVICES) {
    // The throttled sweep may have left an entry that expired during the last
    // second. Force one pass before evicting an active device budget.
    pruneHlsStartBudget(now, true);
  }
  if (!hlsStartsByDevice.has(deviceId) && hlsStartsByDevice.size >= MAX_TRACKED_HLS_START_DEVICES) {
    const oldestDevice = [...hlsStartsByDevice.entries()]
      .sort(([, left], [, right]) => (left.at(-1) || 0) - (right.at(-1) || 0))[0];
    if (oldestDevice) hlsStartsByDevice.delete(oldestDevice[0]);
  }

  const timestamps = (hlsStartsByDevice.get(deviceId) || []).filter((timestamp) => timestamp > cutoff);
  if (timestamps.length >= MAX_HLS_STARTS_PER_DEVICE_PER_WINDOW) {
    hlsStartsByDevice.set(deviceId, timestamps);
    return { allowed: false, retryAfterMs: Math.max(1, timestamps[0] + HLS_START_BUDGET_WINDOW_MS - now) };
  }
  timestamps.push(now);
  hlsStartsByDevice.set(deviceId, timestamps);
  return { allowed: true };
}
