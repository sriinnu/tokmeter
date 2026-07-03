import { describe, expect, test } from "vitest";
import {
  type StatsFloor,
  type TodayTotals,
  computeStatsFloor,
  computeTodayFloor,
  isAllowedHttpHost,
  isAllowedWsOrigin,
  isValidAuthHeader,
} from "./server.js";

describe("isAllowedWsOrigin — WS handshake origin allowlist", () => {
  test("no Origin header (native client: bar app, CLI) is allowed", () => {
    expect(isAllowedWsOrigin(undefined)).toBe(true);
  });

  test("localhost / 127.0.0.1 / [::1], with or without a port, are allowed", () => {
    expect(isAllowedWsOrigin("http://localhost")).toBe(true);
    expect(isAllowedWsOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedWsOrigin("https://127.0.0.1:9876")).toBe(true);
    expect(isAllowedWsOrigin("http://[::1]:3000")).toBe(true);
  });

  test("a foreign origin is rejected (the DNS-rebinding / malicious-page attack)", () => {
    expect(isAllowedWsOrigin("https://evil.com")).toBe(false);
    expect(isAllowedWsOrigin("http://localhost.evil.com")).toBe(false);
    expect(isAllowedWsOrigin("http://127.0.0.1.evil.com")).toBe(false);
  });
});

describe("isAllowedHttpHost — HTTP Host-header DNS-rebinding guard", () => {
  test("missing Host header is allowed (HTTP/1.0, some native clients)", () => {
    expect(isAllowedHttpHost(undefined)).toBe(true);
  });

  test("localhost / 127.0.0.1 / [::1], case-insensitive, with or without a port, are allowed", () => {
    expect(isAllowedHttpHost("localhost")).toBe(true);
    expect(isAllowedHttpHost("LOCALHOST:9877")).toBe(true);
    expect(isAllowedHttpHost("127.0.0.1:9877")).toBe(true);
    expect(isAllowedHttpHost("[::1]:9877")).toBe(true);
  });

  test("a rebound Host header is rejected even though the connection is same-origin", () => {
    // The DNS-rebinding scenario the guard exists for: evil.com's A record
    // now points at 127.0.0.1, so the TCP connection is local, but the
    // browser still sends the original Host header.
    expect(isAllowedHttpHost("evil.com")).toBe(false);
    expect(isAllowedHttpHost("evil.com:9877")).toBe(false);
  });
});

describe("isValidAuthHeader — bearer-token check", () => {
  test("no configured token is dev mode — always passes", () => {
    expect(isValidAuthHeader(undefined, null)).toBe(true);
    expect(isValidAuthHeader("Bearer whatever", null)).toBe(true);
  });

  test("the correct bearer token passes", () => {
    expect(isValidAuthHeader("Bearer abc123", "abc123")).toBe(true);
  });

  test("a wrong token, missing header, or wrong-length header all fail closed", () => {
    expect(isValidAuthHeader("Bearer wrong", "abc123")).toBe(false);
    expect(isValidAuthHeader(undefined, "abc123")).toBe(false);
    expect(isValidAuthHeader("Bearer abc123extra", "abc123")).toBe(false);
    expect(isValidAuthHeader("", "abc123")).toBe(false);
  });
});

