/**
 * @sriinnu/tokmeter-mcp — Zero-token `/tokmeter` slash cards.
 *
 * Pure 66-column monospace card renderers + read-only data loader. Invoked
 * directly by Claude Code / OpenCode custom slash commands (`tokmeter-mcp slash
 * <cmd>`) without spending LLM tokens, and registered on the MCP server as
 * read-only Prompts (`server.registerPrompt(...)`) for any client.
 *
 * Rules kept here:
 * - Strictly read-only: never writes config, caches, or session files.
 * - Strictly <= 66 terminal cells on every emitted line.
 * - Sanitized data: all project/model/branch strings pass sanitizeDataLabel.
 * - Neutral `routes`: zero "Recommended" or "Best value" badges; pins both
 *   frozen historical cost and today's kosha rate timestamp; shows $? when unpriced.
 */

import { homedir } from "node:os";
import {
  canonicalizeProjectName,
  DEFAULT_CONFIG,
  fetchDaemonJson,
  getKoshaRegistryMtime,
  getQuota,
  loadConfig,
  localDateKey,
  type ModelRatesResponse,
  type ProviderSummary,
  type QuotaWindow,
  type ScanMeta,
  type ScanWarning,
  STATUSLINE_STYLES,
  type StatbarSignals,
  sanitizeDataLabel,
  TokmeterCore,
  type TokmeterSummary,
  type UserConfig,
} from "@sriinnu/tokmeter";
import type { AggregatedStats } from "./daemon/protocol.js";
import type { StatuslineContextResponse } from "./daemon/server.js";
import { buildAmbientStatusView } from "./statusline.js";
import {
  cellWidth,
  formatSpan,
  formatTokens,
  formatUsd,
  renderStatusline,
  type StatusView,
  textWidth,
} from "./statusline-view.js";

export const SLASH_CARD_WIDTH = 66;
const INNER_WIDTH = SLASH_CARD_WIDTH - 4; // "│ " + inner + " │"

export const SLASH_COMMANDS = [
  "cockpit",
  "why",
  "quota",
  "live",
  "routes",
  "digest",
  "statusline",
  "doctor",
] as const;

export type SlashCommand = (typeof SLASH_COMMANDS)[number];

export interface CrossToolSummary {
  todayActualCost: number;
  projections: Array<{ model: string; provider: string; projectedCost: number }>;
}

export interface DaemonHealthSummary {
  ready: boolean;
  unpricedModels: string[];
  unpricedModelsTotal: number;
  unpricedRecords: number;
  warnings: ScanWarning[];
  lastScanAt?: number;
}

export interface SlashCardData {
  now: number;
  daemonOnline: boolean;
  project?: string;
  config: UserConfig;
  summary: TokmeterSummary;
  providers: ProviderSummary[];
  todayCost: number;
  todayTokens: number;
  weekCost: number;
  monthCost: number;
  signals: StatbarSignals | null;
  quotas: QuotaWindow[];
  live: AggregatedStats | null;
  rates: ModelRatesResponse | null;
  crossTool: CrossToolSummary | null;
  health: DaemonHealthSummary | null;
  pricingMtime: number;
  view: StatusView;
}

// ─── Layout Helpers (strictly <= 66 display cells) ─────────────────────────

function clean(text: string, max = 256): string {
  return sanitizeDataLabel(text, max);
}

function truncateCells(raw: string, maxCells: number): string {
  const safe = clean(raw, 512);
  if (textWidth(safe) <= maxCells) return safe;
  if (maxCells <= 0) return "";
  if (maxCells === 1) return "…";
  let out = "";
  let used = 0;
  for (const ch of safe) {
    const cw = cellWidth(ch.codePointAt(0) ?? 0);
    if (used + cw > maxCells - 1) break;
    out += ch;
    used += cw;
  }
  return `${out}…`;
}

function padCells(raw: string, widthCells: number): string {
  const fitted = truncateCells(raw, widthCells);
  const w = textWidth(fitted);
  return fitted + " ".repeat(Math.max(0, widthCells - w));
}

