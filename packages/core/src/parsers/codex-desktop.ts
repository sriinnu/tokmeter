/**
 * @sriinnu/tokmeter-core — Codex SQLite-state fallback parser.
 *
 * Every Codex thread (CLI, VS Code extension, or the standalone Codex
 * Desktop app bundled in ChatGPT.app) gets a row in local SQLite state at
 * $CODEX_HOME/state_5.sqlite, table `threads`, with a genuinely useful,
 * *structured* set of columns: `tokens_used` (cumulative lifetime total),
 * `model`, `cwd`, `source`, `rollout_path`, `updated_at`. This is real local
 * data OpenAI's own Codex engine maintains for its own UI — confirmed on a
 * live "Codex Pro Max" Desktop session showing a genuine, live-updating
 * tokens_used (132,254,795 → 133,172,272 over ~90s) tied to model
 * "gpt-5.6-sol" and the exact project cwd, none of which appears anywhere in
 * that same thread's rollout JSONL.
 *
 * This ONLY fills the gap CodexParser (codex.ts) leaves: CodexParser reads
 * granular per-turn input/output/cache/reasoning breakdowns from JSONL
 * token_count events, which is strictly better data where it exists (real
 * CLI sessions always have it). This parser is a pure fallback for threads
 * whose rollout JSONL has NO token_count events at all — Codex Desktop /
 * VS Code-extension-sourced threads, confirmed to never emit them locally.
 * A thread already covered by CodexParser is explicitly skipped here so a
 * session can never be double-counted under both provider ids.
 *
 * Caveat, deliberately not hidden: `tokens_used` is ONE lump cumulative
 * number — Codex's SQLite state has no input/output/cache split anywhere.
 * Guessing a split just to produce a dollar cost risks being confidently
 * wrong (this codebase has already been burned once by a bad input/cached
 * split — see codex.test.ts's 24x-overcharge regression test), so the full
 * delta is surfaced as a token count with cost explicitly not_exposed,
 * never fabricated from an assumed ratio.
 *
 * tokens_used is cumulative for the thread's whole life, not a discrete
 * per-scan delta — a persisted checkpoint (codex-sqlite-checkpoint.ts) is
 * required so a re-scan counts only what's genuinely new since last time,
 * the same delta-tracking shape as antigravity-live.ts's credit deltas.
 */

import { open, stat } from "node:fs/promises";
import { localDateKey } from "../date-utils.js";
import { canonicalizeProjectName } from "../project-name.js";
import type { SessionParser, TokenRecord } from "../types.js";
import { readCheckpoints, writeCheckpoints } from "./codex-sqlite-checkpoint.js";
import { codexHomeDir } from "./codex.js";
import {
  type ReadonlySqlite,
  createRecord,
  expandHome,
  fileExists,
  getConfiguredProviderPaths,
  openReadonlySqlite,
} from "./utils.js";

const DEFAULT_MODEL = "unknown";
/** Enough to catch a real token_count event anywhere near the tail of an
 * actively-used CLI rollout without reading the whole (possibly 200 MB+)
 * file — same bound codex.ts's own newestEventMs uses for the same reason. */
const TAIL_CHECK_BYTES = 65_536;

interface ThreadRow {
  id: string;
  tokens_used: number;
  model: string | null;
  cwd: string | null;
  rollout_path: string | null;
  updated_at: number;
}

/** Candidate state_5.sqlite paths: the auto-detected $CODEX_HOME plus any
 * configured providerPaths.codex-desktop directories, mirroring codex.ts's
 * own escape hatch for a Codex install that moves in the future. */
function candidateStateDbPaths(homeDir: string): string[] {
  const paths = [`${codexHomeDir(homeDir)}/state_5.sqlite`];
  for (const dir of getConfiguredProviderPaths("codex-desktop", homeDir)) {
    paths.push(`${expandHome(dir, homeDir)}/state_5.sqlite`);
  }
  return paths;
}

async function openStateDb(homeDir: string): Promise<ReadonlySqlite | null> {
  for (const path of candidateStateDbPaths(homeDir)) {
    if (!(await fileExists(path))) continue;
    const db = await openReadonlySqlite(path);
    if (db) return db;
  }
  return null;
}

interface CodexEventShape {
  type?: string;
  payload?: { type?: string };
}

/**
 * True if this rollout file already carries at least one real token_count
 * event — meaning CodexParser already covers it with granular data and this
 * fallback must stay out of the way. A tail read is enough: an actively
 * logging CLI session writes token_count events steadily, so one appears in
 * the last 64 KB whenever the file genuinely has them.
 *
 * Parses each tail line as JSON and checks the STRUCTURED
 * `payload.type === "token_count"` field, not a raw substring match — a
 * Codex Desktop session (which, unlike the CLI, is routinely used to read
 * or write source that legitimately contains the literal text
 * "token_count", e.g. this very file) would otherwise false-positive on
 * that substring and get permanently, silently excluded from this
 * fallback with no other source ever covering it.
 */
