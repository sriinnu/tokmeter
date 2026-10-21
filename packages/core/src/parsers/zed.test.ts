/**
 * Zed parser tests.
 *
 * Zed is open source, so — unlike the reverse-engineered VS Code Copilot
 * and Antigravity parsers — this fixture uses Zed's actual current schema
 * (crates/agent/src/db.rs): a `threads` table whose `data` column is a
 * zstd-compressed JSON blob of a flattened `DbThread`. No live Zed install
 * was available to validate against, so these tests are the only
 * verification this parser has had — they pin the real column names, the
 * real JSON field names, and the real zstd framing.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZedParser } from "./zed.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zed-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

interface ThreadFixture {
  id: string;
  summary: string;
  updatedAt: string;
  createdAt?: string;
  folderPaths?: string[];
  /** Original (pre-lexicographic-sort) index of each entry in folderPaths. */
  folderPathsOrder?: number[];
  model?: { provider: string; model: string };
  cumulativeTokenUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  compressed?: boolean;
}

/**
 * Builds a fixture threads.db via the `sqlite3` CLI, storing each thread's
 * `data` blob exactly as Zed does: JSON matching the real flattened
 * `DbThread` shape, zstd-compressed (or raw, for the legacy 'json' path).
 */
function seedThreadsDb(threads: ThreadFixture[]): void {
  const dbDir = join(tmpDir, "Library", "Application Support", "Zed", "threads");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "threads.db");

  execFileSync("sqlite3", [dbPath], {
    input: [
      "CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT, updated_at TEXT, data_type TEXT, data BLOB, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT);",
    ].join("\n"),
  });

  for (const t of threads) {
    const json = JSON.stringify({
      title: t.summary,
      messages: [],
      updated_at: t.updatedAt,
      cumulative_token_usage: t.cumulativeTokenUsage ?? {},
      model: t.model,
      version: "0.3.0",
    });
    const dataType = t.compressed === false ? "json" : "zstd";
    const dataBuf =
      t.compressed === false ? Buffer.from(json) : zstdCompressSync(Buffer.from(json));
    const dataBlobPath = join(dbDir, `${t.id}.blob`);
    writeFileSync(dataBlobPath, dataBuf);

    const folderPathsSql = t.folderPaths ? `'${t.folderPaths.join("\n")}'` : "NULL";
    const folderPathsOrderSql = t.folderPathsOrder ? `'${t.folderPathsOrder.join(",")}'` : "NULL";
    const createdAtSql = t.createdAt ? `'${t.createdAt}'` : "NULL";
    execFileSync("sqlite3", [dbPath], {
      input: `INSERT INTO threads (id, summary, updated_at, data_type, data, folder_paths, folder_paths_order, created_at) VALUES ('${t.id}', '${t.summary.replace(/'/g, "''")}', '${t.updatedAt}', '${dataType}', readfile('${dataBlobPath}'), ${folderPathsSql}, ${folderPathsOrderSql}, ${createdAtSql});`,
    });
  }
}

/** Replace the fixture db, keeping the parser's baselines under tmpDir/.cache. */
function reseed(threads: ThreadFixture[]): void {
  rmSync(join(tmpDir, "Library", "Application Support", "Zed", "threads"), {
    recursive: true,
    force: true,
  });
  seedThreadsDb(threads);
}

