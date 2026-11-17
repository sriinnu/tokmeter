/**
 * The oracle's own test: small Codex homes, each built around one edge the
 * real data rarely shows, with the right answer worked out by hand.
 *
 *   bun run build && node scripts/oracle/test-fixtures.mjs
 *
 * Two checks per fixture:
 *   1. the oracle's rows plus the tokens its rule-free cross-checks flag as
 *      not counted equal the hand-worked total, so the judge is tested. (The
 *      oracle shares a few rules with tokmeter, like keep-largest for fork
 *      families; where such a rule loses work, the cross-check is what sees it);
 *   2. tokmeter's verdict (compare-codex.mjs) is what we expect. A fixture in
 *      KNOWN_BUGS must still FAIL: when a parser fix makes it pass, this test
 *      fails too, saying so, and the entry comes out of KNOWN_BUGS in the same
 *      change. That keeps the list honest in both directions.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Receipts in mkfix.py use input 1000 (400 cached), output 100: 1,100 tokens each.
// Each total is the truth, worked out by hand. The oracle must either count it
// exactly (rows plus what its cross-checks quantify as uncounted) or raise a gap:
// a judge may miss work only out loud.
const TRUTH = {
  f1: 4400, // parent r1 r2 r4 + the fork's own r3; the fork's replay of r1 counts once
  f2: 352, // 110, +110, counter restarts at 55, +77
  f3: 165, // 110, a {} total beside last_token_usage 33, then a cumulative 165 that includes it
  f4: 1100, // a usage line with a byte that isn't UTF-8 still counts
  f6: 1100, // a receipt with no timestamp still counts, dated by the file's birth time (a shared choice, not a check)
  f7: 1100, // one response id in two unrelated rollouts counts once
  f8: 0, // an empty sessions folder
  f9: 330, // a guardian's total restored with the compaction is inherited, even when it equals its last usage; then +330
  f10: 330, // a reused guardian: its first total carries earlier work in, skipped
  f11: 330, // three calls of 110 in one turn, only one of them with a receipt
  f12: 275, // 110, then the counter restarts at 165 (higher, so input never goes down)
  f13: 220, // 110, the same total and last usage written again (0), then +110
};

// Fixtures where tokmeter's parser is known to be wrong today, and how the
// comparison must show it: "rows" (the oracle counts it differently) or "gap"
// (both sides share the rule; a rule-free cross-check catches it). Each entry
// comes out in the PR that fixes it.
const KNOWN_BUGS = {
  f1: { why: "keep-largest fork dedup drops the fork's own work", shows: "gap" },
  f2: { why: "a legacy counter that goes down is not treated as a restart", shows: "rows" },
  f3: { why: "an empty {} total is treated as a counter", shows: "rows" },
  f7: { why: "a response id repeated across files is emitted twice", shows: "rows" },
  f11: {
    why: "a turn's legacy counters are dropped when any receipt exists, even if receipts miss calls",
    shows: "gap",
  },
  f12: { why: "a counter restart that doesn't go down is read as a small step", shows: "gap" },
};

const root = mkdtempSync(join(tmpdir(), "codex-fixtures-"));
// tokmeter writes under HOME (~/.tokmeter, ~/.cache/tokmeter) while it scans;
// a hand run of this test must not leave that in the real one.
const home = join(root, ".home");
mkdirSync(home);
const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.CODEX_HOME;
let failed = 0;
try {
  const mk = spawnSync("python3", ["-I", join(here, "fixtures", "mkfix.py"), root], {
    encoding: "utf8",
  });
  if (mk.status !== 0) throw new Error(`mkfix.py failed: ${mk.stderr}`);
  for (const name of Object.keys(TRUTH)) {
    const r = spawnSync(
      process.execPath,
      [join(here, "compare-codex.mjs"), "--codex-home", join(root, name), "--allow-empty"],
      { encoding: "utf8", maxBuffer: 64 << 20, env }
    );
    const out = r.stdout ?? "";
    const end = out.indexOf("\n}\n");
    let report;
    try {
      report = JSON.parse(out.slice(0, end + 2));
    } catch {
      console.log(`✗ ${name}: no report from compare-codex.mjs\n${out}${r.stderr}`);
      failed++;
      continue;
    }
    const cx = report.oracle.cross_checks;
    const flagged = cx.tokens_not_counted + cx.receipt_turns_short_tokens;
    const got = report.oracle.tokens + flagged;
    const want = TRUTH[name];
    const rowDiffs =
      report.row_diffs.only_oracle + report.row_diffs.only_tokmeter + report.day_diffs;
    const gapped = report.gaps.length > 0;
    const verdict = r.status === 0 ? "PASS" : "FAIL";
    const bug = KNOWN_BUGS[name];
    const problems = [];
    if (got !== want && !gapped)
      problems.push(
        `oracle counted ${report.oracle.tokens}, flagged ${flagged}, raised no gap; the truth is ${want}`
      );
    if (bug?.shows === "rows" && !rowDiffs)
      problems.push(`expected row diffs for "${bug.why}", got none`);
    if (bug?.shows === "gap" && !gapped) problems.push(`expected a gap for "${bug.why}", got none`);
    if (bug && verdict === "PASS")
      problems.push(
        `tokmeter now passes; the bug "${bug.why}" looks fixed, remove it from KNOWN_BUGS`
      );
    if (!bug && verdict === "FAIL")
      problems.push(
        `tokmeter fails: ${out
          .slice(end + 3)
          .trim()
          .split("\n")
          .slice(0, 4)
          .join(" | ")}`
      );
    if (problems.length) {
      failed++;
      console.log(`✗ ${name}: ${problems.join("; ")}`);
    } else {
      console.log(
        `✓ ${name}: oracle ${report.oracle.tokens}${flagged ? ` + ${flagged} flagged` : ""}, tokmeter ${report.tokmeter.tokens}${bug ? ` (known bug, ${bug.shows}: ${bug.why})` : ""}`
      );
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failed ? `\noracle fixtures: ${failed} failed` : "\noracle fixtures: all as expected");
process.exit(failed ? 1 : 0);
