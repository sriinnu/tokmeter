/**
 * @sriinnu/tokmeter-core — reader for the Cursor turn journal.
 *
 * `tokmeter cursor-hook install` puts a `stop` hook in ~/.cursor/hooks.json.
 * When a Cursor agent turn ends, the hook appends one line to
 * ~/.tokmeter/cursor-turns/YYYY-MM-DD.jsonl (local date of the hook run):
 *
 *   {"v":1,"ts":<ms>,"conversation_id":"…","generation_id":"…","model":"…",
 *    "model_id":"…","status":"completed","loop_count":0,"input_tokens":…,
 *    "output_tokens":…,"cache_read_tokens":…,"cache_write_tokens":…,
 *    "cursor_version":"3.11.13","workspace_root":"/path/to/project"}
 *
 * The counts are Cursor's `composerData.turnTokenUsage`, which the server's
 * `agent.v1.TurnEndedUpdate` sets (replacing, not adding) and which is reset
 * when the next generation starts. When no TurnEnded arrived (an error, an
 * abort, a Cmd-K edit) the token fields are absent; those lines are counted in
 * `turnsWithoutUsage`, never as zero-token records.
 *
 * Dedup, so one turn counts once:
 *  1. The same `generation_id` is one turn. A second line for it merges in,
 *     keeping the max per bucket (the counts only replace, so the max is the
 *     final value).
 *  2. Cursor falls back to a random generation_id when the composer has none,
 *     so a re-fired stop for the same turn can arrive under a new id. Usage
 *     resets per generation, so the same conversation reporting an identical
 *     token tuple on its next usage line, within RE_REPORT_WINDOW_MS (10 s)
 *     by `ts`, is that re-report and counts once. Real distinct turns are
 *     further apart than that. A no-usage line in between means a new
 *     generation started, which ends the match.
 *
 * Which TokenRecord field carries the generation_id: `apiCallId`, the raw
 * generation_id with no prefix. That is the field TokenRecord documents as
 * "identity of the API response", and it is what a later merge with Cursor's
 * local DB (whose bubbles carry the same id as their request id) can match
 * on. `threadKey` is `cursor-turn:<generation_id>`.
 *
 * Open questions only a live turn can settle are kept in one place,
 * CURSOR_TURN_SEMANTICS below; fix the mapping there.
 *
 * Past days' files are never rewritten and today's file only grows, so each
 * file is read once and then only from where the last read stopped.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { localDateKey } from "../date-utils.js";
import { canonicalizeProjectName } from "../project-name.js";
import type { TokenRecord, UsageProvenance } from "../types.js";
import { createRecord, visitJsonlLines } from "./utils.js";

/** Journal schema versions this reader understands. */
export const CURSOR_TURN_SCHEMAS: ReadonlySet<number> = new Set([1]);

/**
 * How the hook's counts map onto tokmeter buckets. Every assumption a live
 * Cursor turn has to confirm lives here:
 *
 * - `verified`: false until a live turn has been checked against Cursor's
 *   own numbers. While false, the hook runs in shadow mode: it records
 *   turns, `tokmeter cursor-hook status` shows them, and the Cursor parser
 *   counts none of them and ignores the coverage ledger. The local database
 *   stays the only source.
 * - `inputIncludesCacheRead`: is `input_tokens` the whole prompt (cache reads
 *   inside it) or only the uncached part? Assumed false (disjoint, like the
 *   agent.v1 usage elsewhere). If true, input must become input - cacheRead.
 * - Whole turn or last step: assumed whole turn (TurnEnded is per turn). If it
 *   turns out to be the last step only, these records undercount and the DB
 *   bubbles stay the better source.
 * - Subagents: they fire `subagentStop`, which carries no token fields, so
 *   they write no lines. Whether the parent's turn usage includes theirs is
 *   unknown.
 */
export const CURSOR_TURN_SEMANTICS = {
  verified: false,
  inputIncludesCacheRead: false,
} as const;

/** Rule 2 drops an equal tuple only when the two lines are this close by `ts`. */
export const RE_REPORT_WINDOW_MS = 10_000;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Cursor's "Auto" model shows up as `default` in hook payloads. */
const AUTO_MODEL_NAMES = new Set(["default", "auto"]);

export function cursorTurnJournalDir(homeDir: string): string {
  return join(homeDir, ".tokmeter", "cursor-turns");
}

/**
 * When the hook was installed, as a ledger: `tokmeter cursor-hook install`
 * appends `{"v":1,"event":"installed","ts":…}` and uninstall appends
 * `"uninstalled"`. Written before the turns it covers, so which source owns a
 * moment never changes after the fact (see {@link readCursorHookCoverage}).
 */
