import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { TokmeterCore as Core } from "./tokmeter-core.js";

// The real path through TokmeterCore: sessions deleted between daemon ticks
// must not take their tokens out of the day they ran in.
//
// The record cache resolves its directory from HOME when parsers/utils loads,
// so HOME is pointed at a scratch dir BEFORE the core is imported; otherwise
// these runs would write into the real ~/.cache/tokmeter.
const realHome = process.env.HOME;
const scratchHome = mkdtempSync(join(tmpdir(), "tokmeter-grow-only-cache-"));
let TokmeterCore: typeof Core;
let writeDayFile: typeof import("./aggregates-store.js").writeDayFile;
let readDayFile: typeof import("./aggregates-store.js").readDayFile;

beforeAll(async () => {
  process.env.HOME = scratchHome;
  ({ TokmeterCore } = await import("./tokmeter-core.js"));
  ({ writeDayFile, readDayFile } = await import("./aggregates-store.js"));
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(scratchHome, { recursive: true, force: true });
});

let home: string;
let dir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokmeter-grow-only-"));
  dir = join(home, ".claude", "projects", "-tmp-app");
  mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

function session(name: string, id: string, ts: number, out: number): string {
  const file = join(dir, name);
  const line = {
    type: "assistant",
    uuid: `u-${id}`,
    requestId: `req_${id}`,
    timestamp: new Date(ts).toISOString(),
    message: {
      id: `msg_${id}`,
      model: "claude-x",
      usage: {
        input_tokens: 10,
        output_tokens: out,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text" }],
    },
  };
  writeFileSync(file, `${JSON.stringify(line)}\n`);
  utimesSync(file, new Date(ts), new Date(ts));
  return file;
}

// Local-time literals: vitest and bun test run in different timezones.
const at = (s: string) => new Date(s).getTime();

describe("grow-only today", () => {
  test("deleting a session file keeps its tokens in today, across a restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-20T12:00:00"));
    session("kept.jsonl", "K", at("2026-10-20T11:00:00"), 100);
    const doomed = session("doomed.jsonl", "D", at("2026-10-20T11:00:01"), 5000);

    const core = new TokmeterCore({ homeDir: home, skipPricing: true });
    await core.scan();
    expect(core.getTodayAggregate()?.totalTokens).toBe(5120);

    unlinkSync(doomed);
    await core.refreshToday(at("2026-10-20T12:00:12"));
    expect(core.getTodayAggregate()?.totalTokens).toBe(5120);

    const restarted = new TokmeterCore({ homeDir: home, skipPricing: true });
    await restarted.scan();
    expect(restarted.getTodayAggregate()?.totalTokens).toBe(5120);
  });

  test("a deletion the daemon saw survives the daemon being down at midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-20T12:00:00"));
    // An older sealed day, so the next morning's cold start gap-fills 10-20
    // instead of rebuilding everything.
    writeDayFile(home, {
      date: "2026-10-17",
      cost: 0,
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 1,
      recordCount: 1,
      firstUsed: at("2026-10-17T12:00:00"),
      lastUsed: at("2026-10-17T12:00:00"),
      models: {},
      projects: {},
      providers: {},
      costByHour: new Array(24).fill(0),
    } as never);
    session("kept.jsonl", "K", at("2026-10-20T11:00:00"), 100);
    const doomed = session("doomed.jsonl", "D", at("2026-10-20T11:00:01"), 5000);

    const daemon = new TokmeterCore({ homeDir: home, skipPricing: true });
    await daemon.scan();
    unlinkSync(doomed);
    await daemon.refreshToday(at("2026-10-20T12:00:12"));
    // The daemon exits here and isn't back until the next morning.

    vi.setSystemTime(at("2026-10-21T09:00:00"));
    const morning = new TokmeterCore({ homeDir: home, skipPricing: true });
    await morning.scan();
    const sealed = morning.getDailyAggregates().find((d) => d.date === "2026-10-20");
    expect(sealed?.totalTokens).toBe(5120);
  });

  test("a full rebuild (empty relay) folds in what was deleted before the seal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-20T12:00:00"));
    session("kept.jsonl", "K", at("2026-10-20T11:00:00"), 100);
    const doomed = session("doomed.jsonl", "D", at("2026-10-20T11:00:01"), 5000);

    const daemon = new TokmeterCore({ homeDir: home, skipPricing: true });
    await daemon.scan();
    unlinkSync(doomed);
    await daemon.refreshToday(at("2026-10-20T12:00:12"));

    // No sealed day anywhere: the next cold start rebuilds history from raw.
    vi.setSystemTime(at("2026-10-21T09:00:00"));
    const morning = new TokmeterCore({ homeDir: home, skipPricing: true });
    await morning.scan();
    const sealed = morning.getDailyAggregates().find((d) => d.date === "2026-10-20");
    expect(sealed?.totalTokens).toBe(5120);
  });

  test("a provider-filtered scan just before midnight doesn't shrink the sealed day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-20T23:50:00"));
    session("s.jsonl", "S", at("2026-10-20T23:40:00"), 700);

    const daemon = new TokmeterCore({ homeDir: home, skipPricing: true });
    await daemon.scan();
    vi.setSystemTime(at("2026-10-20T23:58:00"));
    await daemon.scan({ providers: ["codex"] }); // e.g. a `--codex` view
    vi.setSystemTime(at("2026-10-21T00:00:12"));
    await daemon.refreshToday(at("2026-10-21T00:00:12"));
    const sealed = daemon.getDailyAggregates().find((d) => d.date === "2026-10-20");
    expect(sealed?.totalTokens).toBe(710);
  });

  test("a partial midnight read defers sealing until an authoritative retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-20T23:50:00"));
    const path = session("s.jsonl", "S", at("2026-10-20T23:40:00"), 700);
    const daemon = new TokmeterCore({ homeDir: home, skipPricing: true });
    await daemon.scan();

    const late = session("late-source.jsonl", "L", at("2026-10-20T23:59:00"), 90);
    const lateLine = readFileSync(late, "utf8");
    unlinkSync(late);
    const split = Math.floor(lateLine.length / 2);
    appendFileSync(path, lateLine.slice(0, split));

    vi.setSystemTime(at("2026-10-21T00:00:12"));
    await daemon.refreshToday(at("2026-10-21T00:00:12"));
    // Held: nothing reaches the immutable relay, and today runs live meanwhile.
    expect(readDayFile(home, "2026-10-20")).toBeNull();
    expect(daemon.getTodayAggregate()?.date).toBe("2026-10-21");

    appendFileSync(path, lateLine.slice(split));
    await daemon.refreshToday(at("2026-10-21T00:00:24"));
    const sealed = daemon.getDailyAggregates().find((day) => day.date === "2026-10-20");
    expect(sealed?.totalTokens).toBe(810);
    expect(readDayFile(home, "2026-10-20")?.totalTokens).toBe(810);
  });

  test("a provider-filtered midnight scan defers sealing until a full retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-20T23:50:00"));
    session("early.jsonl", "EARLY", at("2026-10-20T23:40:00"), 700);
    const daemon = new TokmeterCore({ homeDir: home, skipPricing: true });
    await daemon.scan();
    const late = session("late.jsonl", "LATE", at("2026-10-20T23:59:00"), 90);

    vi.setSystemTime(at("2026-10-21T00:00:12"));
    await daemon.scan({ today: true, providers: ["codex"] });
    // Held: nothing reaches the immutable relay, and today runs live meanwhile.
    expect(readDayFile(home, "2026-10-20")).toBeNull();
    expect(daemon.getTodayAggregate()?.date).toBe("2026-10-21");

    utimesSync(late, new Date(at("2026-10-21T00:00:20")), new Date(at("2026-10-21T00:00:20")));
    await daemon.refreshToday(at("2026-10-21T00:00:24"));
    const sealed = daemon.getDailyAggregates().find((day) => day.date === "2026-10-20");
    expect(sealed?.totalTokens).toBe(810);
    expect(readDayFile(home, "2026-10-20")?.totalTokens).toBe(810);
  });
});
