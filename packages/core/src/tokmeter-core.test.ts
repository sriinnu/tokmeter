import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateRecordsByDay } from "./aggregates.js";
import { writeDayFile } from "./aggregates-store.js";
import { localDateKey } from "./date-utils.js";
import { TodayJournal } from "./today-journal.js";
import { TokmeterCore } from "./tokmeter-core.js";
import type { TokenRecord } from "./types.js";

// ─── Freeze-rule regression tests ──────────────────────────────────────
// Cover the $21K → $15K historical reprice bug (commits 662960c + 3580b40).
// Today's rows must reprice when kosha mtime advances; everything older must
// stay frozen at whatever cost was written when it was first scanned.
//
// These are skeletons — TODOs flesh out scenario setup. Filling them in
// requires a small fixtures harness (mock kosha registry on disk + seed
// JSONL files) that we'll layer in as a follow-up.

describe("scan() — kosha mtime change reprices today only", () => {
  it.todo("reprices today's records when kosha mtime advances");
  it.todo("does NOT reprice historical records on kosha mtime change");
  it.todo("preserves cost === 0 records (model not in registry) without flipping their cost");
});

describe("snapshot round-trip preserves cost verbatim", () => {
  it.todo("loads frozen costs without re-pricing on stableThrough match");
  it.todo("rebuilds snapshot from scan-cache (frozen costs) when stableThrough mismatches");
});

describe("enrichCosts skip rule", () => {
  it.todo("skips records where cost > 0 (the freeze-respect line)");
  it.todo("only zero-cost records get priced");
});

describe("TokmeterCore.hydrateFromDiskCache", () => {
  it("returns false when no relay aggregates or today journal exist on disk", () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-hydrate-empty-"));
    try {
      const core = new TokmeterCore({ homeDir: home, skipPricing: true });
      expect(core.hydrateFromDiskCache()).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("loads sealed relay days and persisted today journal records without running parsers", () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-hydrate-disk-"));
    try {
      const now = Date.now();
      const todayKey = localDateKey(now);
      const yesterdayMs = now - 24 * 3_600_000;
      const pastRecord: TokenRecord = {
        timestamp: yesterdayMs,
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        project: "alpha",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 150,
        cost: 1.5,
        sourceFile: join(home, ".claude", "projects", "alpha", "old.jsonl"),
        apiCallId: "past-1",
      };
      for (const agg of aggregateRecordsByDay([pastRecord])) {
        writeDayFile(home, agg);
      }

      const journal = new TodayJournal(home);
      const todayRecord: TokenRecord = {
        timestamp: now,
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        project: "beta",
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 300,
        cost: 2.5,
        sourceFile: join(home, ".claude", "projects", "beta", "today.jsonl"),
        apiCallId: "today-1",
      };
      // Trigger persisted `seen` snapshot across a simulated >5m tick gap.
      journal.reconcile([todayRecord], now - 6 * 60_000);
      journal.reconcile([todayRecord], now);

      const core = new TokmeterCore({ homeDir: home, skipPricing: true });
      expect(core.hydrateFromDiskCache(now)).toBe(true);
      expect(core.getDailyBreakdown().map((d) => d.date)).toContain(todayKey);
      expect(core.getStats().totalCost).toBeCloseTo(4.0, 5);
      expect(core.getScanMeta().todayState).toBe("snapshot-only");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