function padLeftCells(raw: string, widthCells: number): string {
  const fitted = truncateCells(raw, widthCells);
  const w = textWidth(fitted);
  return " ".repeat(Math.max(0, widthCells - w)) + fitted;
}

function twoCol(left: string, right: string, widthCells = INNER_WIDTH): string {
  const rw = textWidth(right);
  const gap = 1;
  const maxLeft = Math.max(4, widthCells - rw - gap);
  const l = truncateCells(left, maxLeft);
  const lw = textWidth(l);
  const spaces = Math.max(1, widthCells - lw - rw);
  return padCells(`${l}${" ".repeat(spaces)}${right}`, widthCells);
}

function gaugeBar(pct: number, cells = 12): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * cells);
  return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

function divider(): string {
  return `├${"─".repeat(SLASH_CARD_WIDTH - 2)}┤`;
}

function boxTop(heading: string): string {
  const head = `┌─ ${truncateCells(heading, SLASH_CARD_WIDTH - 6)} `;
  const rem = Math.max(1, SLASH_CARD_WIDTH - textWidth(head) - 1);
  return `${head}${"─".repeat(rem)}┐`;
}

function boxRow(text: string): string {
  return `│ ${padCells(text, INNER_WIDTH)} │`;
}

function boxBottom(): string {
  return `└${"─".repeat(SLASH_CARD_WIDTH - 2)}┘`;
}

function wrapTextRows(text: string): string[] {
  const words = clean(text, 512).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate) <= INNER_WIDTH) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = textWidth(word) > INNER_WIDTH ? truncateCells(word, INNER_WIDTH) : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function renderCard(heading: string, sections: string[][]): string {
  const out: string[] = [boxTop(heading)];
  sections.forEach((sec, idx) => {
    if (idx > 0) out.push(divider());
    for (const row of sec) {
      out.push(boxRow(row));
    }
  });
  out.push(boxBottom());
  return out
    .map((l) => (textWidth(l) > SLASH_CARD_WIDTH ? truncateCells(l, SLASH_CARD_WIDTH) : l))
    .join("\n");
}

// ─── Card Renderers (8 pure cards) ─────────────────────────────────────────

export function renderCockpitCard(d: SlashCardData): string {
  const daemonState = d.daemonOnline ? "daemon online" : "local fallback";
  const hero = [
    twoCol(`TODAY ${formatUsd(d.todayCost)}`, `WEEK ${formatUsd(d.weekCost)}`),
    twoCol(`MONTH ${formatUsd(d.monthCost)}`, `ALL ${formatUsd(d.summary.stats.totalCost)}`),
    twoCol(
      `Tokens today ${formatTokens(d.todayTokens)}`,
      `${d.summary.stats.activeDays}d · ${d.summary.stats.longestStreak}d streak`
    ),
  ];

  const sig = d.signals;
  const paceVal = sig?.pace?.multiple;
  const paceStr =
    typeof paceVal === "number" && Number.isFinite(paceVal) && paceVal > 0
      ? `${paceVal.toFixed(1)}x vs 7d`
      : "pace —";
  const burnStr =
    sig && sig.burnRate.costPerHour > 0 ? `${formatUsd(sig.burnRate.costPerHour)}/h` : "burn —";
  const budgetThreshold = d.config.alerts.dailyCostThreshold;
  const budgetStr =
    budgetThreshold !== null && budgetThreshold > 0
      ? `Budget ${formatUsd(d.todayCost)} / ${formatUsd(budgetThreshold)}`
      : "Budget unset (config set alerts.dailyCostThreshold)";
  const runtimeSec = [twoCol(`Burn ${burnStr}`, `Pace ${paceStr}`), budgetStr];
  if (d.live && d.live.sessions > 0) {
    runtimeSec.push(
      twoCol(
        `Live: ${d.live.sessions} session${d.live.sessions === 1 ? "" : "s"}`,
        d.live.providers.slice(0, 3).join(", ")
      )
    );
  }

  const quotaSec: string[] = [];
  if (d.quotas.length > 0) {
    for (const q of d.quotas.slice(0, 3)) {
      const pct = Math.min(100, Math.max(0, Math.round(q.usedPct)));
      const left = q.resetsAt > d.now / 1000 ? formatSpan(q.resetsAt - d.now / 1000) : "reset";
      const lbl = padCells(`${q.agent} ${q.window}`, 18);
      quotaSec.push(`${lbl} ${gaugeBar(pct, 10)} ${padLeftCells(`${pct}%`, 4)} · ${left}`);
    }
  } else {
    quotaSec.push("Quotas: none recorded yet");
  }

  return renderCard(`tokmeter · cockpit · ${daemonState}`, [hero, runtimeSec, quotaSec]);
}

