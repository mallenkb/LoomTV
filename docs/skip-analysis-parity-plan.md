# LoomTV Automatic Skip Analysis — Intro Skipper Parity (Revised)

## At a glance

- Reach functional parity with [Intro Skipper](https://github.com/intro-skipper/intro-skipper)
  through a clean-room LoomTV implementation. Its repository and wiki are the
  behavioral specification only; no GPLv3 source is copied, translated,
  linked, or shipped.
- Build on the shipped skip-segment system (providers, chapters, manual
  editor, Chromaprint local analysis, idle scheduler) rather than replacing
  it. Detector precedence stays: manual → chapter → AniSkip/TheIntroDB →
  local audio/visual.
- Deliver in three phases, highest value first:
  - **Phase A** — analyze new/changed files immediately after every library
    scan, with durable jobs and a visible status surface.
  - **Phase B** — detection quality: intro boundary snapping, adaptive
    black-frame and non-black credit cards, recap/preview local windows,
    per-season overrides and exclusions.
  - **Phase C** — the timestamp manager UI, bulk operations, and a trimmed
    settings surface.
- Several Intro Skipper features are **deliberately deferred or cut** (see
  §7): the commercial segment type, the recurring full-maintenance timer, the
  decoded-audio extract cache, user-editable chapter regexes, and preview
  generation from after-credits scenes.
- All existing protections are preserved: background work runs only while
  idle and on AC power, pauses immediately for playback/transcoding, uses one
  below-normal-priority worker, and never modifies media files.
- Manual corrections always survive automatic analysis and continue to
  support undo. Review-state candidates never surface in playback until
  approved.

## Decisions carried in from review

These resolve conflicts between raw Intro Skipper parity and shipped LoomTV
behavior. They are decisions, not open questions:

1. **No recurring full-maintenance cycle.** Recomputing markers over
   unchanged files with an unchanged configuration hash produces identical
   results. Intro Skipper needs scheduled tasks because Jellyfin's task
   scheduler is its only trigger; LoomTV has scan hooks. Re-analysis triggers
   are exactly: file revision changed, configuration hash changed, season
   incomplete (`waiting_for_peers`), or an explicit manual run. A manual
   "Run full analysis now" action exists and respects playback safety.
2. **No `commercial` segment type in this plan.** It would force
   constraint-changing table rebuilds, IPC/LAN contract changes, and player
   changes on both platforms — and current clients render unknown types
   badly (the mobile player would show "Skip undefined"). Prerequisite work
   is included instead: both players must ignore segment types they do not
   recognize, so a future type addition is a data change, not a lockstep
   deploy. The type itself waits for evidence anyone has chapter-marked
   commercial content.
3. **No decoded-audio extract cache.** The expensive artifact is the
   fingerprint, which is already cached indefinitely per file revision.
   Decoding an analysis window takes seconds, and intro/credits windows do
   not overlap, so there is nothing to share. Cut entirely.
4. **Duration limits do not change for existing installs.** Shipped limits
   (intro 15–180 s, credits 15–300 s, movie credits up to 900 s) remain the
   defaults everywhere. Intro Skipper's tighter 120 s intro cap would drop
   currently-valid markers (combined cold-open + OP intros exceed it).
   Per-type limits become configurable (§4) and participate in the
   configuration hash, but no upgrade may silently invalidate a library's
   markers via changed defaults.
5. **The overlap guard applies to local detection only.** Verified provider
   data contains legitimate cross-type overlaps (Demon Slayer S1E1: intro
   21:10–22:40 overlapping credits 21:40–23:35 — both correct). The guard
   prevents the local credits-window match from claiming the intro's audio
   and vice versa; it never suppresses provider, chapter, or manual markers.
6. **Chapter patterns are anchored whole-label matches, not free regexes.**
   The shipped anchored-label design exists precisely to reject substring
   false positives ("Opening scene"). The pattern set is extended (§2) but
   remains internal; labels are normalized and matched whole. A user-editable
   regex editor is deferred (§7).
7. **Rollback compatibility is preserved.** The original skip-marker plan
   required additive-only migrations so a rolled-back binary reads the DB.
   This plan keeps that: all new tables and columns are additive, no CHECK
   constraints are rebuilt, and no new enum values are written (a consequence
   of decision 2).

## 1. Phase A — Incremental analysis, durable jobs, and status

### New- and changed-content detection

- Hook an analysis coordinator into `saveLibraryFromScan`. Capture the
  previous library snapshot before saving the scan result and diff stable
  file revisions (path, size, modification time, duration, selected audio
  track — the existing `fileRevision` identity).
- Enqueue only added or changed episode/movie revisions, at the highest
  automatic priority.
- For a new episode:
  - Generate fingerprints only for the new revision.
  - Load cached fingerprints for neighboring episodes (±4, as today).
  - If a neighbor's fingerprints are missing, generate the minimum reference
    fingerprints needed **without rewriting that neighbor's markers**.
  - Persist marker candidates only for the new or changed revision.
- If a season has fewer than three usable episodes, run chapter and visual
  detection immediately and record the Chromaprint job as
  `waiting_for_peers`; the arrival of a third episode re-queues it.
- Removed files trigger cleanup of orphaned candidates, fingerprints, and
  job state (extending the existing bounded orphan cleanup).
- No live filesystem watcher; detection occurs after successful startup,
  automatic, or manual library scans.

### Durable jobs and scheduling

- Add additive tables:
  - `segment_analysis_jobs` — durable queue rows for incremental, manual,
    and cleanup jobs. Unique job key = job kind + media scope + file
    revision + configuration hash, so repeated scans are idempotent.
  - `segment_analysis_inventory` — per-revision record of last configuration
    hash, fingerprint algorithm version, and analysis timestamps. This is
    what makes "due" a derived property instead of a timer.
- The existing `segment_analysis_state` table remains for compatibility;
  the existing season-analysis IPC method continues to work as a wrapper.
- Queue check cadence and runtime protections are unchanged from the shipped
  scheduler: once per minute; run only on AC power, after five minutes of
  system idle, with no playback/transcoding activity and at least one minute
  since the last playback activity. Playback immediately terminates active
  FFmpeg/fpcalc work and returns the job to the queue; completed fingerprint
  windows stay cached.
- Job priority: manual scope scan → new/changed content → incomplete season
  (`waiting_for_peers`) → configuration-hash recompute → cleanup.
- One background worker, below-normal priority. A 1–4 concurrency setting is
  deferred until a library demonstrably needs it (§7).
- Configuration changes that affect marker selection enqueue a
  hash-recompute pass that **reuses cached fingerprints**; only sample-rate,
  channel-layout, or Chromaprint algorithm changes invalidate fingerprints
  (extraction is versioned separately from selection, as today).
- Restart recovery: pending job rows survive; on startup the coordinator
  resumes the queue.

### Status surface

- IPC additions: analysis status (current job, progress, pending count,
  recent errors), run-now for library/season/item, cancel, pause/resume,
  and cache cleanup.
- Settings → Status section shows the current job, pending items, last
  completed pass, errors, helper availability (`fpcalc`/FFmpeg discovery),
  and fingerprint cache usage.
- Structured local logs for job duration, cache hit rate, detector results,
  pause reasons, and failures — never recording media-derived fingerprint
  contents. Analysis remains fully local; nothing is uploaded.

### Client type-tolerance (prerequisite for any future type)

- Desktop and mobile players filter segment payloads to known types before
  rendering, with a shared label map fallback of "Skip" for anything
  unexpected that slips through.
- The LAN segments endpoint remains type-agnostic; tolerance lives in the
  clients.

## 2. Phase B — Detection quality

### Chapter detection

Extend the anchored, normalized label sets (matched whole, case-insensitive,
never substrings):

- Introduction: intro, introduction, opening, op.
- Credits: credits, end credits, ending, ed, outro.
- Preview: preview, pv, sneak peek, coming up, next episode,
  next episode preview.
- Recap: recap, previously, previously on, summary, last episode.

Chapter candidates keep confidence 0.98 and file-release scoping.

### Boundary refinement (the highest-value quality item)

Today only credits get silence/black-frame refinement; intro edges come raw
from fingerprint frame medians. Add snapping for all locally detected
boundaries:

- Candidate boundary sources: chapter marks, silence intervals
  (`silencedetect`), and container keyframes near the proposed edge.
- Search five seconds inward and two seconds outward of the proposed
  boundary.
- Select the nearest valid boundary; ties prefer chapters, then silence,
  then keyframes.
- Snap to media start/end when within two seconds.
- Store the original boundary and the snapping decision in candidate
  metadata (`analysis_metadata_json`, additive column) for the status UI
  and future tuning.
- Credits keep the existing rule that silence and black-frame signals must
  agree within five seconds before the fingerprint result is moved.

### Black-frame and credit-card detection

- Preserve the existing movie credits detector and its post-credit-scene
  handling (multiple non-overlapping credits intervals).
- Add adaptive thresholds derived from sampled episode luminance instead of
  fixed constants (defaults: 85 % dark pixels, brightness threshold 28).
- Add entropy/saturation classification so white, grey, and muted-color
  credit cards are recognized, not just black cards.
- These remain refinement/fallback signals. `blackframe` is recorded as
  detector provenance in candidate metadata — not a new competing source in
  the precedence order.

### Local recap and preview windows

- Extend local analysis beyond intro/credits: a recap window at the episode
  head (before/around the intro window) and a preview window at the tail,
  using the same cross-episode matching, thresholds, and review gating.
- Duration rules: recap 15–120 s, preview 15–120 s (configurable, in the
  configuration hash).
- Fingerprint storage extends to the new windows additively; existing
  intro/credits cache rows are untouched.

### Anime handling

- OP/ED/PV chapter aliases (covered by the chapter sets above).
- Optional first-episode intro suppression (off by default — verified real
  data shows episode-1 OPs at nonstandard positions are often correct).
- Per-series anime override and per-season detector overrides.
- Season 0 (specials) analysis disabled by default.

### Exclusions and overrides

- Excluded series IDs, movie IDs, seasons, and normalized filesystem paths.
- Per-season analysis mode override (chapter-only / providers-only / full).
- Exclusions are respected by scan-diff enqueueing, manual runs, and
  cleanup alike.

## 3. Phase C — Management UX

### Settings — "Automatic Skip Analysis"

Deliberately smaller than Intro Skipper's surface. Exposed:

- Enable analysis; analyze new media automatically.
- Enabled segment types (intro/recap/credits/preview toggles for playback
  prompts remain where they are today).
- Per-type duration limits (defaults per decision 4).
- First-episode suppression and Season 0 handling.
- Exclusions management.
- Status section and actions: run now, scan a season, pause/resume, cancel,
  clear stale cache, rebuild all markers.

Kept internal (constants in the configuration hash, not UI): analysis window
percentages, silence/black-frame thresholds, snapping distances, chapter
label sets, concurrency, FFmpeg thread/priority tuning, cache compression.

Settings migrate from `localSkipAnalysisEnabled` into a normalized
`skipAnalysis` object; existing installations keep current behavior and
duration limits exactly.

### Timestamp manager

Grouped by library → show → season → episode, plus movies:

- Display each marker's source, confidence, status (active/review), timing,
  and detector provenance (including snapping decisions).
- Preview an interval before saving.
- Add, edit, delete, reject, restore, and change segment type.
- Multiple credits intervals supported (post-credit scenes).
- Bulk season operations: rescan, erase markers, exclude, set override.
- Review-state candidates are approved or rejected here; they never appear
  in playback until approved.

### Player integration

- The in-player marker editor gains reject/restore and shows provenance.
- Skip prompt labels stay contextual (Skip Intro / Skip Recap / Skip
  Credits or Outro / Skip Preview).

## 4. Persistence and migration rules

- All migrations are **additive**: new tables (`segment_analysis_jobs`,
  `segment_analysis_inventory`), new nullable columns
  (`analysis_metadata_json` on candidates), new fingerprint window rows.
  No table rebuilds, no constraint changes, no new segment-type enum values.
- All manual history, provider cache, fingerprints, and resolved markers
  remain readable by the previous app version after a rollback.
- Candidate rows gain detector provenance, confidence components,
  peer-support count, original boundaries, and snapping decisions inside
  `analysis_metadata_json`; the typed columns are unchanged.
- Indexes: pending-job priority, inventory revision lookup, season analysis
  lookup.

## 5. Cache lifecycle

- Compressed Chromaprint fingerprints are retained indefinitely while their
  file revision remains current (unchanged from today).
- Orphaned fingerprints and job rows are removed after library scans in
  bounded batches, and by the manual cleanup action.
- Fingerprint extraction versioning is independent of marker-selection
  versioning: selection changes reuse fingerprints; extraction changes
  invalidate only incompatible fingerprint rows.

## 6. Test and acceptance plan

Add tests (created during implementation; executed only when explicitly
authorized — static inspection and diff validation remain allowed) for:

- Additive migration: existing candidates, segments, fingerprints, and
  manual history intact; old-binary readability of the migrated schema.
- Scan diffing: one added episode queues exactly one job and leaves existing
  markers byte-identical; a changed file invalidates only itself.
- Restart recovery and job idempotency via unique job keys.
- Incremental-job priority over hash-recompute and cleanup jobs.
- `waiting_for_peers`: <3-episode fallback, and re-queue on the third
  episode's arrival.
- Fingerprint reuse across configuration-hash recomputes; invalidation on
  extraction-version change only.
- Anchored chapter label acceptance for all four types; substring rejection.
- Local-only overlap guard: provider cross-type overlaps preserved
  (Demon Slayer S1E1 fixture), local credits-window claims on intro audio
  rejected.
- Boundary snapping: chapter/silence/keyframe preference order, inward and
  outward limits, start/end snap.
- Adaptive black-frame and non-black credit-card fixtures (white, grey,
  muted-color cards; post-credit scenes; multiple credits blocks).
- Recap/preview local windows with cold opens and absent segments.
- Exclusions, Season 0 default-off, first-episode suppression off by
  default, per-season overrides.
- Playback/transcoding pause, job return-to-queue, and automatic resume.
- Client type-tolerance: both players ignore unknown segment types.
- IPC authorization and `skipAnalysis` settings normalization/migration.
- Packaged FFmpeg, ffprobe, and fpcalc discovery on supported platforms.
- Performance fixture: incremental analysis decodes only the new item when
  peer fingerprints are cached.

Acceptance criteria:

- A completed library scan queues only added or changed files, and the new
  file's markers exist without any user action.
- Existing episode markers are never rewritten by an incremental job.
- Playback never competes with background analysis.
- Manual corrections always survive automatic analysis.
- No original media files are modified.
- A rolled-back previous version reads the migrated database.
- Marker quality on the curated corpus does not regress relative to the
  shipped detector (zero new false-positive auto-published markers).
- No Intro Skipper GPL source is copied, translated, linked, or shipped.

## 7. Deferred / cut (with re-entry conditions)

| Item | Status | Re-entry condition |
|---|---|---|
| `commercial` segment type | Deferred | Real chapter-marked commercial content in user libraries; client type-tolerance (Phase A) already shipped |
| Recurring full-maintenance timer (24–168 h) | Cut | A concrete failure mode that scan/config/manual triggers cannot cover |
| Decoded-audio extract cache (1 GB LRU) | Cut | Evidence that window re-decoding is a measured bottleneck |
| User-editable chapter regex patterns | Deferred | Repeated user requests the anchored label sets cannot satisfy; must keep whole-label anchoring |
| Preview generation from after-credits scenes | Deferred | Demand signal; niche |
| Analysis concurrency setting (1–4 workers) | Deferred | A library where one worker measurably lags scan cadence |
| Settled-season re-analysis timer | Cut | Covered by scan-diff + `waiting_for_peers` re-queue |

## Assumptions

- Intro Skipper's public repository and wiki (general settings, analysis
  rules, playback refinement, scheduled tasks) are the behavioral
  specification; implementation is clean-room under LoomTV's existing
  licensing model.
- New-content detection runs after successful startup, automatic, or manual
  library scans; no live filesystem watcher.
- Background analysis remains local and never uploads fingerprints or any
  media-derived analysis data.
