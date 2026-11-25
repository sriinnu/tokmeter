/**
 * @sriinnu/tokmeter-core — User config service.
 *
 * Lives at ~/.tokmeter/config.json alongside aliases.json. Holds the small
 * set of knobs a user actually reaches for — refresh cadence, CLI defaults,
 * alert thresholds — not every tuneable constant in the codebase.
 *
 * v1 schema (kept deliberately small):
 *
 *   {
 *     "version": 1,
 *     "bar":    { "refreshSeconds": 30 },
 *     "daemon": { "scanIntervalSeconds": 60 },
 *     "cli":    { "defaultRange": "all", "defaultSort": "cost" },
 *     "alerts": { "dailyCostThreshold": null },
 *     "modifiedBy": "user",
 *     "modifiedAt": "2026-04-24T18:00:00Z"
 *   }
 *
 * Missing fields are filled from DEFAULT_CONFIG on load — so old files stay
 * valid when the schema grows. A malformed JSON file is moved aside to
 * `config.json.bak-<ISO>` and defaults are used; the user's edits aren't
 * silently overwritten.
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensurePrivateDirectory, ensurePrivateFile, writePrivateFile } from "./private-files.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type DefaultRange = "all" | "today" | "week" | "month" | "year";
export type DefaultSort = "cost" | "tokens" | "activeDays";
export type MenubarColorSource = "off" | "context" | "block" | "budget";
const MENUBAR_COLOR_SOURCES: readonly MenubarColorSource[] = ["off", "context", "block", "budget"];
export type WeekChartStyle = "line" | "bars" | "area";
const WEEK_CHART_STYLES: readonly WeekChartStyle[] = ["line", "bars", "area"];
export const BUILT_IN_THEME_IDS = [
  "default",
  "tokyo-night",
  "catppuccin",
  "dracula",
  "solarized-dark",
  "light",
  "solarized-light",
  "high-contrast",
] as const;

export const STATUSLINE_STYLES = ["rams", "deck", "pill", "meter", "ledger"] as const;
export type StatuslineStyle = (typeof STATUSLINE_STYLES)[number];

export const STATUSLINE_DENSITIES = ["compact", "balanced", "telemetry"] as const;
export type StatuslineDensity = (typeof STATUSLINE_DENSITIES)[number];

export interface StatuslineShowConfig {
  git: boolean;
  pr: boolean;
  cache: boolean;
  windows: boolean;
  today: boolean;
  repo: boolean;
  pace: boolean;
  liveSessions: boolean;
  subagents: boolean;
  linesDelta: boolean;
}

export interface StatuslineConfig {
  style: StatuslineStyle;
  density: StatuslineDensity;
  theme: string | null;
  nerdFont: boolean | null;
  show: StatuslineShowConfig;
}

/** Formats a custom source's files can be written in. */
export type CustomSourceFormat = "tokmeter-usage-jsonl";

/** A user-registered agent whose session files tokmeter should also read. */
export interface CustomSource {
  /** Directory to scan (recursively) for session files. `~` is expanded. */
  path: string;
  /** How the files are encoded. Only the canonical usage-line format for now. */
  format: CustomSourceFormat;
  /**
   * Provider id to tag these records with. One of the custom-eligible ids
   * ("ribhu", "chitragupta", "grok", "custom"); anything else falls back to
   * "custom".
   */
  provider?: string;
  /** Human label for the UI (e.g. "Takumi"). Cosmetic. */
  label?: string;
  /** Set false to keep the entry but stop scanning it. Defaults to true. */
  enabled?: boolean;
}

