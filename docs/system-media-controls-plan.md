# LoomTV System Media Controls Plan

**Status:** proposal · revision 2
**Supersedes:** the media-session implementation plan (revision 1)

Treat this as a native media-session project. It is not a keyboard-shortcut project.

## Outcome

LoomTV answers system media controls on macOS, Windows, and Linux no matter the
keyboard layout, `Fn` behaviour, headset type, or whether the app has focus.
Commands drive the running LibVLC, mpv, or Chromium session. They never restart
playback, switch engines, start a transcode, or call a metadata provider.

---

## 0. What this revision changes

1. **Adds a macOS hosting spike as a blocking gate (§2).** Whether a helper process
   can own the Now Playing session decides the shape of the macOS adapter. Revision 1
   assumed the answer and built seven phases on top of it.
2. **Names the second claimant.** `HardwareMediaKeyHandling` is enabled at
   [main.ts:323](../apps/desktop/src/main.ts). Revision 1 never mentions it. Keeping
   Chromium's media session alive next to a native adapter gives one app two owners
   and the winner is whichever registered last.
3. **Deletes the periodic position tick.** All three platform APIs interpolate
   position from elapsed time and rate. Publishing once per second is wasted on macOS
   and violates the MPRIS spec, which excludes `Position` from change notifications.
4. **Moves packaging into each adapter phase.** Revision 1 packaged after all three
   adapters, which makes shipping macOS on its own impossible.
5. **Moves lifecycle handling into the controller phase.** The controller is not
   correct without it, so it cannot wait for the settings phase.
6. **Adds a standalone F-key fix that ships first (§1).** It is a live bug on Windows
   and Linux today and has nothing to do with the rest of this work.
7. **Corrects stop semantics.** Stop ends playback and releases the session. It does
   not close the player window.

---

## 1. Current state

Static inspection of `apps/desktop`:

| Location | Finding |
| --- | --- |
| `src/main/systemMediaKeys.ts:32` | Electron `globalShortcut` registers three media accelerators. Cannot succeed while `HardwareMediaKeyHandling` is on, so it logs "registration was refused" and no-ops. |
| `src/main.ts:323` | `HardwareMediaKeyHandling` is enabled alongside `PlatformHEVCDecoderSupport` and `MediaFoundationH264Encoding`. |
| `src/components/VideoPlayer.tsx:3223` | Keydown handler matches `F7`, `F8`, `F9` with no platform guard. Steals plain function keys on Windows and Linux. |
| `src/components/VideoPlayer.tsx:3383` | Chromium Media Session handlers registered in the renderer. |
| `src/components/VideoPlayer.tsx:3444` | Silent 1-second 8 kHz WAV loop, an attempt to keep a Chromium media session alive during native playback. Chromium filters short silent audio, so it does not work. |
| `src/shared/ipcContract.ts:192` | Exposes three actions: `play-pause`, `previous-track`, `next-track`. |
| `src/main/libvlcPlayback.ts:1611` | Main process already tracks position and emits playback state. |
| `src/main/libvlcPlayback.ts:1639` | Main process already dispatches an absolute `seek` command in seconds. |

Two facts shape everything below. The LibVLC player runs in the **main process**, so
the controller can reach it without a renderer round trip. And `backgroundThrottling`
is set nowhere in the project, so it defaults to `true` and Chromium throttles renderer
timers whenever the window is backgrounded. Any media-session code living in the
renderer degrades in exactly the case this project exists to fix.

---

## 2. Rules that apply to every phase

- The **main process** owns the system media session.
- `VideoPlayer` stays the playback authority. The controller asks, it does not decide.
- Platform adapters translate operating-system commands into one shared command type
  and contain no playback logic.
- **All three engines** publish through the same controller. There is no parallel
  `navigator.mediaSession` path inside the desktop app. The browser client keeps using
  the Media Session API because it has no other option.
- Position is published **on discontinuity only**: play, pause, seek, rate change,
  item change. No timer. Each platform interpolates.
- Banned: silent audio, keyboard scan codes, Accessibility permission, `CGEventTap`,
  Electron `globalShortcut`.
- Metadata and artwork come from LoomTV's cache and database. System integration never
  calls a metadata provider.
- A missing or crashed adapter disables system controls and nothing else. Playback is
  unaffected.

---

## Phase 0 — Delete the F-key bindings

Independent of everything else. Ship it on its own.

