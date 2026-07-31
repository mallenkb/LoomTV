export type ActiveMediaProfile = {
  profileId: string | null;
  selectionRevision: number;
};

export type MediaAccessIdentity = {
  deviceId: string;
  profileId: string;
  selectionRevision: number;
};

export type MediaAccessIdentityInput = {
  boundDeviceId: string;
  boundProfileId: string;
  boundSelectionRevision: number;
  credentialDeviceId: string;
  signedRequestValid: boolean;
};

/**
 * Resolve media authorization from verified credentials. Query parameters may
 * narrow an authenticated identity, but can never replace or broaden it.
 */
export function resolveMediaAccessIdentity(
  input: MediaAccessIdentityInput,
  activeProfileForDevice: (deviceId: string) => ActiveMediaProfile,
): MediaAccessIdentity | null {
  const {
    boundDeviceId,
    boundProfileId,
    boundSelectionRevision,
    credentialDeviceId,
    signedRequestValid,
  } = input;
  if (credentialDeviceId && boundDeviceId && credentialDeviceId !== boundDeviceId) return null;

  const signedDeviceId = !credentialDeviceId && signedRequestValid ? boundDeviceId : '';
  const authorizedDeviceId = credentialDeviceId || signedDeviceId;
  if (!authorizedDeviceId) return null;

  const active = activeProfileForDevice(authorizedDeviceId);
  const profileId = boundProfileId || active.profileId;
  if (
    !profileId
    || (boundProfileId && active.profileId !== boundProfileId)
    || (
      Number.isFinite(boundSelectionRevision)
      && boundSelectionRevision > 0
      && active.selectionRevision !== boundSelectionRevision
    )
  ) return null;

  return {
    deviceId: authorizedDeviceId,
    profileId,
    selectionRevision: active.selectionRevision,
  };
}
