/**
 * Antigravity 2.x conversation databases (~/.gemini/antigravity{,-cli}/
 * conversations/<cascade>.db). Fixtures are built at the wire level with the
 * shapes found in real files (2026-11-17): a retried generation with two
 * calls, a 64-bit -1 varint, nested doubles, a generation with no start
 * time, a "-default" model alias, and a WAL database with an empty -wal
 * (what macOS SQLite leaves). Ids, paths and text are made up.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDateKey } from "../date-utils.js";
import { execSql } from "../test-sqlite.js";
import { AntigravityParser } from "./antigravity.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "antigravity-conv-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// ─── Wire-format writer ─────────────────────────────────────────────

function varint(value: number | bigint): Buffer {
  let v = BigInt(value);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return Buffer.from(out);
}
const tag = (n: number, w: number) => varint((n << 3) | w);
const vf = (n: number, v: number | bigint) => Buffer.concat([tag(n, 0), varint(v)]);
const bf = (n: number, b: Buffer | string) => {
  const buf = typeof b === "string" ? Buffer.from(b) : b;
  return Buffer.concat([tag(n, 2), varint(buf.length), buf]);
};
const f64 = (n: number, x: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(x);
  return Buffer.concat([tag(n, 1), b]);
};
const msg = (...parts: Buffer[]) => Buffer.concat(parts);
const stamp = (ms: number) => msg(vf(1, Math.floor(ms / 1000)), vf(2, (ms % 1000) * 1e6));
const kv = (k: string, v: string) => bf(20, msg(bf(1, k), bf(2, v)));

interface Usage {
  input: number;
  thinking: number;
  response: number;
  cacheRead?: number;
  id?: string;
}

function usage(u: Usage): Buffer {
  return msg(
    vf(1, 1016),
    vf(2, u.input),
    vf(3, u.thinking + u.response),
    ...(u.cacheRead ? [vf(5, u.cacheRead)] : []),
    vf(6, 24),
    vf(9, u.thinking),
    vf(10, u.response),
    ...(u.id ? [bf(11, u.id)] : [])
  );
}

function generation(opts: {
  calls: Usage[];
  startMs?: number;
  modelId?: string;
  display?: string;
  modelEnum?: string;
  lastStep: number;
  noCalls?: boolean;
}): Buffer {
  const sum: Usage = {
    input: opts.calls.reduce((a, c) => a + c.input, 0),
    thinking: opts.calls.reduce((a, c) => a + c.thinking, 0),
    response: opts.calls.reduce((a, c) => a + c.response, 0),
    cacheRead: opts.calls.reduce((a, c) => a + (c.cacheRead ?? 0), 0),
    id: opts.calls[0]?.id,
  };
  const timing = msg(
    vf(2, 18446744073709551615n),
    ...(opts.startMs ? [bf(4, stamp(opts.startMs))] : [])
  );
  const gen = msg(
    vf(3, 1016),
    bf(4, usage(sum)),
    bf(9, timing),
    // Sampling settings, with doubles (wire type 1), as real rows carry.
    bf(15, msg(vf(1, 1), f64(5, 1), f64(6, 0.4), bf(9, "<|user|>"))),
    ...(opts.noCalls
      ? []
      : opts.calls.map((c, i) =>
          bf(
            17,
            msg(
              bf(2, usage(c)),
              ...(i === 0 && opts.calls.length > 1 ? [bf(3, "model output error")] : [])
            )
          )
        )),
    ...(opts.modelId ? [bf(19, opts.modelId)] : []),
    ...(opts.modelEnum ? [kv("model_enum", opts.modelEnum)] : []),
    kv("last_step_index", String(opts.lastStep)),
    ...(opts.display ? [bf(21, opts.display)] : [])
  );
  return msg(bf(2, ""), bf(4, "exec-1"), bf(1, gen));
}

const hex = (b: Buffer) => `X'${b.toString("hex")}'`;

function seedConversation(
  cascade: string,
  gens: Buffer[],
  steps: { idx: number; ms: number }[],
  opts: { app?: string; workspace?: string } = {}
): string {
  const dir = join(home, ".gemini", opts.app ?? "antigravity", "conversations");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, `${cascade}.db`);
  const blob = msg(bf(7, opts.workspace ?? "file:///work/demo-app"));
  const sql = [
    "PRAGMA journal_mode=WAL;",
    "CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, metadata blob);",
    "CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer);",
    "CREATE TABLE trajectory_metadata_blob (id text PRIMARY KEY, data blob);",
    ...steps.map(
      (s) =>
        `INSERT INTO steps VALUES (${s.idx}, 15, ${hex(msg(bf(1, stamp(s.ms)), bf(12, "exec-1")))});`
    ),
    ...gens.map((g, i) => `INSERT INTO gen_metadata VALUES (${i}, ${hex(g)}, ${g.length});`),
    `INSERT INTO trajectory_metadata_blob VALUES ('main', ${hex(blob)});`,
  ].join("\n");
  execSql(dbPath, sql);
  // As Antigravity leaves a conversation once it's closed: no -shm, no -wal.
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  return dbPath;
}

const T0 = new Date(2026, 10, 17, 12, 0, 0).getTime();

describe("Antigravity conversation databases", () => {
  it("counts every call of a retried generation once, by response id", async () => {
    seedConversation(
      "cascade-a",
      [
        generation({
          startMs: T0,
          lastStep: 0,
          modelId: "gemini-pro-default",
          display: "Gemini 3.1 Pro (High)",
          modelEnum: "M16",
          calls: [
            { input: 2879, thinking: 504, response: 58, cacheRead: 77569, id: "resp-1" },
            { input: 3050, thinking: 322, response: 55, cacheRead: 77560, id: "resp-2" },
          ],
        }),
      ],
      [{ idx: 0, ms: T0 }]
    );

    const records = await new AntigravityParser().scan(home);
    expect(records).toHaveLength(2);
    const [a, b] = records.sort((x, y) => (x.apiCallId! < y.apiCallId! ? -1 : 1));
    expect(a).toMatchObject({
      provider: "antigravity",
      model: "gemini-3.1-pro",
      inputTokens: 2879,
      outputTokens: 58,
      reasoningTokens: 504,
      cacheReadTokens: 77569,
      cacheWriteTokens: 0,
      apiCallId: "resp-1",
      timestamp: T0,
    });
    expect(a.project).toContain("demo-app");
    expect(b.apiCallId).toBe("resp-2");
    // Thinking and response are separate buckets: their sum is the call's output.
    const out = records.reduce((s, r) => s + r.outputTokens + r.reasoningTokens, 0);
    expect(out).toBe(504 + 58 + 322 + 55);
    expect(a.usage?.inputTokens).toBe("direct");
    // Never written by Antigravity, so not claimed as measured.
    expect(a.usage?.cacheWriteTokens).toBe("not_exposed");
  });

  it("dates a generation with no start time by its last step", async () => {
    seedConversation(
      "cascade-b",
      [
        generation({
          lastStep: 3,
          modelId: "gemini-3.8-flash",
          calls: [{ input: 10, thinking: 0, response: 5, id: "r" }],
        }),
      ],
      [
        { idx: 0, ms: T0 - 86_400_000 },
        { idx: 3, ms: T0 },
      ]
    );
    const [r] = await new AntigravityParser().scan(home);
    expect(r.timestamp).toBe(T0);
    expect(r.timestampInferred).toBeUndefined();
    expect(localDateKey(r.timestamp)).toBe(localDateKey(T0));
  });

  it("names an alias-only row from its model enum in another conversation, even in a today scan", async () => {
    // The real shape: 398 calls carried only "gemini-pro-default" + M16, and
    // only other conversations named M16 "Gemini 3.1 Pro (High)".
    const named = seedConversation(
      "cascade-c1",
      [
        generation({
          startMs: T0 - 5 * 86_400_000,
          lastStep: 0,
          modelId: "gemini-pro-default",
          display: "Gemini 3.1 Pro (High)",
          modelEnum: "M16",
          calls: [{ input: 1, thinking: 0, response: 1, id: "c1" }],
        }),
      ],
      [{ idx: 0, ms: T0 - 5 * 86_400_000 }]
    );
    utimesSync(named, new Date(T0 - 5 * 86_400_000), new Date(T0 - 5 * 86_400_000));
    seedConversation(
      "cascade-c2",
      [
        generation({
          startMs: T0,
          lastStep: 0,
          modelId: "gemini-pro-default",
          modelEnum: "M16",
          calls: [{ input: 1, thinking: 0, response: 1, id: "c2" }],
        }),
      ],
      [{ idx: 0, ms: T0 }]
    );
    const today = await new AntigravityParser().scan(home, { modifiedSinceMs: T0 - 86_400_000 });
    expect(today.map((r) => r.model)).toEqual(["gemini-3.1-pro"]);
    const everything = await new AntigravityParser().scan(home);
    expect(everything.map((r) => r.model).sort()).toEqual(["gemini-3.1-pro", "gemini-3.1-pro"]);
  });

  it("prefers the id an enum carries elsewhere over a slug of the display name", async () => {
    seedConversation(
      "cascade-h1",
      [
        generation({
          startMs: T0,
          lastStep: 0,
          modelId: "claude-sonnet-4-6",
          modelEnum: "M35",
          calls: [{ input: 1, thinking: 0, response: 1, id: "h1" }],
        }),
      ],
      [{ idx: 0, ms: T0 }]
    );
    seedConversation(
      "cascade-h2",
      [
        generation({
          startMs: T0,
          lastStep: 0,
          display: "Claude Sonnet 4.6 (Thinking)",
          modelEnum: "M35",
          calls: [{ input: 1, thinking: 0, response: 1, id: "h2" }],
        }),
      ],
      [{ idx: 0, ms: T0 }]
    );
    const records = await new AntigravityParser().scan(home);
    expect(records.map((r) => r.model)).toEqual(["claude-sonnet-4-6", "claude-sonnet-4-6"]);
  });

  it("skips a call with no recorded time and says so, instead of guessing a date", async () => {
    seedConversation(
      "cascade-u",
      [
        generation({
          lastStep: 9,
          modelId: "gemini-3.8-flash",
          calls: [{ input: 10, thinking: 0, response: 5, id: "u" }],
        }),
      ],
      [{ idx: 0, ms: T0 }]
    );
    const notices: string[] = [];
    const warnings: string[] = [];
    const records = await new AntigravityParser().scan(home, {
      onNotice: (m) => notices.push(m),
      onWarning: (m) => warnings.push(m),
    });
    expect(records).toHaveLength(0);
    expect(notices.join("\n")).toContain("no time recorded");
    expect(warnings).toEqual([]);
  });

  it("leaves no -shm or -wal beside a closed conversation", async () => {
    const db = seedConversation(
      "cascade-s",
      [
        generation({
          startMs: T0,
          lastStep: 0,
          calls: [{ input: 1, thinking: 0, response: 1, id: "s" }],
        }),
      ],
      [{ idx: 0, ms: T0 }]
    );
    expect(await new AntigravityParser().scan(home)).toHaveLength(1);
    expect(existsSync(`${db}-shm`)).toBe(false);
    expect(existsSync(`${db}-wal`)).toBe(false);
  });

  it("reports an opened-but-not-continued conversation as inactive that day", async () => {
    // The real shape: a conversation last used on 09-23, opened on 11-11.
    // Its file changed on 11-11 but no step was added.
    const day = new Date(2026, 10, 11).getTime();
    const db = seedConversation(
      "cascade-o",
      [
        generation({
          startMs: day - 49 * 86_400_000,
          lastStep: 0,
          calls: [{ input: 1, thinking: 0, response: 1, id: "o1" }],
        }),
      ],
      [{ idx: 0, ms: day - 49 * 86_400_000 }]
    );
    const parser = new AntigravityParser();
    expect(await parser.databaseActiveBetween(db, day, day + 86_400_000)).toBe(false);
    expect(await parser.databaseActiveBetween(db, day - 49 * 86_400_000 - 3600_000, day)).toBe(
      true
    );
  });

  it("falls back to the generation total when no per-call entries exist", async () => {
    seedConversation(
      "cascade-d",
      [
        generation({
          startMs: T0,
          lastStep: 0,
          modelId: "claude-sonnet-4-6",
          noCalls: true,
          calls: [{ input: 100, thinking: 20, response: 30, cacheRead: 400, id: "tot" }],
        }),
      ],
      [{ idx: 0, ms: T0 }]
    );
    const records = await new AntigravityParser().scan(home);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 20,
      cacheReadTokens: 400,
    });
  });

  it("reads the CLI's folder and keeps one record for a response id seen twice", async () => {
    const call = { input: 7, thinking: 1, response: 2, id: "shared-id" };
    seedConversation(
      "cascade-e",
      [generation({ startMs: T0, lastStep: 0, calls: [call] })],
      [{ idx: 0, ms: T0 }]
    );
    seedConversation(
      "cascade-f",
      [generation({ startMs: T0, lastStep: 0, calls: [call] })],
      [{ idx: 0, ms: T0 }],
      {
        app: "antigravity-cli",
      }
    );
    const records = await new AntigravityParser().scan(home);
    expect(records).toHaveLength(1);
  });

  it("skips databases older than modifiedSinceMs and lists them as usage databases", async () => {
    const old = seedConversation(
      "cascade-old",
      [
        generation({
          startMs: T0,
          lastStep: 0,
          calls: [{ input: 1, thinking: 0, response: 1, id: "o" }],
        }),
      ],
      [{ idx: 0, ms: T0 }]
    );
    utimesSync(old, new Date(T0 - 3 * 86_400_000), new Date(T0 - 3 * 86_400_000));
    const parser = new AntigravityParser();
    expect(await parser.scan(home, { modifiedSinceMs: T0 - 86_400_000 })).toHaveLength(0);
    expect(await parser.scan(home)).toHaveLength(1);
    expect(parser.usageDatabases(home)).toEqual([old]);
  });

  it("drops the empty summary record of a session that has a conversation database", async () => {
    seedConversation(
      "cascade-g",
      [
        generation({
          startMs: T0,
          lastStep: 0,
          calls: [{ input: 5, thinking: 0, response: 5, id: "g" }],
        }),
      ],
      [{ idx: 0, ms: T0 }]
    );
    // state.vscdb summary entry for the same cascade, plus one without a database.
    const entry = (id: string) => {
      const summary = msg(bf(1, "title"), bf(3, vf(1, Math.floor(T0 / 1000))));
      const wrapped = bf(1, Buffer.from(summary.toString("base64")));
      return bf(1, msg(bf(1, id), bf(2, wrapped)));
    };
    const value = msg(entry("cascade-g"), entry("cascade-none")).toString("base64");
    const dir = join(
      home,
      "Library",
      "Application Support",
      "Antigravity",
      "User",
      "globalStorage"
    );
    mkdirSync(dir, { recursive: true });
    execSql(
      join(dir, "state.vscdb"),
      `CREATE TABLE ItemTable (key TEXT UNIQUE, value TEXT);
INSERT INTO ItemTable VALUES ('antigravityUnifiedStateSync.trajectorySummaries', '${value}');`
    );
    const records = await new AntigravityParser().scan(home);
    expect(records).toHaveLength(2);
    const summary = records.find((r) => r.inputTokens === 0);
    expect(summary?.usage?.inputTokens).toBe("not_exposed");
    expect(records.find((r) => r.apiCallId === "g")?.inputTokens).toBe(5);
  });

  it("persists enum-name mappings across cache clears without changing model resolution", async () => {
    const { clearAntigravityCaches } = await import("./antigravity-conversations.js");
    const oldDb = seedConversation(
      "cascade-persist-1",
      [
        generation({
          startMs: T0 - 5 * 86_400_000,
          lastStep: 0,
          modelId: "gemini-pro-default",
          display: "Gemini 3.1 Pro (High)",
          modelEnum: "M99",
          calls: [{ input: 1, thinking: 0, response: 1, id: "p1" }],
        }),
      ],
      [{ idx: 0, ms: T0 - 5 * 86_400_000 }]
    );
    utimesSync(oldDb, new Date(T0 - 5 * 86_400_000), new Date(T0 - 5 * 86_400_000));
    seedConversation(
      "cascade-persist-2",
      [
        generation({
          startMs: T0,
          lastStep: 0,
          modelId: "gemini-pro-default",
          modelEnum: "M99",
          calls: [{ input: 2, thinking: 0, response: 2, id: "p2" }],
        }),
      ],
      [{ idx: 0, ms: T0 }]
    );

    const first = await new AntigravityParser().scan(home, { modifiedSinceMs: T0 - 86_400_000 });
    expect(first.map((r) => r.model)).toEqual(["gemini-3.1-pro"]);
    expect(existsSync(join(home, ".cache", "tokmeter", "antigravity-enum-names.json"))).toBe(true);

    clearAntigravityCaches();
    const second = await new AntigravityParser().scan(home, { modifiedSinceMs: T0 - 86_400_000 });
    expect(second.map((r) => r.model)).toEqual(["gemini-3.1-pro"]);
  });
});
