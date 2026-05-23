/**
 * tokmeter digest — Weekly/monthly/daily cost digest with trends and tips.
 *
 * Renders a report-card style output covering spend summary, model breakdown,
 * cache efficiency, optimization score, and actionable tips. Also supports
 * JSON output for programmatic consumption.
 */

import type { ScanOptions, TokenRecord } from "@sriinnu/tokmeter";
import { TokmeterCore, sumUsage } from "@sriinnu/tokmeter";
import chalk from "chalk";
import Table from "cli-table3";

// ---- Constants ----

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// ---- Formatting helpers ----

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Color a percentage-change string — red for up, green for down. */
function colorDelta(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  const arrow = pct >= 0 ? "\u2191" : "\u2193";
  const label = `${sign}${pct.toFixed(1)}% ${arrow}`;
  return pct > 10 ? chalk.red(label) : pct > 0 ? chalk.yellow(label) : chalk.green(label);
}

/** Determine a letter grade from a 0-100 score. */
function letterGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/** Color a grade string with appropriate severity. */
function colorGrade(grade: string): string {
  switch (grade) {
    case "A":
      return chalk.green.bold(grade);
    case "B":
      return chalk.greenBright(grade);
    case "C":
      return chalk.yellow(grade);
    case "D":
      return chalk.hex("#FFA500")(grade);
    default:
      return chalk.red.bold(grade);
  }
}

/** Does this model have cheaper alternatives available? */
function isExpensiveModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("opus") || lower.includes("gpt-4o") || lower.includes("gpt-4-");
}

/** Is this model in the cheaper tier? */
function isCheapModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("sonnet") ||
    lower.includes("haiku") ||
    lower.includes("gpt-4o-mini") ||
    lower.includes("flash") ||
    lower.includes("gemini-2.0")
  );
}

// ---- Date range logic ----

/** Compute the date range boundaries for the current and previous periods. */
function getDigestRanges(period: "today" | "week" | "month") {
  const now = new Date();
  let currentStart: Date;
  let currentEnd: Date;
  let prevStart: Date;
  let prevEnd: Date;

  if (period === "today") {
    currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    currentEnd = new Date(currentStart.getTime() + 86400000);
    prevStart = new Date(currentStart.getTime() - 86400000);
    prevEnd = new Date(currentStart.getTime());
  } else if (period === "month") {
    currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
    currentEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    prevEnd = new Date(currentStart.getTime());
  } else {
    // week (default)
    currentEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    currentStart = new Date(currentEnd.getTime() - 7 * 86400000);
    prevEnd = new Date(currentStart.getTime());
    prevStart = new Date(prevEnd.getTime() - 7 * 86400000);
  }

  return { currentStart, currentEnd, prevStart, prevEnd };
}

