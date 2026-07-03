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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DAEMON_HOST, DAEMON_PORT } from "./protocol.js";

// packages/mcp/src/daemon → repo packages/ (fileURLToPath is tsc-safe, unlike
// the Bun-only import.meta.dir).
const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
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

// ─── Field-level drift: Swift Codable structs vs. their TS source shape ────
//
// The bar doesn't decode protocol.ts's WS types (SessionInfo/TokenUsage/
// AggregatedStats/etc.) at all — those are the WS session-reporting protocol
// between provider hooks and the daemon. The bar talks HTTP GET to endpoints
// whose response shapes come from named TS interfaces in core/src/types.ts
// (TokmeterStats, ModelSummary, DailyEntry), decoded by hand-written Swift
// Codable structs in Models.swift with NO shared schema. A field renamed on
// the TS side doesn't fail a build on either side — Swift's Optional fields
// silently decode to nil, and even non-optional fields just throw at runtime
// on the next fetch, not in CI. These tests catch that at field-name
// granularity: every field a Swift struct declares must still exist on the
// TS interface backing it. Swift is allowed to decode a SUBSET of the TS
// shape (and does, deliberately) — this is not a full equality check.

/** Extract the field names of a flat (no nested `{`) TS interface body. */
function tsInterfaceFields(source: string, name: string): Set<string> {
  const match = source.match(new RegExp(`interface ${name}\\s*\\{([^}]*)\\}`, "s"));
  if (!match) throw new Error(`interface ${name} not found`);
  const fields = new Set<string>();
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.replace(/\/\/.*/, ""); // strip line comments
    const field = line.match(/^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/);
    if (field) fields.add(field[1]);
  }
  return fields;
}

/** Extract the `let name: Type` / `let name: Type?` field names of a flat Swift Codable struct. */
function swiftStructFields(source: string, name: string): string[] {
  const match = source.match(new RegExp(`struct ${name}\\s*:\\s*Codable\\s*\\{([^}]*)\\}`, "s"));
  if (!match) throw new Error(`struct ${name} not found`);
  const fields: string[] = [];
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.replace(/\/\/.*/, "");
    const field = line.match(/^\s*let\s+(\w+)\s*:/);
    if (field) fields.push(field[1]);
  }
  return fields;
}

/** Slice the handler body for one `pathname === "..."` branch in server.ts, up to the next one. */
function handlerBody(source: string, pathname: string): string {
  const startMarker = `pathname === "${pathname}"`;
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`handler for ${pathname} not found in server.ts`);
  const next = source.indexOf('pathname === "', start + startMarker.length);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("daemon contract — Swift decode structs stay within their TS source shape", () => {
  const typesTs = read("core/src/types.ts");
  const modelsSwift = read("macos-bar/Sources/TokmeterBar/Models.swift");

  test("StatsData's fields all exist on TokmeterStats (/api/quick + /api/stats serialize getStats())", () => {
    const tsFields = tsInterfaceFields(typesTs, "TokmeterStats");
    for (const f of swiftStructFields(modelsSwift, "StatsData")) {
      expect(tsFields.has(f), `StatsData.${f} has no matching TokmeterStats field`).toBe(true);
    }
  });

  test("DailyData's fields all exist on DailyEntry (/api/daily serializes getDailyBreakdown())", () => {
    const tsFields = tsInterfaceFields(typesTs, "DailyEntry");
    for (const f of swiftStructFields(modelsSwift, "DailyData")) {
      expect(tsFields.has(f), `DailyData.${f} has no matching DailyEntry field`).toBe(true);
    }
  });

  test("ModelData's fields all exist on ModelSummary (/api/models serializes getModelCosts())", () => {
    const tsFields = tsInterfaceFields(typesTs, "ModelSummary");
    for (const f of swiftStructFields(modelsSwift, "ModelData")) {
      expect(tsFields.has(f), `ModelData.${f} has no matching ModelSummary field`).toBe(true);
    }
  });

  test("/api/quick's response covers QuickResponse's non-optional fields (ready, stats)", () => {
    const serverTs = read("mcp/src/daemon/server.ts");
    const body = handlerBody(serverTs, "/api/quick");
    // Both the warm and cold-start branches must emit these — they're the
    // only two QuickResponse fields Swift decodes as non-optional.
    expect(body).toMatch(/\bready\b/);
    expect(body).toMatch(/\bstats\b/);
  });
});
