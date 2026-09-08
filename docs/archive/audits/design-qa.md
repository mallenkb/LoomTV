# Mobile web responsive QA

## Reference

- Source reference: `/var/folders/pd/0s26rrp54jd95230zcfqg3lw0000gn/T/codex-clipboard-9744e573-1e4e-4130-911d-5d1c340ced18.png`
- Target: HBO Max-inspired mobile streaming layout for LoomTV's web renderer.

## Implementation

- Responsive shell and bottom navigation: `apps/desktop/src/components/Sidebar.tsx`, `apps/desktop/src/index.css`
- Hero responsive hooks: `apps/desktop/src/components/ModernHome.tsx`
- Horizontal media touch behavior: `apps/desktop/src/components/MediaRail.tsx`
- Breakpoints: phone refinements at `760px`, mobile/tablet shell at `1024px`.

## Browser evidence

- Phone, `390x844`: `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/responsive-current-build/phone-390x844.png`
- Tablet, `768x1024`: `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/responsive-current-build/tablet-768x1024.png`
- Landscape phone, `844x390`: `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/responsive-current-build/landscape-844x390.png`
- 200% equivalent, top and scrolled, `195x422` CSS pixels at `2x` device scale: `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/responsive-current-build/zoom-200-phone.png` and `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/responsive-current-build/zoom-200-phone-scrolled.png`
- Capture metrics: `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/responsive-current-build/capture-metrics.json`
- Browser target: `http://127.0.0.1:3847/app/`; `/app` document and asset requests were fulfilled from the production renderer output while `/api` requests were left unintercepted.

## Production bundle identity

- HTML: `index.html`, SHA-256 `301cb184673d0a6e18148337819b05843fcfd338832f83e244a38c4f6f3ed5a6`
- JavaScript: `index-CRQdtD_D.js`, SHA-256 `25ac7b5686e1bd40dbac4b2f95d0a9595f5c6ccb9dac536d11d8f3a3d9d70802`
- CSS: `index-CBgcGntf.css`, SHA-256 `bf31fcc229108d4d95468349b3d03872fa8baa6eda8be199ebfba55bd4bc5064`
- Every saved capture reported the same JavaScript and CSS asset names.

## Result

- The production renderer build passed visual review at `390x844`, `768x1024`, and `844x390`.
- The 200% equivalent capture passed at the top and at internal `scrollTop = 220`: metadata wraps, the synopsis, pager, Play action, and first rail remain reachable, and the fixed bottom navigation stays visible.
- Document and app-scroller widths matched their viewports in every capture. No horizontal document or app-shell overflow was measured.
- The category strip and media rails retain intentional horizontal scrolling.

final result: passed

---

# Desktop keyboard focus and setup-dialog QA

## Evidence

- Production renderer focus metrics: `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/medium-verification/desktop-renderer-focus-evidence.json`
- Setup keyboard metrics: `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/medium-verification/desktop-setup-keyboard-evidence.json`
- Setup dialog capture: `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/medium-verification/desktop-setup-dialog.png`
- Browser: Edge 152 headless on macOS.

## Result

- The production CSS bundle exposes a real `2px` focus outline on a button and the standalone dropdown search in both dark and light modes.
- Library and modern search inputs expose the same `2px` outline on their containing controls. Their inner input stays visually quiet without losing the keyboard indicator.
- The declared focus colors measure `4.07:1` to `8.33:1` across dark surfaces and `6.08:1` to `7.63:1` across light surfaces.
- The setup dialog opens with focus on the folder path. `Shift+Tab` wraps to Add folder, `Tab` wraps back to the path, and `Escape` closes the dialog and returns focus to its opener.
- Every sampled focus target reported `:focus-visible` and a solid `2px` outline from the production CSS or setup page.
- No project tests ran. Physical-keyboard, forced-colors, VoiceOver, NVDA, and other assistive-technology checks remain outside this evidence.

final result: passed for the keyboard acceptance criteria

---

# Live TV desktop QA

## References

- Discover-style header: `/var/folders/pd/0s26rrp54jd95230zcfqg3lw0000gn/T/codex-clipboard-e6d73bf3-f65d-4f44-b862-d1eddad05ebf.png`
- Paused channel identity: `/var/folders/pd/0s26rrp54jd95230zcfqg3lw0000gn/T/codex-clipboard-7fabc3fe-0e2b-407f-af27-9606b1d7d7b2.png`

## Implementation evidence

- Live TV page capture: `/var/folders/pd/0s26rrp54jd95230zcfqg3lw0000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-08-27 at 9.33.44 AM.jpeg`
- Paused Live TV capture: `/var/folders/pd/0s26rrp54jd95230zcfqg3lw0000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-08-27 at 9.34.38 AM.jpeg`
- Combined header comparison: `/tmp/loomtv-live-header-qa.jpg`
- Combined player comparison: `/tmp/loomtv-live-player-qa.jpg`

## Findings

- P0: none.
- P1: none.
- P2: none.
- The Live TV header follows the established Discover hierarchy: title and status at left, search at right, compact pill filters beneath.
- Category mode uses readable headings; semicolon-delimited provider tags are presented as individual labels.
- The paused player shows the real channel logo and name above a full live-edge timeline. `LIVE` uses a red status indicator and the timeline does not imply unsupported seeking.
- The supplied broadcast icon remains red in active and inactive sidebar states.

## Result

Passed at the desktop test viewport. Static type-check passed, automatic pagination loaded all remaining results in the selected category, and the paused Live TV state was inspected in the running isolated test app.

The Live TV filter now opens with Categories selected, matching the supplied reference. A–Z and Z–A remain available in the same menu.

final result: passed

---

# Shared browse headers and scroll-divider QA

## Source visual truth

- Discover header reference: `/var/folders/pd/0s26rrp54jd95230zcfqg3lw0000gn/T/codex-clipboard-be60af86-17e6-4766-9dc5-1695b2f5bfc6.png` (`2224 × 254` pixels).
- Archive.org and IPTV references were supplied in the same request and used to identify the inconsistent title, search, controls, and refresh placements.

## Implementation evidence

- Combined comparison: `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/header-consistency/header-comparison.png`.
- Archive.org: `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/header-consistency/archive-header.png`.
- IPTV: `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/header-consistency/iptv-header.png`.
- Discover implementation: `/Users/mallenkb/Documents/Code Projects/LoomTV/.codex-artifacts/header-consistency/discover-reference-implementation.png`.
- Test viewport: `1920 × 1080`, dark theme, desktop scale 1, page at top.

## Findings

- P0: none.
- P1: none.
- P2: none for header hierarchy, spacing, typography, search placement, or scroll-divider behavior.
- The browse pages use the Discover header hierarchy: title and metadata at left, inline search at right, and page-specific filters on the second row.
- The Archive.org and IPTV refresh controls were removed. Archive.org search now runs after a short typing debounce.
- Shared poster, landscape-card, and IPTV-card shimmer components use one animation and preserve each page's content geometry.
- The sticky bottom border and shadow are transparent at `scrollTop = 0` and become visible only after `scrollTop > 4`. Runtime computed-style checks confirmed both states.
- The initial runtime check exposed competing transparent and visible border classes. The header class was changed to emit only one state at a time, then rechecked at the top and after scrolling.
- TypeScript checks and `git diff --check` passed after the final fix.

## Result

The supplied Discover reference and the three rendered implementation headers match in hierarchy, alignment, density, and control treatment. The divider is absent before scrolling and appears only once content moves beneath the sticky header.

final result: passed
