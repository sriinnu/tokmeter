import type { LiveData } from "../../hooks/useLiveData.js";
import type {
  TokmeterDailyEntry,
  TokmeterData,
  TokmeterProjectSummary,
} from "../../hooks/useTokmeterData.js";
import { webTheme } from "../../theme.js";
import {
  formatDashboardCostPerMillion,
  formatDashboardCurrency,
  formatDashboardDate,
  formatDashboardNumber,
  formatDashboardPercent,
  formatDashboardTimestamp,
} from "./dashboardFormatters.js";

const TREND_WINDOW_DAYS = 30;
const SPARKLINE_WINDOW_DAYS = 14;
const MAX_TOP_PROJECTS = 6;
const MAX_TOP_MODELS = 8;
const MAX_RECENT_DAYS = 8;

export interface DashboardHeroMetric {
  label: string;
  value: string;
  note: string;
}

export interface DashboardSpotlight {
  eyebrow: string;
  title: string;
  body: string;
  chips: string[];
}

export interface DashboardKpi {
  label: string;
  value: string;
  helper: string;
  accent: string;
}

export interface DashboardProviderInsight {
  provider: string;
  cost: number;
  totalTokens: number;
  percentageOfTotal: number;
  modelCount: number;
  projectCount: number;
  costPerMillion: number | null;
}

export interface DashboardProjectInsight {
  project: string;
  totalCost: number;
  totalTokens: number;
  activeDays: number;
  lastUsed: number;
  modelCount: number;
  providerCount: number;
  recentCost: number;
  sparkline: number[];
}

export interface DashboardModelInsight {
  model: string;
  provider: string;
  cost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  reasoningTokens: number;
  percentageOfTotal: number;
}

export interface DashboardRecentDayInsight {
  date: string;
  totalTokens: number;
  cost: number;
  records: number;
  cacheTokens: number;
}

export interface DashboardActivityHighlight {
  label: string;
  value: string;
  helper: string;
}

export interface DashboardInsights {
  spotlight: DashboardSpotlight;
  heroMetrics: DashboardHeroMetric[];
  kpis: DashboardKpi[];
  activityHighlights: DashboardActivityHighlight[];
  providerInsights: DashboardProviderInsight[];
  topProjects: DashboardProjectInsight[];
  topModels: DashboardModelInsight[];
  todayModels: DashboardModelInsight[];
  recentDays: DashboardRecentDayInsight[];
  trendWindow: TokmeterDailyEntry[];
}

/**
 * Build the derived dashboard view-model from Tokmeter summary data and live daemon state.
 */
