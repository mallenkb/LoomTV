# LoomTV — Full Codebase Audit

**Date:** 2026-08-04
**Commit:** `8e66d3b` (Release LoomTV 1.0.104), branch `main`
**Scope:** `apps/desktop`, `apps/mobile`, `apps/server`, `packages/*`, `scripts/`, CI, build/release config

---

## 📊 Snapshot

| Metric | Value |
|---|---|
| Total source LOC (excl. deps/generated) | ~73,000 |
| `apps/desktop/src` | 48,257 |
| `apps/mobile` | 11,286 |
| `apps/server/src` | 4,193 |
| `packages/*` | 1,242 |
| Test files | 58 (46 desktop / 7 mobile / 5 server) |
| Tests passing | 216 (203 desktop + mobile + server), 1 `todo` |
| Files > 500 lines | 33 |
| `as any` occurrences | **0** |
| `@ts-ignore` / `@ts-expect-error` | **0** |
| `eslint-disable` occurrences | 12 (11 in `apps/mobile/App.tsx`) |

**Health checks run for this audit:**

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ pass (exit 0) |
| `pnpm lint` | ✅ pass (exit 0) |
| `pnpm test` | ✅ pass (216 tests, 0 failures) |
| `pnpm audit:prod` | ❌ **fail (exit 1)** — 6 advisories, 2 high |

---

# 🔴 Bugs, Defects and Risks

Ordered by severity. Each entry states what I verified, not what I suspect, unless labelled as such.

## 🔴 HIGH-1 — The supply-chain CI gate is currently failing

**Where:** `scripts/audit-production.cjs`, `security/production-audit-waivers.json`, `.github/workflows/build-installers.yml:44`

Running the exact command CI runs:

```
$ node scripts/audit-production.cjs; echo $?
moderate: GHSA-fxqj-rqcc-2cmp postcss — incomplete fix of GHSA-6g55-p6wh-862q — attacker-controlled sourceMappingURL reads arbitrary .map files when `from` is unset (no waiver)
moderate: GHSA-8xcm-r25x-g524 undici — downstream response desynchronization via retry interceptor (no waiver)
high:     GHSA-7p8r-x3mc-p8w7 fast-uri — host confusion via backslash authority introducer (no waiver)
moderate: GHSA-m8rv-5g2x-5cg5 undici — CRLF injection via blob-like body 'type' property (no waiver)
moderate: GHSA-v3r7-h72x-cjcm undici — cookie attribute injection via unsanitized domain (no waiver)
high:     GHSA-rgw5-rvv9-x895 brace-expansion — DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation (no waiver)
Workspace production audit failed with 6 advisory finding(s).
1
```

The `supply-chain` job runs on `pull_request` **and** on `push: tags: v*`. It is red today, which means every PR shows a failing check and every release tag trips the gate.

What makes this notable rather than routine: `pnpm-workspace.yaml` already carries pins intended to close exactly these — `'@expo/cli>undici': 6.27.0`, `'fast-uri@3.1.2': 3.1.4`, `brace-expansion: 5.0.8` plus a local patch in `patches/brace-expansion@5.0.8.patch`. Those pins are no longer sufficient; the advisories now cover the pinned versions too. The `security/production-audit-waivers.json` file is an empty `{"advisories": {}}`, so nothing is suppressed either.

**Impact:** Release pipeline blocked. That much is certain and is the actionable part.

**Caveat on severity — these are not yet established as product vulnerabilities.** `pnpm audit --prod` classifies by *manifest position*, not by what ships or executes. `postcss`, `undici` and `fast-uri` reach the closure through Expo CLI / Metro tooling, which is build-time machinery; `expo` sits in `dependencies` in `apps/mobile/package.json`, so the audit counts it as production regardless. Before describing any of the six as a shipped vulnerability, confirm reachability per advisory:

- Does the package land in the packaged Electron app (`electron-builder` `files` allowlist is `.vite/build`, `.vite/renderer`, `package.json`, `node_modules`) or the mobile binary — or only in the build container?
- Is the vulnerable code path reachable from attacker-controlled input at runtime? `postcss` `sourceMappingURL` and `undici` cookie/CRLF handling are unlikely to be, in this app's shape.

**Fix:** Bump the overrides to fixed versions and refresh the `brace-expansion` patch against the new mitigation. For anything that triage shows is build-time-only, add a **dated, justified waiver** to `security/production-audit-waivers.json` — that file exists for exactly this purpose and is currently empty. Restoring a green gate honestly matters more than driving the count to zero.

---

## 🔴 HIGH-2 — Mobile poster / metadata editing is permanently broken (HTTP 410)

**Where:** `apps/mobile/mobileLanClient.ts:130-143`, `apps/mobile/App.tsx:2906-2966`, `apps/desktop/src/main/lanRoutePolicy.ts:53-55`, `apps/desktop/src/main/mediaServer.ts:1026-1029`

The mobile client calls two desktop endpoints:

```ts
// mobileLanClient.ts:131
fetchImpl(`${baseUrl}/api/artwork/official-candidates`, { method: 'POST', ... })
// mobileLanClient.ts:138
fetchImpl(`${baseUrl}/api/artwork/apply-official`, { method: 'POST', ... })
```

Both paths are members of `IPC_ONLY_HTTP_ROUTES`:

```ts
// lanRoutePolicy.ts
'/api/artwork/refresh-official',
'/api/artwork/official-candidates',
'/api/artwork/apply-official',
```

