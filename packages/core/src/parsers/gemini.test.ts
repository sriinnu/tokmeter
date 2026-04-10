/**
 * Gemini parser regression tests.
 *
 * The Gemini parser had the same double-count bug as Codex: tokens.input
 * from the Gemini CLI mirrors Google's API and is the TOTAL prompt
 * (including cached). The cost calculator assumed Anthropic semantics
 * (input = uncached only). The fix subtracts tokens.cached from tokens.input
 * before creating records. These tests pin that contract to a fixture so we
 * never regress.
 *
 * Note: unlike Codex/Qwen, Gemini stores each session as a SINGLE JSON file
 * (not JSONL) at ~/.gemini/tmp/{id}/chats/{file}.json.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeminiParser } from "./gemini.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gemini-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

interface GeminiMessageFixture {
  type: string;
  model?: string;
  timestamp?: string;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
  };
}

/**
 * Write a fake Gemini session JSON file at the expected location:
 * {tmp}/.gemini/tmp/{sessionId}/chats/{file}.json
 */
function writeFakeSession(messages: GeminiMessageFixture[], sessionTimestamp?: string): string {
  const chatsDir = join(tmpDir, ".gemini", "tmp", "test-session-id", "chats");
  mkdirSync(chatsDir, { recursive: true });
  const filePath = join(chatsDir, "test-chat.json");

  const session = {
    sessionId: "test-session-id",
    timestamp: sessionTimestamp,
    messages,
  };

  writeFileSync(filePath, JSON.stringify(session));
  return filePath;
}

describe("GeminiParser", () => {
  it("subtracts tokens.cached from tokens.input (Anthropic semantics)", async () => {
    // 100k total prompt, 80k cached → 20k uncached input, 80k cache read.
    writeFakeSession([
      {
        type: "gemini",
        model: "gemini-2.5-pro",
        timestamp: "2026-04-09T12:00:10.000Z",
        tokens: { input: 100_000, output: 5_000, cached: 80_000, thoughts: 0 },
      },
    ]);

    const parser = new GeminiParser();
    const records = await parser.scan(tmpDir);
    expect(records.length).toBe(1);

    const r = records[0];
    expect(r.inputTokens).toBe(20_000); // input - cached
    expect(r.cacheReadTokens).toBe(80_000);
    expect(r.outputTokens).toBe(5_000);
    expect(r.provider).toBe("gemini");
    expect(r.model).toBe("gemini-2.5-pro");
  });

  it("leaves input untouched when cached is zero", async () => {
    writeFakeSession([
      {
        type: "gemini",
        model: "gemini-2.5-pro",
        timestamp: "2026-04-09T12:00:10.000Z",
        tokens: { input: 50_000, output: 2_000, cached: 0, thoughts: 0 },
      },
    ]);

    const parser = new GeminiParser();
    const records = await parser.scan(tmpDir);
    expect(records.length).toBe(1);

    const r = records[0];
    expect(r.inputTokens).toBe(50_000);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.outputTokens).toBe(2_000);
  });

  it("clamps to zero when cached > input (pathological API quirk)", async () => {
    writeFakeSession([
      {
        type: "gemini",
        model: "gemini-2.5-pro",
        timestamp: "2026-04-09T12:00:10.000Z",
        tokens: { input: 30_000, output: 1_000, cached: 50_000, thoughts: 0 },
      },
    ]);

    const parser = new GeminiParser();
    const records = await parser.scan(tmpDir);
    expect(records.length).toBe(1);

    const r = records[0];
    expect(r.inputTokens).toBe(0); // Math.max(0, 30k - 50k)
    expect(r.cacheReadTokens).toBe(50_000);
  });

  it("falls back to session timestamp when message has no timestamp", async () => {
    const sessionTs = "2026-04-09T09:30:00.000Z";
    writeFakeSession(
      [
        {
          type: "gemini",
          model: "gemini-2.5-pro",
          // no timestamp on the message itself
          tokens: { input: 10_000, output: 500, cached: 0, thoughts: 0 },
        },
      ],
      sessionTs
    );

    const parser = new GeminiParser();
    const records = await parser.scan(tmpDir);
    expect(records.length).toBe(1);

    const r = records[0];
    expect(new Date(r.timestamp).toISOString()).toBe(sessionTs);
  });
});
