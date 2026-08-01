# LoomTV media core

This package is the small, runtime-neutral contract shared by the Electron and
headless hosts. It owns decisions that must not diverge when a library moves
between those hosts:

- stable media IDs (SHA-256 of the normalized absolute media path)
- the supported video-extension vocabulary
- client playback-profile normalization and output codec names
- portable profile identity/type normalization

The package deliberately does not open SQLite, inspect hardware, or choose a
transcoder backend. Those remain runtime adapters. Keeping those boundaries
explicit lets the desktop database and the headless persistence adapter move to
the same storage contract later without changing scanner or playback callers.
