import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { carriedRecordsFor, TodayJournal } from "./today-journal.js";
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
    expect(j.carriedFiles()).toEqual(["codex|/s/a.jsonl"]);
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

  test("shared-database records without a thread key are never carried", () => {
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

  describe("shared databases, per thread", () => {
    const db = "/zed/threads.db";
    const t1 = rec({ provider: "zed", sourceFile: db, threadKey: "t1", timestamp: NOON });
    const t2 = rec({ provider: "zed", sourceFile: db, threadKey: "t2", timestamp: NOON + 1 });

    test("a thread deleted from a database that was still read is carried", () => {
      const j = new TodayJournal(home);
      j.reconcile([t1, t2], NOON + 5000);
      expect(j.reconcile([t2], NOON + 17000)).toEqual([t2, t1]);
    });

    test("the last thread touched today counts as deleted while older threads still read", () => {
      const j = new TodayJournal(home);
      const old = { ...t2, timestamp: NOON - 86_400_000 };
      j.reconcile([t1], NOON + 5000, [old]);
      expect(j.reconcile([], NOON + 17000, [old])).toEqual([t1]);
    });

    test("an unreadable database is not every thread deleted", () => {
      const j = new TodayJournal(home);
      j.reconcile([t1, t2], NOON + 5000);
      expect(j.reconcile([], NOON + 17000)).toEqual([]);
      // and when it reads again, nothing was carried to double up
      expect(j.reconcile([t1, t2], NOON + 29000)).toEqual([t1, t2]);
    });

    test("a running total carries its last value, and a returning thread is live", () => {
      const j = new TodayJournal(home);
      const grown = { ...t1, inputTokens: 5000, timestamp: NOON + 9000 };
      j.reconcile([t1, t2], NOON + 5000);
      j.reconcile([grown, t2], NOON + 17000);
      expect(j.reconcile([t2], NOON + 29000)).toEqual([t2, grown]);
      expect(j.reconcile([grown, t2], NOON + 41000)).toEqual([grown, t2]);
    });

    test("Cursor switching from its database to CSV exports doesn't double count", () => {
      const j = new TodayJournal(home);
      const bubble = rec({
        provider: "cursor",
        sourceFile: "/c/state.vscdb",
        threadKey: "bubbleId:c:b",
      });
      const csvRow = rec({ provider: "cursor", sourceFile: "/c/cache/usage.csv" });
      j.reconcile([bubble], NOON + 5000);
      expect(j.reconcile([csvRow], NOON + 17000)).toEqual([csvRow]);
      // and the CSVs going away isn't carried either
      expect(j.reconcile([bubble], NOON + 29000)).toEqual([bubble]);
    });
  });

  test("per-session files (Mux) carry like any file; Codex desktop never does", () => {
    const j = new TodayJournal(home);
    const desk = rec({ provider: "codex-desktop", sourceFile: "/codex/rollout-x.jsonl" });
    const mux = rec({ provider: "mux", sourceFile: "/mux/s1/session-usage.json" });
    j.reconcile([desk, mux], NOON + 5000);
    expect(j.reconcile([], NOON + 17000)).toEqual([mux]);
  });

  test("archived and then deleted is carried under both paths but counted once", () => {
    const j = new TodayJournal(home);
    j.reconcile([a1, a2, b1], NOON + 5000);
    const moved = [a1, a2].map((r) => ({
      ...r,
      sourceFile: "/archived/a.jsonl",
      project: "other",
    }));
    j.reconcile([...moved, b1], NOON + 17000);
    const after = j.reconcile([b1], NOON + 29000);
    expect(j.carriedFiles()).toHaveLength(2);
    expect(after).toHaveLength(3);
  });

  test("two providers reading one path are separate units", () => {
    const j = new TodayJournal(home);
    const path = "/codex/rollout-y.jsonl";
    const codex = rec({ sourceFile: path, apiCallId: "resp_y", inputTokens: 5000 });
    j.reconcile([codex], NOON + 5000);
    // rollout deleted; codex-desktop's fallback now emits a delta for that path
    const desk = rec({
      provider: "codex-desktop",
      sourceFile: path,
      inputTokens: 7,
      outputTokens: 0,
    });
    expect(sum(j.reconcile([desk], NOON + 17000))).toBe(5017);
  });

  test("an OpenCode session deleted from the database is carried", () => {
    const j = new TodayJournal(home);
    const db = "/oc/opencode.db";
    const m1 = rec({ provider: "opencode", sourceFile: db, apiCallId: "msg1", threadKey: "msg1" });
    const m2 = rec({
      provider: "opencode",
      sourceFile: db,
      apiCallId: "msg2",
      threadKey: "msg2",
      timestamp: NOON + 1,
    });
    j.reconcile([m1, m2], NOON + 5000);
    expect(j.reconcile([m2], NOON + 17000)).toEqual([m2, m1]);
  });

  test("OpenCode's JSON store (a file per message) carries as files", () => {
    const j = new TodayJournal(home);
    const m = rec({
      provider: "opencode",
      sourceFile: "/oc/storage/message/s/m1.json",
      apiCallId: "m1",
    });
    j.reconcile([m], NOON + 5000);
    expect(j.reconcile([], NOON + 17000)).toEqual([m]);
  });

  test("a thread deleted while its database was unreadable is still carried", () => {
    const j = new TodayJournal(home);
    const db = "/zed/threads.db";
    const t1 = rec({ provider: "zed", sourceFile: db, threadKey: "t1" });
    const t2 = rec({ provider: "zed", sourceFile: db, threadKey: "t2", timestamp: NOON + 1 });
    j.reconcile([t1, t2], NOON + 5000);
    j.reconcile([], NOON + 17000); // locked
    expect(j.reconcile([t2], NOON + 29000)).toEqual([t2, t1]);
  });

  test("a provider-filtered scan sees that provider's carried records, and changes nothing", () => {
    const j = new TodayJournal(home);
    const amp = rec({ provider: "amp", sourceFile: "/amp/t.jsonl", timestamp: NOON + 3 });
    j.reconcile([a1, amp, b1], NOON + 5000);
    j.reconcile([b1], NOON + 17000);
    expect(j.withCarriedFor([b1], ["codex"], NOON + 20000)).toEqual([b1, a1]);
    expect(j.withCarriedFor([], ["amp"], NOON + 20000)).toEqual([amp]);
    expect(j.carriedFiles()).toHaveLength(2);
  });

  test("processes sharing the journal don't wipe each other's carried units", () => {
    const daemon = new TodayJournal(home);
    const tracker = new TodayJournal(home);
    daemon.reconcile([a1, b1], NOON + 5000);
    tracker.reconcile([a1, b1], NOON + 5000);
    daemon.reconcile([b1], NOON + 17000); // daemon sees a deleted
    tracker.reconcile([a1], NOON + 17000); // tracker (stale view) sees b deleted
    const restarted = new TodayJournal(home);
    expect(restarted.reconcile([], NOON + 60000)).toHaveLength(2);
  });

  describe("a restart diffs against the saved snapshot", () => {
    test("a file deleted while the daemon was down is carried", () => {
      const fa = join(home, "a.jsonl");
      const fb = join(home, "b.jsonl");
      writeFileSync(fa, "x");
      writeFileSync(fb, "x");
      const ra = rec({ sourceFile: fa, apiCallId: "ra" });
      const rb = rec({ sourceFile: fb, apiCallId: "rb", timestamp: NOON + 1 });
      const j = new TodayJournal(home);
      j.reconcile([ra, rb], NOON);
      j.reconcile([ra, rb], NOON + 6 * 60_000); // snapshot saved
      rmSync(fa);
      const restarted = new TodayJournal(home);
      expect(restarted.reconcile([rb], NOON + 30 * 60_000)).toEqual([rb, ra]);
    });

    test("a file that still exists but emits differently after an upgrade is not carried", () => {
      const fa = join(home, "a.jsonl");
      writeFileSync(fa, "x");
      const ra = rec({ sourceFile: fa, apiCallId: "ra" });
      const j = new TodayJournal(home);
      j.reconcile([ra], NOON);
      j.reconcile([ra], NOON + 6 * 60_000);
      const restarted = new TodayJournal(home);
      expect(restarted.reconcile([], NOON + 30 * 60_000)).toEqual([]);
    });

    test("a one-shot process never writes the snapshot", () => {
      const j = new TodayJournal(home);
      j.reconcile([a1], NOON);
      expect(existsSync(join(home, ".cache/tokmeter/today/2026-10-20.json"))).toBe(false);
    });
  });

  test("carriedRecordsFor reads a past day: carried, plus snapshot files now gone", () => {
    const fa = join(home, "a.jsonl");
    writeFileSync(fa, "x");
    const ra = rec({ sourceFile: fa, apiCallId: "ra" });
    const j = new TodayJournal(home);
    j.reconcile([ra, b1], NOON);
    j.reconcile([ra, b1], NOON + 6 * 60_000);
    j.reconcile([ra], NOON + 7 * 60_000); // b deleted while running
    rmSync(fa); // a deleted after the daemon died
    const got = carriedRecordsFor(home, "2026-10-20");
    expect(got.map((r) => r.apiCallId).sort()).toEqual(["ra", "resp_b1"]);
  });
});

