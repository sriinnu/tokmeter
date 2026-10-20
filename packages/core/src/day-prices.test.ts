// Dated prices: a sealed day keeps the rates it was billed at, so a rebuild
// changes its cost only when its tokens change — never because kosha's rates
// moved since. These drive the REAL codex parser against fixture rollouts in a
// temp home, with a fake kosha whose prices the test can move.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { aggregateRecordsByDay, type DailyAggregate } from "./aggregates.js";
import {
  DailyAccumulator,
  readDayFile,
  sealRolledOverDay,
  writeDayFile,
} from "./aggregates-store.js";
import { attachDayPrices, type DayPrices, impliedPrices } from "./day-prices.js";
import { costFromCard, type PriceCard, PricingService } from "./pricing.js";
import { backfillProviderIntoRelay, rebuildRecentWindow } from "./relay-loader.js";
import type { ScanContext } from "./scan-pipeline.js";
import type { ScanWarning, TokenRecord } from "./types.js";

const M = 1_000_000;
const REF = Date.parse("2026-06-15T12:00:00"); // local noon
const DAY_KEY = "2026-06-13";
const dayTs = Date.parse(`${DAY_KEY}T12:00:00`);

/** A kosha stand-in: today's cards, movable between seal and rebuild. */
class FakeKosha {
  cards: Record<string, PriceCard> = {};
  async init() {}
  getRegistryMtime() {
    return 1;
  }
  hasUserOverride() {
    return false;
  }
  async getPricingWithSource(model: string) {
    const pricing = this.cards[model] ?? null;
    return {
      pricing,
      source: { tier: pricing ? ("kosha-exact" as const) : ("unpriced" as const) },
    };
  }
  async calculateCost(model: string, i: number, o: number, cr = 0, cw = 0, rs = 0, cw1h = 0) {
    const card = this.cards[model];
    return card ? costFromCard(model, card, i, o, cr, cw, rs, cw1h) : 0;
  }
}

const card = (input: number, output = input * 4): PriceCard => ({
  inputPerMillion: input,
  outputPerMillion: output,
});

function rollout(day: string, model: string, inputs: number[]): string {
  return [
    { timestamp: `${day}T12:00:00`, type: "session_meta", payload: { cwd: "/tmp/demo" } },
    { timestamp: `${day}T12:00:01`, type: "turn_context", payload: { model } },
    ...inputs.map((n, i) => ({
      timestamp: `${day}T12:00:${String(2 + i).padStart(2, "0")}`,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: n, output_tokens: 0 } },
      },
    })),
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
}

