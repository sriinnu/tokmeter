/**
 * Cursor parser tests.
 *
 * Two independent sources, each pinned separately:
 *  - CSV cache (~/.config/tokscale/cursor-cache/*.csv) — the original,
 *    external-sync-dependent path.
 *  - Local SQLite (`cursorDiskKV` in Cursor's own state.vscdb) — read
 *    directly, no external tool. A conversation ("composer") is split into
 *    requests: each user bubble (`type` 1, carrying `modelInfo` and the
 *    `requestId`) opens one, and the bubbles after it in createdAt order
 *    belong to it. At most one of those carries `tokenCount`, with no
 *    `modelInfo` and a `requestId` of its own that matches no user bubble.
 *    These fixtures copy that shape (Cursor 3.11.13), not its data.
 *
 * The CSV-wins-if-present rule (scanCsvCache runs first, scanLocalDatabase
 * only runs if it found nothing) exists so a user with both sources set up
 * doesn't get every request counted twice — pinned by the last test below.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSql } from "../test-sqlite.js";
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
  /** 1 = user message, 2 = assistant or tool step (Cursor's own values). */
  type?: 1 | 2;
  createdAt?: string;
  requestId?: string;
  usageUuid?: string;
  inputTokens?: number;
  outputTokens?: number;
  modelName?: string;
  workspaceUri?: string;
}

/** A user bubble: the model and requestId live here, never a count. */
function user(
  composerId: string,
  bubbleId: string,
  createdAt: string,
  modelName: string,
  extra: Partial<BubbleFixture> = {}
): BubbleFixture {
  return {
    composerId,
    bubbleId,
    type: 1,
    createdAt,
    modelName,
    requestId: `req-${bubbleId}`,
    ...extra,
  };
}

/** The one assistant bubble per request that carries a count: no modelInfo. */
function counted(
  composerId: string,
  bubbleId: string,
  createdAt: string,
  inputTokens: number,
  outputTokens: number
): BubbleFixture {
  return {
    composerId,
    bubbleId,
    type: 2,
    createdAt,
    inputTokens,
    outputTokens,
    // Its own requestId, which matches no user bubble's.
    requestId: `unrelated-${bubbleId}`,
    usageUuid: `usage-${bubbleId}`,
  };
}

/** A tool/assistant step with a zero placeholder count. */
function step(composerId: string, bubbleId: string, createdAt: string): BubbleFixture {
  return { composerId, bubbleId, type: 2, createdAt, inputTokens: 0, outputTokens: 0 };
}

function seedLocalDb(
  bubbles: BubbleFixture[],
  /** composerId → bubbleIds in `fullConversationHeadersOnly` order. */
  headers: Record<string, string[]> = {}
): void {
  const dbDir = join(tmpDir, "Library", "Application Support", "Cursor", "User", "globalStorage");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "state.vscdb");

  const statements = [
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
  ];
  const insert = (key: string, value: string) =>
    statements.push(
      `INSERT INTO cursorDiskKV (key, value) VALUES ('${key}', '${value.replace(/'/g, "''")}');`
    );

  for (const b of bubbles) {
    insert(
      `bubbleId:${b.composerId}:${b.bubbleId}`,
      JSON.stringify({
        type: b.type,
        createdAt: b.createdAt ?? "2026-06-01T12:00:00.000Z",
        requestId: b.requestId,
        usageUuid: b.usageUuid,
        tokenCount:
          b.inputTokens !== undefined || b.outputTokens !== undefined
            ? { inputTokens: b.inputTokens ?? 0, outputTokens: b.outputTokens ?? 0 }
            : undefined,
        modelInfo: b.modelName ? { modelName: b.modelName } : undefined,
        workspaceUris: b.workspaceUri ? [b.workspaceUri] : undefined,
      })
    );
  }
  for (const [composerId, ids] of Object.entries(headers)) {
    insert(
      `composerData:${composerId}`,
      JSON.stringify({
        fullConversationHeadersOnly: ids.map((bubbleId, i) => ({
          bubbleId,
          type: i === 0 ? 1 : 2,
        })),
      })
    );
  }
  execSql(dbPath, statements.join("\n"));
}

