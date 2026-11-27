/**
 * @sriinnu/tokmeter-core — Shareable editorial receipt builder & renderers.
 *
 * Produces privacy-scrubbed (no repo names or paths unless explicitly enabled)
 * Thermal and Broadsheet receipts in plain/ANSI text, zero-dependency SVG, and
 * Markdown across all operating systems.
 */

import { sanitizeDataLabel } from "./display-safety.js";
import type { ModelSummary, TokmeterSummary } from "./types.js";

export type ReceiptStyle = "thermal" | "broadsheet";

export interface ReceiptAlternative {
  model: string;
  provider: string;
  projectedCost: number;
  deltaUsd: number;
}

export interface ReceiptProviderRow {
  provider: string;
  cost: number;
  tokens: number;
  sharePct: number;
}

export interface ReceiptModelRow {
  model: string;
  provider: string;
  cost: number;
  tokens: number;
  sharePct: number;
}

export interface ReceiptProjectRow {
  project: string;
  cost: number;
  tokens: number;
  sharePct: number;
}

export interface ReceiptData {
  scopeLabel: string;
  generatedAt: string;
  privacyScrubbed: boolean;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  activeDays: number;
  longestStreak: number;
  totalRecords: number;
  unpricedRecords: number;
  cacheHitRate: number | null;
  signals: {
    paceMultiple: number | null;
    burnCostPerHour: number | null;
    compactionCost: number | null;
    compactionShare: number | null;
    subagentShare: number | null;
  };
  providers: ReceiptProviderRow[];
  models: ReceiptModelRow[];
  projects: ReceiptProjectRow[];
  alternatives: ReceiptAlternative[];
}

export interface BuildReceiptOptions {
  label?: string;
  includeProjects?: boolean;
  alternatives?: Array<{ model: string; provider: string; projectedCost: number }>;
  now?: number;
}

function fmtUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtPct(pct: number): string {
  return `${pct.toFixed(pct >= 10 || pct === 0 ? 1 : 2)}%`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function aggregateProvidersFromModels(
  models: ModelSummary[],
  totalCost: number
): ReceiptProviderRow[] {
  const byProvider = new Map<string, { cost: number; tokens: number }>();
  for (const m of models) {
    const key = sanitizeDataLabel(m.provider, 64) || "unknown";
    const cur = byProvider.get(key) ?? { cost: 0, tokens: 0 };
    cur.cost += m.cost;
    cur.tokens += m.totalTokens;
    byProvider.set(key, cur);
  }
  const sorted = [...byProvider.entries()]
    .map(([provider, v]) => ({
      provider,
      cost: v.cost,
      tokens: v.tokens,
      sharePct: totalCost > 0 ? (v.cost / totalCost) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  if (sorted.length <= 6) return sorted;
  const head = sorted.slice(0, 5);
  const tail = sorted.slice(5);
  const otherCost = tail.reduce((s, r) => s + r.cost, 0);
  const otherTokens = tail.reduce((s, r) => s + r.tokens, 0);
  head.push({
    provider: `other (${tail.length})`,
    cost: otherCost,
    tokens: otherTokens,
    sharePct: totalCost > 0 ? (otherCost / totalCost) * 100 : 0,
  });
  return head;
}

/**
 * Build a privacy-safe, structured receipt snapshot from a {@link TokmeterSummary}.
 * Repository/project names are omitted unless `opts.includeProjects` is `true`.
 */
export function buildReceiptData(
  summary: TokmeterSummary,
  opts: BuildReceiptOptions = {}
): ReceiptData {
  const stats = summary.stats;
  const totalCanonicalInput = stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens;
  const cacheHitRate = totalCanonicalInput > 0 ? stats.cacheReadTokens / totalCanonicalInput : null;

  const includeProjects = opts.includeProjects === true;
  const providers = aggregateProvidersFromModels(summary.models, stats.totalCost);

  const models: ReceiptModelRow[] = summary.models
    .slice()
    .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens)
    .slice(0, 5)
    .map((m) => ({
      model: sanitizeDataLabel(m.model, 48) || "unknown",
      provider: sanitizeDataLabel(m.provider, 32) || "unknown",
      cost: m.cost,
      tokens: m.totalTokens,
      sharePct: m.percentageOfTotal,
    }));

  const projects: ReceiptProjectRow[] = includeProjects
    ? summary.projects
        .slice()
        .sort((a, b) => b.totalCost - a.totalCost || b.totalTokens - a.totalTokens)
        .slice(0, 5)
        .map((p) => ({
          project: sanitizeDataLabel(p.project, 48) || "unknown",
          cost: p.totalCost,
          tokens: p.totalTokens,
          sharePct: stats.totalCost > 0 ? (p.totalCost / stats.totalCost) * 100 : 0,
        }))
    : [];

  const sig = summary.signals;
  const signals = {
    paceMultiple: sig?.pace?.multiple ?? null,
    burnCostPerHour: sig && sig.burnRate.recordsInWindow > 0 ? sig.burnRate.costPerHour : null,
    compactionCost: sig && sig.compactionToday.events > 0 ? sig.compactionToday.cost : null,
    compactionShare: sig && sig.compactionToday.events > 0 ? sig.compactionToday.share : null,
    subagentShare: sig && sig.subagentToday.records > 0 ? sig.subagentToday.share : null,
  };

  const alternatives: ReceiptAlternative[] = (opts.alternatives ?? [])
    .filter((a) => a.projectedCost > 0.0001)
    .slice()
    .sort((a, b) => a.projectedCost - b.projectedCost)
    .slice(0, 3)
    .map((a) => ({
      model: sanitizeDataLabel(a.model, 44) || "unknown",
      provider: sanitizeDataLabel(a.provider, 28) || "unknown",
      projectedCost: a.projectedCost,
      deltaUsd: a.projectedCost - stats.totalCost,
    }));

  const fallbackRange =
    summary.daily.length > 0
      ? `${summary.daily[0]!.date} -> ${summary.daily[summary.daily.length - 1]!.date}`
      : "all-time";

  return {
    scopeLabel: sanitizeDataLabel(opts.label ?? fallbackRange, 64) || "all-time",
    generatedAt: new Date(opts.now ?? Date.now()).toISOString().slice(0, 16).replace("T", " "),
    privacyScrubbed: !includeProjects,
    totalCost: stats.totalCost,
    totalTokens: stats.totalTokens,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cacheReadTokens: stats.cacheReadTokens,
    cacheWriteTokens: stats.cacheWriteTokens,
    reasoningTokens: stats.reasoningTokens,
    activeDays: stats.activeDays,
    longestStreak: stats.longestStreak,
    totalRecords: stats.totalRecords,
    unpricedRecords: summary.meta.unpricedRecords,
    cacheHitRate,
    signals,
    providers,
    models,
    projects,
    alternatives,
  };
}

function leaderLine(left: string, right: string, width: number, fill = "."): string {
  const maxLeft = Math.max(8, width - right.length - 2);
  const clippedLeft = left.length > maxLeft ? `${left.slice(0, maxLeft - 1)}…` : left;
  const dots = Math.max(1, width - clippedLeft.length - right.length);
  return `${clippedLeft}${fill.repeat(dots)}${right}`;
}

function centerLine(text: string, width: number): string {
  if (text.length >= width) return text;
  const pad = Math.floor((width - text.length) / 2);
  return `${" ".repeat(pad)}${text}`;
}

/**
 * Render a receipt as plain or ANSI-styled text in either `thermal` or `broadsheet` layout.
 */
export function renderReceiptText(
  data: ReceiptData,
  opts: { style?: ReceiptStyle; color?: boolean } = {}
): string {
  const style = opts.style ?? "thermal";
  const color = opts.color === true;
  const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const accent = (s: string) => (color ? `\x1b[36;1m${s}\x1b[0m` : s);
  const warn = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);

  const width = style === "broadsheet" ? 64 : 46;
  const rule = style === "broadsheet" ? "═".repeat(width) : "-".repeat(width);
  const thinRule = style === "broadsheet" ? "─".repeat(width) : "- ".repeat(Math.floor(width / 2));

  const lines: string[] = [];
  if (style === "broadsheet") {
    lines.push(rule);
    lines.push(bold(centerLine("TOKMETER · AI ENGINEERING LEDGER", width)));
    lines.push(dim(centerLine(`${data.scopeLabel} · ${data.generatedAt} UTC`, width)));
    lines.push(rule);
  } else {
    lines.push(`+${"-".repeat(width - 2)}+`);
    lines.push(bold(centerLine("∞  TOKMETER RECEIPT", width)));
    lines.push(dim(centerLine(data.scopeLabel, width)));
    lines.push(dim(centerLine(`${data.generatedAt} UTC`, width)));
    lines.push(rule);
  }

  lines.push(bold(leaderLine("EST. API COST", fmtUsd(data.totalCost), width, " ")));
  lines.push(leaderLine("TOTAL TOKENS", fmtTokens(data.totalTokens), width, " "));
  lines.push(
    dim(
      leaderLine(
        "TOKENS IN / OUT",
        `${fmtTokens(data.inputTokens)} / ${fmtTokens(data.outputTokens)}`,
        width,
        " "
      )
    )
  );
  lines.push(
    dim(
      leaderLine(
        "CACHE READ / WRITE",
        `${fmtTokens(data.cacheReadTokens)} / ${fmtTokens(data.cacheWriteTokens)}`,
        width,
        " "
      )
    )
  );
  if (data.cacheHitRate !== null) {
    lines.push(accent(leaderLine("CACHE HIT SHARE", fmtPct(data.cacheHitRate * 100), width, " ")));
  }

  lines.push(thinRule);
  lines.push(bold("AGENTS"));
  for (const p of data.providers) {
    lines.push(
      leaderLine(`  ${p.provider}`, `${fmtUsd(p.cost)} (${Math.round(p.sharePct)}%)`, width)
    );
  }

  if (data.models.length > 0) {
    lines.push(thinRule);
    lines.push(bold("TOP MODELS"));
    for (const m of data.models) {
      lines.push(leaderLine(`  ${m.model}`, `${fmtUsd(m.cost)} · ${fmtTokens(m.tokens)}`, width));
    }
  }

  if (data.projects.length > 0) {
    lines.push(thinRule);
    lines.push(bold("PROJECTS"));
    for (const p of data.projects) {
      lines.push(
        leaderLine(`  ${p.project}`, `${fmtUsd(p.cost)} (${Math.round(p.sharePct)}%)`, width)
      );
    }
  }

  const signalRows: Array<[string, string]> = [];
  if (data.signals.paceMultiple !== null) {
    signalRows.push(["PACE VS TYPICAL", `${data.signals.paceMultiple.toFixed(2)}x`]);
  }
  if (data.signals.burnCostPerHour !== null) {
    signalRows.push(["LIVE BURN", `${fmtUsd(data.signals.burnCostPerHour)}/hr`]);
  }
  if (data.signals.compactionCost !== null && data.signals.compactionShare !== null) {
    signalRows.push([
      "COMPACTION TAX",
      `${fmtUsd(data.signals.compactionCost)} (${fmtPct(data.signals.compactionShare * 100)})`,
    ]);
  }
  if (data.signals.subagentShare !== null) {
    signalRows.push(["SUBAGENT SHARE", fmtPct(data.signals.subagentShare * 100)]);
  }
  if (signalRows.length > 0) {
    lines.push(thinRule);
    lines.push(bold("TELEMETRY"));
    for (const [label, value] of signalRows) {
      lines.push(leaderLine(`  ${label}`, value, width));
    }
  }

  if (data.alternatives.length > 0) {
    lines.push(thinRule);
    lines.push(bold("IF WORKLOAD RAN ON"));
    for (const alt of data.alternatives) {
      const sign = alt.deltaUsd < 0 ? "-" : "+";
      const deltaStr =
        Math.abs(alt.deltaUsd) < 0.01 ? "par" : `${sign}${fmtUsd(Math.abs(alt.deltaUsd))}`;
      lines.push(leaderLine(`  ${alt.model}`, `${fmtUsd(alt.projectedCost)} (${deltaStr})`, width));
    }
  }

  if (data.unpricedRecords > 0) {
    lines.push(thinRule);
    lines.push(warn(`! ${data.unpricedRecords} unpriced record(s) excluded from USD`));
  }

  lines.push(rule);
  lines.push(
    dim(
      centerLine(
        data.privacyScrubbed
          ? "local ledger · paths scrubbed · npx @sriinnu/tokmeter"
          : "local ledger · npx @sriinnu/tokmeter",
        width
      )
    )
  );
  if (style === "thermal") {
    lines.push(`+${"-".repeat(width - 2)}+`);
  }
  return lines.join("\n");
}

/** Render a receipt as GitHub-Flavored Markdown. */
export function renderReceiptMarkdown(data: ReceiptData): string {
  const cacheStr = data.cacheHitRate !== null ? fmtPct(data.cacheHitRate * 100) : "n/a";
  const privacy = data.privacyScrubbed ? " · paths scrubbed" : "";
  const lines = [
    `### ∞ Tokmeter Receipt — ${data.scopeLabel}`,
    "",
    `**Est. API Cost:** \`${fmtUsd(data.totalCost)}\` · **Tokens:** \`${fmtTokens(data.totalTokens)}\` · **Cache Hit:** \`${cacheStr}\` · **Calls:** \`${data.totalRecords.toLocaleString()}\``,
    "",
  ];

  if (data.providers.length > 0) {
    lines.push("| Agent | Est. Cost | Tokens | Share |", "| --- | ---: | ---: | ---: |");
    for (const p of data.providers) {
      lines.push(
        `| ${p.provider} | ${fmtUsd(p.cost)} | ${fmtTokens(p.tokens)} | ${fmtPct(p.sharePct)} |`
      );
    }
    lines.push("");
  }

  if (data.models.length > 0) {
    lines.push("| Model | Agent | Est. Cost | Tokens |", "| --- | --- | ---: | ---: |");
    for (const m of data.models) {
      lines.push(`| ${m.model} | ${m.provider} | ${fmtUsd(m.cost)} | ${fmtTokens(m.tokens)} |`);
    }
    lines.push("");
  }

  if (data.projects.length > 0) {
    lines.push("| Project | Est. Cost | Tokens | Share |", "| --- | ---: | ---: | ---: |");
    for (const p of data.projects) {
      lines.push(
        `| ${p.project} | ${fmtUsd(p.cost)} | ${fmtTokens(p.tokens)} | ${fmtPct(p.sharePct)} |`
      );
    }
    lines.push("");
  }

  const telemetry: string[] = [];
  if (data.signals.paceMultiple !== null)
    telemetry.push(`Pace \`${data.signals.paceMultiple.toFixed(2)}x\``);
  if (data.signals.compactionCost !== null) {
    telemetry.push(`Compaction \`${fmtUsd(data.signals.compactionCost)}\``);
  }
  if (data.signals.subagentShare !== null) {
    telemetry.push(`Subagents \`${fmtPct(data.signals.subagentShare * 100)}\``);
  }
  if (telemetry.length > 0) lines.push(`*Telemetry:* ${telemetry.join(" · ")}`, "");

  lines.push(
    `<sub>Generated locally via \`npx @sriinnu/tokmeter receipt\` (${data.generatedAt} UTC${privacy})</sub>`
  );
  return lines.join("\n");
}

/**
 * Render a zero-dependency vector SVG receipt (`thermal` or `broadsheet`) safe for
 * direct export and social sharing across macOS, Linux, and Windows.
 */
export function renderReceiptSvg(data: ReceiptData, opts: { style?: ReceiptStyle } = {}): string {
  const isBroadsheet = (opts.style ?? "thermal") === "broadsheet";
  const width = isBroadsheet ? 680 : 520;
  const padX = isBroadsheet ? 36 : 30;
  const innerW = width - padX * 2;
  const palette = isBroadsheet
    ? {
        bg: "#f4efe4",
        card: "#faf7f0",
        ink: "#1a1815",
        muted: "#6b6358",
        rule: "#2d2924",
        accent: "#8c3b20",
        barBg: "#e6dfd1",
        fontDisplay: "Georgia, 'Times New Roman', serif",
        fontMono: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
      }
    : {
        bg: "#ece8df",
        card: "#fbfaf6",
        ink: "#16181c",
        muted: "#636871",
        rule: "#b9b4a8",
        accent: "#5b4fe0",
        barBg: "#eae6dc",
        fontDisplay: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
        fontMono: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
      };

  const elements: string[] = [];
  let y = isBroadsheet ? 52 : 56;

  // Header
  elements.push(
    `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${palette.fontDisplay}" font-size="${isBroadsheet ? 23 : 20}" font-weight="700" letter-spacing="${isBroadsheet ? 1.5 : 2}" fill="${palette.ink}">${escapeXml(isBroadsheet ? "TOKMETER LEDGER" : "∞ TOKMETER")}</text>`
  );
  y += 22;
  elements.push(
    `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${palette.fontMono}" font-size="11" fill="${palette.muted}">${escapeXml(`${data.scopeLabel} · ${data.generatedAt} UTC`)}</text>`
  );
  y += 20;

  // Rule
  elements.push(
    `<line x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}" stroke="${palette.rule}" stroke-width="${isBroadsheet ? 2 : 1}" ${isBroadsheet ? "" : 'stroke-dasharray="4 3"'}/>`
  );
  y += 34;

  // Hero numbers
  elements.push(
    `<text x="${padX}" y="${y - 16}" font-family="${palette.fontMono}" font-size="10" letter-spacing="1.4" fill="${palette.muted}">EST. API COST</text>`
  );
  elements.push(
    `<text x="${width - padX}" y="${y - 16}" text-anchor="end" font-family="${palette.fontMono}" font-size="10" letter-spacing="1.4" fill="${palette.muted}">TOTAL TOKENS</text>`
  );
  elements.push(
    `<text x="${padX}" y="${y + 12}" font-family="${palette.fontMono}" font-size="30" font-weight="700" fill="${palette.ink}">${escapeXml(fmtUsd(data.totalCost))}</text>`
  );
  elements.push(
    `<text x="${width - padX}" y="${y + 12}" text-anchor="end" font-family="${palette.fontMono}" font-size="24" font-weight="700" fill="${palette.accent}">${escapeXml(fmtTokens(data.totalTokens))}</text>`
  );
  y += 32;

  const subFacts = [
    `In ${fmtTokens(data.inputTokens)}`,
    `Out ${fmtTokens(data.outputTokens)}`,
    `Cache Read ${fmtTokens(data.cacheReadTokens)}`,
    ...(data.cacheHitRate !== null ? [`Hit ${fmtPct(data.cacheHitRate * 100)}`] : []),
  ].join(" · ");
  elements.push(
    `<text x="${padX}" y="${y}" font-family="${palette.fontMono}" font-size="11" fill="${palette.muted}">${escapeXml(subFacts)}</text>`
  );
  y += 20;

  const drawDivider = () => {
    elements.push(
      `<line x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}" stroke="${palette.rule}" stroke-width="1" stroke-dasharray="3 3"/>`
    );
    y += 22;
  };

  if (data.providers.length > 0) {
    drawDivider();
    elements.push(
      `<text x="${padX}" y="${y}" font-family="${palette.fontMono}" font-size="10" font-weight="700" letter-spacing="1.5" fill="${palette.muted}">AGENTS</text>`
    );
    y += 18;
    const barW = Math.min(180, innerW * 0.36);
    for (const p of data.providers) {
      const fillW = Math.max(2, Math.round((Math.min(100, Math.max(0, p.sharePct)) / 100) * barW));
      elements.push(
        `<text x="${padX}" y="${y}" font-family="${palette.fontMono}" font-size="12" fill="${palette.ink}">${escapeXml(p.provider)}</text>`
      );
      elements.push(
        `<rect x="${padX + 150}" y="${y - 9}" width="${barW}" height="7" rx="3" fill="${palette.barBg}"/>`
      );
      elements.push(
        `<rect x="${padX + 150}" y="${y - 9}" width="${fillW}" height="7" rx="3" fill="${palette.accent}"/>`
      );
      elements.push(
        `<text x="${width - padX}" y="${y}" text-anchor="end" font-family="${palette.fontMono}" font-size="12" fill="${palette.ink}">${escapeXml(`${fmtUsd(p.cost)} (${Math.round(p.sharePct)}%)`)}</text>`
      );
      y += 22;
    }
  }

  if (data.models.length > 0) {
    drawDivider();
    elements.push(
      `<text x="${padX}" y="${y}" font-family="${palette.fontMono}" font-size="10" font-weight="700" letter-spacing="1.5" fill="${palette.muted}">TOP MODELS</text>`
    );
    y += 18;
    for (const m of data.models) {
      const label = m.model.length > 28 ? `${m.model.slice(0, 27)}…` : m.model;
      elements.push(
        `<text x="${padX}" y="${y}" font-family="${palette.fontMono}" font-size="12" fill="${palette.ink}">${escapeXml(label)}</text>`
      );
      elements.push(
        `<text x="${width - padX}" y="${y}" text-anchor="end" font-family="${palette.fontMono}" font-size="12" fill="${palette.muted}">${escapeXml(`${fmtTokens(m.tokens)} · ${fmtUsd(m.cost)}`)}</text>`
      );
      y += 20;
    }
  }

  if (data.projects.length > 0) {
    drawDivider();
    elements.push(
      `<text x="${padX}" y="${y}" font-family="${palette.fontMono}" font-size="10" font-weight="700" letter-spacing="1.5" fill="${palette.muted}">PROJECTS</text>`
    );
    y += 18;
    for (const p of data.projects) {
      const label = p.project.length > 28 ? `${p.project.slice(0, 27)}…` : p.project;
      elements.push(
        `<text x="${padX}" y="${y}" font-family="${palette.fontMono}" font-size="12" fill="${palette.ink}">${escapeXml(label)}</text>`
      );
      elements.push(
        `<text x="${width - padX}" y="${y}" text-anchor="end" font-family="${palette.fontMono}" font-size="12" fill="${palette.muted}">${escapeXml(`${fmtUsd(p.cost)} (${Math.round(p.sharePct)}%)`)}</text>`
      );
      y += 20;
    }
  }

  const footFacts: string[] = [
    `${data.totalRecords.toLocaleString()} calls`,
    `${data.activeDays} active day(s)`,
  ];
  if (data.signals.compactionCost !== null) {
    footFacts.push(`compaction ${fmtUsd(data.signals.compactionCost)}`);
  }
  if (data.signals.subagentShare !== null) {
    footFacts.push(`subagents ${fmtPct(data.signals.subagentShare * 100)}`);
  }

  drawDivider();
  elements.push(
    `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${palette.fontMono}" font-size="11" fill="${palette.muted}">${escapeXml(footFacts.join(" · "))}</text>`
  );
  y += 20;
  elements.push(
    `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${palette.fontMono}" font-size="10" fill="${palette.muted}">${escapeXml(
      data.privacyScrubbed
        ? "local ledger · paths scrubbed · npx @sriinnu/tokmeter receipt"
        : "local ledger · npx @sriinnu/tokmeter receipt"
    )}</text>`
  );
  y += 30;

  const height = y + 18;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(`Tokmeter receipt for ${data.scopeLabel}`)}">`,
    `  <rect width="${width}" height="${height}" fill="${palette.bg}"/>`,
    `  <rect x="14" y="14" width="${width - 28}" height="${height - 28}" rx="${isBroadsheet ? 4 : 10}" fill="${palette.card}" stroke="${palette.rule}" stroke-width="${isBroadsheet ? 1.5 : 1}"/>`,
    ...elements.map((el) => `  ${el}`),
    `</svg>`,
  ].join("\n");
}
