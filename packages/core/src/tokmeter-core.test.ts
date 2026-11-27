import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateRecordsByDay } from "./aggregates.js";
import { writeDayFile } from "./aggregates-store.js";
import { localDateKey } from "./date-utils.js";
import { peekTodayJournalRecords, TodayJournal } from "./today-journal.js";
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

  it("surfaces quarantined-day warnings from hydrateFromDiskCache and enforces todayDate guard", () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-hydrate-warn-"));
    try {
      const now = Date.now();
      const todayKey = localDateKey(now);
      const pastRecord: TokenRecord = {
        timestamp: now - 24 * 3_600_000,
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
        apiCallId: "past-warn",
      };
      for (const agg of aggregateRecordsByDay([pastRecord])) {
        writeDayFile(home, agg);
      }
      // Write a corrupt day file so loadAggregates emits a quarantine warning.
      mkdirSync(join(home, ".cache", "tokmeter", "aggregates"), { recursive: true });
      writeFileSync(
        join(home, ".cache", "tokmeter", "aggregates", "2025-01-01.json"),
        "{corrupt-json"
      );

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
        apiCallId: "today-warn",
      };
      journal.reconcile([todayRecord], now - 6 * 60_000);
      journal.reconcile([todayRecord], now);

      const core = new TokmeterCore({ homeDir: home, skipPricing: true });
      expect(core.hydrateFromDiskCache(now)).toBe(true);
      expect(core.getScanMeta().warnings.some((w) => w.scope === "history")).toBe(true);
      // Matching todayDate returns today's projects/models; mismatched todayDate returns empty.
      expect(core.getAllProjects({ today: true, todayDate: todayKey })).toHaveLength(1);
      expect(core.getModelCosts({ today: true, todayDate: todayKey })).toHaveLength(1);
      expect(core.getAllProjects({ today: true, todayDate: "2099-01-01" })).toEqual([]);
      expect(core.getModelCosts({ today: true, todayDate: "2099-01-01" })).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("initializes pricing during getCrossToolComparison on a hydrated core", async () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-hydrate-crosstool-"));
    try {
      mkdirSync(join(home, ".tokmeter"), { recursive: true });
      writeFileSync(
        join(home, ".tokmeter", "pricing-overrides.json"),
        JSON.stringify({
          "hydrated-override-model": { inputPerMillion: 10, outputPerMillion: 40 },
        })
      );
      const now = Date.now();
      const todayKey = localDateKey(now);
      const todayRecord: TokenRecord = {
        timestamp: now,
        provider: "claude-code",
        model: "hydrated-override-model",
        project: "beta",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1_000_000,
        cost: 10,
        sourceFile: join(home, ".claude", "projects", "beta", "today.jsonl"),
        apiCallId: "today-override",
      };
      const journal = new TodayJournal(home);
      journal.reconcile([todayRecord], now - 6 * 60_000);
      journal.reconcile([todayRecord], now);

      const core = new TokmeterCore({ homeDir: home });
      expect(core.hydrateFromDiskCache(now)).toBe(true);
      const comparison = await core.getCrossToolComparison(todayKey);
      const alt = comparison.projections.find((a) => a.model === "hydrated-override-model");
      expect(alt).toBeDefined();
      expect(alt?.projectedCost).toBeCloseTo(10, 4);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("peekTodayJournalRecords rejects invalid dates and corrupt journal files cleanly", () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-peek-journal-"));
    try {
      expect(peekTodayJournalRecords(home, "../evil")).toEqual([]);
      mkdirSync(join(home, ".cache", "tokmeter", "today"), { recursive: true });
      writeFileSync(join(home, ".cache", "tokmeter", "today", "2026-11-27.json"), "{bad-json");
      expect(peekTodayJournalRecords(home, "2026-11-27")).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
