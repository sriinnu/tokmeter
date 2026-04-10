/**
 * Data loading hook for the web app.
 *
 * Prefers a live summary endpoint when available, falls back to the static
 * JSON export, and keeps rendering the last good payload if a background
 * refresh fails.
 */

import { useEffect, useState } from "react";

const SUMMARY_ENDPOINTS = ["/api/summary", "/data.json"] as const;
const DEFAULT_REFRESH_MS = 15_000;
const SUMMARY_SOURCE_HEADER = "X-Tokmeter-Summary-Source";

export interface TokmeterStats {
  totalTokens: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalRecords: number;
  projects: number;
  models: number;
  providers: number;
  activeDays: number;
  longestStreak: number;
  firstUsed: number;
  lastUsed: number;
}

export interface TokmeterDailyEntry {
  date: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cost: number;
  records: number;
}

export interface TokmeterModelSummary {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  percentageOfTotal: number;
}

export interface TokmeterProviderSummary {
  provider: string;
  totalTokens: number;
  cost: number;
  models: string[];
  percentageOfTotal: number;
}

export interface TokmeterProjectSummary {
  project: string;
  totalTokens: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  models: TokmeterModelSummary[];
  providers: TokmeterProviderSummary[];
  dailyBreakdown: TokmeterDailyEntry[];
  activeDays: number;
  firstUsed: number;
  lastUsed: number;
}

export interface TokmeterScanWarning {
  scope: "history" | "today" | "provider" | "cache";
  provider?: string;
  message: string;
}

export interface TokmeterScanMeta {
  stableThrough: string | null;
  historySource: "snapshot" | "rebuilt" | "none";
  todayState: "live" | "degraded" | "snapshot-only";
  lastScanAt: number;
  warnings: TokmeterScanWarning[];
}

export interface TokmeterData {
  records: Array<Record<string, unknown>>;
  projects: TokmeterProjectSummary[];
  models: TokmeterModelSummary[];
  daily: TokmeterDailyEntry[];
  stats: TokmeterStats;
  meta: TokmeterScanMeta;
}

export type TokmeterSummarySource = "live-api" | "cached-api" | "static-cache" | "memory-cache";

let cachedData: TokmeterData | null = null;
let cachedLoadedAt: number | null = null;
let cachedSource: TokmeterSummarySource | null = null;
let inflightRequest: Promise<{ data: TokmeterData; source: TokmeterSummarySource }> | null = null;

const DEFAULT_META: TokmeterScanMeta = {
  stableThrough: null,
  historySource: "none",
  todayState: "snapshot-only",
  lastScanAt: 0,
  warnings: [],
};

export function useTokmeterData(): {
  data: TokmeterData | null;
  loading: boolean;
  error: string | null;
  warning: string | null;
  lastLoadedAt: number | null;
  source: TokmeterSummarySource | null;
} {
  const [data, setData] = useState<TokmeterData | null>(cachedData);
  const [loading, setLoading] = useState(cachedData === null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(summarizeWarnings(cachedData?.meta));
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(cachedLoadedAt);
  const [source, setSource] = useState<TokmeterSummarySource | null>(cachedSource);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function loadData(isBackgroundRefresh: boolean): Promise<void> {
      if (!isBackgroundRefresh && cachedData === null) {
        setLoading(true);
      }

      try {
        const { data: nextData, source: nextSource } = await fetchTokmeterData(controller.signal);
        const loadedAt = Date.now();

        cachedData = nextData;
        cachedLoadedAt = loadedAt;
        cachedSource = nextSource;

        if (!cancelled) {
          setData(nextData);
          setError(null);
          setWarning(summarizeWarnings(nextData.meta));
          setLastLoadedAt(loadedAt);
          setSource(nextSource);
          setLoading(false);
        }
      } catch (fetchError) {
        const message = toErrorMessage(fetchError);

        if (!cancelled) {
          if (cachedData) {
            setData(cachedData);
            setError(null);
            setWarning(
              `Refresh failed — showing last good ${getSummarySourceLabel(cachedSource ?? "memory-cache").toLowerCase()} (${message}).`
            );
            setLastLoadedAt(cachedLoadedAt);
            setSource(cachedSource ?? "memory-cache");
          } else {
            setError(message);
          }
          setLoading(false);
        }
      }
    }

    void loadData(false);

    const refreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadData(true);
      }
    }, DEFAULT_REFRESH_MS);

    const refreshOnVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void loadData(true);
      }
    };

    document.addEventListener("visibilitychange", refreshOnVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", refreshOnVisibilityChange);
      controller.abort();
    };
  }, []);

  return { data, loading, error, warning, lastLoadedAt, source };
}

