/**
 * Cursor parser tests.
 *
 * Two independent sources, each pinned separately:
 *  - CSV cache (~/.config/tokscale/cursor-cache/*.csv) — the original,
 *    external-sync-dependent path.
 *  - Local SQLite (`cursorDiskKV` in Cursor's own state.vscdb) — read
 *    directly, no external tool. Model name and project often live on a
 *    *different* message ("bubble") than the one carrying real token
 *    counts, so both are resolved per composer (conversation), not per
 *    bubble — these tests pin that cross-bubble resolution.
 *
 * The CSV-wins-if-present rule (scanCsvCache runs first, scanLocalDatabase
 * only runs if it found nothing) exists so a user with both sources set up
 * doesn't get every request counted twice — pinned by the last test below.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorParser } from "./cursor.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cursor-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function seedCsvCache(rows: string[]): void {
  const dir = join(tmpDir, ".config", "tokscale", "cursor-cache");
  mkdirSync(dir, { recursive: true });
  const header = "timestamp,model,project,inputTokens,outputTokens,cost";
  writeFileSync(join(dir, "usage.csv"), [header, ...rows].join("\n"));
}

interface BubbleFixture {
  composerId: string;
  bubbleId: string;
  createdAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  modelName?: string;
  workspaceUri?: string;
}

function seedLocalDb(bubbles: BubbleFixture[]): void {
  const dbDir = join(tmpDir, "Library", "Application Support", "Cursor", "User", "globalStorage");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "state.vscdb");

  execFileSync("sqlite3", [dbPath], {
    input: "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
  });

  for (const b of bubbles) {
    const value = JSON.stringify({
      createdAt: b.createdAt ?? "2026-06-01T12:00:00.000Z",
      tokenCount:
        b.inputTokens !== undefined || b.outputTokens !== undefined
          ? { inputTokens: b.inputTokens ?? 0, outputTokens: b.outputTokens ?? 0 }
          : undefined,
      modelInfo: b.modelName ? { modelName: b.modelName } : undefined,
      workspaceUris: b.workspaceUri ? [b.workspaceUri] : undefined,
    });
    const key = `bubbleId:${b.composerId}:${b.bubbleId}`;
    execFileSync("sqlite3", [dbPath], {
      input: `INSERT INTO cursorDiskKV (key, value) VALUES ('${key}', '${value.replace(/'/g, "''")}');`,
    });
  }
}

describe("CursorParser — local SQLite (cursorDiskKV)", () => {
  it("resolves model and project from a different bubble than the one carrying real tokens", async () => {
    seedLocalDb([
      // This bubble carries the model + workspace, but zero tokens (typical
      // of a request/tool-call bubble).
      {
        composerId: "c1",
        bubbleId: "b1",
        modelName: "claude-4.5-opus-high-thinking",
        workspaceUri: "file:///Users/sriinnu/Sriinnu/AI/medha-grid.ai",
      },
      // This bubble carries the real token count, but no model/workspace of
      // its own — it must inherit both from bubble b1 via the composer.
      { composerId: "c1", bubbleId: "b2", inputTokens: 47521, outputTokens: 4551 },
    ]);

    const records = await new CursorParser().scan(tmpDir);
    expect(records.length).toBe(1);
    const r = records[0];
    expect(r.model).toBe("claude-4.5-opus-high-thinking");
    expect(r.project).toContain("medha-grid.ai");
    expect(r.inputTokens).toBe(47521);
    expect(r.outputTokens).toBe(4551);
    expect(r.usage?.source).toBe("tool_sqlite");
    expect(r.usage?.inputTokens).toBe("direct");
  });

  it("skips bubbles with zero tokens instead of emitting empty records", async () => {
    seedLocalDb([
      { composerId: "c2", bubbleId: "b1", modelName: "gpt-5.2-xhigh" },
      { composerId: "c2", bubbleId: "b2", inputTokens: 0, outputTokens: 0 },
    ]);

    const records = await new CursorParser().scan(tmpDir);
    expect(records.length).toBe(0);
  });

  it("falls back to 'unknown' model and generic project when a composer never carries either", async () => {
    seedLocalDb([{ composerId: "c3", bubbleId: "b1", inputTokens: 100, outputTokens: 20 }]);

    const records = await new CursorParser().scan(tmpDir);
    expect(records[0].model).toBe("unknown");
    expect(records[0].project).toBe("cursor");
  });

  it("keeps composers' token bubbles independent — no cross-composer bleed", async () => {
    seedLocalDb([
      { composerId: "a", bubbleId: "1", modelName: "model-a", inputTokens: 10, outputTokens: 1 },
      { composerId: "b", bubbleId: "1", modelName: "model-b", inputTokens: 20, outputTokens: 2 },
    ]);

    const records = await new CursorParser().scan(tmpDir);
    expect(records.length).toBe(2);
    const models = records.map((r) => r.model).sort();
    expect(models).toEqual(["model-a", "model-b"]);
  });

  it("returns no records when Cursor isn't installed and no CSV cache exists", async () => {
    const records = await new CursorParser().scan(tmpDir);
    expect(records.length).toBe(0);
  });

  it("returns independent record objects across repeated scans (cache must not share mutable state)", async () => {
    // state.vscdb is a large, actively-written app database — re-querying
    // it on every scan tick is the repeated-full-scan pattern that already
    // caused a real memory-pressure incident in this project, so the local
    // read is mtime-cached per dbPath. That cache must never hand back the
    // same object across calls: pricing enrichment mutates
    // record.cost/record.usage.cost in place downstream, and a shared
    // reference would let one scan's enrichment bleed into another's.
    seedLocalDb([
      { composerId: "c1", bubbleId: "b1", modelName: "m", inputTokens: 10, outputTokens: 5 },
    ]);

    const parser = new CursorParser();
    const first = await parser.scan(tmpDir);
    const second = await parser.scan(tmpDir);

    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0].usage).not.toBe(second[0].usage);

    first[0].cost = 999;
    if (first[0].usage) first[0].usage.cost = "not_exposed";
    expect(second[0].cost).toBe(0);
    expect(second[0].usage?.cost).not.toBe("not_exposed");
  });
});

describe("CursorParser — CSV cache takes priority over local SQLite", () => {
  it("uses only the CSV cache when it has data, ignoring local SQLite entirely", async () => {
    seedCsvCache(["2026-06-01T12:00:00Z,gpt-5,my-project,1000,200,0.05"]);
    seedLocalDb([
      {
        composerId: "c1",
        bubbleId: "b1",
        modelName: "claude-opus",
        inputTokens: 99999,
        outputTokens: 99999,
      },
    ]);

    const records = await new CursorParser().scan(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].model).toBe("gpt-5");
    expect(records[0].usage?.cost).toBe("direct");
  });
});