export interface UserConfig {
  version: 1;
  /** Color theme id shared across CLI/statusline/TUI. */
  theme: string;
  /** Enable Nerd Font glyphs in statusline/TUI when true. */
  nerdFont: boolean;
  bar: {
    /** Seconds between bar fetches from the daemon. */
    refreshSeconds: number;
    /**
     * Which live signal tints the menubar (green→yellow→orange→red):
     *   - "context": worst live context-window fill across sessions (needs a
     *     provider that reports one; falls back to neutral when none do).
     *   - "block": Anthropic 5-hour billing-block usage.
     *   - "budget": today's cost vs `alerts.dailyCostThreshold` (universal).
     *   - "off": no coloring.
     */
    menubarColorSource: MenubarColorSource;
    /** Rendering style for the popover's LAST 7 DAYS chart (Swift mirrors
     *  this in HubConfigStore.WeekChartStyle — keep raw values identical). */
    weekChartStyle: WeekChartStyle;
    /** Preferred port for the bar's bundled web dashboard. If another
     *  server holds it, the bar moves to the next free port. */
    dashboardPort: number;
  };
  daemon: {
    /** Advisory: seconds between full rescans inside the daemon. */
    scanIntervalSeconds: number;
    /**
     * Off by default, deliberately. When on, the daemon polls Antigravity's
     * running language_server on a timer to read live credit/model status —
     * which means reading a CSRF token out of that process's own command
     * line and calling an undocumented internal RPC endpoint with it (the
     * same technique the community "antigravity-panel" extension uses, but
     * still an internal channel Antigravity didn't publish for this). That's
     * a real enough thing to automate indefinitely in the background that it
     * shouldn't turn on from an in-conversation "yes" alone — flip this
     * explicitly once you've decided you want it standing.
     */
    antigravityLivePolling: boolean;
    /**
     * On by default. Cursor 3.11+ keeps no token counts on disk, so the
     * daemon keeps tokmeter's Cursor stop hook installed (see
     * ensureCursorHook). Set false to stop it; `tokmeter cursor-hook
     * uninstall` also opts out for good.
     */
    cursorHook: boolean;
  };
  cli: {
    /** Default time window when no --today/--week/... flag is passed. */
    defaultRange: DefaultRange;
    /** Default sort column for tables that support multiple orderings. */
    defaultSort: DefaultSort;
  };
  alerts: {
    /** USD/day that triggers an alert. `null` disables alerting. */
    dailyCostThreshold: number | null;
  };
  /** Statusline appearance, density, and section toggles. */
  statusline: StatuslineConfig;
  /**
   * Extra search roots per provider, keyed by ProviderId (e.g. "cursor",
   * "antigravity"). Most parsers already probe several likely locations on
   * their own (platform variants, app-name variants like "Code" vs "Code -
   * Insiders") — this is the escape hatch for the rest: a non-standard
   * install, an unreleased app rename, a portable/XDG-override install.
   * Not every parser reads this yet; only ones built around
   * vscodeFamilyUserDirs do. Not a fix for a provider storing data in a
   * structurally different location than what that parser expects — that
   * needs new parsing logic, not a new search path. Edit config.json by
   * hand to set this; no CLI verb for it yet.
   */
  providerPaths: Record<string, string[]>;
  /**
   * User-registered extra agents that tokmeter has no built-in parser for.
   * Each points at a directory of session files written in the canonical
   * usage-line format (see CustomSourceParser) — one JSON object per API
   * response. This is the "enter a path and tokmeter picks it up" hatch: an
   * agent you build (Takumi), a tool we don't ship a parser for yet (Grok), or
   * anything that can emit the contract. A `backfill` then folds the last N
   * days of that source into the relay via the normal grow-only deep rescan.
   */
  customSources: CustomSource[];
  /** Who last wrote the file. Restore merges prefer user-flagged sides. */
  modifiedBy: "user" | "tokmeter";
  /** ISO timestamp of the last write. */
  modifiedAt: string;
}

/**
 * Baseline config. `loadConfig` overlays the user's file on top of this, so
 * any missing knob gets its default and no caller ever sees `undefined`.
 */
export const DEFAULT_CONFIG: UserConfig = {
  version: 1,
  theme: "default",
  nerdFont: false,
  bar: {
    refreshSeconds: 30,
    menubarColorSource: "context",
    weekChartStyle: "line",
    dashboardPort: 8888,
  },
  daemon: { scanIntervalSeconds: 60, antigravityLivePolling: false, cursorHook: true },
  cli: { defaultRange: "all", defaultSort: "cost" },
  alerts: { dailyCostThreshold: null },
  statusline: {
    style: "rams",
    density: "balanced",
    theme: null,
    nerdFont: null,
    show: {
      git: true,
      pr: true,
      cache: true,
      windows: true,
      today: true,
      repo: true,
      pace: true,
      liveSessions: true,
      subagents: true,
      linesDelta: true,
    },
  },
  providerPaths: {},
  customSources: [],
  modifiedBy: "tokmeter",
  modifiedAt: new Date(0).toISOString(),
};

// ─── Paths ─────────────────────────────────────────────────────────────────

