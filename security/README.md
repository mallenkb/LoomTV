# Dependency release gate

`pnpm audit:prod` audits production dependency paths across the complete workspace. Moderate,
high, and critical advisories fail the installer gate unless an exact advisory, module, and
dependency-path exception is documented in `production-audit-waivers.json`.

Waivers expire and may include source or dependency-path markers that invalidate the exception
when an excluded feature or runtime path appears. Current exceptions are limited to React Router's
unused unstable React Server Components APIs and old-major `brace-expansion` copies reached only
through Expo/React Native CLI, dev-server, test, code-generation, and build tooling. The latter
cannot safely take the patched v5 CommonJS API under the older minimatch consumers and expires
pending a compatible Expo/React Native toolchain update.

`pnpm sbom` creates a deterministic CycloneDX 1.6 inventory from `pnpm-lock.yaml`. It omits a
generation timestamp, sorts components, includes available integrity hashes, and records the
source lockfile SHA-256 so repeated generation from the same lockfile is byte-for-byte stable.

The mobile app uses Continuous Native Generation. Its local config plugin verifies the expected
Gradle distribution URL and adds Gradle's official SHA-256 checksum whenever Android native files
are generated, avoiding a partially committed `android` directory. The checksum source is
`https://services.gradle.org/distributions/gradle-8.14.3-bin.zip.sha256`.
