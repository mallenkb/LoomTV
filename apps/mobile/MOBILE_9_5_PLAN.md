# Mobile 9.5 plan

Execution plan to move every ledger category in `loomtv-mobile-app-audit.html` from its current
score to 9.5 or better. Scored against the acceptance criteria already written in
`MOBILE_9_5_RELEASE_GATE.md`.

## The rule this plan obeys

A score moves when evidence moves, never when code merges. Every phase below therefore names both
the work and the artifact that lets the category be re-scored. Phases 1 to 4 are code and can be
done without a device; they raise the ceiling but cannot on their own award a 9.5. Phase 5 is the
evidence that awards it.

Do not target 10. A 10 asserts no residual risk in a category, which a review cannot establish.
9.5 to 9.7 with recorded evidence is the honest maximum, and two categories (02, 06) cannot pass
9.5 on engineering work at all — they need a handful of real users.

## Current position

| No. | Category | Now | Target | Blocked by |
| --- | --- | --- | --- | --- |
| 01 | System status feedback | 7.8 | 9.5 | Findings 3, 7 |
| 02 | Real world / mental model | 8.6 | 9.5 | Finding 11, user validation |
| 03 | User control and reversibility | 8.2 | 9.6 | Finding 2 |
| 04 | Consistency and navigation | 8.6 | 9.6 | Contract tests only |
| 05 | Error prevention | 7.9 | 9.5 | Findings 2, 4, 8 |
| 06 | Recognition rather than recall | 8.2 | 9.5 | Finding 10, user validation |
| 07 | Flexibility and efficiency | 7.6 | 9.5 | Findings 6, 11 |
| 08 | Simplicity and information architecture | 6.9 | 9.5 | Finding 6 |
| 09 | Error diagnosis and recovery | 6.8 | 9.6 | Findings 1, 7 |
| 10 | Help and documentation | 8.0 | 9.5 | Finding 9, gate evidence |

---

## Phase 1 — Failure legibility

No device needed. This is the phase that changes user-visible behaviour the most per hour spent.

**1.1 Error boundaries** — Small
Wrap `AppRoot` (`App.tsx:1163`) in a boundary that renders a retry screen and can clear the state
that threw. Add a second boundary around `PlayerContent` (`App.tsx:5152`) so a decode or track
failure cannot take the library down with it.
*Done when:* a deliberate throw behind a debug flag produces a recoverable screen on both platforms,
and a test asserts the boundary renders its fallback.

**1.2 One non-fatal reporting path** — Small to Medium
Add `reportNonFatal(scope, error)` and route all 22 bare `catch {}` blocks in `App.tsx` through it.
Keep a bounded in-memory ring buffer; surface it in Settings and attach it to the offline notice.
*Done when:* no bare `catch {}` remains in `App.tsx`, and a forced secure-store, prefetch, and
player-teardown failure each leave a readable record.

**1.3 Per-operation deadlines** — Small
Thread `timeoutMs` through `createMobileLanClient` so each method sets its own budget instead of
inheriting the single 12s default at `mobileLanClient.ts:182`. Suggested: 4s for `client-config`
and health checks, 20s for `library`, 45s for `start-hls`.
*Done when:* a desktop throttled to a 15s first byte on `start-hls` starts playback rather than
raising `MobileLanTimeoutError`, and a dead host fails a health check inside 5s.

**1.4 Progress retention** — Small
Age progress rows against the snapshot they belong to, or refresh `saved_at` for every row in the
active snapshot (`mobileOfflineCache.ts:191` vs `212`).
*Done when:* a clock-shifted test ages a row past 30 days and the resume position survives.

**Lifts:** 01 → ~9.0, 03 → ~9.2, 05 → ~8.8, 09 → ~9.0. None reach 9.5 yet; Phase 5 closes the gap.

---

## Phase 2 — Boundary tests

The untested set is the trust and durability boundary. This phase is pure test work, no device.

**2.1 Decoder fixtures** — Medium
`mobileDecoders.ts` has no tests. For each payload the desktop sends: a valid fixture, a truncated
one, a wrong-typed field, an unexpected extra field, and a hostile oversized string.
*Done when:* every decoder has all five cases and a malformed payload provably cannot reach state.

**2.2 Cache round-trip** — Medium
`mobileOfflineCache.ts` has no tests. Cover save → load equality, the identity fast path
(`154-165`), in-place mutation, the retention sweep, transaction rollback, and the 32MB cap.
*Done when:* an in-place library mutation still forces a rewrite, proving finding 4 is closed
rather than merely reasoned about.

