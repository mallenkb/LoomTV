# Library organization and recovery plan

Updated October 2, 2026. Status: implemented in the local `main` worktree. Static checks and the previously authorized organization and rename/undo tests pass. Broader recovery tests await the pending test authorization; native playback and the settings UI have not been exercised in the app.

Work directly on `main`. Build the original-state and recovery foundations before expanding automatic cleanup.

## Required behavior

Loom records the original names and locations before its first change to imported content. That original inventory is permanent. Later renames never replace it. The user-facing reverse action is **Restore original**, which targets the first recorded state rather than the preceding rename batch.

The original location is where Loom first encounters the import in a configured library. If the user moves content from Downloads into Movies before scanning, restoration returns it to its original location within Movies. It does not return it to Downloads.

The inventory records names, locations, relationships, and file identity information. It does not create backup copies of videos.

## Category rules

- **TV shows and anime shows:** use the same episode organization and restoration rules. Organize confirmed episodes under `Show name (year)/Season NN/`, reuse matching show and season folders, and preserve the actual season and episode numbers.
- **Movies:** use `Movie name (year)/Movie name (year).ext`, with no season folder. Both an imported movie folder and a standalone movie file follow these rules.
- Use the configured library category and confirmed metadata to distinguish shows from movies. A standalone video can be an episode; being loose does not make it a movie.
- Original inventories, recovery, cleanup, deletion history, and fresh-import identity rules apply to all three categories.

## Placement scenarios

### Imported movie folder

Original:

```text
Movies/Runner.2026.WEB-DL/
  Runner.2026.1080p.mkv
  Runner.en.srt
  downloaded-from.txt
  website-ad.jpg
```

After a confirmed match, organize the folder and video as:

```text
Movies/Runner (2026)/Runner (2026).mkv
```

Eligible external subtitles and recognized download clutter move to cleanup holding storage. Useful artwork and unknown files remain protected. Restore original reconstructs the first folder structure and filenames, including held extras that are still available. It reports anything missing or blocked.

### Standalone movie

Original: `Movies/Runner.mkv`.

After confirming the title and year: `Movies/Runner (2026)/Runner (2026).mkv`.

Record the flat original location before creating the movie folder. Check for existing folders and duplicate content before moving. Restore original returns the file to `Movies/Runner.mkv`. Remove a Loom-created folder only when it is empty. Never remove a pre-existing folder or unrelated content subsequently added to it.

If the title or release year cannot be established, leave the video in place for review.

### TV or anime episode placed directly inside an existing show folder

This behavior applies equally to TV shows and anime shows. Person of Interest is the TV example below; an anime episode follows the same steps inside its anime show folder.

Original:

```text
TV Shows/Person of Interest (2011)/
  Season 01/
  Season 02/
  Person.of.Interest.S02E05.mkv
```

Once the show, season, and episode are confirmed, move the new episode into the existing `Season 02` folder and use the confirmed episode naming format. Create the season folder only if it is absent. Reuse the existing show folder. Do not create a second show folder or change the season numbering.

Capture an original record for the newly imported episode and its associated files. Restore original for that import puts the episode back directly inside the Person of Interest folder, under its original filename. It leaves pre-existing episodes, season folders, and unrelated later additions alone. A duplicate episode or occupied destination stops the move for review.

### TV or anime episode placed directly in a category library

A loose episode in Anime or TV Shows should join an existing, unambiguously matching show and season folder. Create only the missing folders. Record its original category-root location. Restore original returns that import to the category root and removes only empty folders created for it.

### Existing season folders

Preserve an established Season 2 even if Season 1 is absent. Never renumber seasons by their order or by the number of folders present. Use episode metadata to support corrections. Conflicting folder, filename, and provider evidence must be resolved explicitly rather than guessed.

## Implementation stages

### 1. Permanent original inventories and import identities

