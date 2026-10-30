import { describe, expect, it } from "vitest";
import { normalizeTokmeterData, type TokmeterTimeOfDay } from "./useTokmeterData.js";

describe("normalizeTokmeterData", () => {
  it("keeps the summary's time-of-day profile", () => {
    // It rebuilt the payload field by field and dropped timeOfDay, so the
    // busiest-hours strip read "missing" even from a current daemon.
    const timeOfDay: TokmeterTimeOfDay = {
      status: "insufficient",
      windowDays: 30,
      minDays: 7,
      daysCounted: 2,
      daysSkipped: 0,
      totalCost: 0,
      blocks: [],
      peak: null,
    };
    expect(normalizeTokmeterData({ timeOfDay }).timeOfDay).toEqual(timeOfDay);
    expect(normalizeTokmeterData({}).timeOfDay).toBeUndefined();
  });
});
