import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDateKey } from "@sriinnu/tokmeter";
import { describe, expect, test } from "vitest";
import {
  formatAge,
  isConnectionRefused,
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
      "/run/user/1000/tokmeter-statusline"
    );
    expect(statuslineCacheDir({}, "/home/u")).toBe("/home/u/.cache/tokmeter/statusline");
    // A relative runtime dir is not trusted.
    expect(statuslineCacheDir({ XDG_RUNTIME_DIR: "run" }, "/home/u")).toBe(
      "/home/u/.cache/tokmeter/statusline"
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
