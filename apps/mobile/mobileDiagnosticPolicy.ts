export const MOBILE_DIAGNOSTIC_MAX_EVENTS = 100;
export const MOBILE_DIAGNOSTIC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MOBILE_DIAGNOSTIC_MAX_BYTES = 256 * 1024;

export type MobileDiagnosticEvent = {
  id: string;
  createdAt: number;
  scope: string;
  name: string;
  message: string;
  context?: Record<string, unknown>;
};

const sensitiveKeyPattern = /(authorization|certificate|credential|password|pin|refresh.?token|request.?secret|token)/i;
const bearerPattern = /Bearer\s+[^\s"']+/gi;
const secretQueryPattern = /([?&](?:code|secret|token|key|authorization)=)[^&#\s]+/gi;
const unixPathPattern = /(?:\/Users\/|\/home\/|\/storage\/|\/data\/)[^\s"']+/g;

function sanitizedString(value: string): string {
  return value
    .replace(bearerPattern, 'Bearer [redacted]')
    .replace(secretQueryPattern, '$1[redacted]')
    .replace(unixPathPattern, '[redacted-path]')
    .slice(0, 2_000);
}

function sanitizedValue(value: unknown, key = '', depth = 0): unknown {
  if (sensitiveKeyPattern.test(key)) return '[redacted]';
  if (depth >= 4) return '[truncated]';
  if (typeof value === 'string') return sanitizedString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizedValue(entry, '', depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([entryKey, entryValue]) => [entryKey, sanitizedValue(entryValue, entryKey, depth + 1)]),
    );
  }
  return String(value);
}

export function createMobileDiagnosticEvent(
  scope: string,
  error: unknown,
  context?: Record<string, unknown>,
  now = Date.now(),
): MobileDiagnosticEvent {
  const normalizedError = error instanceof Error
    ? { name: error.name || 'Error', message: error.message || 'Unknown error' }
    : { name: 'Error', message: typeof error === 'string' ? error : 'Unknown error' };
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: now,
    scope: sanitizedString(scope || 'unknown').slice(0, 120),
    name: sanitizedString(normalizedError.name).slice(0, 120),
    message: sanitizedString(normalizedError.message),
    ...(context ? { context: sanitizedValue(context) as Record<string, unknown> } : {}),
  };
}

export function mobileDiagnosticEventBytes(event: MobileDiagnosticEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).length;
}

export function mobileDiagnosticIdsToDelete(
  candidates: Array<{ id: string; createdAt: number; bytes: number }>,
  now: number,
): string[] {
  let retainedCount = 0;
  let retainedBytes = 0;
  const minimumCreatedAt = now - MOBILE_DIAGNOSTIC_MAX_AGE_MS;
  return [...candidates]
    .sort((left, right) => right.createdAt - left.createdAt)
    .flatMap((candidate) => {
      const expired = candidate.createdAt < minimumCreatedAt;
      const exceedsCount = retainedCount >= MOBILE_DIAGNOSTIC_MAX_EVENTS;
      const exceedsBytes = retainedBytes + candidate.bytes > MOBILE_DIAGNOSTIC_MAX_BYTES;
      if (expired || exceedsCount || exceedsBytes) return [candidate.id];
      retainedCount += 1;
      retainedBytes += candidate.bytes;
      return [];
    });
}