async function fetchTokmeterData(
  signal: AbortSignal
): Promise<{ data: TokmeterData; source: TokmeterSummarySource }> {
  if (inflightRequest) {
    return inflightRequest;
  }

  inflightRequest = (async () => {
    const errors: string[] = [];

    for (const endpoint of SUMMARY_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          signal,
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(`${endpoint} returned HTTP ${response.status}`);
        }

        const json = await readJsonResponse(endpoint, response);
        return {
          data: normalizeTokmeterData(json),
          source: detectSummarySource(endpoint, response),
        };
      } catch (fetchError) {
        errors.push(toErrorMessage(fetchError));
      }
    }

    throw new Error(errors.join(" | "));
  })();

  try {
    return await inflightRequest;
  } finally {
    inflightRequest = null;
  }
}

async function readJsonResponse(
  endpoint: string,
  response: Response
): Promise<Partial<TokmeterData>> {
  const body = await response.text();
  const trimmed = body.trim();
  const contentType = response.headers.get("content-type") ?? "";

  if (!trimmed) {
    throw new Error(`${endpoint} returned an empty response`);
  }

  if (
    contentType.includes("text/html") ||
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<html")
  ) {
    throw new Error(`${endpoint} returned HTML instead of JSON`);
  }

  try {
    return JSON.parse(body) as Partial<TokmeterData>;
  } catch (error) {
    throw new Error(`${endpoint} returned invalid JSON (${toErrorMessage(error)})`);
  }
}

function detectSummarySource(endpoint: string, response: Response): TokmeterSummarySource {
  if (endpoint === "/data.json") {
    return "static-cache";
  }

  return response.headers.get(SUMMARY_SOURCE_HEADER) === "cache" ? "cached-api" : "live-api";
}

function normalizeTokmeterData(input: Partial<TokmeterData>): TokmeterData {
  return {
    records: Array.isArray(input.records) ? input.records : [],
    projects: Array.isArray(input.projects)
      ? input.projects.map((project) => normalizeProjectSummary(project))
      : [],
    models: Array.isArray(input.models) ? input.models.map((model) => normalizeModel(model)) : [],
    daily: Array.isArray(input.daily) ? input.daily.map((entry) => normalizeDailyEntry(entry)) : [],
    stats: normalizeStats(input.stats),
    meta: normalizeMeta(input.meta),
  };
}

function normalizeStats(stats: Partial<TokmeterStats> | undefined): TokmeterStats {
  return {
    totalTokens: stats?.totalTokens ?? 0,
    totalCost: stats?.totalCost ?? 0,
    inputTokens: stats?.inputTokens ?? 0,
    outputTokens: stats?.outputTokens ?? 0,
    cacheReadTokens: stats?.cacheReadTokens ?? 0,
    cacheWriteTokens: stats?.cacheWriteTokens ?? 0,
    reasoningTokens: stats?.reasoningTokens ?? 0,
    totalRecords: stats?.totalRecords ?? 0,
    projects: stats?.projects ?? 0,
    models: stats?.models ?? 0,
    providers: stats?.providers ?? 0,
    activeDays: stats?.activeDays ?? 0,
    longestStreak: stats?.longestStreak ?? 0,
    firstUsed: stats?.firstUsed ?? 0,
    lastUsed: stats?.lastUsed ?? 0,
  };
}

