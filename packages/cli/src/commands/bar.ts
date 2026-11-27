/**
 * `tokmeter bar` — Multi-OS ambient status output & shell/bar integration snippets.
 *
 * Works across macOS, Linux, and Windows by querying the local warm daemon
 * (`/api/statusline-context`) in <25ms, with clean disk-cache fallback when
 * the daemon isn't running.
 */

import { homedir } from "node:os";
import { fetchDaemonJson, localDateKey, type QuotaWindow, TokmeterCore } from "@sriinnu/tokmeter";
import type { CliArgs } from "../args.js";

export type BarFormat =
  | "plain"
  | "ansi"
  | "tmux"
  | "starship"
  | "waybar"
  | "polybar"
  | "powershell"
  | "json";

export type BarSnippetTarget =
  | "tmux"
  | "starship"
  | "waybar"
  | "polybar"
  | "zsh"
  | "fish"
  | "powershell";

export interface AmbientBarData {
  todayCost: number;
  todayTokens: number;
  repoCost: number | null;
  repoName: string | null;
  paceMultiple: number | null;
  dailyBudget: number | null;
  liveCount: number;
  activeAgent: string | null;
  contextFillPct: number | null;
  topQuotaPct: number | null;
  topQuotaLabel: string | null;
  source: "daemon" | "cache" | "empty";
  computedAt: number;
}

interface DaemonStatuslineContextWire {
  today?: { cost?: number; in?: number; out?: number };
  repo?: { name?: string; cost?: number } | null;
  liveSessions?: {
    count?: number;
    active?: Array<{ provider?: string; contextFillPct?: number }>;
  };
  paceMultiple?: number | null;
  dailyCostThreshold?: number | null;
  quotas?: QuotaWindow[];
  computedAt?: number;
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}

function buildTextParts(data: AmbientBarData): string[] {
  const parts = [`∞ ${fmtUsd(data.todayCost)}`, `${fmtTokens(data.todayTokens)} tok`];
  if (data.paceMultiple !== null && data.paceMultiple > 0) {
    parts.push(`${data.paceMultiple.toFixed(1)}x`);
  }
  if (data.contextFillPct !== null) {
    parts.push(`ctx ${Math.round(data.contextFillPct)}%`);
  }
  if (data.topQuotaPct !== null && data.topQuotaLabel) {
    parts.push(`${data.topQuotaLabel} ${Math.round(data.topQuotaPct)}%`);
  }
  if (data.repoName && data.repoCost !== null && data.repoCost > 0) {
    parts.push(`${data.repoName} ${fmtUsd(data.repoCost)}`);
  }
  return parts;
}

function budgetPercentage(data: AmbientBarData): number {
  if (data.dailyBudget && data.dailyBudget > 0) {
    return Math.min(100, Math.round((data.todayCost / data.dailyBudget) * 100));
  }
  if (data.topQuotaPct !== null) {
    return Math.min(100, Math.round(data.topQuotaPct));
  }
  return 0;
}

function bandForData(data: AmbientBarData): "ok" | "warn" | "critical" {
  const pct = budgetPercentage(data);
  if (pct >= 90 || (data.contextFillPct ?? 0) >= 85) return "critical";
  if (pct >= 70 || (data.contextFillPct ?? 0) >= 70) return "warn";
  return "ok";
}

/** Pure formatter for every multi-OS ambient status surface. */
export function formatBarOutput(data: AmbientBarData, format: BarFormat): string {
  if (format === "json") return JSON.stringify(data);

  const line = buildTextParts(data).join(" · ");
  const band = bandForData(data);

  switch (format) {
    case "plain":
    case "starship":
    case "powershell":
      return line;
    case "ansi": {
      const code =
        band === "critical" ? "\x1b[31;1m" : band === "warn" ? "\x1b[33;1m" : "\x1b[36;1m";
      return `${code}${line}\x1b[0m`;
    }
    case "tmux": {
      const fg = band === "critical" ? "colour196" : band === "warn" ? "colour214" : "colour81";
      return `#[fg=${fg},bold]${line}#[default]`;
    }
    case "polybar": {
      const fg = band === "critical" ? "#ef4444" : band === "warn" ? "#f59e0b" : "#8b5cf6";
      return `%{F${fg}}${line}%{F-}`;
    }
    case "waybar": {
      const tooltipLines = [
        `Today: ${fmtUsd(data.todayCost)} (${fmtTokens(data.todayTokens)} tokens)`,
        ...(data.repoName && data.repoCost !== null
          ? [`Repo (${data.repoName}): ${fmtUsd(data.repoCost)}`]
          : []),
        ...(data.paceMultiple !== null ? [`Pace: ${data.paceMultiple.toFixed(2)}x typical`] : []),
        ...(data.topQuotaLabel && data.topQuotaPct !== null
          ? [`Quota (${data.topQuotaLabel}): ${Math.round(data.topQuotaPct)}%`]
          : []),
        `Source: ${data.source}`,
      ];
      return JSON.stringify({
        text: line,
        tooltip: tooltipLines.join("\n"),
        class: `tokmeter-${band}`,
        percentage: budgetPercentage(data),
      });
    }
  }
}

