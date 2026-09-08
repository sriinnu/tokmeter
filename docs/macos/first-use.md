---
type: Note
status: Active
---

# MAC-01: first use

Status: implementation and local regression checks complete; fresh-Mac acceptance open. Changes start from released 1.10.0 and are tracked in [macOS completion](../macos-completion.md).

## Reproduction and fixes

A fresh temporary npm prefix containing only `@sriinnu/tokmeter@1.10.0` fails on `tokmeter daemon status`: its dynamic import of `@sriinnu/drishti` cannot resolve. The app used this same package to start the daemon. A workspace or global installation containing both packages masked the defect.

The app now invokes the Drishti package matching its own version. Drishti declares its dependency on Tokmeter, so npm resolves the complete daemon installation. A first download has a bounded 120-second budget. Subprocess stdout/stderr are drained concurrently with bounded retained output, preventing a full pipe from wedging npm until timeout.

Node discovery requires executable Node and npx in the same installation. It supports the standard Homebrew/local paths and conventional Volta, nvm, fnm, mise, and asdf installation directories without sourcing shell profiles. Missing/old Node presents installation and retry actions. Protocol/decode errors from a running service remain visible instead of triggering another daemon launch.

## Local evidence

- Published CLI-only reproduction failed with the expected missing Drishti import; no daemon was started or stopped.
- Managed-installation fixtures cover absent Node, unpaired npx, numeric version selection, and the GUI subprocess PATH.
- Runner tests cover 512 KiB on each output pipe, bounded retention, nonzero exit, a missing executable, and timeout.
- Protocol mismatch test checks that warming/fresh flags and live color claims clear without starting a second service.
- The real error views are rendered at 320 points for text/action layout inspection. This is visual fixture evidence, not a VoiceOver or fresh-Mac result.
- Native suite: 22 passed; one unrelated optional walkthrough render skipped. Repository lint and whitespace checks passed.

## Fresh-Mac acceptance, still required

1. Use another Apple Silicon Mac, a fresh macOS account, or a macOS VM. Record OS and published app/daemon versions.
2. With Node absent, verify the prerequisite explanation and installation action. Install supported Node using a normal method; do not add a Tokmeter checkout or global Drishti package.
3. Open the app and retry. Verify one daemon starts, the app moves out of warming, and the expected Claude/Codex usage appears.
4. Restart the app and verify it attaches to the same daemon without another scan process.
5. Exercise offline download failure and recovery; confirm errors are actionable and retry is bounded.

Record observed results before closing MAC-01. A temporary npm directory on the development Mac is not a substitute for this check.
