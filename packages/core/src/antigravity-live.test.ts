/**
 * Tests for the pure cache/delta logic in antigravity-live.ts — the part
 * that doesn't touch a real process or network call, which the
 * process-discovery/RPC path (pollAntigravityLiveStatus) needs a live
 * Antigravity install and an explicit permission grant to exercise for
 * real. These tests build the on-disk snapshot log by hand and check what
 * gets read back out of it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AntigravitySnapshot,
  computeCreditsUsedToday,
  pruneSnapshotHistory,
  readLatestSnapshot,
  readSnapshotHistory,
} from "./antigravity-live.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "antigravity-live-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function seedSnapshots(snapshots: AntigravitySnapshot[]): void {
  const dir = join(tmpDir, ".cache", "tokmeter");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "antigravity-live-snapshots.jsonl"),
    `${snapshots.map((s) => JSON.stringify(s)).join("\n")}\n`
  );
}

function snapshot(overrides: Partial<AntigravitySnapshot>): AntigravitySnapshot {
  return {
    timestamp: Date.now(),
    availablePromptCredits: 500,
    availableFlowCredits: 100,
    models: [],
    ...overrides,
  };
}

describe("readSnapshotHistory / readLatestSnapshot", () => {
  it("returns [] / null when no log file exists yet", () => {
    expect(readSnapshotHistory(tmpDir)).toEqual([]);
    expect(readLatestSnapshot(tmpDir)).toBeNull();
  });

  it("reads snapshots back in order and skips malformed lines", () => {
    const dir = join(tmpDir, ".cache", "tokmeter");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "antigravity-live-snapshots.jsonl"),
      [
        JSON.stringify(snapshot({ timestamp: 1, availablePromptCredits: 500 })),
        "{not valid json",
        JSON.stringify(snapshot({ timestamp: 2, availablePromptCredits: 480 })),
      ].join("\n")
    );

    const history = readSnapshotHistory(tmpDir);
    expect(history.length).toBe(2);
    expect(history[0]?.timestamp).toBe(1);
    expect(history[1]?.timestamp).toBe(2);
    expect(readLatestSnapshot(tmpDir)?.timestamp).toBe(2);
  });
});

describe("computeCreditsUsedToday", () => {
  it("sums decreasing deltas across today's snapshots", () => {
    const now = Date.now();
    seedSnapshots([
      snapshot({ timestamp: now - 3000, availablePromptCredits: 500, availableFlowCredits: 100 }),
      snapshot({ timestamp: now - 2000, availablePromptCredits: 480, availableFlowCredits: 95 }),
      snapshot({ timestamp: now - 1000, availablePromptCredits: 450, availableFlowCredits: 90 }),
    ]);

    const used = computeCreditsUsedToday(tmpDir);
    expect(used?.promptCreditsUsed).toBe(50); // 500 -> 480 -> 450
    expect(used?.flowCreditsUsed).toBe(10); // 100 -> 95 -> 90
  });

  it("treats a quota reset (credits going up) as excluded, not negative usage", () => {
    const now = Date.now();
    seedSnapshots([
      snapshot({ timestamp: now - 3000, availablePromptCredits: 50, availableFlowCredits: 10 }),
      // Reset: credits jump back up between polls.
      snapshot({ timestamp: now - 2000, availablePromptCredits: 500, availableFlowCredits: 100 }),
      snapshot({ timestamp: now - 1000, availablePromptCredits: 480, availableFlowCredits: 95 }),
    ]);

    const used = computeCreditsUsedToday(tmpDir);
    // Only the second interval (500 -> 480, 100 -> 95) counts; the reset
    // interval contributes 0, not a negative number that would cancel it out.
    expect(used?.promptCreditsUsed).toBe(20);
    expect(used?.flowCreditsUsed).toBe(5);
  });

  it("ignores snapshots from before today", () => {
    const now = Date.now();
    const yesterday = now - 25 * 60 * 60 * 1000;
    seedSnapshots([
      snapshot({ timestamp: yesterday, availablePromptCredits: 999, availableFlowCredits: 999 }),
    ]);

    expect(computeCreditsUsedToday(tmpDir)).toBeNull();
  });

  it("returns null when no snapshots exist at all", () => {
    expect(computeCreditsUsedToday(tmpDir)).toBeNull();
  });
});

describe("pruneSnapshotHistory", () => {
  it("keeps only the most recent N entries", () => {
    seedSnapshots([
      snapshot({ timestamp: 1 }),
      snapshot({ timestamp: 2 }),
      snapshot({ timestamp: 3 }),
      snapshot({ timestamp: 4 }),
    ]);

    pruneSnapshotHistory(2, tmpDir);

    const history = readSnapshotHistory(tmpDir);
    expect(history.map((s) => s.timestamp)).toEqual([3, 4]);
  });

  it("is a no-op when there are fewer entries than the keep count", () => {
    seedSnapshots([snapshot({ timestamp: 1 }), snapshot({ timestamp: 2 })]);
    pruneSnapshotHistory(10, tmpDir);
    expect(readSnapshotHistory(tmpDir).length).toBe(2);
  });
});
