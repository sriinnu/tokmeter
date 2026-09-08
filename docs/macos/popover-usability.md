---
type: Note
status: Active
---

# Popover usability

Source checkpoint: 2026-09-08, branch `fix/macos-first-run-and-reliability`.

The installed 1.10.0 (46) screenshots showed a large empty area below collapsed Usage details. The root imposed a 520-point minimum height while its scroll view consumed spare space. The source now measures the scroll content and header/footer, fits short content, and caps long content against the screen's visible height (780 points maximum). A hosting-view regression exercises small → overflowing → small content and verifies the panel returns to its original height.

Usage details now uses the theme's explicit primary text color. Paper's model cost numbers also use dark text; bright tier colors remain in its bars. Signal readings wrap intact instead of competing for one truncated row.

## Theme review

Reviewed production hero and usage views with synthetic demo data, expanded and collapsed, across the seven previously selectable themes. Keep Terminal, Paper, Nebula, Aurora, Nocturne, and Glass. Remove Noise from the picker: its yellow background, white cards, and bright cost colors compete with the readings. Its enum case remains readable for existing saved preferences, consistent with the other retired themes.

Render artifacts are local, under `/tmp/tokmeter-ui-qa`. These are fixture views, not screenshots of an installed build. Material appearance also depends on the live desktop. Aggregate KPI values remain zero in this fixture because it supplies today's model/project data only.

## Validation

From `packages/macos-bar`:

```sh
TOKMETER_UI_QA_DIR=/tmp/tokmeter-ui-qa CLANG_MODULE_CACHE_PATH=/tmp/tokmeter-clang-cache swift test --disable-sandbox
```

Initial result: 24 passed, one optional public walkthrough render skipped, zero failures. Theme and startup renders ran. That first layout regression exercised an isolated scroll area and missed the full-popup failure described below. MAC-05 remains open.

Local installation: 2026-09-08, `/Applications/TokmeterBar.app` version 1.10.0 (46.1), ad-hoc signed development build. The installed executable matches the branch build (SHA-256 `59507f0367e6b3b6fa74d9c8c691e4a9a4fdc7fb374d4e131479fad691c58c83`), deep/strict signature verification passed, and the installed process was observed running. The previous app was backed up locally. This is not a published/notarized release or proof of the pending interaction checks.

## First-layout regression and correction

The user observed that build 46.1 displayed only the hero and footer. Reproduced with the full production `TokmeterBarView` in an initially one-point-high AppKit hosting window: the entire popup remained 158 points high. The earlier isolated scroll test passed against the same broken implementation.

Replace propagated height preferences with direct geometry observations for the scroll content, hero, error area, and footer. The first layout starts with the available screen budget so content can be measured; later layouts use its actual height. The cap follows the hosting window's screen and screen-configuration changes. This keeps the popup content-sized and scrolls only when required.

Expanded and collapsed full-popup tests now verify that the body is present on first layout, grows when model/project records arrive, and shrinks when those records disappear. A separate test drives the production Usage details binding through expand → smaller viewport → larger viewport → collapse and verifies the resulting heights. Full production-view renders were inspected in both states. Updated native result: 26 passed, one optional walkthrough render skipped, zero failures. Actual installed MenuBarExtra interaction, multiple-monitor positioning, overlays, keyboard navigation, and VoiceOver remain unverified; the native automation service was unavailable during this correction.

Corrected local installation: 1.10.0 (46.2) installed and relaunched from `/Applications` on 2026-09-08. Installed executable SHA-256 `aea32ed7092eb78b11c363c8a7e2eb68987062dfdebf6594eafe8915280124a0` matches the new branch build; deep/strict ad-hoc signature verification passed and the installed process was observed running. Build 46.1 has been replaced.

## Full-row control and frosted Glass

Usage details now has one full-width button containing its chevron and label. Clicking either, or the space beside the label, runs the same toggle action. The button also supports keyboard activation and exposes its expanded/collapsed state to accessibility.

Glass now uses one native `NSVisualEffectView` behind-window blur, a subtle frost tint, and translucent cards shared by the popup and Hub. Nested material layers and animated header gloss were removed; icy high-contrast values replace the muted slate/beige palette. Reduce Transparency uses an opaque fallback. Full production popup renders for Glass and Nebula were inspected, collapsed and expanded; 26 native tests passed and one optional walkthrough render was skipped. Wallpaper-dependent appearance and actual pointer/VoiceOver interaction still require live observation.

Installed local build 1.10.0 (46.3) in `/Applications` on 2026-09-08. Executable SHA-256 `8d64d7f70545c7c07b87e78f138a5c88f147aca0d79a489e8e04b925abb39854` matches the branch build; deep/strict ad-hoc signature verification passed and the installed process was observed running. Lint, whitespace, and staged secret checks passed.

## Light frost and footer hierarchy

Glass now uses the light native popover material, a pale frost tint, dark ink text, and low-contrast translucent cards. The header blends into the main surface instead of ending in a separate rounded slab. Its opaque accessibility fallback uses the same light palette.

The footer separates app details (credit, exact version/build, licenses) from pricing freshness and warnings. All labels stay on one line in the inspected fixtures, including simultaneous unpriced and repriced badges. The credit, license link, and repricing badge are native buttons. Full popup renders were reviewed in Glass, Terminal, Paper, and Nebula, expanded and collapsed, with all pricing indicators present. Native checks: 26 passed, one optional walkthrough render skipped. Live wallpaper-dependent appearance and pointer/VoiceOver checks remain open.

Installed local build 1.10.0 (46.4) in `/Applications` on 2026-09-08; executable SHA-256 `e5d009f85c03d574b4e98027597724e961a9c4b35491dc981cf63e3d634c6bdc`. Binary identity, deep/strict ad-hoc signature, and running installed process verified. Lint, whitespace, and staged secret checks passed.

## Contrast on light surfaces

User screenshots of installed builds 46.4 and 46.5 showed washed-out yellow Pace text and green percentage badges. The 46.5 dynamic `NSColor` fix passed preview tests but failed in the live menu window: status colors still followed the host appearance. Those tests did not cover the actual mismatch.

The replacement resolves warning/success/danger colors directly from `AppTheme`. Light surfaces use deep amber, green, and red ink; dark surfaces retain luminous accents. Percentage badges also choose their pale backing directly from the theme. The popup and Hub set an explicit SwiftUI color-scheme environment for native controls. Signal icons, cache bars, footer status, and pricing warnings use the same explicit palette.

Regression checks render both light and dark themes under opposing color schemes and assert invariant status ink with at least 4.5:1 contrast against representative surfaces. Production Pace and percentage widgets are captured inside a Dark Aqua native window with a dark SwiftUI environment, even for Glass and Paper; pixel assertions require the selected theme's actual ink. Full production popup fixtures also run under a dark host. Glass, Paper, and Terminal widget captures were visually inspected. This checks the host mismatch and representative backgrounds; it is not a blanket accessibility claim for every wallpaper.

Native result: 27 passed, one optional walkthrough render skipped. Lint, whitespace, and the full repository secret guard passed. Installed local build 1.10.0 (46.6) in `/Applications` on 2026-09-08; executable SHA-256 `a3f59a1fd671205cfe7494e6325dbd5c6c100c833da99a79e951c8269f5f4326`. Binary identity, deep/strict ad-hoc signature, and running installed process verified. The user accepted the installed 46.6 contrast revision on 2026-09-08. Agent inspection covered the native-host fixture captures; automated live capture remained unavailable. Keyboard, VoiceOver, and broader usability gates stay open.