export function buildDashboardInsights(data: TokmeterData, liveData: LiveData): DashboardInsights {
  const { stats, daily, projects, models, records } = data;
  const cacheTokens = stats.cacheReadTokens + stats.cacheWriteTokens;
  const cacheShare = stats.totalTokens > 0 ? cacheTokens / stats.totalTokens : 0;
  const reasoningShare = stats.totalTokens > 0 ? stats.reasoningTokens / stats.totalTokens : 0;
  const costPerMillion =
    stats.totalTokens > 0 ? (stats.totalCost / stats.totalTokens) * 1_000_000 : null;

  const trendWindow = daily.slice(-TREND_WINDOW_DAYS);
  const recentWindow = trendWindow.length > 0 ? trendWindow : daily;
  const today = daily[daily.length - 1] ?? null;
  const peakDay = daily.reduce<TokmeterDailyEntry | null>((best, entry) => {
    if (!best || entry.cost > best.cost) {
      return entry;
    }

    return best;
  }, null);

  const providerInsights = aggregateProviderInsights(projects);
  const topProjects = [...projects]
    .sort((left, right) => right.totalCost - left.totalCost)
    .slice(0, MAX_TOP_PROJECTS)
    .map((project) => buildProjectInsight(project));

  const topModels = [...models]
    .sort((left, right) => right.cost - left.cost)
    .slice(0, MAX_TOP_MODELS)
    .map((model) => ({
      model: model.model,
      provider: model.provider,
      cost: model.cost,
      totalTokens: model.totalTokens,
      inputTokens: model.inputTokens,
      outputTokens: model.outputTokens,
      cacheTokens: model.cacheReadTokens + model.cacheWriteTokens,
      reasoningTokens: model.reasoningTokens,
      percentageOfTotal: model.percentageOfTotal,
    }));

  const todayModels = buildTodayModels(records, today?.date ?? null);

  const recentDays = [...daily]
    .slice(-MAX_RECENT_DAYS)
    .reverse()
    .map((entry) => ({
      date: entry.date,
      totalTokens: entry.totalTokens,
      cost: entry.cost,
      records: entry.records,
      cacheTokens: entry.cacheReadTokens + entry.cacheWriteTokens,
    }));

  const topProject = topProjects[0] ?? null;
  const topProvider = providerInsights[0] ?? null;
  const liveLabel =
    liveData.status === "connected"
      ? `${liveData.aggregated?.sessions ?? 0} live session${
          liveData.aggregated?.sessions === 1 ? "" : "s"
        }`
      : liveData.status === "connecting"
        ? "Daemon reconnecting"
        : "Daemon offline";

  const spotlight: DashboardSpotlight = {
    eyebrow: "Transparent command center",
    title:
      liveData.status === "connected"
        ? "Live sessions layered over stable history."
        : "Stable history, resilient fallback, clear spend lanes.",
    body: buildSpotlightBody({
      peakDay,
      topProject,
      topProvider,
      totalProjects: stats.projects,
      totalProviders: stats.providers,
      totalRecords: stats.totalRecords,
    }),
    chips: [
      `${stats.projects} projects`,
      `${stats.providers} providers`,
      `${formatDashboardPercent(cacheShare)} cache share`,
      liveLabel,
    ],
  };

  const heroMetrics: DashboardHeroMetric[] = [
    {
      label: "Records",
      value: formatDashboardNumber(stats.totalRecords),
      note: `${formatDashboardNumber(stats.models)} models tracked`,
    },
    {
      label: "Last activity",
      value: stats.lastUsed ? formatDashboardTimestamp(stats.lastUsed) : "Awaiting activity",
      note: stats.firstUsed
        ? `Since ${formatDashboardTimestamp(stats.firstUsed)}`
        : "First scan warming up",
    },
    {
      label: "Peak day",
      value: peakDay ? formatDashboardDate(peakDay.date) : "No peak yet",
      note: peakDay ? `${formatDashboardCurrency(peakDay.cost)} spent` : "Need more history",
    },
  ];

  const kpis: DashboardKpi[] = [
    {
      label: "Total cost",
      value: formatDashboardCurrency(stats.totalCost),
      helper: `${formatDashboardCurrency(getAverageDailyCost(daily))} / active day`,
      accent: webTheme.colors.olive,
    },
    {
      label: "Total tokens",
      value: formatDashboardNumber(stats.totalTokens),
      helper: `${formatDashboardNumber(stats.inputTokens)} in · ${formatDashboardNumber(
        stats.outputTokens
      )} out`,
      accent: webTheme.colors.cream,
    },
    {
      label: "Longest streak",
      value: `${stats.longestStreak}d`,
      helper: `${stats.activeDays} active days`,
      accent: webTheme.colors.teal,
    },
    {
      label: "Cache share",
      value: formatDashboardPercent(cacheShare),
      helper: `${formatDashboardNumber(cacheTokens)} cached tokens`,
      accent: webTheme.colors.rose,
    },
    {
      label: "Reasoning share",
      value: formatDashboardPercent(reasoningShare),
      helper: `${formatDashboardNumber(stats.reasoningTokens)} reasoning tokens`,
      accent: webTheme.colors.cream,
    },
    {
      label: "Cost / 1M tokens",
      value: formatDashboardCostPerMillion(costPerMillion),
      helper: "Useful for cross-model efficiency",
      accent: webTheme.colors.rose,
    },
    {
      label: "Projects",
      value: `${stats.projects}`,
      helper: topProject
        ? `${topProject.project} is currently leading`
        : "Waiting for project breakdown",
      accent: webTheme.colors.teal,
    },
    {
      label: "Today",
      value: today ? formatDashboardCurrency(today.cost) : "$0.00",
      helper: today
        ? `${formatDashboardNumber(today.totalTokens)} tokens today`
        : "No activity today yet",
      accent: webTheme.colors.olive,
    },
  ];

  const activityHighlights: DashboardActivityHighlight[] = [
    {
      label: "Window",
      value: `${recentWindow.length} days`,
      helper:
        recentWindow.length === TREND_WINDOW_DAYS ? "Latest rolling view" : "All available history",
    },
    {
      label: "Peak spend",
      value: peakDay ? formatDashboardCurrency(peakDay.cost) : "$0.00",
      helper: peakDay ? formatDashboardDate(peakDay.date) : "No peak yet",
    },
    {
      label: "Recent tokens",
      value: formatDashboardNumber(recentWindow.reduce((sum, entry) => sum + entry.totalTokens, 0)),
      helper: `${formatDashboardNumber(
        recentWindow.reduce((sum, entry) => sum + entry.records, 0)
      )} records in window`,
    },
    {
      label: "Today state",
      value: liveLabel,
      helper: today
        ? `${formatDashboardPercent(
            today.totalTokens > 0
              ? (today.cacheReadTokens + today.cacheWriteTokens) / today.totalTokens
              : 0
          )} cached today`
        : "Live overlay pending",
    },
  ];

  return {
    spotlight,
    heroMetrics,
    kpis,
    activityHighlights,
    providerInsights,
    topProjects,
    topModels,
    todayModels,
    recentDays,
    trendWindow,
  };
}