async function hasJsonlTokenCoverage(rolloutPath: string): Promise<boolean> {
  try {
    const st = await stat(rolloutPath);
    if (st.size === 0) return false;
    const fd = await open(rolloutPath, "r");
    try {
      const tail = Math.min(TAIL_CHECK_BYTES, st.size);
      const buf = Buffer.alloc(tail);
      await fd.read(buf, 0, tail, st.size - tail);
      const lines = buf.toString("utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as CodexEventShape;
          if (evt.type === "event_msg" && evt.payload?.type === "token_count") return true;
        } catch {
          // partial line (tail read can start mid-record) — skip
        }
      }
      return false;
    } finally {
      await fd.close();
    }
  } catch {
    // Missing/unreadable rollout file — nothing for CodexParser to have
    // covered, so this fallback should still consider the thread.
    return false;
  }
}

export class CodexDesktopParser implements SessionParser {
  readonly providerId = "codex-desktop" as const;

  // opts.modifiedSinceMs is deliberately NOT used to filter the SQL query.
  // TokmeterCore's refreshTodayAccumulator() REPLACES its whole "today"
  // state from whatever a scan returns — it never folds across calls (see
  // codex-sqlite-checkpoint.ts's header comment). Every call here must
  // therefore re-derive the FULL, idempotent "today" picture from scratch;
  // filtering rows by a recency watermark would silently drop threads whose
  // delta is real but that simply weren't touched again since the last poll.
  async scan(homeDir: string): Promise<TokenRecord[]> {
    const db = await openStateDb(homeDir);
    if (!db) return [];

    try {
      const rows = db.all<ThreadRow>(
        "SELECT id, tokens_used, model, cwd, rollout_path, updated_at FROM threads"
      );

      const today = localDateKey();
      const checkpoints = readCheckpoints(homeDir);
      const records: TokenRecord[] = [];
      let checkpointsChanged = false;

      for (const row of rows) {
        // Only threads genuinely touched today can contribute to today's
        // total — prunes the (large, mostly historical) thread table down
        // to today's handful before the pricier per-file coverage check runs.
        if (localDateKey(row.updated_at * 1000) !== today) continue;
        if (!row.rollout_path || (await hasJsonlTokenCoverage(row.rollout_path))) continue;

        const existing = checkpoints[row.id];
        if (!existing || existing.baselineDate !== today) {
          // First sight of this thread ever, OR first sight since a new
          // local day started: (re)establish today's baseline WITHOUT
          // emitting a record. tokens_used is a lifetime cumulative total —
          // a thread active since February, first observed today, has no
          // per-day breakdown anywhere to reconstruct, so treating its
          // entire history as "today's delta" would dump months of backlog
          // into one day. A live install showed exactly this: 2,423
          // threads, 1.09 TRILLION tokens counted as "today" on a first run
          // with no baseline. Same tradeoff antigravity-live.ts's credit
          // deltas already accept: this can say "used since we started
          // watching today," never "what happened before that."
          checkpoints[row.id] = { baselineTokens: row.tokens_used, baselineDate: today };
          checkpointsChanged = true;
          continue;
        }

        // Baseline is STABLE for the whole day (not advanced here) — the
        // same delta is recomputed on every scan until real growth happens,
        // which is what makes this idempotent across repeated same-day
        // calls instead of a consumed-on-read value. Math.max(0, …) floors a
        // legitimate decrease (thread ID reuse, an internal Codex reset) at
        // zero rather than going negative — any usage between the last
        // high-water mark and a reset is unrecoverable (indistinguishable
        // from "this ID now belongs to a smaller, different conversation"),
        // same floor-guard shape as this project's other monotonic counters.
        const delta = Math.max(0, row.tokens_used - existing.baselineTokens);
        if (delta === 0) continue;

        records.push(
          createRecord({
            timestamp: row.updated_at * 1000,
            provider: "codex-desktop",
            model: row.model?.trim() || DEFAULT_MODEL,
            project: row.cwd ? canonicalizeProjectName(row.cwd, "codex-desktop") : "codex-desktop",
            sourceFile: row.rollout_path,
            outputTokens: delta,
            // gpt-5.6-sol (and most Codex models) DO have real kosha pricing,
            // so without this, generic cost enrichment would happily price
            // this lump total at the model's output rate — exactly the
            // guessed-ratio cost this parser exists to avoid. See
            // TokenRecord.costEligible.
            costEligible: false,
          })
        );
      }

      if (checkpointsChanged) writeCheckpoints(checkpoints, homeDir);
      return records;
    } finally {
      db.close();
    }
  }
}
