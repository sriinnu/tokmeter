import { describe, expect, it } from "vitest";
import {
  formatBar,
  formatCost,
  formatDuration,
  formatLineDelta,
  formatNumber,
  formatPercent,
  formatResetIn,
  formatTierBar,
  sparkline,
} from "./formatter.js";

describe("formatResetIn", () => {
  const now = 1_700_000_000_000; // ms

  it("should render hours and minutes", () => {
    expect(formatResetIn(now / 1000 + 2 * 3600 + 10 * 60, now)).toBe("2h10m");
  });

  it("should drop zero minutes on the hour", () => {
    expect(formatResetIn(now / 1000 + 3 * 3600, now)).toBe("3h");
  });

  it("should render minutes and seconds", () => {
    expect(formatResetIn(now / 1000 + 45 * 60, now)).toBe("45m");
    expect(formatResetIn(now / 1000 + 30, now)).toBe("30s");
  });

  it("should be empty once passed or invalid", () => {
    expect(formatResetIn(now / 1000 - 1, now)).toBe("");
    expect(formatResetIn(now / 1000, now)).toBe("");
    expect(formatResetIn(Number.NaN, now)).toBe("");
  });
});

describe("formatTierBar", () => {
  it("should fill proportionally", () => {
    expect(formatTierBar(0)).toEqual({ filled: "", empty: "────────" });
    expect(formatTierBar(50)).toEqual({ filled: "━━━━", empty: "────" });
    expect(formatTierBar(100)).toEqual({ filled: "━━━━━━━━", empty: "" });
  });

  it("should clamp out-of-range and invalid values", () => {
    expect(formatTierBar(140)).toEqual({ filled: "━━━━━━━━", empty: "" });
    expect(formatTierBar(-5)).toEqual({ filled: "", empty: "────────" });
    expect(formatTierBar(Number.NaN)).toEqual({ filled: "", empty: "────────" });
  });

  it("should honor width", () => {
    expect(formatTierBar(50, 4)).toEqual({ filled: "━━", empty: "──" });
  });
});

describe("formatLineDelta", () => {
  it("should render both sides", () => {
    expect(formatLineDelta(142, 38)).toEqual({ added: "+142", removed: "−38" });
  });

  it("should omit a zero side", () => {
    expect(formatLineDelta(12, 0)).toEqual({ added: "+12", removed: "" });
    expect(formatLineDelta(0, 7)).toEqual({ added: "", removed: "−7" });
  });

  it("should be null when nothing changed", () => {
    expect(formatLineDelta(0, 0)).toBeNull();
    expect(formatLineDelta(Number.NaN, -3)).toBeNull();
  });

  it("should compact large counts", () => {
    expect(formatLineDelta(15_200, 0)).toEqual({ added: "+15.2K", removed: "" });
  });
});

describe("formatNumber", () => {
  it("should format millions", () => {
    expect(formatNumber(1_500_000)).toBe("1.5M");
    expect(formatNumber(2_000_000)).toBe("2.0M");
  });

  it("should format thousands", () => {
    expect(formatNumber(1_500)).toBe("1.5K");
    expect(formatNumber(999)).toBe("999");
  });

  it("should format small numbers", () => {
    expect(formatNumber(42)).toBe("42");
    expect(formatNumber(0)).toBe("0");
  });

  it("should handle NaN and Infinity", () => {
    expect(formatNumber(Number.NaN)).toBe("0");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatNumber(Number.NEGATIVE_INFINITY)).toBe("0");
  });
});

describe("formatCost", () => {
  it("should format large costs", () => {
    expect(formatCost(150)).toBe("$150");
    expect(formatCost(100)).toBe("$100");
  });

  it("should format medium costs", () => {
    expect(formatCost(15)).toBe("$15.0");
    expect(formatCost(10)).toBe("$10.0");
  });

  it("should format small costs", () => {
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(0.05)).toBe("$0.05");
  });

  it("should handle NaN and Infinity", () => {
    expect(formatCost(Number.NaN)).toBe("$0.00");
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe("$0.00");
    expect(formatCost(Number.NEGATIVE_INFINITY)).toBe("$0.00");
  });
});

describe("formatPercent", () => {
  it("should format large percentages", () => {
    expect(formatPercent(75)).toBe("75.0%");
    expect(formatPercent(100)).toBe("100.0%");
  });

  it("should format small percentages", () => {
    expect(formatPercent(0.5)).toBe("0.50%");
    expect(formatPercent(5)).toBe("5.0%");
  });

  it("should handle NaN and Infinity", () => {
    expect(formatPercent(Number.NaN)).toBe("0.00%");
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("0.00%");
  });
});

describe("formatBar", () => {
  it("should render empty bar for zero value", () => {
    expect(formatBar(0, 100)).toBe("░░░░░░░░░░");
  });

  it("should render full bar for max value", () => {
    expect(formatBar(100, 100)).toBe("██████████");
  });

  it("should render partial bar", () => {
    expect(formatBar(50, 100)).toBe("█████░░░░░");
  });

  it("should handle custom width", () => {
    expect(formatBar(50, 100, 4)).toBe("██░░");
  });

  it("should handle NaN and Infinity", () => {
    expect(formatBar(Number.NaN, 100)).toBe("░░░░░░░░░░");
    expect(formatBar(50, Number.NaN)).toBe("░░░░░░░░░░");
    expect(formatBar(Number.POSITIVE_INFINITY, 100)).toBe("░░░░░░░░░░");
  });
});

describe("formatDuration", () => {
  it("should format hours and minutes", () => {
    expect(formatDuration(2 * 60 * 60 * 1000 + 15 * 60 * 1000)).toBe("2h 15m");
  });

  it("should format minutes and seconds", () => {
    expect(formatDuration(45 * 60 * 1000 + 12 * 1000)).toBe("45m 12s");
  });

  it("should format seconds only", () => {
    expect(formatDuration(45 * 1000)).toBe("45s");
  });

  it("should handle zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("should handle NaN and negative values", () => {
    expect(formatDuration(Number.NaN)).toBe("0s");
    expect(formatDuration(-1000)).toBe("0s");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});

describe("sparkline", () => {
  it("should return empty string for empty array", () => {
    expect(sparkline([])).toBe("");
  });

  it("should render single value as min", () => {
    // When min === max, ratio is 0, so it returns the first char '▁'
    expect(sparkline([5])).toBe("▁");
  });

  it("should render multiple values", () => {
    const result = sparkline([1, 2, 3, 4, 5]);
    expect(result.length).toBe(5);
  });

  it("should use different block characters", () => {
    const result = sparkline([0, 5, 10]);
    expect(result[0]).toBe("▁"); // min
    expect(result[2]).toBe("█"); // max
  });

  it("should handle NaN values", () => {
    expect(sparkline([Number.NaN, Number.NaN])).toBe("");
    expect(sparkline([1, Number.NaN, 3])).toBe("▁█"); // filters out NaN, renders finite values
  });
});
