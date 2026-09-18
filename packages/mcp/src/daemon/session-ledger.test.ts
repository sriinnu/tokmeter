import { describe, expect, test } from "vitest";
import { belongsToTranscript, computeSessionLedger } from "./session-ledger.js";

const T = "/home/u/.claude/projects/-repo/abc-123.jsonl";

const rec = (sourceFile: string | undefined, over: Partial<Record<string, number>> = {}) => ({
  sourceFile,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 100,
  cacheWriteTokens: 20,
  reasoningTokens: 3,
  cost: 0.01,
  ...over,
});

describe("belongsToTranscript", () => {
  test("exact transcript file matches", () => {
    expect(belongsToTranscript(T, T)).toBe(true);
  });

  test("subagent runs nested under the session id match", () => {
    expect(
      belongsToTranscript("/home/u/.claude/projects/-repo/abc-123/subagents/agent-1.jsonl", T)
    ).toBe(true);
  });

  test("a sibling session whose id shares a prefix does not match", () => {
    expect(belongsToTranscript("/home/u/.claude/projects/-repo/abc-1234.jsonl", T)).toBe(false);
    expect(
      belongsToTranscript("/home/u/.claude/projects/-repo/abc-1234/subagents/a.jsonl", T)
    ).toBe(false);
  });

  test("missing sourceFile never matches", () => {
    expect(belongsToTranscript(undefined, T)).toBe(false);
  });
});

describe("computeSessionLedger", () => {
  test("sums only this session's records, subagents included", () => {
    const records = [
      rec(T),
      rec(T, { inputTokens: 20 }),
      rec("/home/u/.claude/projects/-repo/abc-123/subagents/agent-1.jsonl", { cost: 0.5 }),
      rec("/home/u/.claude/projects/-repo/other.jsonl", { inputTokens: 9999 }),
      rec(undefined, { inputTokens: 9999 }),
    ];
    expect(computeSessionLedger(records, T)).toEqual({
      inputTokens: 40,
      outputTokens: 15,
      cacheReadTokens: 300,
      cacheWriteTokens: 60,
      reasoningTokens: 9,
      cost: 0.52,
      turns: 3,
    });
  });

  test("null when nothing matches or no transcript given", () => {
    expect(computeSessionLedger([rec("/x.jsonl")], T)).toBeNull();
    expect(computeSessionLedger([rec(T)], "")).toBeNull();
  });

  test("records without reasoningTokens count as zero", () => {
    const r = { ...rec(T) } as Record<string, unknown>;
    r.reasoningTokens = undefined;
    expect(computeSessionLedger([r as never], T)?.reasoningTokens).toBe(0);
  });
});
