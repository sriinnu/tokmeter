import { describe, expect, it } from "vitest";
import type { TokmeterTimeOfDay } from "../hooks/useTokmeterData.js";
import { buildTimeOfDayView, formatBlock, formatShare, formatSharePrecise } from "./time-of-day.js";

// The owner's real 30-day cost split (sealed relay, 2026-10-30).
const SHARES = [0.0177, 0.00382, 0.01295, 0.11275, 0.16253, 0.2448, 0.20627, 0.23918];

function profile(overrides: Partial<TokmeterTimeOfDay> = {}): TokmeterTimeOfDay {
  const total = 1000;
  const blocks = SHARES.map((share, i) => ({
    startHour: i * 3,
    endHour: i * 3 + 3,
    cost: share * total,
    share,
  }));
  return {
    status: "ok",
    windowDays: 30,
    minDays: 7,
    daysCounted: 30,
    daysSkipped: 0,
    totalCost: total,
    blocks,
    peak: blocks[5],
    ...overrides,
  };
}

describe("buildTimeOfDayView", () => {
  it("passes a well-formed profile through with its peak", () => {
    const view = buildTimeOfDayView(profile());
    expect(view.state).toBe("ok");
    if (view.state !== "ok") return;
    expect(formatBlock(view.peak)).toBe("15–18");
    expect(formatShare(view.peak.share)).toBe("24%"); // 24.48%, not 25
    expect(view.maxShare).toBe(0.2448);
    expect(view.daysCounted).toBe(30);
  });

  it("is missing when the daemon didn't send one (older daemon, static export)", () => {
    expect(buildTimeOfDayView(undefined).state).toBe("missing");
    expect(buildTimeOfDayView(null).state).toBe("missing");
  });

  it("reports how many days it has when there isn't enough data", () => {
    const view = buildTimeOfDayView(
      profile({ status: "insufficient", daysCounted: 4, blocks: [], peak: null, totalCost: 0 })
    );
    expect(view).toEqual({ state: "insufficient", daysCounted: 4, minDays: 7 });
  });

  it("refuses a split that doesn't add up rather than draw it", () => {
    const p = profile();
    p.blocks[0] = { ...p.blocks[0], share: 0.5 };
    expect(buildTimeOfDayView(p).state).toBe("missing");
    expect(buildTimeOfDayView(profile({ blocks: profile().blocks.slice(0, 7) })).state).toBe(
      "missing"
    );
  });
});

describe("formatters", () => {
  it("formats blocks on a 24-hour clock", () => {
    expect(formatBlock({ startHour: 0, endHour: 3 })).toBe("00–03");
    expect(formatBlock({ startHour: 21, endHour: 24 })).toBe("21–24");
  });

  it("never rounds real spend down to 0%", () => {
    expect(formatShare(0.004)).toBe("<1%");
    expect(formatShare(0)).toBe("0%");
  });

  it("the table keeps one decimal so near-ties stay distinct", () => {
    expect(formatSharePrecise(0.2448)).toBe("24.5%");
    expect(formatSharePrecise(0.23918)).toBe("23.9%");
    expect(formatSharePrecise(0.0003)).toBe("<0.1%");
  });
});
