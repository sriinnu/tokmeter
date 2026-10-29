import { describe, expect, test } from "vitest";
import { estimateTurnsLeft } from "./statusline.js";
import {
  forecastWindow,
  formatSpan,
  renderStatusline,
  type StatusView,
} from "./statusline-view.js";

// 2026-10-18 16:19 local, the moment of the captured payload these mirror.
const NOW = new Date(2026, 9, 18, 16, 19, 0).getTime();
const S = NOW / 1000;
const plain = (v: StatusView, cols = 200) => renderStatusline(v, { cols, color: false });

/** This session's real payload numbers (cost, API time, cache, windows). */
function base(overrides: Partial<StatusView> = {}): StatusView {
  return {
    now: NOW,
    project: "tokmeter",
    model: "Opus 5.5",
    effort: "med",
    ctx: { pct: 16, windowTokens: 1_000_000, turnsLeft: null },
    cache: { warm: true, expiresAt: S + 59 * 60, rebuildTokens: 150_839 },
    cost: { usd: 25.98, activeMs: 3_496_835 },
    // 5h window: 1h30m in, 3h30m left; 7d: 5d11h40m left.
    five: { pct: 2, resetsAt: S + 3.5 * 3600, spanSec: 5 * 3600 },
    seven: { pct: 1, resetsAt: S + (5 * 86400 + 11 * 3600 + 40 * 60), spanSec: 7 * 86400 },
    today: { state: "fresh", usd: 75.3, ageMs: 4_000 },
    repo: { usd: 9.42, stale: false },
    git: { branch: "fix/opencode-db-schema", dirty: 0 },
    pr: { number: 128 },
    ...overrides,
  };
}

describe("normal session", () => {
  test("every decision segment, cost per active hour, forecast to reset", () => {
    const [l1, l2] = plain(base()).split("\n");
    expect(l1).toContain(" ◆ tokmeter ");
    expect(l1).toContain("Opus 5.5 · med");
    expect(l1).toContain("ctx ▰▱▱▱▱▱▱▱ 16%");
    expect(l1).toContain("cache 59m");
    // $25.98 over 58.3 active minutes, not over 18 wall-clock hours.
    expect(l1).toContain("$26.0 · $26.7/h active");
    expect(l1).toContain("⎇ fix/opencode-db-schema");
    expect(l2).toContain("5h 2% · 3h30m");
    expect(l2).toContain("7d 1%");
    expect(l2).toContain("today $75.3");
    expect(l2).toContain("repo $9.42");
    expect(l2).not.toContain("⚠");
  });
});

describe("running out", () => {
  test("context 86% warns with turns left and takes the alert slot", () => {
    const out = plain(base({ ctx: { pct: 86, windowTokens: 1_000_000, turnsLeft: 6 } }));
    expect(out).toContain("~6 turns left");
    expect(out.split("\n")[1]).toContain("⚠ context 86% · ~6 turns left");
  });

  test("context 97% says it compacts next turn and what to do", () => {
    const out = plain(base({ ctx: { pct: 97, turnsLeft: 1 } }));
    expect(out).toContain("ctx ▰▰▰▰▰▰▰▰ 97% · compacts next turn");
    expect(out).toContain("⚠ context 97% · next turn compacts · /compact now to choose what stays");
  });

  test("context 100% reads compacting", () => {
    expect(plain(base({ ctx: { pct: 100 } }))).toContain("ctx 100% · compacting");
  });

  test("cache under 5 minutes shows the rebuild size", () => {
    const out = plain(base({ cache: { warm: true, expiresAt: S + 240, rebuildTokens: 150_839 } }));
    expect(out).toContain("cache 4m · rebuild ~151K tok");
    expect(out).toContain("⚠ cache cools in 4m · then rebuilds ~151K tok");
  });

  test("a cold cache says the next turn rebuilds", () => {
    expect(
      plain(base({ cache: { warm: false, expiresAt: null, rebuildTokens: 150_839 } }))
    ).toContain("cache cold · next turn rebuilds ~151K tok");
  });

  test("a 5h window on course to run out before reset forecasts the time", () => {
    // 71% used 1h30m in → hits 100% about 37 minutes from now.
    const out = plain(base({ five: { pct: 71, resetsAt: S + 3.5 * 3600, spanSec: 5 * 3600 } }));
    expect(out).toMatch(/⚠ 5h limit at ~16:5\d at this pace · 2h\d+m before reset/);
    expect(out).toContain("5h 71% → ~237%");
  });

  test("a spent 5h window says so, with the reset and the 7d window", () => {
    const out = plain(
      base({
        five: { pct: 100, resetsAt: S + 72 * 60, spanSec: 5 * 3600 },
        seven: { pct: 34, resetsAt: S + 5 * 86400, spanSec: 7 * 86400 },
      })
    );
    expect(out).toContain("■ 5h limit reached · resets 17:31 (in 1h12m) · 7d 34%");
    expect(out).toContain("5h 100%");
  });

  test("the worst problem wins the alert slot", () => {
    const out = plain(
      base({
        ctx: { pct: 86, turnsLeft: 6 },
        cache: { warm: true, expiresAt: S + 240, rebuildTokens: 150_839 },
        five: { pct: 100, resetsAt: S + 72 * 60, spanSec: 5 * 3600 },
      })
    );
    const l2 = out.split("\n")[1];
    expect(l2).toContain("■ 5h limit reached");
    expect(l2).not.toContain("⚠ context");
    expect(l2).not.toContain("⚠ cache");
  });
});