/**
 * Config file path. Sibling to aliases.json under ~/.tokmeter/ so both ride
 * along in every snapshot and survive cache wipes.
 */
export function configFilePath(home: string = homedir()): string {
  return join(home, ".tokmeter", "config.json");
}

// ─── Load / Save ───────────────────────────────────────────────────────────

/**
 * Load config, overlaying on DEFAULT_CONFIG. Missing or malformed files are
 * tolerated — the user gets defaults and a .bak copy if the file was junk.
 */
function readLegacyThemeConfig(home: string): { theme?: string; nerdFont?: boolean } | null {
  const legacyPath = join(home, ".config", "tokmeter", "config.json");
  if (!existsSync(legacyPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(legacyPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    return {
      ...(typeof obj.theme === "string" ? { theme: obj.theme } : {}),
      ...(typeof obj.nerdFont === "boolean" ? { nerdFont: obj.nerdFont } : {}),
    };
  } catch {
    return null;
  }
}

export function loadConfig(home: string = homedir()): UserConfig {
  const path = configFilePath(home);
  ensurePrivateDirectory(dirname(path));
  ensurePrivateFile(path);
  const legacy = readLegacyThemeConfig(home);
  if (!existsSync(path)) {
    return legacy ? normalizeConfig(legacy as Partial<UserConfig>) : { ...DEFAULT_CONFIG };
  }

  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    backupBrokenConfigFile(path, `JSON parse error: ${(err as Error).message}`);
    return legacy ? normalizeConfig(legacy as Partial<UserConfig>) : { ...DEFAULT_CONFIG };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    backupBrokenConfigFile(path, "root is not an object");
    return legacy ? normalizeConfig(legacy as Partial<UserConfig>) : { ...DEFAULT_CONFIG };
  }

  const rawObj = parsed as Partial<UserConfig>;
  const merged: Partial<UserConfig> = legacy
    ? {
        ...rawObj,
        ...(rawObj.theme === undefined && legacy.theme !== undefined
          ? { theme: legacy.theme }
          : {}),
        ...(rawObj.nerdFont === undefined && legacy.nerdFont !== undefined
          ? { nerdFont: legacy.nerdFont }
          : {}),
      }
    : rawObj;
  return normalizeConfig(merged);
}

/** Atomic write — tmp + rename. Safe against power loss and concurrent CLIs. */
export function saveConfig(config: UserConfig, home: string = homedir()): void {
  const path = configFilePath(home);
  writePrivateFile(path, JSON.stringify(config, null, 2));
}

function backupBrokenConfigFile(path: string, reason: string): void {
  const backupPath = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    copyFileSync(path, backupPath);
    console.error(
      `⚠  tokmeter: ~/.tokmeter/config.json is malformed (${reason}). Saved a copy at ${backupPath} and continuing with defaults.`
    );
  } catch {
    // If even the copy fails, continue silently — defaults still work.
  }
}

/**
 * Fill in any missing fields from DEFAULT_CONFIG. Drops unknown keys to keep
 * the file schema-clean — a typo in a field name shouldn't silently round-trip.
 */
