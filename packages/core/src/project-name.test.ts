import { describe, expect, it } from "vitest";
import { filterByProject } from "./aggregator.js";
import {
  canonicalizeProjectName,
  projectMatchKey,
  projectNameIncludes,
  projectNamesMatch,
} from "./project-name.js";
import type { TokenRecord } from "./types.js";

describe("project-name helpers", () => {
  it("names an eval harness's trial folders for the tool, not the trial number", () => {
    const evalDir = "/Users/me/.ribhu/eval/work/1794565623-38179/footer-repeats/core/1";
    const evalSlug =
      "-Users-me--ribhu-eval-work-1794565623-38179-mcp-only-extension-dropped-on-restart-core-1";
    expect(canonicalizeProjectName(evalDir)).toBe("ribhu/eval");
    expect(canonicalizeProjectName(evalSlug)).toBe("ribhu/eval");
    expect(projectMatchKey(evalSlug)).not.toBe(projectMatchKey("ribhu"));
  });

  it("keeps ordinary projects, config dot-folders and one-deep tool folders as before", () => {
    expect(canonicalizeProjectName("/Users/me/Sriinnu/Personal/tokmeter")).toBe("tokmeter");
    expect(canonicalizeProjectName("-Users-me-Sriinnu-Personal-tokmeter")).toBe("tokmeter");
    expect(canonicalizeProjectName("/Users/me/.dotfiles/nvim")).toBe("nvim");
    expect(canonicalizeProjectName("/Users/me/.codex/worktrees/a1b2/AUriva")).toBe("AUriva");
    expect(canonicalizeProjectName("-Users-me--codex-worktrees-ribhu-routing-repair-AUriva")).toBe(
      "AUriva"
    );
    expect(canonicalizeProjectName("/home/me/.config/nvim/lua")).toBe("lua");
    expect(canonicalizeProjectName("-Users-me--config-nvim-lua")).toBe("lua");
  });

  it("names a per-run temp workspace for its prefix, not its random tail", () => {
    const mac = "/private/var/folders/3p/3f62sd0j57/T/ribhu-live-ws-06Wwnk";
    const macSlug = "-private-var-folders-3p-3f62sd0j57114nppqn2x67hm0000gn-T-ribhu-live-ws-9AGabi";
    expect(canonicalizeProjectName(mac)).toBe("ribhu-live-ws");
    expect(canonicalizeProjectName(macSlug)).toBe("ribhu-live-ws");
    expect(canonicalizeProjectName("/tmp/tmp.Ab3dE9xQ")).toBe("tmp");
    expect(canonicalizeProjectName("-private-tmp-scratch")).toBe("scratch");
    expect(
      canonicalizeProjectName(
        "-private-tmp-claude-501--Users-me-Personal-ribhu-17228982-scratchpad-ux"
      )
    ).toBe("ux");
    expect(canonicalizeProjectName("/tmp/build-server")).toBe("build-server");
    expect(canonicalizeProjectName("/tmp/accept2417")).toBe("accept2417");
    expect(canonicalizeProjectName("/tmp/work/Harbor")).toBe("Harbor");
  });

  it("never lets a bare number stand alone as a project name", () => {
    expect(canonicalizeProjectName("/Users/me/work/runs/3")).toBe("runs/3");
    expect(canonicalizeProjectName("-Users-me-work-runs-3")).toBe("runs/3");
  });

  it("canonicalizes Windows, WSL, and slugged frontend workspaces to one project label", () => {
    const inputs = [
      "/mnt/c/Acme/WeatherApp/frontend",
      "C:\\Acme\\WeatherApp\\frontend",
      "-mnt-c-Acme-WeatherApp-frontend",
      "/mnt/c/Acme/WeatherApp/frontend.code-workspace",
    ];

    expect(inputs.map((value) => canonicalizeProjectName(value))).toEqual([
      "WeatherApp/frontend",
      "WeatherApp/frontend",
      "WeatherApp/frontend",
      "WeatherApp/frontend",
    ]);
  });

  it("preserves meaningful repo names from slugged workspace identifiers", () => {
    expect(canonicalizeProjectName("-mnt-c-sriinnu-personal-Kaala-brahma-clipforge-PAKT")).toBe(
      "clipforge-PAKT"
    );
    expect(canonicalizeProjectName("-mnt-c-sriinnu-personal-Json-ZEN")).toBe("Json-ZEN");
    expect(canonicalizeProjectName("-mnt-c-sriinnu-personal-Kaala-brahma-AUriva-Auditor")).toBe(
      "Auditor"
    );
  });

  it("preserves plain hyphenated names that are not encoded paths", () => {
    expect(canonicalizeProjectName("feature-branch-long-name")).toBe("feature-branch-long-name");
    expect(canonicalizeProjectName("customer-cockpit-live-monitor")).toBe(
      "customer-cockpit-live-monitor"
    );
  });

  it("builds identical match keys for cross-platform variants of the same project", () => {
    const wslPath = "/mnt/c/sriinnu/personal/Kaala-brahma/clipforge-PAKT";
    const windowsPath = "C:\\sriinnu\\personal\\Kaala-brahma\\clipforge-PAKT";
    const slugPath = "-mnt-c-sriinnu-personal-Kaala-brahma-clipforge-PAKT";

    expect(projectMatchKey(wslPath)).toBe(projectMatchKey(windowsPath));
    expect(projectMatchKey(windowsPath)).toBe(projectMatchKey(slugPath));
    expect(projectNamesMatch(wslPath, slugPath)).toBe(true);
  });

  it("matches canonical project names against path-like queries", () => {
    const records: TokenRecord[] = [
      {
        timestamp: 1_710_000_000_000,
        project: "WeatherApp/frontend",
        provider: "codex",
        model: "gpt-4.1",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cost: 1,
      },
    ];

    expect(filterByProject(records, "/mnt/c/Acme/WeatherApp/frontend")).toHaveLength(1);
    expect(filterByProject(records, "-mnt-c-Acme-WeatherApp-frontend")).toHaveLength(1);
    expect(projectNameIncludes("WeatherApp/frontend", "frontend")).toBe(true);
  });
});