**2.3 Contract tests from the gate doc** — Medium
The two the gate already names: zero Others IDs across Home, anime, TV, movie, hero, My List and
core search; and no LAN request surviving navigation, backgrounding, disconnect, retry, or deadline.
*Done when:* both run in `mobile-release-gate.yml` and fail loudly when the invariant breaks.

**Lifts:** 04 → 9.6, 05 → ~9.3, 09 → ~9.3.

---

## Phase 3 — Structure

**3.1 Split the root** — Large
`AppRoot` is 2,407 lines with 99 hooks inside a 6,807-line file. Extract by seam, in this order,
each taking its effects and gaining tests as it moves:

1. connection / session (pairing, tokens, health, lifecycle)
2. catalog / offline (library, snapshot, restore, prefetch)
3. player (session, gestures, tracks, progress)
4. navigation / modal stack

*Done when:* no component exceeds ~600 lines, no component holds more than ~25 hooks, and root
renders per playback minute are measured before and after.

**3.2 Comment the `allItems` distinction** — Trivial
`mobileLibrary.ts:163` includes Others by design and is used for ID lookups only. Say so where it
is defined, before someone reuses it for a surface.

**Lifts:** 08 → 9.5, 07 → ~9.2.

---

## Phase 4 — Product decisions

Each of these is a decision to record, not a defect to fix. Undecided is what costs the score.

**4.1 Background playback, lock-screen controls, PiP** — Medium if adopted
`App.tsx:1967` sets only `loop` and `timeUpdateEventInterval`. Decide explicitly. If off, say so in
the app; if on, add session handling for interruptions, route changes, and backgrounded progress.

**4.2 Localisation** — Large if adopted
No catalogue, no locale handling beyond one `toLocaleString`. If localisation is ever coming,
extract strings during Phase 3, not after. If not, record the decision so it stops being relitigated.

**4.3 URL scheme** — Small
`app.json` declares `loomtv` with no handler anywhere. Drop it, or add a validating handler.

**4.4 Contributor instructions** — Trivial
`AGENTS.md` points at Expo v56 docs; `package.json` pins `~54.0.35`.

**Lifts:** 02 → ~9.2, 07 → 9.5, 10 → ~9.2.

---

## Phase 5 — Runtime evidence

Nothing above awards a 9.5 without this. These are the gate doc's own rows, with the measurement
each one has to produce.

| Evidence | Produces | Awards |
| --- | --- | --- |
| Device matrix: iPhone, iPad, Android phone, Android tablet | Artifact links, OS versions, per-row results | All categories |
| VoiceOver + TalkBack through pairing, library, detail, playback | Focus order, announcements, target sizes vs 44pt | 06 → 9.5 |
| Maximum text size, both orientations | No clipped or unreachable controls | 06, 08 |
| One-hour playback trace | SQLite bytes written per hour, bounded | 07 → 9.5 |
| Cold offline, warm offline, image-complete p50/p95 | Local-first promise measured, not asserted | 01 → 9.5 |
| Desktop sleep, address change, captive portal, packet loss | Recovery within a stated deadline every time | 03 → 9.6, 09 → 9.6 |
| Signed production artifacts | Signer and merged permissions match policy | 05 → 9.5 |
| Five-user manual-pairing test | Pairing copy validated with real users | 02 → 9.5 |

**Fill the pending rows in `RELEASE_CHECKLIST.md` as this runs.** Every row currently reads
Pending, which is the single largest reason category 10 cannot pass 9.5 no matter how good the
prose is.

---

## Order of work

1. Phase 1 — highest user-visible return, no device, roughly a week.
2. Phase 2 — makes Phase 3 safe to attempt.
3. Phase 4.3 and 4.4 — an hour, do them while Phase 2 runs.
4. Phase 3 — the long one; do it against the tests from Phase 2.
5. Phase 4.1 and 4.2 — decide during Phase 3 so extraction absorbs them.
6. Phase 5 — after the code settles, or the matrix gets run twice.

## What not to do

- Do not raise a score because a phase merged. The ledger moves when Phase 5 produces the artifact.
- Do not start Phase 3 before Phase 2. Splitting a 2,407-line root without tests on the persistence
  and decode boundary trades a known problem for an unknown one.
- Do not chase 10. If a category reads 9.7 with every gate row recorded, that is the ceiling; the
  remaining 0.3 is the honest cost of it being a judgement rather than a measurement.
