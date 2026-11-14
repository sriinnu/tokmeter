/**
 * @sriinnu/tokmeter-core — Cursor IDE parser.
 *
 * Two data sources, tried in order so a user is never double-counted:
 *
 * 1. ~/.config/tokscale/cursor-cache/*.csv — usage synced from Cursor's own
 *    API by an external "tokscale" tool. Real $ cost when present, but
 *    requires that separate sync to have been run at least once.
 * 2. Cursor's own local SQLite store (`cursorDiskKV` table in
 *    globalStorage/state.vscdb) — read directly, no external tool needed.
 *    Conversation messages ("bubbles") are split into requests: a user
 *    bubble and the assistant/tool bubbles after it, in createdAt order.
 *    The user bubble names the model; a later bubble carries the request's
 *    `tokenCount`. One record per counted bubble, named by its request's
 *    user bubble; requests with no count are reported as a notice. `inputTokens` there is the context size,
 *    not billed input, and there is no cache split.
 *
 * Source 2 only runs when source 1 found nothing, so a user who has both
 * set up doesn't get every request counted twice.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeProjectName } from "../project-name.js";
import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import {
  CURSOR_TURN_SEMANTICS,
  cursorTurnJournalDir,
  isCovered,
  readCursorHookCoverage,
  readCursorTurnJournal,
} from "./cursor-turn-journal.js";
import {
  createRecord,
  expandHome,
  findFiles,
  getConfiguredProviderPaths,
  openReadonlySqlite,
  vscodeFamilyUserDirs,
} from "./utils.js";

/** Bubble `type` for a user message; 2 is an assistant or tool step. */
const USER_BUBBLE = 1;

interface CursorBubble {
  type?: number;
  createdAt?: string;
  /** On a user bubble: the request's id. On a counted bubble it matches nothing. */
  requestId?: string;
  /** Only on the one assistant bubble per request that carries a count. */
  tokenCount?: { inputTokens?: number; outputTokens?: number };
  /** Only on user bubbles. */
  modelInfo?: { modelName?: string };
  workspaceUris?: string[];
}

/** A `composerData:<composerId>` row: the conversation's bubble order. */
interface CursorComposerData {
  fullConversationHeadersOnly?: { bubbleId?: string }[];
}

