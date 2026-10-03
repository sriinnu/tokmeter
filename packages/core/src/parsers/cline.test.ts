/**
 * Cline (hub / kanban CLI) parser tests.
 *
 * Fixtures pin the real log shape from ~/.cline/apps/kanban/sessions/*.jsonl:
 * `{ ts, stream, chunk }` lines where only `stream === "chat_usage"` carries
 * usage, and `chunk` is a JSON-encoded string with Anthropic-style buckets
 * (inputTokens already excludes the cached read).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClineParser } from "./cline.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cline-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function seedSession(name: string, lines: unknown[]): void {
  const dir = join(tmpDir, ".cline", "apps", "kanban", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n"));
}

function usageLine(ts: number, chunk: Record<string, number>) {
  return { ts, stream: "chat_usage", chunk: JSON.stringify(chunk) };
}

describe("ClineParser", () => {
  it("emits one record per chat_usage line and ignores other streams", async () => {
    seedSession("1790185442767_abc.jsonl", [
      { ts: 1_790_188_120_707, stream: "chat_core_log", chunk: '{"level":"info"}' },
      { ts: 1_790_188_120_800, stream: "chat_reasoning", chunk: "thinking..." },
      usageLine(1_790_188_152_915, {
        inputTokens: 6875,
        outputTokens: 163,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
      }),
      usageLine(1_790_188_156_626, {
        inputTokens: 429,
        outputTokens: 83,
        cacheReadTokens: 6874,
        cacheWriteTokens: 0,
        cost: 0.0021,
      }),
    ]);

    const records = await new ClineParser().scan(tmpDir);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.provider === "cline")).toBe(true);

    expect(records[0].inputTokens).toBe(6875);
    expect(records[0].outputTokens).toBe(163);

    expect(records[1].inputTokens).toBe(429);
    expect(records[1].cacheReadTokens).toBe(6874);
    // Cline's own cost is kept as a floor when the model can't be priced.
    expect(records[1].cost).toBeCloseTo(0.0021);

    // Stable, distinct dedup ids derived from session + ordinal.
    expect(records[0].apiCallId).not.toBe(records[1].apiCallId);
  });
});
