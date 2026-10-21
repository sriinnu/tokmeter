// Plan quota. The Codex shapes are the real ones on disk in October 2026: a
// weekly window only (window_minutes 10080, secondary null), resets_at
// jittering by a second between readings, parallel threads reporting a
// snapshot 1% stale, and a fresh window opening before the old one reset.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  claudeCodeQuota,
  codexQuotaFromLine,
  getQuota,
  type QuotaSample,
  quotaWindows,
  readCodexQuota,
  readQuotaStore,
  recordQuotaSamples,
} from "./quota.js";

const RESET = Date.parse("2026-10-27T08:12:01Z") / 1000;
const WEEK = 10080;

function codexLine(ts: string, usedPct: number, resetsAt = RESET): string {
  return JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 10 } },
      rate_limits: {
        limit_id: "codex",
        limit_name: null,
        primary: { used_percent: usedPct, window_minutes: WEEK, resets_at: resetsAt },
        secondary: null,
        credits: { has_credits: true, unlimited: false, balance: "5805.3307665000" },
        individual_limit: null,
        spend_control_reached: null,
        plan_type: "pro",
        rate_limit_reached_type: null,
      },
    },
  });
}

const sample = (at: string, usedPct: number, extra: Partial<QuotaSample> = {}): QuotaSample => ({
  agent: "codex",
  windowMinutes: WEEK,
  usedPct,
  resetsAt: RESET,
  at: Date.parse(at),
  ...extra,
});

describe("codexQuotaFromLine", () => {
  test("reads the weekly window, plan and credits", () => {
    expect(codexQuotaFromLine(codexLine("2026-10-21T13:17:13.197Z", 61))).toEqual([
      {
        agent: "codex",
        windowMinutes: WEEK,
        usedPct: 61,
        resetsAt: RESET,
        at: Date.parse("2026-10-21T13:17:13.197Z"),
        plan: "pro",
        creditsBalance: 5805.3307665,
      },
    ]);
  });

  test("ignores lines without rate limits and other event types", () => {
    expect(codexQuotaFromLine('{"type":"event_msg","payload":{"type":"token_count"}}')).toEqual([]);
    expect(
      codexQuotaFromLine('{"type":"response_item","payload":{"rate_limits":{"primary":{}}}}')
    ).toEqual([]);
    expect(codexQuotaFromLine('{"rate_limits": broken')).toEqual([]);
  });
});

describe("quotaWindows", () => {
  const now = Date.parse("2026-10-21T14:00:00Z");

  test("a 1%-stale reading from a parallel thread never lowers the window", () => {
    const [w] = quotaWindows(
      [sample("2026-10-21T13:32:42Z", 62), sample("2026-10-21T13:33:38Z", 61)],
      now
    );
    expect(w?.usedPct).toBe(62);
  });

  test("resets_at a second apart is the same window", () => {
    const ws = quotaWindows(
      [
        sample("2026-10-21T10:00:00Z", 50),
        sample("2026-10-21T13:00:00Z", 60, { resetsAt: RESET + 1 }),
      ],
      now
    );
    expect(ws).toHaveLength(1);
    expect(ws[0]?.usedPct).toBe(60);
  });

  test("a window opened early replaces the old one", () => {
    const old = Date.parse("2026-10-22T07:38:45Z") / 1000;
    const ws = quotaWindows(
      [sample("2026-10-15T19:05:35Z", 100, { resetsAt: old }), sample("2026-10-21T13:00:00Z", 20)],
      now
    );
    expect(ws).toHaveLength(1);
    expect(ws[0]?.resetsAt).toBe(RESET);
  });

  test("average pace runs from the window start; hits the limit before the reset", () => {
    // Window opened 10-20 08:12:01; 60% by 10-21 08:12:01 is 2.5%/h,
    // so the remaining 40% lasts 16h, well before the 10-27 reset.
    const [w] = quotaWindows([sample("2026-10-21T08:12:01Z", 60)], now);
    expect(w?.windowStart).toBe(RESET - WEEK * 60);
    expect(w?.avgPctPerHour).toBeCloseTo(2.5);
    expect(w?.recentPctPerHour).toBeNull();
    expect(w?.verdict).toBe("hits-limit");
    expect(w?.hitsLimitAt).toBe(Date.parse("2026-10-22T00:12:01Z") / 1000);
  });

  test("the recent pace wins over the average when there is one", () => {
    // 10% in the last 5h is 2%/h, against an average of 60% in 29h (2.07%/h).
    // The 40% left lasts 20h at the recent pace.
    const [w] = quotaWindows(
      [sample("2026-10-21T08:12:01Z", 50), sample("2026-10-21T13:12:01Z", 60)],
      now
    );
    expect(w?.recentPctPerHour).toBeCloseTo(2);
    expect(w?.hitsLimitAt).toBe(Date.parse("2026-10-22T09:12:01Z") / 1000);
  });

  test("a slow pace resets first", () => {
    const [w] = quotaWindows([sample("2026-10-25T08:12:01Z", 10)], now);
    expect(w?.verdict).toBe("resets-first");
    expect(w?.hitsLimitAt).toBeNull();
  });

  test("at the limit, and expired once the reset has passed", () => {
    expect(quotaWindows([sample("2026-10-21T13:00:00Z", 100)], now)[0]?.verdict).toBe("at-limit");
    const after = (RESET + 60) * 1000;
    expect(quotaWindows([sample("2026-10-21T13:00:00Z", 40)], after)[0]?.verdict).toBe("expired");
  });
});

