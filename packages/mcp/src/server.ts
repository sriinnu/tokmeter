/**
 * @sriinnu/tokmeter-mcp — MCP Server
 *
 * Tokmeter — token usage observatory for AI coding agents.
 *
 * Exposes 24 read-only tools via the Model Context Protocol that let AI agents and CLIs
 * query, analyze, forecast, and export token usage data collected by tokmeter.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAdvisorAndCleanupTools } from "./tools/advisor-cleanup.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerOverviewTools } from "./tools/overview.js";
import { registerQueryTools } from "./tools/query.js";
import { registerReceiptAndGitTools } from "./tools/receipt-git.js";

export { resolveScopeWindow } from "./scoped-view.js";
export { csvCell, fmtDate, fmtDatetime, READ_ONLY_TOOL } from "./tools/context.js";

const SLASH_PROMPTS: ReadonlyArray<{
  name: string;
  card: "cockpit" | "why" | "quota" | "live" | "routes" | "digest";
  title: string;
  description: string;
}> = [
  {
    name: "tokmeter_cockpit",
    card: "cockpit",
    title: "Tokmeter Cockpit",
    description: "Read-only 66-col cockpit summary (today, week, month, burn pace, active quotas).",
  },
  {
    name: "tokmeter_why",
    card: "why",
    title: "Tokmeter Why",
    description:
      "Read-only breakdown of today's top cost drivers, cache hit, subagents, and compaction tax.",
  },
  {
    name: "tokmeter_quota",
    card: "quota",
    title: "Tokmeter Plan Quotas",
    description:
      "Read-only plan rate windows (Claude 5h/7d, Codex 7d, Grok Bot 7d) and pace verdicts.",
  },
  {
    name: "tokmeter_live",
    card: "live",
    title: "Tokmeter Live Sessions",
    description: "Read-only view of currently active coding-agent sessions reported to the daemon.",
  },
  {
    name: "tokmeter_routes",
    card: "routes",
    title: "Tokmeter Model Routes",
    description:
      "Neutral read-only model rate & cross-tool pricing projection card ($? for unpriced).",
  },
  {
    name: "tokmeter_digest",
    card: "digest",
    title: "Tokmeter Spend Digest",
    description:
      "Read-only daily and multi-day spend digest across all configured AI coding agents.",
  },
];

/**
 * Create and configure the tokmeter MCP server and register its tools.
 *
 * Each tool call uses {@link getCore} which caches the TokmeterCore instance
 * for 5 seconds to avoid rescanning the filesystem on rapid successive calls.
 * Every tool output includes a transparency footer showing record count,
 * scan duration, and warnings for models with missing pricing.
 *
 * @returns Configured McpServer ready to be connected to a transport.
 */
export function createServer(): McpServer {
  /**
   * The published package version, read at runtime from the package.json that
   * ships beside `dist/`. MCP clients show this in `initialize`'s
   * `serverInfo.version`, and the registry refuses a manifest whose version
   * disagrees with the release — a hand-maintained literal here drifted to
   * 1.4.0 while the package was at 1.12.0. Falls back to "0.0.0" rather than
   * throwing: an unreadable package.json must not take the server down.
   */
  function serverVersion(): string {
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")).version ?? "0.0.0";
    } catch {
      return "0.0.0";
    }
  }

  const server = new McpServer(
    {
      // Matches `mcpName` in package.json and `name` in server.json — the MCP
      // registry rejects a manifest whose name disagrees with the published
      // package, and clients show this string, so all three say "tokmeter".
      name: "tokmeter",
      version: serverVersion(),
      description: "∞ — Token usage observatory for AI coding agents",
    },
    { maxToolInputElements: 256 }
  );

  registerOverviewTools(server);
  registerQueryTools(server);
  registerAnalyticsTools(server);
  registerInsightTools(server);
  registerAdvisorAndCleanupTools(server);
  registerReceiptAndGitTools(server);

  for (const spec of SLASH_PROMPTS) {
    server.registerPrompt(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
      },
      async () => {
        const { loadSlashCardData, renderSlashCard } = await import("./slash.js");
        const data = await loadSlashCardData();
        const card = renderSlashCard(spec.card, data);
        return {
          description: spec.description,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Present this read-only 66-column Tokmeter card verbatim inside a fenced code block without modifying any numbers or labels:\n\n${card}`,
              },
            },
          ],
        };
      }
    );
  }

  return server;
}

// ─────────────────────────────────────────────────────────────
// Entrypoint
// ─────────────────────────────────────────────────────────────

export async function startServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
