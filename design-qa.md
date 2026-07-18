**Source visual truth**

- `/var/folders/pd/0s26rrp54jd95230zcfqg3lw0000gn/T/codex-clipboard-741871ab-4e6c-4613-9760-d4c98f59383c.png`
- `/var/folders/pd/0s26rrp54jd95230zcfqg3lw0000gn/T/codex-clipboard-20a67795-a4ce-473c-a6a0-db0b5f847b9d.png`
- User direction: use medium-weight CTA labels and show desktop-style watched progress on the series detail CTA.

**Implementation evidence**

- Home CTA: `/tmp/loomtv-mobile-medium-progress-initial.png`
- In-progress detail CTA: `/tmp/loomtv-mobile-progress-detail-final.png`
- Full-view comparison: `/tmp/loomtv-progress-button-comparison.png`
- Focused CTA comparison: `/tmp/loomtv-progress-button-focused-comparison.png`
- Viewport: 1080 × 2340, Samsung SM-S906B, Android, dark theme.
- State: The Legend of Vox Machina home and detail views; S01E01 resumed at 12m of 27m.

**Findings**

- No actionable P0, P1, or P2 differences remain for the requested controls.
- Fonts and typography: both CTA labels now use weight 500. The detail CTA uses a medium 17px primary label and an 11px medium progress label with clear hierarchy.
- Spacing and layout rhythm: the icon and two-line copy remain centered as one group without changing the CTA height, margins, or 12px radius.
- Colors and visual tokens: existing accent/foreground tokens remain intact; the watched portion uses a subtle 20% black overlay consistent with the desktop progress treatment.
- Image quality and asset fidelity: existing poster art and play icons are unchanged.
- Copy and content: the detail CTA now reports the selected on-deck episode and, when in progress, the watched position and duration (for example, `S01E01 · 12m of 27m`).

**Comparison history**

- Initial P2: home and detail CTA text used bold weight 700.
  Fix: changed both CTA labels to medium weight 500.
  Post-fix evidence: `/tmp/loomtv-mobile-medium-progress-initial.png` and `/tmp/loomtv-mobile-progress-detail-final.png`.
- Initial P1: the series detail CTA only displayed `Watch S01E01` or `Resume S01E01`, hiding how far playback had progressed.
  Fix: reused the existing on-deck progress state to render action, episode code, elapsed/total minutes, and a proportional background fill.
  Post-fix evidence: `/tmp/loomtv-progress-button-focused-comparison.png`.

**Open Questions**

- None.

**Implementation Checklist**

- [x] Use medium weight on the home hero CTA.
- [x] Use medium weight on the detail CTA.
- [x] Show the current on-deck episode.
- [x] Show elapsed and total minutes when playback is in progress.
- [x] Show proportional watched progress in the CTA background.
- [x] Verify a real in-progress episode on Android hardware.

**Follow-up Polish**

- None required for this request.

final result: passed