and `mediaServer.ts` short-circuits every one of them before any handler runs:

```ts
if (routeAccess.kind === 'ipc-only') {
  writeJson(res, 410, { error: 'This operation is available only through validated Electron IPC.' });
  return;
}
```

**Failure scenario (deterministic):** a paired phone opens a title's detail sheet and taps the poster-refresh control → `refreshPosterOnHost()` → 410 → `readJsonResponse` returns `{error: "This operation is available only through validated Electron IPC."}` → `throw new Error(message)` → `setArtworkRefreshError(...)`. The user sees the raw developer string *"This operation is available only through validated Electron IPC."* in the mobile UI. `applyPosterCandidate()` fails identically.

This is not dead code — both are wired to live UI controls (`PosterCandidateSheet`, `refreshingArtworkId`, `applyingPosterCandidateId`).

**Fix:** either remove the mobile controls and the two client methods, or expose scoped v2 equivalents — but **not** behind `playback:write`. That scope covers per-profile state (progress, lists, preferences); artwork and metadata edits mutate the **shared library** that every profile sees. These need an owner-only capability, consistent with how the desktop already gates them (`authorizeSettingsWrite()` → `requireOwner()` at `ipcHandlers.ts:660-670`). Shipping a button that cannot work is the worst of the available options.

---

## 🟠 MEDIUM-3 — Signed LAN URLs survive device revocation

> **Reclassified from High after review.** The original write-up framed this as "no replay protection" and recommended a single-use nonce store. That framing was wrong and the recommendation was actively harmful — see *Retracted* below.

**Where:** `apps/desktop/src/main/lanSecurity.ts:194-234, 274-287`

`requireStreamAccess` accepts a valid signature **before** it ever consults the paired-device table:

```ts
if (isLanSharingEnabled() && isSignedLanRequestValid(reqUrl)) return true;   // ← no device lookup
if (authorizeLanRequest(reqUrl, req).ok) return true;
```

`isSignedLanRequestValid` verifies only the HMAC and `exp`. The signed payload *does* carry `deviceId`, `profileId` and `selectionRevision` (`signedStreamUrlForRemote`, `main.ts:944-957`), and the artwork branch checks those against the current active selection — but nothing checks that the issuing device is **still paired**.

**Failure scenario:** an owner revokes a phone in Settings → Network (or the phone calls `/api/v2/unpair`). The device is removed from `localNetworkPairedDevices` and its access token stops working immediately. But any signed `/stream` URL it already holds keeps working for up to `MAX_SIGNED_LAN_URL_TTL_SECONDS` (15 minutes) — revocation is not immediate for the one capability that actually delivers media bytes.

**Retracted — do not implement single-use nonces.** Signed, expiring URLs are *normally* replayable bearer capabilities; that is the design (S3 presigned URLs, CloudFront signed URLs). Making them single-use would break this codebase concretely:

- `/stream` serves HTTP range requests (`mediaServer.ts:2025-2047`, 206 responses). A video player issues many range requests against one URL — seeking would break outright.
- Artwork URLs are served with `LAN_IMAGE_CACHE_CONTROL = 'private, max-age=31536000, immutable'`. Single-use directly contradicts a cache directive the code deliberately sets.
- HLS segment fetches and ordinary network retries would fail non-deterministically.

The deterministic `options.stable` nonce is likewise *correct* under this framing — it is a stable cache key, which is the point.

**Fix:** inside `isSignedLanRequestValid` (or at the `requireStreamAccess` call site), resolve the signed `deviceId` and confirm it is still present in `localNetworkPairedDevices` before returning true. Consider renaming `nonce` → `salt`, since the current name implies a replay guarantee that neither exists nor should.

---

## 🔴 HIGH-4 — macOS updates are installed without verifying the code signature

**Where:** `apps/desktop/src/main/autoUpdater.ts:265-330`, `apps/desktop/forge.config.ts:236`, `apps/desktop/tests/securityBoundaryContracts.test.ts:161`

The update path does exactly one integrity check:

```ts
async function verifyMacUpdateZip(updateFilePath: string): Promise<void> {
  const info = JSON.parse(rawInfo) as { sha512?: string; fileName?: string };
  if (!info.sha512) throw new Error('Downloaded update metadata is missing a sha512 checksum.');
  const actualSha512 = await sha512Base64(updateFilePath);
  if (actualSha512 !== info.sha512) throw new Error('Downloaded update checksum did not match the release metadata.');
}
```

That checksum comes from electron-updater's pending-info JSON, itself derived from `latest-mac.yml` fetched over HTTPS from GitHub. So the entire trust anchor is *TLS + GitHub account integrity*. After the hash check, `extractMacUpdate()` unzips with `ditto` and the helper script swaps the bundle in place — with **no `codesign --verify --deep --strict` and no `spctl -a -t exec` on the extracted `.app`** before it replaces the running application.

Three things compound this:

- `forge.config.ts:236` — `osxSign: { identity: process.env.MACOS_SIGNING_IDENTITY || '-' }`. If the signing secret is absent or misnamed in CI, the build **silently ad-hoc signs** instead of failing.
- Notarization verification is explicitly deferred: `test.todo('release signer and notarization verification remains deferred by user request')`.
- `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` fuses protect the *asar*, not the bundle-replacement step.

**Fix (corrected after review).** The obvious remediation — run `codesign --verify --deep --strict` and `spctl --assess` — is **not sufficient**, and the first version of this report was wrong to stop there:

