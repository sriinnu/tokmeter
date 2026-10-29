import { beforeEach, describe, expect, test } from "vitest";
import type { TokenUsage } from "./protocol.js";
import { LIVE_IDLE_MS, SessionManager } from "./session.js";

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

  test("update records the transcript path and keeps it on later updates that omit it", () => {
    mgr.update("claude-code", "a", 0.1, tok(), 0, undefined, { transcriptPath: "/t/a.jsonl" });
    expect(mgr.get("claude-code", "a")?.transcriptPath).toBe("/t/a.jsonl");

    mgr.update("claude-code", "a", 0.2, tok());
    expect(mgr.get("claude-code", "a")?.transcriptPath).toBe("/t/a.jsonl");

    mgr.update("claude-code", "a", 0.3, tok(), 0, undefined, { transcriptPath: "" });
    expect(mgr.get("claude-code", "a")?.transcriptPath).toBe("/t/a.jsonl");
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

  test("provider and session ID boundaries cannot collide", () => {
    mgr.register({ provider: "a:b", sessionId: "c", model: "one" });
    mgr.register({ provider: "a", sessionId: "b:c", model: "two" });
    expect(mgr.getAll()).toHaveLength(2);
    expect(mgr.get("a:b", "c")?.model).toBe("one");
    expect(mgr.get("a", "b:c")?.model).toBe("two");
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

  test("unregister ends the session: kept for cleanup, but no longer live", () => {
    mgr.register({ provider: "gemini", sessionId: "g", model: "gemini-2.5-pro" });
    mgr.unregister("gemini", "g");
    expect(mgr.get("gemini", "g")?.connected).toBe(false);
    expect(mgr.getAll()).toHaveLength(1);
    expect(mgr.getLive()).toHaveLength(0);
  });

  test("a later push revives an unregistered session", () => {
    mgr.update("gemini", "g", 1, tok());
    mgr.unregister("gemini", "g");
    mgr.update("gemini", "g", 2, tok());
    expect(mgr.getLive()).toHaveLength(1);
  });

  test("a one-shot update registers with the model/project/cwd it carries", () => {
    mgr.update("claude-code", "s", 0.5, tok(), 0, undefined, {
      model: "claude-opus-5-5",
      project: "tokmeter",
      cwd: "/w/tokmeter",
    });
    const s = mgr.get("claude-code", "s");
    expect(s?.model).toBe("claude-opus-5-5");
    expect(s?.project).toBe("tokmeter");
    expect(s?.cwd).toBe("/w/tokmeter");
    // A /model switch arrives on the next push.
    mgr.update("claude-code", "s", 0.6, tok(), 0, undefined, { model: "claude-sonnet-5" });
    expect(mgr.get("claude-code", "s")?.model).toBe("claude-sonnet-5");
    // An oversized model never lands; the previous one stays.
    mgr.update("claude-code", "s", 0.7, tok(), 0, undefined, { model: "m".repeat(257) });
    expect(mgr.get("claude-code", "s")?.model).toBe("claude-sonnet-5");
  });
});

describe("SessionManager — input hygiene", () => {
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

  test("rejects malformed model and oversized identifiers before they reach aggregation", () => {
    expect(mgr.register({ provider: "codex", sessionId: "x", model: {} } as never)).toBe(false);
    expect(mgr.register({ provider: "codex", sessionId: "x".repeat(257), model: "m" })).toBe(false);
    expect(mgr.update("codex", "x".repeat(257), 1, tok())).toBeNull();
    expect(mgr.getAll()).toHaveLength(0);
  });

  test("bounds registered sessions while allowing an existing one to refresh", () => {
    for (let i = 0; i < 1024; i++) {
      expect(mgr.register({ provider: "codex", sessionId: String(i), model: "m" })).toBe(true);
    }
    expect(mgr.register({ provider: "codex", sessionId: "extra", model: "m" })).toBe(false);
    expect(mgr.update("codex", "extra", 1, tok())).toBeNull();
    expect(mgr.register({ provider: "codex", sessionId: "0", model: "m" })).toBe(true);
    expect(mgr.getAll()).toHaveLength(1024);
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
    mgr.update(
      "claude-code",
      "a",
      2,
      tok({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 })
    );
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

  test("only live sessions contribute: unregistered and idle ones drop out", () => {
    mgr.update("claude-code", "a", 5, tok());
    mgr.update("claude-code", "b", 7, tok());
    mgr.update("claude-code", "c", 11, tok());
    mgr.unregister("claude-code", "b");
    mgr.get("claude-code", "c")!.lastUpdate = Date.now() - LIVE_IDLE_MS - 1;
    expect(mgr.getAggregated().totalCost).toBe(5);
    expect(mgr.getAggregated().sessions).toBe(1);
  });

  test("a one-shot client (update, then socket close) stays live until it goes quiet", () => {
    mgr.update("claude-code", "one-shot", 3, tok(), 0, { usedTokens: 50, maxTokens: 100 });
    mgr.disconnect("claude-code", "one-shot"); // the statusline closes after every push
    expect(mgr.getAggregated().sessions).toBe(1);
    expect(mgr.getAggregated().maxContextFillPct).toBeCloseTo(50, 6);

    mgr.get("claude-code", "one-shot")!.lastUpdate = Date.now() - LIVE_IDLE_MS + 1_000;
    expect(mgr.getAggregated().sessions).toBe(1); // still inside the window
    mgr.get("claude-code", "one-shot")!.lastUpdate = Date.now() - LIVE_IDLE_MS - 1;
    expect(mgr.getAggregated().sessions).toBe(0);
    expect(mgr.getAggregated().maxContextFillPct).toBeUndefined();
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

  test("an ended or idle high-fill session does not count", () => {
    mgr.update("codex", "b", 1, tok(), 0, { usedTokens: 190, maxTokens: 200 });
    mgr.unregister("codex", "b");
    expect(mgr.getAggregated().maxContextFillPct).toBeUndefined();

    mgr.update("codex", "c", 1, tok(), 0, { usedTokens: 180, maxTokens: 200 });
    mgr.get("codex", "c")!.lastUpdate = Date.now() - LIVE_IDLE_MS - 1;
    expect(mgr.getAggregated().maxContextFillPct).toBeUndefined();
  });
});

describe("SessionManager — cleanupStale", () => {
  let mgr: SessionManager;
  beforeEach(() => {
    mgr = new SessionManager();
  });

  test("removes sessions idle past the live window, keeps fresh ones", () => {
    mgr.update("claude-code", "live", 1, tok());
    mgr.update("codex", "old", 1, tok());
    mgr.disconnect("codex", "old");
    // Backdate past the window (objects are returned by reference, so mutating
    // lastUpdate simulates elapsed time).
    mgr.get("codex", "old")!.lastUpdate = Date.now() - LIVE_IDLE_MS - 1;

    const cleaned = mgr.cleanupStale();
    expect(cleaned).toBe(1);
    expect(mgr.get("codex", "old")).toBeUndefined();
    expect(mgr.get("claude-code", "live")).toBeDefined();
  });

  test("a disconnected-but-recent session is retained (one-shot pushes)", () => {
    mgr.update("codex", "recent", 1, tok());
    mgr.disconnect("codex", "recent");
    mgr.get("codex", "recent")!.lastUpdate = Date.now() - 120_000; // the old 60s cutoff
    expect(mgr.cleanupStale()).toBe(0);
    expect(mgr.get("codex", "recent")).toBeDefined();
  });

  test("a connected socket that stopped pushing is reaped too", () => {
    mgr.update("codex", "silent", 1, tok());
    mgr.get("codex", "silent")!.lastUpdate = Date.now() - LIVE_IDLE_MS - 1;
    expect(mgr.get("codex", "silent")?.connected).toBe(true);
    expect(mgr.cleanupStale()).toBe(1);
  });

  test("an unregistered session is reaped on the next pass", () => {
    mgr.update("codex", "bye", 1, tok());
    mgr.unregister("codex", "bye");
    expect(mgr.cleanupStale()).toBe(1);
  });
});
