import { beforeEach, describe, expect, test } from "vitest";
import { SessionManager } from "./session.js";
import type { TokenUsage } from "./protocol.js";

const tok = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

describe("SessionManager — lifecycle", () => {
  let mgr: SessionManager;
  beforeEach(() => {
    mgr = new SessionManager();
  });

  test("register creates a connected session; re-register reconnects, doesn't duplicate", () => {
    mgr.register({ provider: "claude-code", sessionId: "a", model: "claude-opus-4" });
    expect(mgr.getAll()).toHaveLength(1);
    expect(mgr.get("claude-code", "a")?.connected).toBe(true);

    mgr.disconnect("claude-code", "a");
    expect(mgr.get("claude-code", "a")?.connected).toBe(false);

    mgr.register({ provider: "claude-code", sessionId: "a", model: "claude-opus-4" });
    expect(mgr.getAll()).toHaveLength(1); // same key, no dupe
    expect(mgr.get("claude-code", "a")?.connected).toBe(true);
  });

  test("update auto-registers an unknown session and sets cost/tokens", () => {
    const s = mgr.update("codex", "x", 1.5, tok({ inputTokens: 100, outputTokens: 40 }));
    expect(s).not.toBeNull();
    expect(mgr.get("codex", "x")?.cost).toBe(1.5);
    expect(mgr.get("codex", "x")?.tokens.inputTokens).toBe(100);
  });

  test("update keeps the last-known context window when a later update omits it", () => {
    mgr.update("claude-code", "a", 1, tok(), 0, { usedTokens: 100, maxTokens: 200 });
    // A cost-only update (no contextWindow) must not wipe the reported window.
    mgr.update("claude-code", "a", 2, tok());
    expect(mgr.get("claude-code", "a")?.contextWindow).toEqual({ usedTokens: 100, maxTokens: 200 });
  });

  test("unregister/disconnect flip connected off but keep the session", () => {
    mgr.register({ provider: "gemini", sessionId: "g", model: "gemini-2.5-pro" });
    mgr.unregister("gemini", "g");
    expect(mgr.get("gemini", "g")?.connected).toBe(false);
    expect(mgr.getAll()).toHaveLength(1);
    expect(mgr.getConnected()).toHaveLength(0);
  });
});

describe("SessionManager — input hygiene (unauthenticated WS transport)", () => {
  let mgr: SessionManager;
  beforeEach(() => {
    mgr = new SessionManager();
  });

  test("coerces a hostile/garbage cost and partial tokens to finite non-negative", () => {
    mgr.update("codex", "x", Number.NaN, { inputTokens: -5 } as unknown as TokenUsage);
    const s = mgr.get("codex", "x")!;
    expect(s.cost).toBe(0); // NaN → 0
    expect(s.tokens.inputTokens).toBe(0); // negative → 0
    expect(s.tokens.outputTokens).toBe(0); // undefined field → 0, not NaN
    // The aggregate must be a clean number, never NaN.
    expect(Number.isFinite(mgr.getAggregated().totalCost)).toBe(true);
    expect(mgr.getAggregated().totalCost).toBe(0);
  });

  test("a huge but finite cost is kept (not silently zeroed) — only non-finite/negative are scrubbed", () => {
    mgr.update("codex", "x", 1e6, tok({ inputTokens: 1_000_000 }));
    expect(mgr.getAggregated().totalCost).toBe(1e6);
  });

  test("drops register/update with an empty provider or sessionId (no junk session)", () => {
    mgr.register({ provider: "", sessionId: "a", model: "m" });
    mgr.update("claude-code", "", 5, tok());
    expect(mgr.getAll()).toHaveLength(0);
    expect(mgr.getAggregated().totalCost).toBe(0);
  });

  test("a malformed context window (NaN used tokens) never yields a NaN fill", () => {
    mgr.update("claude-code", "a", 1, tok(), 0, {
      usedTokens: Number.NaN,
      maxTokens: 200,
    });
    // usedTokens scrubbed to 0 → 0% fill, not NaN.
    expect(mgr.getAggregated().maxContextFillPct).toBe(0);
  });
});

