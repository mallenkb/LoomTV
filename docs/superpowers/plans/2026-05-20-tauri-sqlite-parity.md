# Tauri SQLite Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tauri's JSON persistence with a SQLite database that matches the Electron app's durable library, settings, playback progress, and custom artwork behavior.

**Architecture:** Add a Rust database module backed by `rusqlite` and store the database at the Tauri app data path as `loomtv.sqlite`. Keep the existing Tauri command surface stable so the renderer continues to call the same APIs. Migrate existing JSON files into SQLite on first use.

**Tech Stack:** Tauri 2, Rust 2021, rusqlite with bundled SQLite, serde_json.

---

### Task 1: SQLite Persistence Module

**Files:**
- Create: `src-tauri/src/database.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Write failing Rust tests**

Add tests for saving/loading library data, settings merge persistence, progress normalization, custom artwork aliases, backup, and clear behavior.

- [ ] **Step 2: Run tests to verify red**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: FAIL because `database` module and `rusqlite` dependency are missing.

- [ ] **Step 3: Implement database module**

Create the SQLite schema matching Electron's tables: `app_settings`, `library_folders`, `media_items`, `seasons`, `episodes`, `episode_files`, `scan_cache`, `playback_progress`, `custom_artwork`, and `artwork_cache`. Implement JSON migration and command-facing helpers.

- [ ] **Step 4: Wire Tauri commands**

Replace JSON-file helpers in `src-tauri/src/main.rs` with database-backed helpers while preserving existing command names and payload shapes.

- [ ] **Step 5: Verify**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

