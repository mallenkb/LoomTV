# LoomTV Hybrid Skip-Marker Implementation Plan

## Scope

Skip markers cover TV and anime episodes only. Movies are explicitly out of
scope for both phases: TheIntroDB is a TV database, AniSkip is anime-only, and
local analysis depends on cross-episode repetition that movies do not have.
This is a decision, not an omission; revisit only if a credible movie-credits
source appears.

## 1. Architecture and data contracts

Build a desktop-owned marker service used by both players. Source resolution is
deterministic and keys off the source ordering below — never off confidence
values. Confidence is stored provenance metadata for display and review
thresholds; two implementations must not exist where one compares confidence
numbers to pick a winner, or a future high-confidence Chromaprint marker could
accidentally outrank a provider marker:

```text
Manual correction
→ explicitly named embedded chapter
→ duration-compatible TheIntroDB/AniSkip marker
→ high-confidence local Chromaprint marker
→ no marker
```

Playback starts independently and never awaits provider requests, analysis, or
marker writes. A segment lookup may finish later and update the skip UI, but it
cannot delay stream creation or first frame.

Use milliseconds throughout. All stored marker times are **absolute media
time** — see “Playback clock mapping” below for how players translate them:

```ts
type MediaSegmentType = 'intro' | 'recap' | 'credits' | 'preview';

type MediaSegmentSource =
  | 'manual'
  | 'chapter'
  | 'theintrodb'
  | 'aniskip'
  | 'chromaprint';

interface MediaSegment {
  id: string;
  type: MediaSegmentType;
  startMs: number;
  endMs: number | null;
  confidence: number;
  source: MediaSegmentSource;
  mediaDurationMs: number;
  updatedAt: string;
}
```

Expose:

```ts
interface MediaSegmentRequest {
  mediaId: string;
  season?: number;
  episode?: number;
}

interface MediaSegmentResponse {
  segments: MediaSegment[];
  revision: string;
}
```

- Desktop reads through IPC.
- Mobile reads through an authenticated LAN endpoint.
- Desktop alone receives save, delete, undo, and reset-to-automatic operations.
- Renderers and mobile never call external providers or access file paths directly.

Add additive SQLite tables:

- `segment_source_cache`: positive/negative provider responses and expiration.
- `media_segment_candidates`: normalized candidates, provenance, confidence, status, and file variant.
- `media_segments`: resolved markers used by playback.
- `segment_manual_history`: previous manual values.
- Phase two adds `media_fingerprints` and `segment_analysis_state`.

Candidate updates and effective-marker resolution occur in one short transaction. Provider refreshes replace only their own candidates and cannot overwrite manual corrections.

Use two file identities:

- Automatic cache identity: canonical path, size, modification time, duration, and audio stream.
- Manual release identity: duration, size, stream metadata, and lightweight hashes of the file’s beginning/end, calculated only when editing or analyzing.

Note: `episode_files` currently keys on path only and stores no size,
modification time, duration, or audio-stream identity. The automatic cache
identity therefore requires new data collection during scans, not just a new
table. Collect these fields from data the scan already has (stat results and
the existing probe output) so the scan path gains no new I/O; this addition is
covered by the first-frame/scan regression gates in section 5.

This keeps scanning inexpensive, detects replaced releases, and allows manual markers to survive simple file moves. Changed releases retain corrections as “needs review” rather than applying potentially incorrect timestamps.

### Playback clock mapping

Markers are stored in absolute media time, but under offset-seek transcoding
and HLS the player’s reported position may be relative to the seek point
rather than the start of the file. Before wiring any skip UI, each player must
expose a single documented function mapping player position → absolute media
time (and its inverse for seeks), verified against direct play, remux, HLS,
and offset-seek transcode on both desktop and mobile. Both the skip-button
visibility check and the seek-to-`endMs` action go through this mapping only.
This is a design deliverable of the player-integration step, not something
left to the test matrix to discover.

## 2. Phase One — Providers, chapters, manual editing, and players

### Provider verification (gating pre-work)

Two assumptions must be verified against live services before building on
them, as the first task of this phase:

- **TheIntroDB**: confirm the API contract, that public lookups require no API
  key, rate-limit behavior, and sample coverage across a handful of
  representative library shows. It is a young community database; if coverage
  proves thin, phase one still ships for anime and TheIntroDB remains a
  best-effort source. Set expectations accordingly: phase one mostly benefits
  anime, and regular TV gets most of its real value from phase two.
