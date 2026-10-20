import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { localDateKey } from "../date-utils.js";
import { type Buckets, type CumulativeBaselines, dayDelta } from "./cumulative-baselines.js";
import { MuxParser } from "./mux.js";

const b = (input: number, output = 0): Buckets => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

describe("dayDelta", () => {
  test("a thread first seen on the day it was created counts in full", () => {
    const store: CumulativeBaselines = {};
    const changed = { value: false };
    expect(dayDelta(store, "k", "2026-10-20", b(100, 5), "2026-10-20", changed)).toEqual(b(100, 5));
    expect(changed.value).toBe(true);
  });

  test("a total that resets mid-day keeps what was counted and adds new growth", () => {
    const store: CumulativeBaselines = {};
    const c = { value: false };
    dayDelta(store, "k", "2026-10-20", b(100), "2026-10-20", c);
    expect(dayDelta(store, "k", "2026-10-20", b(40), "2026-10-20", c)).toEqual(b(100));
    expect(dayDelta(store, "k", "2026-10-20", b(50), "2026-10-20", c)).toEqual(b(110));
    // the next day starts from the reset run's total
    expect(dayDelta(store, "k", "2026-10-21", b(70), "2026-10-20", c)).toEqual(b(20));
  });

  test("a clock that went backwards never re-emits an earlier day", () => {
    const store: CumulativeBaselines = {};
    const c = { value: false };
    dayDelta(store, "k", "2026-10-20", b(100), "2026-10-20", c);
    expect(dayDelta(store, "k", "2026-10-19", b(150), "2026-10-20", c)).toBeNull();
  });

  test("nothing changes and nothing is written when the total didn't move", () => {
    const store: CumulativeBaselines = {};
    dayDelta(store, "k", "2026-10-20", b(100), undefined, { value: false });
    const c = { value: false };
    expect(dayDelta(store, "k", "2026-10-20", b(100), undefined, c)).toBeNull();
    expect(c.value).toBe(false);
  });
});

describe("MuxParser running totals", () => {
  let home: string;
  let file: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mux-parser-test-"));
    const dir = join(home, ".mux", "sessions", "ws1");
    mkdirSync(dir, { recursive: true });
    file = join(dir, "session-usage.json");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const write = (timestamp: string, input: number) =>
    writeFileSync(
      file,
      JSON.stringify({ timestamp, byModel: { "anthropic:claude-x": { input } } })
    );

  test("a session started today counts in full; a later day counts only its growth", async () => {
    // The file was just created, so its birth time is today.
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const parser = new MuxParser();

    write(today.toISOString(), 1000);
    const [first] = await parser.scan(home);
    expect(first?.inputTokens).toBe(1000);
    expect(first?.model).toBe("claude-x");
    expect(localDateKey(first!.timestamp)).toBe(localDateKey(today.getTime()));

    write(today.toISOString(), 1500);
    expect((await parser.scan(home))[0]?.inputTokens).toBe(1500);

    write(tomorrow.toISOString(), 1800);
    expect((await parser.scan(home))[0]?.inputTokens).toBe(300);
  });

  test("an old session seen for the first time counts nothing until it grows", async () => {
    write("2026-01-05T12:00:00", 9000); // file born today, last touched months ago
    expect(await new MuxParser().scan(home)).toEqual([]);
  });
});
