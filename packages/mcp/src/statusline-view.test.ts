import { STATUSLINE_DENSITIES, STATUSLINE_STYLES } from "@sriinnu/tokmeter";
import { describe, expect, test } from "vitest";
import { estimateTurnsLeft } from "./statusline.js";
import {
  breakCause,
  fitForTest,
  forecastWindow,
  formatSpan,
  formatWhen,
  renderStatusline,
  type StatusView,
  textWidth,
} from "./statusline-view.js";

// 2026-10-18 16:19 local, the moment of the captured payload these mirror.
const NOW = new Date(2026, 9, 18, 16, 19, 0).getTime();
const S = NOW / 1000;
const plain = (v: StatusView, cols = 200) => renderStatusline(v, { cols, color: false });

/** This session's real payload numbers (cost, cache, windows). */
function base(overrides: Partial<StatusView> = {}): StatusView {
  return {
    now: NOW,
    project: "tokmeter",
    model: "Opus 5.5",
    effort: "med",
    ctx: { pct: 16, windowTokens: 1_000_000, turnsLeft: null },
    cache: { warm: true, expiresAt: S + 59 * 60, rebuildTokens: 150_839, hitRatio: 0.94 },
    cost: { usd: 25.98 },
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

/** Four breaks, the last one 40 seconds ago, as Claude Code 2.1.329 reports them. */
const BROKEN = {
  warm: true,
  expiresAt: S + 59 * 60,
  rebuildTokens: 150_839,
  hitRatio: 0.61,
  breaks: 4,
  breakTokens: 590_000,
  lastBreakAt: S - 40,
  lastBreakCauses: ["tools_changed"],
};

describe("normal session", () => {
  test("every number says what it covers, and a quiet session raises nothing", () => {
    const [l1, l2] = plain(base()).split("\n");
    expect(l1).toContain(" ◆ tokmeter ");
    expect(l1).toContain("Opus 5.5 · med");
    expect(l1).toContain("ctx ▰▱▱▱▱▱▱▱ 16%");
    expect(l1).toContain("cache 94% hit · 59m");
    expect(l1).toContain("session $26.0");
    expect(l1).toContain("⎇ fix/opencode-db-schema");
    expect(l2).toContain("5h 2% · 3h30m");
    expect(l2).toContain("7d 1%");
    expect(l2).toContain("today $75.3 · $9.42 here");
    expect(l2).not.toContain("⚠");
  });
});

describe("prompt cache: unknown is not cold", () => {
  test("warm with no expiry shows the hit share, not cold", () => {
    const out = plain(base({ cache: { warm: true, expiresAt: null, hitRatio: 0.94 } }));
    expect(out).toContain("cache 94% hit");
    expect(out).not.toContain("cold");
  });
  test("no word on warmth is not cold", () => {
    const out = plain(base({ cache: { warm: null, expiresAt: null, hitRatio: 0.5 } }));
    expect(out).toContain("cache 50% hit");
    expect(out).not.toContain("cold");
    expect(plain(base({ cache: { warm: null, expiresAt: null } }))).not.toContain("cache");
  });
  test("cold only when the harness says so or the expiry passed", () => {
    expect(plain(base({ cache: { warm: false, expiresAt: null } }))).toContain("cache cold");
    expect(plain(base({ cache: { warm: true, expiresAt: S - 1 } }))).toContain("cache cold");
  });
});

describe("prompt cache: hit share and breaks", () => {
  const l1 = (cache: StatusView["cache"]) => plain(base({ cache })).split("\n")[0];

  test("the hit share is the harness's own ratio, never recomputed or inverted", () => {
    const at = (hitRatio: number) =>
      l1({ warm: true, expiresAt: S + 3540, rebuildTokens: 150_839, hitRatio });
    expect(at(0.94)).toContain("cache 94% hit · 59m");
    expect(at(0.06)).toContain("cache 6% hit · 59m");
    expect(at(0)).toContain("cache 0% hit · 59m");
    expect(at(1)).toContain("cache 100% hit · 59m");
  });

  test("a harness that reports no ratio gets no percentage, not 0%", () => {
    for (const hitRatio of [undefined, null, Number.NaN]) {
      const out = l1({ warm: true, expiresAt: S + 3540, rebuildTokens: 150_839, hitRatio });
      expect(out).toContain("cache 59m");
      expect(out).not.toContain("hit");
      expect(out).not.toContain("0%");
    }
  });

  test("no breaks, no break count", () => {
    expect(l1(base().cache)).not.toContain("break");
    expect(l1({ ...BROKEN, breaks: 0 })).not.toContain("break");
  });

  test("breaks are counted on the cache segment for the rest of the session", () => {
    expect(l1(BROKEN)).toContain("cache 61% hit · 4 breaks · 59m");
    expect(l1({ ...BROKEN, breaks: 1 })).toContain("cache 61% hit · 1 break · 59m");
  });

  test("a break that just happened takes the alert slot, with its cause and its toll", () => {
    const l2 = plain(base({ cache: BROKEN })).split("\n")[1];
    expect(l2).toContain(
      "⚠ cache break 40s ago · tools changed · 4 this session, 590K tok re-cached"
    );
    const first = plain(
      base({ cache: { ...BROKEN, breaks: 1, breakTokens: 148_000, lastBreakCauses: [] } })
    );
    expect(first).toContain("⚠ cache break 40s ago · 148K tok re-cached");
  });

  test("an old break stays a count and raises no alert", () => {
    const out = plain(base({ cache: { ...BROKEN, lastBreakAt: S - 301 } }));
    expect(out).toContain("4 breaks");
    expect(out).not.toContain("⚠");
  });

  test("a break dated in the future (a skewed clock) raises no alert", () => {
    expect(plain(base({ cache: { ...BROKEN, lastBreakAt: S + 120 } }))).not.toContain("⚠");
  });

  test("anything about to cost the next turn outranks a break already paid for", () => {
    const l2 = plain(
      base({ cache: { ...BROKEN, expiresAt: S + 240 }, ctx: { pct: 86, turnsLeft: 6 } })
    ).split("\n")[1];
    expect(l2).toContain("⚠ context 86%");
    expect(l2).not.toContain("cache break");
    expect(plain(base({ cache: { ...BROKEN, expiresAt: S + 240 } })).split("\n")[1]).toContain(
      "⚠ cache cools in 4m"
    );
  });

  test("cause names: known ones in words, new ones as sent, unknown as nothing", () => {
    expect(breakCause(["ttl_expired_1h"])).toBe("idle past the 1h TTL");
    expect(breakCause(["system_prompt_changed", "tools_changed"])).toBe("system prompt changed +1");
    expect(breakCause(["some_new_cause"])).toBe("some new cause");
    expect(breakCause(["unknown"])).toBeNull();
    expect(breakCause([])).toBeNull();
    expect(breakCause(undefined)).toBeNull();
  });

  test("a cause name cannot emit terminal controls", () => {
    const out = plain(base({ cache: { ...BROKEN, lastBreakCauses: ["x\u001b]0;owned\u0007y"] } }));
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
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

  test("a 5h window on course to run out says when, on the segment and in the alert", () => {
    // 71% used 1h30m in → hits 100% about 37 minutes from now.
    const out = plain(base({ five: { pct: 71, resetsAt: S + 3.5 * 3600, spanSec: 5 * 3600 } }));
    expect(out).toMatch(/⚠ 5h limit at ~16:5\d at this pace · 2h\d+m before reset/);
    expect(out).toMatch(/5h 71% → out ~16:5\d/);
    // Never a projection past the limit: "237% by reset" is not a real number.
    expect(out).not.toMatch(/~\d{3,}%/);
  });

  test("a 7d forecast days away names the day, not just a clock time", () => {
    // 31% used 1.5 days in → runs out about 3.3 days from now.
    const out = plain(base({ seven: { pct: 31, resetsAt: S + 5.5 * 86400, spanSec: 7 * 86400 } }));
    expect(out).toMatch(/⚠ 7d limit at ~(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d at this pace/);
    expect(out).toMatch(/7d 31% → out ~(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d/);
  });

  test("a spent 5h window says so, with the reset and the 7d window", () => {
    const out = plain(
      base({
        five: { pct: 100, resetsAt: S + 72 * 60, spanSec: 5 * 3600 },
        seven: { pct: 34, resetsAt: S + 5 * 86400, spanSec: 7 * 86400 },
      })
    );
    expect(out).toContain("■ 5h limit reached · resets 17:31 (in 1h12m) · 7d 34%");
    expect(out).toContain("5h 100% · resets 17:31");
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

  test("an alert that beat others says how many are waiting", () => {
    const stacked = plain(
      base({
        ctx: { pct: 86, turnsLeft: 6 },
        five: { pct: 100, resetsAt: S + 72 * 60, spanSec: 5 * 3600 },
      })
    ).split("\n")[1];
    expect(stacked).toMatch(/■ 5h limit reached · resets 17:31 \(in 1h12m\)[^(]*\(\+1\)/);
    const alone = plain(base({ five: { pct: 100, resetsAt: S + 72 * 60, spanSec: 5 * 3600 } }));
    expect(alone).toContain("■ 5h limit reached");
    expect(alone).not.toContain("(+");
  });
});

describe("gateway spend limit", () => {
  const spend = { pct: 54, resetsAt: S + 12 * 86400, usedUsd: 27, limitUsd: 50, period: "monthly" };

  test("metered dollars against the limit, with the period", () => {
    const out = plain(base({ spend: { ...spend, period: "monthly" } }));
    expect(out).toContain("spend 54% · $27.0 of $50.0 monthly");
    expect(out).not.toContain("⚠");
  });

  test("a gateway that sends only a percentage gets only a percentage", () => {
    const out = plain(base({ spend: { pct: 54 } }));
    expect(out).toContain("spend 54%");
    expect(out).not.toContain(" of $");
  });

  test("near and past the limit", () => {
    expect(plain(base({ spend: { pct: 93 } }))).toContain("⚠ spend limit 93% used");
    expect(plain(base({ spend: { pct: 104, resetsAt: S + 3600 } }))).toContain(
      "■ spend limit reached · resets 17:19"
    );
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
    expect(out).toContain("today ~$75.3 · ~$9.42 here · 41s old");
  });

  test("a stopped daemon is a dash, never $0.00", () => {
    const out = plain(base({ today: { state: "down" }, repo: undefined }));
    expect(out).toContain("today — daemon offline");
    expect(out).not.toContain("$0.00");
  });

  test("this repo's part is shown inside today, never as a second total", () => {
    const l2 = plain(base()).split("\n")[1];
    expect(l2.match(/\$/g)).toHaveLength(2);
    expect(plain(base({ repo: undefined })).split("\n")[1]).not.toContain("here");
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
    // No cache telemetry from this harness: no cache segment, not "0% hit".
    expect(out).not.toContain("cache");
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

  test("a narrow terminal still shows which model answered and that it fell back", () => {
    const out = plain(
      ribhu({
        via: "chitragupta",
        provider: "ollama",
        model: "llama3.2:3b",
        authority: "fallback",
      }),
      44
    );
    expect(out).toContain("ollama/llama3.2:3b");
    expect(out).toContain("⚠ chitragupta fell back");
  });
});

describe("width", () => {
  const states: Record<string, StatusView> = {
    normal: base(),
    "fresh break": base({ cache: BROKEN }),
    "5h on course": base({ five: { pct: 71, resetsAt: S + 3.5 * 3600, spanSec: 5 * 3600 } }),
    "5h spent": base({ five: { pct: 100, resetsAt: S + 72 * 60, spanSec: 5 * 3600 } }),
    "context 97%": base({ ctx: { pct: 97, turnsLeft: 1 } }),
    "cache cold": base({ cache: { warm: false, expiresAt: null, rebuildTokens: 150_839 } }),
    "daemon down": base({ today: { state: "down" }, repo: undefined }),
    "long names": base({
      project: "agent-a50b67477698b126d-with-a-very-long-folder-name",
      git: { branch: "feature/a-branch-name-that-goes-on-and-on-and-on-forever", dirty: 3 },
    }),
  };

  test("no line is ever wider than the terminal, at any width, in any state", () => {
    for (const [name, view] of Object.entries(states)) {
      for (let cols = 1; cols <= 170; cols++) {
        for (const line of plain(view, cols).split("\n")) {
          expect([...line].length, `${name} at ${cols} cols: ${line}`).toBeLessThanOrEqual(cols);
        }
      }
    }
  });

  test("widening never drops something worth more than what it gained", () => {
    // The review's case: a cache break with a cause, both windows, today and here.
    const v = base({
      cache: BROKEN,
      five: { pct: 71, resetsAt: S + 3.5 * 3600, spanSec: 5 * 3600 },
      seven: { pct: 40, resetsAt: S + 5 * 86400, spanSec: 7 * 86400 },
    });
    let seen5h = false;
    for (let cols = 60; cols <= 220; cols++) {
      const l2 = plain(v, cols).split("\n")[1] ?? "";
      // 5h outranks everything that grows after it, so it never goes again.
      if (seen5h) expect(l2, `5h lost at ${cols}`).toContain("5h");
      seen5h ||= l2.includes("5h");
    }
    const wide = plain(v, 220).split("\n")[1];
    // The 5h forecast outranks the cache break, which waits behind it as (+2).
    for (const part of ["⚠ 5h limit at", "(+2)", "5h 71%", "7d 40%", "today $75.3", "$9.42 here"]) {
      expect(wide).toContain(part);
    }
  });

  test("fit: what is kept, ranked by worth, never gets worse as the line widens", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const text = (n: number) => [{ tone: "plain" as const, text: "x".repeat(n) }];
    for (let trial = 0; trial < 300; trial++) {
      const segs = Array.from({ length: 2 + rnd(6) }, () => {
        const full = 3 + rnd(30);
        const short = rnd(2) ? 1 + rnd(full - 1) : 0;
        return {
          prio: 1 + rnd(99),
          spans: text(full),
          ...(short ? { short: text(short), fullPrio: rnd(100) } : {}),
        };
      });
      // Worths a layout grants: being shown, and the long form when shown long.
      const worths = (cols: number) => {
        const kept = fitForTest(segs, cols);
        const out: number[] = [];
        let k = 0;
        segs.forEach((g) => {
          const got = kept[k];
          if (got === undefined || (got !== g.spans && got !== g.short)) return;
          k++;
          out.push(g.prio);
          if (got === g.spans && g.short) out.push(g.fullPrio ?? g.prio / 2);
        });
        return out.sort((a, b) => b - a);
      };
      const lexGe = (a: number[], b: number[]) => {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) > (b[i] ?? -1);
        }
        return true;
      };
      let prev = worths(1);
      for (let cols = 2; cols <= 200; cols++) {
        const cur = worths(cols);
        expect(lexGe(cur, prev), `trial ${trial} at ${cols}`).toBe(true);
        prev = cur;
      }
    }
  });

  test("double-width names count as two cells", () => {
    const wideCh = /[\u{3000}-\u{9fff}\u{ff00}-\u{ff60}]/u;
    const cells = (t: string) => [...t].reduce((n, ch) => n + (wideCh.test(ch) ? 2 : 1), 0);
    for (const cols of [40, 60, 80]) {
      for (const l of plain(base({ project: "日本語プロジェクト名前" }), cols).split("\n")) {
        expect(cells(l), `${cols}: ${l}`).toBeLessThanOrEqual(cols);
      }
    }
  });

  test("a worktree shows the repo's name, then gives up the (worktree) tag first", () => {
    const wide = plain(base({ project: "tokmeter", worktree: true }), 200);
    expect(wide).toContain("◆ tokmeter (worktree)");
    const narrow = plain(base({ project: "tokmeter", worktree: true }), 40).split("\n")[0];
    expect(narrow).toContain("◆ tokmeter");
    expect(narrow).not.toContain("worktree");
    expect(plain(base())).not.toContain("(worktree)");
  });

  test("99.6% is not shown as 100%", () => {
    const out = plain(base({ five: { pct: 99.6, resetsAt: S + 3600, spanSec: 5 * 3600 } }));
    expect(out).toContain("5h 99%");
    expect(out).not.toContain("100%");
  });

  test("a wide terminal loses nothing", () => {
    const [l1, l2] = plain(base(), 140).split("\n");
    expect(l1).toBe(
      " ◆ tokmeter  │ Opus 5.5 · med │ ctx ▰▱▱▱▱▱▱▱ 16% │ cache 94% hit · 59m │ session $26.0 │ ⎇ fix/opencode-db-schema │ #128"
    );
    expect(l2).toBe("5h 2% · 3h30m │ 7d 1% · 5d11h │ today $75.3 · $9.42 here");
  });

  test("80 columns shortens before it drops: context, cache and cost all survive", () => {
    const [l1, l2] = plain(base({ cache: BROKEN }), 80).split("\n");
    expect(l1).toContain("ctx");
    expect(l1).toContain("16%");
    expect(l1).toContain("cache 61% hit");
    expect(l1).toContain("$26.0");
    expect(l2).toContain("⚠ cache break");
    expect(l2).toContain("today $75.3");
  });

  test("60 columns keeps the alert and both plan windows beside it", () => {
    const l2 = plain(
      base({
        five: { pct: 71, resetsAt: S + 3.5 * 3600, spanSec: 5 * 3600 },
        seven: { pct: 12, resetsAt: S + 5 * 86400, spanSec: 7 * 86400 },
      }),
      60
    ).split("\n")[1];
    expect(l2).toMatch(/⚠ 5h limit at ~16:5\d/);
    expect(l2).toContain("5h 71%");
    expect(l2).toContain("7d 12%");
  });

  test("a single segment wider than the terminal is clipped, not left to wrap", () => {
    const out = plain(base({ project: "a-very-long-project-folder-name" }), 10);
    for (const line of out.split("\n")) expect([...line].length).toBeLessThanOrEqual(10);
    expect(out.split("\n")[0]).toMatch(/…$/);
  });

  test("color is plain text when disabled", () => {
    expect(plain(base())).not.toContain("\x1b[");
    expect(renderStatusline(base(), { cols: 200, color: true })).toContain("\x1b[");
  });
});

describe("dumb terminal", () => {
  test("ASCII mode emits nothing outside ASCII and keeps every number", () => {
    const view = base({
      cache: BROKEN,
      five: { pct: 71, resetsAt: S + 3.5 * 3600, spanSec: 5 * 3600 },
    });
    for (const cols of [60, 100, 200]) {
      const out = renderStatusline(view, { cols, color: false, ascii: true });
      for (const line of out.split("\n")) {
        expect(line).toMatch(/^[ -~]*$/);
        expect(line.length).toBeLessThanOrEqual(cols);
      }
    }
    const wide = renderStatusline(view, { cols: 200, color: false, ascii: true });
    expect(wide).toContain("ctx #------- 16%");
    expect(wide).toContain("cache 61% hit - 4 breaks - 59m");
    expect(wide).toContain("! 5h limit at ~");
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

  test("a time today is a clock; a time days away carries its weekday", () => {
    // NOW is Sunday 2026-10-18 16:19 local.
    expect(formatWhen(S + 37 * 60, S)).toBe("16:56");
    expect(formatWhen(new Date(2026, 9, 21, 0, 7, 0).getTime() / 1000, S)).toBe("Wed 00:07");
  });
});

describe("text from outside", () => {
  const hostile = "main\u001b]0;owned\u0007\u001b[2Jx‮";

  test("a branch name cannot emit terminal controls", () => {
    const out = plain(base({ git: { branch: hostile, dirty: 1 } }));
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
    expect(out).not.toContain("‮");
    expect(out).toContain("main");
  });

  test("nor can a folder name, a model label or a router's names", () => {
    const out = plain(
      base({
        project: hostile,
        model: hostile,
        effort: hostile,
        route: { via: hostile, provider: hostile, model: hostile, authority: "fallback" },
      })
    );
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
    expect(out).not.toContain("‮");
  });
});

describe("statusline v2: skins, densities, palettes, formats & wired signals", () => {
  const richView = (): StatusView =>
    base({
      worktree: "wt-feature",
      fastMode: true,
      ctx: { pct: 68, windowTokens: 1_000_000, turnsLeft: 9, exceeds200k: true },
      cost: { usd: 14.5, activeMs: 1_800_000 },
      today: { state: "fresh", usd: 54.2, ageMs: 2_000, paceMultiple: 1.6 },
      liveSessions: { count: 3, others: ["codex", "cursor"] },
      subagentToday: { cost: 9.8, share: 0.18, records: 12 },
      budget: { dailyThresholdUsd: 50, todayUsd: 54.2 },
      unpricedModelsCount: 2,
      linesDelta: { added: 142, removed: 38 },
      tokensLast: { in: 18_400, out: 4_200, cacheRead: 162_000, cacheWrite: 6_400 },
      quotas: [{ agent: "codex", label: "7d", pct: 24 }],
      pr: { number: 294, reviewState: "approved" },
    });

  test("all 5 skins × 3 densities stay within 40..150 columns", () => {
    const scenarios = [
      base(),
      richView(),
      base({ project: "日本語プロジェクト名", cache: BROKEN }),
    ];
    for (const style of STATUSLINE_STYLES) {
      for (const density of STATUSLINE_DENSITIES) {
        for (const view of scenarios) {
          for (let cols = 40; cols <= 150; cols += 5) {
            const out = renderStatusline(view, { cols, color: false, style, density });
            const lines = out.split("\n");
            if (density === "compact") expect(lines).toHaveLength(1);
            if (density === "balanced") expect(lines.length).toBeLessThanOrEqual(2);
            if (density === "telemetry") expect(lines.length).toBeLessThanOrEqual(3);
            for (const line of lines) {
              expect(
                textWidth(line),
                `style=${style} density=${density} cols=${cols}: ${line}`
              ).toBeLessThanOrEqual(cols);
            }
          }
        }
      }
    }
  });

  test("surfaces newly wired StatusView fields, budget alert, unpriced alert, and (+N) stacking", () => {
    const out = renderStatusline(richView(), {
      cols: 220,
      color: false,
      style: "rams",
      density: "telemetry",
    });
    const [l1, l2, l3] = out.split("\n");
    expect(l1).toContain("(wt-feature)");
    expect(l1).toContain("⚡fast");
    expect(l1).toContain("200K+");
    expect(l1).toContain("#294 ✓");
    expect(l2).toContain("⚠ daily budget $54.2 / $50");
    expect(l2).toContain("(+1)");
    expect(l2).toContain("+3 live (codex,cursor)");
    expect(l2).toContain("1.6×");
    expect(l3).toContain("last 18K in · 4K out · 162K cR · 6K cW");
    expect(l3).toContain("+142/-38 lines");
    expect(l3).toContain("sub $9.80 (18%)");
    expect(l3).toContain("codex 7d 24%");

    // Standalone unpriced alert when no higher alert preempts
    const unpricedOut = plain(base({ unpricedModelsCount: 2 }));
    expect(unpricedOut).toContain("⚠ 2 unpriced models ($0 in ledger)");
  });

  test("supports light, solarized-light, high-contrast palettes and ledger zero-bg mode", () => {
    const view = richView();
    const light = renderStatusline(view, {
      cols: 220,
      color: true,
      theme: "light",
    });
    expect(light).toContain("\x1b[38;2;31;35;40m"); // #1f2328 plain ink
    expect(light).toContain("\x1b[1;38;2;146;64;14;48;2;254;243;199m"); // light warn banner

    const solLight = renderStatusline(view, {
      cols: 220,
      color: true,
      theme: "solarized-light",
    });
    expect(solLight).toContain("\x1b[38;2;88;110;117m");

    const hc = renderStatusline(view, {
      cols: 140,
      color: true,
      theme: "high-contrast",
      style: "pill",
    });
    // High-contrast ok/bad uses cyan (#00ddff) & orange (#ff8800), not default green/red
    expect(hc).not.toContain("74;222;128");
    expect(hc).not.toContain("248;113;113");

    const ledger = renderStatusline(view, {
      cols: 140,
      color: true,
      theme: "light",
      style: "ledger",
    });
    // Zero ANSI 48;2 background escapes anywhere in ledger skin
    expect(ledger).not.toContain(";48;2;");
  });

  test("renders tmux, plain, and title formats cleanly within cols", () => {
    const view = richView();
    const tmux = renderStatusline(view, {
      cols: 120,
      color: true,
      format: "tmux",
      theme: "light",
    });
    expect(tmux).toContain("#[fg=");
    expect(tmux).not.toContain("\x1b[");

    const plainFmt = renderStatusline(view, {
      cols: 120,
      color: true,
      format: "plain",
    });
    expect(plainFmt).not.toContain("\x1b[");
    expect(plainFmt).not.toContain("#[fg=");

    const title = renderStatusline(view, {
      cols: 42,
      color: true,
      format: "title",
    });
    expect(title.startsWith("\x1b]0;")).toBe(true);
    expect(title.endsWith("\x07")).toBe(true);
    const inner = title.slice(4, -1);
    expect(textWidth(inner)).toBeLessThanOrEqual(42);
  });

  test("respects show.* section toggles and ASCII mapping across new glyphs", () => {
    const view = richView();
    const hidden = renderStatusline(view, {
      cols: 200,
      color: false,
      density: "telemetry",
      show: { git: false, pr: false, cache: false, windows: false, pace: false, linesDelta: false },
    });
    expect(hidden).not.toContain("fix/opencode-db-schema");
    expect(hidden).not.toContain("#294");
    expect(hidden).not.toContain("cache");
    expect(hidden).not.toContain("5h ");
    expect(hidden).not.toContain("1.6×");
    expect(hidden).not.toContain("+142/-38");

    const ascii = renderStatusline(view, {
      cols: 200,
      color: false,
      ascii: true,
      style: "deck",
      density: "telemetry",
    });
    for (const line of ascii.split("\n")) {
      expect(line).toMatch(/^[ -~]*$/);
    }
  });
});
