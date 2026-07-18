# LoomTV Profiles Plan

## Status

- Stage: Proposed (revised 2026-07-18 after codebase review)
- Product direction: Netflix-style household profiles with a Disney+-inspired profile page
- Platforms: LoomTV Desktop and LoomTV Mobile
- Storage model: Local-first, owned by the desktop server
- Initial release: Managed local profiles, not cloud accounts

## 1. Product summary

LoomTV will use a Netflix-like household data model with a Disney+-inspired profile page, built around a shared household library:

- The desktop installation owns one media library.
- Each person gets a profile within that installation.
- Opening LoomTV shows a **Who's Watching?** screen when multiple profiles exist.
- Watch history, resume positions, watched status, and playback preferences are independent for each profile.
- Phones and tablets pair with the desktop once, then select a profile without pairing again.
- A profile switch affects only the device performing the switch.
- The Owner manages profiles, the library, network sharing, metadata, and application data.
- Kids profiles can eventually restrict content, but only after LoomTV supports real maturity classifications and server-side enforcement.

This is intentionally a household profile system rather than an email/password account platform. A future LoomTV account system can be added above it without changing the meaning of a profile.

## 2. Goals

### Primary goals

1. Provide a familiar **Who's Watching?** entry experience.
2. Keep every profile's viewing activity private from the other profiles in normal use.
3. Allow different devices to use different profiles concurrently.
4. Preserve all existing progress during upgrade.
5. Keep the library, scans, metadata, artwork, and server configuration shared.
6. Make one-profile LoomTV behave almost exactly as it does today.
7. Keep older mobile clients working against a profile-enabled desktop server.

### Non-goals for the first release

- Email/password registration
- Cloud-hosted profiles
- Invitations to other LoomTV installations
- Remote password recovery
- Profile data synchronization between unrelated desktop servers
- Social features
- Personalized recommendation algorithms
- Kids restrictions based only on the current numeric audience score
- Guest or temporary profiles

## 3. Profile types

### Owner

The first profile created automatically during migration.

Capabilities:

- Manage profiles.
- Configure library folders and scanning.
- Configure LAN sharing and paired devices.
- Configure metadata providers and credentials.
- Back up or clear application data.
- Set or remove profile PINs.
- Use the full shared library.

Rules:

- Exactly one Owner must exist.
- The Owner cannot be deleted.
- An Owner PIN is optional but recommended when Kids profiles exist.

### Standard

A normal household viewer.

Capabilities:

- Browse allowed content.
- Watch media.
- Maintain independent progress and track preferences.
- Switch to another profile, subject to its PIN.
- Change personal preferences when per-profile preferences are introduced.

Restrictions:

- Cannot change server administration settings.
- Cannot manage or delete profiles.

### Kids

A restricted managed profile.

Capabilities:

- Browse and play content allowed by its restriction policy.
- Maintain independent progress and playback preferences.

Restrictions:

- Cannot access server settings or profile management.
- Cannot see or stream blocked content.
- Unrated content is hidden by default.

Kids profiles should be exposed only after restriction checks are enforced by the server, not merely by hiding cards in the UI.

## 4. Mobbin design direction

The primary visual reference is the Disney+ desktop **Edit profiles** page supplied with this plan and found through Mobbin. The implementation should use the interaction principles and composition, not Disney branding, characters, typography, or copyrighted artwork.

Primary Mobbin references:

