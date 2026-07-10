/**
 * Codex SQLite-state fallback parser regression tests.
 *
 * Codex Desktop / VS Code-extension sessions never emit token_count events
 * in their rollout JSONL, but every Codex thread (CLI included) gets a row
 * in local state_5.sqlite with a real cumulative tokens_used total — this
 * parser fills exactly the gap CodexParser's JSONL-only reading leaves.
 * These tests pin: the JSONL-coverage skip (never double-count a thread
 * CodexParser already handles), checkpoint-based delta tracking (a
 * cumulative total must not be recounted on every scan), and honest
 * cost non-exposure (no input/output split exists to price from).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

/** Writes a rollout JSONL. `withTokenCount` simulates a real CLI session
 * CodexParser already covers — the SQLite fallback must skip those. */
function writeRollout(fileName: string, opts?: { withTokenCount?: boolean }): string {
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
  it("never emits a thread's full historical total on first sight (baseline-only)", async () => {
    // Regression for a real bug found on a live install: with no prior
    // checkpoint, a thread's entire lifetime tokens_used (a February-to-July
    // thread, first observed today) was being emitted as a single "today"
    // record — 2,423 threads, 1.09 TRILLION tokens, on one first run.
    // First sight must establish a baseline silently; only growth AFTER
    // that baseline counts as real, dateable usage.
    const rolloutPath = writeRollout("rollout-desktop.jsonl");
    seedStateDb([
      {
        id: "thread-1",
        tokensUsed: 133_172_272,
        model: "gpt-5.6-sol",
        cwd: "/Users/test/AUriva",
        rolloutPath,
        updatedAtSec: Math.floor(new Date("2026-07-10T13:59:42.000Z").getTime() / 1000),
      },
    ]);

    const first = await new CodexDesktopParser().scan(tmpDir);
    expect(first.length).toBe(0);

    // New growth after the baseline is real, dateable usage — this is what
    // should show up, and only this.
    execFileSync("sqlite3", [stateDbPath()], {
      input: "UPDATE threads SET tokens_used = 133182272 WHERE id = 'thread-1';",
    });
    const second = await new CodexDesktopParser().scan(tmpDir);
    expect(second.length).toBe(1);

    const r = second[0];
    expect(r.provider).toBe("codex-desktop");
    expect(r.model).toBe("gpt-5.6-sol");
    expect(r.project).toBe("AUriva");
    expect(r.outputTokens).toBe(10_000);
    expect(r.inputTokens).toBe(0);
    expect(r.cost).toBe(0);
    expect(r.usage).toMatchObject({
      cost: "not_exposed",
      inputTokens: "not_exposed",
    });
  });

  it("skips a thread whose rollout JSONL already has token_count events", async () => {
    // A real CLI session must be picked up ONLY by CodexParser, never by the
    // SQLite fallback, even though it also has a threads row.
    const rolloutPath = writeRollout("rollout-cli.jsonl", { withTokenCount: true });
    seedStateDb([
      {
        id: "thread-cli",
        tokensUsed: 19_841_596,
        model: "gpt-5.3-codex-spark",
        cwd: "/Users/test/AUriva",
        rolloutPath,
        updatedAtSec: Math.floor(Date.now() / 1000),
      },
    ]);

    const desktopRecords = await new CodexDesktopParser().scan(tmpDir);
    const cliRecords = await new CodexParser().scan(tmpDir);

    expect(desktopRecords.length).toBe(0);
    expect(cliRecords.length).toBe(1);
    expect(cliRecords[0].provider).toBe("codex");
  });

  it("never recounts the same tokens_used on a re-scan with no new growth", async () => {
    const rolloutPath = writeRollout("rollout-desktop.jsonl");
    seedStateDb([
      {
        id: "thread-1",
        tokensUsed: 100_000,
        model: "gpt-5.6-sol",
        cwd: "/Users/test/AUriva",
        rolloutPath,
        updatedAtSec: Math.floor(Date.now() / 1000),
      },
    ]);

    // First sight: establishes the 100_000 baseline, emits nothing.
    const first = await new CodexDesktopParser().scan(tmpDir);
    expect(first.length).toBe(0);

    // Unchanged tokens_used — a re-scan must not recount anything either.
    const second = await new CodexDesktopParser().scan(tmpDir);
    expect(second.length).toBe(0);

    // Genuine new growth — only the delta since the baseline shows up.
    execFileSync("sqlite3", [stateDbPath()], {
      input: "UPDATE threads SET tokens_used = 145000 WHERE id = 'thread-1';",
    });
    const third = await new CodexDesktopParser().scan(tmpDir);
    expect(third.length).toBe(1);
    expect(third[0].outputTokens).toBe(45_000);

    // Unchanged again after that — must not recount the 145_000 either.
    const fourth = await new CodexDesktopParser().scan(tmpDir);
    expect(fourth.length).toBe(0);
  });

  it("returns nothing when there's no state_5.sqlite at all", async () => {
    const records = await new CodexDesktopParser().scan(tmpDir);
    expect(records).toEqual([]);
  });
});
