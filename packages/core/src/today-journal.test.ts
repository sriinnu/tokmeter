import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TodayJournal } from "./today-journal.js";
import type { TokenRecord } from "./types.js";

// Local-midday literals: vitest and bun test run in different timezones.
const NOON = new Date("2026-10-20T12:00:00").getTime();
const NEXT_NOON = new Date("2026-10-21T12:00:00").getTime();

function rec(overrides: Partial<TokenRecord>): TokenRecord {
  return {
    timestamp: NOON,
    project: "demo",
    provider: "codex",
    model: "gpt-5.5",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0.01,
    ...overrides,
  };
}

const sum = (rs: TokenRecord[]) => rs.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);

describe("TodayJournal", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-journal-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const a1 = rec({ sourceFile: "/s/a.jsonl", apiCallId: "resp_a1", timestamp: NOON });
  const a2 = rec({ sourceFile: "/s/a.jsonl", apiCallId: "resp_a2", timestamp: NOON + 1000 });
  const b1 = rec({ sourceFile: "/s/b.jsonl", apiCallId: "resp_b1", timestamp: NOON + 2000 });

  test("a deleted file's records stay in today", () => {
    const j = new TodayJournal(home);
    expect(j.reconcile([a1, a2, b1], NOON + 5000)).toHaveLength(3);
    const after = j.reconcile([b1], NOON + 17000);
    expect(after).toHaveLength(3);
    expect(sum(after)).toBe(330);
    expect(j.carriedFiles()).toEqual(["/s/a.jsonl"]);
  });

  test("a moved file (Codex archive) is not counted twice", () => {
    const j = new TodayJournal(home);
    j.reconcile([a1, a2, b1], NOON + 5000);
    const moved = [a1, a2].map((r) => ({ ...r, sourceFile: "/archived/a.jsonl" }));
    expect(j.reconcile([...moved, b1], NOON + 17000)).toHaveLength(3);
  });

  test("a moved file without response ids collapses on fingerprint", () => {
    const j = new TodayJournal(home);
    const x = rec({ provider: "amp", sourceFile: "/amp/t.jsonl" });
    j.reconcile([x], NOON + 5000);
    expect(j.reconcile([{ ...x, sourceFile: "/amp/moved.jsonl" }], NOON + 17000)).toHaveLength(1);
  });

  test("a file that comes back is live again, not carried", () => {
    const j = new TodayJournal(home);
    j.reconcile([a1, b1], NOON + 5000);
    j.reconcile([b1], NOON + 17000);
    const grown = { ...a1, apiCallId: "resp_a3", timestamp: NOON + 3000 };
    const back = j.reconcile([a1, grown, b1], NOON + 29000);
    expect(back).toHaveLength(3);
    expect(j.carriedFiles()).toEqual([]);
  });

  test("the carried copy is the file's last state, not its first", () => {
    const j = new TodayJournal(home);
    // Kilo/Roo write a placeholder and fill the counts in later.
    const placeholder = rec({
      provider: "kilo",
      sourceFile: "/k/ui.json",
      inputTokens: 0,
      outputTokens: 0,
    });
    const final = { ...placeholder, inputTokens: 900, outputTokens: 90 };
    j.reconcile([placeholder], NOON + 5000);
    j.reconcile([final], NOON + 17000);
    const after = j.reconcile([], NOON + 29000);
    expect(after).toEqual([final]);
  });

  test("running-total providers are never carried", () => {
    const j = new TodayJournal(home);
    const z = rec({ provider: "zed", sourceFile: "/zed/threads.db" });
    j.reconcile([z], NOON + 5000);
    expect(j.reconcile([], NOON + 17000)).toEqual([]);
  });

  test("records without a source file are never carried", () => {
    const j = new TodayJournal(home);
    j.reconcile([rec({})], NOON + 5000);
    expect(j.reconcile([], NOON + 17000)).toEqual([]);
  });

  test("a restart keeps what vanished before it", () => {
    const j = new TodayJournal(home);
    j.reconcile([a1, a2, b1], NOON + 5000);
    j.reconcile([b1], NOON + 17000);
    const restarted = new TodayJournal(home);
    expect(sum(restarted.reconcile([b1], NOON + 60000))).toBe(330);
  });

  test("a new day starts empty and yesterday's carried records don't leak in", () => {
    const j = new TodayJournal(home);
    j.reconcile([a1, b1], NOON + 5000);
    j.reconcile([b1], NOON + 17000);
    expect(j.reconcile([], NEXT_NOON)).toEqual([]);
    expect(j.carriedFiles()).toEqual([]);
  });

  test("only today's records are carried", () => {
    const j = new TodayJournal(home);
    const yesterday = rec({ sourceFile: "/s/a.jsonl", timestamp: NOON - 86_400_000 });
    j.reconcile([yesterday, a1], NOON + 5000);
    expect(j.reconcile([], NOON + 17000)).toEqual([a1]);
  });

  test("old journals are pruned, a corrupt one is ignored", () => {
    const dir = join(home, ".cache/tokmeter/today");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-09-01.json"), "{}");
    writeFileSync(join(dir, "2026-10-20.json"), "not json");
    const j = new TodayJournal(home);
    expect(j.reconcile([b1], NOON)).toEqual([b1]);
    expect(existsSync(join(dir, "2026-09-01.json"))).toBe(false);
    expect(readdirSync(dir)).toContain("2026-10-20.json");
  });
});