export const CURSOR_HOOK_COVERAGE_FILE = "coverage.jsonl";

/** A span of time, in ms; `end` is Infinity while the hook is installed. */
export interface CoverageSpan {
  start: number;
  end: number;
}

/**
 * Turn the ledger's text into spans. Events are taken in append (line) order,
 * never sorted by `ts`: the file's order is the order things happened. A
 * backdated event (a clock that stepped back) is clamped to the previous
 * event's `ts`, so spans never overlap or run backwards.
 */
export function parseCursorHookCoverage(text: string): CoverageSpan[] {
  const spans: CoverageSpan[] = [];
  let open: number | null = null;
  let last = Number.NEGATIVE_INFINITY;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: { event?: unknown; ts?: unknown };
    try {
      e = JSON.parse(line) as { event?: unknown; ts?: unknown };
    } catch {
      continue; // a torn or foreign line; the rest of the ledger still counts
    }
    if (!e || (e.event !== "installed" && e.event !== "uninstalled")) continue;
    if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) continue;
    const ts = Math.max(e.ts, last);
    last = ts;
    if (e.event === "installed" && open === null) open = ts;
    else if (e.event === "uninstalled" && open !== null) {
      spans.push({ start: open, end: ts });
      open = null;
    }
  }
  if (open !== null) spans.push({ start: open, end: Number.POSITIVE_INFINITY });
  return spans;
}

/** True when the ledger's last span is still open (the hook is installed). */
export function hasOpenCoverageSpan(spans: readonly CoverageSpan[]): boolean {
  return spans.length > 0 && spans[spans.length - 1]!.end === Number.POSITIVE_INFINITY;
}

/**
 * The spans the stop hook was installed for, oldest first. Inside one, the
 * hook's turns are Cursor's usage and the local database's per-request counts
 * are not used, so a turn is never counted from both.
 *
 * Why a ledger written at install time, and not "drop a database count when a
 * hook turn matches it": the daemon remembers every record it has seen today,
 * and one that later vanishes from a file still on disk is carried as deleted
 * history. A database count dropped once its hook twin shows up would be
 * carried and counted twice. The install time is known before any turn it
 * covers, so a record's source is decided once and never flips.
 */
export async function readCursorHookCoverage(homeDir: string): Promise<CoverageSpan[]> {
  let text: string;
  try {
    text = await readFile(join(cursorTurnJournalDir(homeDir), CURSOR_HOOK_COVERAGE_FILE), "utf8");
  } catch (error) {
    // Only "no ledger" means "never installed". Any other failure (a
    // permission, a directory in its place) throws, so the scan fails and the
    // day's seal is held rather than counting the wrong source.
    if (isEnoent(error)) return [];
    throw error;
  }
  return parseCursorHookCoverage(text);
}

/** True when `ts` falls inside any span. */
export function isCovered(spans: readonly CoverageSpan[], ts: number): boolean {
  return spans.some((s) => ts >= s.start && ts < s.end);
}

interface JournalEntry {
  ts: number;
  conversationId?: string;
  generationId?: string;
  model?: string;
  modelId?: string;
  status?: string;
  workspaceRoot?: string;
  /** [input, output, cacheRead, cacheWrite]; absent = the turn had no usage. */
  tokens?: [number, number, number, number];
  file: string;
}

interface FileState {
  mtimeMs: number;
  sizeBytes: number;
  consumed: number;
  entries: JournalEntry[];
  malformed: number;
  unknownSchema: number;
}

const fileStates = new Map<string, FileState>();

/** Drop the incremental read cache (tests; a forced rescan). */
export function clearCursorTurnJournalCache(): void {
  fileStates.clear();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

type LineResult = JournalEntry | "malformed" | "unknown-schema";

function parseLine(line: string, file: string): LineResult {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "malformed";
    raw = parsed as Record<string, unknown>;
  } catch {
    return "malformed";
  }
  if (typeof raw.v !== "number" || !CURSOR_TURN_SCHEMAS.has(raw.v)) return "unknown-schema";
  const ts = count(raw.ts);
  if (!ts) return "malformed";
  const buckets = [
    count(raw.input_tokens),
    count(raw.output_tokens),
    count(raw.cache_read_tokens),
    count(raw.cache_write_tokens),
  ];
  const hasUsage = buckets.some((b) => b !== undefined && b > 0);
  return {
    ts,
    conversationId: str(raw.conversation_id),
    generationId: str(raw.generation_id),
    model: str(raw.model),
    modelId: str(raw.model_id),
    status: str(raw.status),
    workspaceRoot: str(raw.workspace_root),
    tokens: hasUsage
      ? [buckets[0] ?? 0, buckets[1] ?? 0, buckets[2] ?? 0, buckets[3] ?? 0]
      : undefined,
    file,
  };
}

