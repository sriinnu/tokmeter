import { describe, expect, it } from "vitest";
import { modelCostBasis, summarizeCostBasis } from "./cost-basis.js";
import { createRecord } from "./parsers/utils.js";

describe("cost provenance", () => {
  it("keeps the same model's reported and estimated costs separate across tools", () => {
    const records = [
      createRecord({ timestamp: 0, provider: "codex", model: "shared", cost: 1 }),
      createRecord({
        timestamp: 0,
        provider: "cursor",
        model: "shared",
        cost: 2,
        usage: { cost: "direct" },
      }),
    ];
    const grouped = modelCostBasis(records);
    expect(grouped["codex::shared"].estimatedCost).toBe(1);
    expect(grouped["cursor::shared"].reportedCost).toBe(2);
  });
  it("separates estimates, tool reports, and unavailable costs without inventing charges", () => {
    const record = (cost: number, basis: "calculated" | "direct" | "not_exposed") =>
      createRecord({
        timestamp: 0,
        provider: "codex",
        model: "demo",
        inputTokens: 100,
        cost,
        usage: { cost: basis },
      });
    expect(
      summarizeCostBasis([
        record(1.25, "calculated"),
        record(0.5, "direct"),
        record(0, "direct"),
        record(0, "not_exposed"),
        { ...record(0, "calculated"), costEligible: false },
        { ...record(0.75, "not_exposed"), usage: undefined },
      ])
    ).toEqual({
      estimatedCost: 1.25,
      reportedCost: 0.5,
      unclassifiedCost: 0.75,
      estimatedRecords: 1,
      reportedRecords: 2,
      unavailableRecords: 3,
    });
  });

  it("keeps an intentionally free estimate distinct from missing data", () => {
    const free = createRecord({
      timestamp: 0,
      provider: "codex",
      model: "free",
      usage: { cost: "calculated" },
    });
    expect(summarizeCostBasis([free])).toMatchObject({
      estimatedCost: 0,
      estimatedRecords: 1,
      unavailableRecords: 0,
    });
  });
});