function normalizeModel(model: Partial<TokmeterModelSummary>): TokmeterModelSummary {
  return {
    model: model.model ?? "Unknown model",
    provider: model.provider ?? "unknown",
    inputTokens: model.inputTokens ?? 0,
    outputTokens: model.outputTokens ?? 0,
    cacheReadTokens: model.cacheReadTokens ?? 0,
    cacheWriteTokens: model.cacheWriteTokens ?? 0,
    reasoningTokens: model.reasoningTokens ?? 0,
    totalTokens: model.totalTokens ?? 0,
    cost: model.cost ?? 0,
    percentageOfTotal: model.percentageOfTotal ?? 0,
  };
}

function normalizeProvider(provider: Partial<TokmeterProviderSummary>): TokmeterProviderSummary {
  return {
    provider: provider.provider ?? "unknown",
    totalTokens: provider.totalTokens ?? 0,
    cost: provider.cost ?? 0,
    models: Array.isArray(provider.models) ? provider.models : [],
    percentageOfTotal: provider.percentageOfTotal ?? 0,
  };
}

function normalizeDailyEntry(entry: Partial<TokmeterDailyEntry>): TokmeterDailyEntry {
  return {
    date: entry.date ?? "unknown",
    totalTokens: entry.totalTokens ?? 0,
    inputTokens: entry.inputTokens ?? 0,
    outputTokens: entry.outputTokens ?? 0,
    cacheReadTokens: entry.cacheReadTokens ?? 0,
    cacheWriteTokens: entry.cacheWriteTokens ?? 0,
    reasoningTokens: entry.reasoningTokens ?? 0,
    cost: entry.cost ?? 0,
    records: entry.records ?? 0,
  };
}

function normalizeProjectSummary(project: Partial<TokmeterProjectSummary>): TokmeterProjectSummary {
  return {
    project: project.project ?? "Unknown project",
    totalTokens: project.totalTokens ?? 0,
    totalCost: project.totalCost ?? 0,
    inputTokens: project.inputTokens ?? 0,
    outputTokens: project.outputTokens ?? 0,
    cacheReadTokens: project.cacheReadTokens ?? 0,
    cacheWriteTokens: project.cacheWriteTokens ?? 0,
    reasoningTokens: project.reasoningTokens ?? 0,
    models: Array.isArray(project.models)
      ? project.models.map((model) => normalizeModel(model))
      : [],
    providers: Array.isArray(project.providers)
      ? project.providers.map((provider) => normalizeProvider(provider))
      : [],
    dailyBreakdown: Array.isArray(project.dailyBreakdown)
      ? project.dailyBreakdown.map((entry) => normalizeDailyEntry(entry))
      : [],
    activeDays: project.activeDays ?? 0,
    firstUsed: project.firstUsed ?? 0,
    lastUsed: project.lastUsed ?? 0,
  };
}

function normalizeMeta(meta: Partial<TokmeterScanMeta> | undefined): TokmeterScanMeta {
  return {
    stableThrough: meta?.stableThrough ?? DEFAULT_META.stableThrough,
    historySource: meta?.historySource ?? DEFAULT_META.historySource,
    todayState: meta?.todayState ?? DEFAULT_META.todayState,
    lastScanAt: meta?.lastScanAt ?? DEFAULT_META.lastScanAt,
    warnings: Array.isArray(meta?.warnings)
      ? meta.warnings.map((warning) => ({
          scope: warning.scope ?? "cache",
          provider: warning.provider,
          message: warning.message ?? "Unknown warning",
        }))
      : DEFAULT_META.warnings,
  };
}

function summarizeWarnings(meta: TokmeterScanMeta | undefined): string | null {
  if (!meta || meta.warnings.length === 0) {
    return null;
  }

  return meta.warnings.map((warning) => warning.message).join(" · ");
}

function getSummarySourceLabel(source: TokmeterSummarySource): string {
  switch (source) {
    case "live-api":
      return "live summary";
    case "cached-api":
      return "persisted cache";
    case "static-cache":
      return "static cache file";
    default:
      return "in-memory cache";
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Request aborted";
  }

  return error instanceof Error ? error.message : String(error);
}