- `codesign --verify` proves the bundle is *internally consistent* and unmodified since signing. It does **not** prove who signed it. An attacker-supplied bundle signed with any valid certificate passes.
- `spctl --assess` evaluates Gatekeeper policy. It does not by itself establish that the publisher is *the same* publisher as the running app.

What actually establishes trust is a **same-publisher check**: extract the designated requirement / Team ID from the running bundle and require the replacement to match, e.g.

```
codesign -dv --verbose=4 <extracted.app>   # capture TeamIdentifier
codesign --verify -R="anchor apple generic and certificate leaf[subject.OU] = <TEAM_ID>" <extracted.app>
```

Then gate the strictness correctly: enforce a real signing identity for **production release builds only** (`process.env.CI` / release workflow), and keep the ad-hoc `-` fallback for ordinary local packaging so developer builds are not broken. Making `osxSign` throw unconditionally — as the first draft suggested — would break local `pnpm package` for everyone.

---

## 🟠 MEDIUM-5 — A desktop restart bricks mobile playback until the library revision changes (via the 304 path)

> **Rewritten after review.** The original claim — "every desktop restart invalidates all outstanding mobile resource IDs" — was **wrong**, and the reviewer was right to challenge it. Verifying it produced a narrower but more serious bug.

**What I got wrong.** Resource IDs are deterministic: `HMAC(secret, kind\0path)`. They are stable across restarts. And `registerResource` is called *during library projection* — `progressKeyFor` (`main.ts:420`) for every item and episode, `signedStreamUrlForRemote` (`main.ts:949`) for every stream URL. So any catalog fetch repopulates the whole registry with byte-identical IDs. `hydrateSelectedProfile` (`App.tsx:2325-2329`) calls `fetchMobileCatalog` on every reconnect. Under a cache miss, the system self-heals exactly as the reviewer expected.

**The bug that survives.** The catalog fetch is ETag-conditional, and the payload is only built on a **miss**:

```ts
const writeCatalogRepresentation = (etag, payload) => {
  if (requestEtag === etag) { res.writeHead(304, ...); res.end(); return; }   // ← payload() never runs
  writeJson(res, 200, payload());                                             // ← only here do resources register
};
```

Mobile sends `If-None-Match` (`mobileLanClient.ts:106-110`) and on 304 keeps its cached catalog (`App.tsx:2300`). So the question is whether the ETag changes across a restart. Every component is persisted in SQLite:

| ETag component | Survives restart? |
|---|---|
| `catalogVersion`, `representation` | constant |
| `libraryRevision` | ✅ persisted |
| `profile.restrictions` | ✅ persisted |
| `profile.deviceId` | ✅ paired-device row |
| `profile.selectionRevision` | ✅ `device_profile_selection_revisions` table (verified `databaseProfilesRepository.ts:206-210`) |
| `profile.delivery` (base address + HMAC secret) | ✅ stable IP/port + persisted secret |

**Failure scenario:** desktop restarts → phone reconnects → sends its cached ETag → desktop returns **304** → the payload thunk never runs → registry stays empty → the phone plays from its cached catalog and every `resourceId` resolves against an empty map → `MEDIA_NOT_FOUND` / *"Unknown local resource. Refresh the paired library and try again."*

And it is **sticky**: pull-to-refresh re-sends the same ETag and gets another 304. Recovery requires something that bumps the ETag — a library scan, or a profile switch incrementing `selectionRevision`. The user-facing symptom is "my phone says the media is unavailable after I restarted the desktop, and refreshing doesn't help."

**Secondary defect — self-eviction within one pass.** `MAX_REGISTERED_RESOURCES = 100_000` with FIFO eviction on *first-insert* order (a JS `Map` does not reorder a key on overwrite, so re-registration never advances an entry). For a library exceeding 100k resources, a *single* projection pass evicts its own earlier entries before it finishes — the front of the catalog is gone by the time the payload is serialized.

**Fix:** warm the registry independently of the ETag — either register resources when the library is loaded rather than when a payload is serialized, or fold a per-process boot nonce into the `delivery` identity so the first request after a restart is always a miss. Separately, make eviction LRU (delete-then-set on hit).

---

## 🟠 MEDIUM-6 — HMAC secret fails open to an empty key, and is non-deterministic on first run

**Where:** `apps/desktop/src/main/settings.ts:201-206, 243`, plus 6 call sites

The pattern `loadSettings().localNetworkHmacSecret || ''` appears in `lanSecurity.ts:130`, `mediaServer.ts:565,1169,1396`, and `main.ts:389,420,949,1280`. `createHmac('sha256', '')` does **not** throw — it silently produces a signature under a publicly-known empty key. Every signed LAN URL and every resource ID would become forgeable, with no error anywhere.

In practice `normalizeSettings` backfills the field, so the fallback should be unreachable. But `loadSettings()` has a genuine first-run hole:

```ts
export function loadSettings(): AppSettings {
  const databaseSettings = loadSettingsFromDatabase();
  if (databaseSettings) { /* normalize, persist if epoch != 2, return */ }
  try { if (fs.existsSync(SETTINGS_FILE)) { /* migrate legacy, persist */ } } catch { ... }
  return normalizeSettings({});          // ← line 243: never persisted
}
```

`normalizeSettings({})` generates `randomBytes(32)` for the HMAC secret, a fresh `randomInt` share PIN, and a fresh `randomUUID` device ID — **and returns without saving**. On a genuinely fresh install, before anything calls `saveSettings`, two consecutive `loadSettings()` calls return *different* secrets, PINs and device IDs. Any resource ID minted in that window is unresolvable, and any signed URL is unverifiable.