describe("computeTodayFloor — today's totals are monotonic upward within a day", () => {
  const base: TodayTotals = {
    cost: 2.5,
    in: 1000,
    out: 500,
    day: "2026-07-01",
    projects: { alpha: { cost: 2.5, in: 1000, out: 500 } },
  };

  test("first call (no prior floor) passes through as-is", () => {
    const floor = computeTodayFloor(base, null);
    expect(floor).toEqual(base);
  });

  test("a later LOWER reading (codex fork-dedup winner swap) is floored up to the high-water mark", () => {
    const dipped: TodayTotals = {
      cost: 2.0, // dropped from 2.5 — parser flux, not a real refund
      in: 1000,
      out: 500,
      day: "2026-07-01",
      projects: { alpha: { cost: 2.0, in: 1000, out: 500 } },
    };
    const floor = computeTodayFloor(dipped, base);
    expect(floor.cost).toBe(2.5); // held at the prior high-water, not dropped
    expect(floor.projects.alpha.cost).toBe(2.5);
  });

  test("a later HIGHER reading raises the floor", () => {
    const grown: TodayTotals = {
      cost: 3.0,
      in: 1200,
      out: 600,
      day: "2026-07-01",
      projects: { alpha: { cost: 3.0, in: 1200, out: 600 } },
    };
    const floor = computeTodayFloor(grown, base);
    expect(floor.cost).toBe(3.0);
  });

  test("a new project appearing mid-day is floored independently, not lost", () => {
    const withNewProject: TodayTotals = {
      cost: 3.5,
      in: 1400,
      out: 700,
      day: "2026-07-01",
      projects: {
        alpha: { cost: 2.5, in: 1000, out: 500 },
        beta: { cost: 1.0, in: 400, out: 200 },
      },
    };
    const floor = computeTodayFloor(withNewProject, base);
    expect(floor.projects.beta).toEqual({ cost: 1.0, in: 400, out: 200 });
  });

  test("day rollover resets the floor — a new day's smaller total is NOT held to yesterday's", () => {
    const nextDay: TodayTotals = {
      cost: 0.1,
      in: 50,
      out: 20,
      day: "2026-07-02",
      projects: {},
    };
    const floor = computeTodayFloor(nextDay, base);
    expect(floor.cost).toBe(0.1); // fresh floor for the new day, not held at 2.5
    expect(floor.day).toBe("2026-07-02");
  });
});

describe("computeStatsFloor — lifetime totals are monotonic upward within a day", () => {
  const day = "2026-07-01";

  test("first call for a day seeds the floor and returns stats unfloored", () => {
    const stats = { totalCost: 100, totalTokens: 50_000, activeDays: 10 };
    const { result, floor } = computeStatsFloor(stats, null, day);
    expect(result).toEqual(stats);
    expect(floor).toEqual({ day, totalCost: 100, totalTokens: 50_000 });
  });

  test("a later LOWER lifetime reading is floored up (fork-dedup swap), not shown as a refund", () => {
    const prior: StatsFloor = { day, totalCost: 100, totalTokens: 50_000 };
    const dipped = { totalCost: 98, totalTokens: 49_000, activeDays: 10 };
    const { result, floor } = computeStatsFloor(dipped, prior, day);
    expect(result.totalCost).toBe(100);
    expect(result.totalTokens).toBe(50_000);
    expect(floor?.totalCost).toBe(100);
  });

  test("a later HIGHER reading passes through and raises the floor", () => {
    const prior: StatsFloor = { day, totalCost: 100, totalTokens: 50_000 };
    const grown = { totalCost: 105, totalTokens: 52_000 };
    const { result, floor } = computeStatsFloor(grown, prior, day);
    expect(result.totalCost).toBe(105);
    expect(floor?.totalCost).toBe(105);
  });

  test("day rollover resets the floor to the new day's value", () => {
    const prior: StatsFloor = { day, totalCost: 100, totalTokens: 50_000 };
    const nextDayStats = { totalCost: 3, totalTokens: 1_000 };
    const { result, floor } = computeStatsFloor(nextDayStats, prior, "2026-07-02");
    expect(result.totalCost).toBe(3); // not floored against yesterday's 100
    expect(floor).toEqual({ day: "2026-07-02", totalCost: 3, totalTokens: 1_000 });
  });

  test("a shape without numeric totalCost/totalTokens passes through untouched, floor unchanged", () => {
    const prior: StatsFloor = { day, totalCost: 100, totalTokens: 50_000 };
    const weird = { somethingElse: true } as unknown as {
      totalCost?: number;
      totalTokens?: number;
    };
    const { result, floor } = computeStatsFloor(weird, prior, day);
    expect(result).toBe(weird);
    expect(floor).toBe(prior);
  });
});
