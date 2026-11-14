import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURSOR_HOOK_COVERAGE_FILE,
  CURSOR_TURN_SEMANTICS,
  clearCursorTurnJournalCache,
  cursorTurnJournalDir,
  parseCursorHookCoverage,
  readCursorHookCoverage,
  readCursorTurnJournal,
} from "./cursor-turn-journal.js";

// Local midday, so the day file and the record's local date agree in any TZ.
const DAY = "2026-11-12";
const NOON = new Date(2026, 10, 12, 12, 0, 0).getTime();

let home: string;

function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, ...fields })}\n`;
}

function turn(gen: string, conv: string, tokens: [number, number, number, number], extra = {}) {
  return line({
    ts: NOON,
    conversation_id: conv,
    generation_id: gen,
    model: "claude-4.5-sonnet",
    status: "completed",
    input_tokens: tokens[0],
    output_tokens: tokens[1],
    cache_read_tokens: tokens[2],
    cache_write_tokens: tokens[3],
    workspace_root: "/Users/someone/work/alpha",
    ...extra,
  });
}

function writeDay(day: string, content: string) {
  const dir = cursorTurnJournalDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.jsonl`), content);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokmeter-cursor-journal-"));
  clearCursorTurnJournalCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("readCursorTurnJournal", () => {
  it("returns nothing when there is no journal", async () => {
    const r = await readCursorTurnJournal(home);
    expect(r.records).toEqual([]);
    expect(r.files).toBe(0);
  });

  it("maps a turn to a direct-provenance cursor record", async () => {
    writeDay(DAY, turn("gen-1", "conv-1", [120, 40, 9000, 300]));
    const { records } = await readCursorTurnJournal(home);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r).toMatchObject({
      provider: "cursor",
      model: "claude-4.5-sonnet",
      timestamp: NOON,
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 9000,
      cacheWriteTokens: 300,
      reasoningTokens: 0,
      apiCallId: "gen-1",
      threadKey: "cursor-turn:gen-1",
      cwd: "/Users/someone/work/alpha",
    });
    expect(r.project).toContain("alpha");
    expect(r.usage).toMatchObject({
      source: "agent_hook",
      inputTokens: "direct",
      outputTokens: "direct",
      cacheReadTokens: "direct",
      cacheWriteTokens: "direct",
      reasoningTokens: "not_exposed",
    });
  });

  it("maps Cursor's Auto model (default) to cursor-auto", async () => {
    writeDay(
      DAY,
      turn("gen-1", "c", [1, 1, 0, 0], { model: "default" }) +
        turn("gen-2", "d", [2, 1, 0, 0], { model: "Auto" })
    );
    const { records } = await readCursorTurnJournal(home);
    expect(records.map((r) => r.model)).toEqual(["cursor-auto", "cursor-auto"]);
  });

  it("counts one generation_id once, keeping the max per bucket", async () => {
    writeDay(
      DAY,
      turn("gen-1", "conv-1", [100, 10, 500, 0]) + turn("gen-1", "conv-1", [90, 30, 500, 7])
    );
    const r = await readCursorTurnJournal(home);
    expect(r.records).toHaveLength(1);
    expect(r.sameGenerationMerged).toBe(1);
    expect(r.records[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 500,
      cacheWriteTokens: 7,
    });
  });

  it("drops a re-report: same conversation, identical tuple, new generation_id", async () => {
    writeDay(
      DAY,
      turn("gen-1", "conv-1", [100, 10, 500, 0]) +
        // Another window's turn in between doesn't break the match.
        turn("gen-x", "conv-2", [5, 5, 5, 5]) +
        turn("random-fallback", "conv-1", [100, 10, 500, 0])
    );
    const r = await readCursorTurnJournal(home);
    expect(r.reReportsDropped).toBe(1);
    expect(r.records.map((x) => x.apiCallId)).toEqual(["gen-1", "gen-x"]);
  });

  it("keeps an identical tuple more than 10 s later: a real second turn, not a re-report", async () => {
    writeDay(
      DAY,
      turn("gen-1", "conv-1", [100, 10, 500, 0]) +
        turn("gen-2", "conv-1", [100, 10, 500, 0], { ts: NOON + 60_000 }) +
        // Within 10 s of the line before it: a re-fired stop, dropped.
        turn("random-fallback", "conv-1", [100, 10, 500, 0], { ts: NOON + 65_000 })
    );
    const r = await readCursorTurnJournal(home);
    expect(r.records.map((x) => x.apiCallId)).toEqual(["gen-1", "gen-2"]);
    expect(r.reReportsDropped).toBe(1);
  });

  it("keeps an identical tuple in a different conversation", async () => {
    writeDay(
      DAY,
      turn("gen-1", "conv-1", [100, 10, 500, 0]) + turn("gen-2", "conv-2", [100, 10, 500, 0])
    );
    const r = await readCursorTurnJournal(home);
    expect(r.records).toHaveLength(2);
    expect(r.reReportsDropped).toBe(0);
  });

  it("keeps an equal tuple after a no-usage turn (a new generation started)", async () => {
    writeDay(
      DAY,
      turn("gen-1", "conv-1", [100, 10, 500, 0]) +
        line({ ts: NOON, conversation_id: "conv-1", generation_id: "gen-2", status: "error" }) +
        turn("gen-3", "conv-1", [100, 10, 500, 0])
    );
    const r = await readCursorTurnJournal(home);
    expect(r.records).toHaveLength(2);
    expect(r.turnsWithoutUsage).toBe(1);
  });

  it("skips lines without tokens but reports how many, by status", async () => {
    writeDay(
      DAY,
      turn("gen-1", "conv-1", [1, 2, 3, 4]) +
        line({ ts: NOON, conversation_id: "conv-1", generation_id: "gen-2", status: "error" }) +
        line({ ts: NOON, conversation_id: "conv-1", generation_id: "gen-3", status: "aborted" }) +
        line({
          ts: NOON,
          conversation_id: "c",
          generation_id: "g",
          status: "completed",
          input_tokens: 0,
        })
    );
    const r = await readCursorTurnJournal(home);
    expect(r.records).toHaveLength(1);
    expect(r.turnsWithoutUsage).toBe(3);
    expect(r.turnsWithoutUsageByStatus).toEqual({ error: 1, aborted: 1, completed: 1 });
  });

  it("counts malformed and unknown-schema lines without failing", async () => {
    writeDay(
      DAY,
      "not json\n" +
        `${JSON.stringify({ v: 99, ts: NOON, input_tokens: 5 })}\n` +
        `${JSON.stringify({ v: 1, input_tokens: 5 })}\n` +
        turn("gen-1", "conv-1", [1, 1, 1, 1])
    );
    const r = await readCursorTurnJournal(home);
    expect(r.records).toHaveLength(1);
    expect(r.malformedLines).toBe(2);
    expect(r.unknownSchemaLines).toBe(1);
  });

  it("reads only the appended tail of a growing file, without double counting", async () => {
    writeDay(DAY, turn("gen-1", "conv-1", [1, 1, 1, 1]));
    expect((await readCursorTurnJournal(home)).records).toHaveLength(1);
    appendFileSync(
      join(cursorTurnJournalDir(home), `${DAY}.jsonl`),
      turn("gen-2", "conv-1", [2, 2, 2, 2])
    );
    const second = await readCursorTurnJournal(home);
    expect(second.records.map((r) => r.apiCallId)).toEqual(["gen-1", "gen-2"]);
    // Unchanged file: same answer.
    expect((await readCursorTurnJournal(home)).records).toHaveLength(2);
  });

  it("leaves an unterminated, unparseable tail for the next read", async () => {
    const full = turn("gen-2", "conv-1", [2, 2, 2, 2]);
    writeDay(DAY, turn("gen-1", "conv-1", [1, 1, 1, 1]) + full.slice(0, 20));
    expect((await readCursorTurnJournal(home)).records).toHaveLength(1);
    appendFileSync(join(cursorTurnJournalDir(home), `${DAY}.jsonl`), full.slice(20));
    expect((await readCursorTurnJournal(home)).records).toHaveLength(2);
  });

  it("filters by time window and ignores other files", async () => {
    const nextNoon = new Date(2026, 10, 13, 12).getTime();
    writeDay(DAY, turn("gen-1", "conv-1", [1, 1, 1, 1]));
    writeDay("2026-11-13", turn("gen-2", "conv-1", [2, 2, 2, 2], { ts: nextNoon }));
    writeFileSync(join(cursorTurnJournalDir(home), "notes.txt"), "x");
    const r = await readCursorTurnJournal(home, { sinceMs: new Date(2026, 10, 13).getTime() });
    expect(r.records.map((x) => x.apiCallId)).toEqual(["gen-2"]);
  });
});

