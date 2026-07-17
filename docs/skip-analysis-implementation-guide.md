# Skip Analysis Implementation Guide (for the implementing agent)

Companion to [skip-analysis-parity-plan.md](./skip-analysis-parity-plan.md).
The plan says *what* to build; this document says *how* to build it in this
codebase without breaking it. Read both fully before writing code. When this
guide and the plan conflict, the plan's "Decisions carried in from review"
section wins.

---

## 0. Orientation — read these files first

| File | Role |
|---|---|
| `apps/desktop/src/main/skipSegments/service.ts` | Marker resolution service: context building, provider orchestration, prefetch, manual ops |
| `apps/desktop/src/main/skipSegments/localAnalysis.ts` | Chromaprint detector + current idle scheduler (you will split this) |
| `apps/desktop/src/main/skipSegments/normalize.ts` | Pure logic: validation, precedence, dedup, chapter labels |
| `apps/desktop/src/main/skipSegments/fingerprintMatcher.ts` | Pure logic: alignment + scoring |
| `apps/desktop/src/main/skipSegments/movieCreditsDetector.ts` | Pure logic: brightness-pattern credits detection |
| `apps/desktop/src/main/skipSegments/types.ts` | Shared segment types and contracts |
| `apps/desktop/src/main/databaseSegmentsRepository.ts` | All SQL for segments/fingerprints/analysis state |
| `apps/desktop/src/main/database.ts` | Migration pattern (`PRAGMA table_info` + additive DDL) |
| `apps/desktop/src/main/ffmpegGovernor.ts` | Playback leases, `registerAnalysisProcess`, activity timing |
| `apps/desktop/src/main/mediaBinaries.ts` | `findFFmpeg` / `findFpcalc` discovery order |
| `apps/desktop/src/main.ts` | Wiring: `createSkipSegmentService`, `createLocalSegmentAnalysis`, `warmSkipSegmentsAfterScan`, `saveLibraryFromScan` |
| `apps/desktop/src/main/ipcHandlers.ts` | IPC registration + validation conventions |
| `apps/desktop/src/preload.ts` + `apps/desktop/src/lib/desktopApi.ts` | Renderer API surface (both must stay in sync) |
| `apps/desktop/src/components/VideoPlayer/skipPrompt.ts` | Pure player-side prompt logic |
| `apps/mobile/App.tsx` | Mobile player. **User-owned, has uncommitted changes — patch narrowly, never reformat or restructure** |
| `apps/desktop/tests/skipSegments.test.ts`, `animeSeasonMapping.test.ts` | Test conventions to imitate |

---

## 1. Non-negotiable invariants

Violating any of these is a defect regardless of tests passing.

1. **Playback never waits.** No analysis, provider request, or marker write
   may delay stream creation, first frame, or seeking. Check
   `isPlaybackActivityActive()` before starting decode work and between
   episodes; a playback lease terminates analysis processes immediately
   (already handled by `registerAnalysisProcess` — always register every
   spawned process).
2. **Manual always wins.** Never insert, delete, or modify rows with
   `source = 'manual'` from any automatic path. The only writers of manual
   rows are the existing manual IPC operations.
3. **Additive-only migrations.** New tables and nullable columns only. No
   `ALTER TABLE ... DROP`, no table rebuilds, no CHECK-constraint changes, no
   new values written to existing type columns. A rolled-back previous binary
   must open and read the database. Follow the exact `PRAGMA table_info`
   guard pattern in `database.ts`.
4. **Never rewrite unchanged data.** `replaceSegmentCandidatesForSource`
   already no-ops when incoming candidates equal stored rows — route all
   candidate persistence through it. Incremental jobs persist candidates
   only for the new/changed revision; peer episodes' rows must be
   byte-identical after the job.
5. **False negatives over false positives.** Keep confidence gates
   (≥ 0.90 auto-publish, 0.80–0.89 `review`, < 0.80 discard). When in doubt,
   emit nothing. Review candidates never reach playback.
6. **Resolution precedence is source-order only.** `SOURCE_PRIORITY` in
   `normalize.ts` is the single authority. Never compare confidence across
   sources. Detector provenance (blackframe, snapping, silence) is metadata
   inside `analysis_metadata_json`, never a new source.
7. **Clean-room discipline.** Do not open, read, or fetch the intro-skipper
   *source code*. Behavior comes from its wiki/README and this plan only. Do
   not copy its constants, thresholds, table layouts, or test data.
