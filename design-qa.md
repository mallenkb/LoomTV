**Design QA**

- Source visual truth: `/var/folders/pd/0s26rrp54jd95230zcfqg3lw0000gn/T/codex-clipboard-86401015-47a1-423a-bd79-72c208953578.png` (original LoomTV poster rails and rating badges), `/var/folders/pd/0s26rrp54jd95230zcfqg3lw0000gn/T/codex-clipboard-320e2805-25ad-4b42-9192-04ee506d267f.png` (Modern Home composition), `/var/folders/pd/0s26rrp54jd95230zcfqg3lw0000gn/T/codex-clipboard-8e8538a2-d82d-407c-9a14-5326e434eb31.png` (annotated missing right-edge blend), the current `2847 x 1354` Home max-width annotation, the current macOS Electron Back-control appshot, and the current conversation-attached browser annotation selecting the outlined watched-state icon at `1463 x 1141`.
- Implementation screenshots: `.codex-design-qa/implementation-home-continue-covers.png`, `.codex-design-qa/implementation-home-posters.png`, `.codex-design-qa/implementation-home-hero-maxwidth.png`, `.codex-design-qa/implementation-hero-carousel-1703.png`, `.codex-design-qa/implementation-home-catalog-rows-1703.jpg`, `.codex-design-qa/implementation-home-complete-catalog-rows.jpg`, `.codex-design-qa/implementation-detail-aligned.png`, `.codex-design-qa/implementation-detail-back-aligned-1463.jpg`, `.codex-design-qa/implementation-detail-themed-resume.png`, `.codex-design-qa/implementation-detail-solid-watched-icon-1463.jpg`, and `.codex-design-qa/implementation-right-vignette.jpg`.
- Combined comparison evidence: `.codex-design-qa/home-comparison.png`, `.codex-design-qa/hero-carousel-comparison.jpg`, `.codex-design-qa/home-catalog-rows-comparison.jpg`, `.codex-design-qa/detail-comparison.png`, and `.codex-design-qa/right-vignette-comparison.jpg`.
- Viewport: Home `1463 x 1141` CSS px, carousel controls at `1280 x 720` and `1703 x 1141`, plus the right-vignette verification at `1280 x 720`; detail checked at `1280 x 720` and `1463 x 1141`; device scale factor 1.
- Source pixels: original LoomTV Home `1392 x 912`; Modern composition `5760 x 3240`.
- Implementation pixels: Home `1463 x 1141`; right-vignette capture `1280 x 720`; clean detail capture `1280 x 720`, with alignment confirmed again at `1463 x 1141` in the annotated browser state.
- Density normalization: poster proportion, badge placement, and text hierarchy were compared as focused component regions; the different full-view crops were treated as viewport context rather than pixel-identical frames.
- State: Modern style, populated local library, Home hero at the top of the page, detail hero at the top of an anime content page.

**Full-view comparison evidence**

- The implementation follows the source composition: edge-to-edge cinematic artwork, transparent left icon rail, centered fully rounded category switcher, right-corner search control, left-aligned hero information, and the original portrait poster rails.
- App-specific artwork, title copy, library categories, and the persistent continue-watching bar intentionally use LoomTV's live library data and existing playback behavior.

**Focused-region comparison evidence**

