import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attributeGitBranchCost,
  inspectGitBranch,
  renderGitCostMarkdown,
  renderGitCostText,
} from "./git-cost.js";
import type { TokenRecord } from "./types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("git branch cost attribution", () => {
  it("inspects a branch window relative to base and attributes cwd and fallback records", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tokmeter-git-cost-")));
    dirs.push(repo);

    const baseEnv = {
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: "2026-11-26T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-11-26T10:00:00Z",
    };
    const branchEnv = {
      ...baseEnv,
      GIT_AUTHOR_DATE: "2026-11-27T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-11-27T12:00:00Z",
    };

    git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"], baseEnv);

    git(repo, ["checkout", "-b", "feat/pr-cost"]);
    writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");
    git(repo, ["add", "feature.ts"]);
    git(repo, ["commit", "-m", "add feature"], branchEnv);

    const win = inspectGitBranch(repo, {
      base: "main",
      leadMinutes: 30,
      now: Date.parse("2026-11-27T13:00:00Z"),
    });
    expect(win.branch).toBe("feat/pr-cost");
    expect(win.baseRef).toBe("main");
    expect(win.commitCount).toBe(1);
    expect(win.windowBasis).toBe("branch-commits");
    expect(win.windowStartMs).toBe(Date.parse("2026-11-27T11:30:00Z"));

    const records: TokenRecord[] = [
      // Inside window + repo subpath cwd
      {
        timestamp: Date.parse("2026-11-27T11:45:00Z"),
        provider: "claude-code",
        model: "claude-opus-4-6",
        project: "ignored",
        cwd: join(repo, "packages"),
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 9000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 10500,
        cost: 1.25,
        isSubagent: true,
      },
      // Inside window, no cwd -> project fallback
      {
        timestamp: Date.parse("2026-11-27T12:10:00Z"),
        provider: "codex",
        model: "gpt-5.6",
        project: win.repoName,
        inputTokens: 500,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 700,
        cost: 0.75,
        kind: "compaction",
      },
      // Outside window (before lead time)
      {
        timestamp: Date.parse("2026-11-27T10:00:00Z"),
        provider: "claude-code",
        model: "claude-opus-4-6",
        project: win.repoName,
        cwd: repo,
        inputTokens: 9999,
        outputTokens: 9999,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 19998,
        cost: 99,
      },
      // Different repo cwd
      {
        timestamp: Date.parse("2026-11-27T12:05:00Z"),
        provider: "claude-code",
        model: "claude-opus-4-6",
        project: "other-repo",
        cwd: "/tmp/completely-different-repo",
        inputTokens: 500,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1000,
        cost: 50,
      },
    ];

    const report = attributeGitBranchCost(records, win);
    expect(report.matchedRecords).toBe(2);
    expect(report.directCwdMatches).toBe(1);
    expect(report.projectFallbackMatches).toBe(1);
    expect(report.totalCost).toBeCloseTo(2.0, 5);
    expect(report.subagentCost).toBeCloseTo(1.25, 5);
    expect(report.compactionCost).toBeCloseTo(0.75, 5);
    expect(report.compactionEvents).toBe(1);
    expect(renderGitCostText(report)).toContain("feat/pr-cost");
    const md = renderGitCostMarkdown(report);
    expect(md).toContain("<details>");
    expect(md).toContain("$2.00");
  });

  it("rejects unsafe git refs containing option flags or '..'", () => {
    expect(() => inspectGitBranch(process.cwd(), { base: "--exec=evil" })).toThrow();
    expect(() => inspectGitBranch(process.cwd(), { base: "main..HEAD" })).toThrow();
  });
});
