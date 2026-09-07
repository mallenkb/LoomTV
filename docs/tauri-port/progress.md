# Desktop port status

Updated 2026-09-07. Full desktop parity is incomplete. The port is not a replacement for Electron and is not ready for a production release. Work stays on `codex/tauri-react-port`; existing Electron, NAS, mobile and TV default commands remain unchanged.

## Verified local media service work

Implementation commit: `3d04a0eeee8822d7d1a898eb29f2f84766ab76f6`.
Transport and command-interface commit: `e25338f697118f6cfcffc0460766680b3b6b47c6`.
Starting branch snapshot: `3830a65cb9897345b0e050c7451578e92cf2189d`.

The Rust desktop now connects `media:probe`, `media:can-direct-play`, `media:start-transcode`, `media:stop-transcode`, and forced `media:get-stream-url` to the normalized probe and owned local HLS service. These operations no longer use the unfinished transcode placeholders that prevented compilation. Probe results use the renderer contract instead of raw ffprobe JSON.

The HLS service owns encoder processes, drains process output, generates bounded seek windows, validates selected stream indices, scopes URLs to the active profile revision, validates each streamed chunk, and removes its own outputs on revocation/shutdown. It rejects forged Host headers and invalid segment names, serves GET/HEAD and byte ranges, and limits sessions, requests, restart frequency and cache size. This is local-file fallback work. It does not establish remote transcode, IPTV, native LibVLC or browser rendering parity.

The Tauri event transport now handles removal before asynchronous listen completion, duplicate registration, failed registration, disposal, late replies, malformed events and failing native cleanup. React components were not rewritten.

The missing Tauri pnpm importer and dependency entries were generated with pnpm 11.20.0. A comparison asserted that every existing workspace importer stayed unchanged. Frozen installation now succeeds for the repaired lockfile.

## Executed evidence

GitHub Actions run `34089977335`, job `101641310441`, on Ubuntu 24.04:

- `pnpm install --frozen-lockfile --ignore-scripts`: passed.
- Existing workspace dependency-selection comparison: passed.
- `pnpm verify:workflow-policy`: passed.
- `pnpm desktop:tauri:test`: eight transport tests passed.
- `cargo test -p loomtv-core -p loomtv-playback --locked --no-fail-fast`: five unit tests passed. The external-tool integration case was ignored here and executed separately below. `loomtv-playback` currently contains no unit tests; its compilation is not native playback verification.
- `pnpm desktop:tauri:test:media`, with explicit `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`: one generated-media integration test passed, zero ignored.

The integration case creates a short generated test movie and temporary SQLite store. It checks normalized probing, direct suffix ranges, real MPEG-TS output, a seek outside the first encoding window, partial responses, HEAD headers/empty body, invalid ranges, invalid segment names, forged Host rejection, session reuse, profile-lock revocation, output removal and shutdown. It does not open installed applications, private credentials, user libraries or production databases.

Evidence artifact `10006518337`, `tauri-reviewed-e25338f697118f6cfcffc0460766680b3b6b47c6-1`, contains the exact verified patch, its SHA-256, source snapshot and test logs. The verified patch was committed as `3d04a0e`. The temporary commit job pushed successfully, then its final informational Git command failed after removal of an environment-based Git config value. The remote ref was checked independently. That post-push logging failure must not be described as a failed media test or as a wholly successful workflow.

The temporary patch-transfer workflow and patch files have been removed. The remaining Tauri workflow is read-only and runs against ordinary tracked source. It checks transport behavior, both desktop TypeScript projects, frontend production output, Rust formatting/lint/tests, generated media and macOS adapter compilation. Results from that permanent workflow must be read for the exact commit under review; merely defining a job is not a passing result.

## Storage warning

The inherited branch currently defaults to Electron's version-14 `LoomTV/loomtv.sqlite`. `LOOMTV_DATA_DIR` can select an isolated directory. The earlier shared-database implementation conflicts with the supplied checklist's isolated-default and explicit-snapshot-import rules. That conflict remains unresolved. A backup marker is not proof that concurrent Electron/Tauri writers, credential migration or schema changes are safe. Use a separate temporary data directory for tests. No real user store was opened during this work.

## Remaining acceptance gates

The existing Rust code also contains profiles, personal state, catalog projections, scanning, metadata/provider requests, artwork, discovery, remote connections, subtitles/thumbnails, IPTV proxying, macOS player hosting and OS integrations. Presence of those handlers is not completed feature parity.

Still open: full desktop-hosted server behavior; end-to-end NAS pairing and trust; remote/browser fallback parity; mpv; Stremio review/configuration/resource execution; automatic segment analysis; secondary metadata/artwork flows; safe storage import, credentials and coexistence; tray and complete OS behavior; signed updates; shared renderer/package extraction; Windows/Linux native composition; clean installation; accessibility; full regression and security-negative suites; release benchmarks and long-session soak tests.

No real WebView playback, native video/audio composition, fullscreen/sleep/monitor behavior, installer/update validation, private provider request, real-library scan or performance improvement was verified by the service tests. The two-hour soak and 50-cycle playback requirements remain unexecuted. The full feature ledger and source-delta review remain incomplete.

## Commands

Use `pnpm desktop:tauri:test` for transport tests, `pnpm desktop:tauri:test:rust` for Rust services, and `pnpm desktop:tauri:test:media --ffmpeg /trusted/absolute/ffmpeg --ffprobe /trusted/absolute/ffprobe` for the generated-media integration case. The media command fails when binaries are not explicitly supplied. `pnpm desktop:tauri:parity` still reports incomplete parity; it is not a success-count shortcut. Benchmark collection remains an open command-interface requirement.
