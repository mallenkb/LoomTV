# Opus task: finish the LoomTV video program

This is the implementation contract for the remaining LoomTV video work. Read
[the shared program contract](./video-unification-shared.md),
[the Sol handoff](./sol-core-platform-handoff.md), and
[the current Opus ledger](./opus-handoff-ledger.md) completely before editing.
Read every `AGENTS.md` or `CLAUDE.md` that governs a file before changing it.
Treat the repository as the source of truth when a ledger claim and current
code differ.

## Outcome

Finish every open implementation item in the video-only program. The result
must migrate existing installations without silent loss and give desktop,
mobile, browser, Android TV, and Fire TV clients the same canonical `/api/v1`
video journeys. It must also finish casting, external subtitle sidecars, release
policy fixes, and the supporting documentation.

For this task, Opus owns every file required to finish these items, including a
targeted server or contract change. Preserve the canonical one-server,
one-database design. Record each cross-boundary contract change in the handoff
ledger.

Preserve the user's existing `apps/mobile/app.json` changes. Make a change there
only when the TV or mobile implementation cannot work without it, and record the
exact reviewed delta. Do not change `design-qa.md`,
`design-qa-mobile-phone.png`, or `design-qa-mobile-tablet.png`.

The user's latest instruction authorizes focused tests and verification
commands. Implementation comes first. The primary agent will run an independent
verification pass after handoff, so report evidence rather than declaring the
product complete.

## Step 1: establish the live contract

Inspect the canonical route table, public types, server projections, legacy
adapters, client calls, workspace packages, release workflows, and both handoff
ledgers. Replace stale ledger statements with current facts. Build a private
working inventory that accounts for every open route, client journey, migration
carrier, release selector, casting path, and subtitle path.

Completion criterion: every remaining item maps to an existing implementation,
a file to change, or a named new file. No dependent edit starts from an assumed
route shape.

## Step 2: repair and integrate migration

Replace the rejected `packages/video-migration` draft with a complete bridge to
the canonical desktop projection and importer. Cover the authoritative desktop
database together with WAL and SHM state, library roots, all catalog and series
state, metadata and artwork overrides, accounts, profile kinds and PINs,
assignments and restrictions, progress and history, lists, track preferences,
devices, settings, identity aliases, and evidence.

Malformed input must stop with a typed reconciliation error. Empty desktop
folder grants map to unrestricted canonical roots. A subfolder grant that
cannot be represented must stop or remain explicitly unresolved. It must never
widen to a root grant. Identity matching uses content hash, filesystem identity,
then quick hash. Ambiguity preserves records and appears in the redacted report.

Dry run, verified backup, transform, canonical import, independent readback,
operator report, idempotent rerun, and rollback must use the same state model.
The public package API must not expose migration plans, credential material,
raw locators, or internal records. Rollback restores each artifact to its real
source destination and never starts a legacy fallback server after canonical
commit.

After the bridge passes its focused checks, wire desktop startup to the
canonical host. Start one listener and one store. Start the window only after a
committed or newly completed migration. All failure and shutdown paths stop the
partial host. Remove the legacy host as a live authority while retaining the
bounded compatibility adapter.

Completion criterion: every legacy record has a deterministic mapping,
retention rule, or explicit incompatibility. A successful rerun makes no new
records. Every failure boundary preserves or restores the source installation.
Desktop startup cannot run canonical and legacy authorities together.

## Step 3: move desktop and mobile to the canonical API

Move core desktop and mobile journeys to canonical discovery, TLS identity,
authentication, pairing, profiles, library, details, progress, playback plans,
tracks, downloads, devices, invitations, and revocation. Remove direct client
use of legacy state and legacy route implementations. Keep compatibility routes
only for the current prior client generation.

Update onboarding for local desktop hosting, standalone NAS or server setup,
and connection to an existing server. Handle local, remote, invitation, revoked,
offline, incompatible-version, and expired-capability states. Keep tokens and
raw paths out of renderer storage, URLs, logs, and public payloads.

Completion criterion: both clients can complete onboarding, sign-in or pairing,
profile selection, browsing, movie and episode playback, progress, track
selection, downloads, device management, invitation use, recovery, and sign-out
against either desktop-hosted or standalone LoomTV. Core client code contains no
unaccounted `/api/v2` call or direct legacy-state dependency.

## Step 4: complete the browser client

Turn the hosted viewer into the canonical browser client. Implement onboarding,
HTTPS cookie sign-in with CSRF, profile selection and lock state, Home, search,
movies, series, seasons and episodes, details, lists, direct or HLS playback,
audio and subtitle selection, progress, invitation sessions, recovery from
server or source loss, and sign-out.

