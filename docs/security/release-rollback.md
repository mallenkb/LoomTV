# LoomTV release rollback runbook

This runbook covers a bad desktop release, a failed draft publication, or a suspected release-credential incident. It deliberately preserves protected tags: a tag is never moved to make a rollback appear successful.

## Stop publication

1. If the run is still active, cancel it in GitHub Actions.
2. If the release is still a draft, leave it unpublished while investigating. Save the run URL and the `loomtv-prior-draft-evidence-*` workflow artifact before deleting or replacing the draft.
3. If release authority may have been exposed, disable the Release workflow and remove/rotate `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`, and `WINDOWS_SIGNER_THUMBPRINT` in the `production-release` environment. Remove environment reviewers and deployment access until the incident is contained.

## Bad published release

1. Do not delete or move the protected tag and do not overwrite a published release with a rerun. Record the tag, commit SHA, release URL, and the `SHA256SUMS` and manifest evidence.
2. Hide the bad release from future updater selection by editing it to a draft or otherwise disabling its publication according to the repository's GitHub release policy. If GitHub does not permit that transition for the affected release, remove or quarantine the bad assets and keep the release marked as unsafe in the incident record.
3. Build a corrected release from a new annotated `vMAJOR.MINOR.PATCH` tag pointing at the reviewed fix. The package version, release notes, updater metadata, checksums, exact target manifest, and GitHub/SLSA subjects must all identify the new tag.
4. Tell users to install the corrected release from its verified GitHub URL. Do not publish a lower version and do not reuse the compromised version: `electron-updater` resolves releases by version and would otherwise select the wrong artifact.

## Interrupted draft or failed evidence gate

1. Keep the draft unpublished. Inspect the workflow logs and the uploaded `release-manifest.json` and `SHA256SUMS`; verify subjects with `gh attestation verify` before treating an asset as trusted.
2. If the failure is a transient runner or upload issue, rerun the workflow for the same protected tag. The workflow archives the prior draft before deletion and then replaces the complete asset set, so stale or same-named assets cannot be retained accidentally.
3. If the failure is an identity, signature, checksum, target-matrix, updater-coverage, or attestation mismatch, correct the source or external setting and create a new protected tag when the package version must change. Never use a rerun to bypass a failed final verification gate.

## Actual certificate revocation

Perform the provider-side revocation, not only GitHub secret rotation, when a signing identity may have been exposed. Record the certificate serial/thumbprint and revocation timestamp in the incident record before deleting the evidence archive.

1. macOS: in Apple Developer Account → Certificates, Identifiers & Profiles → Certificates, revoke the affected Developer ID Application certificate. At appleid.apple.com, revoke the `APPLE_APP_SPECIFIC_PASSWORD` used for notarization. Remove both values and `APPLE_TEAM_ID` from `production-release`, issue replacement credentials, and require a fresh environment approval. On a clean macOS runner, confirm the replacement identity with `security find-identity -p codesigning -v` and a disposable notarized build.
2. Windows: ask the certificate authority or signing-service administrator to revoke the affected Authenticode certificate using its serial number, then remove `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`, and `WINDOWS_SIGNER_THUMBPRINT` from `production-release`. On a network-connected clean Windows host, verify the old artifact with `signtool verify /pa /all /tw` and online revocation enabled; retain the failing output as evidence and confirm the replacement thumbprint is the only one accepted by the release gate.
3. GitHub: disable the Release workflow while credentials are rotated, remove stale environment reviewers/deployment access, and re-enable only after the replacement identities and protected `v*` tag rules are confirmed.

## Tested updater disable/recovery drill

Run this against a disposable stable tag and a packaged test client; attach the observed update-state evidence to the release record. This is a required operational test, not a claim that the drill was run by this code change.

1. Build and sign the disposable tag, but leave its release as a draft. On a packaged macOS, Windows, or Linux AppImage client, use File → Check for Updates. The client must not reach `available`, `downloading`, or `downloaded` for the draft; record the observed `not-available`/`error` state and the release API response. The packaged updater uses the GitHub feed; unsupported/unpackaged builds use `/releases/latest`, which excludes drafts.
2. Disable the feed by keeping the release draft (or, during an incident, move the affected release back to draft if GitHub permits it). Repeat the manual check after restarting the client and confirm no installer is offered or installed. Do not delete the tag.
3. Recover with `gh release edit vMAJOR.MINOR.PATCH --draft=false --latest` only after the replacement artifacts, signatures, checksums, manifest, and attestations are verified. Restart the disposable client, run the manual check, and record `available`/`downloaded` only for the expected higher version; exercise install/restart on the disposable client and retain the resulting version and signature evidence.

## Restore normal release authority

1. Confirm the final macOS Team ID matches `APPLE_TEAM_ID` and the Windows installer signer matches `WINDOWS_SIGNER_THUMBPRINT`.
2. Confirm the `production-release` environment has required reviewers, protected tag/branch restrictions, and only the minimum secrets.
3. Re-enable the Release workflow and perform a disposable protected-tag dry run before restoring production credentials.
