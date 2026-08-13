# Mobile 9.5 release gate

This is a pass/fail evidence gate for the LoomTV mobile release. It does not award a score and it cannot be satisfied by changing the audit ledger. Re-score the audit only after this gate passes.

## Required evidence record

Every row must include:

- Git revision and release artifact identifier.
- Platform, device model, OS version, and app version.
- Desktop version and host OS where applicable.
- Network and test condition.
- Start and end timestamps.
- Raw measurement or pass/fail result.
- Link to the build, log, trace, screenshot, video, or exported report.
- Tester and any deviation from the procedure.

Missing evidence is a failure, not a Pending pass.

## 1. Clean release artifacts

- Mobile source tests, typecheck, decoder tests, cache tests, boundary tests, diagnostic tests, selector contracts, and cancellation contracts pass.
- Android and iOS Release configurations compile from a clean prebuild.
- Android uses the intended release signer, never the debug signer.
- The merged Android permission list exactly matches the approved allowlist.
- Android backup and extraction rules exclude sensitive app data.
- iOS signing identity and entitlements match the approved release configuration.
- The tested binaries are the same artifacts used for the device matrix.

## 2. Failure recovery and diagnostics

- A deliberate root render throw produces a labelled recovery screen on iOS and Android, never a blank app.
- Root recovery preserves persisted profiles, catalog, progress, credentials, and connection data.
- A deliberate player throw resets only playback and returns to a reachable detail or library state.
- Removing the injected fault and retrying recovers without reinstalling the app.
- Every operationally meaningful swallowed failure records exactly one sanitized diagnostic event.
- The persisted diagnostic buffer holds at most 100 events, expires events after seven days, and respects its byte cap.
- Exported diagnostics contain no credentials, tokens, certificate material, secret-bearing URLs, or unsanitized media paths.

## 3. LAN deadlines, cancellation, and recovery

- Health and client-config requests use a 4-second budget and terminate within 5 seconds when the host is dead.
- Ordinary metadata and progress calls use a 12-second budget.
- Library transfer uses a 20-second budget.
- HLS preparation uses a 45-second budget and displays a distinct preparation state after 2 seconds.
- A controlled start-HLS response at 15 seconds succeeds.
- Timeout, caller cancellation, authorization failure, malformed response, and unreachable host produce distinct typed outcomes.
- Navigation, backgrounding, disconnect, retry, and deadline abort the affected request within 500 ms of the trigger.
- No aborted request commits data or updates screen state after cancellation.
- After the desktop becomes reachable following sleep or address change, the app returns to a usable connected state within 15 seconds without restart.
- Captive portal and sustained packet-loss conditions produce an actionable offline state within 5 seconds of a failed probe.

## 4. Local-first data and persistence

Measure from app launch to usable local metadata and to completion of cached artwork on each required device. Run at least 20 samples per launch condition after one warm-up run.

- Cold offline metadata: p50 <= 1.5 seconds and p95 <= 2.5 seconds.
- Warm offline metadata: p50 <= 0.75 seconds and p95 <= 1.25 seconds.
- Cached artwork completion: p50 <= 1.5 seconds and p95 <= 3.0 seconds.
- Offline metadata and cached artwork require no network request to become usable.
- A one-hour playback trace writes no more than 5 MB to the mobile SQLite database after initial catalog population.
- The catalog payload is not rewritten during playback unless the catalog revision changes.
- Progress writes remain incremental and the final resume position is correct within one progress interval.
- An active catalog title retains resume progress beyond 30 days in the clock-shift test.
- A removed title's progress expires only after the documented orphan-retention period.
- Corrupt, oversized, or transaction-failed cache writes preserve the last valid snapshot and produce a diagnostic event.

If baseline hardware cannot meet a timing or byte limit, change the threshold only through a recorded product decision made before rerunning the gate. Do not silently redefine a failed run.

## 5. Media-domain contracts

Automated contracts must prove zero Others IDs in:

- Home.
- Anime.
- TV.
- Movies.
- Hero candidates.
- My List.
- Continue Watching.
- Core search.
- Core item lookup and progress ownership.

On every physical device, selecting Others media must direct-play or open its media viewer without entering a movie, anime, or TV detail flow.

## 6. Physical-device matrix

Use the exact release artifacts on:

| Device class | Required coverage |
| --- | --- |
| iPhone | Oldest supported iOS and current iOS |
| iPad | Compact and regular-width layouts on current iPadOS |
| Android phone | Android 7/API 24 and current Android |
| Android tablet | Compact and expanded-width layouts |

Each device must pass:

- Bonjour discovery and manual HTTPS pairing on home Wi-Fi and office Wi-Fi.
- Cold online, cold offline, and warm offline launch.
- Desktop sleep, address change, captive portal, packet loss, and reconnect recovery.
- HLS, direct play, subtitle, audio-track, orientation, background, resume, and scrub journeys.
- Others direct playback with zero detail-page or core-surface leakage.
- Maximum supported text size in portrait and landscape with no clipped, overlapping, or unreachable control.
- Reduced-motion behavior with no essential information dependent on animation.
- VoiceOver or TalkBack through pairing, library, detail, playback, recovery, and diagnostics.
- Logical focus order and explicit announcements for loading, connection, timeout, playback, and recovery state changes.
- Every actionable target measures at least 44 by 44 points unless it is part of a larger accessible target.
- Switch access can reach and activate every primary journey action.

A row fails if the journey requires force quit, reinstall, hidden gesture knowledge, or developer intervention.

## 7. Manual-pairing study

Run five formative sessions with participants who did not implement the flow. Record familiarity, completion time, assistance, wrong actions, and misunderstood copy.

Pass criteria:

- At least 4 of 5 participants complete pairing without facilitator instruction.
- All 5 can recover from one deliberately incorrect address or code using only in-product guidance.
- Median unassisted completion time is <= 2 minutes after the desktop is ready.
- No participant exposes or is asked to interpret protocol, certificate, or implementation terminology.
- Every observed misunderstanding is either corrected and rerun or explicitly accepted as residual product risk.

## 8. Product-scope decisions

The release record must state whether background playback, lock-screen controls, picture-in-picture, localization, and deep links are supported.

The current decision record is `MOBILE_PRODUCT_SCOPE.md`. Any change to those decisions requires an updated record and matching automated and physical-device evidence.

- Supported behaviors must pass their applicable device journeys.
- Unsupported behaviors must fail gracefully, preserve progress and session integrity, and be communicated where users encounter the limitation.
- The `loomtv` URL scheme must be removed or handled through an allowlisted validating parser with tests.

## Final release decision

The gate passes only when:

- Every applicable row above has linked evidence and passes.
- No critical or high-priority source or runtime finding remains open.
- No device-matrix row remains Pending.
- The exact production artifacts pass signer, permission, entitlement, backup, and runtime checks.
- Accepted residual risks have an owner, rationale, user impact, and follow-up date.

After the gate passes, run a fresh source and runtime audit against the tested revision. Scores remain directional summaries of that evidence, never release criteria themselves.
