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
import { canonicalizeProjectName } from "../project-name.js";
import type { ProviderId, ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import { readCheckpoints, writeCheckpoints } from "./codex-sqlite-checkpoint.js";
import { codexHomeDir } from "./codex.js";
import {
  createRecord,
  expandHome,
  fileExists,
  getConfiguredProviderPaths,
  openReadonlySqlite,
  type ReadonlySqlite,
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

/**
 * True if this rollout file already carries at least one real token_count
 * event — meaning CodexParser already covers it with granular data and this
 * fallback must stay out of the way. A tail read is enough: an actively
 * logging CLI session writes token_count events steadily, so one appears in
 * the last 64 KB whenever the file genuinely has them.
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
      return buf.toString("utf-8").includes('"token_count"');
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

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const db = await openStateDb(homeDir);
    if (!db) return [];

    try {
      const watermark = opts?.modifiedSinceMs;
      const rows = db.all<ThreadRow>(
        watermark !== undefined
          ? "SELECT id, tokens_used, model, cwd, rollout_path, updated_at FROM threads WHERE updated_at * 1000 >= ?"
          : "SELECT id, tokens_used, model, cwd, rollout_path, updated_at FROM threads",
        ...(watermark !== undefined ? [watermark] : [])
      );

      const checkpoints = readCheckpoints(homeDir);
      const records: TokenRecord[] = [];
      let checkpointsChanged = false;

      for (const row of rows) {
        if (!row.rollout_path || (await hasJsonlTokenCoverage(row.rollout_path))) continue;

        // First time this thread is ever seen: establish tokens_used as the
        // baseline WITHOUT emitting a record. tokens_used is a lifetime
        // cumulative total, not a per-day figure — a thread active since
        // February, first observed today, has no per-day breakdown anywhere
        // to reconstruct, so treating its entire history as "today's delta"
        // would dump months of backlog into one day (a live install showed
        // this concretely: 2,423 threads, 1.09 TRILLION tokens on a
        // first run with no checkpoint). Same tradeoff antigravity-live.ts
        // already makes: this can say "used since we started watching,"
        // never "what you did before that."
        const existing = checkpoints[row.id];
        checkpoints[row.id] = { lastTokensUsed: row.tokens_used, lastSeenAt: Date.now() };
        checkpointsChanged = true;
        if (!existing) continue;

        const delta = Math.max(0, row.tokens_used - existing.lastTokensUsed);
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
