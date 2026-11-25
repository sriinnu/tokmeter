/**
 * Scoped HTTP route parsing and query execution for daemon read endpoints.
 */

import {
  ALL_PROVIDER_IDS,
  type ProviderId,
  type ScanOptions,
  type ScanWarning,
  type TokmeterCore,
  type TokmeterSummary,
} from "@sriinnu/tokmeter";
import {
  computeScopedView,
  type ScopeParams,
  serializeScopedView,
  unpricedOf,
} from "../scoped-view.js";

export const SUMMARY_SOURCE_HEADER = "X-Tokmeter-Summary-Source";

const MAX_PROVIDERS = 32;
const MAX_PROVIDER_LEN = 64;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

let _validProviderIds: Set<string> | null = null;
function getValidProviderIds(): Set<string> {
  if (!_validProviderIds) {
    _validProviderIds = new Set<string>(ALL_PROVIDER_IDS);
  }
  return _validProviderIds;
}

function parseBoolParam(raw: string | null): boolean | undefined | "invalid" {
  if (raw === null) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0" || raw === "") return false;
  return "invalid";
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function appendSummaryWarnings(
  summary: TokmeterSummary,
  warnings: ScanWarning[],
  todayState: TokmeterSummary["meta"]["todayState"]
): TokmeterSummary {
  return {
    ...summary,
    meta: {
      ...summary.meta,
      todayState,
      warnings: [...summary.meta.warnings, ...warnings],
    },
  };
}

/**
 * Parse scoped query parameters for daemon read endpoints (`/api/summary`,
 * `/api/stats`, `/api/daily`, `/api/models`, `/api/projects`, `/api/providers`,
 * `/api/scoped-view`). Validates providers against `ALL_PROVIDER_IDS` and numeric
 * year bounds cleanly so invalid inputs return HTTP 400.
 */
export function parseDaemonScopeQuery(url: string): {
  options: ScanOptions;
  hasScope: boolean;
  error?: string;
} {
  const qi = url.indexOf("?");
  if (qi < 0) return { options: {}, hasScope: false };
  const params = new URLSearchParams(url.slice(qi + 1));
  const options: ScanOptions = {};

  const rawProviders = params.get("providers") ?? params.get("provider");
  if (rawProviders !== null && rawProviders.trim() !== "") {
    const seen = new Set<string>();
    const list: ProviderId[] = [];
    for (const part of rawProviders.split(",")) {
      const s = part.trim();
      if (!s) continue;
      if (
        s.length > MAX_PROVIDER_LEN ||
        !PROVIDER_PATTERN.test(s) ||
        !getValidProviderIds().has(s)
      ) {
        return { options: {}, hasScope: true, error: `Unknown provider "${s}".` };
      }
      if (seen.has(s)) continue;
      seen.add(s);
      list.push(s as ProviderId);
      if (list.length > MAX_PROVIDERS) {
        return { options: {}, hasScope: true, error: "Too many providers in query." };
      }
    }
    if (list.length > 0) options.providers = list;
  }

  const project = params.get("project")?.trim();
  if (project) {
    if (project.length > 512) {
      return { options: {}, hasScope: true, error: "project filter is too long." };
    }
    options.project = project;
  }

  const since = params.get("since")?.trim();
  if (since) options.since = since;
  const until = params.get("until")?.trim();
  if (until) options.until = until;

  const scope = params.get("scope")?.trim();
  if (scope) {
    if (scope === "today") options.today = true;
    else if (scope === "week") options.week = true;
    else if (scope === "month") options.month = true;
    else if (scope !== "all") {
      return {
        options: {},
        hasScope: true,
        error: `Invalid scope "${scope}". Expected today, week, month, or all.`,
      };
    }
  }

  for (const flag of ["today", "week", "month"] as const) {
    const parsedFlag = parseBoolParam(params.get(flag));
    if (parsedFlag === "invalid") {
      return { options: {}, hasScope: true, error: `${flag} must be true or false.` };
    }
    if (parsedFlag === true) options[flag] = true;
  }

  if (params.has("year")) {
    const rawYear = (params.get("year") ?? "").trim();
    if (!/^\d{4}$/.test(rawYear)) {
      return { options: {}, hasScope: true, error: "year must be a four-digit calendar year." };
    }
    const year = Number(rawYear);
    if (!Number.isInteger(year) || year < 1000 || year > 9999) {
      return { options: {}, hasScope: true, error: "year must be a four-digit calendar year." };
    }
    options.year = year;
  }

  const hasScope = Boolean(
    options.providers?.length ||
      options.project ||
      options.since ||
      options.until ||
      options.today ||
      options.week ||
      options.month ||
      options.year !== undefined
  );
  return { options, hasScope };
}

function toScopeParams(options: ScanOptions): ScopeParams {
  return {
    scope: options.today
      ? "today"
      : options.week
        ? "week"
        : options.month
          ? "month"
          : options.year !== undefined
            ? undefined
            : "all",
    since: options.year !== undefined ? `${options.year}-01-01` : options.since,
    until: options.year !== undefined ? `${options.year}-12-31` : options.until,
    project: options.project,
    providers: options.providers,
  };
}

export interface ScopedRouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Shared scoped HTTP route handler for both the live daemon HTTP API and
 * ephemeral test servers. Returns `null` when the request has no scoping params
 * (for routes other than `/api/scoped-view`) so the live server's legacy
 * floored/cached fast paths continue uninterrupted.
 */
export function executeScopedRoute(
  pathname: string,
  url: string,
  core: TokmeterCore,
  scanDurationMs = 0
): ScopedRouteResult | null {
  const isScopedView = pathname === "/api/scoped-view";
  const isScopedRoute =
    isScopedView ||
    pathname === "/api/summary" ||
    pathname === "/api/stats" ||
    pathname === "/api/daily" ||
    pathname === "/api/models" ||
    pathname === "/api/projects" ||
    pathname === "/api/providers";
  if (!isScopedRoute) return null;

  const parsed = parseDaemonScopeQuery(url);
  if (parsed.error) {
    return { status: 400, body: { error: parsed.error } };
  }
  if (!isScopedView && !parsed.hasScope) {
    return null;
  }

  try {
    const records = core.getRecentRecords();
    const meta = {
      recordCount: records.length,
      ...unpricedOf(records),
      scanDurationMs,
    };

    if (isScopedView) {
      // Validate explicit date/year bounds using core.getSummary first so malformed dates fail 400.
      if (parsed.hasScope) core.getSummary(parsed.options);
      const view = computeScopedView(core, records, meta, toScopeParams(parsed.options));
      return { status: 200, body: serializeScopedView(view) };
    }

    const summary = core.getSummary(parsed.options);
    if (pathname === "/api/summary") {
      return {
        status: 200,
        body: summary,
        headers: { [SUMMARY_SOURCE_HEADER]: "live" },
      };
    }
    if (pathname === "/api/stats") return { status: 200, body: summary.stats };
    if (pathname === "/api/daily") return { status: 200, body: summary.daily };
    if (pathname === "/api/models") return { status: 200, body: summary.models };
    if (pathname === "/api/projects") return { status: 200, body: summary.projects };
    if (pathname === "/api/providers") {
      const view = computeScopedView(core, records, meta, toScopeParams(parsed.options));
      return { status: 200, body: view.providers };
    }
    return null;
  } catch (err) {
    return { status: 400, body: { error: toErrorMessage(err) } };
  }
}
