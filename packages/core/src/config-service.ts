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

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────────

export type DefaultRange = "all" | "today" | "week" | "month" | "year";
export type DefaultSort = "cost" | "tokens" | "activeDays";

export interface UserConfig {
  version: 1;
  bar: {
    /** Seconds between bar fetches from the daemon. */
    refreshSeconds: number;
  };
  daemon: {
    /** Advisory: seconds between full rescans inside the daemon. */
    scanIntervalSeconds: number;
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
  bar: { refreshSeconds: 30 },
  daemon: { scanIntervalSeconds: 60 },
  cli: { defaultRange: "all", defaultSort: "cost" },
  alerts: { dailyCostThreshold: null },
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
export function loadConfig(home: string = homedir()): UserConfig {
  const path = configFilePath(home);
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };

  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    backupBrokenConfigFile(path, `JSON parse error: ${(err as Error).message}`);
    return { ...DEFAULT_CONFIG };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    backupBrokenConfigFile(path, "root is not an object");
    return { ...DEFAULT_CONFIG };
  }

  return normalizeConfig(parsed as Partial<UserConfig>);
}

/** Atomic write — tmp + rename. Safe against power loss and concurrent CLIs. */
export function saveConfig(config: UserConfig, home: string = homedir()): void {
  const path = configFilePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, path);
}

function backupBrokenConfigFile(path: string, reason: string): void {
  const backupPath = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    copyFileSync(path, backupPath);
    // biome-ignore lint/suspicious/noConsole: user-facing warning, not debug noise
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
  return {
    version: 1,
    bar: {
      refreshSeconds: clampPositiveInt(raw.bar?.refreshSeconds, d.bar.refreshSeconds, 5, 3600),
    },
    daemon: {
      scanIntervalSeconds: clampPositiveInt(
        raw.daemon?.scanIntervalSeconds,
        d.daemon.scanIntervalSeconds,
        10,
        3600
      ),
    },
    cli: {
      defaultRange: isDefaultRange(raw.cli?.defaultRange) ? raw.cli.defaultRange : d.cli.defaultRange,
      defaultSort: isDefaultSort(raw.cli?.defaultSort) ? raw.cli.defaultSort : d.cli.defaultSort,
    },
    alerts: {
      dailyCostThreshold:
        typeof raw.alerts?.dailyCostThreshold === "number" && raw.alerts.dailyCostThreshold > 0
          ? raw.alerts.dailyCostThreshold
          : d.alerts.dailyCostThreshold,
    },
    modifiedBy: raw.modifiedBy === "user" ? "user" : "tokmeter",
    modifiedAt: typeof raw.modifiedAt === "string" ? raw.modifiedAt : new Date().toISOString(),
  };
}

function clampPositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const i = Math.round(value);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function isDefaultRange(value: unknown): value is DefaultRange {
  return value === "all" || value === "today" || value === "week" || value === "month" || value === "year";
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
  type: "int" | "enum" | "number-or-null";
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  description: string;
}

export const CONFIG_FIELDS: readonly ConfigFieldMeta[] = [
  {
    path: "bar.refreshSeconds",
    type: "int",
    min: 5,
    max: 3600,
    description: "Seconds between menubar fetches from the daemon.",
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
