/**
 * @sriinnu/tokmeter-core — Record construction, provenance defaults, and timestamp inference.
 */

import { statSync } from "node:fs";
import { localDateKey } from "../../date-utils.js";
import { sanitizeDataLabel } from "../../display-safety.js";
import { canonicalizeProjectName } from "../../project-name.js";
import type {
  ProviderId,
  TokenRecord,
  UsageProvenance,
  UsageTelemetrySource,
} from "../../types.js";

/** Extract project name from a Claude Code session path. */
export function extractProjectFromPath(filePath: string): string {
  // ~/.claude/projects/-Users-me-myapp/session.jsonl → -Users-me-myapp
  // or just use the parent directory name
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  // Find "projects" in path and take next segment
  const projectsIdx = parts.indexOf("projects");
  if (projectsIdx >= 0 && parts[projectsIdx + 1]) {
    return canonicalizeProjectName(parts[projectsIdx + 1], "unknown");
  }
  // Fallback: use parent directory name
  return canonicalizeProjectName(parts[parts.length - 2] || "unknown", "unknown");
}

type CreateRecordOverrides = Omit<Partial<TokenRecord>, "usage"> & {
  usage?: Partial<UsageProvenance>;
};

const directMetric = "direct" as const;
const notExposedMetric = "not_exposed" as const;
const calculatedMetric = "calculated" as const;
const normalizedMetric = "normalized" as const;

function baseProvenance(source: UsageTelemetrySource): UsageProvenance {
  return {
    source,
    inputTokens: directMetric,
    outputTokens: directMetric,
    cacheReadTokens: directMetric,
    cacheWriteTokens: directMetric,
    reasoningTokens: notExposedMetric,
    cost: calculatedMetric,
  };
}

function withMetrics(base: UsageProvenance, overrides: Partial<UsageProvenance>): UsageProvenance {
  return { ...base, ...overrides };
}

function defaultUsageProvenance(provider: ProviderId): UsageProvenance {
  switch (provider) {
    case "claude-code":
      return baseProvenance("tool_jsonl");
    case "codex":
      return {
        ...baseProvenance("tool_jsonl"),
        inputTokens: normalizedMetric,
        outputTokens: normalizedMetric,
        cacheWriteTokens: notExposedMetric,
        reasoningTokens: directMetric,
        notes: [
          "OpenAI-style total input is normalized to uncached input + cache read; output is normalized to visible output + reasoning.",
        ],
      };
    case "gemini":
    case "qwen":
      return {
        ...baseProvenance(provider === "gemini" ? "tool_json" : "tool_jsonl"),
        inputTokens: normalizedMetric,
        cacheWriteTokens: notExposedMetric,
        reasoningTokens: directMetric,
        notes: ["Total prompt tokens are normalized to uncached input + cache read."],
      };
    case "cursor":
      return withMetrics(baseProvenance("tool_csv"), {
        cacheReadTokens: notExposedMetric,
        cacheWriteTokens: notExposedMetric,
        reasoningTokens: notExposedMetric,
      });
    case "kilo-cli":
      return withMetrics(baseProvenance("tool_sqlite"), {
        reasoningTokens: directMetric,
      });
    case "opencode":
      return withMetrics(baseProvenance("tool_sqlite"), {
        reasoningTokens: directMetric,
      });
    case "kilo":
    case "roo-code":
      return baseProvenance("tool_json");
    case "mux":
      return withMetrics(baseProvenance("tool_json"), {
        reasoningTokens: directMetric,
      });
    case "openclaw":
      return withMetrics(baseProvenance("tool_jsonl"), {
        cacheWriteTokens: notExposedMetric,
        reasoningTokens: notExposedMetric,
      });
    case "vscode-copilot":
      return withMetrics(baseProvenance("tool_json"), {
        inputTokens: notExposedMetric,
        outputTokens: notExposedMetric,
        cacheReadTokens: notExposedMetric,
        cacheWriteTokens: notExposedMetric,
        cost: notExposedMetric,
        notes: [
          "GitHub Copilot bills via quota'd premium requests, not tokens — VS Code's local chat session store has no token/cost data, only model + request timestamps.",
        ],
      });
    case "antigravity":
      return withMetrics(baseProvenance("tool_sqlite"), {
        reasoningTokens: directMetric,
        // Never written: absent from all 2,429 usages decoded on 2026-11-17.
        cacheWriteTokens: notExposedMetric,
        notes: [
          "Antigravity 2.x conversation databases (no public schema, decoded by hand) record per-call usage: uncached input, cache read, thinking and response tokens, each call once by its response id.",
        ],
      });
    case "zed":
      return withMetrics(baseProvenance("tool_sqlite"), {
        notes: [
          "Built from Zed's public open-source schema but not validated against a live Zed install — flag any discrepancy if Zed's format has moved.",
        ],
      });
    case "codex-desktop":
      return withMetrics(baseProvenance("tool_sqlite"), {
        inputTokens: notExposedMetric,
        cacheReadTokens: notExposedMetric,
        cacheWriteTokens: notExposedMetric,
        reasoningTokens: notExposedMetric,
        cost: notExposedMetric,
        notes: [
          "Sourced from Codex's local SQLite state (threads.tokens_used) as a fallback for threads whose rollout JSONL has no token_count events — Codex Desktop / VS Code-extension sessions confirmed to never emit them locally. tokens_used is one cumulative lump total with no input/output/cache split, so the full delta is placed in outputTokens as a TOTAL, not a real output count; cost is left unexposed rather than guessing an input/output ratio to price it.",
        ],
      });
    case "synthetic":
      return withMetrics(baseProvenance("synthetic"), {
        inputTokens: calculatedMetric,
        outputTokens: calculatedMetric,
        cacheReadTokens: calculatedMetric,
        cacheWriteTokens: calculatedMetric,
        reasoningTokens: calculatedMetric,
        cost: calculatedMetric,
      });
    default:
      return baseProvenance("tool_jsonl");
  }
}