8. **Local only.** The analysis path performs zero network I/O. Fingerprints
   and any media-derived data never leave the machine and never appear in
   logs.
9. **No new FFprobe processes per file.** Reuse `localMetadata` from the
   scan/probe; call `probeMediaFile` only when metadata is absent, exactly as
   `contextFor` does today.
10. **Bounded everything.** Every child-process output, queue scan, cleanup
    pass, and JSON parse has an explicit cap. Copy the existing patterns
    (`MAX_OUTPUT_BYTES`, bounded orphan cleanup batches, capped stderr
    accumulation).

---

## 2. Language, tooling, and style rules

These reflect enforced repo configuration — deviations fail CI or the test
runner.

- **TypeScript, strict.** ESLint enforces `no-explicit-any`,
  `no-non-null-assertion`, `no-empty-function` as errors. Zero `any`; use
  `unknown` + narrowing (see `asRecord`/`asArray` in `providers.ts`).
- **The test runner is plain `node --test` with strip-only TS.** This is the
  #1 practical gotcha (it has broken this repo twice):
  - **No constructor parameter properties** (`constructor(readonly x: number)`
    crashes the loader). Assign fields in the constructor body.
  - **No TS `enum`s.** Use string literal unions.
  - **Relative imports in main-process files must carry the `.ts` extension**
    (`from './normalize.ts'`, `from '../safeFetch.ts'`) so tests can import
    the transitive graph.
- **Factories over classes.** Modules export `createXxx(deps)` returning an
  object of functions, with dependencies injected via a `deps` object
  (`createSkipSegmentService`, `createDatabaseSegmentsRepository`). Match
  this. No DI frameworks, no singletons except module-level state that the
  factory owns.
- **Pure logic in its own files.** Anything unit-testable without Electron,
  the filesystem, or SQLite goes in a dedicated module with no `electron`,
  `node:fs`, or database imports (`normalize.ts`, `fingerprintMatcher.ts`,
  `skipPrompt.ts` are the models). Tests import these directly. This
  matters doubly here because `better-sqlite3` is compiled for Electron's
  ABI and cannot load under system Node — **pure-logic tests must not
  transitively import the database module.**
- **SQL conventions.** `better-sqlite3` prepared statements; multi-statement
  writes wrapped in `database.transaction(() => { ... })`; snake_case
  columns mapped to camelCase via explicit row types + `fromRow` functions
  (see `candidateFromRow`). JSON columns are suffixed `_json` and parsed
  through the tolerant `jsonParse(value, fallback)` helper.
- **Time is integer milliseconds** in all stored/computed values; seconds
  appear only at player boundaries. All marker times are absolute media
  time.
