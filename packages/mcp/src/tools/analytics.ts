/**
 * Analytics & ranking MCP tools: heatmap, anomaly detection, efficiency, leaderboard.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deriveUsage, localDateKey, type ModelSummary } from "@sriinnu/tokmeter";
import { z } from "zod";
import type { ProviderRow } from "../scoped-view.js";
import {
  barChart,
  fmtCost,
  fmtDatetime,
  fmtNum,
  fmtPct,
  formatTable,
  getScopedRecords,
  getScopedView,
  header,
  modelRequests,
  noDataMessage,
  ProjectFilter,
  ProvidersArray,
  progressBar,
  RAW_RECORD_WINDOW_DAYS,
  READ_ONLY_TOOL,
  ResultLimit,
  rawFooter,
  ScopeEnum,
  separator,
  viewFooter,
} from "./context.js";

/** Register analytics & ranking tools (11-14) on the MCP server. */
export function registerAnalyticsTools(server: McpServer): void {
  // ────────────────────────────────────────────
  // 11. tokmeter_heatmap — Activity heatmap
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_heatmap",
    "Visualize activity patterns as a heatmap — see which hours of the day and days of the week have the heaviest usage. " +
      "Shows both cost and token intensity. Use this to understand work patterns and peak usage times. " +
      `Built from individual records, so the default (all) scope covers the last ${RAW_RECORD_WINDOW_DAYS} days.`,
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
      metric: z
        .enum(["cost", "tokens", "records"])
        .optional()
        .describe("Heatmap metric: cost, tokens, or records (default: cost)"),
    },
    READ_ONLY_TOOL,
    async (params) => {
      const raw = await getScopedRecords(params);
      const records = raw.records;

      if (records.length === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(raw.label) }],
        };
      }

      const metric = params.metric ?? "cost";

      // Build hour-of-day x day-of-week matrix
      const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const heatChars = " ░▒▓█";

      // hourly[hour][dayOfWeek] = accumulated metric
      const hourly: number[][] = Array.from({ length: 24 }, () => Array(7).fill(0));
      // dayTotals[dayOfWeek] and hourTotals[hour]
      const dayTotals: number[] = Array(7).fill(0);
      const hourTotals: number[] = Array(24).fill(0);

      for (const r of records) {
        const d = new Date(r.timestamp);
        const hour = d.getHours();
        const day = d.getDay();
        let value: number;
        if (metric === "cost") value = r.cost;
        else if (metric === "tokens")
          value =
            r.inputTokens +
            r.outputTokens +
            r.cacheReadTokens +
            r.cacheWriteTokens +
            r.reasoningTokens;
        else value = 1; // record count

        hourly[hour][day] += value;
        dayTotals[day] += value;
        hourTotals[hour] += value;
      }

      // Find global max for normalization
      let globalMax = 0;
      for (let h = 0; h < 24; h++) {
        for (let d = 0; d < 7; d++) {
          if (hourly[h][d] > globalMax) globalMax = hourly[h][d];
        }
      }

      const metricLabel = metric === "cost" ? "Cost" : metric === "tokens" ? "Tokens" : "Records";

      const lines = [
        header("HEATMAP"),
        `  Window: ${raw.label}  │  Metric: ${metricLabel}  │  ${records.length} records`,
        separator(),
        "",
        "  Hour-of-Day × Day-of-Week Heatmap",
        `  Intensity: ${heatChars
          .split("")
          .map((c, i) => `${c}${i === 0 ? "=none" : ""}`)
          .join(" ")}`,
        "",
      ];

      // Header row
      lines.push(`        ${DAYS.map((d) => d.padStart(4)).join("")}`);

      // Each hour row
      for (let h = 0; h < 24; h++) {
        const hourLabel = `${String(h).padStart(2, "0")}:00`;
        const cells = DAYS.map((_, d) => {
          const val = hourly[h][d];
          const intensity =
            globalMax > 0 ? Math.round((val / globalMax) * (heatChars.length - 1)) : 0;
          return ` ${heatChars[intensity]}${heatChars[intensity]} `;
        });
        lines.push(`  ${hourLabel}  ${cells.join("")}`);
      }

      // Day-of-week summary
      lines.push("", separator(), "  Busiest Days:");
      const sortedDays = DAYS.map((name, i) => ({
        name,
        total: dayTotals[i],
      })).sort((a, b) => b.total - a.total);
      const maxDay = sortedDays[0]?.total ?? 0;
      for (const d of sortedDays) {
        if (d.total === 0) continue;
        lines.push(
          `    ${d.name}  ${barChart(d.total, maxDay, 15)}  ${metric === "cost" ? fmtCost(d.total) : fmtNum(d.total)}`
        );
      }

      // Hour summary
      lines.push("", "  Busiest Hours:");
      const sortedHours = hourTotals
        .map((total, hour) => ({ hour, total }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 6);
      const maxHour = sortedHours[0]?.total ?? 0;
      for (const h of sortedHours) {
        if (h.total === 0) continue;
        lines.push(
          `    ${String(h.hour).padStart(2, "0")}:00  ${barChart(h.total, maxHour, 15)}  ${metric === "cost" ? fmtCost(h.total) : fmtNum(h.total)}`
        );
      }

      lines.push("", "");
      return {
        content: [{ type: "text", text: lines.join("\n") + rawFooter(raw) }],
      };
    }
  );

  // ────────────────────────────────────────────
  // 12. tokmeter_anomaly — Anomaly detection
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_anomaly",
    "Detect unusual spending patterns and anomalies in token usage. " +
      "Identifies days or sessions with cost spikes, sudden model switches, abnormally large requests, " +
      "and deviation from historical averages. Use this to catch runaway costs or unexpected usage.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
      sensitivity: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("Anomaly detection sensitivity (default: medium)"),
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView(params);
      const daily = view.daily;

      if (daily.length < 2) {
        return {
          content: [
            {
              type: "text",
              text: `${header("ANOMALY")}\n\n  ⚠ Need at least 2 days of data for anomaly detection.\n`,
            },
          ],
        };
      }

      const sensitivity = params.sensitivity ?? "medium";
      const thresholds: Record<string, number> = {
        low: 3.0,
        medium: 2.0,
        high: 1.5,
      };
      const zThreshold = thresholds[sensitivity];

      const lines = [
        header("ANOMALY"),
        `  Scope: ${view.label}  │  Sensitivity: ${sensitivity} (z > ${zThreshold})`,
        separator(),
        "",
      ];
      // Per-request checks need raw records, which only cover recent days.
      const raw = await getScopedRecords(params);
      const records = raw.records;

      // ── Daily cost anomalies (z-score) ──
      const costs = daily.map((d) => d.cost);
      const mean = costs.reduce((s, c) => s + c, 0) / costs.length;
      const variance = costs.reduce((s, c) => s + (c - mean) ** 2, 0) / costs.length;
      const stddev = Math.sqrt(variance);

      const dailyAnomalies: Array<{
        date: string;
        cost: number;
        zScore: number;
        direction: string;
      }> = [];

      if (stddev > 0) {
        for (const d of daily) {
          const z = (d.cost - mean) / stddev;
          if (Math.abs(z) >= zThreshold) {
            dailyAnomalies.push({
              date: d.date,
              cost: d.cost,
              zScore: z,
              direction: z > 0 ? "SPIKE" : "DROP",
            });
          }
        }
      }

      lines.push(`  📊 Daily Cost Anomalies (mean: ${fmtCost(mean)}, stddev: ${fmtCost(stddev)})`);
      if (dailyAnomalies.length === 0) {
        lines.push("    ✓ No anomalous days detected.", "");
      } else {
        for (const a of dailyAnomalies.sort((x, y) => Math.abs(y.zScore) - Math.abs(x.zScore))) {
          const emoji = a.direction === "SPIKE" ? "🔴" : "🔵";
          lines.push(
            `    ${emoji} ${a.date}  │  ${a.direction}  │  Cost: ${fmtCost(a.cost)}  │  z-score: ${a.zScore > 0 ? "+" : ""}${a.zScore.toFixed(2)}  │  ${fmtPct(((a.cost - mean) / mean) * 100)} from mean`
          );
        }
        lines.push("");
      }

      // ── Unusually expensive individual records ──
      if (records.length > 0) {
        const recordCosts = records.map((r) => r.cost);
        const recMean = recordCosts.reduce((s, c) => s + c, 0) / records.length;
        const recVariance =
          recordCosts.reduce((s, c) => s + (c - recMean) ** 2, 0) / records.length;
        const recStddev = Math.sqrt(recVariance);

        const expensiveRecords =
          recStddev > 0
            ? records
                .map((r) => ({ ...r, zScore: (r.cost - recMean) / recStddev }))
                .filter((r) => r.zScore >= zThreshold)
                .sort((a, b) => b.zScore - a.zScore)
                .slice(0, 10)
            : [];

        lines.push(
          `  💸 Unusually Expensive Requests (mean: ${fmtCost(recMean)}/request; ${raw.label})`
        );
        if (expensiveRecords.length === 0) {
          lines.push("    ✓ No outlier requests detected.", "");
        } else {
          for (const r of expensiveRecords) {
            lines.push(
              `    🔴 ${fmtDatetime(r.timestamp)}  │  ${r.model}  │  Cost: ${fmtCost(r.cost)}  │  z: +${r.zScore.toFixed(2)}`,
              `       Project: ${r.project}  │  Tokens: in=${fmtNum(r.inputTokens)} out=${fmtNum(r.outputTokens)}`
            );
          }
          lines.push("");
        }
      }

      // ── Sudden model change detection ──
      const dailyModels = new Map<string, Set<string>>();
      for (const r of records) {
        const date = localDateKey(r.timestamp);
        if (!dailyModels.has(date)) dailyModels.set(date, new Set());
        dailyModels.get(date)!.add(r.model);
      }
      const sortedDates = [...dailyModels.keys()].sort();
      const modelChanges: Array<{
        date: string;
        newModels: string[];
        removedModels: string[];
      }> = [];
      for (let i = 1; i < sortedDates.length; i++) {
        const prev = dailyModels.get(sortedDates[i - 1])!;
        const curr = dailyModels.get(sortedDates[i])!;
        const newModels = [...curr].filter((m) => !prev.has(m));
        const removedModels = [...prev].filter((m) => !curr.has(m));
        if (newModels.length > 0 || removedModels.length > 0) {
          modelChanges.push({ date: sortedDates[i], newModels, removedModels });
        }
      }

      lines.push(`  🔄 Model Change Events (last 5; ${raw.label}):`);
      if (modelChanges.length === 0) {
        lines.push("    ✓ Consistent model usage across all days.", "");
      } else {
        for (const mc of modelChanges.slice(-5)) {
          if (mc.newModels.length > 0) {
            lines.push(`    📥 ${mc.date}: New → ${mc.newModels.join(", ")}`);
          }
          if (mc.removedModels.length > 0) {
            lines.push(`    📤 ${mc.date}: Dropped → ${mc.removedModels.join(", ")}`);
          }
        }
        lines.push("");
      }

      // ── Day-over-day velocity ──
      if (daily.length >= 3) {
        const velocities: Array<{
          date: string;
          change: number;
          pctChange: number;
        }> = [];
        for (let i = 1; i < daily.length; i++) {
          const prev = daily[i - 1].cost;
          const curr = daily[i].cost;
          const change = curr - prev;
          const pctChange = prev > 0 ? (change / prev) * 100 : 0;
          if (Math.abs(pctChange) > 100) {
            velocities.push({ date: daily[i].date, change, pctChange });
          }
        }

        lines.push("  ⚡ Day-over-Day Velocity Spikes (>100% change):");
        if (velocities.length === 0) {
          lines.push("    ✓ No extreme day-over-day changes.", "");
        } else {
          for (const v of velocities.slice(-5)) {
            const emoji = v.change > 0 ? "📈" : "📉";
            lines.push(
              `    ${emoji} ${v.date}  │  ${v.change > 0 ? "+" : ""}${fmtCost(v.change)}  │  ${v.pctChange > 0 ? "+" : ""}${v.pctChange.toFixed(0)}%`
            );
          }
          lines.push("");
        }
      }

      lines.push("");
      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) + rawFooter(raw) }],
      };
    }
  );

  // ────────────────────────────────────────────
  // 13. tokmeter_efficiency — Cache & efficiency metrics
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_efficiency",
    "Token-efficiency ratios for a scope, project or set of providers: cache hit rate, reasoning and output " +
      "shares of all tokens, input:output ratio, cost per 1M tokens and average cost per request — overall and " +
      "per model, plus an estimated caching saving. " +
      "Use it to compare how models spend tokens. For what caching actually saved in dollars and how many " +
      "cache writes were never read back, use tokmeter_cache_efficiency; to rank models on one metric, use tokmeter_leaderboard.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView(params);
      const { stats, models } = view;

      if (stats.totalRecords === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(view.label) }],
        };
      }

      // Global efficiency metrics
      const usage = deriveUsage(stats);
      const cacheHitRate = usage.cacheHitRate * 100;
      const totalAll = stats.totalTokens;
      const reasoningRatio = totalAll > 0 ? (stats.reasoningTokens / totalAll) * 100 : 0;
      const outputRatio = totalAll > 0 ? (stats.outputTokens / totalAll) * 100 : 0;
      const costPerMillionTokens = totalAll > 0 ? (stats.totalCost / totalAll) * 1_000_000 : 0;
      const avgCostPerRecord = stats.totalRecords > 0 ? stats.totalCost / stats.totalRecords : 0;
      const inputOutputRatio = stats.outputTokens > 0 ? stats.inputTokens / stats.outputTokens : 0;

      // Cost savings from caching (estimated: cache reads cost ~90% less than fresh input)
      const estimatedCacheSavings =
        stats.cacheReadTokens > 0
          ? (stats.cacheReadTokens / 1_000_000) * costPerMillionTokens * 0.9
          : 0;

      const lines = [
        header("EFFICIENCY"),
        `  Scope: ${view.label}`,
        separator(),
        "",
        "  Overall Metrics",
        `    Cache Hit Rate:        ${fmtPct(cacheHitRate)}  ${progressBar(cacheHitRate, 100, 20)}`,
        `    Reasoning Ratio:       ${fmtPct(reasoningRatio)}  ${progressBar(reasoningRatio, 100, 20)}`,
        `    Output Ratio:          ${fmtPct(outputRatio)}  ${progressBar(outputRatio, 100, 20)}`,
        `    Input:Output Ratio:    ${inputOutputRatio.toFixed(2)}:1`,
        `    Cost / 1M tokens:      ${fmtCost(costPerMillionTokens)}`,
        `    Avg Cost / Request:    ${fmtCost(avgCostPerRecord)}`,
        `    Est. Cache Savings:    ~${fmtCost(estimatedCacheSavings)}`,
        "",
        separator(),
        "  Per-Model Efficiency",
        "",
      ];

      // Per-model efficiency table
      const modelHeaders = ["Model", "Cache%", "Reason%", "$/1M tok", "Avg $/req"];
      const modelRows: string[][] = [];

      for (const m of models.slice(0, 15)) {
        const modelUsage = deriveUsage(m);
        const mCacheRate = modelUsage.cacheHitRate * 100;
        const mReasonRate = m.totalTokens > 0 ? (m.reasoningTokens / m.totalTokens) * 100 : 0;
        const mCostPer1M = m.totalTokens > 0 ? (m.cost / m.totalTokens) * 1_000_000 : 0;
        const requests = modelRequests(view, m);

        modelRows.push([
          m.model.length > 30 ? `${m.model.slice(0, 27)}...` : m.model,
          fmtPct(mCacheRate),
          fmtPct(mReasonRate),
          fmtCost(mCostPer1M),
          requests ? fmtCost(m.cost / requests) : "—",
        ]);
      }

      lines.push(formatTable(modelHeaders, modelRows, [false, true, true, true, true]));

      // Efficiency recommendations
      lines.push("", separator(), "  💡 Insights", "");

      if (cacheHitRate < 20) {
        lines.push(
          "    ⚠ Low cache hit rate. Consider using longer sessions to benefit from context caching."
        );
      } else if (cacheHitRate > 60) {
        lines.push(
          "    ✓ Excellent cache utilization! Context caching is saving significant costs."
        );
      }

      if (reasoningRatio > 30) {
        lines.push(
          "    ℹ High reasoning token ratio. Models are doing extensive thinking — consider if all tasks need this."
        );
      }

      if (inputOutputRatio > 10) {
        lines.push(
          "    ⚠ Very high input:output ratio. Large prompts with small outputs may indicate overloaded context."
        );
      }

      const mostExpensiveModel = models[0];
      const cheapestModel = models[models.length - 1];
      if (mostExpensiveModel && cheapestModel && models.length > 1) {
        const expRate =
          mostExpensiveModel.totalTokens > 0
            ? (mostExpensiveModel.cost / mostExpensiveModel.totalTokens) * 1_000_000
            : 0;
        const cheapRate =
          cheapestModel.totalTokens > 0
            ? (cheapestModel.cost / cheapestModel.totalTokens) * 1_000_000
            : 0;
        if (expRate > 0 && cheapRate > 0) {
          lines.push(
            `    ℹ Most expensive: ${mostExpensiveModel.model} (${fmtCost(expRate)}/1M tok) vs cheapest: ${cheapestModel.model} (${fmtCost(cheapRate)}/1M tok)`
          );
        }
      }

      lines.push("", "");
      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) }],
      };
    }
  );

  // ────────────────────────────────────────────
  // 14. tokmeter_leaderboard — Rank models/providers
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_leaderboard",
    "Rank the top N models or providers (default 10) in a scope by one metric: total cost, cost per 1M tokens " +
      "(cost_efficiency), total tokens, cache hit rate (cache_rate), reasoning share (reasoning_rate), " +
      "output tokens, or record count. Returns the entries in rank order with their metrics. " +
      'Use it to answer "which model costs most / gives the best value"; for every metric of every model at once, use tokmeter_models.',
    {
      rank_by: z
        .enum([
          "cost",
          "cost_efficiency",
          "tokens",
          "cache_rate",
          "reasoning_rate",
          "output_volume",
          "records",
        ])
        .optional()
        .describe("Ranking metric (default: cost)"),
      entity: z
        .enum(["models", "providers"])
        .optional()
        .describe("Rank models or providers (default: models)"),
      scope: ScopeEnum,
      project: ProjectFilter,
      limit: ResultLimit.describe("Top N to show (default: 10)"),
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView(params);
      const rankBy = params.rank_by ?? "cost";
      const entity = params.entity ?? "models";
      const limit = params.limit ?? 10;

      const lines = [
        header("LEADERBOARD"),
        `  Entity: ${entity}  │  Ranked by: ${rankBy}  │  Scope: ${view.label}`,
        separator(),
        "",
      ];

      if (entity === "models") {
        const models = view.models;

        if (models.length === 0) {
          return {
            content: [{ type: "text", text: noDataMessage(view.label) }],
          };
        }

        // Compute derived metrics for each model
        type ModelMetrics = ModelSummary & {
          costPer1M: number;
          cacheRate: number;
          reasoningRate: number;
          recordCount: number;
        };

        const enriched: ModelMetrics[] = models.map((m) => {
          const usage = deriveUsage(m);
          return {
            ...m,
            costPer1M: m.totalTokens > 0 ? (m.cost / m.totalTokens) * 1_000_000 : 0,
            cacheRate: usage.cacheHitRate * 100,
            reasoningRate: m.totalTokens > 0 ? (m.reasoningTokens / m.totalTokens) * 100 : 0,
            recordCount: modelRequests(view, m) ?? 0,
          };
        });

        // Sort by requested metric
        const sortFns: Record<string, (a: ModelMetrics, b: ModelMetrics) => number> = {
          cost: (a, b) => b.cost - a.cost,
          cost_efficiency: (a, b) => a.costPer1M - b.costPer1M, // ascending = cheaper first
          tokens: (a, b) => b.totalTokens - a.totalTokens,
          cache_rate: (a, b) => b.cacheRate - a.cacheRate,
          reasoning_rate: (a, b) => b.reasoningRate - a.reasoningRate,
          output_volume: (a, b) => b.outputTokens - a.outputTokens,
          records: (a, b) => b.recordCount - a.recordCount,
        };

        enriched.sort(sortFns[rankBy] ?? sortFns.cost);
        const shown = enriched.slice(0, limit);

        const medals = ["🥇", "🥈", "🥉"];
        const maxMetric = Math.max(
          ...shown.map((m) => {
            if (rankBy === "cost") return m.cost;
            if (rankBy === "cost_efficiency") return m.costPer1M;
            if (rankBy === "tokens") return m.totalTokens;
            if (rankBy === "cache_rate") return m.cacheRate;
            if (rankBy === "reasoning_rate") return m.reasoningRate;
            if (rankBy === "output_volume") return m.outputTokens;
            if (rankBy === "records") return m.recordCount;
            return m.cost;
          })
        );

        for (let i = 0; i < shown.length; i++) {
          const m = shown[i];
          const rank = i < 3 ? medals[i] : `#${i + 1}`;
          let metricValue: string;
          let metricRaw: number;

          if (rankBy === "cost") {
            metricValue = fmtCost(m.cost);
            metricRaw = m.cost;
          } else if (rankBy === "cost_efficiency") {
            metricValue = `${fmtCost(m.costPer1M)}/1M tok`;
            metricRaw = m.costPer1M;
          } else if (rankBy === "tokens") {
            metricValue = fmtNum(m.totalTokens);
            metricRaw = m.totalTokens;
          } else if (rankBy === "cache_rate") {
            metricValue = fmtPct(m.cacheRate);
            metricRaw = m.cacheRate;
          } else if (rankBy === "reasoning_rate") {
            metricValue = fmtPct(m.reasoningRate);
            metricRaw = m.reasoningRate;
          } else if (rankBy === "output_volume") {
            metricValue = fmtNum(m.outputTokens);
            metricRaw = m.outputTokens;
          } else if (rankBy === "records") {
            metricValue = view.requestsByModel ? `${m.recordCount} requests` : "— requests";
            metricRaw = m.recordCount;
          } else {
            metricValue = fmtCost(m.cost);
            metricRaw = m.cost;
          }

          const bar = barChart(metricRaw, maxMetric, 15);
          lines.push(
            `  ${rank.padEnd(3)} ${m.model}`,
            `      ${bar}  ${metricValue}  │  Provider: ${m.provider}  │  Total: ${fmtCost(m.cost)}`,
            ""
          );
        }
      } else {
        // providers
        const providers = view.providers;

        if (providers.length === 0) {
          return {
            content: [{ type: "text", text: noDataMessage(view.label) }],
          };
        }

        type ProviderMetrics = ProviderRow & { costPer1M: number };

        const enriched: ProviderMetrics[] = providers.map((p) => ({
          ...p,
          costPer1M: p.totalTokens > 0 ? (p.cost / p.totalTokens) * 1_000_000 : 0,
        }));

        const sortFns: Record<string, (a: ProviderMetrics, b: ProviderMetrics) => number> = {
          cost: (a, b) => b.cost - a.cost,
          cost_efficiency: (a, b) => a.costPer1M - b.costPer1M,
          tokens: (a, b) => b.totalTokens - a.totalTokens,
          records: (a, b) => b.recordCount - a.recordCount,
        };

        enriched.sort(sortFns[rankBy] ?? sortFns.cost);
        const shown = enriched.slice(0, limit);
        const medals = ["🥇", "🥈", "🥉"];

        for (let i = 0; i < shown.length; i++) {
          const p = shown[i];
          const rank = i < 3 ? medals[i] : `#${i + 1}`;
          lines.push(
            `  ${rank.padEnd(3)} ${p.provider.toUpperCase()}`,
            `      Cost: ${fmtCost(p.cost)}  │  Tokens: ${fmtNum(p.totalTokens)}  │  $/1M tok: ${fmtCost(p.costPer1M)}  │  Requests: ${p.recordCount}`,
            `      Models: ${p.models.join(", ")}`,
            ""
          );
        }
      }

      lines.push("");
      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) }],
      };
    }
  );
}
