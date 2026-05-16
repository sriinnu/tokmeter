/**
 * @sriinnu/tokmeter-core — Statbar signals.
 *
 * Derived metrics for "how am I doing right now" — burn rate, cache health,
 * pace vs. typical, compaction tax, and the live session pointer. Computed
 * from the same TokenRecord[] that drives every other view, but referenced
 * against an explicit `now` so tests can pin time.
 */

import { localDateKey } from "./date-utils.js";
import type { StatbarSignals, TokenRecord } from "./types.js";

/** How long we look back when computing burn rate. */
const BURN_WINDOW_MINUTES = 60;

/** A record younger than this counts as "live" for the live-session pill. */
const LIVE_FRESHNESS_SECONDS = 5 * 60;

/** How many past active days inform the pace baseline. */
const PACE_BASELINE_DAYS = 7;

/**
 * Claude Pro/Max billing windows are 5 hours wide. A new block starts at the
 * first Claude record after no activity for >5h; block ends 5h after that.
 * This matches the upstream Anthropic billing model the UI subscriptions are
 * priced against — hitting the cap inside a window forces a wait.
 */
const BILLING_WINDOW_HOURS = 5;
const BILLING_WINDOW_MS = BILLING_WINDOW_HOURS * 3600 * 1000;

/**
 * How far back the billing-window detector scans. We need to see enough
 * history to verify whether the OLDEST candidate `blockStart` actually opened
 * a new block — that requires looking ~5h further back than the block itself.
 * Otherwise the lookback can clip a previous block's tail into a phantom
 * fresh block. 2× the billing window is the smallest safe value.
 */
const BILLING_LOOKBACK_MS = BILLING_WINDOW_MS * 2;

/** Total token count helper — keep parity with aggregator's sumTokens. */
function recordTotal(r: TokenRecord): number {
  return (
    r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.reasoningTokens
  );
}

/** Count distinct 5h billing blocks in a chronologically-sorted slice. A new
 *  block opens whenever the gap from the current block_start exceeds 5h. */
function countBlocks(sorted: TokenRecord[]): number {
  if (sorted.length === 0) return 0;
  let count = 1;
  let blockStart = sorted[0].timestamp;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].timestamp - blockStart > 5 * 3600 * 1000) {
      count++;
      blockStart = sorted[i].timestamp;
    }
  }
  return count;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Build the full StatbarSignals payload from a record set. The `records`
 * array can be in any order — we don't mutate it. `now` is in epoch ms.
 */