- The detail comparison specifically checks the lower hero edge. The revised implementation now darkens progressively through the final third of the artwork and reaches the black content canvas without a visible hard seam.
- The detail hero now mirrors Home's title-first composition: label, oversized uppercase title, metadata, clamped summary, and adjacent pill actions without a competing poster column.
- The category control is 48px high with 4px internal padding and 20px tab padding, matching the latest annotated requirement.
- The Home hero reserves at least 608px and reduces the rail overlap to 96px so the first row cannot collide with hero actions in shorter desktop windows.
- Large Settings choice and action cards use a 24px radius; only compact controls retain the pill radius.
- The profile switcher sits at the bottom of the Modern rail, and its menu retains access to Settings.
- Modern detail utility controls share the Back button's 40px glass-pill treatment.
- Loader style choices use a consistent 16px radius.
- Home rail items reuse the original `MediaPosterCard`, including 2:3 poster artwork, top-right star ratings, titles, and year/season metadata.
- Modern detail hero text, Resume/My List actions, Summary, and episode content now share the same 32px content inset inside the centered 1440px frame.
- Continue Watching alone uses 16:9 cover artwork, a visible accent progress track, rating badges, and an eight-item cap; Trending and Recently Added remain portrait posters.
- The primary Play/Resume action uses the active theme accent and its matching foreground tokens.
- Modern search keeps its floating glass shell but removes the input-level focus ring and border, including when a query is active.
- Detail-page Back and artwork actions use the same centered-frame horizontal inset as the hero content, preventing the top controls from floating inward or outward.
- The Modern Home hero artwork and its overlays now share a centered frame capped at 1440px; the surrounding cinema-black canvas remains viewport-wide.
- The Home hero's right vignette now begins subtly at 64%, increases across nine opacity stops, and reaches solid black at 100%, removing the visible artwork-to-canvas seam.
- The Home hero is now a six-title carousel with synchronized artwork/copy crossfades, automatic eight-second rotation, hover pause, previous/next controls, and direct position dots placed above Continue Watching.
- Home catalog rows now have one clear content type each: Anime, TV Shows, then Movies. Continue Watching remains the personalized cover-art row above them.
- In a windowed macOS build, the detail Back control reserves an 80px leading safe area for the traffic lights, while wider windows continue to align it with the centered hero frame.
- The detail Back control now starts exactly at the hero content frame's left edge and never enters the 80px navigation rail; browser geometry at `1463 x 1141` measured Back `80px`, content `80px`, and sidebar right edge `80px`.
- Completed episode rows now use a filled green watched icon with a dark check cutout; the status remains in the existing 16px slot and does not shift the rating or episode copy.

**Findings**

- No actionable P0, P1, or P2 differences remain.
- Fonts and typography: system typography differs from the streaming reference's proprietary typeface but preserves its hierarchy, weight, contrast, and readable line lengths.
- Spacing and layout rhythm: main content is centered in a responsive frame capped at 1440px, while Settings uses a focused 800px maximum; the sidebar, center switcher, and search remain viewport-pinned.
- Colors and tokens: Modern consistently uses the cinema-black canvas, translucent control surfaces, white active pills, and restrained borders across Home, browse, details, player, and Settings.
- Image quality: LoomTV uses the library's real poster and backdrop candidates with cover crops; no placeholder artwork was introduced.
- Copy and content: labels are adapted to LoomTV's Anime, TV Shows, and Movies information architecture.

**Comparison history**

