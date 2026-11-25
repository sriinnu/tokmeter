import type { ProviderId } from "@sriinnu/tokmeter";
import { describe, expect, test } from "vitest";
import {
  buildDaemonReadQuery,
  DAEMON_READ_ENDPOINTS,
  daemonReadEligible,
  resolveDaemonHttpBase,
  resolveDaemonWsPort,
} from "./daemon-read.js";

describe("daemonReadEligible & scoped query routing", () => {
  test("unfiltered supported read commands (including overview) are daemon-eligible", () => {
    for (const cmd of Object.keys(DAEMON_READ_ENDPOINTS)) {
      expect(daemonReadEligible(cmd, {})).toBe(true);
    }
  });

  test("unknown or non-summary commands fall back to their dedicated paths", () => {
    expect(daemonReadEligible("digest", {})).toBe(false);
    expect(daemonReadEligible("cleanup", {})).toBe(false);
    expect(daemonReadEligible("", {})).toBe(false);
  });

  test("scoped date, window, project, and provider queries are daemon-eligible", () => {
    const providers = ["codex", "claude-code"] as ProviderId[];
    expect(daemonReadEligible("stats", { today: true, providers })).toBe(true);
    expect(daemonReadEligible("overview", { week: true, project: "alpha" })).toBe(true);
    expect(daemonReadEligible("daily", { month: true, since: "2026-10-01" })).toBe(true);
    expect(daemonReadEligible("models", { year: 2026, until: "2026-12-31" })).toBe(true);
    expect(daemonReadEligible("projects", { providers: ["codex"] })).toBe(true);
  });

  test("--light and --rescan-history force local scans", () => {
    expect(daemonReadEligible("stats", { light: true })).toBe(false);
    expect(daemonReadEligible("overview", { rescanHistory: true })).toBe(false);
  });

  test("buildDaemonReadQuery serializes filters cleanly", () => {
    expect(buildDaemonReadQuery({})).toBe("");
    const qs = buildDaemonReadQuery({
      providers: ["claude-code", "codex"],
      project: "alpha app",
      since: "2026-10-01",
      until: "2026-10-15",
      today: true,
      year: 2026,
    });
    const params = new URLSearchParams(qs.slice(1));
    expect(params.get("providers")).toBe("claude-code,codex");
    expect(params.get("project")).toBe("alpha app");
    expect(params.get("since")).toBe("2026-10-01");
    expect(params.get("until")).toBe("2026-10-15");
    expect(params.get("today")).toBe("true");
    expect(params.get("year")).toBe("2026");
  });

  test("resolveDaemonWsPort and resolveDaemonHttpBase honor TOKMETER_DAEMON_PORT", () => {
    expect(resolveDaemonWsPort({})).toBe(9876);
    expect(resolveDaemonHttpBase({})).toBe("http://127.0.0.1:9877");

    expect(resolveDaemonWsPort({ TOKMETER_DAEMON_PORT: "10500" })).toBe(10500);
    expect(resolveDaemonHttpBase({ TOKMETER_DAEMON_PORT: "10500" })).toBe("http://127.0.0.1:10501");

    // Out-of-range or malformed falls back safely to default 9876/9877
    expect(resolveDaemonWsPort({ TOKMETER_DAEMON_PORT: "80" })).toBe(9876);
    expect(resolveDaemonWsPort({ TOKMETER_DAEMON_PORT: "99999" })).toBe(9876);
    expect(resolveDaemonWsPort({ TOKMETER_DAEMON_PORT: "abc" })).toBe(9876);
  });

  test("every eligible command has an /api route", () => {
    for (const cmd of Object.keys(DAEMON_READ_ENDPOINTS)) {
      expect(daemonReadEligible(cmd, {})).toBe(true);
      expect(DAEMON_READ_ENDPOINTS[cmd]).toMatch(/^\/api\//);
    }
  });
});