describe("stale payload", () => {
  test("a window whose reset has passed reads as reset, and raises no alert", () => {
    const out = plain(base({ five: { pct: 100, resetsAt: S - 60, spanSec: 5 * 3600 } }));
    expect(out).toContain("5h reset");
    expect(out).not.toContain("5h 100%");
    expect(out).not.toContain("limit reached");
  });
});

describe("daemon freshness", () => {
  test("stale totals are marked with ~ and their age", () => {
    const out = plain(
      base({
        today: { state: "stale", usd: 75.3, ageMs: 41_000 },
        repo: { usd: 9.42, stale: true },
      })
    );
    expect(out).toContain("today ~$75.3 · 41s old");
    expect(out).toContain("repo ~$9.42");
  });

  test("a stopped daemon is a dash, never $0.00", () => {
    const out = plain(base({ today: { state: "down" }, repo: undefined }));
    expect(out).toContain("today — daemon offline");
    expect(out).not.toContain("$0.00");
  });
});

describe("Ribhu via Chitragupta", () => {
  const ribhu = (route: StatusView["route"]) =>
    base({
      project: "ribhu",
      model: "deepseek/deepseek-v4-pro",
      effort: undefined,
      route,
      ctx: { pct: null },
      cache: undefined,
      cost: { usd: null },
      five: undefined,
      seven: undefined,
      git: { branch: "next", dirty: 0 },
      pr: undefined,
    });

  test("the router, the model that answered, and who chose it", () => {
    const out = plain(
      ribhu({
        via: "chitragupta",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        authority: "kernel",
        recent: { fallbacks: 0, total: 5 },
      })
    );
    expect(out).toContain("⇄ chitragupta → deepseek/deepseek-v4-pro · kernel");
    expect(out).toContain("route 5 of 5 kernel");
  });

  test("unknown context and cost show as unknown, not zero", () => {
    const out = plain(ribhu({ via: "chitragupta", authority: "kernel" }));
    expect(out).toContain("ctx ?");
    expect(out).toContain("$— not priced");
    expect(out).not.toContain("ctx 0%");
  });

  test("a fallback is called out", () => {
    const out = plain(
      ribhu({
        via: "chitragupta",
        provider: "ollama",
        model: "llama3.2:3b",
        authority: "fallback",
        recent: { fallbacks: 2, total: 5 },
      })
    );
    expect(out).toContain("⇄ chitragupta → ollama/llama3.2:3b · fallback");
    expect(out).toContain("⚠ chitragupta fell back to ollama/llama3.2:3b");
    expect(out).toContain("route 2 of last 5 fell back");
  });

  test("an unreachable router", () => {
    expect(plain(ribhu({ via: "chitragupta", offline: true }))).toContain(
      "⚠ chitragupta offline · can't route"
    );
  });
});

describe("width", () => {
  test("drops low-priority segments to fit and never exceeds the width", () => {
    for (const cols of [40, 60, 80, 120]) {
      for (const line of plain(base(), cols).split("\n")) {
        expect([...line].length).toBeLessThanOrEqual(cols);
      }
    }
    const narrow = plain(base(), 80);
    expect(narrow).toContain("ctx");
    expect(narrow).toContain("$26.0");
    expect(narrow).not.toContain("⎇");
  });

  test("color is plain text when disabled", () => {
    expect(plain(base())).not.toContain("\x1b[");
    expect(renderStatusline(base(), { cols: 200, color: true })).toContain("\x1b[");
  });
});

describe("helpers", () => {
  test("forecast needs ten minutes of window behind it", () => {
    expect(
      forecastWindow({ pct: 5, resetsAt: S + 5 * 3600 - 300, spanSec: 5 * 3600 }, NOW)
    ).toBeNull();
    expect(
      forecastWindow({ pct: 6, resetsAt: S + 3.5 * 3600, spanSec: 5 * 3600 }, NOW)?.atReset
    ).toBeCloseTo(20, 1);
    // Whole-percent rounding makes anything under 5% too coarse to project.
    expect(forecastWindow({ pct: 2, resetsAt: S + 3.5 * 3600, spanSec: 5 * 3600 }, NOW)).toBeNull();
  });

  test("turns left from the last few context steps; a compaction starts over", () => {
    expect(estimateTurnsLeft([70, 72, 74, 76], 76)).toBe(12);
    expect(estimateTurnsLeft([76], 76)).toBeNull();
  });

  test("spans", () => {
    expect(formatSpan(41)).toBe("41s");
    expect(formatSpan(12_600)).toBe("3h30m");
    expect(formatSpan(5 * 86400 + 11 * 3600 + 40 * 60)).toBe("5d11h");
  });
});

describe("repo-controlled text", () => {
  test("a branch name cannot emit terminal controls", () => {
    const out = plain(base({ git: { branch: "main\u001b]0;owned\u0007\u001b[2Jx‮", dirty: 1 } }));
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
    expect(out).not.toContain("‮");
    expect(out).toContain("main");
  });
});