- P2: Modern styling initially stopped at Home. Fixed by carrying the transparent icon rail, rounded controls, black canvas, glass panels, and media-surface treatment across browse, details, player, and Settings. Post-fix evidence: both implementation captures.
- P2: the main frame, category switcher, and continue-watching bar were offset to compensate for the sidebar. Fixed by centering a `calc(100% - 10rem)` frame capped at 1440px and independently pinning sidebar/search. Post-fix evidence: `home-comparison.png`.
- P2: the detail backdrop ended on a visibly hard boundary. Fixed with a stronger, correctly stacked bottom fade and raised hero content layer. Post-fix evidence: `detail-comparison.png`.
- P2: large Settings buttons inherited the compact pill radius. Fixed by restoring a 24px radius for text-left choice cards and action tiles.
- P2: Modern Home rails used 16:9 cover cards and omitted visible ratings. Fixed by reusing LoomTV's original portrait poster component for rails and search results; post-fix evidence: `implementation-home-posters.png`.
- P2: detail hero information used a 56px internal inset while the detail body used 32px. Fixed by using the same 32px inset for hero information, actions, Summary, and episodes; post-fix evidence: `implementation-detail-aligned.png` and the annotated 1463px browser view.
- P2: Continue Watching inherited the portrait treatment intended for catalog rows. Fixed by restoring 16:9 cover cards only for Continue Watching, adding per-item progress bars, and limiting the rail to eight items; post-fix evidence: `implementation-home-continue-covers.png`.
- P2: Modern card hover moved/clipped the whole card. Fixed by keeping poster and cover frames fixed, scaling only artwork inside the frame, and restoring the centered play affordance for Continue Watching.
- P2: the Modern detail Resume action used a fixed white surface instead of the selected theme. Fixed with the existing accent, accent-hover, and accent-foreground tokens; post-fix evidence: `implementation-detail-themed-resume.png`.
- P2: the Modern Home backdrop expanded across ultra-wide windows instead of respecting the 1440px visual frame. Fixed by centering a dedicated artwork-and-overlay wrapper capped at 1440px; post-fix evidence: `implementation-home-hero-maxwidth.png` and computed `max-width: 1440px` with no horizontal overflow.
- P2: the windowed macOS Back pill overlapped the native traffic lights. Fixed with a macOS-only 80px minimum leading inset that yields to the centered-frame inset on wide windows.
- P2: lowering the right-edge vignette's final opacity exposed the edge of the 1440px artwork frame against the black page. Fixed by restoring a full-black 100% stop and distributing the transition across nine intermediate stops. Post-fix evidence: `implementation-right-vignette.jpg` and `right-vignette-comparison.jpg`; computed browser evidence confirms the overlay ends at `rgb(0, 0, 0) 100%`.
- P2: the Modern Home hero was a static featured title with no browsing affordance. Fixed by rotating through up to six featured library titles, adding crossfades, accessible arrows/dots, and pausing automatic rotation while the hero is hovered. Post-fix evidence: `implementation-hero-carousel-1703.png`; browser interaction changed the hero through both Next and direct-dot controls, and the title changed again after the eight-second interval.
- P2: Home repeated Anime across the mixed Trending and Recently Added rows, leaving no dedicated TV or Movies grouping. Fixed by replacing those rows with Anime, TV Shows, and Movies in that order. Post-fix evidence: `implementation-home-catalog-rows-1703.jpg`, `implementation-home-complete-catalog-rows.jpg`, and browser-rendered headings `Continue Watching`, `Anime`, `TV Shows`, `Movies` with no console errors.
- P2: the browser detail Back pill used a viewport-edge override and overlapped the Modern sidebar/search column. Fixed by aligning its left edge to the centered 1440px detail frame with an 80px minimum rail clearance at desktop and tablet widths. Post-fix evidence: `implementation-detail-back-aligned-1463.jpg`; computed browser geometry confirms Back and content both start at `80px`, exactly at the sidebar's right edge, with no console errors.
- P2: completed episodes used an outlined circle-check that read too similarly to an available action. Fixed by filling the existing library icon with the watched-state green and using a dark check stroke for clear solid-state contrast. Post-fix evidence: `implementation-detail-solid-watched-icon-1463.jpg`; browser-computed evidence confirms a 16px icon with a green fill and no console errors.

**Implementation Checklist**

- [x] Modern style persists per profile.
- [x] Modern visual language applies app-wide.
- [x] Main content is centered and capped at 1440px.
- [x] Detail hero blends into the page background.
- [x] Category control is 48px high with 4px shell padding and 20px tab padding.
- [x] Large cards use a 24px radius.
- [x] Appearance choices use a 16px radius and Settings content is capped at 800px.
- [x] Search dismisses on outside click or Escape without forcing input focus.
- [x] Detail utility buttons match the themed Back control.
- [x] Detail hero matches the Home hero hierarchy and pill-action treatment.
- [x] Home hero has a fixed desktop minimum height to protect the first rail.
- [x] Loader choices use a 16px radius.
- [x] Modern Home rails use portrait posters with rating badges and metadata.
- [x] Detail hero information, buttons, Summary, and episodes share one left alignment.
- [x] Continue Watching uses cover cards with progress and an eight-item limit.
- [x] Modern hover scales artwork without moving the card and exposes a centered play affordance.
- [x] Detail Play/Resume follows the selected theme color.
- [x] Modern search input has no visible focus ring.
- [x] Detail top controls share the hero content's left/right inset.
- [x] Modern Home hero artwork is centered and capped at 1440px.
- [x] Windowed macOS detail Back control clears the traffic lights.
- [x] Modern Home artwork feathers fully into the black canvas on the right.
- [x] Modern Home hero rotates through up to six featured titles.
- [x] Carousel arrows and direct position dots change the active title.
- [x] Carousel automatically advances every eight seconds and pauses while hovered.
- [x] Home catalog rows are ordered Anime, TV Shows, and Movies without repeating the Anime rail.
- [x] Detail Back aligns with the hero frame and clears the Modern sidebar at desktop and tablet widths.
- [x] Completed episode rows use a solid watched-status icon.
- [x] Desktop TypeScript checks pass.
- [x] Browser-rendered Home, browse, Settings, and detail states were inspected.