**Fix:** persist immediately in the `normalizeSettings({})` branch, and replace `|| ''` with a throw — an empty signing key should be a loud failure, never a silent downgrade.

---

## 🟠 MEDIUM-7 — HLS session tokens survive Local Network Sharing being turned off

**Where:** `apps/desktop/src/main/mediaServer.ts:1779-1782`, `apps/desktop/src/main/transcodeManager.ts:548-562`

```ts
const hasSessionCredential = authorizeHlsStreamRequest(reqUrl);
if (!hasSessionCredential && !requireStreamAccess(reqUrl, req, res)) return;
```

`authorizeHlsStreamRequest` only checks that the `streamToken` matches a credential on a live, non-stopped session. It never consults `isLanSharingEnabled()`, the paired-device table, or the profile binding. So a phone that started playback keeps streaming after the owner flips Local Network Sharing off in Settings, until the session hits `SESSION_IDLE_TIMEOUT_MS` (5 minutes idle) — and while the client keeps requesting segments, it never goes idle.

The profile binding check immediately below *does* run and will 409 on a stale selection, so this is bounded, not open-ended. But "turn off sharing" not stopping in-flight streams contradicts the user-facing promise of that toggle.

**Fix:** have `stopLanSharing` (and the settings-save path) call `stopTranscode` for every session whose start scope begins with `lan:`.

---

## 🟡 LOW-8 — Unauthenticated LAN information disclosure (privacy hardening)

> **Downgraded from Medium after review.** This is privacy hardening on an already-trusted network segment, not a security boundary failure. Nothing here grants access to media or credentials.

**Where:** `apps/desktop/src/main/mediaServer.ts:687-735`, `lanRoutePolicy.ts:83-85`

`/`, `/pair`, `/api/ping` and `/api/lan/info` are `{ kind: 'public' }` — reachable on the TLS LAN listener with no credential at all. `/api/lan/info` returns:

```ts
{ deviceId, deviceName, sharingEnabled, networkName,
  port, transport, certFingerprint, addresses: getLocalNetworkAddresses() }
```

and the landing page renders `deviceName` and `networkName` in its footer.

Any device on the network — including a guest on the same Wi-Fi — can enumerate LoomTV hosts and harvest the hostname, a stable device UUID, the SSID/network name, and the full list of local interface addresses. The device UUID is the same value used as `localNetworkDeviceId`, making it a stable cross-session tracking identifier.

This is a *deliberate* trade-off (discovery needs a pre-auth handshake), and the certificate fingerprint genuinely must be published pre-pairing for pinning to work. But `addresses` (all interfaces) and `networkName` are not needed for discovery and are the most sensitive parts.

**Fix:** trim `/api/lan/info` to `{ ok, app, deviceId, sharingEnabled, port, transport, certFingerprint }`; drop `addresses` and `networkName` from the unauthenticated response.

---

## 🟠 MEDIUM-9 — Artwork routes verify identity binding but never check content restrictions

**Where:** `apps/desktop/src/main/mediaServer.ts:1037-1055, 1500-1605`

For artwork routes the gate is:

```ts
if (isArtworkRoute && !loopbackRequest && hasValidSignature
    && (!reqUrl.searchParams.get('deviceId') || !reqUrl.searchParams.get('profileId') || !profileIdentityForMedia())) {
  writeJson(res, 409, { error: 'stale_profile_selection' });
  return;
}
```

That confirms *who* is asking and that their profile selection is current. It never calls `assertProfileCanAccessPath` for the artwork's underlying media. Compare `/api/thumbnail` (line 1617) and `/stream` (line 1823), which both do call `requireProfileMediaAccess`.

`/api/custom-artwork` is the clearest case — it takes a raw `mediaId` and `target` straight from the query string:

```ts
const mediaId = reqUrl.searchParams.get('mediaId') || '';
const target  = reqUrl.searchParams.get('target') || '';
const artwork = mediaId && target ? getCustomArtworkData(mediaId, target) : null;
```

**Failure scenario:** a kid-profile device holds a signed artwork URL (or constructs a `mediaId` for a title outside its rating ceiling) and retrieves the poster/backdrop for restricted content. It cannot *play* the title — streaming is properly gated — but the parental-controls boundary leaks at the artwork layer, which is exactly where titles become visible and discoverable.

**Fix:** resolve `mediaId` to a file path and run `assertProfileCanAccessPath(identity.profileId, path)` in the artwork branch, the same way `/api/thumbnail` already does.

---

## 🟡 LOW-10 — Unvalidated query parameter passed to FFmpeg's `-ss`

**Where:** `apps/desktop/src/main/mediaServer.ts:1608, 1633`

```ts
const time = reqUrl.searchParams.get('t') || '00:01:00';
// ...
: ['-ss', time, '-i', filePath, '-vf', THUMBNAIL_SCALE_FILTER, ...]
```

`time` goes straight into the argv with no shape check. This is **not** a command injection — `spawn(ffmpegPath, args)` with an array and no `shell: true` cannot break out — and the adjacent `-i filePath` still constrains what gets read. The realistic outcomes are an ffmpeg parse error and a burned governor slot. Every other numeric parameter on this handler goes through `queryNumber()` or `parseIntegerTag()`; `t` is the outlier.

**Fix:** validate against `/^\d{1,2}:\d{2}:\d{2}(\.\d+)?$|^\d+(\.\d+)?$/` before use.

