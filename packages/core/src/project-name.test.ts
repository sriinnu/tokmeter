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
