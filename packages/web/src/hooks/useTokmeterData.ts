/**
 * Data loading hook for the web app.
 *
 * In production, this reads from a JSON file exported by `tokmeter --json`
 * or fetches from the local server API.
 * For development, loads from /data.json.
 */

import { useState, useEffect } from "react";

/** Matches the shape of TokmeterCore.toJSON() output. */
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

export interface TokmeterData {
  records: { [key: string]: unknown }[];
  projects: TokmeterProjectSummary[];
  models: TokmeterModelSummary[];
  daily: TokmeterDailyEntry[];
  stats: TokmeterStats;
}

export function useTokmeterData(): { data: TokmeterData | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<TokmeterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    fetch("/data.json", { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: TokmeterData) => {
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return { data, loading, error };
}
