import { describe, expect, test } from "vitest";
import {
  DEFAULT_HEALTH_THRESHOLDS,
  type HealthBand,
  bandForPct,
  pctOfBudget,
  worstBand,
} from "./session-health.js";

describe("session-health — bandForPct", () => {
  test("maps percentages to the right band at default thresholds", () => {
    expect(bandForPct(0)).toBe("ok");
    expect(bandForPct(49.9)).toBe("ok");
    expect(bandForPct(50)).toBe("warn");
    expect(bandForPct(74.9)).toBe("warn");
    expect(bandForPct(75)).toBe("high");
    expect(bandForPct(89.9)).toBe("high");
    expect(bandForPct(90)).toBe("critical");
    expect(bandForPct(100)).toBe("critical");
    expect(bandForPct(150)).toBe("critical"); // over 100% stays critical
  });

  test("unknown/invalid readings are never alarming", () => {
    expect(bandForPct(Number.NaN)).toBe("ok");
    expect(bandForPct(Number.POSITIVE_INFINITY)).toBe("ok");
    expect(bandForPct(-5)).toBe("ok");
  });

  test("honors custom thresholds", () => {
    const t = { warn: 20, high: 40, critical: 60 };
    expect(bandForPct(25, t)).toBe("warn");
    expect(bandForPct(65, t)).toBe("critical");
  });
});

describe("session-health — pctOfBudget", () => {
  test("computes percent of budget", () => {
    expect(pctOfBudget(5, 10)).toBe(50);
    expect(pctOfBudget(12, 10)).toBe(120);
  });
  test("returns null for missing/invalid budget so no bogus band shows", () => {
    expect(pctOfBudget(5, 0)).toBeNull();
    expect(pctOfBudget(5, Number.NaN)).toBeNull();
    expect(pctOfBudget(Number.NaN, 10)).toBeNull();
  });
});

describe("session-health — worstBand (worst-session-wins, capability-aware)", () => {
  test("returns the highest-severity band across sessions", () => {
    expect(worstBand(["ok", "warn", "critical", "high"])).toBe("critical");
    expect(worstBand(["ok", "warn"])).toBe("warn");
  });

  test("ignores absent readings — a provider that can't produce the signal doesn't count", () => {
    const bands: Array<HealthBand | null | undefined> = [null, "warn", undefined, "high"];
    expect(worstBand(bands)).toBe("high");
  });

  test("returns null when nothing can report (no fabricated band)", () => {
    expect(worstBand([null, undefined])).toBeNull();
    expect(worstBand([])).toBeNull();
  });

  test("default thresholds are the documented 50/75/90", () => {
    expect(DEFAULT_HEALTH_THRESHOLDS).toEqual({ warn: 50, high: 75, critical: 90 });
  });
});