export function renderWhyCard(d: SlashCardData): string {
  const sig = d.signals;
  const todayModels = (d.rates?.models ?? []).slice(0, 4);
  const modelRows: string[] = ["TOP MODELS TODAY"];
  if (todayModels.length > 0) {
    for (const m of todayModels) {
      const pct = d.todayCost > 0 ? Math.round((m.usage.cost / d.todayCost) * 100) : 0;
      const costStr = m.source.tier === "unpriced" ? "$?" : formatUsd(m.usage.cost);
      modelRows.push(twoCol(`  ${m.model} (${m.provider})`, `${costStr} · ${pct}%`));
    }
  } else {
    for (const m of d.summary.models.slice(0, 4)) {
      modelRows.push(twoCol(`  ${m.model} (${m.provider})`, formatUsd(m.cost)));
    }
    if (modelRows.length === 1) modelRows.push("  No model usage recorded.");
  }

  const driverRows: string[] = ["DIAGNOSTICS (TODAY)"];
  if (sig) {
    const cachePct =
      typeof sig.cacheHitToday.canonicalRate === "number"
        ? `${Math.round(sig.cacheHitToday.canonicalRate * 100)}%`
        : "?";
    const subPct = Math.round(sig.subagentToday.share * 100);
    const reasonPct = Math.round(sig.reasoningToday.share * 100);
    driverRows.push(
      twoCol(
        `  Cache hit share: ${cachePct}`,
        `Reads ${formatTokens(sig.cacheHitToday.cacheReadTokens)}`
      )
    );
    driverRows.push(
      twoCol(`  Subagent work: ${formatUsd(sig.subagentToday.cost)}`, `${subPct}% of today`)
    );
    driverRows.push(
      twoCol(
        `  Compaction tax: ${formatUsd(sig.compactionToday.cost)}`,
        `${sig.compactionToday.events} events`
      )
    );
    driverRows.push(twoCol(`  Reasoning output share`, `${reasonPct}%`));
  } else {
    driverRows.push("  Diagnostics unavailable (no recent records in window).");
  }

  const projRows: string[] = ["TOP PROJECTS"];
  for (const p of d.summary.projects.slice(0, 3)) {
    projRows.push(
      twoCol(`  ${p.project}`, `${formatUsd(p.totalCost)} · ${formatTokens(p.totalTokens)}`)
    );
  }
  if (projRows.length === 1) projRows.push("  No projects recorded.");

  return renderCard(`tokmeter · why (${formatUsd(d.todayCost)} today)`, [
    modelRows,
    driverRows,
    projRows,
  ]);
}