function toJson<T>(raw: string | Uint8Array): T | null {
  try {
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/** Extracts the composerId from a `bubbleId:<composerId>:<bubbleId>` key. */
function composerIdFromKey(key: string): string | undefined {
  return key.split(":")[1];
}

/** Where tokscale's Cursor CSV export cache lives. */
function cursorCsvCacheDir(homeDir: string): string {
  return expandHome("~/.config/tokscale/cursor-cache", homeDir);
}

/** Cursor's local state.vscdb candidates: auto-detected plus configured. */
function cursorStateDbPaths(homeDir: string): string[] {
  return [
    ...vscodeFamilyUserDirs(["Cursor"], homeDir),
    ...getConfiguredProviderPaths("cursor", homeDir).map((p) => expandHome(p, homeDir)),
  ].map((userDir) => join(userDir, "globalStorage", "state.vscdb"));
}

export interface CursorParserOptions {
  /**
   * Count the stop hook's turns inside its install ledger. Defaults to
   * CURSOR_TURN_SEMANTICS.verified, which is false: shadow mode, where the
   * hook's turns are only reported, never counted. Tests flip it here.
   */
  hookVerified?: boolean;
}

export class CursorParser implements SessionParser {
  readonly providerId = "cursor" as const;
  private readonly hookVerified: boolean;

  constructor(options: CursorParserOptions = {}) {
    this.hookVerified = options.hookVerified ?? CURSOR_TURN_SEMANTICS.verified;
  }

  // Cursor's own state.vscdb is a live, actively-written app database that
  // can run to hundreds of MB with thousands of rows — re-querying and
  // re-JSON-parsing the whole cursorDiskKV table on every scan tick (the
  // daemon refreshes "today" every ~12s) is exactly the repeated-full-scan
  // pattern that already caused a real memory-pressure incident in this
  // project (see docs/architecture.md). Cache per dbPath, keyed by mtime,
  // so an unchanged database is a stat() call, not a re-read.
  private readonly localCache = new Map<string, LocalDbRead & { mtimeMs: number }>();

  /** Paths this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [
      cursorCsvCacheDir(homeDir),
      ...cursorStateDbPaths(homeDir),
      cursorTurnJournalDir(homeDir),
    ];
  }

  /**
   * Sources, each owning its own stretch of time so a turn counts once:
   *  - tokscale's CSV export, when present, replaces everything (as before);
   *  - while the stop hook is installed (its coverage ledger), its turns are
   *    the usage: real input, output and cache counts;
   *  - outside those spans, the local database's per-request counts.
   * The hook part runs only once its numbers are verified
   * (`hookVerified`). Until then it is shadow mode: the journal and the
   * ledger are not used at all, the database counts everything, and a
   * notice says how many turns the hook recorded.
   * The opt-in `tokmeter cursor sync` export isn't read here yet: it covers
   * time after the fact, and a source that takes over a stretch later would
   * make the daemon carry the records it replaced as deleted history.
   */
  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const fromCsv = await this.scanCsvCache(homeDir);
    if (fromCsv.length > 0) return fromCsv;
    if (!this.hookVerified) {
      const local = await this.scanLocalDatabase(homeDir, opts);
      await reportShadowTurns(homeDir, opts);
      return local;
    }
    const coverage = await readCursorHookCoverage(homeDir);
    const local = await this.scanLocalDatabase(homeDir, opts);
    if (coverage.length === 0) return local;

    const kept = local.filter((r) => !isCovered(coverage, r.timestamp));
    if (kept.length < local.length) {
      opts?.onNotice?.(
        `${local.length - kept.length} local request count${local.length - kept.length === 1 ? "" : "s"} fell while the stop hook was installed; its turns are used instead.`
      );
    }
    const journal = await readCursorTurnJournal(homeDir);
    // A hook line written outside its own ledger (a hand-edited hooks.json)
    // would overlap the database's counts there, so it's not used.
    const turns = journal.records.filter((r) => isCovered(coverage, r.timestamp));
    if (journal.turnsWithoutUsage > 0) {
      opts?.onNotice?.(
        `${journal.turnsWithoutUsage} Cursor turn${journal.turnsWithoutUsage === 1 ? "" : "s"} ended without usage (errors, aborts, inline edits).`
      );
    }
    if (turns.length < journal.records.length) {
      opts?.onNotice?.(
        `${journal.records.length - turns.length} hook turn${journal.records.length - turns.length === 1 ? "" : "s"} fell outside the hook's install ledger and weren't used.`
      );
    }
    return [...kept, ...turns];
  }

  private async scanCsvCache(homeDir: string): Promise<TokenRecord[]> {
    const cacheDir = cursorCsvCacheDir(homeDir);
    const csvFiles = await findFiles(cacheDir, (f) => f.endsWith(".csv"), 1);
    const records: TokenRecord[] = [];

    for (const file of csvFiles) {
      try {
        const raw = await readFile(file, "utf-8");
        const lines = raw.trim().split("\n");
        if (lines.length < 2) continue;

        // Skip header, parse CSV rows
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",");
          if (cols.length < 4) continue;
          const parsedCost = Number(cols[5]);
          const hasCost = cols[5] !== undefined && cols[5] !== "" && Number.isFinite(parsedCost);

          records.push(
            createRecord({
              timestamp: cols[0] ? new Date(cols[0]).getTime() : undefined,
              provider: "cursor",
              model: cols[1] || "unknown",
              project: canonicalizeProjectName(cols[2] || "cursor", "cursor"),
              sourceFile: file,
              inputTokens: Number(cols[3]) || 0,
              outputTokens: Number(cols[4]) || 0,
              cost: hasCost ? parsedCost : 0,
              usage: hasCost ? { cost: "direct" } : { cost: "calculated" },
            })
          );
        }
      } catch (error) {
        throw new Error(
          `Unable to read Cursor CSV ${file}: ${error instanceof Error ? error.message : error}`
        );
      }
    }
    return records;
  }

  private async scanLocalDatabase(
    homeDir: string,
    opts?: ScanFilterOptions
  ): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];
    let requests = 0;
    let uncounted = 0;
    for (const dbPath of cursorStateDbPaths(homeDir)) {
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(dbPath)).mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }

      let read = this.localCache.get(dbPath);
      if (!read || read.mtimeMs !== mtimeMs) {
        read = { mtimeMs, ...(await this.readLocalDatabase(dbPath)) };
        this.localCache.set(dbPath, read);
      }
      records.push(...cloneRecords(read.records));
      requests += read.requests;
      uncounted += read.uncounted;
    }
    // Said on every scan, cache hit or not: each scan collects its own notices.
    // A notice, not a warning: nothing tokmeter could read was lost, so it
    // must never hold a day's seal.
    if (uncounted > 0) {
      opts?.onNotice?.(
        `${uncounted} of ${requests} request${requests === 1 ? "" : "s"} ${uncounted === 1 ? "has" : "have"} no token count in Cursor's local data`
      );
    }
    return records;
  }

  /**
   * One record per request. A request is a user bubble (`type` 1) and every
   * bubble after it in the same composer, up to the next user bubble. The user
   * bubble names the model and carries the `requestId`; the bubble with the
   * count (`tokenCount`) has no `modelInfo`, and its own `requestId` matches
   * no user bubble, so the two can only be joined by order. Composers switch
   * models mid-conversation, so the model is per request, never per composer.
   */
  private async readLocalDatabase(dbPath: string): Promise<LocalDbRead> {
    const records: TokenRecord[] = [];
    let requests = 0;
    let uncounted = 0;
    const db = await openReadonlySqlite(dbPath);
    try {
      const rows = db.all<{ key: string; value: string | Uint8Array }>(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'"
      );
      const composerRows = db.all<{ key: string; value: string | Uint8Array }>(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
      );

      // Where each bubble sits in its composer's own header list: the
      // tie-break when two bubbles share a createdAt.
      const headerIndex = new Map<string, number>();
      for (const row of composerRows) {
        const composerId = row.key.slice("composerData:".length);
        const headers = toJson<CursorComposerData>(row.value)?.fullConversationHeadersOnly;
        if (!composerId || !Array.isArray(headers)) continue;
        headers.forEach((header, index) => {
          if (typeof header?.bubbleId === "string") {
            headerIndex.set(`bubbleId:${composerId}:${header.bubbleId}`, index);
          }
        });
      }

      const projectByComposer = new Map<string, string>();
      const byComposer = new Map<string, ParsedBubble[]>();
      for (const row of rows) {
        const composerId = composerIdFromKey(row.key);
        const bubble = toJson<CursorBubble>(row.value);
        if (!composerId || !bubble) continue;
        const parsed: ParsedBubble = {
          key: row.key,
          bubble,
          time: bubble.createdAt ? Date.parse(bubble.createdAt) : Number.NaN,
          headerIndex: headerIndex.get(row.key),
        };
        const list = byComposer.get(composerId);
        if (list) list.push(parsed);
        else byComposer.set(composerId, [parsed]);

        if (bubble.workspaceUris?.[0] && !projectByComposer.has(composerId)) {
          projectByComposer.set(
            composerId,
            canonicalizeProjectName(decodeCursorFileUri(bubble.workspaceUris[0]), "cursor")
          );
        }
      }

      for (const [composerId, bubbles] of byComposer) {
        bubbles.sort(compareBubbles);
        const composerProject = projectByComposer.get(composerId) || "cursor";
        for (const segment of segmentByRequest(bubbles)) {
          if (segment.user) requests++;
          if (segment.counted.length === 0) {
            if (segment.user) uncounted++;
            continue;
          }
          const userUri = segment.user?.bubble.workspaceUris?.[0];
          const project = userUri
            ? canonicalizeProjectName(decodeCursorFileUri(userUri), "cursor")
            : composerProject;
          // One record per counted bubble. Each is its own response; folding
          // several into one (max per bucket) would drop real usage.
          for (const bubble of segment.counted) {
            records.push(toRecord(segment, bubble, project, dbPath));
          }
        }
      }
    } finally {
      db.close();
    }
    return { records, requests, uncounted };
  }
}

