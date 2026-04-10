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
      "/mnt/c/Linsinger/CustomerCockpit/frontend",
      "C:\\Linsinger\\CustomerCockpit\\frontend",
      "-mnt-c-Linsinger-CustomerCockpit-frontend",
      "/mnt/c/Linsinger/CustomerCockpit/frontend.code-workspace",
    ];

    expect(inputs.map((value) => canonicalizeProjectName(value))).toEqual([
      "CustomerCockpit/frontend",
      "CustomerCockpit/frontend",
      "CustomerCockpit/frontend",
      "CustomerCockpit/frontend",
    ]);
  });

  it("preserves meaningful repo names from slugged workspace identifiers", () => {
    expect(canonicalizeProjectName("-mnt-c-sriinnu-personal-Kaala-brahma-clipforge-PAKT")).toBe(
      "clipforge-PAKT"
    );
    expect(canonicalizeProjectName("-mnt-c-sriinnu-personal-Json-ZEN")).toBe("Json-ZEN");
    expect(canonicalizeProjectName("-mnt-c-sriinnu-personal-Kaala-brahma-AUriva-chitragupta")).toBe(
      "chitragupta"
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
        project: "CustomerCockpit/frontend",
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

    expect(filterByProject(records, "/mnt/c/Linsinger/CustomerCockpit/frontend")).toHaveLength(1);
    expect(filterByProject(records, "-mnt-c-Linsinger-CustomerCockpit-frontend")).toHaveLength(1);
    expect(projectNameIncludes("CustomerCockpit/frontend", "frontend")).toBe(true);
  });
});
