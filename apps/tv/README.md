# LoomTV for Android TV and Fire TV

This Expo client connects directly to the canonical LoomTV `/api/v1` server. It supports mDNS discovery, manual HTTPS setup, certificate pinning, device pairing, invitation sessions, profiles and PINs, movie and series browsing, progress, My List, direct/HLS playback, track selection, and credential revocation on sign-out.

Run the source checks:

```sh
pnpm tv:typecheck
pnpm tv:test
pnpm --filter @loom-media-server/tv verify:config
```

Start a development client with `pnpm tv:start`, or generate and run Android with `pnpm tv:android`. Release candidates must complete [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md), including Android TV and Fire TV hardware checks. Source checks do not replace physical remote, decoder, network, and store validation.
