# Contributing to Loom Media Server

Loom Media Server is a local-first desktop media library and player for movies, TV shows, and anime that users already own or are authorized to use. Contributions should keep that boundary clear: the project does not provide, host, download, or sell media.

## Ways to Contribute

- Fix bugs in library scanning, metadata matching, playback, artwork, settings, or packaging.
- Improve tests around media classification, playback planning, local server security, updater behavior, and renderer utilities.
- Improve documentation for installation, release workflows, platform quirks, and provider setup.
- Help with cross-platform packaging issues on macOS, Windows, and Linux.
- Propose small UX improvements that keep Loom Media Server focused on local media management.

## Development Setup

Requirements:

- Node.js
- pnpm via Corepack
- A desktop environment supported by Electron

Install dependencies from the repository root:

```sh
corepack enable
corepack pnpm install
```

Run the desktop app:

```sh
corepack pnpm desktop:start
```

Run checks before opening a pull request:

```sh
corepack pnpm typecheck
corepack pnpm test
```

Desktop-specific commands are also available:

```sh
corepack pnpm desktop:typecheck
corepack pnpm desktop:test
corepack pnpm --filter loom-media-server-desktop dist
```

## Project Structure

```text
apps/
  desktop/   Electron main process, renderer UI, local database, playback, probing, and packaging.
  mobile/    Expo mobile client for pairing and playback experiments.
convex/      Backend functions for host registry, pairing, media sync, and playback state.
docs/        Screenshots, release notes, future work, and implementation notes.
```

## Pull Request Guidelines

- Keep changes focused. Avoid broad refactors mixed with behavior changes.
- Include tests when changing shared helpers, scan logic, security checks, playback planning, updater behavior, or metadata matching.
- Update README or docs when changing setup, packaging, release behavior, privacy/security posture, or user-visible workflows.
- Do not commit media libraries, copyrighted content, private API keys, generated installers, local databases, or personal configuration.
- For UI changes, include screenshots or a short description of what changed.
- For release or packaging changes, explain which platforms were tested.

## Security and Privacy Boundaries

Loom Media Server handles local files, metadata provider API keys, local network access, updater flows, and bundled media tooling. Treat changes in these areas as higher risk.

Use extra care when touching:

- Local file access and folder scanning
- LAN discovery, pairing, and local media server code
- API key storage and metadata provider calls
- Update download, install, and restart flows
- FFmpeg, FFprobe, HLS, transcode, and direct stream behavior
- Electron main/preload IPC boundaries

Report vulnerabilities privately using the process in `SECURITY.md`.

## Code Style

- Prefer TypeScript types that document the shape of data crossing process or package boundaries.
- Keep Electron main-process code, preload APIs, and renderer UI responsibilities separate.
- Prefer small helper functions with focused tests for parsing, classification, planning, and security decisions.
- Keep user-facing copy direct and specific.

## License

By contributing, you agree that your contribution is licensed under the MIT License used by this repository.
