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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Receipts in mkfix.py use input 1000 (400 cached), output 100: 1,100 tokens each.
const EXPECTED_TOKENS = {
  f1: 4400, // parent r1 r2 r4 + the fork's own r3; the fork's replay of r1 counts once
  f2: 352, // 110, +110, counter restarts at 55, +77
  f3: 198, // 110, a {} total beside last_token_usage 33, then +55 to 165
  f4: 1100, // a usage line with a byte that isn't UTF-8 still counts
  f6: 1100, // a receipt with no timestamp still counts, dated by the file's birth time (a shared choice, not a check)
  f7: 1100, // one response id in two unrelated rollouts counts once
  f8: 0, // an empty sessions folder
  f9: 880, // a fresh guardian's first call after `compacted` (total == own usage), then +330
  f10: 330, // a reused guardian: its first total carries earlier work in, skipped
};

// Fixtures where tokmeter's parser is known to be wrong today. Each one comes
// out of this list in the PR that fixes it.
const KNOWN_BUGS = {
  f1: "keep-largest fork dedup drops the fork's own work",
  f2: "a legacy counter that goes down is not treated as a restart",
  f3: "an empty {} total is treated as a counter",
  f7: "a response id repeated across files is emitted twice",
  f9: "a first call after `compacted` is skipped as if carried in",
};

const root = mkdtempSync(join(tmpdir(), "codex-fixtures-"));
let failed = 0;
try {
  const mk = spawnSync("python3", ["-I", join(here, "fixtures", "mkfix.py"), root], {
    encoding: "utf8",
  });
  if (mk.status !== 0) throw new Error(`mkfix.py failed: ${mk.stderr}`);
  for (const [name, want] of Object.entries(EXPECTED_TOKENS)) {
    const r = spawnSync(
      process.execPath,
      [join(here, "compare-codex.mjs"), "--codex-home", join(root, name), "--allow-empty"],
      { encoding: "utf8", maxBuffer: 64 << 20 }
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
    const flagged = report.oracle.cross_checks.tokens_not_counted;
    const got = report.oracle.tokens + flagged;
    const verdict = r.status === 0 ? "PASS" : "FAIL";
    const bug = KNOWN_BUGS[name];
    const problems = [];
    if (got !== want)
      problems.push(
        `oracle counted ${report.oracle.tokens} and flagged ${flagged}, hand-worked total is ${want}`
      );
    if (bug && verdict === "PASS")
      problems.push(`tokmeter now passes; the bug "${bug}" looks fixed, remove it from KNOWN_BUGS`);
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
        `✓ ${name}: oracle ${report.oracle.tokens}${flagged ? ` + ${flagged} flagged` : ""}, tokmeter ${report.tokmeter.tokens}${bug ? ` (known bug: ${bug})` : ""}`
      );
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failed ? `\noracle fixtures: ${failed} failed` : "\noracle fixtures: all as expected");
process.exit(failed ? 1 : 0);
