# 1.10.0 local validation

Checked on 2026-09-06 on Apple Silicon macOS. These results describe the uncommitted local candidate, not a published release or a signed source revision.

| Check | Result |
|---|---|
| JavaScript tests | 360 passed; 11 existing TODOs; 35 test files passed and 2 skipped. |
| Swift tests | 13 passed, including idle-day handling and production-view demo rendering. |
| Repository lint | Biome checked 170 files successfully. |
| Workspace build | TypeScript packages and web build passed. Vite retains a roughly 5 MB minified bundle warning. |
| Script syntax and whitespace | Release/packaging shell syntax and `git diff --check` passed. |
| npm artifacts | Both 1.10.0 tarballs prepared locally; manifests contain no unresolved `workspace:` dependencies. |
| Isolated npm install | Both local tarballs installed into a fresh temporary directory with an isolated npm cache and `--ignore-scripts`. This is not a clean-machine installer test. |
| Packaged entry points | Tokmeter and Drishti help commands passed under Node 26.0.0. The packaged Codex parser produced exactly one Astra record and matched all five expected fixture fields. |
| Secret guard | Repository guard passed, including npm pack surfaces. Its ZIP check covered the existing 1.9.2 archive; no 1.10.0 release ZIP was produced. |
| Installed app | `/Applications/TokmeterBar.app` reports 1.10.0, build 46; deep/strict code-signature verification passed for the local ad-hoc build. |
| Live runtime | Installed app process and restarted source-backed daemon observed. HTTP readiness was true; live cost-basis fields and today's project endpoint returned data. This was a short functional check, not a soak. |
| Demo | Four production-view renders visually inspected; a 20-second synthetic-data MP4 generated. No customer session content used. |

The accounting work reconciled newer Codex receipts and repaired the specifically inspected September 5 totals with a backup. This does not establish correctness of every older sealed day. See [compatibility](../compatibility.md) for per-integration evidence and [number semantics](../how-the-numbers-work.md) for accounting limits.

## Remaining release and trial gates

- Review and signed source commit; changes remain local and uncommitted.
- Developer ID signing, notarization, Sparkle update validation, and a 1.10.0 release archive.
- Public npm/GitHub publishing and verification of published downloads on a clean machine.
- Testing on other Node versions, Intel macOS, and other operating systems.
- Five named participants, invitations, a week of usage, and real feedback. The [trial kit](../trial/guide.md) is prepared; no invitations were sent and no trial results are claimed.

No provider/model completion calls were used for validation.

## License-packaging follow-up

The original candidates omitted the application/core license texts, and the app omitted Sparkle's notices. The packaging scripts now include them alongside a local source archive; the app exposes a **Licenses & source** footer control. Existing AGPL-3.0-only application and MPL-2.0 core licensing is unchanged.

- Repacked both npm candidates into `/tmp/tokmeter-license-candidate`; verified both license texts against the repository and the enclosed source against local files.
- Extracted the source into a temporary directory, installed dependencies using the frozen lockfile, and built the full workspace successfully. The existing Vite bundle-size warning remains.
- Rebuilt and installed 1.10.0 (46); verified its signature and exact AGPL, MPL, and Sparkle notice contents. The installed source snapshot matched 253 source/build files, excluding personal notes and credentials.
- Native follow-up: 12 tests passed, with the optional demo-render test skipped; lint and whitespace checks passed.
- The isolated npm installation's package license declarations were MIT, MIT OR CC0-1.0, ISC, BSD-2-Clause, BSD-3-Clause, or AGPL-3.0-only. No non-private installed package lacked a declaration. This is a metadata inventory, not a source-ownership or exhaustive dependency legal audit.

See [licenses and source](../licensing.md). Signing a source commit and public publishing remain pending.