---

## 🟡 LOW-11 — `process.cwd()` is in the bundled-FFmpeg search path

**Where:** `apps/desktop/src/main/mediaBinaries.ts:62-68`

```ts
function bundledBinary(name: 'ffmpeg' | 'ffprobe'): string | null {
  const relative = path.join('ffmpeg', platformFolder(), binaryName(name));
  return firstExistingBinary([
    path.join(process.resourcesPath || '', relative),
    path.join(app.getAppPath(), 'resources', relative),
    path.join(process.cwd(), 'resources', relative),   // ← attacker-influenceable
  ]);
}
```

In a packaged app the first candidate exists, so the `cwd` entry is normally unreachable. It becomes live only if the bundled binary is missing or fails the `isCompatibleDarwinBinary` check — at which point launching LoomTV from a directory containing `./resources/ffmpeg/<platform>/ffmpeg` executes that binary. `systemBinaryCandidates` similarly includes `/usr/local/bin`, which is user-writable on default macOS installs.

Both are ordinary media-app trade-offs, but `process.cwd()` has no business being a search path in a packaged build.

**Fix:** gate the `process.cwd()` candidate behind `!app.isPackaged`.

---

## 🟡 LOW-12 — Non-constant-time session token comparison in the headless server

**Where:** `apps/server/src/admin-service.js:677, 712`

```js
const session = active.find((entry) => entry.tokenHash === hashToken(token));
```

`hashToken` is SHA-256, so a timing oracle here leaks information about a *hash*, not the token — practically unexploitable. It is flagged only because the same file uses `timingSafeEqual` correctly at lines 191 and 256; the inconsistency is the kind of thing that gets copied into a place where it does matter.

**Fix:** route through the same `timingSafeEqual` helper for consistency.

---

## 🟡 LOW-13 — Token hashes are shipped to the renderer

**Where:** `apps/desktop/src/main/ipcHandlerPolicy.ts:32`

```js
pairedDevices: settings.localNetworkPairedDevices || [],
```

`buildNetworkStatus` returns the full `LanPairedDevice[]`, including `accessTokenHash` and `refreshTokenHash`, over the `network:status` IPC channel to the renderer. The hashes are not usable as credentials (the server hashes what the client presents, so possessing the hash grants nothing), and `settingsForRenderer` is explicitly tested to strip these fields elsewhere — this one path bypasses that discipline.

**Fix:** project to `{ id, name, createdAt, lastSeenAt, lastAddress }`, matching the `LanPairedDevice` type the IPC layer already declares at `ipcHandlers.ts:37-43`.

---

# 🟡 Okay — Works, But Worth Attention

### 🟡 CSP is wider than it needs to be
`apps/desktop/src/main.ts:1185-1209`. `connect-src` includes bare `https:` and `img-src`/`media-src` include `https:` — the renderer can reach *any* HTTPS host. Metadata and artwork fetching already happen in the main process via `safeFetch`, so the renderer arguably needs neither. `frame-ancestors` and `form-action` are absent. `plexserver:` appears in three directives and looks like a leftover from an abandoned integration — nothing in the codebase references that scheme.

### 🟡 The highest-risk module has no direct tests
`createLanSecurity` (635 lines: PIN pairing, approval flow, refresh-token rotation, signed-URL HMAC, rate-limit integration) has **zero** direct test coverage. `securityBoundaryContracts.test.ts` is genuinely good work, but it tests `serverSecurity`, `resourceRegistry`, `mediaAccessIdentity`, `lanRoutePolicy`, `sessionBindingStore` and `rendererSettings` — it stops exactly at the pairing state machine. The `pendingPairingApprovals` lifecycle (expiry, `state` transitions, `result` memoization) and `isSignedLanRequestValid` deserve tests more than almost anything else in the repo.

### 🟡 `apps/mobile/App.tsx` is 6,766 lines
`AppRoot` alone spans lines 1100–3394 — a single ~2,300-line React component holding the connection state machine, catalog sync, profile handling, offline cache, artwork editing and navigation. `PlayerContent` is another ~920 lines. All 11 `react-hooks/exhaustive-deps` suppressions in the repo are in this file, which is the classic signature of effects whose real dependencies are inconvenient — i.e. latent stale-closure bugs. `apps/desktop/src/components/VideoPlayer.tsx` (3,147 lines) has the same shape on the desktop side. 33 files exceed 500 lines.

### 🟡 Route policy is declared twice
`lanRoutePolicy.ts` declares access classes for each path; `mediaServer.ts` independently re-matches the same paths in a ~1,000-line `if` chain. The two must agree, and nothing enforces that they do. Adding a route to one and forgetting the other fails open to `{ kind: 'desktop' }` (requires local-or-LAN auth, then falls through to 404) — safe today, but only by luck of the default.

### 🟡 Settings is one JSON blob
`databasePlaybackRepository.ts:79` — `INSERT OR REPLACE INTO app_settings (id, data_json, ...) VALUES (1, ?, ?)`. Every mutation rewrites the entire document (library folders, all skip-analysis config, all paired devices, all API keys). I checked for a read-modify-write race and **there isn't one** — every `loadSettings()`→`saveSettings()` pair runs synchronously after its `await`, so the event loop cannot interleave. The risk is prospective: the moment anyone inserts an `await` between the read and the write, concurrent LAN requests will start losing paired devices.

