// Cross-language contract drift guard.
//
// The daemon port is canonical in protocol.ts (DAEMON_PORT), but the CLI and
// the macOS bar deliberately HARDCODE the HTTP port (DAEMON_PORT + 1) to avoid
// a build-time dependency on the daemon package internals. That hardcoding is
// drift-prone: change DAEMON_PORT and those files silently keep the old port.
// These tests read the other-language sources as text and fail the moment they
// no longer agree with protocol.ts — a cheap guard until the wire types are
// generated from one schema.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DAEMON_HOST, DAEMON_PORT } from "./protocol.js";

// packages/mcp/src/daemon → repo packages/
const packagesDir = join(import.meta.dir, "..", "..", "..");
const read = (rel: string) => readFileSync(join(packagesDir, rel), "utf8");

const httpBase = `http://${DAEMON_HOST}:${DAEMON_PORT + 1}`;

describe("daemon contract — HTTP base stays in sync with protocol.ts", () => {
  test("CLI hardcodes the HTTP base derived from DAEMON_PORT", () => {
    expect(read("cli/src/cli.ts")).toContain(httpBase);
  });

  test("macOS bar DaemonClient hardcodes the same HTTP base", () => {
    expect(read("macos-bar/Sources/TokmeterBar/DaemonClient.swift")).toContain(httpBase);
  });

  test("canonical values are what the hardcoders assume", () => {
    // If either of these changes, the two tests above will fail until the CLI
    // and Swift literals are updated — that's the whole point.
    expect(DAEMON_HOST).toBe("127.0.0.1");
    expect(DAEMON_PORT).toBe(9876);
  });
});