function aggregateProviderInsights(projects: TokmeterProjectSummary[]): DashboardProviderInsight[] {
  const providerMap = new Map<
    string,
    {
      cost: number;
      totalTokens: number;
      projects: Set<string>;
      models: Set<string>;
    }
  >();

  for (const project of projects) {
    for (const provider of project.providers) {
      const current = providerMap.get(provider.provider) ?? {
        cost: 0,
        totalTokens: 0,
        projects: new Set<string>(),
        models: new Set<string>(),
      };

      current.cost += provider.cost;
      current.totalTokens += provider.totalTokens;
      current.projects.add(project.project);

      for (const model of provider.models) {
        current.models.add(model);
      }

      providerMap.set(provider.provider, current);
    }
  }

  const totalProviderCost = [...providerMap.values()].reduce(
    (sum, provider) => sum + provider.cost,
    0
  );

  return [...providerMap.entries()]
    .map(([provider, value]) => ({
      provider,
      cost: value.cost,
      totalTokens: value.totalTokens,
      percentageOfTotal: totalProviderCost > 0 ? (value.cost / totalProviderCost) * 100 : 0,
      modelCount: value.models.size,
      projectCount: value.projects.size,
      costPerMillion: value.totalTokens > 0 ? (value.cost / value.totalTokens) * 1_000_000 : null,
    }))
    .sort((left, right) => right.cost - left.cost);
}

function buildProjectInsight(project: TokmeterProjectSummary): DashboardProjectInsight {
  const recentBreakdown = project.dailyBreakdown.slice(-SPARKLINE_WINDOW_DAYS);

  return {
    project: project.project,
    totalCost: project.totalCost,
    totalTokens: project.totalTokens,
    activeDays: project.activeDays,
    lastUsed: project.lastUsed,
    modelCount: project.models.length,
    providerCount: project.providers.length,
    recentCost: recentBreakdown.reduce((sum, entry) => sum + entry.cost, 0),
    sparkline: recentBreakdown.map((entry) => entry.cost || entry.totalTokens),
  };
}

function buildSpotlightBody({
  peakDay,
  topProject,
  topProvider,
  totalProjects,
  totalProviders,
  totalRecords,
}: {
  peakDay: TokmeterDailyEntry | null;
  topProject: DashboardProjectInsight | null;
  topProvider: DashboardProviderInsight | null;
  totalProjects: number;
  totalProviders: number;
  totalRecords: number;
}): string {
  const fragments = [
    `${formatDashboardNumber(totalRecords)} records span ${totalProjects} projects across ${totalProviders} providers.`,
  ];

  if (topProject) {
    fragments.push(
      `${topProject.project} currently leads spend at ${formatDashboardCurrency(
        topProject.totalCost
      )}.`
    );
  }

  if (topProvider) {
    fragments.push(
      `${topProvider.provider} owns the widest lane at ${formatDashboardPercent(
        topProvider.percentageOfTotal / 100
      )} of tracked spend.`
    );
  }

  if (peakDay) {
    fragments.push(`${formatDashboardDate(peakDay.date)} stands out as the busiest day so far.`);
  }

  return fragments.join(" ");
}

function getAverageDailyCost(daily: TokmeterDailyEntry[]): number {
  if (daily.length === 0) {
    return 0;
  }

  return daily.reduce((sum, entry) => sum + entry.cost, 0) / daily.length;
}

interface RawRecord {
  timestamp: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cost: number;
}

function rawLocalDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildTodayModels(
  rawRecords: Array<Record<string, unknown>>,
  todayDate: string | null
): DashboardModelInsight[] {
  if (!todayDate) return [];

  type Acc = {
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    reasoningTokens: number;
    cost: number;
  };

  const byKey = new Map<string, Acc>();

  for (const raw of rawRecords) {
    const r = raw as unknown as RawRecord;
    if (rawLocalDateKey(r.timestamp) !== todayDate) continue;

    const key = `${r.provider}::${r.model}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.cost += r.cost;
      cur.inputTokens += r.inputTokens ?? 0;
      cur.outputTokens += r.outputTokens ?? 0;
      cur.cacheTokens += (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
      cur.reasoningTokens += r.reasoningTokens ?? 0;
    } else {
      byKey.set(key, {
        model: r.model,
        provider: r.provider,
        cost: r.cost ?? 0,
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        cacheTokens: (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0),
        reasoningTokens: r.reasoningTokens ?? 0,
      });
    }
  }

  const todayTotal = [...byKey.values()].reduce((s, m) => s + m.cost, 0);

  return [...byKey.values()]
    .sort((a, b) => b.cost - a.cost)
    .map((m) => ({
      model: m.model,
      provider: m.provider,
      cost: m.cost,
      totalTokens: m.inputTokens + m.outputTokens + m.cacheTokens + m.reasoningTokens,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheTokens: m.cacheTokens,
      reasoningTokens: m.reasoningTokens,
      percentageOfTotal: todayTotal > 0 ? (m.cost / todayTotal) * 100 : 0,
    }));
}
