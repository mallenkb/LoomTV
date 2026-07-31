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

const hlsProfileBindings = new Map<string, HlsProfileBinding>();
const hlsStartsByDevice = new Map<string, number[]>();

export function deleteHlsProfileBinding(sessionId: string): void {
  hlsProfileBindings.delete(sessionId);
}

export function getHlsProfileBinding(sessionId: string): HlsProfileBinding | undefined {
  return hlsProfileBindings.get(sessionId);
}

export function bindHlsProfile(
  sessionId: string,
  identity: { deviceId: string; profileId: string; selectionRevision: number },
  filePath: string,
): void {
  hlsProfileBindings.delete(sessionId);
  while (hlsProfileBindings.size >= MAX_HLS_PROFILE_BINDINGS) {
    const oldest = [...hlsProfileBindings.entries()]
      .sort(([, left], [, right]) => left.lastAccessAt - right.lastAccessAt)[0];
    if (!oldest) break;
    hlsProfileBindings.delete(oldest[0]);
  }
  hlsProfileBindings.set(sessionId, { ...identity, filePath, lastAccessAt: Date.now() });
}

export function consumeHlsStartBudget(deviceId: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const cutoff = now - HLS_START_BUDGET_WINDOW_MS;
  if (hlsStartsByDevice.size >= MAX_TRACKED_HLS_START_DEVICES) {
    for (const [trackedDeviceId, timestamps] of hlsStartsByDevice) {
      if (!timestamps.some((timestamp) => timestamp > cutoff)) hlsStartsByDevice.delete(trackedDeviceId);
    }
    if (!hlsStartsByDevice.has(deviceId) && hlsStartsByDevice.size >= MAX_TRACKED_HLS_START_DEVICES) {
      const oldestDevice = [...hlsStartsByDevice.entries()]
        .sort(([, left], [, right]) => (left.at(-1) || 0) - (right.at(-1) || 0))[0];
      if (oldestDevice) hlsStartsByDevice.delete(oldestDevice[0]);
    }
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
