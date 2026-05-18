# QoL Library Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add item-level metadata repair, metadata match selection, library filters, and better exact-episode continue watching.

**Architecture:** Reuse the existing Electron metadata endpoints and `ArtworkEditorControls` candidate picker, then add small renderer helpers for filtering and continue-watching selection. Keep changes close to detail/list surfaces so database schema and scan architecture remain unchanged.

**Tech Stack:** Electron IPC, React 19, TypeScript, Tailwind CSS, node:test.

---

### Task 1: Make Item Metadata Repair Explicit

**Files:**
- Modify: `src/components/ArtworkEditorControls.tsx`
- Modify: `src/pages/MovieDetail.tsx`
- Modify: `src/pages/TVDetail.tsx`

- [ ] Rename the primary detail action copy from generic refresh to "Fix Match" and add menu actions for "Refresh metadata" and "Refresh artwork".
- [ ] Keep `onFetchOfficialArtworkCandidates` wired to the primary action.
- [ ] Keep `onFetchOfficialArtwork` wired to the refresh action so one item can be refreshed without a full scan.
- [ ] Call `refreshLibrary` after each successful apply/refresh so React state immediately reflects stored metadata.

### Task 2: Preserve Candidate Application

**Files:**
- Modify: `src/components/ArtworkEditorControls.tsx`
- Verify: `src/main.ts`
- Verify: `src/lib/desktopApi.ts`

- [ ] Use the existing `desktopApi.getOfficialMetadataCandidates(mediaId)` and `desktopApi.applyOfficialMetadata(mediaId, candidate)` APIs.
- [ ] Keep candidate cards showing title, year, provider, rating, cover, and episode preview.
- [ ] Show a success toast when a candidate is applied and an error message when it fails.

### Task 3: Add Library Filters

**Files:**
- Create: `src/lib/libraryFilters.ts`
- Modify: `src/pages/Movies.tsx`
- Modify: `src/pages/TVShows.tsx`

- [ ] Add filter modes: all, in progress, unwatched, watched, missing metadata, missing artwork.
- [ ] Implement movie/show predicates using saved progress and existing item artwork/metadata fields.
- [ ] Add a compact segmented filter row under search on Movies, TV Shows, and Anime.
- [ ] Show "No items match this filter" when the library has items but the active filter removes them.

### Task 4: Improve Continue Watching

**Files:**
- Modify: `src/components/ContinueWatchingBar.tsx`

- [ ] Keep in-progress movies and episodes ranked by latest progress update.
- [ ] For TV/anime, show exact episode code, episode title, progress time, and next episode when available.
- [ ] If a show has no in-progress episode but has watched episodes, offer the next unwatched episode as "Up next".
- [ ] Preserve existing player arguments so clicking opens the correct episode with episode drawer context.

### Task 5: Verification

**Files:**
- Test: `tests/metadataSearch.test.ts`
- Build: renderer and main bundles

- [ ] Run `corepack pnpm test`.
- [ ] Run `corepack pnpm run build:main`.
- [ ] Run `corepack pnpm run build:renderer`.
- [ ] Manually inspect the changed renderer code for button text overflow and filter empty states.
