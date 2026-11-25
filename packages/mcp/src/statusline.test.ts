import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveUsage, localDateKey } from "@sriinnu/tokmeter";
import { describe, expect, test, vi } from "vitest";
import type { SessionPush } from "./daemon/push.js";
import {
  afterOutput,
  buildAmbientStatusView,
  cacheFromInput,
  colorEnabled,
  findProjectTotal,
  formatAge,
  gitHeadPath,
  isConnectionRefused,
  isDumbTerminal,
  type PromptCacheInput,
  parseStatuslineArgs,
  readLastGoodToday,
  runGit,
  statuslineCacheDir,
} from "./statusline.js";

const dir = mkdtempSync(join(tmpdir(), "tokmeter-statusline-test-"));
const totals = (day: string, extra: Record<string, unknown> = {}) => ({
  cost: 75.3,
  in: 5_800_000,
  out: 442_800,
  projects: {},
  day,
  ...extra,
});

describe("readLastGoodToday — the fallback when the daemon misses the budget", () => {
  test("today's cached totals come back, aged from when the daemon computed them", () => {
    const path = join(dir, "today-ok.json");
    writeFileSync(
      path,
      JSON.stringify({
        ts: 5_000,
        key: "old-kosha",
        data: totals(localDateKey(), { computedAt: 4_000 }),
      })
    );
    expect(readLastGoodToday(path)).toEqual({
      totals: totals(localDateKey(), { computedAt: 4_000 }),
      ts: 4_000,
    });
  });

  test("an older daemon without computedAt falls back to the cache write time", () => {
    const path = join(dir, "today-legacy.json");
    writeFileSync(path, JSON.stringify({ ts: 5_000, data: totals(localDateKey()) }));
    expect(readLastGoodToday(path)?.ts).toBe(5_000);
  });

  test("yesterday's totals are never shown as today, however recent", () => {
    const path = join(dir, "today-yesterday.json");
    writeFileSync(path, JSON.stringify({ ts: Date.now(), data: totals("1999-01-01") }));
    expect(readLastGoodToday(path)).toBeNull();
  });

  test("a missing or corrupt cache is no fallback", () => {
    expect(readLastGoodToday(join(dir, "absent.json"))).toBeNull();
    const path = join(dir, "today-corrupt.json");
    writeFileSync(path, "{not json");
    expect(readLastGoodToday(path)).toBeNull();
  });
});