function writeRollout(home: string, model: string, inputs: number[], tag = model): void {
  const [y, m, d] = DAY_KEY.split("-");
  const dir = join(home, ".codex/sessions", y, m, d);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-${DAY_KEY}-${tag}.jsonl`), rollout(DAY_KEY, model, inputs));
}

const rec = (provider: string, model: string, inputTokens: number, cost: number, i = 0) =>
  ({
    timestamp: dayTs + i,
    provider,
    model,
    project: "demo",
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost,
  }) as TokenRecord;

function sealed(records: TokenRecord[], prices?: DayPrices): DailyAggregate {
  const [day] = aggregateRecordsByDay(records);
  if (prices) day.prices = prices;
  return day;
}

describe("rebuilds bill a sealed day at its own prices", () => {
  let home: string;
  let kosha: FakeKosha;
  let ctx: ScanContext;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-prices-"));
    kosha = new FakeKosha();
    ctx = { homeDir: home, pricing: kosha as unknown as PricingService, skipPricing: false };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("a grown day is billed at the card it sealed with, not today's rate", async () => {
    // Sealed at $2/M with 1M tokens; kosha has since moved to $5/M; raw shows 2M.
    writeDayFile(
      home,
      sealed([rec("codex", "gpt-5", M, 2)], { "gpt-5": { card: card(2), source: "kosha-exact" } })
    );
    kosha.cards["gpt-5"] = card(5);
    writeRollout(home, "gpt-5", [M, M]);

    const state = await rebuildRecentWindow(ctx, REF, [], 7);
    const day = state.aggregates.get(DAY_KEY);
    expect(day?.totalTokens).toBe(2 * M);
    expect(day?.cost).toBeCloseTo(4, 10); // 2M × $2, not 2M × $5 = $10
    expect(day?.prices?.["gpt-5"]?.card.inputPerMillion).toBe(2);
    expect(readDayFile(home, DAY_KEY)?.prices?.["gpt-5"]?.card.inputPerMillion).toBe(2);
  });

  test("same tokens, prices moved: a forced rebuild leaves the cost exactly as sealed", async () => {
    writeDayFile(
      home,
      sealed([rec("codex", "gpt-5", M, 2)], { "gpt-5": { card: card(2), source: "kosha-exact" } })
    );
    kosha.cards["gpt-5"] = card(1); // cheaper today: the guard alone wouldn't stop a force
    writeRollout(home, "gpt-5", [M]);

    const state = await rebuildRecentWindow(ctx, REF, [], 7, true);
    expect(state.aggregates.get(DAY_KEY)?.cost).toBeCloseTo(2, 10);
  });

  test("a day sealed before cards existed rebuilds at its implied price level", async () => {
    // Legacy: 1M tokens sealed at $3, no cards. Today's card is $5/M.
    writeDayFile(home, sealed([rec("codex", "gpt-5", M, 3)]));
    kosha.cards["gpt-5"] = card(5);
    writeRollout(home, "gpt-5", [M, M]);

    const state = await rebuildRecentWindow(ctx, REF, [], 7);
    const day = state.aggregates.get(DAY_KEY);
    expect(day?.cost).toBeCloseTo(6, 10); // 2M at the day's own $3/M
    expect(day?.prices?.["gpt-5"]).toMatchObject({ source: "implied" });
    expect(day?.prices?.["gpt-5"]?.card.inputPerMillion).toBeCloseTo(3, 10);
  });

  test("a model the day had no card for is billed and carded at today's rate", async () => {
    writeDayFile(
      home,
      sealed([rec("codex", "gpt-5", M, 2)], { "gpt-5": { card: card(2), source: "kosha-exact" } })
    );
    kosha.cards["gpt-5"] = card(5);
    kosha.cards["gpt-5-mini"] = card(1);
    writeRollout(home, "gpt-5", [M]);
    writeRollout(home, "gpt-5-mini", [M]);

    const state = await rebuildRecentWindow(ctx, REF, [], 7);
    const day = state.aggregates.get(DAY_KEY);
    expect(day?.models["gpt-5"]?.cost).toBeCloseTo(2, 10);
    expect(day?.models["gpt-5-mini"]?.cost).toBeCloseTo(1, 10);
    expect(day?.prices?.["gpt-5-mini"]).toMatchObject({ source: "kosha-exact" });
  });

  test("a backfilled provider is billed at the day's card for a model it shares", async () => {
    // Claude Code used gpt-5 that day at $2/M; Codex is backfilled later.
    writeDayFile(
      home,
      sealed([rec("claude-code", "gpt-5", M, 2)], {
        "gpt-5": { card: card(2), source: "kosha-exact" },
      })
    );
    kosha.cards["gpt-5"] = card(5);
    writeRollout(home, "gpt-5", [M]);

    const warnings: ScanWarning[] = [];
    await backfillProviderIntoRelay(ctx, "codex", REF, warnings, 7);
    const day = readDayFile(home, DAY_KEY);
    expect(day?.providers.codex?.cost).toBeCloseTo(2, 10);
    expect(day?.cost).toBeCloseTo(4, 10);
  });
});

describe("implied cards", () => {
  const kosha = new FakeKosha();
  kosha.cards["gpt-5"] = card(2, 8);

  test("scale today's card so the sealed mix costs exactly what was sealed", async () => {
    const day = sealed([
      { ...rec("codex", "gpt-5", M, 0), outputTokens: M, cost: 15 }, // $10 at today's card
    ]);
    const p = await impliedPrices(day, kosha);
    expect(p["gpt-5"]?.card.inputPerMillion).toBeCloseTo(3, 10);
    expect(p["gpt-5"]?.card.outputPerMillion).toBeCloseTo(12, 10);
    const b = day.models["gpt-5"];
    expect(costFromCard("gpt-5", p["gpt-5"]!.card, b.inputTokens, b.outputTokens)).toBeCloseTo(
      15,
      10
    );
  });

  test("none for a model sealed at $0 or unpriced today", async () => {
    const day = sealed([rec("codex", "gpt-5", M, 0, 0), rec("codex", "mystery", M, 4, 1)]);
    expect(await impliedPrices(day, kosha)).toEqual({});
  });
});

describe("attaching cards", () => {
  test("kept cards win, today's fill the rest, unpriced models get none", async () => {
    const kosha = new FakeKosha();
    kosha.cards.a = card(9);
    kosha.cards.b = card(1);
    const day = sealed([
      rec("codex", "a", M, 2, 0),
      rec("codex", "b", M, 1, 1),
      rec("codex", "c", M, 0, 2),
    ]);
    await attachDayPrices(day, kosha, { a: { card: card(2), source: "kosha-exact" } });
    expect(day.prices?.a?.card.inputPerMillion).toBe(2);
    expect(day.prices?.b?.card.inputPerMillion).toBe(1);
    expect(day.prices?.c).toBeUndefined();
  });

  test("only billing rates are stored", async () => {
    const kosha = new FakeKosha();
    kosha.cards.a = { ...card(2), batchInputPerMillion: 1 } as PriceCard;
    const day = sealed([rec("codex", "a", M, 2)]);
    await attachDayPrices(day, kosha);
    expect(Object.keys(day.prices?.a?.card ?? {}).sort()).toEqual([
      "inputPerMillion",
      "outputPerMillion",
    ]);
  });

  test("the midnight seal keeps cards only for models the day used", () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-seal-"));
    try {
      const acc = new DailyAccumulator(DAY_KEY);
      acc.fold(rec("codex", "gpt-5", M, 2));
      const day = sealRolledOverDay(home, acc, "2026-06-14", {
        "gpt-5": { card: card(2), source: "kosha-exact" },
        unused: { card: card(7), source: "kosha-exact" },
      });
      expect(Object.keys(day?.prices ?? {})).toEqual(["gpt-5"]);
      expect(readDayFile(home, DAY_KEY)?.prices?.["gpt-5"]?.card.inputPerMillion).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("costFromCard is calculateCost's arithmetic", () => {
  test("same result for a Claude mix with 1h cache writes, cache reads and reasoning", async () => {
    const ps = new PricingService(mkdtempSync(join(tmpdir(), "tokmeter-pricing-")));
    const c: PriceCard = {
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    };
    ps.seedPricing("claude-sonnet-test", c);
    const args = [1000, 2000, 30_000, 4000, 500, 2500] as const;
    expect(await ps.calculateCost("claude-sonnet-test", ...args)).toBe(
      costFromCard("claude-sonnet-test", c, ...args)
    );
  });
});