function normalizeConfig(raw: Partial<UserConfig>): UserConfig {
  const d = DEFAULT_CONFIG;
  const rawTheme = typeof raw.theme === "string" ? raw.theme.trim() : "";
  return {
    version: 1,
    theme: rawTheme.length > 0 ? rawTheme : d.theme,
    nerdFont: raw.nerdFont === true,
    bar: {
      refreshSeconds: clampPositiveInt(raw.bar?.refreshSeconds, d.bar.refreshSeconds, 5, 3600),
      menubarColorSource: MENUBAR_COLOR_SOURCES.includes(
        raw.bar?.menubarColorSource as MenubarColorSource
      )
        ? (raw.bar?.menubarColorSource as MenubarColorSource)
        : d.bar.menubarColorSource,
      weekChartStyle: WEEK_CHART_STYLES.includes(raw.bar?.weekChartStyle as WeekChartStyle)
        ? (raw.bar?.weekChartStyle as WeekChartStyle)
        : d.bar.weekChartStyle,
      dashboardPort: clampPositiveInt(raw.bar?.dashboardPort, d.bar.dashboardPort, 1024, 65535),
    },
    daemon: {
      scanIntervalSeconds: clampPositiveInt(
        raw.daemon?.scanIntervalSeconds,
        d.daemon.scanIntervalSeconds,
        10,
        3600
      ),
      // Strict === true, not truthy coercion — a malformed or garbage value
      // in the config file must never accidentally turn this on.
      antigravityLivePolling: raw.daemon?.antigravityLivePolling === true,
      // Only an explicit false turns it off; garbage keeps the default.
      cursorHook: raw.daemon?.cursorHook !== false,
    },
    cli: {
      defaultRange: isDefaultRange(raw.cli?.defaultRange)
        ? raw.cli.defaultRange
        : d.cli.defaultRange,
      defaultSort: isDefaultSort(raw.cli?.defaultSort) ? raw.cli.defaultSort : d.cli.defaultSort,
    },
    alerts: {
      dailyCostThreshold:
        typeof raw.alerts?.dailyCostThreshold === "number" && raw.alerts.dailyCostThreshold > 0
          ? raw.alerts.dailyCostThreshold
          : d.alerts.dailyCostThreshold,
    },
    statusline: normalizeStatuslineConfig(raw.statusline),
    providerPaths: normalizeProviderPaths(raw.providerPaths),
    customSources: normalizeCustomSources(raw.customSources),
    modifiedBy: raw.modifiedBy === "user" ? "user" : "tokmeter",
    modifiedAt: typeof raw.modifiedAt === "string" ? raw.modifiedAt : new Date().toISOString(),
  };
}

/**
 * Drops malformed entries instead of rejecting the whole config — a typo'd
 * provider id or a non-string path shouldn't fall back to defaults for
 * every other knob in the file.
 */
function normalizeStatuslineConfig(raw: unknown): StatuslineConfig {
  const d = DEFAULT_CONFIG.statusline;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...d, show: { ...d.show } };
  }
  const r = raw as Partial<StatuslineConfig>;
  const rawTheme = typeof r.theme === "string" ? r.theme.trim() : "";
  const rawShow =
    typeof r.show === "object" && r.show !== null && !Array.isArray(r.show)
      ? (r.show as Partial<StatuslineShowConfig>)
      : {};
  return {
    style: STATUSLINE_STYLES.includes(r.style as StatuslineStyle)
      ? (r.style as StatuslineStyle)
      : d.style,
    density: STATUSLINE_DENSITIES.includes(r.density as StatuslineDensity)
      ? (r.density as StatuslineDensity)
      : d.density,
    theme: rawTheme.length > 0 ? rawTheme : null,
    nerdFont: typeof r.nerdFont === "boolean" ? r.nerdFont : null,
    show: {
      git: rawShow.git !== false,
      pr: rawShow.pr !== false,
      cache: rawShow.cache !== false,
      windows: rawShow.windows !== false,
      today: rawShow.today !== false,
      repo: rawShow.repo !== false,
      pace: rawShow.pace !== false,
      liveSessions: rawShow.liveSessions !== false,
      subagents: rawShow.subagents !== false,
      linesDelta: rawShow.linesDelta !== false,
    },
  };
}

function normalizeProviderPaths(raw: unknown): Record<string, string[]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [providerId, paths] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(paths)) continue;
    const clean = paths.filter((p): p is string => typeof p === "string" && p.length > 0);
    if (clean.length > 0) out[providerId] = clean;
  }
  return out;
}

/**
 * Drops malformed entries instead of rejecting the whole config. A source
 * needs a non-empty `path` and a known `format`; everything else is optional.
 */
function normalizeCustomSources(raw: unknown): CustomSource[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomSource[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== "string" || e.path.length === 0) continue;
    if (e.format !== "tokmeter-usage-jsonl") continue;
    out.push({
      path: e.path,
      format: "tokmeter-usage-jsonl",
      provider: typeof e.provider === "string" ? e.provider : undefined,
      label: typeof e.label === "string" ? e.label : undefined,
      enabled: e.enabled !== false,
    });
  }
  return out;
}

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const i = Math.round(value);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function isDefaultRange(value: unknown): value is DefaultRange {
  return (
    value === "all" ||
    value === "today" ||
    value === "week" ||
    value === "month" ||
    value === "year"
  );
}

function isDefaultSort(value: unknown): value is DefaultSort {
  return value === "cost" || value === "tokens" || value === "activeDays";
}

// ─── Get / Set by dotted path ──────────────────────────────────────────────

