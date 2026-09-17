# Security Policy

Loom Media Server is a local-first desktop media library and player. It works with local files, local network workflows, metadata provider credentials, bundled media tooling, and desktop update flows. Security reports are taken seriously because a small desktop app still has access to sensitive local resources.

## Supported Versions

Security fixes target the latest public release and the current `main` branch.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| `main` | Yes |
| Older releases | Best effort |

## Reporting a Vulnerability

Please do not open a public GitHub issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting as the primary channel when available. Open this repository's Security tab and look for "Report a vulnerability". Availability has not been verified. If the button is missing, use a private contact method listed on the maintainer's GitHub profile. If none is listed, open a public issue asking only how to establish private contact, without vulnerability details, logs, or proof-of-concept material.

Include in the private report:

- A clear description of the issue
- Steps to reproduce
- Affected platform and Loom Media Server version or commit
- Any logs, screenshots, or proof-of-concept details that help verify the issue
- Whether the issue requires local access, LAN access, malicious media files, malicious metadata responses, or user interaction

If you are unsure whether something is security-sensitive, report it privately first.

## Areas of Interest

Useful security reports include, but are not limited to:

- Unsafe local file access or path traversal
- Local media server exposure beyond intended LAN or paired-device boundaries
- Weak pairing, rate limiting, or LAN discovery behavior
- Leaking or mishandling metadata provider API keys
- Unsafe IPC between Electron main, preload, and renderer code
- Update flow issues that could affect integrity or user trust
- Malicious media, subtitle, artwork, or metadata inputs causing code execution, data exposure, or persistent compromise
- Bundled FFmpeg/FFprobe handling that creates unnecessary risk

## Playback URL capabilities

Server-issued playback URLs can contain a `token` query parameter. Treat the full URL as a bearer credential: someone who obtains it may replay the permitted media requests while the capability remains valid. Binding a capability to an account, device, profile, and source limits its authority; it does not prove that the requester is the original device.

Use HTTPS outside isolated local development. Do not log full playback URLs in application, player, reverse-proxy, access, or analytics logs. Strip query strings before recording request paths and redact tokens from screenshots, diagnostics, and bug reports. Never put account or device credentials into playback URLs or share token-bearing playlists publicly.

The server sets `Referrer-Policy: no-referrer`. Preserve that header through reverse proxies and use the same policy in custom browser clients. This reduces referrer leakage, but does not prevent a proxy, player, browser history, or diagnostic tool from retaining a URL it receives.

Capabilities expire and renewal rotates their tokens, but expiry does not make a leaked URL harmless before its deadline. Use the server's returned expiry fields rather than hard-coded client TTLs. See [playback capability lifetimes](docs/hosted-api.md#capability-lifetimes-and-handling) for the implemented idle limits, absolute caps, and rotation overlap.

## macOS update trust

Automatic updates require a Developer ID-signed installation. The downloaded app must match the installed bundle identifier and signing team and pass Apple's Developer ID certificate requirement. Legacy ad-hoc installations cannot establish that publisher identity and must be upgraded manually using the updater menu's "Download Latest Release..." action. Install a Developer ID-signed release when available before using automatic updates.

## Setup session lifetime

Setup keeps bearer credentials in memory, not browser storage. Reloading setup requires signing in again. Completing setup in bearer mode also requires another sign-in at the destination page, including Server Control. HTTPS cookie-mode setup for the hosted app retains its session across navigation. This change does not remove the legacy Server Control page's own session-storage authentication.

## Non-Security Issues

Please use regular GitHub issues for:

- Playback compatibility bugs
- Metadata mismatch reports
- UI bugs
- Build failures
- Feature requests
- Platform packaging problems without a security impact

## Disclosure

The maintainer will try to acknowledge reports promptly, investigate the issue, and coordinate a fix before public disclosure. Timelines may vary based on severity, reproducibility, and release complexity across macOS, Windows, and Linux.