describe("isConnectionRefused — only a refused socket means the daemon is down", () => {
  test("fetch's ECONNREFUSED cause is down", () => {
    const err = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    expect(isConnectionRefused(err)).toBe(true);
  });

  test("a timeout abort is a busy daemon, not a dead one", () => {
    expect(isConnectionRefused(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isConnectionRefused(undefined)).toBe(false);
  });
});

describe("formatAge", () => {
  test("seconds, minutes, hours", () => {
    expect(formatAge(41_000)).toBe("41s");
    expect(formatAge(180_000)).toBe("3m");
    expect(formatAge(7_200_000)).toBe("2h");
  });
});

describe("statusline cache location", () => {
  test("uses $XDG_RUNTIME_DIR when set, else ~/.cache/tokmeter — never shared /tmp", () => {
    expect(statuslineCacheDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/u")).toBe(
      join("/run/user/1000", "tokmeter-statusline")
    );
    expect(statuslineCacheDir({}, "/home/u")).toBe(
      join("/home/u", ".cache", "tokmeter", "statusline")
    );
    // A relative runtime dir is not trusted.
    expect(statuslineCacheDir({ XDG_RUNTIME_DIR: "run" }, "/home/u")).toBe(
      join("/home/u", ".cache", "tokmeter", "statusline")
    );
  });
});

describe("repo commands", () => {
  test("a repo's core.fsmonitor hook is never executed by the statusline", () => {
    const repo = mkdtempSync(join(tmpdir(), "tokmeter-statusline-repo-"));
    const marker = join(repo, "fsmonitor-ran");
    const hook = join(repo, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hook, 0o755);
    const vcs = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    vcs("init", "-q");
    vcs("config", "core.fsmonitor", hook);
    writeFileSync(join(repo, "file.txt"), "x");

    expect(runGit(repo, ["status", "--porcelain"])).toContain("file.txt");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("cacheFromInput — the harness's cache ledger, passed through untouched", () => {
  // prompt_cache as Claude Code 2.1.329 sends it (schema read from the binary).
  const payload: PromptCacheInput = {
    warm: true,
    caching_observed: true,
    ttl: "1h",
    expires_at: 1_792_000_000,
    requests: 212,
    misses: 4,
    expected_rebuilds: 1,
    hit_ratio: 0.61,
    cache_write_tokens: 1_900_000,
    miss_recache_tokens: 590_000,
    last_miss_at: 1_791_999_000,
    last_miss_cause: { causes: ["tools_changed"] },
    miss_causes: { tools_changed: 3, ttl_expired_1h: 1 },
    recache_tokens_if_cold: 150_839,
  };

  test("every shown number is the payload's own, under the name the view uses", () => {
    expect(cacheFromInput(payload)).toEqual({
      warm: true,
      expiresAt: 1_792_000_000,
      rebuildTokens: 150_839,
      hitRatio: 0.61,
      breaks: 4,
      breakTokens: 590_000,
      lastBreakAt: 1_791_999_000,
      lastBreakCauses: ["tools_changed"],
    });
  });

  test("no caching observed is no cache view at all, never a 0% hit rate", () => {
    expect(cacheFromInput(undefined)).toBeUndefined();
    expect(cacheFromInput({ ...payload, caching_observed: false })).toBeUndefined();
    expect(cacheFromInput({ warm: true, hit_ratio: 0 })).toBeUndefined();
  });

  test("an older Claude Code that sends fewer fields gets fewer, not zeros", () => {
    expect(
      cacheFromInput({ warm: true, caching_observed: true, expires_at: 5, hit_ratio: null })
    ).toEqual({ warm: true, expiresAt: 5, rebuildTokens: null });
  });

  test("zero misses and junk values are left out", () => {
    const view = cacheFromInput({
      ...payload,
      misses: 0,
      miss_recache_tokens: 0,
      last_miss_at: null,
      last_miss_cause: null,
      hit_ratio: Number.NaN,
    });
    expect(view).toEqual({ warm: true, expiresAt: 1_792_000_000, rebuildTokens: 150_839 });
  });

  test("Claude Code's hit_ratio and core's cacheHitRate are one definition", () => {
    // hit_ratio = cache_read / (cache_read + cache_creation + uncached input).
    const usage = { inputTokens: 1_200, cacheReadTokens: 157_000, cacheWriteTokens: 2_100 };
    const claudeCode =
      usage.cacheReadTokens / (usage.cacheReadTokens + usage.cacheWriteTokens + usage.inputTokens);
    const core = deriveUsage({ ...usage, outputTokens: 900, reasoningTokens: 0 });
    expect(core.cacheHitRate).toBeCloseTo(claudeCode, 12);
  });
});

describe("plain terminals", () => {
  test("NO_COLOR and TERM=dumb turn color off; FORCE_COLOR decides when set", () => {
    expect(colorEnabled({})).toBe(true);
    expect(colorEnabled({ NO_COLOR: "1" })).toBe(false);
    expect(colorEnabled({ TERM: "dumb" })).toBe(false);
    expect(colorEnabled({ TERM: "dumb", FORCE_COLOR: "3" })).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" })).toBe(false);
  });

  test("only a terminal that says it is dumb gets ASCII glyphs", () => {
    expect(isDumbTerminal({ TERM: "dumb" })).toBe(true);
    expect(isDumbTerminal({ TERM: "xterm-256color", NO_COLOR: "1" })).toBe(false);
    expect(isDumbTerminal({})).toBe(false);
  });
});

describe("gitHeadPath — where a checkout's HEAD lives", () => {
  const scratch = mkdtempSync(join(tmpdir(), "tokmeter-statusline-head-"));

  test("a plain repo", () => {
    const repo = join(scratch, "plain");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(gitHeadPath(repo)).toBe(join(repo, ".git", "HEAD"));
  });

  test("a linked worktree, whose .git is a file naming its git dir", () => {
    const gitDir = join(scratch, "main", ".git", "worktrees", "wt");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
    const worktree = join(scratch, "wt");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    expect(gitHeadPath(worktree)).toBe(join(gitDir, "HEAD"));
    // A relative gitdir (git worktree add --relative-paths) resolves from cwd.
    const relative = join(scratch, "wt-relative");
    mkdirSync(relative);
    writeFileSync(join(relative, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
    expect(gitHeadPath(relative)).toBe(join(gitDir, "HEAD"));
  });

  test("not a repo, or a .git file that names nothing real", () => {
    expect(gitHeadPath(join(scratch, "absent"))).toBeNull();
    const broken = join(scratch, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, ".git"), "gitdir: /nonexistent/tokmeter-test\n");
    expect(gitHeadPath(broken)).toBeNull();
    writeFileSync(join(broken, ".git"), "not a pointer\n");
    expect(gitHeadPath(broken)).toBeNull();
  });
});

describe("afterOutput — the line first, the daemon push after", () => {
  const push: SessionPush = {
    session: { provider: "claude-code", sessionId: "s", model: "m" },
    cost: 0,
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };

  test("pushes only after stdout has drained", async () => {
    const order: string[] = [];
    let pending = 1;
    const length = vi
      .spyOn(process.stdout, "writableLength", "get")
      .mockImplementation(() => pending);
    const done = afterOutput(push, async () => {
      order.push(`push (buffered=${pending})`);
      return true;
    });
    await new Promise((r) => setTimeout(r, 10));
    order.push("drain");
    pending = 0;
    process.stdout.emit("drain");
    await done;
    length.mockRestore();
    expect(order).toEqual(["drain", "push (buffered=0)"]);
  });

  test("a push that never settles is abandoned at the hard cap", async () => {
    const started = Date.now();
    await afterOutput(push, () => new Promise<boolean>(() => {}), 60);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("a failing push is swallowed; no session means no push", async () => {
    await expect(
      afterOutput(push, async () => {
        throw new Error("daemon exploded");
      })
    ).resolves.toBeUndefined();
    const send = vi.fn(async () => true);
    await afterOutput(null, send);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("untyped payload fields", () => {
  test("only a known route authority and a real PR number reach the line", async () => {
    const { routeFromInput } = await import("./statusline.js");
    const r = routeFromInput({
      route: { via: "ribhu", authority: "\x1b[2Jboom", recent_total: Number.NaN },
    } as never);
    expect(r?.authority).toBeUndefined();
    expect(r?.recent).toBeUndefined();
    expect(
      routeFromInput({ route: { via: "ribhu", authority: "pinned" } } as never)?.authority
    ).toBe("pinned");
  });
});

describe('findProjectTotal (the "here" slot)', () => {
  const totals = (projects: Record<string, { cost: number; in: number; out: number }>) => ({
    cost: 10,
    in: 0,
    out: 0,
    projects,
    day: "2026-11-20",
  });

  test("a session in a Claude Code worktree finds its repo's total", () => {
    const t = totals({ tokmeter: { cost: 3, in: 1, out: 1 }, AUriva: { cost: 7, in: 1, out: 1 } });
    const wt = "/Users/me/Sriinnu/Personal/tokmeter/.claude/worktrees/agent-a50b67477698b126d";
    expect(findProjectTotal(t, wt)?.cost).toBe(3);
    expect(findProjectTotal(t, "/Users/me/Sriinnu/Personal/tokmeter")?.cost).toBe(3);
  });

  test("matches whole names only, and sums keys that name one project", () => {
    const t = totals({
      webapp: { cost: 4, in: 1, out: 1 },
      "packages/web": { cost: 2, in: 1, out: 1 },
      Tokmeter: { cost: 1, in: 1, out: 1 },
      tokmeter: { cost: 2, in: 1, out: 1 },
    });
    expect(findProjectTotal(t, "/Users/me/src/app")).toBeNull();
    expect(findProjectTotal(t, "/Users/me/src/tokmeter/packages/web")?.cost).toBe(2);
    expect(findProjectTotal(t, "/Users/me/src/tokmeter")?.cost).toBe(3);
    expect(findProjectTotal(t, "")).toBeNull();
  });

  test("a repo whose name has a dash, dot or acronym finds its Claude Code total", () => {
    // Claude Code names these from its slug; Codex and others from the path.
    const t = totals({
      docs: { cost: 4, in: 1, out: 1 },
      "harness-docs": { cost: 1, in: 1, out: 1 },
      "clipforge-PAKT": { cost: 2, in: 1, out: 1 },
      dev: { cost: 3, in: 1, out: 1 },
    });
    expect(findProjectTotal(t, "/Users/me/Sriinnu/Personal/harness-docs")?.cost).toBe(5);
    expect(findProjectTotal(t, "/Users/me/Sriinnu/clipforge/PAKT")?.cost).toBe(2);
    expect(findProjectTotal(t, "/Users/me/websites/Srinivas.dev")?.cost).toBe(3);
  });

  test("a ledger key is never renamed by the path rules", () => {
    const t = totals({
      "ribhu/eval": { cost: 6, in: 1, out: 1 },
      eval: { cost: 1, in: 1, out: 1 },
    });
    expect(findProjectTotal(t, "/Users/me/.ribhu/eval/work/r/t/1")?.cost).toBe(6);
    expect(findProjectTotal(t, "/Users/me/src/eval")?.cost).toBe(1);
  });
});

describe("parseStatuslineArgs & buildAmbientStatusView", () => {
  test("parses multi-CLI flags (--ambient, --agent, --watch, --style, --density, --theme, --format, --cols)", () => {
    const opts = parseStatuslineArgs([
      "--ambient",
      "--agent",
      "codex",
      "--style=deck",
      "--density",
      "telemetry",
      "--theme",
      "light",
      "--format",
      "tmux",
      "--cols",
      "90",
      "--watch",
      "1500",
      "--no-color",
    ]);
    expect(opts).toEqual({
      ambient: true,
      agent: "codex",
      style: "deck",
      density: "telemetry",
      theme: "light",
      format: "tmux",
      cols: 90,
      watch: true,
      watchMs: 1500,
      noColor: true,
    });
  });

  test("builds ambient view without stdin using injected daemon context and marks estimated ctx ~%", async () => {
    const now = new Date(2026, 10, 20, 14, 15, 0).getTime();
    const view = await buildAmbientStatusView(
      {
        ambient: true,
        agent: "codex",
        cwd: "/tmp/my-repo",
        watch: false,
        watchMs: 2000,
        noColor: false,
      },
      {
        homeDir: dir,
        now,
        context: {
          state: "fresh",
          ageMs: 2000,
          ctx: {
            today: {
              cost: 48.0,
              in: 500_000,
              out: 100_000,
              day: localDateKey(now),
              projects: { "my-repo": { cost: 12.0, in: 100_000, out: 20_000 } },
              computedAt: now,
            },
            repo: { name: "my-repo", cost: 12.0, in: 100_000, out: 20_000 },
            liveSessions: {
              count: 2,
              others: ["claude-code"],
              active: [
                {
                  provider: "codex",
                  sessionId: "c1",
                  model: "gpt-5",
                  cost: 5.5,
                  contextFillPct: 58,
                  lastUpdate: now,
                },
              ],
            },
            paceMultiple: 1.4,
            subagentToday: { cost: 0, share: 0, records: 0 },
            dailyCostThreshold: 40,
            unpricedModelsCount: 0,
            quotas: [
              {
                agent: "codex",
                window: "7d",
                windowMinutes: 10080,
                usedPct: 24,
                windowStart: Math.floor(now / 1000) - 3600,
                resetsAt: Math.floor(now / 1000) + 500000,
                sampledAt: now,
                avgPctPerHour: 1,
                recentPctPerHour: null,
                projectedPctAtReset: 50,
                hitsLimitBeforeReset: false,
                verdict: "resets-first",
              },
            ],
            computedAt: now,
          },
        },
      }
    );

    expect(view.project).toBe("my-repo");
    expect(view.model).toBe("gpt-5");
    expect(view.ctx.pct).toBe(58);
    expect(view.ctx.estimated).toBe(true);
    expect(view.seven?.pct).toBe(24);
    expect(view.today.usd).toBe(48.0);
    expect(view.repo?.usd).toBe(12.0);
    expect(view.budget).toEqual({ dailyThresholdUsd: 40, todayUsd: 48.0 });
    expect(view.liveSessions).toEqual({ count: 2, others: ["claude-code"] });
  });
});
