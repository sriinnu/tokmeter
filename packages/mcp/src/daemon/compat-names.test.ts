import { describe, expect, test } from "vitest";
import {
  API_HEADER,
  DAEMON_CHILD_FLAG,
  LEGACY_API_HEADER,
  LEGACY_DAEMON_CHILD_FLAG,
  apiVersionHeaders,
  daemonChildEnv,
  isDaemonChildEnv,
} from "./compat-names.js";
import { renderAgentPlist } from "./launchd.js";

describe("API version headers (tokmeter + legacy drishti spelling)", () => {
  test("both are sent, current name first, with matching versions", () => {
    expect(apiVersionHeaders(3)).toEqual([
      ["X-Tokmeter-API", "tokmeter-api/3"],
      ["X-Drishti-API", "drishti-api/3"],
    ]);
    expect(API_HEADER).toBe("X-Tokmeter-API");
    expect(LEGACY_API_HEADER).toBe("X-Drishti-API");
  });
});

describe("daemon-child env flag", () => {
  test("either spelling marks the child", () => {
    expect(isDaemonChildEnv({ [DAEMON_CHILD_FLAG]: "1" })).toBe(true);
    expect(isDaemonChildEnv({ [LEGACY_DAEMON_CHILD_FLAG]: "1" })).toBe(true);
    expect(isDaemonChildEnv({ [DAEMON_CHILD_FLAG]: "1", [LEGACY_DAEMON_CHILD_FLAG]: "1" })).toBe(
      true
    );
  });

  test("neither, or anything other than '1', is not a child", () => {
    expect(isDaemonChildEnv({})).toBe(false);
    expect(isDaemonChildEnv({ [DAEMON_CHILD_FLAG]: "0" })).toBe(false);
    expect(isDaemonChildEnv({ [LEGACY_DAEMON_CHILD_FLAG]: "true" })).toBe(false);
  });

  test("spawning sets both spellings, so an older daemon binary still sees its flag", () => {
    expect(daemonChildEnv()).toEqual({
      __TOKMETER_DAEMON_CHILD__: "1",
      __DRISHTI_DAEMON_CHILD__: "1",
    });
  });

  test("a plist written by an older release (legacy flag only) still starts the daemon", () => {
    // What launchd hands the process from a plist that predates the rename.
    const envFromOldPlist = {
      __DRISHTI_DAEMON_CHILD__: "1",
      NODE_OPTIONS: "--max-old-space-size=512",
    };
    expect(isDaemonChildEnv(envFromOldPlist)).toBe(true);
  });

  test("a newly generated plist carries both flags, so an older daemon still runs in the foreground", () => {
    const plist = renderAgentPlist({
      nodePath: "/usr/local/bin/node",
      cliEntry: "/opt/tokmeter-mcp/dist/cli.js",
      heapMb: 512,
      logDir: "/tmp/tokmeter-test-logs",
    });
    for (const key of ["__TOKMETER_DAEMON_CHILD__", "__DRISHTI_DAEMON_CHILD__"]) {
      expect(plist).toMatch(new RegExp(`<key>${key}</key>\\s*<string>1</string>`));
    }
  });
});
