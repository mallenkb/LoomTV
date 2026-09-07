# Desktop port status

Updated 2026-09-07. Full desktop parity is incomplete. The port is not a replacement for Electron and is not ready for a production release. Work stays on `codex/tauri-react-port`. Electron, NAS, mobile and TV default commands remain unchanged. No merge, release, installer publication or live-data migration was performed.

## Implemented in this pass

Starting branch snapshot: `3830a65cb9897345b0e050c7451578e92cf2189d`.

- `3d04a0eeee8822d7d1a898eb29f2f84766ab76f6`: local HLS fallback, normalized probing, command wiring and repaired pnpm lockfile.
- `e25338f697118f6cfcffc0460766680b3b6b47c6`: asynchronous event transport cleanup, eight transport regression tests and explicit test commands.
- `ad20b003a2dd6aea1b7b96e5db0fcae628b3e38a`: fresh-scan catalog crash, conservative content-rating checks, real scan-to-playback regression and strict Rust lint fixes.

`media:probe`, `media:can-direct-play`, `media:start-transcode`, `media:stop-transcode`, and forced `media:get-stream-url` now use the normalized probe and owned local HLS service. The incomplete transcode placeholders previously prevented compilation. The probe response now matches the renderer fields instead of returning raw ffprobe JSON.

The local HLS service owns FFmpeg processes and output directories, drains output, generates bounded seek windows, validates stream indices and segment names, scopes sessions to the active profile revision, and revalidates streamed chunks. GET/HEAD, byte ranges, forged Host rejection, cache/session limits, revocation and shutdown are covered by service tests. This does not establish remote transcode, IPTV, browser rendering or native LibVLC parity.

A fresh scan exposed a panic in `catalog::Store::card`: the code indexed a missing optional `localMetadata` key. Freshly discovered videos commonly have no probe metadata. The compact card builder now reads optional duration safely. Movie and episode regression cases preserve playback references and omit full detail data.

Both Rust provider paths now share 92 country/code rating mappings checked against Electron fixtures. Unknown nonnumeric codes remain unrated, not age zero. Authorization corrects old stored underestimates on read without writing a migration or relaxing a stricter recorded age. See `security-review.md`.

The transport handles pending listener removal, duplicate registration, failed registration, disposal, late replies, malformed events and failing native cleanup. React components were not rewritten.

The missing Tauri pnpm importer and dependencies were generated with pnpm 11.20.0. Every existing workspace importer was compared and remained unchanged. Frozen installation succeeds. Rust is pinned to the 1.98.0 toolchain used by the recorded checks.

## Executed evidence

| Source and run | Executed result |
| --- | --- |
| `e25338f`, run `34089977335`, job `101641310441` | Frozen install, unchanged existing workspace dependency selections, workflow policy and eight transport tests passed. Five initial Rust unit tests and a separate generated-media test passed. |
| `7ab2267`, run `34090438700` | Both desktop TypeScript checks, React production build, frozen install, workflow policy and eight transport tests passed. macOS adapter compiled with staged runtimes. Its strict core lint gate failed; the later hardening change fixed those failures. |
| Patch committed as `ad20b00`, run `34092078082`, job `101647508196` | Eleven Rust unit tests passed. One separately executed generated-media integration test passed with zero ignored. Strict core/playback Clippy with `-D warnings` passed. Rust formatting was applied. |

The final generated-media case uses an actual filesystem scan, not a manually inserted catalog entry. It generates a Unicode-named movie, checks its compact index and detail response, rescans, disconnects the root, and verifies stable identity, manual title, playback progress and watchlist retention. After reconnecting the root it checks normalized probing, real MPEG-TS output, a seek outside the initial encoder window, suffix/partial/invalid ranges, HEAD headers with an empty body, invalid segment names, forged Host rejection, session reuse, profile-lock revocation, output removal and shutdown.

No installed application, private provider credential, user media or production database is used by these tests. The external-tool test is ignored in the unit-test invocation and then executed explicitly with trusted FFmpeg/ffprobe paths. `loomtv-playback` itself still has zero native unit tests; its compilation does not verify LibVLC behavior.

Hardening artifact `10007229673`, `tauri-hardening-e8bb70ea8f127321cf0073e1f2fb6871006931f4-1`, contains logs, source and the exact verified patch. Patch SHA-256: `108b3e384d9f8646927dd86701240d39271254a5824dc5a412384687dcdea0b7`. That patch was pushed as `ad20b00` and the remote ref was independently verified.

macOS compile evidence at `7ab2267`: macOS 26.6.2 arm64, Xcode 26.6, Rust 1.98.0, artifact `10006680023`. This was compilation, not native video verification. The permanent read-only workflow reruns checks on subsequent source/toolchain changes; read its results for the exact commit under review.

Temporary source-transfer workflows and files have been removed. The remaining Tauri workflow is read-only and does not publish releases. An earlier transfer job for `3d04a0e` failed at an informational command after successfully pushing; the push and test results were independently verified. The later `ad20b00` transfer corrected that logging issue.

## Storage and acceptance blockers

The inherited branch defaults to Electron's version-14 `LoomTV/loomtv.sqlite`. `LOOMTV_DATA_DIR` can select an isolated directory. The earlier live shared-database request conflicts with the supplied checklist's isolated-default and explicit-snapshot-import requirements. This remains unresolved. A backup marker is not proof that concurrent writers or credential migration are safe. Do not test this branch against the live Electron store.

Remaining implementation or acceptance gaps include desktop-hosted server parity; end-to-end NAS pairing/trust; remote/browser fallback parity; mpv; Stremio review/configuration/resource execution; automatic segment analysis; secondary metadata/artwork flows; secure storage import, credentials and coexistence; complete tray/OS behavior; signed updates; shared renderer/package extraction; Windows/Linux native composition; clean installation; accessibility; complete regression/security suites; benchmarks and soak tests. Existing handlers are not proof that these features are complete.

No actual WebView/native video/audio composition, fullscreen/sleep/monitor recovery, installer/update behavior or performance improvement was verified here. The required 50-cycle and two-hour native soak tests remain unexecuted. The full feature ledger, route inventory and source-delta review remain incomplete. No checklist-wide completion claim is justified.

## Test commands

`pnpm desktop:tauri:test` runs transport tests. `pnpm desktop:tauri:test:rust` runs Rust service tests. `pnpm desktop:tauri:test:media --ffmpeg /trusted/absolute/ffmpeg --ffprobe /trusted/absolute/ffprobe` runs the generated-media integration case and fails when explicit binaries are missing. `pnpm desktop:tauri:parity` still reports incomplete parity. Benchmark collection remains an open command-interface requirement.
