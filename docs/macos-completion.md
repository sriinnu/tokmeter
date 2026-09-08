---
type: Note
status: Active
---

# macOS completion

Owner: Srinivas + Codex. Started 2026-09-06 after the 1.10.0 release. Workflow: branch → reviewed PR → main. **This work is complete only when all six rows are closed with the evidence below.** Passing source tests, publishing a release, and preparing a trial kit do not close the corresponding real-world checks.

| ID | Area | Status | Completion evidence |
|---|---|---|---|
| MAC-01 | Clean installation and first use | In progress | Published app installed on a fresh macOS account/VM or another Mac, with no Tokmeter checkout/global package; supported Node installation discovered; missing prerequisites explained; daemon starts once and real Claude/Codex usage appears. Record app, daemon, OS, architecture, and install path. |
| MAC-02 | Sustained reliability | Open | At least 72 elapsed hours on one identified installed build, recording app/daemon identity, readiness, RSS/CPU, and recovery. Include natural sleep/wake, a reboot, local midnight, and a controlled daemon restart. Fix unexplained failures and rerun affected evidence. |
| MAC-03 | Real Sparkle upgrade | Open | An installed, notarized prior version discovers the published update, downloads/verifies/replaces/relaunches through Sparkle, and resumes usage. Record before/after versions and preservation of settings/history. Signature-only checks do not close this. |
| MAC-04 | Accounting coverage | Open | Independently reconcile numeric live samples for the primary Claude Code/Codex paths, cover resets/replays/mixed formats/cache/reasoning/day boundaries, and qualify every other advertised integration by observed evidence. Explicitly list unavailable data and un-audited historical ranges. |
| MAC-05 | macOS usability and accessibility | Open | Keyboard-only and VoiceOver walkthroughs; small-screen/text clipping checks; Today/history projects discoverable; empty/offline/error states actionable. Fix issues and record the actual app/build used. |
| MAC-06 | Five-person week-long trial | Needs participants | Five consenting macOS users complete seven days of ordinary use and supply the trial feedback. Log install problems, accounting mismatches, repeat use, and fixes. Invitations require selected recipients and explicit send authorization. No recruitment or trial completion is claimed yet. |

## Current checkpoint

- Baseline: published 1.10.0 (46), Apple Silicon, macOS 14+. Release source tag `v1.10.0`; release and distribution PRs #73/#74 merged.
- Active branch: `fix/macos-first-run-and-reliability`.
- MAC-01 finding: auto-start uses `npx @sriinnu/tokmeter daemon start`, but that package dynamically imports Drishti without installing it. The monorepo masks this missing dependency. Auto-start must invoke the published daemon package directly.
- MAC-01 finding: toolchain discovery only checks `/opt/homebrew/bin/npx` and `/usr/local/bin/npx`; managed Node installations and missing prerequisites need explicit handling.
- MAC-02 finding: generic API/decode/version errors enter the same auto-start path as an unreachable daemon. Recovery and incompatible-data states need distinct treatment.
- Spare Mac/VM availability and participant selection requested; independent implementation continues while those are identified.
- First-use fixes implemented on the active branch: invoke the version-matched Drishti package, discover paired Node/npx in system and managed installations, provide Install Node/Retry actions, preserve protocol errors, and drain bounded subprocess output continuously. Native checks: 22 passed, one optional demo render skipped. Fresh-machine acceptance remains open.
- Reproduced the published CLI-only failure from an isolated npm installation: `tokmeter daemon status` cannot resolve `@sriinnu/drishti`. No daemon or usage data was modified by this reproduction.
- MAC-05 source fixes: content-sized popup, explicit disclosure text color, readable Paper model costs, wrapping signal readings, and Noise retired from the picker. The first local build collapsed its body; the failure was reproduced with the full popup and corrected using direct geometry observations. [Review and validation](macos/popover-usability.md): 26 native tests passed, one optional render skipped, including full-popup first-layout and live disclosure-binding regressions. Installed-app interaction, keyboard, and VoiceOver acceptance remains open.
- Signed commit/PR handoff is pending the configured hardware signing key, which was unavailable on the last attempt. These branch changes have not reached main. Corrected local test build 1.10.0 (46.2) replaced 46.1 and was relaunched from `/Applications` on 2026-09-08; binary identity and local signature verified. The Git signing key is not required for local installation.
- Latest local build: 1.10.0 (46.6), installed and running from `/Applications`. Status colors and badge backgrounds now follow the selected theme explicitly. The user's 46.5 screenshot proved the previous adaptive-color fix still failed in the live popup. Opposing-host native widget captures now assert selected-theme pixels; 27 native tests passed. Binary/signature identity verified; the user accepted 46.6 contrast on 2026-09-08. Remaining interaction/accessibility acceptance stays open.

## Evidence and closure rules

- Record commands/results and build identity in focused documents under `docs/macos/`; keep raw usage, paths identifying private projects, transcripts, and credentials out of committed evidence.
- Long-running observations record elapsed time and identity changes; a restart or changed build starts a new segment and cannot silently inherit a completed soak.
- Source/fixture checks may close substeps, never the fresh-Mac, real-update, observed accessibility, or week-long user criteria by themselves.
- Keep this note current in each PR. Completed rows link to evidence and the merged fix. Unresolved rows stay open with the next action and dependency.
