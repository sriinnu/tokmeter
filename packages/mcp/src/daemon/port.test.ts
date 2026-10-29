import { describe, expect, test } from "vitest";
import { DEFAULT_DAEMON_PORT, daemonPortOverride } from "./port.js";

describe("daemonPortOverride", () => {
  test("unset, empty or the default port is no override", () => {
    expect(daemonPortOverride({})).toBeNull();
    expect(daemonPortOverride({ TOKMETER_DAEMON_PORT: "" })).toBeNull();
    expect(daemonPortOverride({ TOKMETER_DAEMON_PORT: String(DEFAULT_DAEMON_PORT) })).toBeNull();
  });

  test("an unprivileged port with room for HTTP (port + 1) is honoured", () => {
    expect(daemonPortOverride({ TOKMETER_DAEMON_PORT: "19876" })).toBe(19876);
    expect(daemonPortOverride({ TOKMETER_DAEMON_PORT: "1024" })).toBe(1024);
    expect(daemonPortOverride({ TOKMETER_DAEMON_PORT: "65534" })).toBe(65534);
  });

  test("garbage and out-of-range values are ignored", () => {
    for (const raw of ["80", "65535", "70000", "-1", "19876abc", " 19876", "1e4", "0x4d24"]) {
      expect(daemonPortOverride({ TOKMETER_DAEMON_PORT: raw })).toBeNull();
    }
  });
});