- **AniSkip**: confirm marker-type semantics and that lookups key on MAL ID +
  episode number of that MAL entry.

The adapters must degrade to an empty result when a provider is unreachable,
empty, or has changed shape — never a player error.

### Season-to-MAL-ID mapping (gating design item)

This is the highest-risk item in phase one and gates enabling AniSkip.

Today, Jikan resolution produces a single MAL ID per show at classification
time, `malId` is not persisted in `providerIds`, and no per-season mapping
exists. MAL splits shows per cour while western naming uses S1/S2/Part N, and
AniSkip is keyed by MAL ID + episode number of that specific MAL entry.
Critically, the duration-compatibility gate cannot catch a wrong-season
mapping — episodes of one series have near-identical durations and intro
offsets — so a wrong mapping yields plausible-but-wrong markers, exactly the
failure mode this plan is designed to avoid.

Requirements:

- Persist `malId` in `providerIds` alongside TMDB, TVDB, and IMDb IDs.
- Build an explicit season → MAL-ID mapping, using Jikan relation traversal
  and/or an offline community mapping source (e.g., the anime-lists
  TVDB-season → MAL tables), with the choice made after evaluating both.
- When no confident season mapping exists, skip AniSkip lookups for that
  season entirely rather than guessing.
- Cover multi-cour, split-season, and “Part 2” naming in tests before AniSkip
  is enabled by default.

### Metadata and provider routing

Routing:

- Regular TV: TheIntroDB.
- Anime: AniSkip for opening, ending, and recap.
- For anime, query TheIntroDB only for marker types missing from AniSkip and only when suitable IDs exist.
- Public lookups require no API key (verified above); do not add API-key settings in this phase.

Normalize:

- AniSkip `op` and `mixed-op` → `intro`.
- AniSkip `ed` and `mixed-ed` → `credits`.
- AniSkip `recap` → `recap`.
- TheIntroDB types map directly.
- Credits with no end timestamp use `endMs: null`.

Reject results when:

- Values are missing, non-finite, negative, reversed, or outside the file.
- The source duration differs from the local duration by more than `max(30 seconds, 2%)`.
- The resulting marker is shorter than one second.
- Multiple same-source markers conflict without a clear valid interval.

Deduplicate overlapping same-type candidates. Provider confidence defaults to `0.92`.

### Fetching and caching

Run provider clients in the desktop main process using native `fetch`:

- Three-second timeout.
- Maximum two external requests per marker resolution (one episode’s lookup);
  prefetch issues its own per-episode resolutions, serialized by the per-host
  limit below.
- Maximum one active request per provider host.
- Single-flight deduplication by lookup key.
- No immediate retries.
- Respect `Retry-After`.
- Cap response size before parsing.

Cache policy:

- Successful result: 14 days.
- Confirmed no-result: 12 hours.
- Serve stale successful results for up to 90 days during outages.
- Cache provider IDs, season, episode, requested types, and rounded duration—not file paths.

Trigger low-priority prefetch when:

- A series page opens: current and next two episodes.
- Playback opens: current and next two episodes.
- A watched/recent episode’s cache expires.

On a warm hit, return immediately. On a miss, start playback and marker resolution in parallel. The marker request joins the single-flight provider lookup, persists the result, and updates the UI if it finishes while the episode is playing. Failure returns an empty segment list without displaying a player error.

Do not fetch providers during library scanning, FFprobe, HLS creation, transcoding, or first-frame preparation.

### Embedded chapters

Add `-show_chapters` to the existing scan-time per-file FFprobe invocation in
`mediaProbeFile.ts`; do not create another process. (The repo has two probe
call sites — `mediaProbe.ts` and `mediaProbeFile.ts`; only the scan-time
per-file probe gains chapters, keeping the “no additional FFprobe process”
gate measurable.)

Accept only anchored, normalized labels:

- Intro: `intro`, `introduction`, `opening`, `op`.
- Recap: `recap`, `previously on`.
- Credits: `credits`, `end credits`, `ending`, `ed`.
- Preview: `preview`, `next episode`, `next episode preview`.

Ignore generic chapter names and substring matches. Valid explicit chapter candidates receive confidence `0.98` and resolve before providers because they describe the exact file release.

### Desktop manual editor

Add a player control that opens a compact editor:

- Choose intro, recap, credits, or preview.
- Capture start/end from the current position.
- Enter exact timestamps when desired.
- Allow “through end” for credits.
- Preview the proposed skip.
- Save, delete, undo, or reset to automatic.
- Display source, confidence, and update time.