/** Read new bytes of one day file, reusing what was parsed before. */
async function readDayFile(path: string): Promise<FileState> {
  const prev = fileStates.get(path);
  let pending: JournalEntry[] = [];
  let malformed = 0;
  let unknownSchema = 0;
  const visit = (line: string) => {
    if (!line.trim()) return;
    const parsed = parseLine(line, path);
    if (parsed === "malformed") malformed++;
    else if (parsed === "unknown-schema") unknownSchema++;
    else pending.push(parsed);
  };
  let base = prev;
  let result = await visitJsonlLines(path, prev?.consumed ?? 0, visit);
  if (prev && result.snapshot.sizeBytes < prev.sizeBytes) {
    // Shrunk: the hook never truncates, so something rewrote it. Start over.
    pending = [];
    malformed = 0;
    unknownSchema = 0;
    base = undefined;
    result = await visitJsonlLines(path, 0, visit);
  }
  const next: FileState = {
    mtimeMs: result.snapshot.mtimeMs,
    sizeBytes: result.snapshot.sizeBytes,
    consumed: result.consumedThroughBytes,
    entries: base ? (pending.length > 0 ? [...base.entries, ...pending] : base.entries) : pending,
    malformed: (base?.malformed ?? 0) + malformed,
    unknownSchema: (base?.unknownSchema ?? 0) + unknownSchema,
  };
  fileStates.set(path, next);
  return next;
}

export interface CursorTurnJournalOptions {
  /** Only records at or after this time (ms). */
  sinceMs?: number;
  /** Only records at or before this time (ms). */
  untilMs?: number;
}

export interface CursorTurnJournalResult {
  /** One record per counted turn, provider "cursor". */
  records: TokenRecord[];
  /** Lines that ended a turn without usage (errors, aborts, Cmd-K). */
  turnsWithoutUsage: number;
  /** The same lines, by the status Cursor reported ("?" when absent). */
  turnsWithoutUsageByStatus: Record<string, number>;
  /** Lines folded into an earlier line with the same generation_id. */
  sameGenerationMerged: number;
  /** Lines dropped as a re-report of the conversation's previous tuple. */
  reReportsDropped: number;
  /** Lines that weren't JSON objects with a valid `ts`. */
  malformedLines: number;
  /** Lines from a schema version this reader doesn't know. */
  unknownSchemaLines: number;
  /** Day files read. */
  files: number;
}

function displayModel(entry: JournalEntry): string {
  const name = entry.model ?? entry.modelId;
  if (!name) return "unknown";
  return AUTO_MODEL_NAMES.has(name.trim().toLowerCase()) ? "cursor-auto" : name;
}

const HOOK_PROVENANCE: Partial<UsageProvenance> = {
  source: "agent_hook",
  inputTokens: "direct",
  outputTokens: "direct",
  cacheReadTokens: "direct",
  cacheWriteTokens: "direct",
  reasoningTokens: "not_exposed",
  cost: "calculated",
  notes: [
    "From Cursor's stop hook (turnTokenUsage at TurnEnded). No reasoning split; only turns that ended after the hook was installed.",
  ],
};

function toRecord(entry: JournalEntry): TokenRecord {
  const [input, output, cacheRead, cacheWrite] = entry.tokens!;
  const uncachedInput = CURSOR_TURN_SEMANTICS.inputIncludesCacheRead
    ? Math.max(0, input - cacheRead)
    : input;
  const turnId = entry.generationId ?? `${entry.conversationId ?? "unknown"}:${entry.ts}`;
  return createRecord({
    timestamp: entry.ts,
    provider: "cursor",
    model: displayModel(entry),
    project: canonicalizeProjectName(entry.workspaceRoot ?? "", "cursor"),
    ...(entry.workspaceRoot ? { cwd: entry.workspaceRoot } : {}),
    inputTokens: uncachedInput,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(entry.generationId ? { apiCallId: entry.generationId } : {}),
    threadKey: `cursor-turn:${turnId}`,
    sourceFile: entry.file,
    usage: HOOK_PROVENANCE,
  });
}

