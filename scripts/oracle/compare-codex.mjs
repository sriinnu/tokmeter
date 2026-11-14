/**
 * Compare tokmeter's Codex parser against the independent oracle
 * (codex_oracle.py, which shares no code with packages/core).
 *
 *   bun run build   # the harness runs the BUILT parser, under node, like the daemon
 *   node scripts/oracle/compare-codex.mjs --codex-home <copy> [--today | --since-ms <ms>]
 *        [--allow-empty] [--allow-warnings] [--allow-gaps]
 *
 * Exit 1, with the first differences printed, unless all of these hold:
 *   1. per-response rows match as a multiset: file, timestamp, model, cwd,
 *      subagent flag, input, cached, output, reasoning, response id; and
 *      tokmeter wrote no cache-write tokens (Codex has none);
 *   2. per-day totals after tokmeter's day fold (aggregateRecordsByDay, the
 *      path into the relay) match the oracle's per-day sums;
 *   3. neither side saw a problem: no parser warnings, no unreadable files;
 *   4. the oracle's rule-free cross-checks found no gap (every response id on
 *      disk counted; legacy-only files add up to their last cumulative total).
 *      A gap there means a rule both sides share is losing or inventing work.
 *      A carried-in total whose source rollout has aged off disk is printed
 *      as a note, not a gap: it can't be matched, only bounded;
 *   5. there was something to compare (an empty run proves nothing).
 *
 * Point --codex-home at a copy (APFS: cp -cR ~/.codex/sessions …), never at a
 * live Codex home: files growing between the two reads would show as diffs.
 * Bun is not supported: its zstd streams stalled a full-history scan with
 * thousands of descriptors open (2026-11-14).
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const arg = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (n) => argv.includes(n);

const codexHome = arg("--codex-home") && resolve(arg("--codex-home"));
if (!codexHome) {
  console.error(
    "usage: --codex-home <dir> [--today | --since-ms <ms>] [--allow-empty] [--allow-warnings] [--allow-gaps]"
  );
  process.exit(2);
}
let sinceMs = arg("--since-ms") !== undefined ? Number(arg("--since-ms")) : undefined;
if (flag("--today")) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  sinceMs = d.getTime();
}

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, "../../packages/core/dist");
const { CodexParser } = await import(join(core, "parsers/codex.js"));
const { aggregateRecordsByDay } = await import(join(core, "aggregates.js"));

const oracleArgs = ["-I", join(here, "codex_oracle.py"), "--codex-home", codexHome, "--rows"];
if (sinceMs !== undefined) oracleArgs.push("--since-ms", String(sinceMs));
const t0 = performance.now();
const run = spawnSync("python3", oracleArgs, { encoding: "utf8", maxBuffer: 1 << 30 });
if (run.status !== 0) {
  console.error(run.stderr);
  process.exit(2);
}
const oracle = JSON.parse(run.stdout);
const oracleMs = performance.now() - t0;

process.env.CODEX_HOME = codexHome;
const warnings = [];
const t1 = performance.now();
const records = await new CodexParser().scan(process.env.HOME ?? "", {
  ...(sinceMs !== undefined ? { modifiedSinceMs: sinceMs } : {}),
  onWarning: (m) => warnings.push(m),
});
const parserMs = performance.now() - t1;

// ── 1. per-response rows ──
const key = (f, ts, m, cwd, sub, i, c, o, r, id) =>
  [f, ts, m, cwd, sub ? 1 : 0, i, c, o, r, id ?? ""].join("|");
const counts = new Map();
for (const r of oracle.rows) {
  const k = key(
    r.file,
    r.ts,
    r.model,
    r.cwd || "",
    r.subagent,
    r.input,
    r.cached,
    r.output,
    r.reasoning,
    r.response_id
  );
  counts.set(k, (counts.get(k) ?? 0) + 1);
}
for (const r of records) {
  const k = key(
    r.sourceFile ?? "",
    r.timestamp,
    r.model,
    r.cwd ?? "",
    r.isSubagent === true,
    r.inputTokens,
    r.cacheReadTokens,
    r.outputTokens,
    r.reasoningTokens,
    r.apiCallId ?? null
  );
  counts.set(k, (counts.get(k) ?? 0) - 1);
}
const onlyOracle = [];
const onlyTokmeter = [];
for (const [k, n] of counts) {
  for (let i = 0; i < Math.abs(n); i++)
    (n > 0 ? onlyOracle : onlyTokmeter).push(k.replace(codexHome, ""));
}
const cacheWrites = records.filter((r) => r.cacheWriteTokens).length;

// ── 2. per-day totals after the day fold ──
const dayDiffs = [];
const seen = new Set();
for (const d of aggregateRecordsByDay(records)) {
  seen.add(d.date);
  const o = oracle.days[d.date] ?? { input: 0, cached: 0, output: 0, reasoning: 0, records: 0 };
  const t = {
    input: d.inputTokens,
    cached: d.cacheReadTokens,
    output: d.outputTokens,
    reasoning: d.reasoningTokens,
    records: d.recordCount,
  };
  for (const b of Object.keys(t))
    if (t[b] !== o[b]) dayDiffs.push(`${d.date} ${b}: tokmeter ${t[b]} oracle ${o[b]}`);
}
for (const date of Object.keys(oracle.days)) {
  if (!seen.has(date))
    dayDiffs.push(`${date}: oracle has ${oracle.days[date].records} records, tokmeter none`);
}

// ── 3–5. problems, gaps, emptiness ──
const x = oracle.cross_checks;
const gaps = [];
if (x.response_ids_not_counted)
  gaps.push(
    `${x.response_ids_not_counted} response ids on disk not counted (${x.tokens_not_counted} tokens), e.g. ${x.not_counted_sample.slice(0, 3).join(", ")}`
  );
if (x.legacy_files_not_matching_final_total.length)
  gaps.push(
    `${x.legacy_files_not_matching_final_total.length} legacy-only files don't add up to their last total`
  );
// Not a gap: every baseline here already holds more than its own response
// (the oracle counts one that doesn't), so it carried earlier work in; only the
// rollout it came from has aged off disk, so the number can't be matched.
const notes = [];
if (x.inherited_baselines_unverified.length)
  notes.push(
    `${x.inherited_baselines_unverified.length} carried-in totals whose source rollout is no longer on disk`
  );
const problems = [];
if (warnings.length) problems.push(`${warnings.length} parser warnings`);
if (oracle.skipped.unreadable_file)
  problems.push(`${oracle.skipped.unreadable_file} files the oracle couldn't read`);
const empty = oracle.rows.length === 0 && records.length === 0;

const sum = (rs, f) => rs.reduce((s, r) => s + f(r), 0);
console.log(
  JSON.stringify(
    {
      node: process.version,
      sinceMs: sinceMs ?? null,
      oracle: {
        files_considered: oracle.files_considered,
        files_counted: oracle.files_counted,
        rows: oracle.rows.length,
        tokens: sum(oracle.rows, (r) => r.input + r.cached + r.output + r.reasoning),
        ms: Math.round(oracleMs),
        skipped: oracle.skipped,
        same_ms_equal_count_rows: oracle.same_ms_equal_count_rows,
        cross_checks: { ...x, assumed_rules: undefined },
      },
      tokmeter: {
        rows: records.length,
        tokens: sum(
          records,
          (r) => r.inputTokens + r.cacheReadTokens + r.outputTokens + r.reasoningTokens
        ),
        ms: Math.round(parserMs),
        warnings: warnings.length,
        cache_write_rows: cacheWrites,
      },
      row_diffs: { only_oracle: onlyOracle.length, only_tokmeter: onlyTokmeter.length },
      day_diffs: dayDiffs.length,
      gaps,
      notes,
      problems,
      empty,
    },
    null,
    1
  )
);
for (const k of onlyOracle.slice(0, 10)) console.log(`  only oracle:   ${k}`);
for (const k of onlyTokmeter.slice(0, 10)) console.log(`  only tokmeter: ${k}`);
for (const d of dayDiffs.slice(0, 20)) console.log(`  day: ${d}`);
for (const w of warnings.slice(0, 5)) console.log(`  warning: ${w.replace(codexHome, "")}`);
const fail =
  onlyOracle.length ||
  onlyTokmeter.length ||
  cacheWrites ||
  dayDiffs.length ||
  (problems.length && !flag("--allow-warnings")) ||
  (gaps.length && !flag("--allow-gaps")) ||
  (empty && !flag("--allow-empty"));
console.log(fail ? "FAIL" : "PASS");
process.exit(fail ? 1 : 0);