Manual candidates receive confidence `1.0` and apply only to the matching file release. Both desktop and mobile consume the correction immediately from the desktop marker service.

### Player integration

- Extend desktop and mobile play targets with media ID, media type, season, and episode.
- Fetch markers independently from stream preparation.
- Reuse existing playback-position state and seek functions, routed through
  the playback clock mapping (section 1) so all comparisons happen in absolute
  media time.
- Add no polling loop, extra media-time subscription, or animation-frame loop.
- Cancel or ignore stale responses when the episode changes.
- Display the skip button only while the current position is within the segment.
- Finite markers seek to `endMs`.
- Open-ended credits seek to the existing completion tolerance; next-episode remains a separate action.
- Preserve existing transcoded-seek behavior.
- Auto-skip remains out of scope.

Defaults:

- Intro, recap, and credits enabled.
- Preview disabled.
- Provider failures silent in the player.
- Provider status and last refresh visible in diagnostics/settings.

### Cleanup and compatibility

- Keep provider cache across library rebuilds.
- Re-associate effective markers after a scan using episode/file identities.
- Clean orphaned automatic markers in bounded batches after successful scans.
- Retain manual history for missing files so temporary drive disconnection does not erase corrections.
- All migrations are additive and safe to leave during rollback.

## 3. Phase Two — Optional local Chromaprint fallback

### Helper evaluation and packaging

**First task of phase two: evaluate stock `fpcalc` before building a custom
helper.** Chromaprint ships prebuilt `fpcalc` binaries for macOS, Windows, and
Linux, and it can emit raw fingerprint frames. The open questions are whether
it can consume pre-decoded PCM windows piped from the existing FFmpeg binaries
(rather than decoding whole files itself) and whether its output covers the
matching needs below. If stock `fpcalc` suffices, adopt it and skip the custom
helper entirely — the packaging, signing, pinning, and per-platform CI cost of
a bespoke native binary is substantial and ongoing.

Only if `fpcalc` proves insufficient, implement a small LoomTV-owned
`loom-fingerprint` executable around the Chromaprint C API:

- Input: signed 16-bit mono PCM over stdin.
- Output: versioned raw fingerprint frames as bounded JSON.
- Dynamically link a pinned Chromaprint library.
- Use vDSP on macOS and bundled KissFFT on Windows/Linux.
- Do not use FFTW.
- Package the helper and shared library alongside FFmpeg and verify them in installer builds.

Either way, continue using existing FFmpeg binaries for audio decoding; do not require custom Chromaprint-enabled FFmpeg builds.