Use capability URLs only. Never assume media detail returns a direct URL. Keep
cleartext fallback credentials in memory for the current tab only. Implement
loading, empty, permission, unavailable-source, incompatible-client, expired
session, and retry states. Add keyboard operation, visible focus, screen-reader
names and status announcements, scalable text, contrast, and reduced motion.

Completion criterion: every required journey has a reachable success and error
path in the implementation. A keyboard user can operate every control and
playback action without a pointer. No bearer token is stored in local storage,
session storage, IndexedDB, a URL, or a service-worker cache.

## Step 5: build Android TV and Fire TV clients

Add a maintained workspace client for Android TV and Fire TV. Choose its package
layout after inspecting the existing Expo SDK 54 mobile code and current native
constraints. Record the choice in the ledger. The client must advertise honest
playback capabilities and use only canonical public contracts.

Implement server discovery and manual connection, certificate trust, pairing or
sign-in, profiles and PIN state, Home, search, movie and series details, seasons
and episodes, lists, direct or HLS playback, progress, audio and subtitle tracks,
invitation use, device revocation, server loss, and sign-out. Support D-pad focus,
Back, Select, Play or Pause, seek, long text, overscan-safe layout, focus return,
screen-reader semantics, reduced motion, and ten-foot sizing. Touch must not be
required. Android TV and Fire TV packaging metadata must expose only the
permissions and launch categories the client uses.

Completion criterion: every core journey is operable using a television remote.
Focus cannot disappear or become trapped in a core journey. The package has
workspace scripts, type checks, focused tests, release metadata, and a device
verification checklist. Platform execution remains a separate evidence label
until an emulator or device runs it.

## Step 6: finish casting and external subtitle sidecars

Activate authenticated cast-session contracts. Implement AirPlay and Chromecast
handoff where the client platform supports them. Implement administrator-enabled
DLNA discovery and playback without opening an anonymous media route. Bind every
cast session to the account or invitation, active profile, device, media source,
file identity, permission, expiry, and revocation state. Stop or renewal must
recheck live authority. Record a typed unsupported result on a platform that
cannot provide a required native mechanism.

Index supported external subtitle sidecars as authorized media-source records.
Preserve language, label, format, forced and default flags, and local versus
downloaded origin. Resolve them under the same root and profile policy as the
video. Playback planning must select direct external delivery or a bounded
burn-in path based on client capability. Capability URLs must not reveal a file
path. Desktop, mobile, browser, and television track pickers must present and
persist valid sidecar choices.

Completion criterion: casting cannot bypass authentication, profile restrictions,
source authorization, or revocation. Every discovered sidecar has one authorized
delivery path or one typed incompatibility. No public payload contains a raw
subtitle path.

## Step 7: fix release policy and product truth

Fix every `.github/workflows/mobile-release-gate.yml` selector to use the package
name in the current manifest. Extend the workflow-policy verifier and its focused
tests so every workspace filter in every workflow must resolve to a current
package. Account for desktop, server, mobile, and TV build, signing, packaging,
release-note, version, and artifact rules.

Rewrite stale browser, mobile, NAS, backup, casting, subtitle, TV, migration, and
feature-status documentation to match shipped code. Remove unsupported
percentages and completion claims. Separate implemented behavior from runtime,
device, signing, and platform evidence.

Completion criterion: every documented command and workflow selector resolves
against the repository. Every capability claim names its evidence state. No
planned item reads as shipped and no implemented item remains described as a
desktop-only relay.

## Step 8: prepare the independent handoff

Run focused checks for each changed tranche while implementing. Add or update
tests where a regression could silently lose data, bypass authority, break a
client contract, or let a workflow select no package. Do not erase or rewrite a
failing check to hide a product defect.

Update `docs/agent-tasks/opus-handoff-ledger.md` as the single completion record.
List changed paths, contract changes, migration mappings, client journeys,
security decisions, compatibility behavior, release corrections, and every
command run with its result. Mark unavailable hardware, signing identities,
NAS hosts, GPUs, browsers, and TV devices as required evidence with the exact
setup needed. Never substitute a mock for a device claim.

Completion criterion: the ledger accounts for every changed file and every
requirement in Steps 1 through 7. The final Claude response ends with
`READY_FOR_INDEPENDENT_VERIFICATION` only when no known implementation blocker
remains. Otherwise it ends with `BLOCKED` and the smallest concrete blocker.