describe("journal read errors", () => {
  it("treats a missing journal as empty, but throws on an unreadable one", async () => {
    expect((await readCursorTurnJournal(home)).records).toEqual([]);
    // The journal dir is a file: ENOTDIR, not ENOENT.
    mkdirSync(join(home, ".tokmeter"), { recursive: true });
    writeFileSync(cursorTurnJournalDir(home), "not a directory");
    await expect(readCursorTurnJournal(home)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("throws when a day file can't be read", async () => {
    // A directory where a day file should be: EISDIR.
    mkdirSync(join(cursorTurnJournalDir(home), `${DAY}.jsonl`), { recursive: true });
    await expect(readCursorTurnJournal(home)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("treats a missing ledger as never installed, but throws on an unreadable one", async () => {
    expect(await readCursorHookCoverage(home)).toEqual([]);
    mkdirSync(join(cursorTurnJournalDir(home), CURSOR_HOOK_COVERAGE_FILE), { recursive: true });
    await expect(readCursorHookCoverage(home)).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("coverage ledger order", () => {
  const ledger = (events: Array<[string, number]>) =>
    events.map(([event, ts]) => JSON.stringify({ v: 1, event, ts })).join("\n");

  it("reads events in append order and clamps a backdated one to the event before it", () => {
    // Installed, uninstalled, then a reinstall whose clock stepped back.
    // Sorted by ts, the reinstall would land inside the first span and be
    // ignored, so the hook would look uninstalled from 3000 on.
    expect(
      parseCursorHookCoverage(
        ledger([
          ["installed", 1000],
          ["uninstalled", 3000],
          ["installed", 2000],
        ])
      )
    ).toEqual([
      { start: 1000, end: 3000 },
      { start: 3000, end: Number.POSITIVE_INFINITY },
    ]);
  });

  it("never lets a backdated uninstall make a span run backwards", () => {
    expect(
      parseCursorHookCoverage(
        ledger([
          ["installed", 5000],
          ["uninstalled", 4000],
        ])
      )
    ).toEqual([{ start: 5000, end: 5000 }]);
  });
});

describe("CURSOR_TURN_SEMANTICS", () => {
  it("is unverified: the hook runs in shadow mode until a live turn is checked", () => {
    expect(CURSOR_TURN_SEMANTICS.verified).toBe(false);
  });
});