- **Errors.** Background paths degrade silently with a single
  `console.warn('[skip-segments] ...')`; IPC-facing paths throw `Error` with
  a user-readable sentence (existing style: "At least three usable episodes
  are required for local analysis."). IPC handlers wrap with the existing
  `safeResult` where the renderer expects `ApiResult`.
- **Comments** state constraints the code can't express — why a bound
  exists, why an order matters. No narration, no changelog comments.
- **Naming.** Follow existing patterns: IPC channels `playback:analysis:*`,
  settings keys camelCase, job/table names `segment_analysis_*`.
- **Package manager is pnpm via corepack.** Never run `npm install`.

---

## 3. Code structure — where new code goes

```
apps/desktop/src/main/skipSegments/
  analysisCoordinator.ts   ← NEW (Phase A): queue, scan-diff, scheduling, job lifecycle
  analysisJobs.ts          ← NEW (Phase A): pure job-state logic (keys, priority, transitions)
  configHash.ts            ← NEW (Phase A): pure canonical config hashing
  boundaryRefinement.ts    ← NEW (Phase B): pure snapping selection logic
  creditCardClassifier.ts  ← NEW (Phase B): pure entropy/saturation classification
  localAnalysis.ts         ← MODIFIED: becomes detector-only; scheduler moves to coordinator
  service.ts               ← MODIFIED: exposes revision listing for diffing; otherwise stable
  normalize.ts             ← MODIFIED (Phase B): extended chapter label sets
  types.ts                 ← MODIFIED: job/inventory/status types
databaseSegmentsRepository.ts ← MODIFIED: new tables' SQL lives here, nowhere else
```

Rules:

- **`analysisCoordinator.ts` owns all scheduling.** `localAnalysis.ts` keeps
  `analyze`/`analyzeMovie`/fingerprinting and loses `startScheduler` (keep a
  deprecated re-export that delegates, so `main.ts` wiring changes are
  one-line). The coordinator is the only caller of the detector.
- **Pure modules first.** `analysisJobs.ts` (job key construction, priority
  ordering, legal state transitions) and `configHash.ts` must be importable
  by tests with zero side effects. The coordinator is thin glue over them.
- **One writer per table.** All SQL for `segment_analysis_jobs`,
  `segment_analysis_inventory`, and the `analysis_metadata_json` column goes
  in `databaseSegmentsRepository.ts` behind typed functions. No inline SQL
  in the coordinator.
- **Renderer surface changes ripple through exactly three files** and must
  land in the same commit: `ipcHandlers.ts` (validate inputs — coerce with
  `String()`/`Number()` and bound lengths as existing handlers do),
  `preload.ts`, `lib/desktopApi.ts`. If the LAN/mobile contract changes,
  `lanRoutePolicy.ts` and the mobile client change in the same commit too.
- **Settings** extend `normalizeSettings` in `settings.ts` with the
  `skipAnalysis` object; every field gets a validated default so a corrupt
  settings file can never produce `undefined` behavior. Migration from
  `localSkipAnalysisEnabled` happens inside `normalizeSettings` (read old
  key when new object absent), not in a one-shot script.

---

## 4. Phase A build order (do these in sequence)

1. **`configHash.ts`**: `selectionConfigHash(settings: SkipAnalysisSettings): string`
   — canonical JSON (sorted keys, no undefined) → sha256 hex, truncated like
   `hashId`. Include: enabled types, per-type duration limits, snapping
   parameters, detector version constants. Exclude: concurrency, logging,
   anything that can't change marker output.
2. **`analysisJobs.ts`**: job kinds `'incremental' | 'manual' | 'hash-recompute' | 'cleanup'`;
   states `'pending' | 'running' | 'waiting_for_peers' | 'complete' | 'error' | 'cancelled'`;
   `jobKey(kind, scope, fileRevision, configHash)`; a pure comparator
   implementing the priority order from the plan; pure transition guard
   `canTransition(from, to)`.
3. **Repository**: additive migration + typed CRUD for:

   ```sql
   CREATE TABLE IF NOT EXISTS segment_analysis_jobs (
     job_key TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     media_id TEXT NOT NULL,
     season INTEGER NOT NULL DEFAULT 0,
     file_revision TEXT NOT NULL DEFAULT '',
     config_hash TEXT NOT NULL,
     state TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_segment_analysis_jobs_pending
     ON segment_analysis_jobs(state, kind, created_at);

   CREATE TABLE IF NOT EXISTS segment_analysis_inventory (
     file_revision TEXT PRIMARY KEY,
     media_id TEXT NOT NULL,
     season INTEGER NOT NULL,
     episode INTEGER NOT NULL,
     config_hash TEXT NOT NULL,
     fingerprint_version TEXT NOT NULL,
     analyzed_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_segment_analysis_inventory_media
     ON segment_analysis_inventory(media_id, season);
   ```

   Plus nullable `analysis_metadata_json TEXT` on
   `media_segment_candidates` via the existing add-column-if-missing helper.
4. **`analysisCoordinator.ts`**: factory
   `createAnalysisCoordinator(deps: { loadLibrary; loadSettings; detector; repository })`.
   - `onLibrarySaved(previous, next)`: diff file revisions (reuse the
     `fileRevision` identity from `service.ts` — export it, don't duplicate
     it), enqueue jobs idempotently by job key.
   - `tick()`: the once-per-minute gate. Copy the guard conditions verbatim
     in behavior from the current `startScheduler` (AC power, 300 s system
     idle, no playback, 60 s since playback). Pop exactly one job by
     priority; run it; on playback interruption mark `pending` again (the
     existing "Playback became active" error path).
   - Startup: mark orphaned `running` rows `pending` (restart recovery).
5. **Wire `main.ts`**: `saveLibraryFromScan` captures the pre-save snapshot
   and calls `onLibrarySaved` after a successful save. Replace the
   `localSegmentAnalysis.startScheduler()` call with the coordinator's.
   Keep `warmSkipSegmentsAfterScan` (provider warm) unchanged.
6. **Incremental detector entry point**: add
   `analyzeRevision(mediaId, season, fileRevision)` to `localAnalysis.ts`
   that fingerprints only the target revision, loads peer fingerprints from
   cache, generates missing peer fingerprints **without** calling
   `replaceSegmentCandidatesForSource` for peers, and persists candidates
   for the target revision only. `< 3` usable episodes → run chapter/visual
   detection, then return a `waiting_for_peers` signal (typed result, not a
   thrown string).
7. **Status IPC**: extend the existing `playback:analysis:status` payload
   (current job, pending count, last error, helper availability) and add
   `playback:analysis:run`, `playback:analysis:cancel`,
   `playback:analysis:pause`, `playback:analysis:resume`. Keep
   `playback:analysis:season` working as a wrapper that enqueues a manual
   job.
8. **Client type-tolerance**: desktop `skipPrompt.ts` and the mobile
   `activeMediaSegment` memo filter to the known type union; the label maps
   get a `'Skip'` fallback. Mobile change is a minimal targeted diff.

Phase B and C follow the plan; build pure modules
(`boundaryRefinement.ts`, `creditCardClassifier.ts`) with their tests before
touching the detector, and extend chapter label sets in `normalize.ts` only
as anchored whole-label entries.

---

## 5. Explicit do-not list

- **Do not** touch marker resolution (`resolveCandidates`,
  `SOURCE_PRIORITY`), the provider clients, caching TTLs, or
  `warmLibrary`'s provider behavior. They are shipped, tested, and out of
  scope.
- **Do not** change duration-limit defaults (intro 15–180 s, credits
  15–300 s, movie credits ≤ 900 s) or any confidence threshold.
- **Do not** add the `commercial` type, the maintenance timer, the extract
  cache, regex-editing UI, or concurrency > 1. They are deferred/cut with
  re-entry conditions in the plan (§7).
- **Do not** apply the overlap guard to provider, chapter, or manual
  markers — local detection only. The Demon Slayer S1E1 overlap (intro
  21:10–22:40, credits 21:40–23:35, both valid) is the canonical fixture.
- **Do not** restructure, reformat, or "clean up" `apps/mobile/App.tsx`,
  `main.ts`, or `VideoPlayer.tsx` beyond the minimal diffs the tasks
  require. The mobile file has user-owned uncommitted changes.
- **Do not** add polling loops, extra media-time subscriptions, or
  animation-frame loops in either player. The existing snapshot/position
  state is the only clock consumer.
- **Do not** spawn processes without `registerAnalysisProcess`,
  `lowerPriority`, `windowsHide: true`, and bounded output collection.
- **Do not** write file paths into provider cache rows, logs, or any
  LAN-visible payload beyond what existing code already exposes.
- **Do not** run the test suite, builds, or installers unless explicitly
  authorized. Create tests; verify with `corepack pnpm --filter
  loom-media-server-desktop typecheck` and `lint`, and static inspection.
- **Do not** commit, push, or open PRs unless asked. When asked: one phase
  per PR, commits scoped per build-order step above.

---

## 6. Testing standards

- Framework: `node:test` + `node:assert/strict`, files in
  `apps/desktop/tests/*.test.ts`, named after the module under test.
- **Pure-logic tests** (jobs, config hash, boundary refinement, classifier,
  type-tolerance) must import only pure modules — they must pass under
  system Node with no native deps.
- **Repository/migration tests** may use `better-sqlite3` directly (pattern:
  `databaseMigrations.test.ts`), accepting that they only run where the
  native module's ABI matches (CI). Never mix the two kinds in one file.
- Every test asserts behavior from the plan's test list, one scenario per
  `test(...)`, with fixture values that mean something (use the real
  Demon Slayer/AniSkip numbers already in `skipSegments.test.ts` as the
  style guide).
- Required coverage before a phase is "done" (from the plan §6): scan-diff
  enqueues exactly one job per added episode and peers' rows stay
  byte-identical; job idempotency by key; restart recovery;
  `waiting_for_peers` re-queue on the third episode; config-hash recompute
  reuses fingerprints; local-only overlap guard; unknown-type tolerance in
  both players' pure prompt logic; old-binary readability (migration test
  opens the migrated schema with only the previous DDL's expectations).

---

## 7. Definition of done (per phase)

1. Typecheck and lint clean (`tsconfig.json` **and** `tsconfig.node.json`).
2. All new logic covered by tests as in §6 (created, not executed, unless
   authorized).
3. No diff outside the files the phase's build order names, except
   mechanical type propagation (`types.ts`, `desktopApi.ts`, `preload.ts`).
4. Every invariant in §1 re-checked against the diff — explicitly, one by
   one — before declaring the phase complete.
5. The plan's acceptance criteria for the phase restated in the PR/summary
   with a file:line pointer proving each one.