describe("ZedParser", () => {
  it("decodes zstd-compressed thread data with real token counts", async () => {
    seedThreadsDb([
      {
        id: "thread-1",
        summary: "Fix the parser bug",
        updatedAt: "2026-06-01T12:00:00Z",
        createdAt: "2026-06-01T11:00:00Z",
        model: { provider: "anthropic", model: "claude-sonnet-4-5" },
        cumulativeTokenUsage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 100,
        },
        folderPaths: ["/Users/sriinnu/Sriinnu/Personal/tokmeter"],
      },
    ]);

    const records = await new ZedParser().scan(tmpDir);
    expect(records.length).toBe(1);
    const r = records[0];
    expect(r.provider).toBe("zed");
    expect(r.model).toBe("claude-sonnet-4-5");
    expect(r.inputTokens).toBe(1200);
    expect(r.outputTokens).toBe(340);
    expect(r.cacheReadTokens).toBe(500);
    expect(r.cacheWriteTokens).toBe(100);
    expect(r.project).toContain("tokmeter");
    // Timestamp comes from updated_at, not created_at — cumulative_token_usage
    // is the running total "as of the latest save," and created_at is fixed
    // at thread creation and never changes on reuse (see the next test).
    expect(r.timestamp).toBe(new Date("2026-06-01T12:00:00Z").getTime());
  });

  it("counts only a reused thread's growth on the day it happened, not its history", async () => {
    // cumulative_token_usage is a running total, so emitting it whole put a
    // long thread's entire history on every day it was touched again (and,
    // on a fresh install, months of usage on one day). Local-midday literals:
    // vitest and bun test run in different timezones.
    const thread = (updatedAt: string, input: number, output: number): ThreadFixture => ({
      id: "reused-thread",
      summary: "Long-running refactor",
      createdAt: "2026-01-01T12:00:00",
      updatedAt,
      cumulativeTokenUsage: { input_tokens: input, output_tokens: output },
    });
    const parser = new ZedParser();

    // First sight of an old thread: its history can't be split across the
    // days it ran, so it counts nothing yet.
    seedThreadsDb([thread("2026-06-15T12:00:00", 500, 100)]);
    expect(await parser.scan(tmpDir)).toEqual([]);

    // Used again the next day: only the growth, stamped on that day.
    reseed([thread("2026-06-16T12:00:00", 800, 150)]);
    const [r] = await parser.scan(tmpDir);
    expect(r?.inputTokens).toBe(300);
    expect(r?.outputTokens).toBe(50);
    expect(r?.timestamp).toBe(new Date("2026-06-16T12:00:00").getTime());

    // Rescanning the same day gives the same delta (today is replaced each
    // tick, so it must be idempotent), and more growth that day adds to it.
    expect((await parser.scan(tmpDir))[0]?.inputTokens).toBe(300);
    reseed([thread("2026-06-16T18:00:00", 900, 150)]);
    expect((await parser.scan(tmpDir))[0]?.inputTokens).toBe(400);

    // A later day starts from where the previous one ended.
    reseed([thread("2026-06-20T12:00:00", 1000, 200)]);
    const [later] = await parser.scan(tmpDir);
    expect(later?.inputTokens).toBe(100);
    expect(later?.outputTokens).toBe(50);
  });

  it("resolves the originally-first folder, not the lexicographically-first one, for a multi-root workspace", async () => {
    seedThreadsDb([
      {
        id: "multi-root",
        summary: "Multi-root workspace",
        updatedAt: "2026-06-01T12:00:00Z",
        createdAt: "2026-06-01T11:00:00Z",
        cumulativeTokenUsage: { input_tokens: 10, output_tokens: 5 },
        // "docs" sorts before "zeta-project" lexicographically, but the user
        // opened zeta-project first (order index 0).
        folderPaths: ["/Users/sriinnu/docs", "/Users/sriinnu/zeta-project"],
        folderPathsOrder: [1, 0],
      },
    ]);

    const records = await new ZedParser().scan(tmpDir);
    expect(records[0].project).toContain("zeta-project");
  });

  it("decodes the legacy uncompressed 'json' data_type", async () => {
    seedThreadsDb([
      {
        id: "thread-legacy",
        summary: "Old thread",
        updatedAt: "2026-01-01T12:00:00Z",
        createdAt: "2026-01-01T11:00:00Z",
        model: { provider: "openai", model: "gpt-5" },
        cumulativeTokenUsage: { input_tokens: 50, output_tokens: 10 },
        compressed: false,
      },
    ]);

    const records = await new ZedParser().scan(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].model).toBe("gpt-5");
    expect(records[0].inputTokens).toBe(50);
  });

  it("skips threads with no recorded token usage instead of emitting an all-zero record", async () => {
    seedThreadsDb([
      { id: "empty-thread", summary: "Just opened", updatedAt: "2026-06-01T12:00:00Z" },
    ]);

    const records = await new ZedParser().scan(tmpDir);
    expect(records.length).toBe(0);
  });

  it("falls back to a generic project when folder_paths is absent", async () => {
    seedThreadsDb([
      {
        id: "no-folder",
        summary: "Scratch thread",
        updatedAt: "2026-06-01T12:00:00Z",
        createdAt: "2026-06-01T11:00:00Z",
        cumulativeTokenUsage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const records = await new ZedParser().scan(tmpDir);
    expect(records[0].project).toBe("zed");
  });

  it("returns no records when Zed isn't installed", async () => {
    const records = await new ZedParser().scan(tmpDir);
    expect(records.length).toBe(0);
  });
});