/**
 * The set of keys the CLI exposes via `config get/set`. Declaring them as
 * discrete metadata (rather than deep generic path-typing) keeps the CLI
 * validation obvious and the error messages concrete.
 */
export interface ConfigFieldMeta {
  path: string;
  type: "int" | "enum" | "enum-or-null" | "number-or-null" | "bool" | "bool-or-null";
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  description: string;
}

export const CONFIG_FIELDS: readonly ConfigFieldMeta[] = [
  {
    path: "theme",
    type: "enum",
    enumValues: BUILT_IN_THEME_IDS,
    description: "Built-in color theme id for statusline and TUI.",
  },
  {
    path: "nerdFont",
    type: "bool",
    description: "Enable Nerd Font glyphs in statusline/TUI (requires a patched font).",
  },
  {
    path: "statusline.style",
    type: "enum",
    enumValues: STATUSLINE_STYLES,
    description: "Statusline visual skin (rams | deck | pill | meter | ledger).",
  },
  {
    path: "statusline.density",
    type: "enum",
    enumValues: STATUSLINE_DENSITIES,
    description: "Statusline line budget (compact | balanced | telemetry).",
  },
  {
    path: "statusline.theme",
    type: "enum-or-null",
    enumValues: BUILT_IN_THEME_IDS,
    description: 'Statusline theme override ("null" / "inherit" uses top-level theme).',
  },
  {
    path: "statusline.nerdFont",
    type: "bool-or-null",
    description: 'Statusline Nerd Font override ("null" / "inherit" uses top-level nerdFont).',
  },
  {
    path: "statusline.show.git",
    type: "bool",
    description: "Show git branch and dirty marker on the statusline.",
  },
  {
    path: "statusline.show.pr",
    type: "bool",
    description: "Show open pull request badge and review state on the statusline.",
  },
  {
    path: "statusline.show.cache",
    type: "bool",
    description: "Show prompt cache warmth/hit share/TTL segment on the statusline.",
  },
  {
    path: "statusline.show.windows",
    type: "bool",
    description: "Show plan rate windows (5h / 7d) and gateway spend limit on line 2.",
  },
  {
    path: "statusline.show.today",
    type: "bool",
    description: "Show cross-agent today spend segment on line 2.",
  },
  {
    path: "statusline.show.repo",
    type: "bool",
    description: "Show current repository share of today's spend on line 2.",
  },
  {
    path: "statusline.show.pace",
    type: "bool",
    description: "Show intraday spend pace multiple (e.g. 1.2x) next to today's spend.",
  },
  {
    path: "statusline.show.liveSessions",
    type: "bool",
    description: "Show concurrent live session count across coding agents.",
  },
  {
    path: "statusline.show.subagents",
    type: "bool",
    description: "Show subagent spend share when notable.",
  },
  {
    path: "statusline.show.linesDelta",
    type: "bool",
    description: "Show session lines added/removed in telemetry density.",
  },
  {
    path: "bar.refreshSeconds",
    type: "int",
    min: 5,
    max: 3600,
    description: "Seconds between menubar fetches from the daemon.",
  },
  {
    path: "bar.dashboardPort",
    type: "int",
    min: 1024,
    max: 65535,
    description: "Preferred port for the menubar's web dashboard (next free port if taken).",
  },
  {
    path: "daemon.scanIntervalSeconds",
    type: "int",
    min: 10,
    max: 3600,
    description: "Seconds between daemon rescans of session logs.",
  },
  {
    path: "cli.defaultRange",
    type: "enum",
    enumValues: ["all", "today", "week", "month", "year"] as const,
    description: "Default time window when no --today/--week/... flag is passed.",
  },
  {
    path: "cli.defaultSort",
    type: "enum",
    enumValues: ["cost", "tokens", "activeDays"] as const,
    description: "Default sort column for tables.",
  },
  {
    path: "alerts.dailyCostThreshold",
    type: "number-or-null",
    min: 0.01,
    description: 'USD/day that triggers an alert. "null" or "off" disables.',
  },
  {
    path: "daemon.antigravityLivePolling",
    type: "bool",
    description:
      "Off by default. When on, the daemon periodically reads a CSRF token from Antigravity's " +
      "running language_server process and calls its undocumented internal status RPC for live " +
      "model/credit data. Same technique the community antigravity-panel extension uses, but an " +
      "internal channel Antigravity didn't publish for this — deliberately opt-in only.",
  },
  {
    path: "daemon.cursorHook",
    type: "bool",
    description:
      "On by default. The daemon keeps tokmeter's Cursor stop hook in ~/.cursor/hooks.json, " +
      "because Cursor 3.11+ keeps no token counts on disk. Set false to stop it.",
  },
] as const;