const at = (seconds: number) => new Date(Date.UTC(2026, 5, 1, 12, 0, seconds)).toISOString();

async function scanWithNotices(parser = new CursorParser()) {
  const notices: string[] = [];
  const warnings: string[] = [];
  const records = await parser.scan(tmpDir, {
    onNotice: (m) => notices.push(m),
    onWarning: (m) => warnings.push(m),
  });
  return { records, notices, warnings };
}

describe("CursorParser — local SQLite (cursorDiskKV)", () => {
  it("resolves model and project from the request's user bubble, not the counted bubble", async () => {
    seedLocalDb([
      user("c1", "b1", at(0), "claude-4.5-opus-high-thinking", {
        workspaceUri: "file:///Users/sriinnu/Sriinnu/AI/medha-grid.ai",
      }),
      counted("c1", "b2", at(5), 47521, 4551),
    ]);

    const records = await new CursorParser().scan(tmpDir);
    expect(records.length).toBe(1);
    const r = records[0];
    expect(r.model).toBe("claude-4.5-opus-high-thinking");
    expect(r.project).toContain("medha-grid.ai");
    expect(r.inputTokens).toBe(47521);
    expect(r.outputTokens).toBe(4551);
    expect(r.timestamp).toBe(Date.parse(at(5)));
    expect(r.usage?.source).toBe("tool_sqlite");
  });

  it("gives each request the model its user bubble names when a composer switches models", async () => {
    // Composers switch models mid-conversation. The old parser stamped every
    // record with the first model seen in the composer.
    seedLocalDb([
      user("c1", "u1", at(0), "claude-4.5-opus-high-thinking"),
      step("c1", "s1", at(1)),
      counted("c1", "t1", at(2), 30000, 900),
      user("c1", "u2", at(10), "gpt-5.2-xhigh"),
      counted("c1", "t2", at(12), 41000, 1200),
      user("c1", "u3", at(20), "claude-4.5-opus-high-thinking"),
      step("c1", "s3", at(21)),
      counted("c1", "t3", at(22), 52000, 300),
    ]);

    const records = (await new CursorParser().scan(tmpDir)).sort(
      (a, b) => a.timestamp - b.timestamp
    );
    expect(records.map((r) => r.model)).toEqual([
      "claude-4.5-opus-high-thinking",
      "gpt-5.2-xhigh",
      "claude-4.5-opus-high-thinking",
    ]);
    expect(records.map((r) => r.outputTokens)).toEqual([900, 1200, 300]);
  });

  it("joins the count to its request by order, since the counted bubble has no modelInfo", async () => {
    seedLocalDb([user("c1", "u1", at(0), "gpt-5.2-xhigh"), counted("c1", "t1", at(3), 12000, 450)]);

    const [r] = await new CursorParser().scan(tmpDir);
    expect(r.model).toBe("gpt-5.2-xhigh");
    // The user bubble's requestId (what a Cursor hook's generation_id is
    // expected to equal), not the counted bubble's unrelated one.
    expect(r.apiCallId).toBe("req-u1");
    expect(r.threadKey).toBe("bubbleId:c1:t1");
    // inputTokens is a context-window snapshot, not billed input.
    expect(r.usage?.inputTokens).toBe("estimated");
    expect(r.usage?.outputTokens).toBe("direct");
    expect(r.usage?.cacheReadTokens).toBe("not_exposed");
    expect(r.usage?.cacheWriteTokens).toBe("not_exposed");
    expect(r.usage?.reasoningTokens).toBe("not_exposed");
    expect(r.usage?.notes?.some((n) => n.includes("context size"))).toBe(true);
  });

  it("maps Cursor's Auto mode ('default') to cursor-auto", async () => {
    seedLocalDb([user("c1", "u1", at(0), "default"), counted("c1", "t1", at(2), 9000, 100)]);

    const [r] = await new CursorParser().scan(tmpDir);
    expect(r.model).toBe("cursor-auto");
  });

  it("reports requests with no count as a notice, never a warning, on every scan", async () => {
    seedLocalDb([
      user("c1", "u1", at(0), "gpt-5.2-xhigh"),
      counted("c1", "t1", at(2), 9000, 100),
      // A request whose bubbles never got a count.
      user("c1", "u2", at(10), "gpt-5.2-xhigh"),
      step("c1", "s2", at(11)),
      user("c2", "u3", at(20), "default"),
      counted("c2", "t3", at(22), 7000, 50),
    ]);

    const parser = new CursorParser();
    const first = await scanWithNotices(parser);
    expect(first.records.length).toBe(2);
    expect(first.notices).toEqual(["1 of 3 requests has no token count in Cursor's local data"]);
    expect(first.warnings).toEqual([]);

    // Cache hit: the database didn't change, the notice is still said.
    const second = await scanWithNotices(parser);
    expect(second.records.length).toBe(2);
    expect(second.notices).toEqual(first.notices);
  });

  it("breaks a createdAt tie by the composer's header order, not key order", async () => {
    // The user bubble and the counted bubble share a millisecond. By key the
    // counted bubble ("a-…") sorts first and would land in the previous
    // request; the header list says the user bubble came first.
    seedLocalDb(
      [
        user("c1", "u1", at(0), "claude-4.5-opus-high-thinking"),
        counted("c1", "t1", at(2), 20000, 700),
        user("c1", "z-user", at(10), "gpt-5.2-xhigh"),
        counted("c1", "a-count", at(10), 25000, 800),
      ],
      { c1: ["u1", "t1", "z-user", "a-count"] }
    );

    const { records, notices } = await scanWithNotices();
    const byOutput = new Map(records.map((r) => [r.outputTokens, r]));
    expect(records.length).toBe(2);
    expect(byOutput.get(700)?.model).toBe("claude-4.5-opus-high-thinking");
    expect(byOutput.get(800)?.model).toBe("gpt-5.2-xhigh");
    expect(byOutput.get(800)?.apiCallId).toBe("req-z-user");
    expect(notices).toEqual([]);
  });

  it("emits one record per counted bubble, named by the request's user bubble", async () => {
    // Two counted bubbles in one request are two responses. Folding them to
    // the max per bucket would have dropped 1000 input and 10 output.
    seedLocalDb([
      user("c1", "u1", at(0), "gpt-5.2-xhigh", { workspaceUri: "file:///work/alpha" }),
      counted("c1", "t1", at(2), 1000, 10),
      step("c1", "s1", at(3)),
      counted("c1", "t2", at(4), 3000, 30),
    ]);

    const { records, notices } = await scanWithNotices();
    const sorted = records.sort((a, b) => a.timestamp - b.timestamp);
    expect(sorted.map((r) => [r.inputTokens, r.outputTokens])).toEqual([
      [1000, 10],
      [3000, 30],
    ]);
    expect(sorted.map((r) => r.threadKey)).toEqual(["bubbleId:c1:t1", "bubbleId:c1:t2"]);
    expect(sorted.map((r) => r.timestamp)).toEqual([Date.parse(at(2)), Date.parse(at(4))]);
    for (const r of sorted) {
      expect(r.model).toBe("gpt-5.2-xhigh");
      expect(r.apiCallId).toBe("req-u1");
      expect(r.project).toContain("alpha");
    }
    expect(notices).toEqual([]);
  });

  it("gives a composer with no user bubble one 'unknown' record per counted bubble", async () => {
    seedLocalDb([
      {
        composerId: "c9",
        bubbleId: "b1",
        type: 2,
        createdAt: at(1),
        inputTokens: 100,
        outputTokens: 20,
      },
      {
        composerId: "c9",
        bubbleId: "b2",
        type: 2,
        createdAt: at(2),
        inputTokens: 300,
        outputTokens: 40,
      },
    ]);

    const records = (await new CursorParser().scan(tmpDir)).sort(
      (a, b) => a.timestamp - b.timestamp
    );
    expect(records.map((r) => [r.model, r.inputTokens, r.outputTokens])).toEqual([
      ["unknown", 100, 20],
      ["unknown", 300, 40],
    ]);
    expect(records.every((r) => r.apiCallId === undefined)).toBe(true);
  });

  it("skips bubbles with zero tokens instead of emitting empty records", async () => {
    seedLocalDb([user("c2", "b1", at(0), "gpt-5.2-xhigh"), step("c2", "b2", at(1))]);

    const records = await new CursorParser().scan(tmpDir);
    expect(records.length).toBe(0);
  });

  it("falls back to 'unknown' model and generic project when a composer never carries either", async () => {
    seedLocalDb([
      { composerId: "c3", bubbleId: "b1", type: 2, inputTokens: 100, outputTokens: 20 },
    ]);

    const records = await new CursorParser().scan(tmpDir);
    expect(records[0].model).toBe("unknown");
    expect(records[0].project).toBe("cursor");
  });

  it("keeps composers' token bubbles independent — no cross-composer bleed", async () => {
    seedLocalDb([
      user("a", "u", at(0), "model-a"),
      counted("a", "t", at(1), 10, 1),
      user("b", "u", at(0), "model-b"),
      counted("b", "t", at(1), 20, 2),
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
    seedLocalDb([user("c1", "u1", at(0), "m"), counted("c1", "t1", at(1), 10, 5)]);

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
    seedLocalDb([user("c1", "u1", at(0), "claude-opus"), counted("c1", "t1", at(1), 99999, 99999)]);

    const records = await new CursorParser().scan(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].model).toBe("gpt-5");
    expect(records[0].usage?.cost).toBe("direct");
  });
});

describe("CursorParser — stop-hook turns own the time the hook was installed", () => {
  // The ledger split runs only once the hook's numbers are verified; these
  // tests pin that path by flipping the flag.
  const verified = () => new CursorParser({ hookVerified: true });

  const t = (seconds: number) => Date.UTC(2026, 5, 1, 12, 0, seconds);
  const journalDir = () => join(tmpDir, ".tokmeter", "cursor-turns");
  function ledger(events: Array<["installed" | "uninstalled", number]>): void {
    mkdirSync(journalDir(), { recursive: true });
    writeFileSync(
      join(journalDir(), "coverage.jsonl"),
      `${events.map(([event, ts]) => JSON.stringify({ v: 1, event, ts })).join("\n")}\n`
    );
  }
  function turn(ts: number, gen: string, input: number, extra: Record<string, unknown> = {}) {
    const day = new Date(ts);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const line = JSON.stringify({
      v: 1,
      ts,
      conversation_id: "conv-1",
      generation_id: gen,
      model: "claude-opus",
      status: "completed",
      loop_count: 0,
      input_tokens: input,
      output_tokens: 50,
      cache_read_tokens: 9000,
      cache_write_tokens: 300,
      ...extra,
    });
    mkdirSync(journalDir(), { recursive: true });
    writeFileSync(join(journalDir(), `${key}.jsonl`), `${line}\n`, { flag: "a" });
  }

  it("uses the database's counts when the hook was never installed", async () => {
    seedLocalDb([user("c1", "u1", at(0), "gpt-5"), counted("c1", "t1", at(1), 1000, 10)]);
    turn(t(30), "g1", 500); // a stray journal line, no ledger
    const { records } = await scanWithNotices(verified());
    expect(records.map((r) => r.inputTokens)).toEqual([1000]);
  });

  it("splits by the install ledger: database before, hook turns after, never both", async () => {
    seedLocalDb([
      user("c1", "u1", at(0), "gpt-5"),
      counted("c1", "t1", at(1), 1000, 10),
      user("c1", "u2", at(20), "gpt-5"),
      counted("c1", "t2", at(21), 2000, 20),
    ]);
    ledger([["installed", t(10)]]);
    turn(t(22), "req-u2", 700);
    const { records, notices } = await scanWithNotices(verified());
    expect(records.map((r) => [r.inputTokens, r.usage?.source])).toEqual([
      [1000, "tool_sqlite"],
      [700, "agent_hook"],
    ]);
    expect(records[1].cacheReadTokens).toBe(9000);
    expect(notices.some((n) => n.includes("1 local request count fell while the stop hook"))).toBe(
      true
    );
  });

  it("goes back to the database after an uninstall, and ignores hook lines outside the ledger", async () => {
    seedLocalDb([user("c1", "u3", at(40), "gpt-5"), counted("c1", "t3", at(41), 3000, 30)]);
    ledger([
      ["installed", t(10)],
      ["uninstalled", t(30)],
    ]);
    turn(t(20), "g-in", 700);
    turn(t(42), "g-out", 800); // written after uninstall: not trusted
    const { records, notices } = await scanWithNotices(verified());
    expect(records.map((r) => r.inputTokens).sort((a, b) => a - b)).toEqual([700, 3000]);
    expect(notices.some((n) => n.includes("fell outside the hook's install ledger"))).toBe(true);
  });

  it("gives a record the same source on every scan, so the daemon never sees one vanish", async () => {
    seedLocalDb([user("c1", "u1", at(0), "gpt-5"), counted("c1", "t1", at(15), 1000, 10)]);
    ledger([["installed", t(10)]]);
    const parser = verified();
    const before = await parser.scan(tmpDir);
    turn(t(16), "req-u1", 700); // the hook's line lands a moment later
    const after = await parser.scan(tmpDir);
    expect(before).toHaveLength(0);
    expect(after.map((r) => r.inputTokens)).toEqual([700]);
  });
});

describe("CursorParser — shadow mode (hook numbers not verified yet)", () => {
  const t = (seconds: number) => Date.UTC(2026, 5, 1, 12, 0, seconds);
  const journalDir = () => join(tmpDir, ".tokmeter", "cursor-turns");

  it("is the default: database counts only, ledger ignored, hook turns only reported", async () => {
    seedLocalDb([
      user("c1", "u1", at(0), "gpt-5"),
      counted("c1", "t1", at(1), 1000, 10),
      user("c1", "u2", at(20), "gpt-5"),
      counted("c1", "t2", at(21), 2000, 20),
    ]);
    mkdirSync(journalDir(), { recursive: true });
    writeFileSync(
      join(journalDir(), "coverage.jsonl"),
      `${JSON.stringify({ v: 1, event: "installed", ts: t(10) })}\n`
    );
    const day = new Date(t(22));
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    writeFileSync(
      join(journalDir(), `${key}.jsonl`),
      `${JSON.stringify({ v: 1, ts: t(22), conversation_id: "k", generation_id: "req-u2", model: "gpt-5", status: "completed", input_tokens: 700, output_tokens: 50, cache_read_tokens: 9000, cache_write_tokens: 300 })}\n` +
        `${JSON.stringify({ v: 1, ts: t(23), conversation_id: "k", generation_id: "g2", status: "error" })}\n`
    );

    const { records, notices, warnings } = await scanWithNotices();
    expect(records.map((r) => [r.inputTokens, r.usage?.source])).toEqual([
      [1000, "tool_sqlite"],
      [2000, "tool_sqlite"],
    ]);
    expect(notices).toEqual([
      "Cursor hook recorded 2 turns (1 with usage); not counted until its numbers are verified.",
    ]);
    expect(warnings).toEqual([]);
  });

  it("doesn't fail the scan when the ledger or journal can't be read", async () => {
    seedLocalDb([user("c1", "u1", at(0), "gpt-5"), counted("c1", "t1", at(1), 1000, 10)]);
    // A directory where the ledger should be.
    mkdirSync(join(journalDir(), "coverage.jsonl"), { recursive: true });
    const { records } = await scanWithNotices();
    expect(records.map((r) => r.inputTokens)).toEqual([1000]);
  });
});