- [Disney+ Edit profiles screen](https://mobbin.com/screens/07319228-a432-4951-ba77-f050a71780af) — primary layout reference
- [Disney+ alternate Edit Profiles screen](https://mobbin.com/screens/b1144caf-2dda-42ef-8ec5-c7edbadf7038) — multi-profile wrapping and spacing reference
- [Disney+ Updating profile flow](https://mobbin.com/flows/b9c5cc02-9a31-4089-8194-2b34c0194942) — management-to-detail transition
- [Disney+ Adding a profile flow](https://mobbin.com/flows/d4196805-39b3-41ea-b374-1504c253387a) — add-profile form and return behavior

Secondary references:

- [Netflix profile lock PIN screen](https://mobbin.com/screens/f8bba7e1-53ea-4637-b4e0-9e00c911d178) — PIN-entry behavior only
- [Netflix Adding a profile flow](https://mobbin.com/flows/05a9f7c0-dabd-4cad-b8f1-510f89aea317) — fallback creation states

### Principles to carry into LoomTV

1. **Profiles are the only focal point.** Do not render the normal sidebar, media rows, or settings tabs behind the profile page.
2. **Selection and editing are separate modes.** The same profile cards are reused, but edit mode adds pencil badges and changes the page actions.
3. **The page stays visually quiet.** Use a nearly black LoomTV background, generous negative space, and one centered profile group.
4. **Status is visible on the card.** A protected profile shows a lock beneath its name; editability is shown with a pencil badge on the avatar.
5. **Add Profile behaves like another profile.** It occupies the same row and visual weight instead of becoming a toolbar button.
6. **Completion is explicit.** A high-contrast **Done** button remains in the top-right during editing.
7. **LoomTV remains recognizable.** Use the LoomTV logo, theme tokens, focus treatment, icons, and original avatar assets.

### Do not copy

- Disney characters or branded avatar art
- Disney+ logo or typography
- Exact Disney colors
- Disney-specific content-rating language
- Layout dimensions that fail LoomTV's desktop or mobile breakpoints

## 5. User experience

### First upgrade

1. LoomTV creates an Owner profile automatically.
2. Existing progress and playback preferences are assigned to the Owner.
3. If only the Owner exists and it has no PIN, LoomTV opens directly to Home.
4. The profile picker begins appearing after another profile is created.

No existing user should lose Continue Watching, watched flags, or resume positions.

### Who's Watching?

The profile picker is displayed before the normal application shell when selection is required.

It contains:

- LoomTV logo
- **Who's Watching?** heading
- Large avatar cards
- Profile names
- A Kids badge where appropriate
- **Add Profile** for an unlocked Owner
- **Manage Profiles** for an unlocked Owner

Interaction:

- Selecting an unprotected profile enters immediately.
- Selecting a protected profile opens a four-digit PIN pad.
- Escape or Back returns from the PIN pad to the profile grid.
- Failed PIN attempts show a neutral error without revealing sensitive information.
- Excessive failures temporarily lock further attempts.

All PIN-related interactions above ship in Phase 4. Until then, every profile is unprotected, no lock indicators are rendered, and selection always enters immediately.

#### Desktop composition

Use a full-window route or application gate rather than a modal over Home.

```text
┌─────────────────────────────────────────────────────────────────────┐
│ LoomTV logo                                           Edit Profiles │
│                                                                     │
│                         Who's watching?                             │
│                                                                     │
│              ( Avatar )   ( Avatar )   (   +   )                    │
│                 Marlon       Amara       Add profile                │
│                   🔒                                                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Layout requirements:

- LoomTV logo is anchored top-left within the normal window safe area.
- **Edit Profiles** is a quiet secondary button at top-right.
- Heading and profile group are horizontally centered.
- The content group sits slightly above the true vertical midpoint, matching the supplied Disney+ reference.
- Profiles use circular avatars rather than the square Netflix treatment.
- Names are centered beneath avatars and limited to one line.
- Protected status appears below the name, not over the artwork.
- **Add profile** uses a neutral circular surface with a centered plus icon.
- Up to five items remain in one row on a large desktop window; additional items wrap into a centered second row.
- The page scrolls vertically only when the available height cannot fit the profile group.

Recommended responsive sizing:

| Element | Desktop | Compact desktop/tablet | Mobile |
|---|---:|---:|---:|
| Avatar | 152–176 px | 112–136 px | 88–104 px |
| Gap between cards | 36–48 px | 24–32 px | 16–24 px |
| Profile-card width | Avatar width + 24 px | Avatar width + 20 px | 112–128 px |
| Heading | 34–40 px | 28–34 px | 26–30 px |
| Edit badge | 38–42 px | 34–38 px | 30–34 px |

Use responsive clamps rather than rigid screenshot dimensions.

### Edit Profiles page

Selecting **Edit Profiles** changes the page in place instead of navigating into the normal Settings shell. This page follows the supplied Disney+ profile-page reference most closely.

```text
┌─────────────────────────────────────────────────────────────────────┐
│ LoomTV logo                                                   DONE  │
│                                                                     │
│                          Edit profiles                              │
│                    Select a profile to edit                         │
│                                                                     │
│              ( Avatar )   ( Avatar )   (   +   )                    │
│                   ✎            ✎                                    │
│                 Marlon       Amara       Add profile                │
│                   🔒                                                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Required behavior:

- Change the title to **Edit profiles**.
- Add the subtitle **Select a profile to edit**.
- Replace **Edit Profiles** with a high-contrast **Done** button.
- Add a small circular pencil badge to the lower-right of every editable avatar.
- Keep the lock icon visible beneath protected profiles (from Phase 4 onward).
- Keep **Add profile** in the same grid.
- Selecting a profile opens its detail editor.
- Selecting **Done** returns to **Who's watching?** with the updated profiles.
- Escape or Back also returns to **Who's watching?**, after prompting only when there are unsaved detail changes.

Visual details:

- Pencil badges use a light circular surface and dark pencil icon for immediate recognition.
- The badge overlaps the avatar edge but must not obscure the face or central artwork.
- The selected or keyboard-focused profile receives a LoomTV accent ring and a slight scale/elevation change.
- Mouse hover, keyboard focus, controller focus, and touch press must be visually distinct.
- Avoid permanent card borders; preserve the open, lightweight Disney+ composition.

### Profile detail editor

Selecting a profile from edit mode opens a focused editor, based on the [Disney+ Updating profile flow](https://mobbin.com/flows/b9c5cc02-9a31-4089-8194-2b34c0194942).

Desktop layout:

- Form column on the left.
- Large avatar preview on the right.
- Pencil badge on the preview opens avatar selection.
- **Done** remains top-right.
- Destructive **Delete profile** action is separated at the bottom.

Initial fields:

- Profile name
- Avatar
- Standard or Kids profile type

Phase 4 field:

- Profile PIN — the editor must not expose a PIN control before hashing, throttling, and the PIN pad exist

Later fields:

- Autoplay
- Preferred audio and subtitle language
- Allowed libraries
- Content rating
- Unrated-content behavior

Saving should show a brief non-blocking confirmation and return to the edit grid only when the user chooses **Done** or Back. Do not force a round trip to Settings after every small change.

### Profile creation

The Owner chooses:

- Name
- Preset avatar
- Avatar color
- Standard or Kids type
- Optional four-digit PIN (Phase 4)
- Later: allowed libraries and maturity level

Use bundled avatar presets for the initial release. Uploaded avatar images would introduce file management, resizing, synchronization, and cleanup work that is not necessary for the core experience.

The creation page should follow the hierarchy in the [Disney+ Adding a profile flow](https://mobbin.com/flows/d4196805-39b3-41ea-b374-1504c253387a): compact form, prominent avatar preview, explicit Save, and a quiet Cancel action. Do not put the full server-settings interface on this page.

### Profile switching

Desktop:

- Show the active avatar at the bottom of the sidebar.
- Selecting it opens **Switch Profile**, **Lock**, and **Manage Profiles** actions.

Mobile:

- Show the active avatar in the header or account/settings menu.
- Selecting it opens the profile picker.

When switching:

1. If playback is active, ask whether to stop playback and switch.
2. Save final progress under the old profile.
3. End the old profile session on that device.
4. Clear profile-dependent caches.
5. Select and unlock the new profile.
6. Load the new profile's progress and preferences.
7. Recalculate Continue Watching and Recently Played.
8. Return to Home.

A profile switch on one phone must not change the desktop or another phone.

### Profile management

Add a **Profiles** section to Settings with:

- Create profile
- Rename profile
- Change avatar and color
- Reorder profiles
- Add, change, or remove PIN
- Convert Standard to Kids or Kids to Standard
- Configure restrictions when available
- Delete a managed profile

Deleting a profile must explain that its watch history and preferences will be permanently deleted. Shared media, metadata, and artwork remain untouched.

The Settings section is an administrative entry point into the dedicated Edit Profiles page; it should not duplicate the complete profile grid inside Settings.

## 6. State ownership

| Per profile | Shared by the LoomTV server |
|---|---|
| Resume positions | Library folders |
| Watched/unwatched state | Library scans and scan cache |
| Continue Watching | Media metadata |
| Recently Played | Posters, backdrops, and logos |
| Audio preferences | Custom artwork |
| Subtitle preferences | Intro, recap, and credits markers |
| PIN and avatar | Transcoding configuration |
| Content restrictions | LAN pairing and paired devices |
| Watchlist and favourites, later | Metadata provider credentials |
| Personal UI preferences, later | Backups and updates |

Theme, sidebar order, and skip-forward intervals can remain server-wide during the first release. They can move into a `profile_preferences` table later.

## 7. Database design

### Migration ledger

Introduce a migration ledger before performing table rebuilds:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

This ensures the profile migration runs exactly once and makes failed or partial upgrades easier to diagnose.

The ledger must coexist with the existing introspection-style migrations in `databaseMigrations.ts` (idempotent `CREATE TABLE IF NOT EXISTS` plus column-check rebuilds such as `migrateMediaSegmentsPrimaryKey`). Rules:

- On first run, record the detected pre-profile schema as version 0 without replaying anything.
- Existing introspection migrations are not retrofitted into the ledger; they continue to run exactly as they do today.
- Only new migrations, starting with the profiles migration, are ledger-versioned. The ledger is the single source of truth for those and nothing else.

### Profiles

```sql
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_key TEXT NOT NULL,
  color_key TEXT NOT NULL,
  profile_type TEXT NOT NULL
    CHECK (profile_type IN ('owner', 'standard', 'kid')),
  pin_hash TEXT,
  pin_salt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0
);
```

Application validation must prevent deletion of the last profile. The one-Owner rule is enforced at the database level, not only in application code:

```sql
CREATE UNIQUE INDEX one_owner ON profiles(profile_type)
  WHERE profile_type = 'owner';
```

`pin_hash` and `pin_salt` remain NULL until Phase 4 ships PIN support.

### Profile-scoped progress

Rebuild `playback_progress`:

```sql
CREATE TABLE playback_progress_new (
  profile_id TEXT NOT NULL
    REFERENCES profiles(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  watched INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, file_path)
);
```

### Profile-scoped track preferences

Rebuild `playback_track_preferences`:

```sql
CREATE TABLE playback_track_preferences_new (
  profile_id TEXT NOT NULL
    REFERENCES profiles(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  preferences_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, scope)
);
```

### Per-device selection

```sql
CREATE TABLE device_profile_selections (
  device_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL
    REFERENCES profiles(id) ON DELETE CASCADE,
  selected_at INTEGER NOT NULL
);
```

Use a stable reserved device identifier for the primary desktop renderer. Paired mobile devices use their existing device IDs.

Selection is durable; unlock is not. PIN unlock state is ephemeral per-boot state owned in memory by the profile service (see section 13) and is deliberately not stored in this table — persisting it would raise unanswerable questions such as what an expiry means mid-playback.

### Known limitation: file-path keys

Progress remains keyed by absolute `file_path`. Renaming or moving a media file already orphans its history today; profiles multiply that fragility by the number of profiles. This is an accepted limitation for v1 and explicitly out of scope for the profiles migration.

### Later restriction tables

```sql
CREATE TABLE profile_library_access (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL,
  PRIMARY KEY (profile_id, folder_path)
);

CREATE TABLE profile_content_restrictions (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL,
  allowed_ratings_json TEXT NOT NULL DEFAULT '[]',
  hide_unrated INTEGER NOT NULL DEFAULT 1
);
```

## 8. Safe migration sequence

The migration is the highest-risk part of this feature.

1. Create an automatic backup using `VACUUM INTO` or better-sqlite3's `.backup()` — never a plain file copy of an open WAL-mode database, since recent writes live in the `-wal` file.
2. Verify the backup opens and passes `PRAGMA integrity_check`.
3. Begin a database transaction.
4. Create `schema_migrations` if required and record the version-0 baseline.
5. Generate a UUID for the Owner profile.
6. Insert the Owner profile.
7. Create the new progress table.
8. Copy every existing progress row using the Owner profile ID.
9. Compare old and new progress row counts.
10. Create the new track-preference table.
11. Copy every existing preference using the Owner profile ID.
12. Compare old and new preference row counts.
13. Rename the original tables to temporary backup names.
14. Rename the new tables to their final names.
15. Run foreign-key and integrity checks.
16. Record the profiles migration version.
17. Commit the transaction.
18. Drop the temporary backup tables later, in a separate transaction, only after the application has started successfully against the new schema. A crash between the two transactions must leave the database recoverable.

On any failure before commit, roll back and retain the pre-migration backup file.

## 9. Desktop architecture

### Main-process profile service

Add a profile service under `apps/desktop/src/main/` responsible for:

- Profile CRUD operations
- Profile validation
- PIN hashing and verification
- Active profile lookup by client/device
- Owner authorization
- Lock and unlock state
- Last-used timestamps
- Profile lifecycle events

The main process remains the authority. Normal renderer progress calls must not accept an arbitrary profile ID.

### Repository changes

Update the playback repository API to require a profile:

```ts
getProgress(profileId, filePath)
getAllProgress(profileId)
saveProgress(profileId, filePath, position, duration)
importProgress(profileId, progress)

getPlaybackTrackPreferences(profileId, scope?)
savePlaybackTrackPreferences(profileId, scope, preferences)
```

`profileId` should be required internally. Silent fallback to a default profile would make future state leaks difficult to detect.

### Renderer context

Add `ProfileProvider` above the application shell. It exposes:

- Profiles
- Active desktop profile
- Selection-required state
- Owner-unlocked state
- Select, switch, lock, create, update, and delete operations
- A profile revision used to invalidate dependent state

The application renders either the profile gate or the normal shell.

### Progress cache lifecycle

On profile change:

1. Prevent new writes for the old profile.
2. Wait for or cancel outstanding old-profile writes.
3. Unsubscribe from old progress notifications.
4. Clear the in-memory progress map.
5. Reset database hydration state.
6. Fetch progress for the new profile.
7. Notify progress subscribers.
8. Resume saves under the new profile.

The legacy localStorage migration must import into the Owner profile once, then remove the old local value.

### Recently Played and `lastPlayed`

`MediaItem.lastPlayed` currently mixes catalog data with viewer state. Profiles require a clean separation:

- Treat the library payload as profile-neutral.
- Derive Recently Played from the selected profile's progress timestamps.
- Stop using the shared `media_items.last_played` value as current-viewer state.
- Deprecate `lastPlayed` from the shared media wire object after compatibility work is complete.

This prevents one profile's activity from reordering Home for another profile.

## 10. Desktop IPC

Add:

```text
profiles:list
profiles:get-active
profiles:create
profiles:update
profiles:delete
profiles:select
profiles:lock
```

`profiles:select` accepts the PIN in the same call and verifies it atomically. There is deliberately no standalone verify-PIN channel: a separate verification step would create a check-then-act race and expose a PIN oracle with its own attack surface. PIN verification for administrative operations happens inside those operations.

Add events:

```text
profiles:changed
profile:active-changed
```

Existing progress and track-preference IPC handlers resolve the active desktop profile in the main process.

Administrative profile operations require the Owner profile and its PIN when configured.

## 11. LAN and mobile architecture

### Separate device trust from viewer identity

Pairing means:

> This phone or tablet is trusted by this LoomTV desktop.

Profile selection means:

> This trusted device is currently being used by this viewer.

A user should not need to pair again when switching profiles.

### Profile endpoints

```http
GET  /api/v2/profiles
GET  /api/v2/profiles/active
POST /api/v2/profiles/select
POST /api/v2/profiles/lock
```

Safe list response:

```json
{
  "profiles": [
    {
      "id": "profile-uuid",
      "name": "Amara",
      "avatarKey": "sunset-03",
      "colorKey": "orange",
      "type": "standard",
      "hasPin": true
    }
  ]
}
```

Selection request:

```json
{
  "profileId": "profile-uuid",
  "pin": "1234"
}
```

Never expose hashes, salts, internal restriction records, or administrative data.

### Route policy and error contract

- Classify the new `/api/v2/profiles*` routes in `lanRoutePolicy.ts`. Listing and selecting require a paired device token; nothing profile-related is public.
- When a device with no selected profile calls a profile-scoped endpoint, respond `409` with `{ "error": "profile_required" }`. The mobile client branches on this deterministically and shows its picker.
- When a device's selected profile has been deleted, respond with the same `profile_required` error.
- Old clients never receive `profile_required`: they are pinned to a fallback profile (section 12).

### Profile-scoped existing endpoints

After selection, resolve the requesting device's profile for:

```text
GET/POST /api/v2/progress
GET/POST /api/v2/playback-track-preferences
GET /api/v2/client-config
```

When kids restrictions exist, also resolve it for:

```text
GET /api/v2/library
POST /api/v2/start-hls
media resource requests
search and artwork access where applicable
```

### Mobile startup

1. Restore paired-device credentials.
2. Connect to the desktop.
3. Read server capabilities.
4. Fetch profiles.
5. Automatically select the only unprotected profile, if there is one.
6. Otherwise show **Who's Watching?**.
7. Select and unlock the profile.
8. Fetch profile progress and playback preferences.
9. Render Home.

The selected profile ID may be cached locally for display, but the desktop server remains the source of truth.

## 12. Compatibility

Extend client config:

```json
{
  "profileApiVersion": 1,
  "capabilities": {
    "profiles": true,
    "profilePins": true,
    "kidsRestrictions": false
  }
}
```

Rules:

- New desktop + old mobile: use the migrated Owner profile.
- New mobile + old desktop: hide profile controls.
- One profile: preserve current behavior.
- Multiple profiles + old mobile: keep that device on its fallback profile (the Owner by default) and show an upgrade notice in desktop paired-device management.
- The Owner can reassign a legacy device's fallback profile from paired-device management, using the same `device_profile_selections` mechanism. This turns the compatibility fallback into a feature: an old tablet can be pinned to a kid's profile without an app update.
- Do not break library or playback responses unnecessarily.

## 13. PIN handling

Profile PINs provide household privacy, not strong operating-system security.

Requirements:

- Store only a slow password hash and random salt.
- Use Node's built-in `crypto.scrypt`. Do not add a native hashing dependency such as Argon2id to the Electron main process; it buys nothing here and adds build-matrix cost.
- With a four-digit space (10,000 possibilities), throttling is the real defense; the hash choice is secondary.
- Compare verification results safely.
- Never log PIN values.
- Rate-limit by profile, device, and network address, reusing the throttling pattern from `pairRateLimit.ts`.
- Apply increasing retry delays.
- Keep unlock state in memory in the profile service, scoped to the current app boot; nothing about unlock is persisted.
- Unlock expiry only re-gates entering the profile; it never interrupts an active playback session.
- Clear unlock state when explicitly locked.
- Require Owner authorization for profile administration.
- Explain in UI that a PIN does not encrypt local files or the database.

## 14. Kids profiles and content enforcement

The current numeric `rating` represents audience/provider scores, not maturity classifications. Kids restrictions need a new certification pipeline.

Required work:

1. Add movie and series content-certification fields.
2. Retrieve certifications from supported metadata providers.
3. Normalize country-specific systems such as PG-13, R, TV-14, and TV-MA.
4. Let the Owner choose the applicable country.
5. Define rating presets and allowed ratings.
6. Hide unrated content by default.
7. Filter catalog, search, Home, details, and Continue Watching.
8. Reject blocked stream-start requests on the server.
9. Reject direct access to blocked media resources.
10. Prevent autoplay from crossing into blocked content.
11. Make `/api/v2/library` ETags profile-aware. Filtering makes the response profile-shaped, so the ETag must incorporate the profile and its restriction-policy revision — otherwise switching profiles on one device can serve the wrong catalog from cache.

Kids mode is not complete until direct API attempts are rejected. Hiding a poster is not access control.

## 15. Deletion behavior

When deleting a managed profile:

1. Verify Owner authorization.
2. Prevent deletion of the Owner or last remaining profile.
3. Show how much viewing data will be removed.
4. Require explicit confirmation.
5. Switch devices currently using the profile to `profile_required`.
6. Delete profile-owned records in one transaction.
7. Preserve all shared library and metadata records.
8. Emit profile-change events.
9. Return all affected clients to the picker.

## 16. Delivery phases

### Phase 1: Invisible foundation

- [x] Add a migration ledger.
- [x] Add the profiles table.
- [x] Create the Owner migration.
- [x] Rebuild and backfill progress.
- [x] Rebuild and backfill track preferences.
- [x] Add the profile service.
- [x] Require profile IDs in playback repositories.
- [x] Make one-profile behavior match the current application.
- [x] Remove shared `lastPlayed` from current-viewer decisions.

Exit criterion: the migrated Owner retains all existing viewing state and the app behaves as it did before profiles.

### Phase 2: Desktop experience

- [x] Add `ProfileProvider`.
- [x] Add the full-window **Who's watching?** profile picker.
- [x] Add the Disney+-inspired **Edit profiles** mode.
- [x] Add the top-left LoomTV logo and top-right Edit/Done actions.
- [x] Add circular profile cards and overlapping pencil badges.
- [x] Add the centered responsive profile grid and wrapping behavior.
- [ ] Add keyboard, mouse, controller, and touch focus states (mouse/keyboard done; controller pending).
- [x] Add the focused profile detail editor.
- [x] Add profile avatar presets.
- [x] Add the sidebar switcher.
- [ ] Add the Profiles settings section.
- [ ] Add create, rename, reorder, and delete flows (create/rename/delete done; reorder pending).
- [x] Invalidate progress and Home state during switching.
- [ ] Restrict server settings to the Owner.

Exit criterion: two desktop profiles can watch the same file with independent progress and watched state.

### Phase 3: Mobile and LAN

- [ ] Add profile capabilities to client config.
- [ ] Add list, active, select, and lock endpoints.
- [ ] Resolve profile selection per paired device.
- [ ] Add the mobile profile picker.
- [ ] Add the mobile profile switcher.
- [ ] Scope mobile progress and track preferences.
- [ ] Add old-client compatibility behavior.

Exit criterion: desktop and multiple mobile devices can concurrently use different profiles without state crossing between them.

### Phase 4: PIN protection

- [ ] Add PIN hashing and verification with `crypto.scrypt`.
- [ ] Add the PIN pad.
- [ ] Add the PIN field to the profile detail editor.
- [ ] Add lock indicators to the picker and edit-mode cards.
- [ ] Add attempt throttling.
- [ ] Add in-memory lock and unlock expiry behavior.
- [ ] Protect profile administration.
- [ ] Protect Owner-only settings.

Exit criterion: normal UI and API flows cannot enter a protected profile without its PIN.

### Phase 5: Kids restrictions

- [ ] Add maturity certification metadata.
- [ ] Add rating normalization.
- [ ] Add library access policies.
- [ ] Add restriction management UI.
- [ ] Filter all discovery surfaces.
- [ ] Enforce restrictions on streaming and direct resource access.
- [ ] Make library ETags incorporate the profile and restriction revision.
- [ ] Add an unrated-content policy.

Exit criterion: blocked content cannot be discovered or played by a Kids profile, including through direct API calls.

### Phase 6: Personalization

- [ ] Add per-profile watchlists.
- [ ] Add favourites.
- [ ] Add personal appearance preferences.
- [ ] Add optional automatic profile sign-in per device.
- [ ] Add profile history import/export.
- [ ] Consider guest profiles.

## 17. Verification matrix

### Migration

- Existing progress count matches the migrated Owner progress count.
- Existing track preferences remain intact.
- A failed migration rolls back without altering the original tables.
- The automatic backup can restore the previous database.

### Isolation

- Two profiles can store different positions for the same file.
- Watched state does not cross profiles.
- Audio and subtitle choices do not cross profiles.
- Recently Played and Continue Watching update immediately after switching.
- Profile switches on one device do not affect other devices.

### Switching

- Active playback saves to the old profile before switching.
- In-flight old-profile writes cannot update the new profile.
- Returning to a previous profile restores its state.
- Deleting an active profile returns affected devices to the picker.

### Security

- PINs never appear in logs or API responses.
- Repeated failures are throttled.
- Standard and Kids profiles cannot access Owner administration.
- Restricted streams fail even when the media resource ID is known.

### Compatibility

- New desktop with old mobile uses the default profile safely.
- New mobile with old desktop continues without profile UI.
- One-profile installations retain the existing startup experience.
- Existing paired devices do not need to pair again.

## 18. Likely code areas

### Desktop main process

- `apps/desktop/src/main/databaseMigrations.ts`
- `apps/desktop/src/main/databasePlaybackRepository.ts`
- `apps/desktop/src/main/databaseLibraryRepository.ts`
- `apps/desktop/src/main/database.ts`
- `apps/desktop/src/main/ipcHandlers.ts`
- `apps/desktop/src/main/mediaServer.ts`
- `apps/desktop/src/main/lanSecurity.ts`
- `apps/desktop/src/main/lanRoutePolicy.ts`
- `apps/desktop/src/main/pairRateLimit.ts` (reused for PIN throttling)
- `apps/desktop/src/main/appContracts.ts`
- New `apps/desktop/src/main/profileService.ts`

### Shared desktop contracts

- `apps/desktop/src/shared/ipcChannels.ts`
- `apps/desktop/src/shared/ipcContract.ts`
- `apps/desktop/src/shared/desktopProtocol.ts`
- `apps/desktop/src/preload.ts`

### Desktop renderer

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/lib/desktopApi.ts`
- `apps/desktop/src/lib/progress.ts`
- `apps/desktop/src/components/Sidebar.tsx`
- `apps/desktop/src/components/ContinueWatchingBar.tsx`
- `apps/desktop/src/pages/Home.tsx`
- `apps/desktop/src/pages/Settings.tsx`
- `apps/desktop/src/pages/Settings.helpers.ts`
- New `apps/desktop/src/contexts/ProfileContext.tsx`
- New profile picker and profile management components

### Mobile

- `apps/mobile/App.tsx`
- `apps/mobile/mobileLanClient.ts`
- `apps/mobile/mobileLibrary.ts`
- `apps/mobile/mobileDomain.ts`
- `apps/mobile/mobileStyles.ts`
- New profile picker and avatar components

## 19. Recommended v1 scope

The first release should include:

- Automatic Owner migration
- Multiple Standard profiles
- Disney+-inspired profile selection and **Edit profiles** pages
- Circular profile avatars with edit and lock states
- Independent progress, watched state, and track preferences
- Desktop profile switching
- Mobile profile selection and switching
- Per-device active profiles
- Preset avatars
- Owner-only profile management
- Backwards-compatible default-profile behavior

Defer these until later:

- Kids content filtering
- Cloud accounts
- Uploaded avatars
- Watchlists and favourites
- Per-profile theme settings
- Guest profiles

This scope delivers the part users immediately understand and value while keeping the migration and identity model small enough to implement safely.