export function renderQuotaCard(d: SlashCardData): string {
  if (d.quotas.length === 0) {
    return renderCard("tokmeter · plan quotas", [
      ["No active plan quota windows recorded yet."],
      [
        "Claude Code records 5h/7d via statusline; Codex from",
        "newest rollout tails; Grok Bot from its desktop cache.",
      ],
    ]);
  }
  const nowSec = d.now / 1000;
  const rows: string[] = [];
  for (const q of d.quotas) {
    const pct = Math.min(100, Math.max(0, Math.round(q.usedPct)));
    const resetStr = q.resetsAt > nowSec ? `in ${formatSpan(q.resetsAt - nowSec)}` : "reset";
    rows.push(twoCol(`${q.agent} · ${q.window}`, `${pct}% · ${resetStr}`));
    rows.push(`  ${gaugeBar(pct, 18)}  verdict: ${q.verdict}`);
    const metaParts = [
      `rate ${q.avgPctPerHour.toFixed(1)}%/h`,
      ...(q.plan ? [`plan ${q.plan}`] : []),
      ...(q.creditsBalance !== undefined ? [`${q.creditsBalance.toFixed(0)} credits`] : []),
    ];
    rows.push(`  ${metaParts.join(" · ")}`);
  }
  return renderCard("tokmeter · plan quotas", [rows]);
}

export function renderLiveCard(d: SlashCardData): string {
  const agg = d.live;
  if (!agg || agg.sessions === 0) {
    return renderCard("tokmeter · live sessions", [
      [
        d.daemonOnline
          ? "No active sessions in the last 5 minutes."
          : "Daemon is currently offline.",
      ],
      ["Start daemon: tokmeter daemon start"],
    ]);
  }
  const head = [
    twoCol(`Active sessions: ${agg.sessions}`, `Live cost: ${formatUsd(agg.totalCost)}`),
    twoCol(
      `Tokens: ${formatTokens(agg.totalInputTokens)} in / ${formatTokens(agg.totalOutputTokens)} out`,
      agg.maxContextFillPct !== undefined
        ? `Max ctx: ${Math.round(agg.maxContextFillPct)}%`
        : "ctx ?"
    ),
  ];
  const byProv = ["BY AGENT"];
  for (const p of agg.byProvider.slice(0, 5)) {
    byProv.push(twoCol(`  ${p.provider}`, `${p.sessions} sess · ${formatUsd(p.cost)}`));
  }
  const byMod = ["BY MODEL"];
  for (const m of agg.byModel.slice(0, 5)) {
    byMod.push(
      twoCol(
        `  ${m.model}`,
        `${formatUsd(m.cost)} · ${formatTokens(m.inputTokens + m.outputTokens)}`
      )
    );
  }
  return renderCard("tokmeter · live sessions", [head, byProv, byMod]);
}

export function renderRoutesCard(d: SlashCardData): string {
  const koshaAge =
    d.pricingMtime > 0
      ? `kosha rate snapshot ${formatSpan(Math.max(0, (d.now - d.pricingMtime) / 1000))} ago`
      : "kosha built-in catalog";
  const actualSec = [
    twoCol(`Today recorded spend`, `${formatUsd(d.todayCost)} (frozen rates)`),
    koshaAge,
  ];

  const cardRows: string[] = ["TODAY RATE TABLE (MODEL · TIER · EFF $/M)"];
  const models = d.rates?.models ?? [];
  if (models.length > 0) {
    for (const m of models.slice(0, 6)) {
      const eff =
        m.source.tier === "unpriced" || m.effectivePerMillion === null
          ? "$?"
          : `${formatUsd(m.effectivePerMillion)}/M`;
      const tier = m.source.tier === "unpriced" ? "unpriced" : m.source.tier;
      cardRows.push(twoCol(`  ${m.model} (${tier})`, `${eff} · ${formatUsd(m.usage.cost)}`));
    }
  } else {
    cardRows.push("  No priced model usage today.");
  }

  const altRows: string[] = ["HYPOTHETICAL RE-PRICE AT TODAY RATES"];
  const proj = d.crossTool?.projections ?? [];
  if (proj.length > 0) {
    for (const p of proj.slice(0, 5)) {
      const priceStr = p.projectedCost > 0.0001 ? formatUsd(p.projectedCost) : "$?";
      altRows.push(twoCol(`  ${p.model} (${p.provider})`, priceStr));
    }
  } else {
    altRows.push("  No cross-tool projections available yet.");
  }

  const disclaimer = wrapTextRows(
    "Note: alternatives use today's kosha catalog; actual spend reflects frozen run rates. $? = unpriced (never $0)."
  );

  return renderCard("tokmeter · routes", [actualSec, cardRows, altRows, disclaimer]);
}

