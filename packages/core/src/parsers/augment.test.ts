/**
 * Augment (Auggie CLI) parser tests.
 *
 * Fixtures pin the real session shape from ~/.augment/sessions/*.json:
 * `chatHistory[].exchange.response_nodes[]` where only the real response node
 * carries `token_usage` (placeholder nodes carry none), Anthropic-style, and
 * the workspace comes from a nested `repository_root`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AugmentParser } from "./augment.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "augment-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function seedSession(session: unknown): void {
  const dir = join(tmpDir, ".augment", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sess-1.json"), JSON.stringify(session));
}

describe("AugmentParser", () => {
  it("emits one record per node with usage, maps cache buckets, and sets project from repository_root", async () => {
    seedSession({
      sessionId: "sess-1",
      created: 1_771_610_727_208,
      agentState: { workspace: { repository_root: "/Users/me/Personal/takumi" } },
      chatHistory: [
        {
          exchange: {
            request_id: "req-1",
            response_nodes: [
              { id: "n0", type: 5, token_usage: null }, // placeholder — ignored
              {
                id: "n1",
                type: 10,
                timestamp_ms: 1_771_610_730_000,
                token_usage: {
                  input_tokens: 3,
                  output_tokens: 259,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 12136,
                },
              },
            ],
          },
        },
      ],
    });

    const records = await new AugmentParser().scan(tmpDir);
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.provider).toBe("augment");
    expect(r.inputTokens).toBe(3);
    expect(r.outputTokens).toBe(259);
    expect(r.cacheWriteTokens).toBe(12136); // cache_creation → cacheWrite
    expect(r.cacheReadTokens).toBe(0);
    expect(r.project).toContain("takumi");
    expect(r.timestamp).toBe(1_771_610_730_000);
  });
});