Remove `case 'F7'`, `case 'F8'`, and `case 'F9'` from the keydown switch in
`src/components/VideoPlayer.tsx:3223`. Keep every `Media*` case. Those carry the
semantic key values the browser reports when a real media key is pressed, wherever it
physically sits, and they are the correct focused-window fallback.

**Done when** F7 and F9 no longer change episodes on Windows and Linux, and the
existing space, `k`, `j`, `l` bindings still work.

---

## Phase 1 — macOS hosting spike (blocking gate)

One question decides the macOS adapter's architecture. Answer it in isolation before
writing anything else.

`MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` register per process. A separate
helper process is therefore attributed to the helper, not to LoomTV.

Build a throwaway `LSUIElement` app bundle in Swift that registers
`togglePlayPauseCommand`, publishes a hardcoded title, duration, elapsed time, and
`playbackState = .playing`, and logs to stderr. Do not connect it to LoomTV.

**Passes when all four hold:**

1. Control Center's Now Playing module shows "LoomTV" with the LoomTV icon.
2. An AirPods squeeze or the keyboard play key fires the handler while LoomTV is
   unfocused and another app is fullscreen.
3. No Accessibility permission prompt appears.
4. It still works when launched from inside a packaged `.app` bundle, not only from
   Xcode.

**If it passes:** Phase 5 ships a signed helper bundle talking to the main process over
a versioned JSON protocol on stdin and stdout.

**If it fails:** the same MediaPlayer.framework calls move into an Objective-C++ Node
addon running in the main process. Cost is `node-gyp`, `electron-rebuild` on every
Electron bump, and per-architecture prebuilds. Only the hosting changes; the framework
code carries over, which is why this spike costs a day rather than a week.

---

## Phase 2 — Shared command contract

Commands:

```
play · pause · toggle · stop
seekRelative(offsetSeconds) · seekAbsolute(positionSeconds)
previousItem · nextItem
setRate(rate)
```

Add repeat and shuffle only once LoomTV has a repeat mode. Do not stub them.

Session snapshot:

```
sessionId
state: 'playing' | 'paused' | 'stopped'
positionSeconds · durationSeconds · rate
supportedCommands: Command[]
skipForwardSeconds · skipBackSeconds
title · seriesTitle · season · episode
queueIndex · queueCount
artworkPath           // local cache path, never a remote URL
```

Adapter interface: `publish(snapshot)`, `clear()`, `onCommand(handler)`.

`stop` ends playback and releases the session. It does not close the player window.
macOS sends `stopCommand` in more situations than users expect, and tearing down the UI
on it is a bug report waiting to happen.

Widen `src/shared/ipcContract.ts:192` from three actions to the full command set, and
add a channel in the renderer-to-main direction for snapshots.

**Done when** every adapter and both players compile against the same command and
snapshot types.

---

## Phase 3 — Main-process session controller

Replace `src/main/systemMediaKeys.ts` with a `SystemMediaSessionController`. Carry over
the `lastPlaybackOwner` ownership logic already at `systemMediaKeys.ts:49`. It is the
right shape. Drop the `globalShortcut` registry entirely.

The controller accepts snapshots from the active player, picks one playback owner,
forwards commands only to that owner, and keeps a paused session available for resume.

Lifecycle it must handle: player opened, playing, paused, seeking, item changed,
playback ended, player closed, renderer destroyed, app quitting, preference changed.

It must **not** release the session when the app loses focus. That is the whole point.

Test it with a fake adapter that logs commands and accepts snapshots. That alone covers
ownership handoff between windows, release on close and on renderer destruction, and
the rule that no command reloads playback. That last one fails silently, so test it
hardest.

**Done when** the main process holds one authoritative session, no stale renderer can
receive a command, and the fake-adapter suite passes with no native code present.

---

## Phase 4 — Engine wiring, parallel paths removed

In `src/components/VideoPlayer.tsx`:

- Publish snapshots through the controller.
- Map commands to existing operations. Play, pause, and toggle call the active engine.
  `seekRelative` and `seekAbsolute` both call the existing `seekTo`. Next and previous
  call the episode navigation functions. `setRate` calls the engine speed setter.
- Delete the silent WAV effect at line 3444 and the `<audio>` element it drives at line
  3798.
- Delete the `navigator.mediaSession` registration block around line 3383. It stays in
  the browser client only.

