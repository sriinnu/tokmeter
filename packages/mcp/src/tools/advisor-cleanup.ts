/**
 * Budget alert, cost optimization, and read-only cleanup preview / backup MCP tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deriveUsage, localDateKey, sanitizeDataLabel } from "@sriinnu/tokmeter";
import { z } from "zod";
import {
  buildCleanupFilter,
  DollarAmount,
  fmtCost,
  fmtDate,
  fmtNum,
  fmtPct,
  formatTable,
  getScopedView,
  header,
  noDataMessage,
  ProjectFilter,
  ProvidersArray,
  progressBar,
  READ_ONLY_TOOL,
  ScopeEnum,
  SinceDate,
  separator,
  UntilDate,
  viewFooter,
} from "./context.js";

/** Register budget alert, cost tips, cleanup preview, and backups tools (19-22). */
export function registerAdvisorAndCleanupTools(server: McpServer): void {
  // ────────────────────────────────────────────
  // 19. budget_alert — Proactive budget monitoring
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_budget_alert",
    "Whole-account budget status: pass a daily budget (required) and optionally weekly and monthly ones. " +
      "For each: spend so far, percent used, projected end-of-period spend at the current hourly burn rate, " +
      "hours left before the budget runs out, and a status of OK (<80%), WARNING (80–99%) or OVER BUDGET. " +
      "Covers all providers and projects; to check a budget for one project or provider, use tokmeter_budget. " +
      "Nothing is stored or scheduled: it reports on demand.",
    {
      daily_budget: DollarAmount.describe("Daily budget in USD"),
      weekly_budget: DollarAmount.optional().describe("Weekly budget in USD"),
      monthly_budget: DollarAmount.optional().describe("Monthly budget in USD"),
    },
    READ_ONLY_TOOL,
    async (params) => {
      const now = new Date();
      const todayStr = localDateKey(now.getTime());

      // All three come from one today + relay scan, narrowed per window.
      const todayView = await getScopedView({ scope: "today" });
      const todaySpend = todayView.stats.totalCost;
      const weekView = await getScopedView({ scope: "week" });
      const weekSpend = weekView.stats.totalCost;
      const monthView = await getScopedView({ scope: "month" });
      const monthSpend = monthView.stats.totalCost;

      /** Determine status color based on usage percentage. */
      function budgetStatus(pct: number): string {
        if (pct >= 100) return "🔴 OVER BUDGET";
        if (pct >= 80) return "🟡 WARNING";
        return "🟢 OK";
      }

      /** Calculate hours remaining at current burn rate. */
      function hoursRemaining(
        spent: number,
        budget: number,
        _hoursInPeriod: number,
        hoursElapsed: number
      ): string {
        if (spent === 0) return "∞";
        const burnRate = spent / Math.max(hoursElapsed, 1); // $/hour
        const remaining = budget - spent;
        if (remaining <= 0) return "0.0";
        return (remaining / burnRate).toFixed(1);
      }

      // Hours elapsed today
      const hoursElapsedToday = now.getHours() + now.getMinutes() / 60;
      const hoursInDay = 24;

      // Hours elapsed in the rolling week: six full days before today, plus today.
      const hoursElapsedWeek = 6 * 24 + hoursElapsedToday;
      const hoursInWeek = 7 * 24;

      // Hours elapsed this month
      const dayOfMonth = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const hoursElapsedMonth = (dayOfMonth - 1) * 24 + hoursElapsedToday;
      const hoursInMonth = daysInMonth * 24;

      // Projections based on burn rate
      const projectedDaily =
        hoursElapsedToday > 0 ? (todaySpend / hoursElapsedToday) * hoursInDay : 0;
      const projectedWeekly =
        hoursElapsedWeek > 0 ? (weekSpend / hoursElapsedWeek) * hoursInWeek : 0;
      const projectedMonthly =
        hoursElapsedMonth > 0 ? (monthSpend / hoursElapsedMonth) * hoursInMonth : 0;

      const dailyPct = (todaySpend / params.daily_budget) * 100;

      const lines = [
        header("BUDGET ALERT"),
        `  Date: ${todayStr}  │  Time: ${now.toTimeString().slice(0, 8)}`,
        separator(),
        "",
        "  📅 Daily Budget",
        `     Budget:     ${fmtCost(params.daily_budget)}`,
        `     Spent:      ${fmtCost(todaySpend)}`,
        `     Used:       ${fmtPct(dailyPct)}  ${progressBar(todaySpend, params.daily_budget)}`,
        `     Projected:  ${fmtCost(projectedDaily)} by end of day`,
        `     Status:     ${budgetStatus(dailyPct)}`,
        `     Remaining:  ${hoursRemaining(todaySpend, params.daily_budget, hoursInDay, hoursElapsedToday)} hours until budget exceeded`,
        "",
      ];

      if (params.weekly_budget) {
        const weeklyPct = (weekSpend / params.weekly_budget) * 100;
        lines.push(
          `  📅 Weekly Budget (${weekView.label})`,
          `     Budget:     ${fmtCost(params.weekly_budget)}`,
          `     Spent:      ${fmtCost(weekSpend)}`,
          `     Used:       ${fmtPct(weeklyPct)}  ${progressBar(weekSpend, params.weekly_budget)}`,
          `     Projected:  ${fmtCost(projectedWeekly)} by end of week`,
          `     Status:     ${budgetStatus(weeklyPct)}`,
          `     Remaining:  ${hoursRemaining(weekSpend, params.weekly_budget, hoursInWeek, hoursElapsedWeek)} hours until budget exceeded`,
          ""
        );
      }

      if (params.monthly_budget) {
        const monthlyPct = (monthSpend / params.monthly_budget) * 100;
        lines.push(
          "  📅 Monthly Budget",
          `     Budget:     ${fmtCost(params.monthly_budget)}`,
          `     Spent:      ${fmtCost(monthSpend)}`,
          `     Used:       ${fmtPct(monthlyPct)}  ${progressBar(monthSpend, params.monthly_budget)}`,
          `     Projected:  ${fmtCost(projectedMonthly)} by end of month`,
          `     Status:     ${budgetStatus(monthlyPct)}`,
          `     Remaining:  ${hoursRemaining(monthSpend, params.monthly_budget, hoursInMonth, hoursElapsedMonth)} hours until budget exceeded`,
          ""
        );
      }

      // Cost drivers — top models from today if over budget
      if (dailyPct >= 80) {
        const modelCosts = todayView.models;
        if (modelCosts.length > 0) {
          lines.push(separator(), "", "  ⚡ Cost Drivers (Today)", "");
          const driverHeaders = ["Model", "Cost", "Share"];
          const driverRows = modelCosts
            .slice(0, 5)
            .map((m) => [m.model, fmtCost(m.cost), fmtPct(m.percentageOfTotal)]);
          lines.push(formatTable(driverHeaders, driverRows, [false, true, true]));
          lines.push("");
        }
      }

      lines.push("");
      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(monthView) }],
      };
    }
  );

  // ────────────────────────────────────────────
  // 20. cost_optimization_tips — Actionable recommendations
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_cost_optimization_tips",
    "Analyze usage patterns and provide actionable cost optimization recommendations. " +
      "Generates tips based on actual data — cache efficiency, model selection, conversation length, " +
      "and spending distribution. Each tip includes category, severity, and estimated savings.",
    {
      period: z
        .enum(["today", "week", "month"])
        .optional()
        .describe("Time period to analyze: today, week, or month"),
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView({ scope: params.period });
      const { models, stats } = view;

      if (stats.totalRecords === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(view.label) }],
        };
      }

      const totalCost = stats.totalCost;

      interface Tip {
        category: string;
        severity: "info" | "warning" | "critical";
        tip: string;
        estimatedSavings: number;
      }

      const tips: Tip[] = [];

      // ── Tip 1: Cache efficiency ──
      const usage = deriveUsage(stats);
      const cacheHitRate = usage.hasCacheTelemetry ? usage.cacheHitRate * 100 : -1;

      if (cacheHitRate >= 0 && cacheHitRate < 80) {
        const potentialSavings = totalCost * 0.1; // ~10% savings from better caching
        tips.push({
          category: "caching",
          severity: cacheHitRate < 50 ? "critical" : "warning",
          tip: `Cache hit rate is only ${fmtPct(cacheHitRate)}. Try longer conversations instead of starting fresh sessions. Each new session discards cached context and re-sends the full prompt.`,
          estimatedSavings: potentialSavings,
        });
      }

      // ── Tip 2: Higher effective-rate concentration ──
      const rated = models
        .filter((m) => m.totalTokens > 0 && m.cost > 0)
        .map((m) => ({
          model: m.model,
          cost: m.cost,
          ratePerMTok: (m.cost / m.totalTokens) * 1_000_000,
        }))
        .sort((a, b) => b.ratePerMTok - a.ratePerMTok);
      if (rated.length > 1) {
        const highest = rated[0];
        const lowest = rated[rated.length - 1];
        const highModels = rated.filter((m) => m.ratePerMTok >= lowest.ratePerMTok * 2);
        const highSpend = highModels.reduce((s, m) => s + m.cost, 0);
        const highPct = totalCost > 0 ? (highSpend / totalCost) * 100 : 0;

        if (highPct > 50 && highest.ratePerMTok > lowest.ratePerMTok) {
          const potentialSavings = Math.max(
            0,
            highSpend * (1 - lowest.ratePerMTok / highest.ratePerMTok)
          );
          tips.push({
            category: "model_selection",
            severity: highPct > 80 ? "critical" : "warning",
            tip: `${fmtPct(highPct)} of spend went to higher-rate models (top: ${highest.model} at $${highest.ratePerMTok.toFixed(2)}/MTok vs ${lowest.model} at $${lowest.ratePerMTok.toFixed(2)}/MTok).`,
            estimatedSavings: potentialSavings,
          });
        }
      }

      // ── Tip 3: Large input tokens (conversation bloat) ──
      const avgInputPerCall =
        stats.totalRecords > 0 ? usage.freshInputTokens / stats.totalRecords : 0;

      if (avgInputPerCall > 100_000) {
        const potentialSavings = totalCost * 0.15;
        tips.push({
          category: "conversation_length",
          severity: avgInputPerCall > 200_000 ? "critical" : "warning",
          tip: `Average input tokens per call is ${fmtNum(avgInputPerCall)} — that's large. Consider compacting conversations, using /clear or /compact, or starting fresh sessions when context gets too long. Long contexts inflate every subsequent request.`,
          estimatedSavings: potentialSavings,
        });
      }

      // ── Tip 4: Disproportionate project spending ──
      const projects = view.projects;
      if (projects.length >= 2) {
        const topProject = projects[0];
        const topPct = totalCost > 0 ? (topProject.totalCost / totalCost) * 100 : 0;
        if (topPct > 60) {
          tips.push({
            category: "time_of_day",
            severity: "info",
            tip: `Project "${topProject.project}" accounts for ${fmtPct(topPct)} of total spend (${fmtCost(topProject.totalCost)}). Consider whether all that usage is necessary, or if some tasks could use cheaper models or be batched more efficiently.`,
            estimatedSavings: topProject.totalCost * 0.2,
          });
        }
      }

      // ── Tip 5: No caching at all ──
      if (cacheHitRate === -1) {
        tips.push({
          category: "caching",
          severity: "info",
          tip:
            "No prompt caching activity detected. If your provider supports caching " +
            "(Claude, GPT-4o), ensure it's enabled. Prompt caching can save 80-90% on repeated context.",
          estimatedSavings: totalCost * 0.2,
        });
      }

      // ── Tip 6: High reasoning token usage ──
      const totalReasoning = stats.reasoningTokens;
      const totalOutput = stats.outputTokens;
      const reasoningPct = totalOutput > 0 ? (totalReasoning / totalOutput) * 100 : 0;
      if (reasoningPct > 50) {
        tips.push({
          category: "model_selection",
          severity: "info",
          tip: `${fmtPct(reasoningPct)} of output tokens are reasoning tokens. If you don't need extended thinking for every task, consider disabling it for straightforward requests to reduce output token costs.`,
          estimatedSavings: totalCost * 0.1,
        });
      }

      // Sort tips by severity, then estimated savings
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      tips.sort((a, b) => {
        const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
        if (sevDiff !== 0) return sevDiff;
        return b.estimatedSavings - a.estimatedSavings;
      });

      const periodLabel = view.label;
      const totalPotentialSavings = tips.reduce((s, t) => s + t.estimatedSavings, 0);

      const lines = [
        header("COST OPTIMIZATION TIPS"),
        `  Period: ${periodLabel}  │  Total Spend: ${fmtCost(totalCost)}`,
        separator(),
        "",
      ];

      if (tips.length === 0) {
        lines.push("  ✅ No optimization issues found! Your usage patterns look efficient.", "");
      } else {
        const severityIcon = { critical: "🔴", warning: "🟡", info: "🔵" };

        for (let i = 0; i < tips.length; i++) {
          const t = tips[i];
          lines.push(
            `  ${severityIcon[t.severity]} [${t.severity.toUpperCase()}] ${t.category}`,
            `     ${t.tip}`,
            `     💰 Estimated savings: ~${fmtCost(t.estimatedSavings)}`,
            ""
          );
        }

        lines.push(
          separator(),
          `  📊 Total Potential Savings: ~${fmtCost(totalPotentialSavings)} (${fmtPct(totalCost > 0 ? (totalPotentialSavings / totalCost) * 100 : 0)} of spend)`,
          ""
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) }],
      };
    }
  );

  // ─── Cleanup Tools ──────────────────────────────────────────

  server.tool(
    "tokmeter_cleanup_preview",
    "Preview what session data would be deleted for the given filters. " +
      "Shows affected files, directories, database rows, total bytes, and per-project/provider breakdown. " +
      "Read-only: deleting is not available over MCP; the user runs `tokmeter cleanup` in a terminal.",
    {
      project: ProjectFilter,
      providers: ProvidersArray,
      since: SinceDate,
      until: UntilDate,
      scope: ScopeEnum,
    },
    READ_ONLY_TOOL,
    async (params) => {
      try {
        const { CleanupService, TokmeterCore } = await import("@sriinnu/tokmeter");
        // The preview reads the whole raw corpus itself (scanLifetimeRaw), so
        // an extra scan here only cost time.
        const service = new CleanupService(new TokmeterCore());

        const filter = buildCleanupFilter(params);

        const preview = await service.preview(filter);

        if (preview.recordCount === 0) {
          return {
            content: [
              {
                type: "text",
                text: `${header("CLEANUP PREVIEW")}\n\n  No records match the filter. Nothing to clean up.\n`,
              },
            ],
          };
        }

        const lines: string[] = [header("CLEANUP PREVIEW"), ""];

        // Summary
        lines.push(
          `  Records: ${fmtNum(preview.recordCount)}`,
          `  Source Files: ${preview.sourceFileCount}`,
          `  Targets: ${preview.targets.length}`,
          `  Disk Space: ${fmtNum(preview.totalBytes)} bytes`,
          ""
        );

        // Show the exact deletion scope. Keep output bounded for very large
        // cleanups.
        if (preview.targets.length > 0) {
          const visibleTargets = preview.targets.slice(0, 100);
          lines.push("  TARGET MANIFEST (first 100):", separator());
          for (const target of visibleTargets) {
            lines.push(
              `  [${sanitizeDataLabel(target.provider, 128)}] ${target.type} — ${fmtNum(target.sizeBytes)} bytes — ${sanitizeDataLabel(target.description, 256)}`,
              `    ${sanitizeDataLabel(target.path, 4096)}`
            );
          }
          if (preview.targets.length > visibleTargets.length) {
            lines.push(
              `  … ${preview.targets.length - visibleTargets.length} more target(s) omitted`
            );
          }
          lines.push("");
        }

        // By provider
        if (preview.byProvider.length > 0) {
          lines.push("  BY PROVIDER:", separator());
          const rows = preview.byProvider.map((p) => [
            p.provider,
            p.targets.toString(),
            fmtNum(p.bytes),
            p.records.toString(),
          ]);
          lines.push(
            formatTable(["Provider", "Targets", "Bytes", "Records"], rows, [
              false,
              true,
              true,
              true,
            ])
          );
          lines.push("");
        }

        // By project
        if (preview.byProject.length > 0) {
          lines.push("  BY PROJECT:", separator());
          const rows = preview.byProject.map((p) => [
            p.project.slice(0, 30),
            p.records.toString(),
            fmtNum(p.tokens),
            fmtCost(p.cost),
          ]);
          lines.push(
            formatTable(["Project", "Records", "Tokens", "Cost"], rows, [false, true, true, true])
          );
          lines.push("");
        }

        // Partial file warnings
        if (preview.partialFileWarnings.length > 0) {
          lines.push("  ⚠️  PARTIAL FILE WARNINGS:", separator());
          for (const w of preview.partialFileWarnings) {
            const shortFile = w.file
              .split(/[\\/]+/)
              .filter(Boolean)
              .slice(-2)
              .join("/");
            lines.push(
              `  ${sanitizeDataLabel(shortFile, 4096)}: ${w.matchedRecords} matched, ${w.otherRecords} other records (${sanitizeDataLabel(w.otherDateRange, 128)}) will ALSO be deleted`
            );
          }
          lines.push("");
        }

        if (preview.unremovable && preview.unremovable.length > 0) {
          lines.push("  LEFT IN PLACE:", separator());
          for (const u of preview.unremovable) {
            lines.push(
              `  ${sanitizeDataLabel(u.path, 4096)} [${sanitizeDataLabel(u.provider, 64)}]: ${sanitizeDataLabel(u.reason, 256)}`
            );
          }
          lines.push("");
        }

        // No command is built from the filters: project names come from
        // untrusted transcripts and must never be handed back as shell input.
        lines.push(
          "  Deleting is not available over MCP. To run this cleanup, the user runs",
          "  `tokmeter cleanup` in a terminal with the same filters (--project, provider",
          "  flags such as --claude or --codex, --since/--until or --today/--week/--month).",
          "  It previews again, writes a backup, and asks for confirmation before deleting."
        );

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `${header("ERROR")}\n\n  ${sanitizeDataLabel(err instanceof Error ? err.message : String(err), 4096)}\n`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "tokmeter_backups",
    "List available cleanup backups with metadata (date, size, providers, projects).",
    {},
    READ_ONLY_TOOL,
    async () => {
      const { CleanupService, TokmeterCore: Core } = await import("@sriinnu/tokmeter");
      const core = new Core({ skipPricing: true });
      const service = new CleanupService(core);
      const backups = service.listBackups();

      if (backups.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `${header("BACKUPS")}\n\n  No backups found.\n`,
            },
          ],
        };
      }

      const lines: string[] = [header("BACKUPS"), ""];
      const rows = backups.map((b) => [
        b.id,
        fmtDate(new Date(b.createdAt).getTime()),
        fmtNum(b.sizeBytes),
        b.providers.join(", "),
      ]);
      lines.push(formatTable(["ID", "Created", "Size", "Providers"], rows));
      lines.push("");

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
