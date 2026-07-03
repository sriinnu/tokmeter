import type { ProviderId } from "@sriinnu/tokmeter";
import { describe, expect, test } from "vitest";
import { DAEMON_READ_ENDPOINTS, daemonReadEligible } from "./daemon-read.js";

describe("daemonReadEligible — the 'silently wrong numbers' guard", () => {
  test("unfiltered supported commands are daemon-eligible", () => {
    for (const cmd of Object.keys(DAEMON_READ_ENDPOINTS)) {
      expect(daemonReadEligible(cmd, {})).toBe(true);
    }
  });

  test("unknown / differently-shaped commands scan", () => {
    expect(daemonReadEligible("overview", {})).toBe(false);
    expect(daemonReadEligible("digest", {})).toBe(false);
    expect(daemonReadEligible("", {})).toBe(false);
  });

  test("any date/window/project narrowing forces a scan (daemon serves lifetime)", () => {
    expect(daemonReadEligible("stats", { today: true })).toBe(false);
    expect(daemonReadEligible("stats", { week: true })).toBe(false);
    expect(daemonReadEligible("stats", { month: true })).toBe(false);
    expect(daemonReadEligible("stats", { year: 2026 })).toBe(false);
    expect(daemonReadEligible("daily", { since: "2026-01-01" })).toBe(false);
    expect(daemonReadEligible("daily", { until: "2026-06-01" })).toBe(false);
    expect(daemonReadEligible("models", { project: "demo" })).toBe(false);
  });

  test("provider filter is fine for stats/daily/models (endpoints honor ?providers=)", () => {
    const providers = ["codex"] as ProviderId[];
    expect(daemonReadEligible("stats", { providers })).toBe(true);
    expect(daemonReadEligible("daily", { providers })).toBe(true);
    expect(daemonReadEligible("models", { providers })).toBe(true);
  });

  test("projects + provider filter scans — /api/projects ignores ?providers=", () => {
    const providers = ["codex"] as ProviderId[];
    expect(daemonReadEligible("projects", { providers })).toBe(false);
    // …but projects with no provider narrowing is eligible.
    expect(daemonReadEligible("projects", {})).toBe(true);
    expect(daemonReadEligible("projects", { providers: [] })).toBe(true);
  });

  test("the today guard specifically prevents the documented lifetime-leak bug", () => {
    // `tokmeter stats --json --today --codex` must never get all-time numbers.
    const providers = ["codex"] as ProviderId[];
    expect(daemonReadEligible("stats", { today: true, providers })).toBe(false);
  });

  test("every eligible command has a route", () => {
    for (const cmd of Object.keys(DAEMON_READ_ENDPOINTS)) {
      expect(daemonReadEligible(cmd, {})).toBe(true);
      expect(DAEMON_READ_ENDPOINTS[cmd]).toMatch(/^\/api\//);
    }
  });
});
