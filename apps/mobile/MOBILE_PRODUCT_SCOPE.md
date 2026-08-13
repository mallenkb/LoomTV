# LoomTV mobile product-scope decisions

Status recorded 2026-08-13. These decisions describe the current same-LAN companion release and must be revisited before any listed capability is advertised as supported.

| Capability | Current support | Required behavior |
| --- | --- | --- |
| Background playback | Not supported | Playback pauses when the app leaves the active state. The current resume position remains available when the user returns. |
| Lock-screen media controls | Not supported | No lock-screen controls or background media session are advertised. Playback pauses before the app backgrounds. |
| Picture-in-picture | Not supported | Playback remains in LoomTV's full-screen player and exits without starting a background video surface. |
| Localization | English only | User-facing copy is authored and reviewed in English. Additional locales require a localization system, translated resources, and device evidence before release. |
| Deep links | Not supported | LoomTV declares no custom URL scheme and accepts no inbound app route. A future implementation must use an allowlisted validating parser with automated hostile-input tests. |

## Scope-change rule

A capability moves to supported only after its implementation, user-facing behavior, automated contracts, and applicable iOS and Android device journeys are recorded in the release evidence. Removing an unsupported label without that evidence does not change the product contract.
