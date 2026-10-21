/**
 * GitHub Copilot CLI parser tests.
 *
 * Fixtures pin the real event shape from ~/.copilot/session-state/<id>/events.jsonl:
 * a `session.start` with `context.gitRoot`, per-response `assistant.message`
 * output, and the authoritative per-model rollup in
 * `session.shutdown.data.modelMetrics`. Usage is OpenAI-style: input includes
 * cache reads (stripped) and output includes reasoning (kept inside output).
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
    // Reasoning is part of output; counting it again would double it.
    expect(mini.outputTokens).toBe(143693);
    expect(mini.reasoningTokens).toBe(0);
    expect(mini.project).toContain("Auren");

    const sonnet = records.find((r) => r.model === "claude-sonnet-4.6")!;
    expect(sonnet.inputTokens).toBe(5000);
  });

  it("counts a session's output before it shuts down", async () => {
    seedSession("sess-open", [
      { type: "session.start", data: { sessionId: "sess-open", context: { cwd: "/w/b" } } },
      {
        type: "assistant.message",
        timestamp: "2026-10-20T10:00:00.000Z",
        data: { messageId: "m1", model: "gpt-5.4", outputTokens: 10 },
      },
    ]);

    const records = await new CopilotCliParser().scan(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ model: "gpt-5.4", outputTokens: 10, inputTokens: 0 });
  });

  it("puts output on the day it was spent when a session runs past midnight", async () => {
    const before = new Date("2026-10-20T23:50:00").toISOString();
    const after = new Date("2026-10-21T00:10:00").toISOString();
    seedSession("sess-midnight", [
      {
        type: "session.start",
        data: { sessionId: "sess-midnight", selectedModel: "gpt-5.4", context: { cwd: "/w/c" } },
      },
      { type: "assistant.message", timestamp: before, data: { messageId: "a", outputTokens: 300 } },
      { type: "assistant.message", timestamp: after, data: { messageId: "b", outputTokens: 200 } },
      {
        type: "session.shutdown",
        timestamp: after,
        data: {
          modelMetrics: {
            "gpt-5.4": {
              usage: {
                inputTokens: 9000,
                outputTokens: 500,
                cacheReadTokens: 8000,
                reasoningTokens: 120,
              },
            },
          },
        },
      },
    ]);

    const records = await new CopilotCliParser().scan(tmpDir);
    const day = (r: { timestamp: number }) => new Date(r.timestamp).getDate();
    const onDay = (d: number) => records.filter((r) => day(r) === d);
    expect(onDay(20).reduce((s, r) => s + r.outputTokens, 0)).toBe(300);
    expect(onDay(21).reduce((s, r) => s + r.outputTokens, 0)).toBe(200);
    // The rollup's input and cache land with the shutdown; totals match it exactly.
    const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens") =>
      records.reduce((s, r) => s + r[k], 0);
    expect(sum("inputTokens")).toBe(1000);
    expect(sum("cacheReadTokens")).toBe(8000);
    expect(sum("outputTokens")).toBe(500);
    expect(new Set(records.map((r) => r.apiCallId)).size).toBe(records.length);
  });

  it("adds only the growth of a resumed session's later shutdown", async () => {
    const t = (h: number) =>
      new Date(`2026-10-20T${String(h).padStart(2, "0")}:00:00`).toISOString();
    const shutdown = (time: string, input: number, output: number) => ({
      type: "session.shutdown",
      timestamp: time,
      data: {
        modelMetrics: { "gpt-5.4": { usage: { inputTokens: input, outputTokens: output } } },
      },
    });
    seedSession("sess-resumed", [
      { type: "session.start", data: { sessionId: "sess-resumed", selectedModel: "gpt-5.4" } },
      { type: "assistant.message", timestamp: t(9), data: { messageId: "a", outputTokens: 40 } },
      shutdown(t(10), 1000, 40),
      { type: "session.start", data: { sessionId: "sess-resumed", selectedModel: "gpt-5.4" } },
      { type: "assistant.message", timestamp: t(11), data: { messageId: "b", outputTokens: 60 } },
      shutdown(t(12), 2500, 100),
    ]);

    const records = await new CopilotCliParser().scan(tmpDir);
    expect(records.reduce((s, r) => s + r.inputTokens, 0)).toBe(2500);
    expect(records.reduce((s, r) => s + r.outputTokens, 0)).toBe(100);
  });
});