Use [Jellyfin Intro Skipper](https://github.com/intro-skipper/intro-skipper) only as an architectural reference because it is GPL-3.0. Do not copy its source, tests, assets, constants, or database implementation.

Follow the [Chromaprint licensing requirements](https://github.com/acoustid/chromaprint/blob/master/LICENSE.md), including notices and corresponding-source/relinking obligations. Complete a distribution review before enabling packaged local detection.

### Bounded analysis

Analyze TV/anime episodes only:

- Intro window: first `min(10 minutes, 25% of duration)`.
- Credits window: final five minutes.
- Selected/default audio stream only.
- Decode as mono 11,025 Hz PCM.
- Pipe directly to the helper without temporary audio files.
- Do not locally detect recaps or previews initially.

Cache compressed fingerprints by:

- Automatic file identity.
- Audio stream index and language.
- Analysis window.
- Sample rate and Chromaprint algorithm.
- Detector version.

Marker-scoring changes reuse fingerprints. Only media/audio changes require decoding again.

### Matching and confidence

- Require at least three usable episodes.
- Compare an episode with at most four previous and four following episodes.
- Use local alignment over raw Chromaprint frames and normalized bitwise Hamming similarity.
- Require mean similarity of at least `0.85`.
- Intro matches must last 15–180 seconds.
- Credits matches must last 15–300 seconds.
- Require support from at least three episodes.
- Cluster by fingerprint content so mid-season theme changes are supported.
- Allow different offsets per episode so cold opens work.

Confidence:

```text
0.60 × median fingerprint similarity
+ 0.25 × min(1, supporting episodes / 5)
+ 0.15 × duration consistency
```

Duration consistency declines from `1` to `0` as median absolute duration deviation rises from zero to five seconds.

- `≥ 0.90`: publish as fallback.
- `0.80–0.89`: retain for desktop review.
- `< 0.80`: discard.

Published Chromaprint markers participate in resolution strictly by source
order (below providers), regardless of confidence value. False negatives are
preferable to false-positive skips.

For accepted credits, run silence and black-frame detection only within ±15 seconds of the proposed boundary. Refine the boundary only when both signals agree within five seconds; otherwise retain the fingerprint result.

### Scheduling and playback protection

Local detection is disabled by default.

When enabled:

- Provide `Analyze season`.
- Schedule unresolved episodes after five minutes of system inactivity.
- Scheduled work runs only on AC power.
- Use one worker with below-normal priority where supported.
- Never start during scanning, playback, direct streaming, HLS, or transcoding.

Extend the existing media-process governor:

- Desktop player holds an IPC playback-activity lease.
- LAN direct streams hold a lease for the HTTP response lifetime.
- Existing FFmpeg tracking covers HLS/transcoding.
- Playback immediately terminates active analysis processes.
- Completed fingerprint windows remain cached.
- Interrupted jobs return to the persistent queue.
- Resume only after 60 seconds without playback activity.

If the helper is absent or incompatible, disable local analysis and expose a diagnostic. Playback and provider markers continue normally.

## 4. Implementation sequence and release gates

1. Verify TheIntroDB and AniSkip API contracts against live services; design
   the season-to-MAL-ID mapping (Jikan relations vs. offline mapping source)
   and the playback clock mapping for both players. These three items carry
   the least-verified assumptions and gate everything downstream.
2. Add shared types, additive migrations, candidate resolution, and file identity.
3. Persist MAL IDs (including per-season mapping) and implement both provider adapters.
4. Add caching, rate limiting, background prefetch, and diagnostics.
5. Add chapters to the existing scan-time probe and candidate resolver.
6. Add desktop IPC, authenticated LAN reads, and mobile play-target identity.
7. Add desktop/mobile skip controls using existing seek paths via the clock mapping.
8. Add the desktop manual editor and history.
9. Ship phase one behind a marker feature flag, then enable it by default after verification. AniSkip stays disabled until the season-mapping test suite passes.
10. Evaluate stock `fpcalc`; build and package the custom Chromaprint helper only if `fpcalc` is insufficient.
11. Add fingerprint caching, matching, scheduler, and analysis settings.
12. Ship phase two as opt-in/experimental until its false-positive release gate is met.

Existing uncommitted mobile and installer changes are user-owned. Implementation must inspect and patch them narrowly rather than replacing or reverting them.

## 5. Verification and acceptance

Add automated coverage for:

- Provider normalization, malformed responses, duration mismatches, timeouts, rate limits, negative caching, stale fallback, and request deduplication.
- Season-specific MAL IDs, including multi-cour, split-season, and “Part N” naming, and the skip-lookup behavior when no confident mapping exists.
- Deterministic source precedence, including that resolution ignores confidence values across sources.
- Playback clock mapping: absolute-time correctness under direct play, remux, HLS, and offset-seek transcode on both players.
- Chapter-name acceptance and generic chapter rejection.
- Manual save, preview, undo, reset, file replacement, and scan persistence.
- SQLite migration, transactions, orphan cleanup, and rollback compatibility.
- Desktop IPC and authenticated LAN access.
- Desktop/mobile direct, remux, HLS, and transcoded playback.
- Rapid episode changes, late marker responses, manual seeking, track changes, and next-episode behavior.
- Chromaprint fixtures with cold opens, multiple themes, dubbed audio, no repeated segment, short seasons, and misleading repeated dialogue.
- Analysis interruption by desktop playback, LAN streaming, and transcoding.
- Helper discovery, shared-library loading, notices, and packaging on every supported platform.

Release criteria:

- Playback never waits for provider or analysis work.
- No additional FFprobe process per file.
- Warm marker retrieval uses one indexed SQLite read.
- No full-video local decoding.
- No unbounded season-wide pair comparison.
- Provider outages cause no player error or request storm.
- First-frame p95 regression stays below 50 ms or 2%, whichever is larger; library scan time shows no measurable regression from identity collection.
- The curated local-detector corpus has zero false-positive auto-published markers.
- Manual corrections always override automatic data and survive provider refreshes.
- AniSkip is not enabled by default until the season-mapping suite has zero wrong-season marker publications on the test corpus.

Tests should be created during implementation but run only when explicitly requested. The plan is based on static repository inspection and official upstream documentation; no runtime or visual verification has been performed, and the TheIntroDB/AniSkip API assumptions in section 2 remain unverified until step 1 of the implementation sequence.
