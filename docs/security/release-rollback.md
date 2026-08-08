# LoomTV release rollback runbook

This runbook covers a bad desktop release, a failed draft publication, or a suspected release-credential incident. It deliberately preserves protected tags: a tag is never moved to make a rollback appear successful.

## Stop publication

1. If the run is still active, cancel it in GitHub Actions.
2. If the release is still a draft, leave it unpublished while investigating. Delete the draft only after saving its run URL and evidence files.
3. If release authority may have been exposed, disable the Release workflow, revoke `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`, and `WINDOWS_SIGNER_THUMBPRINT` in the `production-release` environment. Remove environment reviewers and deployment access until the incident is contained.

## Bad published release

1. Do not delete or move the protected tag and do not overwrite a published release with a rerun. Record the tag, commit SHA, release URL, and the `SHA256SUMS` and manifest evidence.
2. Hide the bad release from future updater selection by editing it to a draft or otherwise disabling its publication according to the repository's GitHub release policy. If GitHub does not permit that transition for the affected release, remove or quarantine the bad assets and keep the release marked as unsafe in the incident record.
3. Build a corrected release from a new annotated `vMAJOR.MINOR.PATCH` tag pointing at the reviewed fix. The package version, release notes, updater metadata, checksums, and provenance must all identify the new tag.
4. Tell users to install the corrected release from its verified GitHub URL. Do not publish a lower version and do not reuse the compromised version: `electron-updater` resolves releases by version and would otherwise select the wrong artifact.

## Interrupted draft or failed evidence gate

1. Keep the draft unpublished. Inspect the workflow logs and the uploaded `release-manifest.json`, `release-provenance.json`, and `SHA256SUMS`.
2. If the failure is a transient runner or upload issue, rerun the workflow for the same protected tag. The workflow deletes and recreates an existing draft, so stale or same-named assets cannot be retained accidentally.
3. If the failure is an identity, signature, checksum, or provenance mismatch, correct the source or external setting and create a new protected tag when the package version must change. Never use a rerun to bypass a failed final verification gate.

## Restore normal release authority

1. Confirm the final macOS Team ID matches `APPLE_TEAM_ID` and the Windows installer signer matches `WINDOWS_SIGNER_THUMBPRINT`.
2. Confirm the `production-release` environment has required reviewers, protected tag/branch restrictions, and only the minimum secrets.
3. Re-enable the Release workflow and perform a disposable protected-tag dry run before restoring production credentials.