- Give each import a persistent identity separate from its movie or show metadata identity and its current path.
- Before any rename or cleanup operation, persist the original inventory of the affected imported content, including hidden files and directories.
- Keep the original paths immutable while tracking current locations separately.
- Associate folder-only moves with all affected original records.
- Give later episodes and other new imports their own records without replacing existing originals.
- Recover earlier original paths from reliable rename history where possible. Mark incomplete or unknown originals instead of presenting current names as proven originals.

### 2. Safe execution and recovery

- Persist the original inventory and an operation journal before touching the filesystem.
- Record completed steps and reconcile interrupted rename, cleanup, and restore operations on startup.
- Recheck source identities, destination conflicts, and folder contents immediately before acting.
- Include hidden entries when evaluating a directory. Avoid moving a whole directory based on a stale inspection of its children.
- Finish and verify any cross-drive copy before removing its source.
- Keep skipped or failed restoration files recoverable. A partial restore must not delete its remaining holding storage or mark the entire operation complete.

### 3. Restore original

- Plan restoration from the original inventory for the selected import, not just the latest batch.
- Restore original filenames, directories, relationships, and available held extras.
- Protect other imports and unrelated files, including content added after organization.
- Preview occupied destinations and missing content. Never overwrite unrelated files or claim full restoration when only part succeeded.
- Keep unresolved entries retryable. Do not let automatic organization immediately reverse a user's restoration.
- Offer **Rename using metadata** for an available import. Preview and apply only that import, preserve every first-recorded original, and release its restoration protection only after a successful rename. Cancelled, blocked, or failed attempts retain protection; other restored imports remain protected.
- Update library paths, playback progress, artwork, subtitles, and other references alongside restored files.
- Remove Loom-created directories only when empty. Never delete a user's existing library or show folder as restoration cleanup.

### 4. Deleted-history records and re-imports

- When a successful scan of an accessible library confirms removal, hide the removed content from the active library and retain an inactive historical record.
- Retain its title, original inventory, former locations, and the time removal was detected. Do not claim to know the exact deletion time if deletion happened outside Loom.
- Do not preserve, copy, or temporarily store the deleted video. A history record cannot recreate it.
- Treat an unavailable or disconnected library location as unavailable, not as proof of deletion.
- A later download receives a fresh import identity and original inventory, even when the title and path are identical. Never apply an old import's restore operations to the new copy.

### 5. Subtitle and clutter cleanup

- Inspect each video for embedded subtitle language and purpose.
- Remove an ordinary external subtitle when a full embedded track covers the same language. Exact translation matching is not required under the user's selected policy.
- Preserve external tracks when language or full-dialogue coverage is uncertain. Do not assume an unlabelled subtitle is English for a destructive cleanup decision.
- Preserve forced, signs-only, commentary, and accessibility variants unless embedded tracks also cover their purpose.
- Clear recognizable download adverts, links, and unrelated images while preserving useful artwork and unknown files.
- Keep cleanup extras in holding storage for 30 days. This holding policy does not apply to videos the user deletes.
- Original inventories remain permanent after cleanup retention expires. Restore must report expired or missing contents; names alone cannot recreate files.
- Invalidate old cached subtitle-cleanup decisions when the policy changes.

### 6. Metadata and file-readiness safeguards

- Require the configured source confirmation before automatic organization, and reject every explicit provider-ID contradiction.
- Preserve existing show folders, correct seasons, and duplicate-destination protection.
- Treat unchanged size and timestamps as evidence of stability, not proof of completion. Combine known download markers, conservative settling, and a final readiness check.
- Leave ambiguous matches or active downloads in place with a clear reason. Automatic operations wait during playback and scanning.

### 7. Native playback restoration

- Keep the suspended video-track state until restoration succeeds in both LibVLC and libmpv.
- Check the engine's response, retry recoverable failures, and report restoration only after success.

### 8. User experience and validation

