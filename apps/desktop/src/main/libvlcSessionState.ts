export type LibVlcTrackSelection = {
  video?: number | null;
  audio?: number | null;
  subtitle?: number | null;
};

export type LibVlcTrackEndpoints = {
  video?: LibVlcTrackEndpoint;
  audio?: LibVlcTrackEndpoint;
  subtitle?: LibVlcTrackEndpoint;
};

type LibVlcTrackEndpoint = {
  get?: () => unknown;
  set?: (trackId: number) => unknown;
};

function normalizedTrackId(value: unknown): number | null {
  const trackId = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(trackId) && trackId >= 0 ? trackId : null;
}

function nativeCallSucceeded(value: unknown): boolean {
  if (typeof value === 'bigint') return value >= 0n;
  return typeof value !== 'number' || value >= 0;
}

export function captureLibVlcTrackSelection(endpoints: LibVlcTrackEndpoints): LibVlcTrackSelection {
  const selection: LibVlcTrackSelection = {};
  for (const kind of ['video', 'audio', 'subtitle'] as const) {
    const get = endpoints[kind]?.get;
    if (!get) continue;
    try {
      selection[kind] = normalizedTrackId(get());
    } catch {
      // An unavailable getter should not prevent the other tracks from being preserved.
    }
  }
  return selection;
}

export function restoreLibVlcTrackSelection(
  selection: LibVlcTrackSelection,
  endpoints: LibVlcTrackEndpoints,
): boolean {
  let restored = true;
  for (const kind of ['video', 'audio', 'subtitle'] as const) {
    if (!Object.prototype.hasOwnProperty.call(selection, kind)) continue;
    const endpoint = endpoints[kind];
    if (!endpoint?.set) {
      restored = false;
      continue;
    }
    const selectedTrackId = selection[kind] ?? null;
    try {
      if (endpoint.get && normalizedTrackId(endpoint.get()) === selectedTrackId) continue;
      if (!nativeCallSucceeded(endpoint.set(selectedTrackId ?? -1))) {
        restored = false;
        continue;
      }
      if (endpoint.get && normalizedTrackId(endpoint.get()) !== selectedTrackId) restored = false;
    } catch {
      restored = false;
    }
  }
  return restored;
}
