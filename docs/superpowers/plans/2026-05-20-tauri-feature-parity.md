# Tauri Feature Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Electron/Tauri parity gaps that were identified in the audit and publish an updated parity table.

**Architecture:** Keep the shared React renderer API stable and move missing desktop behavior into the Tauri backend. Prefer parity-compatible JSON shapes so the renderer does not need Tauri-specific feature branches.

**Tech Stack:** Rust/Tauri v2, `rusqlite`, local HTTP media server, Vite/React renderer, existing Electron implementation as the reference.

---

### Task 1: Scanner Cache And Progress

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src/lib/desktopApi.ts`
- Test: `src-tauri/src/main.rs`

- [x] Add deterministic folder signatures for video/subtitle/image files.
- [x] Reuse cached items for quick scans when signatures match.
- [x] Respect metadata/full scan modes.
- [x] Emit Tauri `library:scan-progress` events.
- [x] Listen for Tauri progress events from `desktopApi.onLibraryScanProgress`.
- [ ] Add unit tests for cache reuse and forced rescan behavior.

### Task 2: Metadata Provider Parity

**Files:**
- Modify: `src-tauri/src/main.rs`
- Test: `src-tauri/src/main.rs`

- [x] Add TVmaze search/details/episode fetching.
- [x] Add Jikan anime search/details/episode fetching with rate limiting.
- [x] Merge TVmaze/Jikan/TMDB episodes in Electron priority order.
- [x] Include richer official candidates from TVmaze and Jikan.
- [x] Add tests for episode metadata source priority and Jikan episode-number matching.

### Task 3: Artwork And Media Endpoint Parity

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/database.rs`
- Test: `src-tauri/src/main.rs`, `src-tauri/src/database.rs`

- [x] Serve `/api/local-image`.
- [x] Serve `/api/cached-artwork`.
- [x] Persist cached remote artwork in `artwork_cache`.
- [x] Detect local poster/backdrop files during scan.
- [x] Extract embedded thumbnail streams through ffmpeg when available.
- [x] Add tests for cache storage.
- [ ] Add tests for local artwork selection.

### Task 4: LAN Sharing And Security

**Files:**
- Modify: `src-tauri/src/main.rs`
- Test: `src-tauri/src/main.rs`

- [x] Bind the media server to `0.0.0.0`.
- [x] Generate/persist device IDs and 6-digit share codes.
- [x] Validate pair requests and device bearer tokens.
- [ ] Enforce auth on LAN library, stream, subtitle, HLS, and artwork routes.
- [ ] Restrict CORS to local renderer origins.
- [ ] Implement native peer discovery; renderer subnet fallback remains available.
- [ ] Add tests for token parsing and protected routes.

### Task 5: Binaries, Updates, Verification, Table

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/tauri.conf.json`
- Create/modify: `docs/tauri-electron-parity-audit.md`

- [x] Add packaged-resource binary lookup before system lookup.
- [x] Add ffmpeg resource declarations to Tauri bundle config.
- [x] Keep update check functional and make install open the release URL when true auto-install is unavailable.
- [x] Run Rust and renderer tests.
- [x] Update the detailed parity table with ✅ and ❌ indicators.
