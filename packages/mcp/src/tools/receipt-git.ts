/**
 * Viral shareable receipts & per-branch git attribution MCP tools (`tokmeter_receipt`, `tokmeter_git_cost`).
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  attributeGitBranchCost,
  buildReceiptData,
  inspectGitBranch,
  loadAliases,
  localDateKey,
  renderGitCostMarkdown,
  renderGitCostText,
  renderReceiptMarkdown,
  renderReceiptSvg,
  renderReceiptText,
  sanitizeDataLabel,
  type TokmeterSummary,
} from "@sriinnu/tokmeter";
import { z } from "zod";
import {
  getCore,
  getScopedView,
  ProjectFilter,
  ProvidersArray,
  READ_ONLY_TOOL,
  ScopeEnum,
  viewFooter,
} from "./context.js";

/** Register receipt and git-attribution tools (23-24) on the MCP server. */
export function registerReceiptAndGitTools(server: McpServer): void {
  // ────────────────────────────────────────────
  // 23. tokmeter_receipt — Privacy-scrubbed editorial receipt
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_receipt",
    "Generate a shareable, privacy-scrubbed Tokmeter receipt (no project names or paths unless include_projects is true) in Thermal or Broadsheet style across plain text, Markdown, SVG, or JSON.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
      style: z.enum(["thermal", "broadsheet"]).optional().default("thermal"),
      format: z.enum(["text", "markdown", "svg", "json"]).optional().default("text"),
      include_projects: z.boolean().optional().default(false),
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView(params);
      const summaryLike: TokmeterSummary = {
        records: [],
        projects: view.projects,
        models: view.models,
        daily: view.daily,
        stats: view.stats,
        meta: {
          stableThrough: view.window.until ?? null,
          historySource: "snapshot",
          todayState: "live",
          lastScanAt: Date.now(),
          warnings: [],
          unpricedModels: view.meta.unpricedModels,
          unpricedRecords: view.meta.unpricedRecords,
        },
      };
      const includeProjects = Boolean(params.include_projects || params.project);
      const receipt = buildReceiptData(summaryLike, {
        label: view.label,
        includeProjects,
      });

      let body: string;
      if (params.format === "json") {
        body = JSON.stringify(receipt, null, 2);
      } else if (params.format === "svg") {
        body = renderReceiptSvg(receipt, { style: params.style });
      } else if (params.format === "markdown") {
        body = renderReceiptMarkdown(receipt);
      } else {
        body = renderReceiptText(receipt, { style: params.style, color: false });
      }

      const out = params.format === "text" ? `${body}${viewFooter(view)}` : body;
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ────────────────────────────────────────────
  // 24. tokmeter_git_cost — Per-branch / PR forensic cost attribution
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_git_cost",
    "Attribute AI coding token usage, cost, cache hit share, subagent spend, and compaction tax to a git branch or PR window based on commit timestamps and repository directory matching.",
    {
      dir: z
        .string()
        .max(1024)
        .optional()
        .describe("Repository directory (defaults to process cwd)"),
      base: z
        .string()
        .max(200)
        .optional()
        .describe("Base branch or git ref to compare HEAD against (auto-detected if omitted)"),
      since_commit: z
        .string()
        .max(200)
        .optional()
        .describe("Explicit base commit/ref instead of merge-base auto-detection"),
      lead_minutes: z
        .number()
        .int()
        .min(0)
        .max(240)
        .optional()
        .default(30)
        .describe("Minutes before the earliest branch commit to include pre-commit turns"),
      format: z.enum(["text", "markdown", "json"]).optional().default("text"),
    },
    READ_ONLY_TOOL,
    async (params) => {
      const targetDir = resolve(params.dir ?? process.cwd());
      let isDir = false;
      try {
        isDir = statSync(targetDir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Directory does not exist: ${sanitizeDataLabel(targetDir, 256)}`,
            },
          ],
        };
      }

      let window: ReturnType<typeof inspectGitBranch>;
      try {
        window = inspectGitBranch(targetDir, {
          base: params.base,
          sinceCommit: params.since_commit,
          leadMinutes: params.lead_minutes,
        });
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Git inspection failed: ${sanitizeDataLabel(err instanceof Error ? err.message : String(err), 256)}`,
            },
          ],
        };
      }

      const { core, records, meta } = await getCore({
        since: localDateKey(window.windowStartMs),
        until: localDateKey(window.windowEndMs),
      });

      const earliestRawRecordMs =
        records.length > 0 ? Math.min(...records.map((r) => r.timestamp)) : null;
      const report = attributeGitBranchCost(records, window, {
        aliases: loadAliases(core.getHomeDir()),
        earliestRawRecordMs,
      });

      let body: string;
      if (params.format === "json") {
        body = JSON.stringify({ ...report, meta }, null, 2);
      } else if (params.format === "markdown") {
        body = renderGitCostMarkdown(report);
      } else {
        body = renderGitCostText(report, { color: false });
      }

      return { content: [{ type: "text", text: body }] };
    }
  );
}