describe("SessionManager — getAggregated", () => {
  let mgr: SessionManager;
  beforeEach(() => {
    mgr = new SessionManager();
  });

  test("sums cost/tokens and groups by model + provider (short model names)", () => {
    mgr.update("claude-code", "a", 2, tok({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 }));
    mgr.get("claude-code", "a")!.model = "claude-sonnet-4-5";
    mgr.update("codex", "b", 3, tok({ inputTokens: 200, outputTokens: 20 }));
    mgr.get("codex", "b")!.model = "gpt-5.5";

    const agg = mgr.getAggregated();
    expect(agg.totalCost).toBe(5);
    expect(agg.totalInputTokens).toBe(300);
    expect(agg.totalOutputTokens).toBe(70);
    expect(agg.totalCacheTokens).toBe(10);
    expect(agg.sessions).toBe(2);
    expect(agg.providers.sort()).toEqual(["claude-code", "codex"]);
    // shortModel strips the "claude-" prefix.
    expect(agg.byModel.map((m) => m.model).sort()).toEqual(["gpt-5.5", "sonnet-4-5"]);
    // sorted by cost desc → codex/gpt-5.5 (3) before claude (2)
    expect(agg.byProvider[0].provider).toBe("codex");
  });

  test("excludeSession omits the asking session from the totals", () => {
    mgr.update("claude-code", "self", 10, tok({ inputTokens: 1000 }));
    mgr.update("claude-code", "other", 4, tok({ inputTokens: 400 }));
    const agg = mgr.getAggregated({ provider: "claude-code", sessionId: "self" });
    expect(agg.totalCost).toBe(4);
    expect(agg.totalInputTokens).toBe(400);
    expect(agg.sessions).toBe(2); // sessions count is the connected total, unfiltered
  });

  test("only connected sessions contribute", () => {
    mgr.update("claude-code", "a", 5, tok());
    mgr.update("claude-code", "b", 7, tok());
    mgr.disconnect("claude-code", "b");
    expect(mgr.getAggregated().totalCost).toBe(5);
  });
});

describe("SessionManager — maxContextFillPct (worst session wins)", () => {
  let mgr: SessionManager;
  beforeEach(() => {
    mgr = new SessionManager();
  });

  test("reports the highest fill across sessions that report a window", () => {
    mgr.update("claude-code", "a", 1, tok(), 0, { usedTokens: 100, maxTokens: 200 }); // 50%
    mgr.update("codex", "b", 1, tok(), 0, { usedTokens: 188, maxTokens: 200 }); // 94%
    mgr.update("gemini", "c", 1, tok()); // no window
    expect(mgr.getAggregated().maxContextFillPct).toBeCloseTo(94, 6);
  });

  test("undefined when no session reports a window (universal fallback)", () => {
    mgr.update("claude-code", "a", 1, tok());
    mgr.update("codex", "b", 1, tok());
    expect(mgr.getAggregated().maxContextFillPct).toBeUndefined();
  });

  test("ignores a malformed window (maxTokens <= 0) rather than dividing by zero", () => {
    mgr.update("deepseek", "d", 1, tok(), 0, { usedTokens: 10, maxTokens: 0 });
    expect(mgr.getAggregated().maxContextFillPct).toBeUndefined();
  });

  test("a disconnected high-fill session does not count", () => {
    mgr.update("codex", "b", 1, tok(), 0, { usedTokens: 190, maxTokens: 200 });
    mgr.disconnect("codex", "b");
    expect(mgr.getAggregated().maxContextFillPct).toBeUndefined();
  });
});

describe("SessionManager — cleanupStale", () => {
  let mgr: SessionManager;
  beforeEach(() => {
    mgr = new SessionManager();
  });

  test("removes disconnected + stale sessions, keeps connected and fresh ones", () => {
    mgr.update("claude-code", "live", 1, tok());
    mgr.update("codex", "old", 1, tok());
    mgr.disconnect("codex", "old");
    // Backdate the disconnected session past the staleness window (objects are
    // returned by reference, so mutating lastUpdate simulates elapsed time).
    mgr.get("codex", "old")!.lastUpdate = Date.now() - 120_000;

    const cleaned = mgr.cleanupStale(60_000);
    expect(cleaned).toBe(1);
    expect(mgr.get("codex", "old")).toBeUndefined();
    expect(mgr.get("claude-code", "live")).toBeDefined();
  });

  test("a disconnected-but-recent session is retained", () => {
    mgr.update("codex", "recent", 1, tok());
    mgr.disconnect("codex", "recent");
    expect(mgr.cleanupStale(60_000)).toBe(0);
    expect(mgr.get("codex", "recent")).toBeDefined();
  });
});
