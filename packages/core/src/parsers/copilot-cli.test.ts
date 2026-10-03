/**
 * GitHub Copilot CLI parser tests.
 *
 * Fixtures pin the real event shape from ~/.copilot/session-state/<id>/events.jsonl:
 * a `session.start` with `context.gitRoot`, and the authoritative per-model
 * rollup in `session.shutdown.data.modelMetrics`. `usage.inputTokens` is
 * OpenAI-style (cache-inclusive) and has its cached portion stripped. A session
 * with no shutdown event contributes nothing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopilotCliParser } from "./copilot-cli.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "copilot-cli-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function seedSession(id: string, events: unknown[]): void {
  const dir = join(tmpDir, ".copilot", "session-state", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
}

describe("CopilotCliParser", () => {
  it("emits one record per model from the shutdown rollup and strips cached input", async () => {
    seedSession("sess-done", [
      {
        type: "session.start",
        data: {
          sessionId: "sess-done",
          startTime: 1_780_669_521_564,
          context: { cwd: "/w/a", gitRoot: "/Users/me/Auren" },
        },
      },
      {
        type: "session.shutdown",
        data: {
          sessionStartTime: 1_780_669_521_564,
          modelMetrics: {
            "gpt-5.4-mini": {
              usage: {
                inputTokens: 1_000_000,
                outputTokens: 143693,
                cacheReadTokens: 900000,
                cacheWriteTokens: 0,
                reasoningTokens: 97483,
              },
            },
            "claude-sonnet-4.6": {
              usage: { inputTokens: 5000, outputTokens: 400, cacheReadTokens: 0 },
            },
          },
        },
      },
    ]);

    const records = await new CopilotCliParser().scan(tmpDir);
    expect(records).toHaveLength(2);

    const mini = records.find((r) => r.model === "gpt-5.4-mini")!;
    expect(mini.inputTokens).toBe(100000); // 1,000,000 − 900,000 cached
    expect(mini.cacheReadTokens).toBe(900000);
    expect(mini.reasoningTokens).toBe(97483);
    expect(mini.project).toContain("Auren");

    const sonnet = records.find((r) => r.model === "claude-sonnet-4.6")!;
    expect(sonnet.inputTokens).toBe(5000);
  });

  it("contributes nothing for a session with no shutdown event", async () => {
    seedSession("sess-open", [
      { type: "session.start", data: { sessionId: "sess-open", context: { cwd: "/w/b" } } },
      { type: "assistant.message", data: { model: "gpt-5.4", outputTokens: 10 } },
    ]);

    const records = await new CopilotCliParser().scan(tmpDir);
    expect(records).toHaveLength(0);
  });
});