export function renderDigestCard(d: SlashCardData): string {
  const s = d.summary.stats;
  const overview = [
    twoCol(`Today: ${formatUsd(d.todayCost)}`, `7d: ${formatUsd(d.weekCost)}`),
    twoCol(`30d: ${formatUsd(d.monthCost)}`, `Lifetime: ${formatUsd(s.totalCost)}`),
    twoCol(`Active days: ${s.activeDays}`, `Streak: ${s.longestStreak}d`),
  ];
  const provRows = ["PROVIDERS (ALL-TIME)"];
  for (const p of d.providers.slice(0, 4)) {
    provRows.push(
      twoCol(`  ${p.provider}`, `${formatUsd(p.cost)} · ${formatTokens(p.totalTokens)}`)
    );
  }
  if (provRows.length === 1) provRows.push("  None recorded.");
  const recentDaily = ["RECENT DAYS"];
  for (const day of d.summary.daily.slice(-4).reverse()) {
    recentDaily.push(
      twoCol(`  ${day.date}`, `${formatUsd(day.cost)} · ${formatTokens(day.totalTokens)}`)
    );
  }
  return renderCard("tokmeter · digest", [overview, provRows, recentDaily]);
}

export function renderStatuslineCard(d: SlashCardData): string {
  const sl = d.config.statusline;
  const activeTheme = sl.theme ?? d.config.theme;
  const cfgSec = [
    twoCol(`Active style: ${sl.style}`, `density: ${sl.density}`),
    twoCol(`Theme: ${activeTheme}`, `nerdFont: ${sl.nerdFont ?? d.config.nerdFont}`),
  ];

  const previewSec = ["ALL 5 SKINS (62-COL COMPACT PREVIEW)"];
  for (const style of STATUSLINE_STYLES) {
    const rendered = renderStatusline(d.view, {
      cols: 62 - 7, // prefix "style: " is up to 8 chars, keep total <= 62
      color: false,
      style,
      density: "compact",
      theme: activeTheme,
    });
    const tag = style === sl.style ? "*" : " ";
    previewSec.push(`${tag}${padCells(style, 6)} ${rendered}`);
  }

  const tipsSec = [
    "CONFIGURE (COPY-PASTE)",
    "  tokmeter config set statusline.style pill",
    "  tokmeter config set statusline.density telemetry",
    "  tokmeter config set statusline.theme light",
  ];
  return renderCard("tokmeter · statusline skins", [cfgSec, previewSec, tipsSec]);
}

export function renderDoctorCard(d: SlashCardData): string {
  const h = d.health;
  const koshaAge =
    d.pricingMtime > 0 ? formatSpan(Math.max(0, (d.now - d.pricingMtime) / 1000)) : "missing";
  const scanAge =
    h?.lastScanAt && h.lastScanAt > 0
      ? formatSpan(Math.max(0, (d.now - h.lastScanAt) / 1000))
      : "—";
  const daemonSec = [
    twoCol(`Daemon status`, d.daemonOnline ? "OK (online)" : "OFFLINE (local fallback)"),
    twoCol(`Last daemon scan`, scanAge),
    twoCol(`Kosha pricing age`, koshaAge),
  ];
  const unpricedCount = h?.unpricedModelsTotal ?? 0;
  const warnCount = h?.warnings.length ?? 0;
  const auditSec = [
    twoCol(`Unpriced models`, String(unpricedCount)),
    twoCol(`Unpriced records`, String(h?.unpricedRecords ?? 0)),
    twoCol(`Scanner warnings`, String(warnCount)),
  ];
  if (h && h.unpricedModels.length > 0) {
    auditSec.push(`  Sample unpriced: ${h.unpricedModels.slice(0, 3).join(", ")}`);
  }
  const cmdSec = [
    "NEXT CHECKS (MANUAL CLI)",
    "  tokmeter pricing-audit · tokmeter coverage · tokmeter daemon status",
  ];
  return renderCard("tokmeter · doctor", [daemonSec, auditSec, cmdSec]);
}