**Follow-up Polish**

- P3: a future pass could add scroll-position-aware contrast to the fixed category control on unusually bright backdrops.

final result: passed

---

## Mobile server-unavailable state — 2026-08-01

- Source visual truth: `/var/folders/pd/0s26rrp54jd95230zcfqg3lw0000gn/T/codex-clipboard-a54b4495-4307-4fcb-8134-5408896f1692.png` (`1182 x 2258`, framed iPhone screenshot showing the previous offline banner over stale library content).
- Implementation screenshot: `.codex-design-qa/mobile-server-unavailable-ios.png` (`1206 x 2622`, iPhone 17 Simulator content at native 3x density; approximately `402 x 874` CSS points).
- Combined comparison evidence: `.codex-design-qa/mobile-server-unavailable-comparison.png` (`1180 x 1200`; both captures scaled proportionally to the same 1200px comparison height).
- Android runtime evidence: `.codex-design-qa/mobile-android-pairing-runtime.png` (`945 x 2048`, physical Samsung SM-S906B after the development client loaded successfully).
- State: paired server unavailable, saved catalog present, dark theme.
- Density normalization: the source includes simulator canvas and device framing while the implementation is a content-only simulator capture, so the comparison normalizes height and evaluates composition rather than pixel alignment.

**Full-view comparison evidence**

- The unavailable state now owns the screen. Stale artwork, filter/search controls, and bottom navigation no longer imply that playback or live library actions remain available.
- The LoomTV logo, connection icon, title, concise recovery copy, and actions form one centered vertical path with generous safe-area spacing. The redundant eyebrow label is intentionally absent.
- Retry is the only primary action. Connection settings is secondary, and saved-catalog browsing is a tertiary opt-in.

**Focused-region comparison evidence**

- A separate crop was not needed: the implementation capture keeps the heading, explanatory copy, and all three actions legible at full-view size, and the requested change concerns whole-screen hierarchy rather than a small visual detail.

**Required fidelity surfaces**

- Fonts and typography: existing LoomTV system typography is retained; the 30px/800 title establishes a clear error-state hierarchy without truncation or a redundant eyebrow label.
- Spacing and layout rhythm: the content is centered in a 420px maximum-width column and controls use consistent 52px touch targets with safe-area spacing.
- Colors and visual tokens: the existing background, accent, border, panel, text, muted, and faint theme tokens are reused; no new competing status color was introduced.
- Image quality and assets: the official reusable `LoomLogo` and Ionicons are used; stale poster/backdrop imagery is intentionally absent.
- Copy and content: “Server unavailable” names the problem directly, server-neutral language covers desktop and NAS hosts, “Reconnect” is the primary CTA, and the saved-catalog limitation is explicit in two short lines.

**Findings**

- No actionable P0, P1, or P2 visual differences remain for the requested clean unavailable state.

**Comparison history**

- P1: the previous banner sat above stale library artwork and active navigation, making unavailable playback and live actions appear usable. Fixed by replacing the normal shell with a dedicated full-screen unavailable state. Post-fix evidence: `.codex-design-qa/mobile-server-unavailable-ios.png` and `.codex-design-qa/mobile-server-unavailable-comparison.png`.
- P3: the first dedicated state still repeated the connection explanation in an eyebrow, footer, and longer body copy. Fixed by removing the label/footer and shortening the body; the primary CTA is now “Reconnect”. Post-fix evidence: `.codex-design-qa/mobile-server-unavailable-ios.png`.

**Implementation Checklist**

- [x] Dedicated server-unavailable page replaces stale library content by default.
- [x] Retry is the primary action.
- [x] Connection settings remains reachable.
- [x] Saved catalog remains available only through an explicit tertiary action.
- [x] Active library navigation is hidden while the unavailable page is shown.
- [x] iPhone 17 Simulator rendering was captured and visually inspected.
- [x] Android development APK compiled, installed, opened, and reached LoomTV’s pairing screen on a physical Samsung device.

**Follow-up Polish**

- None required for this state.

final result: passed
