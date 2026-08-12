/**
 * Which profile a request may read, decided from stored selection state alone.
 *
 * Resolution is a read. It reports the selection a device already made and
 * never selects one on the device's behalf, so a network device cannot inherit
 * the Owner profile by omitting a request header or by being the first caller
 * after a fresh pair. Selections change only through an explicit
 * `selectProfile` call, which is the sole write path.
 *
 * Both profile-sensitive representations come from this one decision: the
 * `409 profile_required` refusal that gates catalog, media, and playback
 * routes, and the `selectionRequired` state a client reads to show its profile
 * picker. They cannot disagree.
 */

export type StoredProfileSelection = {
  profileId: string;
  selectionRevision: number;
  automaticSignIn: boolean;
};

export type LanProfileAuthorization =
  | { kind: 'desktop-profile' }
  | { kind: 'device-profile'; selection: StoredProfileSelection }
  | { kind: 'selection-required'; reason: 'no-selection' | 'unknown-profile' };

export type LanProfileAuthorizationInput = {
  /** `null` only for a request already verified as local to this desktop. */
  deviceId: string | null;
  /** The device's stored selection, or `null` when it has never selected one. */
  selection: StoredProfileSelection | null;
  /** Whether the stored selection still names a live profile. */
  selectedProfileExists: boolean;
};

export function resolveLanProfileAuthorization(
  input: LanProfileAuthorizationInput,
): LanProfileAuthorization {
  const { deviceId, selection, selectedProfileExists } = input;
  if (!deviceId) return { kind: 'desktop-profile' };
  if (!selection) return { kind: 'selection-required', reason: 'no-selection' };
  if (!selectedProfileExists) return { kind: 'selection-required', reason: 'unknown-profile' };
  return { kind: 'device-profile', selection };
}