export function renderSlashHelpCard(): string {
  return renderCard("tokmeter · /tokmeter commands", [
    [
      "Zero-token cards (strictly read-only, 66 cols):",
      "  /tokmeter cockpit     today/week/month + burn + quotas",
      "  /tokmeter why         cost drivers, cache & subagents",
      "  /tokmeter quota       plan rate windows & pace verdicts",
      "  /tokmeter live        active daemon sessions",
      "  /tokmeter routes      neutral model rate & alt costs",
      "  /tokmeter digest      multi-day spend summary",
      "  /tokmeter statusline  5 skins preview & config tips",
      "  /tokmeter doctor      daemon, kosha & coverage health",
    ],
  ]);
}

export function renderSlashCard(command: string | undefined, data: SlashCardData): string {
  const normalized = (command ?? "cockpit").trim().toLowerCase();
  if (normalized === "help" || normalized === "--help" || normalized === "-h") {
    return renderSlashHelpCard();
  }
  switch (normalized) {
    case "":
    case "cockpit":
      return renderCockpitCard(data);
    case "why":
      return renderWhyCard(data);
    case "quota":
      return renderQuotaCard(data);
    case "live":
      return renderLiveCard(data);
    case "routes":
      return renderRoutesCard(data);
    case "digest":
      return renderDigestCard(data);
    case "statusline":
      return renderStatuslineCard(data);
    case "doctor":
      return renderDoctorCard(data);
    default:
      return renderSlashHelpCard();
  }
}

// ─── Read-Only Data Loader ─────────────────────────────────────────────────

function sumRange(daily: TokmeterSummary["daily"], daysBack: number, todayKey: string): number {
  const d = new Date(`${todayKey}T12:00:00`);
  d.setDate(d.getDate() - (daysBack - 1));
  const since = localDateKey(d.getTime());
  let sum = 0;
  for (const e of daily) {
    if (e.date >= since && e.date <= todayKey) sum += e.cost;
  }
  return sum;
}

