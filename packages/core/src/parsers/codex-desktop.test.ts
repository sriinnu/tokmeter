/**
 * Codex SQLite-state fallback parser regression tests.
 *
 * Codex Desktop / VS Code-extension sessions never emit token_count events
 * in their rollout JSONL, but every Codex thread (CLI included) gets a row
 * in local state_5.sqlite with a real cumulative tokens_used total — this
 * parser fills exactly the gap CodexParser's JSONL-only reading leaves.
 *
 * These tests pin three things found via real bugs on a live install:
 *  1. First sight of a thread must establish a start-of-day baseline WITHOUT
 *     emitting a record (else a February-to-July thread first observed
 *     today dumps its ENTIRE lifetime total into "today" — 2,423 threads,
 *     1.09 TRILLION tokens on one real first run).
 *  2. scan() must be IDEMPOTENT for "today": repeated same-day calls with
 *     no new growth must return the SAME delta every time, not an empty
 *     result — TokmeterCore's refreshTodayAccumulator() REPLACES its whole
 *     "today" state from whatever the last scan() returned rather than
 *     folding across calls, so a "delta consumed on read" design silently
 *     loses everything but the most recent poll window's growth.
 *  3. The JSONL-coverage skip must be JSON-aware, not a raw substring
 *     match — a Desktop session routinely reads/writes source that can
 *     legitimately contain the literal text "token_count" without it being
 *     a real event, which would otherwise permanently and silently exclude
 *     that thread from ever being tracked.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDateKey } from "../date-utils.js";
import { CodexDesktopParser } from "./codex-desktop.js";
import { CodexParser } from "./codex.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "codex-sqlite-fallback-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

interface ThreadFixture {
  id: string;
  tokensUsed: number;
  model: string;
  cwd: string;
  rolloutPath: string;
  updatedAtSec: number;
}

function stateDbPath(): string {
  return join(tmpDir, ".codex", "state_5.sqlite");
}

function checkpointPath(): string {
  return join(tmpDir, ".cache", "tokmeter", "codex-sqlite-checkpoints.json");
}

function seedStateDb(threads: ThreadFixture[]): void {
  mkdirSync(join(tmpDir, ".codex"), { recursive: true });
  const dbPath = stateDbPath();
  execFileSync("sqlite3", [dbPath], {
    input:
      "CREATE TABLE threads (id TEXT PRIMARY KEY, tokens_used INTEGER NOT NULL DEFAULT 0, " +
      "model TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER NOT NULL);",
  });
  for (const t of threads) {
    execFileSync("sqlite3", [dbPath], {
      input:
        `INSERT INTO threads (id, tokens_used, model, cwd, rollout_path, updated_at) VALUES (` +
        `'${t.id}', ${t.tokensUsed}, '${t.model}', '${t.cwd.replace(/'/g, "''")}', ` +
        `'${t.rolloutPath.replace(/'/g, "''")}', ${t.updatedAtSec});`,
    });
  }
}

function updateTokensUsed(threadId: string, tokensUsed: number): void {
  const nowSec = Math.floor(Date.now() / 1000);
  execFileSync("sqlite3", [stateDbPath()], {
    input: `UPDATE threads SET tokens_used = ${tokensUsed}, updated_at = ${nowSec} WHERE id = '${threadId}';`,
  });
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** Writes a rollout JSONL. `withTokenCount` simulates a real CLI session
 * CodexParser already covers — the SQLite fallback must skip those.
 * `extraText` lets a test inject a literal payload string (e.g. the text
 * "token_count") that must NOT be mistaken for a real event. */
function writeRollout(fileName: string, opts?: { withTokenCount?: boolean; extraText?: string }): string {
  const sessionsDir = join(tmpDir, ".codex", "sessions", "2026", "07", "10");
  mkdirSync(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, fileName);

  const lines: string[] = [
    JSON.stringify({
      timestamp: "2026-07-10T13:18:49.000Z",
      type: "session_meta",
      payload: { id: "test-session", cwd: "/Users/test/AUriva" },
    }),
  ];
  if (opts?.extraText) {
    lines.push(
      JSON.stringify({
        timestamp: "2026-07-10T13:18:50.000Z",
        type: "response_item",
        payload: { text: opts.extraText },
      })
    );
  }
  if (opts?.withTokenCount) {
    lines.push(
      JSON.stringify({
        timestamp: "2026-07-10T13:19:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 } },
        },
      })
    );
  }
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