/** Format a date range for the header banner. */
function formatDateRange(start: Date, end: Date, period: string): string {
  const fmtDate = (d: Date) => `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
  if (period === "today") {
    return `Today: ${MONTH_SHORT[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()}`;
  }
  const lastDay = new Date(end.getTime() - 86400000);
  if (period === "month") {
    return `Monthly Digest: ${MONTH_SHORT[start.getMonth()]} ${start.getFullYear()}`;
  }
  return `Weekly Digest: ${fmtDate(start)} \u2013 ${fmtDate(lastDay)}, ${lastDay.getFullYear()}`;
}

/** Filter records into a time window (start inclusive, end exclusive). */
function filterRecordsByRange(records: TokenRecord[], start: Date, end: Date): TokenRecord[] {
  const s = start.getTime();
  const e = end.getTime();
  return records.filter((r) => r.timestamp >= s && r.timestamp < e);
}

// ---- Render (terminal output) ----

/**
 * Render the full digest report to stdout.
 *
 * Five sections: period summary, model breakdown, cache efficiency,
 * optimization score, and actionable tips.
 */
function renderDigest(
  currentRecords: TokenRecord[],
  prevRecords: TokenRecord[],
  period: "today" | "week" | "month",
  currentStart: Date,
  currentEnd: Date,
  projectFilter?: string
) {
  const totalCost = currentRecords.reduce((s, r) => s + r.cost, 0);
  const prevTotalCost = prevRecords.reduce((s, r) => s + r.cost, 0);
  const currentUsage = sumUsage(currentRecords);
  const totalCacheRead = currentUsage.cacheReadTokens;
  const totalCacheWrite = currentUsage.cacheWriteTokens;
  const canonicalCacheHitRate = currentUsage.cacheHitRate * 100;

  // Daily breakdown for busiest-day detection
  const dailyMap = new Map<string, number>();
  for (const r of currentRecords) {
    const day = new Date(r.timestamp).toISOString().slice(0, 10);
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + r.cost);
  }
  const days = period === "today" ? 1 : Math.max(dailyMap.size, 1);
  const dailyAvg = totalCost / days;

  let busiestDayLabel = "N/A";
  let busiestDayCost = 0;
  for (const [dateStr, cost] of dailyMap) {
    if (cost > busiestDayCost) {
      busiestDayCost = cost;
      const d = new Date(`${dateStr}T12:00:00`);
      busiestDayLabel = `${DAY_NAMES[d.getDay()]} (${formatCost(cost)})`;
    }
  }

  // ====== Section 1: Period Summary ======
  const title = formatDateRange(currentStart, currentEnd, period);
  const titlePad = Math.max(title.length + 6, 44);
  const border = "\u2550".repeat(titlePad - 2);

  console.log("");
  console.log(chalk.cyan(`\u2554${border}\u2557`));
  console.log(
    chalk.cyan("\u2551") +
      chalk.white.bold(`  ${title}`.padEnd(titlePad - 2)) +
      chalk.cyan("\u2551")
  );
  if (projectFilter) {
    const projLine = `  Project: ${projectFilter}`;
    console.log(
      chalk.cyan("\u2551") + chalk.dim(projLine.padEnd(titlePad - 2)) + chalk.cyan("\u2551")
    );
  }
  console.log(chalk.cyan(`\u255A${border}\u255D`));
  console.log("");

  console.log(`  ${chalk.dim("Total Spend:")}     ${chalk.white.bold(formatCost(totalCost))}`);
  if (prevRecords.length > 0) {
    const pctChange = prevTotalCost > 0 ? ((totalCost - prevTotalCost) / prevTotalCost) * 100 : 0;
    console.log(
      `  ${chalk.dim("vs Last Period:")}  ${formatCost(prevTotalCost)} (${colorDelta(pctChange)})`
    );
  }
  console.log(`  ${chalk.dim("Daily Average:")}   ${formatCost(dailyAvg)}`);
  if (period !== "today") {
    console.log(`  ${chalk.dim("Busiest Day:")}     ${busiestDayLabel}`);
  }
  console.log("");

  // ====== Section 2: Model Breakdown ======
  console.log(chalk.cyan.bold("  Model Breakdown"));
  console.log(chalk.dim(`  ${"\u2500".repeat(42)}`));

  const modelMap = new Map<string, { tokens: number; cost: number; model: string }>();
  for (const r of currentRecords) {
    const existing = modelMap.get(r.model) || { tokens: 0, cost: 0, model: r.model };
    existing.tokens +=
      r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.reasoningTokens;
    existing.cost += r.cost;
    modelMap.set(r.model, existing);
  }
  const modelEntries = [...modelMap.values()].sort((a, b) => b.cost - a.cost);

  const modelTable = new Table({
    head: ["Model", "Tokens", "Cost", "% of Total"],
    colWidths: [30, 12, 10, 12],
    style: { head: ["cyan"] },
  });

  for (const m of modelEntries) {
    const pct = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
    // Highlight the most expensive model in yellow
    const isTop = m === modelEntries[0] && modelEntries.length > 1;
    const costStr = isTop ? chalk.yellow(formatCost(m.cost)) : formatCost(m.cost);
    const modelStr = isTop ? chalk.yellow(m.model) : m.model;
    modelTable.push([modelStr, formatNumber(m.tokens), costStr, `${pct.toFixed(1)}%`]);
  }
  console.log(modelTable.toString());
  console.log("");

  // ====== Section 3: Cache Efficiency ======
  console.log(chalk.cyan.bold("  Cache Efficiency"));
  console.log(chalk.dim(`  ${"\u2500".repeat(42)}`));

  const cacheHitRate = currentUsage.cacheReadShare * 100;

  // Estimate savings: cache reads are ~90% cheaper than regular input
  const avgInputCostPerToken =
    currentUsage.totalInputTokens > 0
      ? currentRecords.reduce((s, r) => {
          const totalTok = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
          return totalTok > 0 ? s + (r.cost * r.inputTokens) / totalTok : s;
        }, 0) / currentUsage.totalInputTokens
      : 0;
  const estimatedSavings = totalCacheRead * avgInputCostPerToken * 0.9;

  const writeReadRatio =
    totalCacheWrite > 0 && totalCacheRead > 0 ? totalCacheWrite / totalCacheRead : 0;
  const cacheWriteWaste =
    writeReadRatio > 1
      ? "High \u2014 writes exceed reads"
      : writeReadRatio > 0.5
        ? "Moderate"
        : "Low \u2014 reads outpace writes";

  const cacheColor =
    cacheHitRate >= 80 ? chalk.green : cacheHitRate >= 50 ? chalk.yellow : chalk.red;
  console.log(`  ${chalk.dim("Cache Hit Rate:")}  ${cacheColor(`${cacheHitRate.toFixed(1)}%`)}`);
  console.log(
    `  ${chalk.dim("Total Input Hit:")} ${cacheColor(`${canonicalCacheHitRate.toFixed(1)}%`)}`
  );
  console.log(`  ${chalk.dim("Fresh Input:")}     ${formatNumber(currentUsage.freshInputTokens)}`);
  console.log(`  ${chalk.dim("Est. Savings:")}    ${chalk.green(formatCost(estimatedSavings))}`);
  console.log(`  ${chalk.dim("Write Waste:")}     ${cacheWriteWaste}`);
  console.log(`  ${chalk.dim("Read Tokens:")}     ${formatNumber(totalCacheRead)}`);
  console.log(`  ${chalk.dim("Write Tokens:")}    ${formatNumber(totalCacheWrite)}`);
  console.log("");

  // ====== Section 4: Cost Optimization Score ======
  console.log(chalk.cyan.bold("  Cost Optimization Score"));
  console.log(chalk.dim(`  ${"\u2500".repeat(42)}`));

  // Cache hit rate (40% weight)
  const cacheScore = Math.min((cacheHitRate / 90) * 100, 100);

  // Model selection efficiency (35% weight) — penalize heavy premium usage
  const expensiveCost = modelEntries
    .filter((m) => isExpensiveModel(m.model))
    .reduce((s, m) => s + m.cost, 0);
  const cheapCost = modelEntries
    .filter((m) => isCheapModel(m.model))
    .reduce((s, m) => s + m.cost, 0);
  const expensiveRatio = totalCost > 0 ? expensiveCost / totalCost : 0;
  const modelScore = Math.max(0, Math.min(100, (1 - expensiveRatio) * 100));

  // Conversation discipline (25% weight) — ideal: 5-30 records/day
  const recordsPerDay = currentRecords.length / days;
  const disciplineScore =
    recordsPerDay <= 30
      ? Math.min(100, (recordsPerDay / 5) * 100)
      : Math.max(40, 100 - (recordsPerDay - 30) * 2);

  const overallScore = cacheScore * 0.4 + modelScore * 0.35 + disciplineScore * 0.25;
  const grade = letterGrade(overallScore);

  console.log(
    `  ${chalk.dim("Overall Grade:")}   ${colorGrade(grade)} ${chalk.dim(`(${overallScore.toFixed(0)}/100)`)}`
  );
  console.log(
    `  ${chalk.dim("Cache:")}           ${letterGrade(cacheScore)} ${chalk.dim(`(${cacheScore.toFixed(0)})`)}`
  );
  console.log(
    `  ${chalk.dim("Model Selection:")} ${letterGrade(modelScore)} ${chalk.dim(`(${modelScore.toFixed(0)})`)}`
  );
  console.log(
    `  ${chalk.dim("Discipline:")}      ${letterGrade(disciplineScore)} ${chalk.dim(`(${disciplineScore.toFixed(0)})`)}`
  );
  console.log("");

  // ====== Section 5: Actionable Tips ======
  console.log(chalk.cyan.bold("  Actionable Tips"));
  console.log(chalk.dim(`  ${"\u2500".repeat(42)}`));

  const tips: string[] = [];

  if (expensiveCost > 0 && cheapCost > 0) {
    tips.push(
      `You spent ${chalk.yellow(formatCost(expensiveCost))} on premium models (Opus/GPT-4). Consider using Sonnet/Haiku/Flash for routine tasks.`
    );
  } else if (expensiveCost > 0 && cheapCost === 0) {
    tips.push(
      `All ${chalk.yellow(formatCost(expensiveCost))} went to premium models. Cheaper models can handle many coding tasks at a fraction of the cost.`
    );
  }

  if (cacheHitRate < 50) {
    tips.push(
      `Cache hit rate is ${chalk.red(`${cacheHitRate.toFixed(0)}%`)} \u2014 long gaps between messages can evict context. Try keeping conversations tighter.`
    );
  } else if (cacheHitRate < 80) {
    tips.push(
      `Cache hit rate is ${chalk.yellow(`${cacheHitRate.toFixed(0)}%`)}. Shorter intervals between messages help keep context cached.`
    );
  }

  // Most expensive project tip
  const projectMap = new Map<string, number>();
  for (const r of currentRecords) {
    projectMap.set(r.project, (projectMap.get(r.project) ?? 0) + r.cost);
  }
  const projectEntries = [...projectMap.entries()].sort((a, b) => b[1] - a[1]);
  if (projectEntries.length > 1) {
    const [topProject, topCost] = projectEntries[0];
    const topPct = totalCost > 0 ? (topCost / totalCost) * 100 : 0;
    if (topPct > 50) {
      tips.push(
        `Project ${chalk.bold(topProject)} accounts for ${chalk.yellow(`${topPct.toFixed(0)}%`)} of spend ` +
          `(${formatCost(topCost)}). Consider scoping conversations tighter.`
      );
    }
  }

  if (prevTotalCost > 0) {
    const pctChange = ((totalCost - prevTotalCost) / prevTotalCost) * 100;
    if (pctChange > 30) {
      tips.push(
        `Spending is up ${chalk.red(`${pctChange.toFixed(0)}%`)} from last period. Review whether the increase reflects actual work or drift.`
      );
    }
  }

  if (writeReadRatio > 1) {
    tips.push(
      `Cache writes (${formatNumber(totalCacheWrite)}) exceed reads (${formatNumber(totalCacheRead)}). This means context is being written but evicted before reuse.`
    );
  }

  if (tips.length === 0) {
    tips.push("Looking good! Cache efficiency is solid and model mix is reasonable.");
  }

  for (const tip of tips.slice(0, 3)) {
    console.log(`  ${chalk.dim("\u2022")} ${tip}`);
  }
  console.log("");
}

// ---- JSON output ----

/** Build a JSON-serializable digest object for --json output. */
function buildDigestJSON(
  currentRecords: TokenRecord[],
  prevRecords: TokenRecord[],
  period: string,
  currentStart: Date,
  currentEnd: Date,
  projectFilter?: string
) {
  const totalCost = currentRecords.reduce((s, r) => s + r.cost, 0);
  const prevTotalCost = prevRecords.reduce((s, r) => s + r.cost, 0);
  const currentUsage = sumUsage(currentRecords);
  const cacheHitRate = currentUsage.cacheReadShare * 100;

  const modelMap = new Map<string, { tokens: number; cost: number; model: string }>();
  for (const r of currentRecords) {
    const existing = modelMap.get(r.model) || { tokens: 0, cost: 0, model: r.model };
    existing.tokens +=
      r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.reasoningTokens;
    existing.cost += r.cost;
    modelMap.set(r.model, existing);
  }

  const dailyMap = new Map<string, number>();
  for (const r of currentRecords) {
    const day = new Date(r.timestamp).toISOString().slice(0, 10);
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + r.cost);
  }
  const days = Math.max(dailyMap.size, 1);

  const projectMap = new Map<string, number>();
  for (const r of currentRecords) {
    projectMap.set(r.project, (projectMap.get(r.project) ?? 0) + r.cost);
  }

  return {
    period,
    dateRange: {
      start: currentStart.toISOString().slice(0, 10),
      end: new Date(currentEnd.getTime() - 86400000).toISOString().slice(0, 10),
    },
    project: projectFilter ?? null,
    summary: {
      totalCost,
      previousPeriodCost: prevTotalCost,
      changePercent: prevTotalCost > 0 ? ((totalCost - prevTotalCost) / prevTotalCost) * 100 : null,
      dailyAverage: totalCost / days,
      activeDays: dailyMap.size,
      totalRecords: currentRecords.length,
    },
    models: [...modelMap.values()]
      .sort((a, b) => b.cost - a.cost)
      .map((m) => ({
        model: m.model,
        tokens: m.tokens,
        cost: m.cost,
        percentOfTotal: totalCost > 0 ? (m.cost / totalCost) * 100 : 0,
      })),
    cache: {
      hitRate: cacheHitRate,
      canonicalHitRate: currentUsage.cacheHitRate * 100,
      readShare: currentUsage.cacheReadShare * 100,
      missRate: currentUsage.cacheMissRate * 100,
      freshInputShare: currentUsage.freshInputShare * 100,
      cacheWriteShare: currentUsage.cacheWriteShare * 100,
      readTokens: currentUsage.cacheReadTokens,
      writeTokens: currentUsage.cacheWriteTokens,
      freshInputTokens: currentUsage.freshInputTokens,
      totalInputTokens: currentUsage.totalInputTokens,
    },
    projects: [...projectMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, cost]) => ({ project: name, cost })),
  };
}

// ---- Public entry point ----

/**
 * Run the digest command.
 *
 * Scans session data for the current + previous period, then renders
 * a terminal report or JSON output depending on flags.
 */
export interface DigestArgs {
  period?: "today" | "week" | "month";
  project?: string;
  json?: boolean;
  light?: boolean;
  scanOptions?: ScanOptions;
}

export async function runDigest(opts: DigestArgs): Promise<void> {
  const period = opts.period ?? "week";
  const { currentStart, currentEnd, prevStart } = getDigestRanges(period);

  // Build scan options that cover both periods
  const core = new TokmeterCore({ skipPricing: opts.light });
  const scanOpts: ScanOptions = {
    ...opts.scanOptions,
    since: prevStart.toISOString(),
    until: currentEnd.toISOString(),
    // Clear period shortcuts so scan doesn't double-filter
    today: undefined,
    week: undefined,
    month: undefined,
  };
  const allRecords = await core.scan(scanOpts);

  // Split into current and previous windows
  let currentRecords = filterRecordsByRange(allRecords, currentStart, currentEnd);
  let prevRecords = filterRecordsByRange(allRecords, prevStart, currentStart);

  // Apply project filter if specified
  if (opts.project) {
    const pLower = opts.project.toLowerCase();
    currentRecords = currentRecords.filter((r) => r.project.toLowerCase().includes(pLower));
    prevRecords = prevRecords.filter((r) => r.project.toLowerCase().includes(pLower));
  }

  if (currentRecords.length === 0) {
    console.log(`No usage data found for the ${period} period.`);
    return;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        buildDigestJSON(
          currentRecords,
          prevRecords,
          period,
          currentStart,
          currentEnd,
          opts.project
        ),
        null,
        2
      )
    );
  } else {
    renderDigest(currentRecords, prevRecords, period, currentStart, currentEnd, opts.project);
  }
}