export async function loadSlashCardData(opts?: {
  homeDir?: string;
  cwd?: string;
  now?: number;
}): Promise<SlashCardData> {
  const now = opts?.now ?? Date.now();
  const homeDir = opts?.homeDir ?? homedir();
  const cwd = opts?.cwd ?? process.cwd();
  const config = (() => {
    try {
      return loadConfig(homeDir);
    } catch {
      return DEFAULT_CONFIG;
    }
  })();

  const [sumRes, provRes, sigRes, liveRes, quotaRes, ratesRes, crossRes, healthRes, ctxRes] =
    await Promise.all([
      fetchDaemonJson<TokmeterSummary>("/api/summary", {
        homeDir,
        probeTimeoutMs: 400,
        timeoutMs: 2500,
      }),
      fetchDaemonJson<ProviderSummary[]>("/api/providers", {
        homeDir,
        probeTimeoutMs: 400,
        timeoutMs: 2500,
      }),
      fetchDaemonJson<StatbarSignals>("/api/statbar-signals", {
        homeDir,
        probeTimeoutMs: 400,
        timeoutMs: 2500,
      }),
      fetchDaemonJson<{ aggregated: AggregatedStats | null }>("/api/live", {
        homeDir,
        probeTimeoutMs: 400,
        timeoutMs: 2500,
      }),
      fetchDaemonJson<{ windows: QuotaWindow[] }>("/api/quota", {
        homeDir,
        probeTimeoutMs: 400,
        timeoutMs: 2500,
      }),
      fetchDaemonJson<ModelRatesResponse>("/api/rates?scope=today", {
        homeDir,
        probeTimeoutMs: 400,
        timeoutMs: 2500,
      }),
      fetchDaemonJson<CrossToolSummary>("/api/cross-tool", {
        homeDir,
        probeTimeoutMs: 400,
        timeoutMs: 2500,
      }),
      fetchDaemonJson<DaemonHealthSummary>("/api/health", {
        homeDir,
        probeTimeoutMs: 400,
        timeoutMs: 2500,
      }),
      fetchDaemonJson<StatuslineContextResponse>(
        `/api/statusline-context?project=${encodeURIComponent(cwd)}`,
        { homeDir, probeTimeoutMs: 400, timeoutMs: 2500 }
      ),
    ]);

  let daemonOnline = sumRes.ok;
  let summary: TokmeterSummary;
  let providers: ProviderSummary[] = provRes.ok ? provRes.data : [];
  let signals: StatbarSignals | null = sigRes.ok ? sigRes.data : null;
  let quotas: QuotaWindow[] = quotaRes.ok ? quotaRes.data.windows : [];
  let rates: ModelRatesResponse | null = ratesRes.ok ? ratesRes.data : null;
  let crossTool: CrossToolSummary | null = crossRes.ok ? crossRes.data : null;
  let health: DaemonHealthSummary | null = healthRes.ok ? healthRes.data : null;
  const live: AggregatedStats | null = liveRes.ok ? liveRes.data.aggregated : null;

  if (sumRes.ok) {
    summary = sumRes.data;
  } else {
    daemonOnline = false;
    const core = new TokmeterCore({ homeDir });
    await core.scan();
    summary = core.getSummary();
    if (providers.length === 0) providers = core.getProviderBreakdown();
    signals = signals ?? core.getStatbarSignals(now);
    rates = rates ?? (await core.getModelRates("today"));
    crossTool = crossTool ?? (await core.getCrossToolComparison());
    const meta: ScanMeta = core.getScanMeta();
    health = health ?? {
      ready: true,
      unpricedModels: meta.unpricedModels.slice(0, 100),
      unpricedModelsTotal: meta.unpricedModels.length,
      unpricedRecords: meta.unpricedRecords,
      warnings: meta.warnings,
      lastScanAt: meta.lastScanAt,
    };
    if (quotas.length === 0) {
      try {
        quotas = await getQuota(homeDir, now);
      } catch {}
    }
  }

  const todayStr = localDateKey(now);
  const todayEntry = summary.daily.find((d) => d.date === todayStr);
  const todayCost = ctxRes.ok ? ctxRes.data.today.cost : (todayEntry?.cost ?? 0);
  const todayTokens = ctxRes.ok
    ? ctxRes.data.today.in + ctxRes.data.today.out
    : (todayEntry?.totalTokens ?? 0);
  const weekCost = sumRange(summary.daily, 7, todayStr);
  const monthCost = sumRange(summary.daily, 30, todayStr);

  const projectFolder = cwd.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const project = canonicalizeProjectName(cwd, projectFolder) || projectFolder || "tokmeter";
  const view = await buildAmbientStatusView(
    { ambient: true, cwd, watch: false, watchMs: 2000, noColor: false },
    {
      homeDir,
      now,
      context: ctxRes.ok ? { state: "fresh", ctx: ctxRes.data, ageMs: 0 } : { state: "down" },
    }
  );

  return {
    now,
    daemonOnline,
    project,
    config,
    summary,
    providers,
    todayCost,
    todayTokens,
    weekCost,
    monthCost,
    signals,
    quotas,
    live,
    rates,
    crossTool,
    health,
    pricingMtime: getKoshaRegistryMtime(homeDir),
    view,
  };
}

export async function runSlashCommand(subcommand?: string, rest: string[] = []): Promise<void> {
  const norm = (subcommand ?? "cockpit").trim().toLowerCase();
  if (norm === "help" || norm === "--help" || norm === "-h") {
    process.stdout.write(`${renderSlashHelpCard()}\n`);
    return;
  }
  let cwd = process.cwd();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--cwd" && rest[i + 1]) cwd = rest[++i];
  }
  const data = await loadSlashCardData({ cwd });
  process.stdout.write(`${renderSlashCard(norm, data)}\n`);
}