export function computeStatbarSignals(records: TokenRecord[], now: number): StatbarSignals {
  // ── Burn rate ──────────────────────────────────────────────────────────
  const burnWindowMs = BURN_WINDOW_MINUTES * 60_000;
  const burnSince = now - burnWindowMs;
  let burnCost = 0;
  let burnTokens = 0;
  let burnRecords = 0;
  for (const r of records) {
    if (r.timestamp < burnSince || r.timestamp > now) continue;
    burnCost += r.cost;
    burnTokens += recordTotal(r);
    burnRecords++;
  }
  // Scale to per-hour. Window is exactly 60 min so this is just the raw sum,
  // but keeping the multiplier explicit so changing BURN_WINDOW_MINUTES still
  // gives sensible numbers.
  const hoursInWindow = BURN_WINDOW_MINUTES / 60;
  const burnRate = {
    costPerHour: hoursInWindow > 0 ? burnCost / hoursInWindow : 0,
    tokensPerHour: hoursInWindow > 0 ? burnTokens / hoursInWindow : 0,
    windowMinutes: BURN_WINDOW_MINUTES,
    recordsInWindow: burnRecords,
  };

  // ── Today's slice (shared by cache-hit, pace, compaction) ──────────────
  // Numeric epoch-ms bounds beat per-record Date allocations. At 100k records
  // the old `localDateKey(r.timestamp)` path was ~5-10 ms per scan (Date ctor
  // × N). One day boundary computation up front + integer compare per record
  // drops it to a hot loop, ~0.1 ms.
  const todayKey = localDateKey(now);
  const nowDateForBounds = new Date(now);
  const todayStartMs = new Date(
    nowDateForBounds.getFullYear(),
    nowDateForBounds.getMonth(),
    nowDateForBounds.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
  const todayRecords: TokenRecord[] = [];
  for (const r of records) {
    if (r.timestamp >= todayStartMs && r.timestamp <= now) {
      todayRecords.push(r);
    }
  }

  // ── Cache hit today ────────────────────────────────────────────────────
  let todayCacheRead = 0;
  let todayInput = 0;
  let todayCost = 0;
  for (const r of todayRecords) {
    todayCacheRead += r.cacheReadTokens;
    todayInput += r.inputTokens;
    todayCost += r.cost;
  }
  const cacheDenominator = todayCacheRead + todayInput;
  const cacheHitToday = {
    rate: cacheDenominator > 0 ? todayCacheRead / cacheDenominator : 0,
    cacheReadTokens: todayCacheRead,
    inputTokens: todayInput,
  };

  // ── Pace vs. typical ───────────────────────────────────────────────────
  // For each past day with any records, sum cost from midnight to the same
  // wall-clock hour:minute as `now`. Median those — that's "typical by this
  // hour." Compare to today's actual.
  const nowDate = new Date(now);
  const minutesIntoToday = nowDate.getHours() * 60 + nowDate.getMinutes();

  // Bound the pace scan to 2× the baseline window. Older records can't
  // contribute (the sort+slice keeps only the most recent N days anyway), so
  // walking them was pure waste — at 100k records spanning a year, ~95% of
  // entries were touched here for nothing. Numeric epoch-ms bound avoids the
  // per-record `Date` allocation that used to dominate the function's cost.
  const paceLookbackMs = PACE_BASELINE_DAYS * 2 * 86_400_000;
  const paceOldestMs = now - paceLookbackMs;
  // Group past records by day, but only those that fall within the same
  // minute-of-day window. Skip today.
  const pastByDay = new Map<string, number>();
  for (const r of records) {
    if (r.timestamp < paceOldestMs) continue;
    if (r.timestamp >= todayStartMs) continue; // skip today and future
    const d = new Date(r.timestamp);
    const minute = d.getHours() * 60 + d.getMinutes();
    if (minute > minutesIntoToday) continue;
    const key = localDateKey(r.timestamp);
    pastByDay.set(key, (pastByDay.get(key) ?? 0) + r.cost);
  }
  // Use the most recent N active days only — older data drifts away from
  // current workflow patterns and stops being predictive.
  const recentDayCosts = [...pastByDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, PACE_BASELINE_DAYS)
    .map(([, v]) => v);
  const typicalByNow = median(recentDayCosts);
  let actualByNow = 0;
  for (const r of todayRecords) actualByNow += r.cost;
  const paceMultiple =
    typicalByNow > 0.0001 && recentDayCosts.length > 0 ? actualByNow / typicalByNow : null;
  const pace = {
    multiple: paceMultiple,
    typicalCostByNow: typicalByNow,
    actualCostByNow: actualByNow,
    daysOfHistory: recentDayCosts.length,
  };

  // ── Compaction tax (today) ─────────────────────────────────────────────
  let compactionCost = 0;
  let compactionTokens = 0;
  let compactionEvents = 0;
  for (const r of todayRecords) {
    if (r.kind !== "compaction") continue;
    compactionCost += r.cost;
    compactionTokens += recordTotal(r);
    compactionEvents++;
  }
  const compactionToday = {
    cost: compactionCost,
    tokens: compactionTokens,
    share: todayCost > 0.0001 ? compactionCost / todayCost : 0,
    events: compactionEvents,
  };

  // ── Subagent share (today) ─────────────────────────────────────────────
  // Claude Code's Task tool spawns subagents in a separate JSONL. Roll up
  // their cost today so the user can spot runaway nested agent work.
  let subagentCost = 0;
  let subagentRecordCount = 0;
  for (const r of todayRecords) {
    if (!r.isSubagent) continue;
    subagentCost += r.cost;
    subagentRecordCount++;
  }
  const subagentToday = {
    cost: subagentCost,
    records: subagentRecordCount,
    share: todayCost > 0.0001 ? subagentCost / todayCost : 0,
  };

  // ── Reasoning share (today) ────────────────────────────────────────────
  // Reasoning tokens are a subset of output tokens for OpenAI-style providers
  // (Codex et al.). Surfacing the share tells the user "your effort:low or
  // explicit-model choice is making this much of your output invisible
  // thinking" — actionable for routing decisions on routine tasks.
  let reasoningTokens = 0;
  let reasoningOutputTokens = 0;
  let reasoningRecords = 0;
  for (const r of todayRecords) {
    reasoningOutputTokens += r.outputTokens;
    if (r.reasoningTokens > 0) {
      reasoningTokens += r.reasoningTokens;
      reasoningRecords++;
    }
  }
  const reasoningToday = {
    tokens: reasoningTokens,
    outputTokens: reasoningOutputTokens,
    // Clamp at 1.0 — some Codex variants over-report reasoning tokens (the
    // count isn't always strictly nested inside output_tokens). Without the
    // clamp the UI would render ">100% reasoning", which is technically
    // honest but reads as a bug.
    share: reasoningOutputTokens > 0 ? Math.min(1, reasoningTokens / reasoningOutputTokens) : 0,
    records: reasoningRecords,
  };

  // ── Tool-call cost breakdown (today) ──────────────────────────────────
  // Today only Claude Code populates toolCalls — its JSONL exposes every
  // tool_use block by name. When one turn fires multiple tools in parallel,
  // we split the turn's cost evenly. Imperfect (the model doesn't tell us
  // how many output tokens each tool's arg JSON cost), but the right call
  // without per-tool accounting from the upstream API.
  const toolCostMap = new Map<string, { cost: number; calls: number }>();
  let toolTotalCost = 0;
  let toolCallCount = 0;
  let turnsWithTools = 0;
  for (const r of todayRecords) {
    const tools = r.toolCalls;
    if (!tools || tools.length === 0) continue;
    turnsWithTools++;
    // Floor at 0 in case a record ever carries a credit/refund adjustment —
    // negative cost would flip sort order and place the "biggest" tool at
    // the bottom. Not a current path; defensive belt-and-suspenders.
    const positiveCost = Math.max(0, r.cost);
    toolTotalCost += positiveCost;
    const share = positiveCost / tools.length;
    for (const tool of tools) {
      toolCallCount++;
      const cur = toolCostMap.get(tool);
      if (cur) {
        cur.cost += share;
        cur.calls += 1;
      } else {
        toolCostMap.set(tool, { cost: share, calls: 1 });
      }
    }
  }
  const byTool = [...toolCostMap.entries()]
    .map(([tool, v]) => ({
      tool,
      cost: v.cost,
      share: toolTotalCost > 0.0001 ? v.cost / toolTotalCost : 0,
      calls: v.calls,
    }))
    .sort((a, b) => b.cost - a.cost);
  const toolCallsToday = {
    byTool,
    totalCost: toolTotalCost,
    callCount: toolCallCount,
    turnsWithTools,
  };

  // ── Claude 5-hour billing window ──────────────────────────────────────
  // Walks every record once, collecting Claude Code rows within the lookback.
  // Lookback is 2× the billing window so the gap-walk has enough history to
  // verify that the oldest candidate `blockStart` actually opened a fresh
  // block (i.e., there was a >5h quiet period before it). With only 5h of
  // history visible, a previous block's tail record can get mistaken for a
  // new block start — phantom blocks reported as active long after the real
  // one expired.
  //
  // Records are appended in scan order, not chronological — do NOT early-
  // break on timestamp during the walk.
  let billingWindow: StatbarSignals["billingWindow"] = null;
  const oldestCandidate = now - BILLING_LOOKBACK_MS - 1;
  const recentClaude: TokenRecord[] = [];
  for (const r of records) {
    if (r.provider !== "claude-code") continue;
    if (r.timestamp > now) continue;
    if (r.timestamp < oldestCandidate) continue;
    recentClaude.push(r);
  }
  if (recentClaude.length > 0) {
    // Sort the small slice ascending by timestamp so the gap-walk that
    // finds the current block boundary is robust to scan-order interleaving.
    recentClaude.sort((a, b) => a.timestamp - b.timestamp);
    let blockStart = recentClaude[0].timestamp;
    let blockStartIdx = 0;
    for (let i = 1; i < recentClaude.length; i++) {
      if (recentClaude[i].timestamp - blockStart > BILLING_WINDOW_MS) {
        blockStart = recentClaude[i].timestamp;
        blockStartIdx = i;
      }
    }
    const blockEnd = blockStart + BILLING_WINDOW_MS;
    const remainingMs = Math.max(0, blockEnd - now);
    // Gate on ≥1s — sub-second remaining is effectively expired, and the
    // Swift Codable comment promises "always > 0 when non-null".
    if (remainingMs >= 1000) {
      let cost = 0;
      let tokens = 0;
      for (let i = blockStartIdx; i < recentClaude.length; i++) {
        cost += recentClaude[i].cost;
        tokens += recordTotal(recentClaude[i]);
      }
      // Block number = "Nth block within today's records." Walk todayRecords
      // (not recentClaude — its 10h lookback can be shorter than today, so
      // an early-morning block would get missed). Filter + sort the small
      // today-claude slice; it's bounded by activity so rarely huge.
      const todayClaude = todayRecords
        .filter((r) => r.provider === "claude-code")
        .sort((a, b) => a.timestamp - b.timestamp);
      const todayBlockCount = countBlocks(todayClaude);
      billingWindow = {
        blockNumber: todayBlockCount > 0 ? todayBlockCount : 1,
        blockStart,
        blockEnd,
        remainingSec: Math.floor(remainingMs / 1000),
        elapsedPct: Math.min(100, ((now - blockStart) / BILLING_WINDOW_MS) * 100),
        cost,
        tokens,
        records: recentClaude.length - blockStartIdx,
      };
    }
  }

  // ── Live session ───────────────────────────────────────────────────────
  // The most recent record across the whole record set. If it's within the
  // freshness window, expose it as the "live" pointer; otherwise null.
  let mostRecent: TokenRecord | null = null;
  for (const r of records) {
    if (r.timestamp > now) continue; // ignore future timestamps (clock skew)
    if (!mostRecent || r.timestamp > mostRecent.timestamp) {
      mostRecent = r;
    }
  }
  let liveSession: StatbarSignals["liveSession"] = null;
  if (mostRecent) {
    const ageSeconds = Math.max(0, Math.floor((now - mostRecent.timestamp) / 1000));
    if (ageSeconds <= LIVE_FRESHNESS_SECONDS) {
      liveSession = {
        provider: mostRecent.provider,
        model: mostRecent.model,
        project: mostRecent.project,
        ageSeconds,
        lastRecordCost: mostRecent.cost,
      };
    }
  }

  return {
    burnRate,
    cacheHitToday,
    pace,
    compactionToday,
    subagentToday,
    reasoningToday,
    toolCallsToday,
    billingWindow,
    liveSession,
  };
}
