import type { ScanOptions, TokenRecord } from "@sriinnu/tokmeter";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ scans: vi.fn(), logs: [] as string[] }));

// Keep the real source query implementation; replace only scan input/state.
// No source/session paths, provider requests, or daemon reads are used.
vi.mock("@sriinnu/tokmeter", async () => {
  const source = await import("../../" + "core/src/index.ts");
  const { aggregateRecordsByDay } = await import("../../" + "core/src/aggregates.ts");
  const records: TokenRecord[] = [
    {
      timestamp: new Date(2026, 7, 1, 12).getTime(),
      project: "old",
      provider: "claude-code",
      inputTokens: 100,
    },
    {
      timestamp: new Date(2026, 8, 7, 12).getTime(),
      project: "app",
      provider: "codex",
      inputTokens: 20,
    },
    {
      timestamp: new Date(2026, 8, 7, 13).getTime(),
      project: "other",
      provider: "claude-code",
      inputTokens: 40,
    },
  ].map((record) => ({
    model: "fixture-model",
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    ...record,
  })) as TokenRecord[];
  return {
    ...source,
    TokmeterCore: class extends source.TokmeterCore {
      constructor() {
        super({ skipPricing: true });
        Object.assign(this, {
          aliases: {},
          recentRecords: [],
          aggregates: new Map(
            aggregateRecordsByDay(records).map((day: { date: string }) => [day.date, day])
          ),
        });
      }
      async scan(options: ScanOptions) {
        state.scans(options);
        return [];
      }
    },
  };
});

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 8, 12) });
  state.scans.mockClear();
  state.logs.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("convenience helpers", () => {
  test("filters each projection while retaining sealed history", async () => {
    const api = await import("./index.js");
    expect((await api.loadTokmeterSummary({ week: true, light: true })).stats.totalTokens).toBe(60);
    expect(
      (await api.loadTokmeterStats({ month: true, providers: ["codex"], light: true })).totalTokens
    ).toBe(20);
    expect(
      (await api.loadTokmeterProjects({ project: "app", light: true })).map((p) => p.project)
    ).toEqual(["app"]);
    expect(
      (await api.loadTokmeterModels({ providers: ["codex"], light: true })).map((m) => m.provider)
    ).toEqual(["codex"]);
    expect(
      (await api.loadTokmeterDailyBreakdown({ week: true, project: "app", light: true })).map(
        (d) => d.totalTokens
      )
    ).toEqual([20]);
    expect((await api.loadTokmeterStats({ light: true })).totalTokens).toBe(160);
    expect(
      state.scans.mock.calls.every(
        ([options]) => !options.week && !options.since && !options.providers
      )
    ).toBe(true);
  });

  test("rejects intraday report requests before scanning", async () => {
    const api = await import("./index.js");
    await expect(
      api.loadTokmeterSummary({ since: "2026-09-07T12:00:00Z", light: true })
    ).rejects.toThrow("YYYY-MM-DD");
    expect(state.scans).not.toHaveBeenCalled();
  });
});

describe("actual CLI argument and JSON dispatch", () => {
  test("rejects --year 0 before the daemon fast path or scanning", async () => {
    vi.useRealTimers();
    vi.resetModules();
    const originalArgv = process.argv;
    const rejectionHandlers = process.listeners("unhandledRejection");
    const exceptionHandlers = process.listeners("uncaughtException");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled"));
    try {
      process.argv = [process.execPath, "tokmeter", "stats", "--year", "0", "--json", "--light"];
      await import("./cli.js");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(error).toHaveBeenCalledWith("Error:", "year must be a four-digit calendar year.");
      expect(network).not.toHaveBeenCalled();
      expect(state.scans).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      for (const handler of process.listeners("unhandledRejection"))
        if (!rejectionHandlers.includes(handler))
          process.removeListener("unhandledRejection", handler);
      for (const handler of process.listeners("uncaughtException"))
        if (!exceptionHandlers.includes(handler))
          process.removeListener("uncaughtException", handler);
    }
  });

  test.each([
    [["--week"], "summary", 60],
    [["--project", "app", "--codex"], "summary", 20],
    [["stats", "--month", "--codex"], "stats", 20],
    [["daily", "--week", "--codex"], "array", 20],
    [["models", "--week", "--codex"], "array", 20],
    [["projects", "--week", "--project", "app"], "array", 20],
    [["--project", "absent"], "summary", 0],
    [["--older-than", "7d"], "summary", 100],
    [[], "summary", 160],
  ] as const)("%j preserves sealed-only JSON totals", async (flags, shape, expected) => {
    vi.useRealTimers();
    vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 8, 8, 12).getTime());
    vi.resetModules();
    const originalArgv = process.argv;
    const rejectionHandlers = process.listeners("unhandledRejection");
    const exceptionHandlers = process.listeners("uncaughtException");
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((value) => state.logs.push(String(value)));
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Unexpected process.exit");
    });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network disabled in fixture"));
    try {
      process.argv = [process.execPath, "tokmeter", ...flags, "--json", "--light"];
      await import("./cli.js");
      await vi.waitFor(() => expect(log).toHaveBeenCalled(), { timeout: 1000 });
      const value = JSON.parse(state.logs[0]);
      const actual =
        shape === "summary"
          ? value.stats.totalTokens
          : shape === "stats"
            ? value.totalTokens
            : value.reduce((sum: number, row: { totalTokens: number }) => sum + row.totalTokens, 0);
      expect(actual).toBe(expected);
      expect(exit).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      for (const handler of process.listeners("unhandledRejection"))
        if (!rejectionHandlers.includes(handler))
          process.removeListener("unhandledRejection", handler);
      for (const handler of process.listeners("uncaughtException"))
        if (!exceptionHandlers.includes(handler))
          process.removeListener("uncaughtException", handler);
    }
  });
});
