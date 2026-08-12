import { randomUUID } from 'node:crypto';

export type OperationResultCode = 'success' | 'http_error' | 'timeout' | 'rejected' | 'failed';
export type CacheStatus = 'hit' | 'miss' | 'stale' | 'bypass' | 'not-applicable';

export type OperationEvent = {
  operationId: string;
  operation: string;
  durationMs: number;
  resultCode: OperationResultCode;
  cacheStatus: CacheStatus;
  provider?: string;
  retryCount: number;
  context?: Readonly<Record<string, string | number | boolean>>;
};

const SAFE_CONTEXT_KEYS = new Set(['method', 'status', 'routeFamily', 'itemType']);

function redactedContext(
  context?: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (!context) return undefined;
  const safeEntries = Object.entries(context).filter(([key]) => SAFE_CONTEXT_KEYS.has(key));
  return safeEntries.length > 0 ? Object.fromEntries(safeEntries) : undefined;
}

export function recordOperationEvent(event: OperationEvent): void {
  const payload = {
    event: 'operation.completed',
    ...event,
    context: redactedContext(event.context),
  };
  const write = event.resultCode === 'success' ? console.info : console.warn;
  write('[operation]', JSON.stringify(payload));
}

export function createOperation(operation: string) {
  const operationId = randomUUID();
  const startedAt = performance.now();
  return {
    operationId,
    finish(input: Omit<OperationEvent, 'operationId' | 'operation' | 'durationMs'>): void {
      recordOperationEvent({
        operationId,
        operation,
        durationMs: Math.round(performance.now() - startedAt),
        ...input,
      });
    },
  };
}
