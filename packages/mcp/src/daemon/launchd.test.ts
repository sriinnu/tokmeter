import { describe, expect, test } from "vitest";
import { renderAgentPlist } from "./launchd.js";

const plist = renderAgentPlist({
  nodePath: "/opt/homebrew/bin/node",
  cliEntry: "/tmp/tokmeter/cli.js",
  heapMb: 6144,
  logDir: "/tmp/tokmeter-logs",
});

describe("renderAgentPlist", () => {
  test("the daemon runs at a normal priority, not launchd's throttled Background tier", () => {
    // Background starved the daemon to ~2% CPU under load and the statusline
    // went blank waiting on it.
    expect(plist).toMatch(/<key>ProcessType<\/key>\s*<string>Standard<\/string>/);
    expect(plist).not.toContain("<string>Background</string>");
  });

  test("a clean exit is not respawned, so a port collision can't loop", () => {
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
  });
});
