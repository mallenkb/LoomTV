# Dependency release gate

`pnpm audit:prod` audits production dependency paths across the complete workspace. Every
moderate, high, or critical advisory fails the installer gate unless its exact GitHub advisory ID
has a valid entry in `production-audit-waivers.json`. Waivers do not change the severity gate; they
accept only findings that continue to match all documented constraints. Accepted waivers are
printed locally and emitted as GitHub Actions warning annotations in CI.

## Waiver schema

`production-audit-waivers.json` contains an `advisories` object keyed by GitHub advisory ID. Each
entry requires:

- `module`: the exact audited package name.
- `reviewedOn`: the UTC date when the exception was reviewed.
- `expires`: the last valid UTC date in `YYYY-MM-DD` form.
- `owner`: the person or team responsible for follow-up.
- `reason`: the bounded impact, why an upgrade is not currently available, and the condition for
  removing the waiver.
- `allowedPathPrefixes`: one or more prefixes; every reported dependency path must start with one.
- `requiredPathMarkers`: one or more markers; every reported dependency path must contain every
  marker.

The validator rejects missing or malformed paths, module changes, expired or malformed entries,
paths outside the allowed prefixes, paths missing any required marker, and paths that do not end
at the exact waived module. Prefixes and markers are compared as complete dependency-graph
segments, not permissive substrings. Stale waiver entries also fail after an advisory disappears,
forcing their prompt removal. A review window cannot exceed 90 days. Add no severity-wide or
module-wide exceptions.

## Ownership, expiry, and removal

The named owner must re-run `pnpm audit:prod` and check the upstream dependency before the expiry
date. Prefer an upgrade or a compatible resolution override. Remove a waiver as soon as pnpm no
longer reports the advisory. If an advisory remains but its module or dependency path changes, add
no broader scope automatically: investigate the new exposure and replace the waiver only after a
fresh review. Expired waivers fail the gate.

## Live waivers

Both current `image-size` advisories are build-time denial-of-service findings with no fixed
published version. They are owned by `@mallenkb`, expire on 2026-11-06, and are accepted only when
every path starts at `apps__mobile>` and contains `>metro>image-size`. This confines them to the
mobile Metro build dependency graph. Follow up when Expo or Metro publishes a compatible fixed
dependency and remove each waiver when its advisory disappears; any path outside that exact scope
must fail the gate.

- `GHSA-w3rx-r6r6-pgpr`: ICNS parser infinite-loop denial of service.
- `GHSA-5p2g-fcmc-qvqq`: JXL and HEIF parser infinite-loop denial of service.

`pnpm sbom` creates a deterministic CycloneDX 1.6 inventory from `pnpm-lock.yaml`. It omits a
generation timestamp, sorts components, includes available integrity hashes, and records the
source lockfile SHA-256 so repeated generation from the same lockfile is byte-for-byte stable.

The mobile app uses Continuous Native Generation. Its local config plugin verifies the expected
Gradle distribution URL and adds Gradle's official SHA-256 checksum whenever Android native files
are generated, avoiding a partially committed `android` directory. The checksum source is
`https://services.gradle.org/distributions/gradle-8.14.3-bin.zip.sha256`.
