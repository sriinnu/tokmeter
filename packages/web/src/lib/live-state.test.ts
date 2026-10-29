import { describe, expect, it } from "vitest";
import type { LiveData } from "../hooks/useLiveData.js";
import { selectLivePanelState } from "./live-state.js";

const aggregate = (sessions: number, models: number) => ({
  totalCost: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheTokens: 0,
  sessions,
  providers: [],
  byModel: Array.from({ length: models }, (_, i) => ({
    model: `m${i}`,
    cost: 1,
    inputTokens: 1,
    outputTokens: 1,
  })),
  byProvider: [],
});
const live = (status: LiveData["status"], aggregated: LiveData["aggregated"]): LiveData => ({
  status,
  aggregated,
  lastUpdate: 1,
});

describe("selectLivePanelState", () => {
  it("only streams when sessions and models are both reporting", () => {
    expect(selectLivePanelState(live("connected", aggregate(2, 1)))).toBe("streaming");
    expect(selectLivePanelState(live("connected", aggregate(0, 0)))).toBe("idle");
    expect(selectLivePanelState(live("connected", aggregate(0, 2)))).toBe("idle");
    expect(selectLivePanelState(live("connected", aggregate(3, 0)))).toBe("idle");
    expect(selectLivePanelState(live("connected", null))).toBe("idle");
  });

  it("keeps an unreachable daemon distinct from an idle one", () => {
    expect(selectLivePanelState(live("disconnected", aggregate(2, 1)))).toBe("offline");
    expect(selectLivePanelState(live("connecting", null))).toBe("connecting");
  });
});