interface LocalDbRead {
  records: TokenRecord[];
  /** User bubbles seen: one per request. */
  requests: number;
  /** Requests (segments with a user bubble) with no counted bubble. */
  uncounted: number;
}

interface ParsedBubble {
  key: string;
  bubble: CursorBubble;
  /** createdAt as epoch ms; NaN when missing. */
  time: number;
  /** Position in the composer's fullConversationHeadersOnly, when listed. */
  headerIndex: number | undefined;
}

interface RequestSegment {
  /** The user bubble that opened the request; absent for bubbles before the first one. */
  user?: ParsedBubble;
  /** Bubbles in the segment that carry a non-zero count. */
  counted: ParsedBubble[];
}

function hasCount(bubble: CursorBubble): boolean {
  return (bubble.tokenCount?.inputTokens ?? 0) > 0 || (bubble.tokenCount?.outputTokens ?? 0) > 0;
}

/**
 * createdAt first. On a tie, header order when both bubbles are listed, a
 * listed bubble before an unlisted one, else key order. Each step is a total
 * order, so the sort is deterministic. A bubble with no createdAt sorts last.
 */
function compareBubbles(a: ParsedBubble, b: ParsedBubble): number {
  const aTime = Number.isFinite(a.time) ? a.time : Number.POSITIVE_INFINITY;
  const bTime = Number.isFinite(b.time) ? b.time : Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  if (a.headerIndex !== undefined && b.headerIndex !== undefined) {
    if (a.headerIndex !== b.headerIndex) return a.headerIndex - b.headerIndex;
  } else if (a.headerIndex !== undefined) {
    return -1;
  } else if (b.headerIndex !== undefined) {
    return 1;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Splits a composer's sorted bubbles into requests, one per user bubble. */
function segmentByRequest(sorted: ParsedBubble[]): RequestSegment[] {
  const segments: RequestSegment[] = [];
  let current: RequestSegment | undefined;
  for (const parsed of sorted) {
    if (parsed.bubble.type === USER_BUBBLE) {
      current = { user: parsed, counted: [] };
      segments.push(current);
    } else if (!current) {
      // A count before any user bubble (not seen in real data) is still
      // usage: keep it as its own request, with no user bubble to name a model.
      current = { counted: [] };
      segments.push(current);
    }
    if (hasCount(parsed.bubble)) current.counted.push(parsed);
  }
  return segments;
}

/**
 * One counted bubble as a record. Its counts and time are its own; model,
 * project and apiCallId come from the request's user bubble. A segment with
 * no user bubble has no model to name: "unknown".
 */
function toRecord(
  segment: RequestSegment,
  counted: ParsedBubble,
  project: string,
  dbPath: string
): TokenRecord {
  const inputTokens = counted.bubble.tokenCount?.inputTokens ?? 0;
  const outputTokens = counted.bubble.tokenCount?.outputTokens ?? 0;
  const modelName = segment.user?.bubble.modelInfo?.modelName || "unknown";
  const requestId = segment.user?.bubble.requestId;
  return createRecord({
    timestamp: Number.isFinite(counted.time) ? counted.time : undefined,
    provider: "cursor",
    // "default" is Cursor's Auto mode: Cursor picked the model and didn't say which.
    model: modelName === "default" ? "cursor-auto" : modelName,
    project,
    sourceFile: dbPath,
    // The counted bubble's key: the thread key earlier versions wrote for the
    // same bubble, so the today journal sees the same threads across the
    // upgrade instead of carrying every old one as deleted (double-counting
    // the day it's installed).
    threadKey: counted.key,
    // The user bubble's requestId, the id a Cursor hook's generation_id is
    // expected to match, for a later hook source to dedup against.
    ...(requestId ? { apiCallId: requestId } : {}),
    inputTokens,
    outputTokens,
    usage: {
      source: "tool_sqlite",
      inputTokens: "estimated",
      outputTokens: "direct",
      cacheReadTokens: "not_exposed",
      cacheWriteTokens: "not_exposed",
      reasoningTokens: "not_exposed",
      notes: [
        "Cursor's input count is the context size when the request was made, not billed input. Cursor's local data has no cache split.",
      ],
    },
  });
}

/**
 * Shadow mode: say what the hook recorded, count none of it. The journal is
 * only read for the notice, so a read failure here costs nothing and must
 * not fail the scan or hold a seal.
 */
async function reportShadowTurns(homeDir: string, opts?: ScanFilterOptions): Promise<void> {
  if (!opts?.onNotice) return;
  let journal: Awaited<ReturnType<typeof readCursorTurnJournal>>;
  try {
    journal = await readCursorTurnJournal(homeDir);
  } catch (error) {
    opts.onNotice(
      `Cursor hook journal could not be read (${error instanceof Error ? error.message : error}); it isn't counted yet, so nothing is lost.`
    );
    return;
  }
  const withUsage = journal.records.length;
  const total = withUsage + journal.turnsWithoutUsage;
  if (total === 0) return;
  opts.onNotice(
    `Cursor hook recorded ${total} turn${total === 1 ? "" : "s"} (${withUsage} with usage); not counted until its numbers are verified.`
  );
}

/**
 * Shallow-copies cached records (including the nested `usage` object) so
 * callers never share mutable references across scans — pricing enrichment
 * mutates `record.cost`/`record.usage.cost` in place, and cache hits must
 * not let one scan's enrichment bleed into another's.
 */
function cloneRecords(records: TokenRecord[]): TokenRecord[] {
  return records.map((r) => ({ ...r, usage: r.usage ? { ...r.usage } : undefined }));
}

function decodeCursorFileUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return decodeURIComponent(uri.slice("file://".length));
  } catch {
    return uri.slice("file://".length);
  }
}