- Organize confirmed content automatically and show a brief result with **Restore original**.
- Distinguish original-state history, recoverable cleanup extras, and deleted-title history. Deleted videos have no action suggesting their contents can be recovered from the database.
- Show complete, partial, blocked, and unavailable restoration states accurately.
- Run lint and TypeScript checks.
- Cover the episode-placement scenarios separately for TV shows and anime shows, and the folder and standalone-file scenarios for movies. Also cover repeated renames, parent-only renames, hidden and newly added files, crash recovery, partial restoration, cross-drive failures, deletion and re-import, disconnected drives, subtitle coverage, paused downloads, and native video restoration failures.
- Run tests only with explicit user authorization, following AGENTS.md. Distinguish static checks, automated tests, and actual playback verification in the completion report.

## Completion criteria

The change is ready when each supported import can be organized without losing its first recorded identity, restoration returns only the selected content to its original available state, cleanup failures preserve recoverability, and actual video deletion retains history without retaining the video. Report any historical originals that could not be reconstructed and any runtime behavior not yet verified.


## Implementation and validation record

- `importInventory.ts` records import identities, complete available inventories before changes, permanent first paths, current locations, removal history, and restoration protection. Earlier rename and cleanup records supply recoverable history, marked as partial.
- The rename executor captures inventories before its existing operation journal, checks source identity again before each move, updates inventory paths in its database transaction, and restores selected imports through that same journal.
- Cleanup uses individual candidates, before-move journals, verified cross-drive copies, resumable transfers, and per-file restore results. A blocked restore retains its holding file. Legacy cleanup storage containing video is preserved for recovery.
- Settings now offers Original imports with an original-path preview, Restore original, and deleted history. Per-batch rename history remains available as a reference.
- TV and anime share season placement and duplicate protection. Movies retain title-and-year organization. Existing correct season numbers remain authoritative.
- Matching rejects conflicting provider IDs even if another ID agrees. Automatic organization and cleanup require a five-minute observation window and check known download markers. This cannot prove that a downloader using a final filename has finished; uncertain metadata and known partial downloads remain in place.
- Both native playback engines retain the suspended track until selection and frame decoding succeed, allowing the next poll to retry.

Validation performed against temporary fixtures, not the user's media:

- 11 existing organization tests passed.
- 7 focused original-restore and placement tests passed, including repeated renames, parent-only renames, TV/anime Season 2 placement, duplicate episodes, occupied destinations, and later-added files.
- ESLint, application and build-configuration TypeScript checks, static checking of the focused test sources, and whitespace checks passed.

Additional tests are written for cleanup interruption and retention, subtitle coverage, deletion/re-import, inaccessible roots, download settling, and playback retry. Their execution is awaiting the pending authorization. Actual cross-drive operation, native playback, and visual UI verification have not been performed. Historical files already deleted from old cleanup storage cannot be recreated. Recorded symbolic links are preserved and reported for manual restoration instead of traversed.


## Restore, rename again, and pause-resume follow-up

- Original imports now offers **Rename using metadata**. It previews only the chosen import, applies only the reviewed changes, and keeps the first recorded paths for future restoration. Other restored imports remain protected. Cancelled or stale previews leave protection intact.
- Repeated restore and metadata-rename cycles refresh the identity of each folder Loom recreates, so subsequent restoration can remove that folder if it is still empty and unchanged.
- Playback defaults to a three-second rewind on explicit resume after a pause. Each profile can turn it off or choose 1 to 30 seconds in Playback settings. Movie and episode playback, play buttons, keyboard shortcuts, and system media controls use the same preference. Initial playback, automatic recovery, and live TV do not request a rewind.
- Resume uses the current paused position, including a seek made while paused. Native adapters flush a pending scrub before resume. Browser playback stays inside its available seekable range.
- Nine focused original-name and placement tests passed, including repeated restore/metadata-rename cycles and stale-preview protection. Playback behavior still needs runtime verification; it has been inspected and typechecked.
