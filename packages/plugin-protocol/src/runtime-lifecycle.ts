export declare const PLUGIN_RUNTIME_LIFECYCLE_VERSION: 1;
export declare const PLUGIN_RUNTIME_STATES: readonly ['absent', 'starting', 'ready', 'draining', 'stopped', 'failed', 'revoked'];
export type PluginRuntimeState = (typeof PLUGIN_RUNTIME_STATES)[number];

export declare class PluginRuntimeLifecycleError extends Error {
  readonly name: 'PluginRuntimeLifecycleError';
  readonly code: 'PLUGIN_RUNTIME_LIFECYCLE_INVALID';
  readonly issues: readonly { path: string; code: string; message: string }[];
}

export interface HostRuntimeLease {
  lifecycleVersion: 1;
  kind: 'host-runtime-lease';
  addonId: string;
  runtimeId: string;
  state: PluginRuntimeState;
  lifecycleEpoch: number;
  authorizationEpoch: number;
  revocationEpoch: number;
  reasonCode?: string;
}

export declare function createHostRuntimeLease(input: {
  addonId: string;
  runtimeId: string;
  state: 'absent';
  lifecycleEpoch: number;
  authorizationEpoch: number;
  revocationEpoch: number;
  reasonCode?: string;
}): HostRuntimeLease;
export declare function transitionHostRuntimeLease(currentLease: HostRuntimeLease, nextState: PluginRuntimeState, reasonCode?: string): HostRuntimeLease;
export declare function isHostRuntimeLease(value: unknown): value is HostRuntimeLease;
export declare function isReadyHostRuntimeLease(value: unknown): value is HostRuntimeLease & { state: 'ready' };
export declare function readCurrentReadyHostRuntimeLease(value: unknown, expected: {
  addonId: string;
  authorizationEpoch: number;
  revocationEpoch: number;
}): Readonly<{
  state: 'ready';
  addonId: string;
  runtimeId: string;
  lifecycleEpoch: number;
  authorizationEpoch: number;
  revocationEpoch: number;
}>;
