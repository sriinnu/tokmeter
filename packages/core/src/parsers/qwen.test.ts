/**
 * Qwen parser regression tests.
 *
 * The Qwen parser had the same double-count bug as Codex: Google's
 * UsageMetadata reports promptTokenCount as TOTAL prompt tokens
 * (including cached), but the cost calculator assumed Anthropic semantics
 * (input = uncached only). The fix subtracts cachedContentTokenCount from
 * promptTokenCount before creating records. These tests pin that contract
 * to a fixture so we never regress.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QwenParser } from "./qwen.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "qwen-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

interface QwenUsageFixture {
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

/**
 * Write a fake Qwen JSONL session file at the expected location:
 * {tmp}/.qwen/projects/{project}/chats/{chatId}.jsonl
 */
function writeFakeSession(events: QwenUsageFixture[]): string {
  const chatsDir = join(tmpDir, ".qwen", "projects", "-tmp-test-project", "chats");
  mkdirSync(chatsDir, { recursive: true });
  const filePath = join(chatsDir, "test-chat.jsonl");

  const lines: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    lines.push(
      JSON.stringify({
        type: "model",
        model: "qwen3-coder-plus",
        timestamp: `2026-04-09T12:00:${String(10 + i).padStart(2, "0")}.000Z`,
        sessionId: "test-session",
        usageMetadata: {
          promptTokenCount: e.promptTokenCount,
          candidatesTokenCount: e.candidatesTokenCount,
          thoughtsTokenCount: e.thoughtsTokenCount ?? 0,
          cachedContentTokenCount: e.cachedContentTokenCount ?? 0,
        },
      })
    );
  }

  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

describe("QwenParser", () => {
  it("subtracts cachedContentTokenCount from promptTokenCount (Anthropic semantics)", async () => {
    // 100k total prompt, 80k cached → 20k uncached input, 80k cache read.
    writeFakeSession([
      {
        promptTokenCount: 100_000,
        candidatesTokenCount: 5_000,
        cachedContentTokenCount: 80_000,
      },
    ]);

    const parser = new QwenParser();
    const records = await parser.scan(tmpDir);
    expect(records.length).toBe(1);

    const r = records[0];
    expect(r.inputTokens).toBe(20_000); // prompt - cached
    expect(r.cacheReadTokens).toBe(80_000);
    expect(r.outputTokens).toBe(5_000);
    expect(r.provider).toBe("qwen");
    expect(r.model).toBe("qwen3-coder-plus");
  });

  it("leaves input untouched when there is no cached content", async () => {
    writeFakeSession([
      {
        promptTokenCount: 50_000,
        candidatesTokenCount: 2_000,
        cachedContentTokenCount: 0,
      },
    ]);

    const parser = new QwenParser();
    const records = await parser.scan(tmpDir);
    expect(records.length).toBe(1);

    const r = records[0];
    expect(r.inputTokens).toBe(50_000);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.outputTokens).toBe(2_000);
  });

  it("clamps to zero when cached > prompt (pathological API quirk)", async () => {
    writeFakeSession([
      {
        promptTokenCount: 30_000,
        candidatesTokenCount: 1_000,
        cachedContentTokenCount: 50_000,
      },
    ]);

    const parser = new QwenParser();
    const records = await parser.scan(tmpDir);
    expect(records.length).toBe(1);

    const r = records[0];
    expect(r.inputTokens).toBe(0); // Math.max(0, 30k - 50k)
    expect(r.cacheReadTokens).toBe(50_000);
  });

  it("preserves thoughtsTokenCount as reasoningTokens", async () => {
    writeFakeSession([
      {
        promptTokenCount: 10_000,
        candidatesTokenCount: 1_500,
        thoughtsTokenCount: 500,
        cachedContentTokenCount: 0,
      },
    ]);

    const parser = new QwenParser();
    const records = await parser.scan(tmpDir);
    expect(records.length).toBe(1);

    const r = records[0];
    expect(r.reasoningTokens).toBe(500);
    expect(r.outputTokens).toBe(1_500);
    expect(r.inputTokens).toBe(10_000);
  });
});
