/**
 * @sriinnu/tokmeter-core — Aggregator.
 *
 * Groups parsed TokenRecords by project, model, provider, and date.
 */
import { toDateStr } from "./parsers/utils.js";
import { projectNameIncludes } from "./project-name.js";
/** Filter records by date range. */
export function filterByDate(records, opts) {
  const now = new Date();
  let since;
  let until;
  if (opts.today) {
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    until = new Date(since.getTime() + 86400000);
  } else if (opts.week) {
    since = new Date(now.getTime() - 7 * 86400000);
  } else if (opts.month) {
    since = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (opts.year) {
    since = new Date(Date.UTC(opts.year, 0, 1));
    until = new Date(Date.UTC(opts.year + 1, 0, 1));
  } else {
    if (opts.since) since = new Date(opts.since);
    if (opts.until) {
      // Handle both date-only ("2025-01-15") and full ISO strings
      const untilStr = opts.until;
      if (untilStr.includes("T") || untilStr.includes("Z")) {
        until = new Date(untilStr);
      } else {
        until = new Date(`${untilStr}T23:59:59.999Z`);
      }
    }
  }
  return records.filter((r) => {
    if (since && r.timestamp < since.getTime()) return false;
    if (until && r.timestamp > until.getTime()) return false;
    return true;
  });
}
/** Filter records by provider. */
export function filterByProvider(records, providers) {
  if (!providers.length) return records;
  return records.filter((r) => providers.includes(r.provider));
}
/** Filter records by project name substring. */
export function filterByProject(records, project) {
  if (!project) return records;
  return records.filter((r) => projectNameIncludes(r.project, project));
}
/** Group records by a key extractor. */
function groupBy(records, keyFn) {
  const map = new Map();
  for (const r of records) {
    const key = keyFn(r);
    const arr = map.get(key) || [];
    arr.push(r);
    map.set(key, arr);
  }
  return map;
}
/** Sum tokens for a set of records. */
function sumTokens(records) {
  return {
    input: records.reduce((s, r) => s + r.inputTokens, 0),
    output: records.reduce((s, r) => s + r.outputTokens, 0),
    cacheRead: records.reduce((s, r) => s + r.cacheReadTokens, 0),
    cacheWrite: records.reduce((s, r) => s + r.cacheWriteTokens, 0),
    reasoning: records.reduce((s, r) => s + r.reasoningTokens, 0),
    total: records.reduce(
      (s, r) =>
        s +
        r.inputTokens +
        r.outputTokens +
        r.cacheReadTokens +
        r.cacheWriteTokens +
        r.reasoningTokens,
      0
    ),
    cost: records.reduce((s, r) => s + r.cost, 0),
  };
}
/** Aggregate records into per-project summaries. */
export function aggregateByProject(records) {
  const grouped = groupBy(records, (r) => r.project);
  const totalCost = records.reduce((s, r) => s + r.cost, 0);
  return Array.from(grouped.entries()).map(([project, recs]) => {
    const sums = sumTokens(recs);
    const models = aggregateByModel(recs, totalCost);
    const providers = aggregateByProvider(recs, totalCost);
    const daily = aggregateByDate(recs);
    return {
      project,
      totalTokens: sums.total,
      totalCost: sums.cost,
      inputTokens: sums.input,
      outputTokens: sums.output,
      cacheReadTokens: sums.cacheRead,
      cacheWriteTokens: sums.cacheWrite,
      reasoningTokens: sums.reasoning,
      models,
      providers,
      dailyBreakdown: daily,
      activeDays: daily.length,
      firstUsed: recs.reduce((min, r) => Math.min(min, r.timestamp), Number.POSITIVE_INFINITY),
      lastUsed: recs.reduce((max, r) => Math.max(max, r.timestamp), Number.NEGATIVE_INFINITY),
    };
  });
}
/** Aggregate records into per-model summaries. */
export function aggregateByModel(records, totalCost) {
  // Use a composite key that handles model names containing colons
  const SEP = "\u0000";
  const grouped = groupBy(records, (r) => `${r.provider}${SEP}${r.model}`);
  const total = totalCost ?? records.reduce((s, r) => s + r.cost, 0);
  return Array.from(grouped.entries())
    .map(([key, recs]) => {
      const sums = sumTokens(recs);
      const sepIdx = key.indexOf(SEP);
      const provider = key.slice(0, sepIdx);
      const model = key.slice(sepIdx + SEP.length);
      return {
        model,
        provider: provider,
        inputTokens: sums.input,
        outputTokens: sums.output,
        cacheReadTokens: sums.cacheRead,
        cacheWriteTokens: sums.cacheWrite,
        reasoningTokens: sums.reasoning,
        totalTokens: sums.total,
        cost: sums.cost,
        percentageOfTotal: total > 0 ? (sums.cost / total) * 100 : 0,
      };
    })
    .sort((a, b) => b.cost - a.cost);
}
/** Aggregate records into per-provider summaries. */
export function aggregateByProvider(records, totalCost) {
  const grouped = groupBy(records, (r) => r.provider);
  const total = totalCost ?? records.reduce((s, r) => s + r.cost, 0);
  return Array.from(grouped.entries())
    .map(([provider, recs]) => {
      const sums = sumTokens(recs);
      const models = [...new Set(recs.map((r) => r.model))];
      return {
        provider: provider,
        totalTokens: sums.total,
        cost: sums.cost,
        models,
        percentageOfTotal: total > 0 ? (sums.cost / total) * 100 : 0,
      };
    })
    .sort((a, b) => b.cost - a.cost);
}
/** Aggregate records into daily entries. */
export function aggregateByDate(records) {
  const grouped = groupBy(records, (r) => toDateStr(r.timestamp));
  return Array.from(grouped.entries())
    .map(([date, recs]) => {
      const sums = sumTokens(recs);
      return {
        date,
        totalTokens: sums.total,
        inputTokens: sums.input,
        outputTokens: sums.output,
        cacheReadTokens: sums.cacheRead,
        cacheWriteTokens: sums.cacheWrite,
        reasoningTokens: sums.reasoning,
        cost: sums.cost,
        records: recs.length,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