describe("claudeCodeQuota", () => {
  test("maps the statusline's 5h and 7d windows; skips what's missing", () => {
    const at = Date.parse("2026-10-21T12:00:00Z");
    const out = claudeCodeQuota(
      { five_hour: { used_percentage: 12, resets_at: 1793000000 }, seven_day: {} },
      at
    );
    expect(out).toEqual([
      { agent: "claude-code", windowMinutes: 300, usedPct: 12, resetsAt: 1793000000, at },
    ]);
    expect(claudeCodeQuota(undefined, at)).toEqual([]);
  });
});

describe("store and Codex reading", () => {
  let home: string;
  const savedCodexHome = process.env.CODEX_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-quota-"));
    delete process.env.CODEX_HOME;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedCodexHome !== undefined) process.env.CODEX_HOME = savedCodexHome;
  });

  test("records only what is new: a new window or a higher used %", () => {
    recordQuotaSamples(home, [sample("2026-10-21T10:00:00Z", 50)]);
    recordQuotaSamples(home, [
      sample("2026-10-21T10:05:00Z", 50),
      sample("2026-10-21T10:06:00Z", 49),
      sample("2026-10-21T11:00:00Z", 55),
    ]);
    expect(readQuotaStore(home, "codex").map((s) => s.usedPct)).toEqual([50, 55]);
  });

  test("reads the newest rollouts this week, live and archived, and records them", async () => {
    const now = Date.parse("2026-10-21T14:00:00");
    const day = join(home, ".codex/sessions/2026/10/21");
    const archived = join(home, ".codex/archived_sessions");
    mkdirSync(day, { recursive: true });
    mkdirSync(archived, { recursive: true });
    const live = join(day, "rollout-2026-10-21T09-00-00-aaa.jsonl");
    writeFileSync(
      live,
      `${codexLine("2026-10-21T09:00:00Z", 40)}\n${codexLine("2026-10-21T12:00:00Z", 58)}\n`
    );
    // Archived this morning, started two days ago: found by its name's date.
    const arch = join(archived, "rollout-2026-10-19T09-00-00-bbb.jsonl");
    writeFileSync(arch, `${codexLine("2026-10-21T12:30:00Z", 59)}\n`);
    // Older than the week: never read.
    const stale = join(archived, "rollout-2026-10-01T09-00-00-ccc.jsonl");
    writeFileSync(stale, `${codexLine("2026-10-21T13:00:00Z", 99)}\n`);
    for (const f of [live, arch, stale]) utimesSync(f, now / 1000, now / 1000);

    const read = await readCodexQuota(home, now);
    expect(read.map((s) => s.usedPct).sort()).toEqual([40, 58, 59]);

    const [w] = await getQuota(home, now);
    expect(w?.usedPct).toBe(59);
    expect(w?.recentPctPerHour).toBeCloseTo(19 / 3.5);
    expect(readQuotaStore(home, "codex").map((s) => s.usedPct)).toEqual([40, 58, 59]);
  });
});
