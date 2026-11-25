/**
 * Narrative insights MCP tools: digest, streaks, cache efficiency, model advisor.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  deriveUsage,
  fetchDaemonJson,
  localDateKey,
  type ModelRatesResponse,
  TokmeterCore,
} from "@sriinnu/tokmeter";
import { z } from "zod";
import { shiftDayKey } from "../scoped-view.js";
import {
  BoundedLabel,
  fmtCost,
  fmtNum,
  fmtPct,
  formatTable,
  getCore,
  getScopedRecords,
  getScopedView,
  header,
  modelRequests,
  noDataMessage,
  ProjectFilter,
  ProvidersArray,
  READ_ONLY_TOOL,
  rawFooter,
  ScopeEnum,
  separator,
  sparkline,
  viewFooter,
} from "./context.js";

/** Register insight & advisor tools (15-18) on the MCP server. */
export function registerInsightTools(server: McpServer): void {
  // ────────────────────────────────────────────
  // 15. tokmeter_digest — Natural language summary
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_digest",
    "Generate a concise natural language summary of token usage — like a daily/weekly briefing. " +
      "Highlights key stats, top spenders, notable trends, and actionable insights in prose form. " +
      "Use this when the user wants a quick narrative overview rather than tables.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView(params);
      const { stats, models, providers, projects, daily } = view;

      if (stats.totalRecords === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(view.label) }],
        };
      }

      const scope = view.label;

      // Build narrative
      const lines: string[] = [header("DIGEST"), `  ${scope} Usage Summary`, separator(), ""];

      // Opening summary
      lines.push(
        `  Over ${stats.activeDays} active day(s), you have consumed ${fmtNum(stats.totalTokens)} tokens`,
        `  across ${stats.models} model(s) from ${stats.providers} provider(s), spanning`,
        `  ${stats.projects} project(s) — totaling ${fmtCost(stats.totalCost)} in cost.`,
        ""
      );

      // Top model
      if (models.length > 0) {
        const top = models[0];
        lines.push(
          `  Your most-used model is ${top.model} (via ${top.provider}), accounting`,
          `  for ${fmtPct(top.percentageOfTotal)} of total spend at ${fmtCost(top.cost)}.`
        );
        if (models.length > 1) {
          lines.push(
            `  Runner-up: ${models[1].model} at ${fmtCost(models[1].cost)} (${fmtPct(models[1].percentageOfTotal)}).`
          );
        }
        lines.push("");
      }

      // Top provider
      if (providers.length > 0) {
        const top = providers[0];
        lines.push(
          `  The dominant provider is ${top.provider} with ${fmtPct(top.percentageOfTotal)} of`,
          `  total cost and ${top.models.length} active model(s).`,
          ""
        );
      }

      // Top project
      if (projects.length > 0) {
        const top = projects[0];
        const totalCost = projects.reduce((s, p) => s + p.totalCost, 0);
        const share = totalCost > 0 ? (top.totalCost / totalCost) * 100 : 0;
        lines.push(
          `  Your most expensive project is "${top.project}" at ${fmtCost(top.totalCost)}`,
          `  (${fmtPct(share)} of total), active for ${top.activeDays} day(s).`,
          ""
        );
      }

      // Trend
      if (daily.length >= 3) {
        const recent = daily.slice(-3);
        const earlier = daily.slice(-6, -3);
        const recentAvg = recent.reduce((s, d) => s + d.cost, 0) / recent.length;
        const earlierAvg =
          earlier.length > 0 ? earlier.reduce((s, d) => s + d.cost, 0) / earlier.length : recentAvg;

        if (earlierAvg > 0) {
          const change = ((recentAvg - earlierAvg) / earlierAvg) * 100;
          if (Math.abs(change) > 10) {
            lines.push(
              `  Trend: Your recent daily spend is ${change > 0 ? "up" : "down"} ${fmtPct(Math.abs(change))}`,
              `  compared to earlier in the period (${fmtCost(recentAvg)}/day vs ${fmtCost(earlierAvg)}/day).`,
              ""
            );
          } else {
            lines.push(`  Trend: Spending is relatively stable at ~${fmtCost(recentAvg)}/day.`, "");
          }
        }
      }

      // Cache efficiency note
      const usage = deriveUsage(stats);
      const cacheRate = usage.cacheHitRate * 100;
      if (cacheRate > 0) {
        lines.push(
          `  Cache utilization: ${fmtPct(cacheRate)} of input tokens are served from cache.`,
          cacheRate > 50
            ? "  Great cache efficiency — this is saving you significant money."
            : cacheRate > 20
              ? "  Moderate cache usage — longer sessions could improve this."
              : "  Low cache hit rate — consider maintaining longer sessions for better caching.",
          ""
        );
      }

      // Busiest day
      if (daily.length > 0) {
        const busiest = daily.reduce((max, d) => (d.cost > max.cost ? d : max), daily[0]);
        lines.push(
          `  Busiest day: ${busiest.date} with ${fmtCost(busiest.cost)} spent across`,
          `  ${busiest.records} request(s) and ${fmtNum(busiest.totalTokens)} tokens.`,
          ""
        );
      }

      // Sparkline footer
      const costSpark = sparkline(daily.map((d) => d.cost));
      lines.push(separator(), `  Daily Cost:  ${costSpark}`, "");

      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) }],
      };
    }
  );

  // ────────────────────────────────────────────
  // 16. tokmeter_streaks — Usage streaks & habits
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_streaks",
    "Analyze your AI coding habits — active day streaks, weekend vs weekday usage, session frequency, " +
      "and consistency metrics. Use this to understand how regularly and intensively you use AI coding agents.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView(params);
      const { daily, stats } = view;

      if (daily.length === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(view.label) }],
        };
      }

      const lines = [header("STREAKS & HABITS"), `  Scope: ${view.label}`, separator(), ""];

      // ── Current streak ──
      const daySet = new Set(daily.map((d) => d.date));
      const allDates = [...daySet].sort().reverse(); // most recent first

      // Day keys are LOCAL calendar days (core keys usage that way), so walk
      // them as local days too — UTC math put "today" a day off in the evening.
      let currentStreak = 0;
      const today = localDateKey();
      let checkDate = today;
      // Check if today or yesterday is the starting point
      if (!daySet.has(today)) {
        const yesterday = shiftDayKey(today, -1);
        if (daySet.has(yesterday)) {
          checkDate = yesterday;
        } else {
          checkDate = allDates[0] || today; // last active day
        }
      }

      // Count consecutive days back from checkDate
      let cursor = checkDate;
      while (daySet.has(cursor)) {
        currentStreak++;
        cursor = shiftDayKey(cursor, -1);
      }

      // ── Longest streak ──
      const sortedDates = [...daySet].sort();
      let longestStreak = 0;
      let longestStreakStart = "";
      let longestStreakEnd = "";
      let tempStreak = 1;
      let tempStart = sortedDates[0];
      for (let i = 1; i < sortedDates.length; i++) {
        const diff =
          (new Date(sortedDates[i]).getTime() - new Date(sortedDates[i - 1]).getTime()) / 86400000;
        if (diff === 1) {
          tempStreak++;
        } else {
          if (tempStreak > longestStreak) {
            longestStreak = tempStreak;
            longestStreakStart = tempStart;
            longestStreakEnd = sortedDates[i - 1];
          }
          tempStreak = 1;
          tempStart = sortedDates[i];
        }
      }
      if (tempStreak > longestStreak) {
        longestStreak = tempStreak;
        longestStreakStart = tempStart;
        longestStreakEnd = sortedDates[sortedDates.length - 1];
      }

      lines.push(
        `  🔥 Current Streak:  ${currentStreak} day(s)`,
        `  🏆 Longest Streak:  ${longestStreak} day(s) (${longestStreakStart} → ${longestStreakEnd})`,
        `  📅 Active Days:     ${stats.activeDays}`,
        `  📦 Requests/Day:    ${(stats.activeDays > 0 ? stats.totalRecords / stats.activeDays : 0).toFixed(1)} avg`,
        ""
      );

      // ── Date range span & coverage ──
      if (sortedDates.length >= 2) {
        const firstDate = new Date(sortedDates[0]);
        const lastDate = new Date(sortedDates[sortedDates.length - 1]);
        const spanDays = Math.round((lastDate.getTime() - firstDate.getTime()) / 86400000) + 1;
        const coverage = (stats.activeDays / spanDays) * 100;
        lines.push(
          `  📊 Date Range:      ${sortedDates[0]} → ${sortedDates[sortedDates.length - 1]} (${spanDays} days)`,
          `  📈 Coverage:        ${fmtPct(coverage)} of days active`,
          ""
        );
      }

      // ── Weekday vs weekend ──
      let weekdayCost = 0;
      let weekdayDays = 0;
      let weekendCost = 0;
      let weekendDays = 0;

      for (const d of daily) {
        const dayOfWeek = new Date(`${d.date}T12:00:00`).getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          weekendCost += d.cost;
          weekendDays++;
        } else {
          weekdayCost += d.cost;
          weekdayDays++;
        }
      }

      const weekdayAvg = weekdayDays > 0 ? weekdayCost / weekdayDays : 0;
      const weekendAvg = weekendDays > 0 ? weekendCost / weekendDays : 0;

      lines.push(
        "  Weekday vs Weekend",
        `    Weekday:  ${weekdayDays} active day(s)  │  Avg: ${fmtCost(weekdayAvg)}/day  │  Total: ${fmtCost(weekdayCost)}`,
        `    Weekend:  ${weekendDays} active day(s)  │  Avg: ${fmtCost(weekendAvg)}/day  │  Total: ${fmtCost(weekendCost)}`,
        weekendAvg > weekdayAvg
          ? "    → You spend MORE on weekends! 🌴"
          : weekdayAvg > weekendAvg * 2
            ? "    → Weekdays are significantly heavier. 💼"
            : "    → Fairly balanced usage. ⚖️",
        ""
      );

      // ── Session intensity ──
      // Group records into sessions (records within 30 min of each other).
      // Sessions need raw timestamps, which only cover recent days, so the
      // request counts here come from the same raw records, not the ledger.
      const raw = await getScopedRecords(params);
      const records = raw.records;
      const sortedRecords = [...records].sort((a, b) => a.timestamp - b.timestamp);
      let sessionCount = 0;
      let lastTs = 0;
      const SESSION_GAP = 30 * 60 * 1000; // 30 min
      for (const r of sortedRecords) {
        if (r.timestamp - lastTs > SESSION_GAP) {
          sessionCount++;
        }
        lastTs = r.timestamp;
      }

      const rawActiveDays = new Set(records.map((r) => localDateKey(r.timestamp))).size;
      const avgSessionsPerDay = rawActiveDays > 0 ? sessionCount / rawActiveDays : 0;

      lines.push(
        `  Session Analysis (30min gap = new session; ${raw.label})`,
        `    Total Sessions:      ~${sessionCount}`,
        `    Avg Sessions/Day:    ${avgSessionsPerDay.toFixed(1)}`,
        `    Avg Requests/Session: ${sessionCount > 0 ? (records.length / sessionCount).toFixed(1) : "—"}`,
        ""
      );

      // ── Weekly activity pattern (mini calendar) ──
      const weekMap = new Map<string, number>(); // ISO week -> cost
      for (const d of daily) {
        const date = new Date(`${d.date}T12:00:00`);
        // Approximate ISO week
        const jan1 = new Date(date.getFullYear(), 0, 1);
        const weekNum = Math.ceil(
          ((date.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7
        );
        const weekKey = `${date.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
        weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + d.cost);
      }

      const weeks = [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      if (weeks.length > 1) {
        const weekCosts = weeks.map(([, c]) => c);
        lines.push(
          `  Weekly Trend:  ${sparkline(weekCosts)}`,
          `    (${weeks.length} weeks, min: ${fmtCost(Math.min(...weekCosts))}, max: ${fmtCost(Math.max(...weekCosts))})`,
          ""
        );
      }

      lines.push("");
      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) + rawFooter(raw) }],
      };
    }
  );

  // ────────────────────────────────────────────
  // 17. cache_efficiency — Cache hit/miss analysis
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_cache_efficiency",
    "Prompt-caching payoff for today, the last 7 days or this month, optionally for one provider or project: " +
      "cache hit rate, cache read and write volumes, and a per-model breakdown, plus ESTIMATED dollars — savings " +
      "(cached reads assumed ~90% cheaper than input), the write premium (assumed ~25% over input) and the net. " +
      "The estimates use the scope's average input price, not each model's card. Use it to judge whether caching " +
      "pays off; for general token ratios across models, use tokmeter_efficiency.",
    {
      period: z
        .enum(["today", "week", "month"])
        .optional()
        .describe("Time period to analyze: today, week, or month"),
      provider: BoundedLabel.optional().describe("Filter to a specific provider"),
      project: ProjectFilter,
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView({
        scope: params.period,
        project: params.project,
        providers: params.provider ? [params.provider] : undefined,
      });
      const { stats } = view;

      if (stats.totalRecords === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(view.label) }],
        };
      }

      // Aggregate totals
      const usage = deriveUsage(stats);
      const totalCacheRead = usage.cacheReadTokens;
      const totalCacheWrite = usage.cacheWriteTokens;
      const totalInputTokens = usage.totalInputTokens;

      // Cache hit rate: reads / (input + reads + writes). If no input activity, 0%.
      const totalCacheTokens = totalCacheRead + totalCacheWrite;
      const hitRate = usage.cacheHitRate * 100;

      // Estimate savings: cache reads cost ~10% of input price, so you save ~90% per cached token.
      // We approximate by looking at average input cost per token across the dataset.
      const totalCost = stats.totalCost;
      const avgCostPerInputToken = totalInputTokens > 0 ? (totalCost * 0.4) / totalInputTokens : 0; // ~40% of cost is input
      const cacheSavings = totalCacheRead * avgCostPerInputToken * 0.9; // saved 90% of input price
      const cacheWaste = totalCacheWrite * avgCostPerInputToken * 0.25; // cache write premium ~25%

      const periodLabel = view.label;

      const lines = [
        header("CACHE EFFICIENCY"),
        `  Period: ${periodLabel}${params.provider ? ` │ Provider: ${params.provider}` : ""}${params.project ? ` │ Project: ${params.project}` : ""}`,
        separator(),
        "",
        `  📊 Overall Cache Hit Rate:  ${fmtPct(hitRate)}`,
        `     ├─ Cache Reads:   ${fmtNum(totalCacheRead)} tokens`,
        `     ├─ Cache Writes:  ${fmtNum(totalCacheWrite)} tokens`,
        `     ├─ Fresh Input:   ${fmtNum(usage.freshInputTokens)} tokens`,
        `     └─ Total Input:   ${fmtNum(usage.totalInputTokens)} tokens`,
        "",
        `  💰 Cache Savings:   ~${fmtCost(cacheSavings)}  (what you saved vs full input price)`,
        `  🗑️  Cache Waste:     ~${fmtCost(cacheWaste)}  (premium paid on writes never amortized)`,
        `  📈 Net Benefit:     ~${fmtCost(cacheSavings - cacheWaste)}`,
        "",
      ];

      // Per-model breakdown
      const modelEntries = view.models
        .filter((m) => m.cacheReadTokens + m.cacheWriteTokens > 0)
        .sort((a, b) => b.cacheReadTokens - a.cacheReadTokens);

      if (modelEntries.length > 0) {
        lines.push("  Per-Model Cache Breakdown", separator(), "");
        const tableHeaders = ["Model", "Hit Rate", "Reads", "Writes", "Calls"];
        const tableRows = modelEntries.map((m) => {
          const mHitRate = deriveUsage(m).cacheHitRate * 100;
          const calls = modelRequests(view, m);
          return [
            m.model,
            fmtPct(mHitRate),
            fmtNum(m.cacheReadTokens),
            fmtNum(m.cacheWriteTokens),
            calls === null ? "—" : String(calls),
          ];
        });
        lines.push(formatTable(tableHeaders, tableRows, [false, true, true, true, true]));
        lines.push("");
      }

      // Recommendation
      lines.push(separator(), "");
      if (hitRate >= 90) {
        lines.push(
          `  ✅ Excellent! Your cache hit rate is ${fmtPct(hitRate)} — caching saves you ~${fmtCost(cacheSavings)}/period.`,
          "     Keep conversations going to maintain high cache utilization."
        );
      } else if (hitRate >= 70) {
        lines.push(
          `  💡 Good cache usage at ${fmtPct(hitRate)}. Consider longer conversations to improve hit rates.`,
          `     Potential additional savings if you reach 90%+: ~${fmtCost(cacheSavings * 0.3)}/period.`
        );
      } else if (totalCacheTokens > 0) {
        if (totalCacheWrite > totalCacheRead) {
          lines.push(
            `  ⚠️  Low cache hit rate: ${fmtPct(hitRate)}. You're paying for cache writes but not reusing them.`,
            "     Try: longer conversations, fewer new sessions, and keeping context warm."
          );
        } else {
          lines.push(
            `  ⚠️  Low total-input cache hit rate: ${fmtPct(hitRate)}. Fresh input is dominating this period.`,
            "     Try keeping stable context warm and avoiding large one-off prompt reloads."
          );
        }
      } else {
        lines.push(
          "  ℹ️  No cache activity detected. Your providers may not support prompt caching,",
          "     or caching stats aren't being reported."
        );
      }
      lines.push("");

      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) }],
      };
    }
  );

  // ────────────────────────────────────────────
  // 18. model_advisor — Cheaper model suggestions
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_model_advisor",
    "Show observed spending by model, live kosha per-million-token rates, and neutral " +
      "workload cost projections across your priced models for the selected period and project.",
    {
      period: z
        .enum(["today", "week", "month"])
        .optional()
        .describe("Time period to analyze: today, week, or month"),
      project: ProjectFilter,
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView({ scope: params.period, project: params.project });
      const models = view.models;

      if (models.length === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(view.label) }],
        };
      }

      const periodLabel = view.label;

      const lines = [
        header("MODEL ADVISOR"),
        `  Period: ${periodLabel}${params.project ? ` │ Project: ${params.project}` : ""}`,
        separator(),
        "",
        "  Current Spending by Model",
        separator(),
        "",
      ];

      // Current spend table
      const currentHeaders = ["Model", "Cost", "Share", "Input Tok", "Output Tok"];
      const currentRows = models
        .slice(0, 15)
        .map((m) => [
          m.model,
          fmtCost(m.cost),
          fmtPct(m.percentageOfTotal),
          fmtNum(m.inputTokens),
          fmtNum(m.outputTokens),
        ]);
      lines.push(formatTable(currentHeaders, currentRows, [false, true, true, true, true]));
      lines.push("");

      const rateScope = params.period === "today" ? "today" : "all";
      let rateResp: ModelRatesResponse | null = null;
      let rateCore: TokmeterCore | null = null;
      const daemonRates = await fetchDaemonJson<ModelRatesResponse>(
        `/api/rates?scope=${rateScope}`,
        { probeTimeoutMs: 500, timeoutMs: 10_000, warmingTimeoutMs: 60_000 }
      );
      if (daemonRates.ok) {
        const byModel = new Map(daemonRates.data.models.map((card) => [card.model, card]));
        const matched = models
          .map((m) => byModel.get(m.model))
          .filter((c): c is NonNullable<typeof c> => Boolean(c));
        if (matched.length === models.length) {
          rateResp = { ...daemonRates.data, models: matched };
        }
      }
      if (!rateResp) {
        const { core } = await getCore();
        rateCore = core;
        rateResp = await core.getModelRatesFor(models, rateScope);
      }
      const pricingCore = rateCore ?? new TokmeterCore();
      const fmtRate = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);

      lines.push("", "  Live Kosha Rates ($/MTok)", separator(), "");
      const rateHeaders = ["Model", "Input", "Output", "Cache Read", "Effective", "Source"];
      const rateRows = rateResp.models
        .slice(0, 15)
        .map((card) => [
          card.model,
          fmtRate(card.rates.input.perMillion),
          fmtRate(card.rates.output.perMillion),
          fmtRate(card.rates.cacheRead.perMillion),
          fmtRate(card.effectivePerMillion),
          card.source.matchedId
            ? `${card.source.tier} (${card.source.matchedId})`
            : card.source.tier,
        ]);
      lines.push(formatTable(rateHeaders, rateRows, [false, true, true, true, true, false]));

      let totalActual = 0;
      let sumInput = 0;
      let sumOutput = 0;
      let sumCacheRead = 0;
      let sumCacheWrite = 0;
      let sumReasoning = 0;
      for (const m of models) {
        totalActual += m.cost;
        sumInput += m.inputTokens;
        sumOutput += m.outputTokens;
        sumCacheRead += m.cacheReadTokens;
        sumCacheWrite += m.cacheWriteTokens;
        sumReasoning += m.reasoningTokens;
      }

      const pricedCards = rateResp.models.filter(
        (c) => c.rates.input.perMillion !== null && c.rates.output.perMillion !== null
      );
      const projections = await Promise.all(
        pricedCards.map(async (card) => ({
          model: card.model,
          projected: await pricingCore.calculateModelCost(
            card.model,
            sumInput,
            sumOutput,
            sumCacheRead,
            sumCacheWrite,
            sumReasoning,
            0
          ),
        }))
      );
      projections.sort((a, b) => a.projected - b.projected);

      if (projections.length > 0) {
        lines.push(
          "",
          "  Workload Projection (same token mix across priced observed models)",
          separator(),
          ""
        );
        const projHeaders = ["Model", "Projected Total", "Delta vs Actual", "Ratio"];
        const projRows = projections.slice(0, 15).map((p) => {
          const delta = p.projected - totalActual;
          const deltaStr = delta >= 0 ? `+${fmtCost(delta)}` : `-${fmtCost(Math.abs(delta))}`;
          const ratioStr = totalActual > 0 ? `${(p.projected / totalActual).toFixed(2)}x` : "—";
          return [p.model, fmtCost(p.projected), deltaStr, ratioStr];
        });
        lines.push(formatTable(projHeaders, projRows, [false, true, true, true]));
        lines.push(
          "",
          separator(),
          `  Actual Total Spend: ${fmtCost(totalActual)}`,
          "  Note: Assumes identical token counts at each model's live kosha card (no quality comparison).",
          ""
        );
      } else {
        lines.push(
          "",
          "  No observed models in this scope have live kosha pricing cards.",
          `  Actual Total Spend: ${fmtCost(totalActual)}`,
          ""
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) }],
      };
    }
  );
}