describe("CodexDesktopParser (SQLite state fallback)", () => {
  it("establishes a baseline on first sight, then returns the SAME idempotent delta on repeated scans until real growth changes it", async () => {
    const rolloutPath = writeRollout("rollout-desktop.jsonl");
    seedStateDb([
      { id: "thread-1", tokensUsed: 133_172_272, model: "gpt-5.6-sol", cwd: "/Users/test/AUriva", rolloutPath, updatedAtSec: nowSec() },
    ]);

    // First sight: establishes the baseline, emits nothing — NOT the full
    // 133M lifetime total (the real bug this guards against).
    const first = await new CodexDesktopParser().scan(tmpDir);
    expect(first.length).toBe(0);

    // Genuine new growth.
    updateTokensUsed("thread-1", 133_182_272);
    const second = await new CodexDesktopParser().scan(tmpDir);
    expect(second.length).toBe(1);
    const r = second[0];
    expect(r.provider).toBe("codex-desktop");
    expect(r.model).toBe("gpt-5.6-sol");
    expect(r.project).toBe("AUriva");
    expect(r.outputTokens).toBe(10_000);
    expect(r.inputTokens).toBe(0);
    expect(r.cost).toBe(0);
    expect(r.usage).toMatchObject({ cost: "not_exposed", inputTokens: "not_exposed" });

    // CRITICAL: re-scanning with NO new growth must return the SAME delta
    // again, not an empty result. TokmeterCore replaces its whole "today"
    // state from each scan's return value rather than folding across calls
    // — an empty result here would make "today's" total silently drop back
    // toward zero between polls even though nothing was lost.
    const third = await new CodexDesktopParser().scan(tmpDir);
    expect(third.length).toBe(1);
    expect(third[0].outputTokens).toBe(10_000);

    // Further growth on top — delta grows from the SAME stable baseline,
    // not from the last-seen value.
    updateTokensUsed("thread-1", 133_192_272);
    const fourth = await new CodexDesktopParser().scan(tmpDir);
    expect(fourth.length).toBe(1);
    expect(fourth[0].outputTokens).toBe(20_000);
  });

  it("resets to a fresh baseline when a new local day starts, without flooding the new day with the prior day's total", async () => {
    const rolloutPath = writeRollout("rollout-desktop.jsonl");
    seedStateDb([
      { id: "thread-1", tokensUsed: 100_000, model: "gpt-5.6-sol", cwd: "/Users/test/AUriva", rolloutPath, updatedAtSec: nowSec() },
    ]);

    await new CodexDesktopParser().scan(tmpDir); // baseline = 100_000, today
    updateTokensUsed("thread-1", 150_000);
    const beforeRollover = await new CodexDesktopParser().scan(tmpDir);
    expect(beforeRollover.length).toBe(1);
    expect(beforeRollover[0].outputTokens).toBe(50_000);

    // Simulate a day rollover by back-dating the persisted checkpoint.
    const checkpoints = JSON.parse(readFileSync(checkpointPath(), "utf-8"));
    checkpoints["thread-1"].baselineDate = "2020-01-01";
    writeFileSync(checkpointPath(), JSON.stringify(checkpoints));

    // First scan of the "new day": re-baselines to the CURRENT tokens_used
    // (150_000) without emitting yesterday's total as today's usage.
    const afterRollover = await new CodexDesktopParser().scan(tmpDir);
    expect(afterRollover.length).toBe(0);

    // New day's real growth is then tracked correctly from the new baseline.
    updateTokensUsed("thread-1", 160_000);
    const newDayGrowth = await new CodexDesktopParser().scan(tmpDir);
    expect(newDayGrowth.length).toBe(1);
    expect(newDayGrowth[0].outputTokens).toBe(10_000);
  });

  it("skips a thread whose rollout JSONL already has token_count events", async () => {
    // A real CLI session must be picked up ONLY by CodexParser, never by the
    // SQLite fallback, even though it also has a threads row.
    const rolloutPath = writeRollout("rollout-cli.jsonl", { withTokenCount: true });
    seedStateDb([
      { id: "thread-cli", tokensUsed: 19_841_596, model: "gpt-5.3-codex-spark", cwd: "/Users/test/AUriva", rolloutPath, updatedAtSec: nowSec() },
    ]);

    const desktopRecords = await new CodexDesktopParser().scan(tmpDir);
    const cliRecords = await new CodexParser().scan(tmpDir);

    expect(desktopRecords.length).toBe(0);
    expect(cliRecords.length).toBe(1);
    expect(cliRecords[0].provider).toBe("codex");
  });

  it("does not mistake a literal 'token_count' substring in session text for a real event", async () => {
    // A Desktop session can legitimately read/write source referencing the
    // literal string "token_count" (e.g. a coding session touching this
    // very codebase) without ever emitting a real token_count EVENT. A raw
    // substring check would false-positive here and permanently, silently
    // drop this thread from tracking.
    const rolloutPath = writeRollout("rollout-desktop.jsonl", {
      extraText: 'grep -n "token_count" packages/core/src/parsers/codex.ts',
    });
    seedStateDb([
      { id: "thread-1", tokensUsed: 100_000, model: "gpt-5.6-sol", cwd: "/Users/test/AUriva", rolloutPath, updatedAtSec: nowSec() },
    ]);

    await new CodexDesktopParser().scan(tmpDir);
    updateTokensUsed("thread-1", 120_000);
    const records = await new CodexDesktopParser().scan(tmpDir);

    expect(records.length).toBe(1);
    expect(records[0].outputTokens).toBe(20_000);
  });

  it("returns nothing when there's no state_5.sqlite at all", async () => {
    const records = await new CodexDesktopParser().scan(tmpDir);
    expect(records).toEqual([]);
  });

  it("never considers a thread not touched today, even with a stale existing baseline", async () => {
    const rolloutPath = writeRollout("rollout-old.jsonl");
    const staleSec = Math.floor(new Date("2020-01-01T00:00:00.000Z").getTime() / 1000);
    seedStateDb([
      { id: "thread-old", tokensUsed: 5_000_000, model: "gpt-5.6-sol", cwd: "/Users/test/AUriva", rolloutPath, updatedAtSec: staleSec },
    ]);

    const records = await new CodexDesktopParser().scan(tmpDir);
    expect(records).toEqual([]);
    // Sanity: localDateKey of the fixture really is in the past relative to
    // "today", i.e. this test is actually exercising the date filter.
    expect(localDateKey(staleSec * 1000)).not.toBe(localDateKey());
  });
});
