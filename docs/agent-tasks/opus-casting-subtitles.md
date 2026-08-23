# Opus task: finish casting and external subtitle sidecars

Start only after the canonical clients and television client are accepted. Read
[the shared contract](./video-unification-shared.md),
[the remaining implementation contract](./opus-remaining-implementation.md),
[the Sol handoff](./sol-core-platform-handoff.md), and the current
[Opus ledger](./opus-handoff-ledger.md) completely.

## Outcome

Activate casting and external subtitle sidecars without adding an anonymous
media path, leaking a locator, or weakening profile and child restrictions.

## Step 1: activate cast sessions

Add a persistent or bounded server registry and activate create, update, renew,
and stop contracts. Bind each session to the account or invitation, profile,
device, selection revision, media, source, file identity, permission, expiry,
and revocation state. Recheck live authority on every control and capability
request. Audit remote actions without secrets or paths.

Completion criterion: revoking the account, invitation, device, profile access,
source, or session makes every cast capability unusable immediately.

## Step 2: add platform casting

Implement AirPlay and Chromecast handoff on supported clients. Add
administrator-enabled DLNA discovery and playback with short-lived authorized
capabilities. A platform without the required native mechanism returns a typed
unsupported state. It cannot fall back to a public media URL.

Completion criterion: focused tests prove each transport consumes only bounded
capabilities and cannot escape account, profile, root, or child policy.

## Step 3: index and deliver sidecars

Discover supported subtitle sidecars beside authorized media. Store them as
server-only source records with language, label, format, forced and default
flags, and local or downloaded origin. Bind them to the video, root, file
identity, and profile policy. Plan direct external delivery or bounded burn-in
according to client capability. Never expose a raw path.

Update desktop, mobile, browser, and television track pickers and preference
handling. A missing or incompatible sidecar returns a typed result and can fall
back only to another authorized track or a plan without subtitles.

Completion criterion: every indexed sidecar has one authorized delivery path or
one typed incompatibility. Scanner, planner, transcoder, public DTO, capability,
revocation, and client-selection tests cover the path.

## Step 4: prove the media features

Run focused server, contract, scanner, playback, security, and client checks,
plus type checks and `git diff --check`. Record real-device, receiver, FFmpeg,
browser, and network verification separately.

Completion criterion: the ledger accounts for every route, record, public
field, client action, and command result. End with `MEDIA_FEATURES_READY` only
when no known implementation blocker remains.