/** Read a CLI-exposed field by its dotted path. Throws on unknown path. */
export function getConfigValue(config: UserConfig, path: string): unknown {
  const field = CONFIG_FIELDS.find((f) => f.path === path);
  if (!field) throw new Error(`Unknown config key: ${path}`);
  return readPath(config, path);
}

/**
 * Set a CLI-exposed field by its dotted path with type coercion + validation.
 * Returns a new config object — does not mutate the input. Throws on invalid
 * key or value so the caller surfaces a clean CLI error.
 */
export function setConfigValue(
  config: UserConfig,
  path: string,
  rawValue: string,
  flag: "user" | "tokmeter" = "user"
): UserConfig {
  const field = CONFIG_FIELDS.find((f) => f.path === path);
  if (!field) throw new Error(`Unknown config key: ${path}`);

  const coerced = coerceValue(field, rawValue);
  const next = deepClone(config);
  writePath(next as unknown as Record<string, unknown>, path, coerced);
  next.modifiedBy = flag;
  next.modifiedAt = new Date().toISOString();
  return next;
}

function coerceValue(field: ConfigFieldMeta, rawValue: string): unknown {
  const v = rawValue.trim();
  switch (field.type) {
    case "int": {
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new Error(`${field.path}: expected integer, got "${rawValue}"`);
      }
      if (field.min !== undefined && n < field.min) {
        throw new Error(`${field.path}: must be ≥ ${field.min}`);
      }
      if (field.max !== undefined && n > field.max) {
        throw new Error(`${field.path}: must be ≤ ${field.max}`);
      }
      return n;
    }
    case "enum": {
      if (!field.enumValues?.includes(v)) {
        throw new Error(
          `${field.path}: must be one of ${field.enumValues?.join(" | ")} (got "${rawValue}")`
        );
      }
      return v;
    }
    case "enum-or-null": {
      if (v === "null" || v === "inherit" || v === "") return null;
      if (!field.enumValues?.includes(v)) {
        throw new Error(
          `${field.path}: must be one of ${field.enumValues?.join(" | ")} or "null" (got "${rawValue}")`
        );
      }
      return v;
    }
    case "number-or-null": {
      if (v === "null" || v === "off" || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        throw new Error(`${field.path}: expected number or "null", got "${rawValue}"`);
      }
      if (field.min !== undefined && n < field.min) {
        throw new Error(`${field.path}: must be ≥ ${field.min} (or "null" to disable)`);
      }
      return n;
    }
    case "bool": {
      if (v === "true" || v === "on" || v === "1") return true;
      if (v === "false" || v === "off" || v === "0") return false;
      throw new Error(`${field.path}: expected true/false (or on/off), got "${rawValue}"`);
    }
    case "bool-or-null": {
      if (v === "null" || v === "inherit" || v === "") return null;
      if (v === "true" || v === "on" || v === "1") return true;
      if (v === "false" || v === "off" || v === "0") return false;
      throw new Error(`${field.path}: expected true/false (or on/off/"null"), got "${rawValue}"`);
    }
  }
}

function readPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function writePath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i] as string;
    if (typeof cur[k] !== "object" || cur[k] === null) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1] as string] = value;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ─── Cross-machine merge (restore path) ────────────────────────────────────

/**
 * Merge two configs with the same precedence rules as alias maps: user beats
 * tokmeter; within the same flag class, newer `modifiedAt` wins. Used by
 * snapshot restore so a backup from the office PC doesn't silently clobber
 * edits made on the Mac after the snapshot was taken.
 */
export function mergeConfigs(a: UserConfig, b: UserConfig): UserConfig {
  if (a.modifiedBy === "user" && b.modifiedBy !== "user") return a;
  if (a.modifiedBy !== "user" && b.modifiedBy === "user") return b;
  const aTs = Date.parse(a.modifiedAt) || 0;
  const bTs = Date.parse(b.modifiedAt) || 0;
  return bTs >= aTs ? b : a;
}
