# Plugin executable sandbox threat model

Status: design artifact only. No executable plugin runtime is enabled by this
worktree.

The safe default is that a plugin is a declaration plus a host-mediated data
provider. If LoomTV later permits executable provider code, that code must be
treated as hostile even when the user explicitly approves the package. The
host must not turn approval into ambient filesystem, network, process, or
profile authority.

The machine-readable source of truth is
`security/plugin-sandbox-threat-model.json`. This document explains the
intended boundary and the evidence required before a future phase can change
the current `blocked` status.

## Assets and trust boundaries

Protected assets include library paths and media bytes, profile identity and
selection revisions, pairing credentials, artwork/cache data, provider
credentials, update keys, host availability, and the integrity of the LoomTV
process. The plugin package, plugin process, provider network, renderer, and
headless API are separate trust domains.

The only acceptable data path is:

```text
plugin process
    -> bounded host RPC with opaque references
    -> host policy/auth broker
    -> reviewed provider/cache/media operation
    -> bounded result
```

The plugin process must never receive a raw media/artwork/subtitle URL, host
filesystem path, profile secret, pairing token, update signing key, or an
arbitrary child-process capability.

## Threats and required controls

| Threat | Required control before enablement |
| --- | --- |
| Package tampering or publisher impersonation | Pinned publisher key, signed package index, artifact digest, sequence/rollback protection, and independent host verification. |
| Plugin escape or host compromise | Separate OS process or stronger isolation boundary, no renderer privileges, narrow RPC schema, input/output size limits, and a documented kill path. |
| Data exfiltration or SSRF | Default-deny egress broker, origin policy, DNS/rebinding controls, redirect denial unless explicitly reviewed, rate/byte budgets, and no plugin-controlled sockets. |
| Profile or pairing confusion | Host-owned profile binding, selection-revision checks, paired-device revalidation, revocation checks on every ticket/attachment, and no plugin-supplied identity. |
| Media/artwork path disclosure | Opaque references only; host resolves paths after containment and restriction checks. Never serialize paths to plugin or client. |
| Resource exhaustion | Per-plugin CPU/memory/process/request quotas, bounded queues, cancellation, timeouts, output caps, and cleanup after crash. |
| Persistence and update abuse | Versioned state validation, least-privilege storage, atomic rollback, signed updates, publisher continuity, and no arbitrary install scripts. |
| Confused deputy through the renderer or headless API | No direct plugin IPC from renderer; all calls pass through the host service and the same policy adapter in Desktop and Headless. |

## Non-negotiable blocked capabilities

Until the controls are evidenced, the runtime must reject:

- arbitrary plugin JavaScript or native modules in the LoomTV process;
- executable package entrypoints, shell commands, child-process spawning, and
  dynamic loading;
- raw URL/path fields in downstream contracts;
- plugin-controlled redirects, proxy destinations, or DNS resolution;
- direct access to profile, pairing, provider-key, or update-key material;
- install/update scripts and package hooks;
- network listeners, local sockets, and unrestricted environment variables.

The downstream validator enforces the data-level portion of this rule by
rejecting transport fields such as `url`, `path`, `command`, `executable`,
`argv`, and `entrypoint`. It is not a sandbox and must not be described as
one.

## Evidence gate for a future executable phase

A future change may move `executable.sandbox` from `blocked` only after review
has attached all of the following evidence:

1. package/publisher verification and key rotation/revocation behavior;
2. isolation design for macOS, Windows, Linux, and headless deployment;
3. a deny-by-default egress broker with redirect and DNS behavior documented;
4. profile/pairing/artwork authorization tests at the host boundary;
5. quotas, cancellation, crash recovery, and stale-capability revocation;
6. a storage/update rollback plan with no arbitrary install hooks;
7. red-team coverage for SSRF, path traversal, archive bombs, output flooding,
   protocol confusion, and host escape attempts;
8. a release decision that explicitly accepts any residual risk.

Until then, the only supported plugin implementation remains the existing
declaration-only, host-mediated JSON adapter.