describe("TodayJournal: a file rewritten smaller in place", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-journal-shrunk-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // Distinct times, like real responses: identical records share a fingerprint.
  const c = (id: string, extra: Partial<TokenRecord> = {}) =>
    rec({
      provider: "claude-code",
      sourceFile: "/p/s.jsonl",
      apiCallId: id,
      timestamp: NOON + Number(id.replace(/\D/g, "")) * 1000,
      ...extra,
    });

  test("a response pruned from a transcript stays in today", () => {
    const j = new TodayJournal(home);
    j.reconcile([c("msg_1"), c("msg_2"), c("msg_3")], NOON + 5000);
    const after = j.reconcile([c("msg_1")], NOON + 17000);
    expect(after.map((r) => r.apiCallId).sort()).toEqual(["msg_1", "msg_2", "msg_3"]);
    expect(sum(after)).toBe(330);
  });

  test("it survives a restart once saved, and the file later vanishing", () => {
    const j = new TodayJournal(home);
    j.reconcile([c("msg_1"), c("msg_2")], NOON + 5000);
    j.reconcile([c("msg_1")], NOON + 17000);
    const restarted = new TodayJournal(home);
    expect(sum(restarted.reconcile([c("msg_1")], NOON + 60000))).toBe(220);
    expect(sum(restarted.reconcile([], NOON + 72000))).toBe(220);
  });

  test("a response that moved to another file (a Codex fork's winner) isn't gone", () => {
    const j = new TodayJournal(home);
    const x = rec({ sourceFile: "/codex/a.jsonl", apiCallId: "resp_x" });
    const y = rec({ sourceFile: "/codex/a.jsonl", apiCallId: "resp_y" });
    j.reconcile([x, y], NOON + 5000);
    const after = j.reconcile([x, { ...y, sourceFile: "/codex/b.jsonl" }], NOON + 17000);
    expect(after).toHaveLength(2);
  });

  test("a pruned response that comes back is counted once", () => {
    const j = new TodayJournal(home);
    j.reconcile([c("msg_1"), c("msg_2")], NOON + 5000);
    j.reconcile([c("msg_1")], NOON + 17000);
    const back = j.reconcile([c("msg_1"), c("msg_2", { outputTokens: 50 })], NOON + 29000);
    expect(back).toHaveLength(2);
    expect(sum(back)).toBe(260); // the live, grown copy; not the carried one too
    expect(j.carriedFiles()).toEqual([]);
  });

  test("positional ids (Cline) are not carried: a renumbered record isn't a lost one", () => {
    const j = new TodayJournal(home);
    const cl = (n: number, out: number) =>
      rec({ provider: "cline", sourceFile: "/cl/ui.json", apiCallId: `t#${n}`, outputTokens: out });
    j.reconcile([cl(0, 10), cl(1, 20), cl(2, 30)], NOON + 5000);
    // Message 1 deleted: what was #2 is now #1.
    const after = j.reconcile([cl(0, 10), cl(1, 30)], NOON + 17000);
    expect(after).toHaveLength(2);
  });

  test("a restart doesn't diff records against the snapshot (ids may have been renamed)", () => {
    const j = new TodayJournal(home);
    j.reconcile([c("msg_1"), c("msg_2")], NOON + 5000);
    // Force a seen snapshot to disk.
    j.reconcile([c("msg_1"), c("msg_2")], NOON + 6 * 60_000);
    const upgraded = new TodayJournal(home);
    const renamed = [c("new_1"), c("new_2")];
    expect(upgraded.reconcile(renamed, NOON + 7 * 60_000)).toHaveLength(2);
  });
});
