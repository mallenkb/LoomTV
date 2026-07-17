# Skip Analysis Performance Plan

Goal: make local skip-segment analysis substantially faster without changing
the detection algorithm or any accuracy threshold. Every detection decision —
the 11,025 Hz Chromaprint fingerprints, the intro/recap/credits/preview
windows, the ±4 neighbor radius, the ≥2 peer agreement, the 0.85/0.80/0.90
similarity and publication thresholds, boundary refinement, and the
visual-credits fallback — stays byte-for-byte identical.

## Corrected diagnosis (what the code actually showed)

The original proposal assumed episodes were being re-fingerprinted per job.
They are not: fingerprints are already cached in SQLite keyed by
`fileRevision + audioTrack + windowType + algorithmVersion:windowVersion`
(`media_fingerprints` / `media_auxiliary_fingerprints`), so repeat decodes
across jobs were already cache hits. The measured bottlenecks are different:

1. **The scheduler ran at most one job per 60-second tick.** A 200-episode
   library needed 200+ minutes of wall clock even when each job took seconds.
   This dwarfed every other cost.
2. **Manual scans sat behind the background gates** — the 60 s timer, the
   5-minute system-idle requirement, and AC power. A user-requested scan did
   not start until the machine had been untouched for five minutes.
3. **Per-episode jobs re-ran the season pipeline once per episode** — season
   context setup, matching, clustering, and the boundary-refinement FFmpeg
   probes for the target, N times per season instead of once.
4. **Fingerprint decodes ran strictly serially**, one FFmpeg→fpcalc pipe at a
   time, even though episodes are independent.

## Implemented changes

### 1. Continuous queue drain (biggest win)

`tick()` now drains the queue in a loop instead of running a single job and
waiting for the next 60-second tick. The 60 s timer remains only as a
heartbeat that re-checks eligibility (idle again, back on AC, playback
stopped). Gating is evaluated per job between jobs, so playback still
interrupts within one job as before.

### 2. Immediate manual scans

Eligibility is now per job kind:

- `manual` jobs run as soon as playback is inactive — no idle wait, no AC
  requirement, no timer wait. `enqueueScope()` and `resume()` kick the drain
  loop directly.
- `incremental` / `hash-recompute` / `cleanup` jobs keep the original
  protections: AC power, ≥5 min system idle, ≥60 s since playback activity.

If background jobs for the same season are already pending when a manual scan
triggers, they ride along in the same batch (the work is identical; running
it once serves both).

### 3. Season batching

The coordinator groups all pending jobs that share `mediaId + season +
configHash` and runs them as **one** season analysis
(`analyzeSeasonBatch`). The detector fingerprints the union of the requested
episodes ±4 neighbors once, matches each requested episode against its
neighbors, and publishes per requested episode. Results are identical to the
per-episode runs because matching inputs (windows, radius, thresholds) are
unchanged — the duplicated season setup and scheduling latency are what
disappear.

Failure isolation: an episode whose file vanished mid-batch errors
individually; the rest of the group completes. Interruption (playback,
pause) re-queues the group's jobs as `pending`; completed fingerprints are
already persisted, so the retry is cache-hits until the interruption point —
this is the "resume from the last completed phase" checkpoint behavior, and
it falls out of the existing fingerprint cache rather than new checkpoint
state.

### 4. Two-worker fingerprint pool

Inside the fingerprint phase, episodes are processed by a bounded pool of
**2** workers (`FINGERPRINT_WORKERS`). Each episode's windows stay serial
within a worker; the Chromaprint input for any given window is produced by
exactly the same FFmpeg invocation as before, so fingerprints are identical.
Matching and refinement remain serial. FFmpeg decode is itself multithreaded,
so the pool is capped at 2 to avoid thrashing NAS/spinning-disk reads and to
bound memory; raise the constant only with benchmarks in hand.

### 5. Phase-level progress

The season pipeline now reports `Fingerprinting X of N episodes` and
`Matching episode X of N` through both the `segment_analysis_state` rows and
the running job's detail (visible in the status surface / timestamp
manager). No ETA — on heterogeneous media an ETA is noise; counts are
honest.

## Deliberately deferred

- **Shared-window decode** (decoding the intro+recap head range or
  credits+preview tail range once and slicing). The tail windows use
  different `-ss` seek points, and FFmpeg seek behavior means the sliced PCM
  is not guaranteed bit-identical to a fresh per-window decode — which would
  silently change fingerprints. Do not implement without a regression test
  asserting fingerprint equality on real files between old and new decode
  paths. Expected win is also the smallest of the batch (windows only
  partially overlap).
- **48-hour reconciliation sweep timestamp.** Startup reconciliation is
  already deduplicated by the inventory table (only missing/stale revisions
  enqueue), and `docs/skip-analysis-parity-plan.md` explicitly decided
  against a recurring full-maintenance cycle. Persisting a sweep timestamp
  would save a stat-walk per launch — not worth new persistence yet.
- **Configurable worker count / higher parallelism.** Needs a benchmark
  harness first; see below.

## Verification

- Coordinator unit tests cover: manual jobs running while the system is not
  idle, background jobs still gated, season grouping producing one detector
  call per season, per-episode inventory completion, and multi-group drain in
  one tick.
- The detection math (`fingerprintMatcher`, `boundaryRefinement`,
  `movieCreditsDetector`, windows, thresholds) is untouched by this change;
  no detector test needed updating.
- Before raising `FINGERPRINT_WORKERS` or attempting shared-window decode:
  benchmark a real library (time per phase: fingerprint / match / refine) and
  add the old-vs-new golden test (identical published segments over a few
  seasons).
