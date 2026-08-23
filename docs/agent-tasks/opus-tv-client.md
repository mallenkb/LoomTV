# Opus task: build the Android TV and Fire TV client

Start only after the canonical desktop and mobile cutover is accepted. Read
[the shared contract](./video-unification-shared.md),
[the remaining implementation contract](./opus-remaining-implementation.md),
[the Sol handoff](./sol-core-platform-handoff.md), and the current
[Opus ledger](./opus-handoff-ledger.md) completely. Inspect Expo SDK 54 and the
existing mobile client before choosing the TV package layout. Use the versioned
Expo 54 documentation required by `apps/mobile/AGENTS.md` for shared Expo code.

## Outcome

Add a maintained workspace application for Android TV and Fire TV. It must use
the canonical public API and work without a touch screen or desktop relay.

## Step 1: establish the package and platform contract

Choose shared versus separate mobile code by measured dependency and platform
constraints. Add the package manifest, workspace scripts, TypeScript settings,
Android TV and Fire TV launch metadata, least-privilege permissions, icons, and
release checks. Record the choice and its upgrade cost.

Completion criterion: the workspace, release verifier, and test-workspace policy
resolve the TV package and every declared command.

## Step 2: implement the living-room journey

Implement discovery and manual connection, certificate trust, pairing and
sign-in, invitation sessions, profiles and PIN state, Home, search, lists,
movies, series, seasons and episodes, details, playback plans and renewal,
progress, audio and subtitle tracks, device revocation, server loss, recovery,
and sign-out. Advertise measured playback capabilities.

Completion criterion: each journey has success, loading, empty, denied,
offline, revoked, expired, incompatible, and retry behavior where applicable.

## Step 3: make remote input authoritative

Implement deterministic D-pad focus, Select, Back, Play or Pause, seeking,
focus return, scroll visibility, overscan-safe layout, ten-foot text, screen
reader names, reduced motion, and long-text handling. Touch and pointer input
may supplement remote input but cannot be required.

Completion criterion: a focus-state test walks every core screen without a
missing or trapped focus target. Back behavior is defined at every navigation
depth.

## Step 4: prove the implementation

Run TV type checks, focused state and focus tests, package-policy checks, Android
configuration checks available without a device, and `git diff --check`. Write
an emulator and physical-device checklist without claiming those runs occurred.

Completion criterion: the ledger records every changed path and command result.
End with `TV_CLIENT_READY` only when no known implementation blocker remains.