Related: `normalizeSettings` runs on every save and unconditionally overwrites `localNetworkSecurityEpoch: 2` and `appDarkTheme: 'black'`, and re-runs `path.resolve()` on `mpvExecutablePath` relative to the current working directory.

### 🟡 Credentials at rest
`openSubtitlesPassword` and all metadata provider API keys are stored in plaintext inside the settings blob (`settings.ts:161-166`). Standard for a local-first desktop app, and Electron's `EnableCookieEncryption` fuse doesn't cover this — worth a line in `SECURITY.md` so users know.

### 🟡 SecureStore used for non-secrets on mobile
`App.tsx:1284, 1289, 5456` put theme mode, theme color and subtitle font size into `expo-secure-store` (Keychain/Keystore). Keychain round-trips are slow relative to plain storage, and on iOS Keychain items outlive app uninstall by default. Credentials belong there; UI preferences don't.

### 🟡 Signed-URL verification is order- and encoding-sensitive
`isSignedLanRequestValid` reconstructs the signing input from `URLSearchParams.toString()` in *request* order. Any intermediary that reorders or re-encodes query parameters silently invalidates every signed URL. The mobile client routes through a native loopback TLS proxy (`LoomTvSecureTransport`) — if that proxy ever normalizes query strings, artwork and thumbnails break with no useful error. Sorting the parameters before signing and before verifying would remove the whole class of problem.

### 🟡 Build and release hygiene
- `osxSign: { identity: process.env.MACOS_SIGNING_IDENTITY || '-' }` silently degrades to ad-hoc signing (see HIGH-4).
- The build matrix runs `lint` + `typecheck` + `test` on all three OSes — three full runs of an OS-independent suite per build.
- No notarization verification step (acknowledged as deferred).