export function renderBarSnippet(target: BarSnippetTarget): string {
  switch (target) {
    case "tmux":
      return [
        "# ~/.tmux.conf",
        "set -g status-interval 5",
        'set -g status-right "#(tokmeter bar --format tmux)"',
      ].join("\n");
    case "starship":
      return [
        "# ~/.config/starship.toml",
        "[custom.tokmeter]",
        'command = "tokmeter bar --format starship"',
        "when = true",
        'format = "[$output]($style) "',
        'style = "bold cyan"',
      ].join("\n");
    case "waybar":
      return [
        "// ~/.config/waybar/config.jsonc",
        '"custom/tokmeter": {',
        '  "exec": "tokmeter bar --format waybar",',
        '  "return-type": "json",',
        '  "interval": 10',
        "}",
      ].join("\n");
    case "polybar":
      return [
        "; ~/.config/polybar/config.ini",
        "[module/tokmeter]",
        "type = custom/script",
        "exec = tokmeter bar --format polybar",
        "interval = 10",
      ].join("\n");
    case "zsh":
      return ["# ~/.zshrc", "RPROMPT='$(tokmeter bar --format ansi)'"].join("\n");
    case "fish":
      return [
        "# ~/.config/fish/functions/fish_right_prompt.fish",
        "function fish_right_prompt",
        "  tokmeter bar --format ansi",
        "end",
      ].join("\n");
    case "powershell":
      return [
        "# $PROFILE (Windows / PowerShell)",
        "function prompt {",
        "  $tm = tokmeter bar --format powershell",
        '  Write-Host "$tm" -ForegroundColor Cyan',
        '  "PS $($executionContext.SessionState.Path.CurrentLocation)> "',
        "}",
      ].join("\n");
  }
}

export async function runBar(args: CliArgs): Promise<void> {
  if (args.barSnippet) {
    console.log(renderBarSnippet(args.barSnippet));
    return;
  }

  const format: BarFormat = args.json ? "json" : (args.barFormat ?? "plain");
  const qs = new URLSearchParams();
  if (args.project) qs.set("project", args.project);
  const path = `/api/statusline-context${qs.size > 0 ? `?${qs.toString()}` : ""}`;

  let data: AmbientBarData | null = null;
  const liveRes = await fetchDaemonJson<DaemonStatuslineContextWire>(path, {
    probeTimeoutMs: 250,
    timeoutMs: 1_200,
    warmingTimeoutMs: 1_500,
  });

  if (liveRes.ok && liveRes.data.today) {
    const d = liveRes.data;
    const quotas = (d.quotas ?? []).filter((q) => q.verdict !== "expired");
    const topQuota = quotas.slice().sort((a, b) => b.usedPct - a.usedPct)[0];
    const activeSessions = d.liveSessions?.active ?? [];
    const topSession =
      activeSessions.find((s) => s.contextFillPct !== undefined) ?? activeSessions[0];
    data = {
      todayCost: d.today?.cost ?? 0,
      todayTokens: (d.today?.in ?? 0) + (d.today?.out ?? 0),
      repoCost: d.repo?.cost ?? null,
      repoName: d.repo?.name ?? null,
      paceMultiple: d.paceMultiple ?? null,
      dailyBudget: d.dailyCostThreshold ?? null,
      liveCount: d.liveSessions?.count ?? 0,
      activeAgent: topSession?.provider ?? null,
      contextFillPct: topSession?.contextFillPct ?? null,
      topQuotaPct: topQuota?.usedPct ?? null,
      topQuotaLabel: topQuota ? `${topQuota.agent}:${topQuota.window}` : null,
      source: "daemon",
      computedAt: d.computedAt ?? Date.now(),
    };
  } else {
    const core = new TokmeterCore({ homeDir: homedir(), skipPricing: true });
    const hydrated = core.hydrateFromDiskCache();
    const todayAgg = core.getTodayAggregate(localDateKey());
    data = {
      todayCost: todayAgg?.cost ?? 0,
      todayTokens: todayAgg?.totalTokens ?? 0,
      repoCost: null,
      repoName: null,
      paceMultiple: null,
      dailyBudget: null,
      liveCount: 0,
      activeAgent: null,
      contextFillPct: null,
      topQuotaPct: null,
      topQuotaLabel: null,
      source: hydrated ? "cache" : "empty",
      computedAt: Date.now(),
    };
  }

  console.log(formatBarOutput(data, format));
}