In `src/main.ts:323`, remove `HardwareMediaKeyHandling` from the comma-joined feature
list. **Keep `PlatformHEVCDecoderSupport` and `MediaFoundationH264Encoding`.** Do not
delete the line.

Route the Chromium and HLS fallback engines through the same controller as LibVLC and
mpv. One path, one owner.

**Done when** every command preserves the active engine and playback position, and no
command triggers a reload, an engine switch, a transcode, or a metadata fetch.

---

## Phase 5 — macOS adapter, setting, packaging → **ship here**

Build the adapter in the shape Phase 1 selected.

Register **discrete** `playCommand`, `pauseCommand`, and `togglePlayPauseCommand`.
Different hardware sends different ones. AirPods send a toggle; many Bluetooth remotes
send discrete play or pause. Registering only the toggle produces bug reports from
hardware you cannot reproduce.

Feed `skipForwardCommand.preferredIntervals` and `skipBackwardCommand.preferredIntervals`
from LoomTV's existing `skipForwardSeconds` and `skipBackSeconds`. Control Center's
expanded module prints the interval inside the skip buttons, so it will show the real
number.

Publish title, series and episode context, duration, elapsed time, rate, playback
state, queue position, and the cached poster path. Disable commands LoomTV does not
support rather than registering no-op handlers. On session end, clear commands,
playback state, metadata, and artwork.

Artwork is the one place to stay cheap. IINA spends most of a 750-line file generating
QuickLook thumbnails from arbitrary video files with retries and cancellation tickets.
LoomTV already has posters on disk, so passing a file path is the entire feature.

Add **Use system media controls** to Playback settings. Device-scoped, default on.
Turning it off releases the session immediately.

Package the macOS helper into development, packaged, and release builds with signing
and notarization checks. Resolve it by bundle-relative path, never a development path.

**Done when** Control Center and common headphones drive LoomTV while it is unfocused,
with no Accessibility prompt, from a signed packaged build. Ship macOS on its own here.
Do not hold the release for the other two platforms.

---

## Phase 6 — Linux adapter (MPRIS)

Expose an MPRIS player over D-Bus. `dbus-next` handles this in JavaScript with no
compile step, so it nearly falls out of the contract for free.

Map `Play`, `Pause`, `PlayPause`, `Stop`, `Seek`, `SetPosition`, `Next`, `Previous`.
Emit the `Seeked` signal on discontinuities. Do not emit `Position` in
`PropertiesChanged`; the spec excludes it and clients interpolate.

Declare any D-Bus runtime dependency in the Linux packages.

---

## Phase 7 — Windows adapter (SMTC)

Last, and only when someone asks. Nothing on Windows is broken the way macOS is.

System Media Transport Controls for a non-UWP desktop app requires
`ISystemMediaTransportControlsInterop::GetForWindow` and a real HWND. A detached helper
process does not have LoomTV's window handle, so **Windows must run in-process** as a
Node addon. This asymmetry with macOS is deliberate, not an oversight. Ship
architecture-specific binaries.

Call `UpdateTimelineProperties` on discontinuities only.

Add a no-op adapter for any environment none of the three cover, so playback still
behaves normally.

---

## Verification matrix

Per platform, with LibVLC, mpv, and Chromium playback:

- Built-in keyboard media keys
- `Fn`-mapped media keys
- Bluetooth headphones, including a squeeze or double-tap gesture
- Discrete play, discrete pause, and toggle play/pause
- Forward and backward skip, with the correct interval shown in the system UI
- Seek by dragging the system scrubber
- Next and previous episode
- Resume from paused while LoomTV is unfocused
- Playback ending, player closing, setting disabled

Cases revision 1 omitted, and the ones users actually hit:

- **Contention.** Pause LoomTV, background it, start another player. Media keys go to
  the other player and LoomTV does not fight for the slot. Resume LoomTV and confirm it
  reclaims the session.
- **Sleep and wake.** Media sessions break across sleep on every platform.
- **Two LoomTV windows playing at once.** Phase 3 promises a single owner; this is the
  test for it.
- **Another app fullscreen on top of LoomTV.**

And in every case: no reload, no engine switch, no transcode, no metadata fetch.

---

## Open items

- Phase 1 has not been run. Everything in Phase 5 assumes an answer it has not received.
- Preserve the unrelated in-flight change in `PlayerEpisodePanel.tsx`.
- Decide who implements this before anyone starts. Every phase touches
  `systemMediaKeys.ts` and `VideoPlayer.tsx`, so two agents working at once will collide.