/** Apply the two dedup rules (see the file header) to entries in journal order. */
function dedupEntries(entries: JournalEntry[]): {
  turns: JournalEntry[];
  noUsage: JournalEntry[];
  sameGenerationMerged: number;
  reReportsDropped: number;
} {
  const turns: JournalEntry[] = [];
  const noUsage: JournalEntry[] = [];
  const byGeneration = new Map<string, JournalEntry>();
  const lastTuple = new Map<string, { tuple: string; ts: number }>();
  let sameGenerationMerged = 0;
  let reReportsDropped = 0;

  for (const entry of entries) {
    const conv = entry.conversationId;
    if (!entry.tokens) {
      noUsage.push(entry);
      // A new generation reset turnTokenUsage: an equal tuple after this
      // line is a new turn, not a re-report.
      if (conv) lastTuple.delete(conv);
      continue;
    }
    const known = entry.generationId ? byGeneration.get(entry.generationId) : undefined;
    if (known) {
      const t = known.tokens!;
      known.tokens = [
        Math.max(t[0], entry.tokens[0]),
        Math.max(t[1], entry.tokens[1]),
        Math.max(t[2], entry.tokens[2]),
        Math.max(t[3], entry.tokens[3]),
      ];
      known.model ??= entry.model;
      known.modelId ??= entry.modelId;
      known.workspaceRoot ??= entry.workspaceRoot;
      if (known.conversationId) {
        lastTuple.set(known.conversationId, { tuple: known.tokens.join(","), ts: entry.ts });
      }
      sameGenerationMerged++;
      continue;
    }
    const tuple = entry.tokens.join(",");
    const prev = conv ? lastTuple.get(conv) : undefined;
    if (prev && prev.tuple === tuple && Math.abs(entry.ts - prev.ts) <= RE_REPORT_WINDOW_MS) {
      // Compared line to line: the next re-report is measured from this one.
      prev.ts = entry.ts;
      reReportsDropped++;
      continue;
    }
    if (conv) lastTuple.set(conv, { tuple, ts: entry.ts });
    const turn: JournalEntry = { ...entry, tokens: [...entry.tokens] };
    turns.push(turn);
    if (entry.generationId) byGeneration.set(entry.generationId, turn);
  }
  return { turns, noUsage, sameGenerationMerged, reReportsDropped };
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Day key one day either side, so a turn re-reported across midnight still dedups. */
function shiftDay(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return localDateKey(new Date(y!, m! - 1, d! + days, 12).getTime());
}

/**
 * Read the Cursor turn journal under `homeDir` into TokenRecords. The Cursor
 * parser uses these, once CURSOR_TURN_SEMANTICS.verified is true, only inside the hook's install spans
 * ({@link readCursorHookCoverage}); outside them the database counts.
 */
export async function readCursorTurnJournal(
  homeDir: string,
  opts: CursorTurnJournalOptions = {}
): Promise<CursorTurnJournalResult> {
  const dir = cursorTurnJournalDir(homeDir);
  const result: CursorTurnJournalResult = {
    records: [],
    turnsWithoutUsage: 0,
    turnsWithoutUsageByStatus: {},
    sameGenerationMerged: 0,
    reReportsDropped: 0,
    malformedLines: 0,
    unknownSchemaLines: 0,
    files: 0,
  };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isEnoent(error)) return result;
    throw error; // unreadable, not absent: fail the scan so the seal is held
  }
  const fromDay = opts.sinceMs !== undefined ? shiftDay(localDateKey(opts.sinceMs), -1) : undefined;
  const toDay = opts.untilMs !== undefined ? shiftDay(localDateKey(opts.untilMs), 1) : undefined;
  const days = names
    .map((n) => DAY_FILE.exec(n)?.[1])
    .filter((d): d is string => !!d)
    .filter((d) => (!fromDay || d >= fromDay) && (!toDay || d <= toDay))
    .sort();

  const entries: JournalEntry[] = [];
  for (const day of days) {
    const path = join(dir, `${day}.jsonl`);
    let state: FileState;
    try {
      state = await readDayFile(path);
    } catch (error) {
      if (isEnoent(error)) continue; // vanished since the listing
      throw error;
    }
    result.files++;
    result.malformedLines += state.malformed;
    result.unknownSchemaLines += state.unknownSchema;
    for (const e of state.entries) entries.push(e);
  }

  const inWindow = (ts: number) =>
    (opts.sinceMs === undefined || ts >= opts.sinceMs) &&
    (opts.untilMs === undefined || ts <= opts.untilMs);
  const deduped = dedupEntries(entries);
  result.sameGenerationMerged = deduped.sameGenerationMerged;
  result.reReportsDropped = deduped.reReportsDropped;
  for (const entry of deduped.noUsage) {
    if (!inWindow(entry.ts)) continue;
    result.turnsWithoutUsage++;
    const status = entry.status ?? "?";
    result.turnsWithoutUsageByStatus[status] = (result.turnsWithoutUsageByStatus[status] ?? 0) + 1;
  }
  for (const turn of deduped.turns) {
    if (inWindow(turn.ts)) result.records.push(toRecord(turn));
  }
  return result;
}
