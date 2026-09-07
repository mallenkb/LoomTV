# Desktop TanStack migration

The shared React desktop renderer now uses TanStack Router, Query, and Virtual. Both Electron and Tauri use the same renderer changes. The Rust backend, database format, and other applications are unchanged by this migration.

## Navigation and data

- Router owns hash navigation, typed route parameters, lazy page loading, intent preloading, and scroll restoration. The app navigation adapter accepts existing saved links and preserves plain query-string values.
- Query owns cached desktop reads and coordinated mutations through the existing desktop API boundary. Profile and server identity changes clear the cache. React contexts retain the current UI state and scan coordination.
- Local and remote library loading use compact catalog records. Details start with the available record or cached detail, then hydrate richer metadata.
- Discover and detail caches use Query instead of separate maps and full-item session storage. Watchlist changes appear immediately and roll back on failure.
- Virtual renders visible poster rows and episode rows with a small overscan. Large lists still retain their underlying records; virtualization limits mounted elements.

## Memory and request limits

Inactive cache entries expire after three minutes by default. Trimming applies family limits and a total target of 160 entries, plus an approximate 8 MiB budget for retained cache data. Active or fetching queries can exceed these targets. This estimate does not include React state, native memory, decoded images, or all JavaScript overhead.

Thumbnail, provider metadata, and media-segment reads share a four-request concurrency limit. Cancellation removes queued work; already dispatched native calls can finish. Detail preloading allows one request at a time.

## Validation

Both desktop TypeScript checks, targeted renderer ESLint, both production renderer builds, and whitespace checks passed. No tests, native builds, runtime checks, visual checks, or performance measurements were run. Warm navigation latency, scrolling behavior, and total process memory remain to be measured in the desktop app.

## Review location

This migration is isolated on `codex/tanstack-desktop-migration`. Its baseline preserves the desktop fixes present when the worktree was created. It has not been merged into the original checkout or pushed.
