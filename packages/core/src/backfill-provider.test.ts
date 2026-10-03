// Surgical provider-scoped backfill — the two review ship-blockers:
//   1. a custom source (ribhu/grok/custom) must actually fold in, which means
//      routing through the CustomSourceParser (providerId "custom") while the
//      per-record filter keeps the target id.
//   2. the existing-day fold must reject malformed records (the same validity
//      gate the cold paths apply) so one bad user-authored line can't poison an
//      immutable sealed day.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadAggregates, writeDayFile } from "./aggregates-store.js";
import { aggregateRecordsByDay } from "./aggregates.js";
import { DEFAULT_CONFIG, saveConfig } from "./config-service.js";
import type { PricingService } from "./pricing.js";
import { backfillProviderIntoRelay } from "./relay-loader.js";
import type { ScanContext } from "./scan-pipeline.js";
import type { TokenRecord } from "./types.js";

const stubPricing = {
  init: async () => {},
  calculateCost: async () => 0,
  getRegistryMtime: () => 0,
} as unknown as PricingService;

const ctxFor = (homeDir: string): ScanContext => ({
  homeDir,
  pricing: stubPricing,
  skipPricing: true,
});

const REF = Date.parse("2026-06-15T12:00:00");
const DAY = 86_400_000;
const SEALED_TS = REF - 2 * DAY; // a sealed day inside the window, before today

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "backfill-provider-test-"));
});
afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

/** Seed a sealed day owned by another provider (codex), to prove it's untouched. */
function seedCodexDay(): string {
  const codex: TokenRecord = {
    timestamp: SEALED_TS,
    provider: "codex",
    model: "gpt-5.3-codex",
    project: "demo",
    inputTokens: 500,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
  } as TokenRecord;
  const [day] = aggregateRecordsByDay([codex]);
  writeDayFile(home, day);
  return day.date;
}

function registerRibhuSource(lines: unknown[]): void {
  const dir = join(home, ".ribhu", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  saveConfig(
    {
      ...DEFAULT_CONFIG,
      modifiedBy: "user",
      customSources: [{ path: dir, format: "tokmeter-usage-jsonl", provider: "ribhu" }],
    },
    home
  );
}

describe("backfillProviderIntoRelay — surgical custom-source fold", () => {
  test("folds a ribhu custom source in additively, drops a malformed line, leaves codex intact", async () => {
    const date = seedCodexDay();

    registerRibhuSource([
      { ts: SEALED_TS, id: "r-good", model: "ribhu-x", input_tokens: 1000, output_tokens: 100 },
      // negative tokens — must be rejected by the validity gate, not folded.
      { ts: SEALED_TS, id: "r-bad", model: "ribhu-x", input_tokens: -5, output_tokens: 0 },
    ]);

    const warnings: never[] = [];
    const relay = await backfillProviderIntoRelay(ctxFor(home), "ribhu", REF, warnings, 30);

    const day = relay.aggregates.get(date);
    expect(day).toBeDefined();
    if (!day) return;

    // ribhu landed (routed through the custom parser despite providerId "custom")
    expect(day.providers.ribhu).toBeDefined();
    // only the good line counted: 1000 + 100 = 1100, NOT 1095 (bad line dropped)
    expect(day.providers.ribhu.totalTokens).toBe(1100);
    expect(day.providers.ribhu.inputTokens).toBe(1000);

    // codex untouched
    expect(day.providers.codex.totalTokens).toBe(550);

    // grand total grew by exactly ribhu's good line
    expect(day.totalTokens).toBe(550 + 1100);
  });

  test("re-running is idempotent (the provider-present skip prevents double-count)", async () => {
    const date = seedCodexDay();
    registerRibhuSource([
      { ts: SEALED_TS, id: "r-good", model: "ribhu-x", input_tokens: 1000, output_tokens: 100 },
    ]);

    await backfillProviderIntoRelay(ctxFor(home), "ribhu", REF, [], 30);
    const relay2 = await backfillProviderIntoRelay(ctxFor(home), "ribhu", REF, [], 30);

    // Reload from disk to be sure the on-disk day wasn't double-folded either.
    const onDisk = loadAggregates(home).get(date);
    expect(onDisk?.providers.ribhu.totalTokens).toBe(1100);
    expect(relay2.aggregates.get(date)?.providers.ribhu.totalTokens).toBe(1100);
  });
});
