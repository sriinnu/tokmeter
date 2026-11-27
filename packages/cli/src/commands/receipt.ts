/**
 * `tokmeter receipt` — shareable, privacy-scrubbed editorial receipts
 * (Thermal / Broadsheet) across ANSI/plain text, SVG, Markdown, and JSON.
 */

import { writeFileSync } from "node:fs";
import {
  buildReceiptData,
  fetchDaemonJson,
  localDateKey,
  type ReceiptStyle,
  renderReceiptMarkdown,
  renderReceiptSvg,
  renderReceiptText,
  TokmeterCore,
  type TokmeterSummary,
} from "@sriinnu/tokmeter";
import type { CliArgs } from "../args.js";
import { buildDaemonReadQuery as buildQuery } from "../daemon-read.js";

export type { CliArgs };

function buildScopeLabel(args: CliArgs): string {
  if (args.today) return `today (${localDateKey()})`;
  if (args.week) return "last 7 days";
  if (args.month) return "this month";
  if (args.year) return String(args.year);
  if (args.since || args.until) return `${args.since ?? "start"} -> ${args.until ?? "today"}`;
  return `today (${localDateKey()})`;
}

export async function runReceipt(args: CliArgs): Promise<void> {
  const hasExplicitRange = Boolean(
    args.today || args.week || args.month || args.year || args.since || args.until
  );
  const effectiveToday = !hasExplicitRange || Boolean(args.today);
  const scanOpts = {
    ...(effectiveToday ? { today: true } : {}),
    ...(args.week ? { week: true } : {}),
    ...(args.month ? { month: true } : {}),
    ...(args.year !== undefined ? { year: args.year } : {}),
    ...(args.since ? { since: args.since } : {}),
    ...(args.until ? { until: args.until } : {}),
    ...(args.project ? { project: args.project } : {}),
    ...(args.providers?.length ? { providers: args.providers } : {}),
  };

  let summary: TokmeterSummary | null = null;
  if (!args.light && !args.rescanHistory) {
    const query = buildQuery({ ...scanOpts, light: args.light, rescanHistory: args.rescanHistory });
    const daemonRes = await fetchDaemonJson<TokmeterSummary>(`/api/summary${query}`, {
      probeTimeoutMs: 500,
      timeoutMs: 10_000,
      warmingTimeoutMs: 30_000,
    });
    if (daemonRes.ok) summary = daemonRes.data;
  }

  let alternatives: Array<{ model: string; provider: string; projectedCost: number }> | undefined;
  const core = new TokmeterCore({ skipPricing: args.light });
  if (!summary) {
    await core.scan(scanOpts);
    summary = core.getSummary(scanOpts);
    if (!args.light && effectiveToday) {
      try {
        alternatives = (await core.getCrossToolComparison(localDateKey())).projections;
      } catch {
        alternatives = undefined;
      }
    }
  } else if (!args.light && effectiveToday) {
    const crossRes = await fetchDaemonJson<{
      projections?: Array<{ model: string; provider: string; projectedCost: number }>;
    }>("/api/cross-tool", { probeTimeoutMs: 250, timeoutMs: 2_500 });
    if (crossRes.ok && Array.isArray(crossRes.data.projections)) {
      alternatives = crossRes.data.projections;
    }
  }

  const label = buildScopeLabel({ ...args, today: effectiveToday });
  const data = buildReceiptData(summary, {
    label,
    includeProjects: Boolean(args.includeProjects || args.project),
    alternatives,
  });

  const style: ReceiptStyle = args.receiptStyle ?? "thermal";

  if (args.svgPath) {
    const svg = renderReceiptSvg(data, { style });
    if (args.svgPath === "-") {
      console.log(svg);
    } else {
      writeFileSync(args.svgPath, svg, "utf8");
      console.log(`Receipt SVG written to ${args.svgPath}`);
    }
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (args.markdown) {
    console.log(renderReceiptMarkdown(data));
    return;
  }

  console.log(renderReceiptText(data, { style, color: process.stdout.isTTY }));
}
