# LoomTV TV release checklist

Complete this checklist for every Android TV or Fire TV release candidate.

## Automated gate

- [ ] `pnpm tv:typecheck`
- [ ] `pnpm tv:test`
- [ ] `pnpm --filter @loom-media-server/tv verify:config`
- [ ] Expo prebuild completes from a clean checkout.
- [ ] Android `assembleRelease` completes in the TV release gate.

## Physical devices

- [ ] Install and launch on a current Android TV device.
- [ ] Install and launch on a current Fire TV device.
- [ ] Confirm the app appears in the TV launcher and requires no touch input.
- [ ] Confirm D-pad traversal, focus visibility, Back behavior, text entry, and screen-reader labels.
- [ ] Discover a desktop-hosted server and a NAS-hosted server over mDNS.
- [ ] Connect by manual HTTPS address when discovery is unavailable.
- [ ] Reject a changed or unconfirmed server certificate.
- [ ] Pair, sign in, accept an invitation, select a PIN profile, switch profile, and sign out.
- [ ] Browse movies and series, choose an episode, resume progress, and update My List.
- [ ] Play direct and HLS media, seek, pause, resume, renew a long session, and change audio/subtitle tracks.
- [ ] Revoke the TV device on the server and confirm the client loses access.

## Network and failure cases

- [ ] Repeat startup with the server offline, its address changed, and its certificate changed.
- [ ] Repeat playback while Wi-Fi drops and returns.
- [ ] Confirm cleartext HTTP is rejected and credentials never appear in logs or URLs.
- [ ] Confirm a self-signed certificate is accepted only through the saved SHA-256 pin.

## Release ownership

- [ ] Package name `app.loomtv.tv`, signing key, Play Console record, and Amazon Appstore record are owned by the project account.
- [ ] Version and Android version code are incremented.
- [ ] Store listing, privacy disclosure, screenshots, TV banner, and release notes match the shipped build.
- [ ] Rollback artifact and prior signed build remain available.
