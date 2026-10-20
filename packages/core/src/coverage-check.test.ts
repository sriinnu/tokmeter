// Coverage check: files under an agent's folder that changed on the day,
// carry usage, and fed no record. The shapes here are the real ones that
// motivated it — Codex moving finished rollouts to ~/.codex/archived_sessions
// and compressing idle ones to .jsonl.zst, outside the parser's declared root.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  agentHome,
  findUnreadFiles,
  readCoverageReports,
  summarizeCoverage,
  writeCoverageReport,
} from "./coverage-check.js";
import type { ProviderId, SessionParser } from "./types.js";

const DAY = "2026-10-19";
const NOON = new Date(`${DAY}T12:00:00`);
const USAGE =
  '{"type":"event_msg","payload":{"info":{"last_token_usage":{"input_tokens":1200}}}}\n';

const parser = (providerId: string, roots: (h: string) => string[]): SessionParser =>
  ({
    providerId: providerId as ProviderId,
    scan: async () => [],
    sessionRoots: roots,
  }) as SessionParser;

describe("findUnreadFiles", () => {
  let home: string;
  const codex = () => parser("codex", (h) => [join(h, ".codex/sessions")]);
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-coverage-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function put(rel: string, body: string, when: Date = NOON): string {
    const path = join(home, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    utimesSync(path, when, when);
    return path;
  }
  const check = (readFiles: string[] = [], parsers = [codex()], extra = {}) =>
    findUnreadFiles({ homeDir: home, date: DAY, readFiles, parsers, ...extra });

  test("flags usage outside the parser's roots but inside the agent's folder", async () => {
    const archived = put(".codex/archived_sessions/rollout-a.jsonl", USAGE);
    const report = await check();
    expect(report.unread.map((f) => f.path)).toEqual([archived]);
    expect(report.unread[0]).toMatchObject({ kind: "usage", providers: ["codex"] });
    expect(report.homes).toEqual([join(home, ".codex")]);
  });

  test("a file that fed a record is not flagged, with or without a #row suffix", async () => {
    const a = put(".codex/sessions/a.jsonl", USAGE);
    const b = put(".codex/sessions/b.jsonl", USAGE);
    expect((await check([a, `${b}#42`])).unread).toEqual([]);
  });

  test("compressed rollouts are flagged without being read", async () => {
    put(".codex/sessions/2026/10/19/rollout-b.jsonl.zst", "(µ/ý binary");
    const report = await check();
    expect(report.unread).toHaveLength(1);
    expect(report.unread[0].kind).toBe("compressed");
  });

  test("token keys with null or zero values are not usage", async () => {
    put(".codex/receipts/r.jsonl", '{"cost":{"input_tokens":null,"output_tokens":0}}\n');
    expect((await check()).unread).toEqual([]);
  });

  test("only files changed on that day count", async () => {
    put(".codex/archived_sessions/old.jsonl", USAGE, new Date("2026-10-17T12:00:00"));
    put(".codex/archived_sessions/new.jsonl", USAGE, new Date("2026-10-20T12:00:00"));
    expect((await check()).unread).toEqual([]);
  });

  test("worktrees, node_modules, logs and databases are skipped", async () => {
    put(".codex/worktrees/repo/.tmp/t.jsonl", USAGE);
    put(".codex/node_modules/x/usage.json", USAGE);
    put(".codex/logs/run.jsonl", USAGE);
    put(".codex/state.sqlite", USAGE);
    put(".codex/task-preservation/t1/fixtures/usage.jsonl", USAGE);
    expect((await check()).unread).toEqual([]);
  });

  test("a git checkout inside the agent folder is code, not sessions", async () => {
    put(".codex/somewhere/repo/.git/HEAD", "ref: refs/heads/main\n");
    put(".codex/somewhere/repo/test/fixtures/rollout.jsonl", USAGE);
    expect((await check()).unread).toEqual([]);
  });

  test("a folder two agents share yields one finding naming both", async () => {
    put("Library/Application Support/Code/User/globalStorage/x/task.json", USAGE);
    const roo = parser("roo-code", (h) => [join(h, "Library/Application Support/Code/User")]);
    const kilo = parser("kilo", (h) => [
      join(h, "Library/Application Support/Code/User/globalStorage"),
    ]);
    const report = await check([], [roo, kilo]);
    expect(report.unread).toHaveLength(1);
    expect(report.unread[0].providers.sort()).toEqual(["kilo", "roo-code"]);
  });

  test("a spent time budget stops the walk and says so", async () => {
    put(".codex/archived_sessions/a.jsonl", USAGE);
    let t = 0;
    const report = await check([], [codex()], { budgetMs: 10, now: () => (t += 100) });
    expect(report.partial).toBe(true);
  });
});

describe("agentHome", () => {
  const h = "/Users/u";
  test.each([
    ["/Users/u/.codex/sessions", "/Users/u/.codex"],
    ["/Users/u/.claude/projects", "/Users/u/.claude"],
    [
      "/Users/u/Library/Application Support/Cursor/User/globalStorage",
      "/Users/u/Library/Application Support/Cursor",
    ],
    ["/Users/u/.config/Code/User", "/Users/u/.config/Code"],
    ["/Users/u/.local/share/opencode/opencode.db", "/Users/u/.local/share/opencode"],
    ["/opt/elsewhere/sessions", null],
    ["/Users/u/Library", null],
  ])("%s → %s", (root, expected) => {
    expect(agentHome(root, h)).toBe(expected);
  });
});

describe("reports", () => {
  test("summary names the count, the folders and the command", () => {
    const home = "/Users/u";
    const msg = summarizeCoverage(
      {
        date: DAY,
        checkedAt: 0,
        elapsedMs: 1,
        homes: [],
        partial: false,
        unread: [
          {
            path: `${home}/.codex/archived_sessions/a.jsonl`,
            bytes: 9,
            kind: "usage",
            providers: ["codex"],
          },
          {
            path: `${home}/.codex/archived_sessions/b.jsonl`,
            bytes: 9,
            kind: "usage",
            providers: ["codex"],
          },
        ],
      },
      home
    );
    expect(msg).toContain("2 session files");
    expect(msg).toContain("2 in ~/.codex/archived_sessions");
    expect(msg).toContain(`tokmeter coverage --date ${DAY}`);
  });

  test("nothing unread → no warning", () => {
    expect(
      summarizeCoverage(
        { date: DAY, checkedAt: 0, elapsedMs: 0, homes: [], partial: false, unread: [] },
        "/x"
      )
    ).toBeNull();
  });

  test("reports round-trip, newest first", async () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-coverage-store-"));
    try {
      for (const date of ["2026-10-17", "2026-10-19", "2026-10-18"]) {
        await writeCoverageReport(home, {
          date,
          checkedAt: 0,
          elapsedMs: 0,
          homes: [],
          unread: [],
          partial: false,
        });
      }
      expect((await readCoverageReports(home, 2)).map((r) => r.date)).toEqual([
        "2026-10-19",
        "2026-10-18",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
