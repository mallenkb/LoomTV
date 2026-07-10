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

Send a private report to the maintainer through GitHub contact options or another private channel available on the maintainer profile. Include:

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