### 🟡 Working tree and repo cleanliness — *release-process concern, not a product defect*
Uncommitted paths on `main` spanning essentially every subsystem (`mediaServer.ts`, `lanSecurity.ts`, `App.tsx`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`). The count is a **moving target** — 66 at the start of this audit, 69 by the end — because a concurrent agent session is editing the repo live. The most recent commit is a release tag, so released 1.0.104 does not correspond to what is on disk; that matters for reproducing a reported bug against a version, and nothing more.

Separately, the repo root carries ~200 KB of generated audit HTML (`loomtv-audit.html`, `loomtv-headless-implementation-audit.html`, `loomtv-vs-jellyfin-feature-comparison.html`) plus committed `tsconfig.tsbuildinfo` / `tsconfig.node.tsbuildinfo` — build artifacts that belong in `.gitignore`.

### 🟡 `pnpm-workspace.yaml` has a placeholder value
```yaml
allowBuilds:
  ffmpeg-static: set this to true or false
```
Every other entry is a boolean. This one is the literal instruction string, left unanswered.

---

# 🟢 The Good — What This Codebase Does Right

This is a well-engineered project. The findings above are real, but they sit on top of a foundation that is stronger than most applications of this size.

### 🟢 Electron hardening is essentially textbook
`windowManager.ts:75-105` — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `setWindowOpenHandler` denying **all** popups, and `will-navigate` pinned to an exact expected URL. `forge.config.ts` sets the full defensive fuse set: `RunAsNode: false`, `EnableNodeOptionsEnvironmentVariable: false`, `EnableNodeCliInspectArguments: false`, `EnableEmbeddedAsarIntegrityValidation: true`, `OnlyLoadAppFromAsar: true`, `EnableCookieEncryption: true`. There is nothing left to turn on.

### 🟢 IPC is typed end-to-end and validates its sender
Every channel flows through a generic `handle<C extends IpcInvokeChannel>` wrapper bound to an `IpcContract` type map, and every call is checked:

```ts
isTrustedSender: (event) => {
  if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) return false;
  const senderUrl = new URL(event.senderFrame.url);
  const applicationUrl = new URL(window.webContents.getURL());
  if (applicationUrl.protocol === 'file:') {
    return senderUrl.protocol === 'file:' && senderUrl.pathname === applicationUrl.pathname;
  }
  return senderUrl.origin === applicationUrl.origin;
}
```

Frame-level origin validation, with a correct `file:` special case. Most Electron apps skip this entirely.

### 🟢 Zero type escapes across 73,000 lines
No `as any`. No `@ts-ignore`. No `@ts-expect-error`. Anywhere. In a codebase spanning Electron main/renderer, React Native, native Kotlin/Swift modules and a headless Node server, that is genuinely rare and it is the single strongest signal of discipline here.

### 🟢 No shell execution anywhere
Every subprocess (`ffmpeg`, `ffprobe`, `mpv`, `ditto`, `which`, `file`, `fpcalc`) uses `spawn`/`execFile`/`execFileSync` with array arguments. No `exec()`, no `shell: true`, no template-string command construction. The entire command-injection class is structurally absent. Likewise: no `innerHTML`, no `dangerouslySetInnerHTML`, no `eval`, no `new Function`.

### 🟢 Capability-based file access instead of path passing
`resourceRegistry.ts` is a genuinely good design. LAN clients never see or send filesystem paths — they hold opaque `HMAC(secret, kind\0path)` identifiers, and resolution enforces four independent constraints: kind allowlist (a media ID cannot be redeemed as a subtitle), optional scope binding (a subtitle ID is bound to its specific media file), `fs.realpathSync.native` containment inside a configured library root (defeating symlink escape), and a `statSync().isFile()` check. `securityBoundaryContracts.test.ts:104-119` tests all four, including traversal and cross-media reuse.

### 🟢 Authorization is genuinely layered
Not one check but five, composed: **listener identity** as the trust boundary (`listenerScope === 'loopback'`, explicitly documented as "not a request-controlled address" — this correctly defeats the classic "reach the LAN listener via 127.0.0.1" bypass), **route class** (`public` / `pairing` / `ipc-only` / `stream` / `artwork` / `scoped` / `desktop`), **OAuth-style scopes** per paired device, **profile binding** with parental-control path checks, and **selection revision** to defeat stale-profile races. `resolveMediaAccessIdentity` refuses to trust a client-supplied `deviceId`/`profileId` unless it matches the credential and the current active selection — and that is tested.

### 🟢 Cryptographic primitives are well chosen
*(Narrowed from "cryptography is correct throughout" — that was too absolute given the empty-key fallback in MEDIUM-6 and the revocation gap in MEDIUM-3. The **primitives and their parameters** are right; two things built on top of them are not.)*

`scrypt` (N=16384, r=8, p=1) for profile PINs and server passwords; `randomInt` for the pairing PIN (not `Math.random`); 32-byte `randomBytes` for access, refresh and pairing-approval tokens; 24-byte for HLS stream credentials; SHA-256 hashed at rest; `timingSafeEqual` behind a length-guarded `timingSafeStringEqual` helper. The failed-login path in `admin-service.js:814` even runs a dummy scrypt to equalize timing when the account doesn't exist — a detail most implementations miss.

### 🟢 TLS with certificate pinning on the LAN
The LAN listener is `https` with `minVersion: 'TLSv1.2'`, and the certificate fingerprint is published through mDNS advertisement and the pairing response. The mobile client (`mobileSecureTransport.ts`) validates it strictly: rejects non-`https:` origins, requires a well-formed 64-hex-char fingerprint, and verifies the native module returns a genuine loopback proxy endpoint before trusting it. `mobileHostIdentity.ts` returns `identity-mismatch` if a discovered host's device ID *or* fingerprint changes — a rediscovered host may only update its address, never its identity. That is the right model.

### 🟢 Rate limiting where it matters
`pairRateLimit.ts` bounds PIN attempts per address, with `recordPairFailure` on both wrong PINs and denied approvals. `MAX_PENDING_PAIRING_APPROVALS = 8` with a one-pending-per-address rule stops approval-prompt flooding. `consumeHlsStartBudget` bounds transcode restarts per device with a `Retry-After` header. The comment at `lanSecurity.ts:464-466` — *"Approval requests must never rotate the fallback PIN or reset failed-PIN limits"* — shows someone thought carefully about how the two pairing paths could be played against each other.

### 🟢 Resource management is deliberate
`ffmpegGovernor` caps concurrent ffmpeg processes with tool slots and playback leases; `ENCODER_IDLE_TIMEOUT_MS` (30 s) and `SESSION_IDLE_TIMEOUT_MS` (5 min) reap idle work; `pruneCachedSegments` bounds HLS disk usage to a sliding window; `readBoundedUtf8File` enforces byte caps *and* honors `AbortSignal` *and* preserves UTF-8 across chunk boundaries (tested with an emoji at a 3-byte chunk size); `readJsonBody` bounds both size and time; every spawned process gets `res.once('close', () => proc.kill('SIGKILL'))`.

### 🟢 CI and supply chain (the gate itself is right, even though it's currently failing)
Every GitHub Action is pinned to a full commit SHA, not a tag. `--frozen-lockfile` installs. A CycloneDX SBOM is generated and uploaded per build. `minimumReleaseAge: 1440` imposes a 24-hour quarantine on newly published package versions — an excellent defense against the npm account-takeover pattern. `blockExoticSubdeps` is set. `verify-packaged-runtime.cjs` validates what actually shipped.

### 🟢 Licensing and provenance are enforced by code, not by policy
`forge.config.ts` blocks packaging outright if a `runtime-provenance.json` manifest is missing or malformed, and `assertNoPackagedMpv` walks both the output tree *and* the contents of `app.asar` to prove no mpv binary was bundled — a GPL-compliance boundary enforced mechanically at build time rather than trusted to reviewers. That is unusually rigorous.

### 🟢 The comments explain *why*
Consistently, and at exactly the points where a future reader would otherwise make a mistake:

> *"Listener identity, not a request-controlled address, defines the trust boundary. Calls to the TLS listener remain LAN-scoped even if a local process reaches it through 127.0.0.1."*

> *"stdout owns the response lifecycle. Ending here can race its final buffered chunk and trigger ERR_STREAM_WRITE_AFTER_END."*

> *"Resolve immediately so protocol-shaped paths, missing files, non-regular files, and paths outside a configured root never become usable stream capabilities."*

Zero `TODO`, `FIXME`, `HACK` or `XXX` markers in the entire source tree.

### 🟢 Mobile credentials are stored correctly
`expo-secure-store` (iOS Keychain / Android Keystore) for the saved connection, and the app deletes the stored credential on every authorization failure path — I counted nine distinct `SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY)` call sites covering revocation, identity mismatch, refresh failure and explicit disconnect.

---

# 📋 Recommended Priority Order

Revised after review. The main sequencing changes: signed-URL work drops below the first-run identity bug (it is a narrower fix once reframed as revocation-awareness), and **LAN-security tests move ahead of the large-file refactor** — boundary tests should exist before anything reshapes pairing or playback code.

| # | Action | Severity | Effort |
|---|---|---|---|
| 1 | Restore the supply-chain/release gate — bump overrides, refresh the `brace-expansion` patch, triage reachability, add dated waivers | 🔴 High | S |
| 2 | Fix or hide mobile artwork editing (currently 410s in the user's face); owner-only capability, **not** `playback:write` | 🔴 High | S–M |
| 3 | Establish a production macOS signing + updater trust model — Team ID / designated-requirement match, enforced for release builds only | 🔴 High | M |
| 4 | Persist settings identity in the `normalizeSettings({})` branch; **fail closed** instead of `\|\| ''` on an empty HMAC secret | 🟠 Medium | S |
| 5 | Make signed URLs revocation-aware (check the signed `deviceId` is still paired) — **without** making them single-use | 🟠 Medium | S |
| 6 | Enforce parental restrictions on artwork routes; stop `lan:` transcode sessions when sharing is disabled | 🟠 Medium | S |
| 7 | Warm `resourceRegistry` independently of the ETag (boot nonce in `delivery`, or register on library load); make eviction LRU | 🟠 Medium | M |
| 8 | Write direct tests for `createLanSecurity` — pairing, approval lifecycle, refresh rotation, signed URLs | 🟡 Hygiene | M |
| 9 | Validate the `t` parameter on `/api/thumbnail`; gate the `cwd` FFmpeg path behind `!app.isPackaged` | 🟡 Low | S |
| 10 | Narrow CSP `connect-src`; drop the unused `plexserver:` scheme; add `frame-ancestors 'none'` | 🟡 Low | S |
| 11 | Trim `addresses` / `networkName` from unauthenticated `/api/lan/info` | 🟡 Low | S |
| 12 | Refactor `apps/mobile/App.tsx` and `VideoPlayer.tsx` — **only after #8**, extracting `AppRoot`'s connection state machine first | 🟡 Hygiene | L |
| 13 | Commit or revert the pending working-tree changes; `.gitignore` generated audit HTML and `*.tsbuildinfo` | 🟡 Process | S |

**On extending LoomTV with plugins:** the evidence here favours API/webhook integrations over in-process third-party code. The trust boundaries this audit found to be soft — signed-URL revocation, artwork-layer restriction enforcement, the empty-key fallback — are precisely the ones an in-process plugin host would multiply. An out-of-process integration surface reuses the scope model that already works (`catalog:read` / `media:stream` / `playback:write`) instead of creating a new, weaker one. Revisit after items 1–7.

---

## Closing assessment

The security architecture here is the work of someone who understands the threat model of a LAN-exposed media server: capability-based file access, listener-scoped trust boundaries, scoped device credentials, TLS with pinning, correct primitives, and mechanical enforcement of licensing constraints at build time. The zero-type-escape record across 73k lines and the complete absence of shell execution are not accidents.

The problems cluster in three places: **a red supply-chain gate that needs a version bump and reachability triage**, **a mobile feature shipped against endpoints the desktop deliberately closed**, and **an update path that verifies a hash but not a publisher**. None require redesign; all are contained fixes.

The one genuine structural debt is `apps/mobile/App.tsx`, where a 2,300-line component and eleven suppressed dependency arrays are steadily accumulating the kind of bug that is very hard to find by reading. Refactoring it should follow the LAN-security tests, not precede them.

---

## 🔍 Revision note

This document was revised after external review (Codex, static validation only, against commit `8e66d3b`). Changes made:

| Original | Revision | Why |
|---|---|---|
| HIGH-3 "no replay protection", fix = single-use nonce store | **Reclassified to MEDIUM-3**, reframed as revocation-awareness; single-use recommendation **retracted** | Expiring signed URLs are normally replayable bearer capabilities. Single-use would break HTTP range requests on `/stream`, the `immutable` artwork cache directive, HLS segments and retries. The revocation gap is the real defect. |
| HIGH-4 fix = `codesign --verify` + `spctl` | **Fix corrected** to Team ID / designated-requirement match; signing enforcement scoped to release builds | `codesign --verify` proves internal consistency, not publisher identity. Unconditional `osxSign` enforcement would break local packaging. |
| MEDIUM-5 "restart invalidates all resource IDs" | **Claim retracted and rewritten** | Verified false: IDs are deterministic HMACs and are re-registered during library projection, which every reconnect triggers. The surviving bug is narrower and worse — the ETag **304** path skips payload construction entirely, so the registry never warms and the failure is sticky until a library scan. |
| Mobile artwork fix behind `playback:write` | **Corrected to owner-only** | Artwork/metadata edits mutate the shared library, not per-profile state. |
| Supply chain: 6 advisories as product vulnerabilities | **Reachability caveat added** | `pnpm audit --prod` classifies by manifest position; Expo tooling is build-time. The release-gate breakage is certain; the product exposure is not. |
| "Cryptography is correct throughout" | **Narrowed** to "primitives are well chosen" | Too absolute given the empty-key fallback and revocation gap. |
| LAN info disclosure at Medium | **Downgraded to Low** | Privacy hardening on an already-trusted segment; grants no access. |
| Uncommitted paths in priority list | **Reclassified as process** | Not a product defect. Count is a moving target (66 → 69) due to a concurrent agent session. |

Two reviewer challenges were checked rather than accepted on assertion. The resource-registry challenge was **correct** and overturned my stated mechanism — but verifying it surfaced a more specific and higher-impact bug (the 304 path) that the original write-up had missed. The single-use-nonce retraction was verified against the actual range-request and cache-control behaviour in `mediaServer.ts` before accepting it.