function mergeUsageProvenance(
  provider: ProviderId,
  overrides?: Partial<UsageProvenance>
): UsageProvenance {
  const defaults = defaultUsageProvenance(provider);
  if (!overrides) return defaults;
  return {
    ...defaults,
    ...overrides,
    notes: [...(defaults.notes ?? []), ...(overrides.notes ?? [])],
  };
}

/** Per-file creation times, read once per file. */
const fallbackTimes = new Map<string, number>();
const FALLBACK_TIMES_MAX = 20_000;

/**
 * When `sourceFile` was created: the base time for a record whose line has no
 * usable timestamp, before {@link settleInferredTimes} moves it next to the
 * line before it. Read once per file and remembered.
 */
export function fallbackRecordTime(sourceFile: string | undefined): number {
  if (!sourceFile) return Date.now();
  const known = fallbackTimes.get(sourceFile);
  if (known !== undefined) return known;
  let t: number;
  try {
    const s = statSync(sourceFile, { bigint: true });
    t = Number((s.birthtimeNs > 0n ? s.birthtimeNs : s.mtimeNs) / 1_000_000n);
  } catch {
    return Date.now();
  }
  if (fallbackTimes.size >= FALLBACK_TIMES_MAX) fallbackTimes.clear();
  fallbackTimes.set(sourceFile, t);
  return t;
}

/** Test seam: forget remembered creation times. */
export function resetFallbackRecordTimes(): void {
  fallbackTimes.clear();
}

/**
 * Date every record whose line had no timestamp (`timestampInferred`) by the
 * line before it in the same file, plus 1 ms for each such record in a row.
 */
export function settleInferredTimes(records: TokenRecord[]): {
  records: TokenRecord[];
  inferred: number;
} {
  if (!records.some((r) => r.timestampInferred)) return { records, inferred: 0 };
  const prev = new Map<string, { at: number; run: number }>();
  let inferred = 0;
  const out = records.map((r) => {
    const key = r.sourceFile ?? "";
    if (!r.timestampInferred) {
      prev.set(key, { at: r.timestamp, run: 0 });
      return r;
    }
    inferred++;
    const base = prev.get(key) ?? { at: fallbackRecordTime(r.sourceFile), run: 0 };
    const run = base.run + 1;
    prev.set(key, { at: base.at, run });
    const timestamp = base.at + run;
    return timestamp === r.timestamp ? r : { ...r, timestamp };
  });
  return { records: out, inferred };
}

/** Create a base token record with sensible defaults. */
export function createRecord(
  overrides: CreateRecordOverrides &
    Pick<TokenRecord, "provider" | "model"> & { timestamp: number | undefined }
): TokenRecord {
  const hasTime = typeof overrides.timestamp === "number" && Number.isFinite(overrides.timestamp);
  const ts = hasTime ? (overrides.timestamp as number) : fallbackRecordTime(overrides.sourceFile);
  const usage = mergeUsageProvenance(overrides.provider, overrides.usage);
  const record: TokenRecord = {
    project: "unknown",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    ...overrides,
    usage,
    timestamp: ts,
    ...(hasTime ? {} : { timestampInferred: true }),
  };
  record.model = sanitizeDataLabel(record.model, 256) || "unknown";
  record.project = sanitizeDataLabel(record.project, 512) || "unknown";
  if (record.cwd) record.cwd = sanitizeDataLabel(record.cwd, 1024);
  if (record.toolCalls) {
    record.toolCalls = record.toolCalls
      .map((tool) => sanitizeDataLabel(tool, 256))
      .filter((tool) => tool.length > 0);
  }
  return record;
}

/** Format a timestamp (ms) to YYYY-MM-DD. */
export function toDateStr(ts: number): string {
  return localDateKey(ts);
}
