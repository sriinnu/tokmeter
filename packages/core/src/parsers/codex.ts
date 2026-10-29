/**
 * @sriinnu/tokmeter-core — Codex CLI session parser.
 *
 * Reads from $CODEX_HOME/sessions/ or ~/.codex/sessions/
 * Sessions are stored in YYYY/MM/DD/ subdirectories as .jsonl files.
 *
 * Format: RolloutItem events (session_meta, turn_context, event_msg, etc.)
 * Token data comes from token_usage_record (per response), falling back to
 * event_msg/token_count cumulative counters for older turns.
 *
 * ─── Fork dedup ─────────────────────────────────────────────────────────
 * Codex writes a separate rollout file for every `codex resume` or branched
 * session. Each fork's `session_meta.forked_from_id` points back to a common
 * ancestor. When a session is resumed, the new rollout replays / re-traces
 * much of the parent history, so naively summing all sibling files double-
 * counts tokens by 5-10× on heavy days.
 *
 * To dedupe, we group files by their root ancestor (the transitive closure of
 * `forked_from_id` back to a session with no parent) and keep only the latest
 * sibling per group. This matches the invariant that a "session" represents
 * one logical continuous run of Codex, regardless of how many times it was
 * resumed or branched in the UI.
 *
 * ─── Subagent threads are NOT forks ─────────────────────────────────────
 * Codex 0.144+ (multi-agent v2) spawns parallel subagent threads — each gets
 * its OWN rollout file whose session_meta carries `thread_source: "subagent"`
 * and a `forked_from_id`/`parent_thread_id` pointing at the spawning thread.
 * Unlike a resume, a subagent file is DISJOINT usage: its token_count
 * counters start fresh at its own initial context (verified on live 0.144.1
 * data — first totals ~20-35k, not the parent's cumulative millions), and the
 * parent's own token_count events never include the subagent's tokens.
 * Grouping them as forks and keeping one sibling silently dropped ~95% of a
 * heavy multi-agent day (86M tokens on one real day). Subagent files
 * therefore always parse standalone; only non-subagent files (true resumes,
 * which DO replay ancestor history) enter the keep-largest dedup.
 */

import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { stat } from "node:fs/promises";
import * as zlib from "node:zlib";

import { canonicalizeProjectName } from "../project-name.js";
import type {
  ProviderId,
  ScanFaultDetail,
  ScanFilterOptions,
  SessionParser,
  TokenRecord,
} from "../types.js";
import {
  createRecord,
  expandHome,
  filterFilesByMtime,
  findFiles,
  getConfiguredProviderPaths,
  mapWithConcurrency,
  visitJsonlLines,
} from "./utils.js";

/**
 * Bound on how many rollout files we read headers/tails for at once. mtime is
 * a LIE about a file's data date — any tool that rewrites a rollout (even
 * blanking a field) bumps mtime to "now", so a today-scan's mtime prefilter
 * can match hundreds of months-old files at once. Reading all of them with an
 * unbounded Promise.all pins the event loop in GC and the daemon stops
 * answering the bar (STALE). A small pool keeps the scan responsive.
 */
const CODEX_SCAN_CONCURRENCY = 8;

/**
 * Search roots for a codex-family session store: the auto-detected
 * $CODEX_HOME/sessions (falling back to ~/.codex/sessions) plus anything the
 * user added under providerPaths.<providerId> in ~/.tokmeter/config.json.
 * The config escape hatch exists because these locations DO move — Antigravity
 * migrated to a differently-named app dir mid-2026 with no warning, which is
 * exactly the class of drift a hardcoded path can't recover from without a
 * code change. Both CodexParser and CodexDesktopParser share this, since they
 * currently read the same on-disk store, just filtering different files out
 * of it.
 */
export function codexHomeDir(homeDir: string): string {
  return process.env.CODEX_HOME ? process.env.CODEX_HOME : expandHome("~/.codex", homeDir);
}

export function codexSessionDirs(providerId: ProviderId, homeDir: string): string[] {
  const codexHome = codexHomeDir(homeDir);
  return [
    `${codexHome}/sessions`,
    // Codex moves archived threads here, flat. Their usage is as real as any
    // other session's; skipping this dir dropped most of a day once threads
    // were archived before the day sealed.
    `${codexHome}/archived_sessions`,
    ...getConfiguredProviderPaths(providerId, homeDir).map((p) => expandHome(p, homeDir)),
  ];
}

// ─── Codex JSONL Event Types ──────────────────────────────────────────────

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

/** Only complete numeric receipts may supersede the legacy turn counters. */
export function isCodexTokenUsage(value: unknown): value is CodexTokenUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return (
    ["input_tokens", "output_tokens"].every(
      (key) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0
    ) &&
    ["cached_input_tokens", "reasoning_output_tokens"].every(
      (key) =>
        usage[key] === undefined ||
        (typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0)
    )
  );
}

interface CodexTokenCountInfo {
  total_token_usage?: CodexTokenUsage;
  last_token_usage?: CodexTokenUsage;
  model_context_window?: number;
}

interface CodexEvent {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    info?: CodexTokenCountInfo;
    usage?: CodexTokenUsage;
    thread_token_usage?: CodexTokenUsage;
    thread_id?: string;
    turn_id?: string;
    response_id?: string;
    // session_meta fields (payload when type is "session_meta")
    id?: string;
    forked_from_id?: string;
    // Codex 0.144+ multi-agent v2: subagent rollouts mark themselves with
    // thread_source "subagent" and point at the spawner via parent_thread_id.
    // `source` widened from string — new codex emits objects like
    // {"subagent": {"thread_spawn": {...}}} alongside legacy "cli"/"vscode".
    thread_source?: string;
    parent_thread_id?: string;
    cwd?: string;
    source?: string | Record<string, unknown>;
    model_provider?: string;
    agent_nickname?: string;
    git?: {
      repository_url?: string;
      branch?: string;
    };
    // turn_context fields (payload when type is "turn_context")
    model?: string;
  };
}

// ─── Stateful Parser ──────────────────────────────────────────────────────

interface CodexParseState {
  currentModel: string;
  project: string;
  cwd: string;
  prevTotal: CodexTokenUsage;
  sessionId?: string;
  currentTurn: string;
  structuredTurns: Set<string>;
  responseIds: Set<string>;
  legacyRecordTurns: Map<number, string>;
  /** From this rollout's own (first) session_meta. */
  isSubagent: boolean;
  /** Whether this rollout has started a turn of its own yet. */
  taskStarted: boolean;
  /** Whether this rollout opened with a `compacted` (carried-over) history. */
  sawCompacted: boolean;
}

function defaultState(): CodexParseState {
  return {
    currentModel: "unknown",
    project: "codex",
    cwd: "",
    prevTotal: {},
    currentTurn: "unscoped",
    structuredTurns: new Set(),
    responseIds: new Set(),
    legacyRecordTurns: new Map(),
    isSubagent: false,
    taskStarted: false,
    sawCompacted: false,
  };
}

/**
 * Whether a session_meta payload describes a multi-agent subagent thread.
 * One definition for the file grouping (readSessionMeta) and the records, so
 * the two can't disagree about which rollouts are subagents.
 */
function isSubagentMeta(p: NonNullable<CodexEvent["payload"]>): boolean {
  return (
    p.thread_source === "subagent" ||
    (typeof p.parent_thread_id === "string" && p.parent_thread_id.length > 0) ||
    (typeof p.source === "object" && p.source !== null && "subagent" in p.source)
  );
}

/** Extract project name from cwd path (last directory component). */
function projectFromCwd(cwd: string): string {
  return canonicalizeProjectName(cwd, "codex");
}

/** Compute delta between current and previous cumulative totals. */
function computeDelta(current: CodexTokenUsage, prev: CodexTokenUsage): CodexTokenUsage {
  return {
    input_tokens: Math.max(0, (current.input_tokens ?? 0) - (prev.input_tokens ?? 0)),
    cached_input_tokens: Math.max(
      0,
      (current.cached_input_tokens ?? 0) - (prev.cached_input_tokens ?? 0)
    ),
    output_tokens: Math.max(0, (current.output_tokens ?? 0) - (prev.output_tokens ?? 0)),
    reasoning_output_tokens: Math.max(
      0,
      (current.reasoning_output_tokens ?? 0) - (prev.reasoning_output_tokens ?? 0)
    ),
  };
}

/**
 * Lightweight session fingerprint read from the first few lines of a rollout
 * file — enough to group siblings without parsing the whole file twice.
 */
interface CodexFileMeta {
  file: string;
  sessionId: string;
  forkedFromId: string | null;
  /**
   * True when this rollout is a multi-agent subagent thread (codex 0.144+).
   * Subagent files hold disjoint per-thread usage with fresh counters — they
   * must NEVER enter fork-sibling dedup, or a parallel fan-out collapses to
   * one counted file and the rest of the day's usage silently vanishes.
   */
  isSubagent: boolean;
  mtimeMs: number;
  /**
   * File size on disk. Used as the tiebreaker for fork-sibling dedup instead
   * of mtimeMs — size is strictly monotonic per file (codex JSONL is append-
   * only), so the "winner" never swaps backwards as quiet siblings get
   * touched. mtime-based dedup caused today flux: an mtime tick on an older
   * sibling with smaller cumulative content would briefly become the winner,
   * dropping today's total. Size keeps the most-complete fork winning.
   */
  sizeBytes: number;
}

// ─── Compressed rollouts ──────────────────────────────────────────────────
//
// Codex compresses an idle rollout to `rollout-….jsonl.zst` and keeps no
// `.jsonl` twin. Reading only `.jsonl` made 46,452 of 55,691 receipts since
// 2026-09-03 invisible (measured 2026-10-18), and a day whose files were
// compressed before it sealed lost them for good.

/**
 * zstd landed in node:zlib in Node 22.15 / 23.8. A named import of it throws at
 * module load on older Node and takes the whole CLI down, so it is read off the
 * namespace and checked here; without it, compressed rollouts are skipped and
 * the scan says so.
 */
export const ZSTD_SUPPORTED =
  typeof zlib.zstdDecompressSync === "function" && typeof zlib.createZstdDecompress === "function";

/** A Codex rollout file, plain or zstd-compressed (when this Node can inflate it). */
export function isCodexRollout(file: string, zstd = ZSTD_SUPPORTED): boolean {
  return file.endsWith(".jsonl") || (zstd && file.endsWith(".jsonl.zst"));
}

function isZst(file: string): boolean {
  return file.endsWith(".zst");
}

/**
 * Decompressed size of a zstd file, from its frame header's content-size
 * field (every Codex rollout sampled carries it, and it matched the real
 * length on every file checked). An absent size is treated as large so the
 * caller streams it; never inflate attacker-controlled compressed input just
 * to decide which parsing path to use.
 * Fork dedup keeps the largest file of a session family, so it must compare
 * contents, not compressed bytes — or a compressed parent loses to a smaller
 * fork and its records disappear.
 */
export function zstContentSize(file: string): number {
  try {
    const fd = openSync(file, "r");
    const b = Buffer.alloc(18);
    try {
      readSync(fd, b, 0, 18, 0);
    } finally {
      closeSync(fd);
    }
    if (b.readUInt32LE(0) === 0xfd2fb528) {
      const d = b[4] as number;
      const fcsFlag = d >> 6;
      const single = (d >> 5) & 1;
      const offset = 5 + (single ? 0 : 1) + ([0, 1, 2, 4][d & 3] as number);
      const n = fcsFlag === 0 ? (single ? 1 : 0) : ([1, 2, 4, 8][fcsFlag] as number);
      if (n === 1) return b[offset] as number;
      if (n === 2) return b.readUInt16LE(offset) + 256;
      if (n === 4) return b.readUInt32LE(offset);
      if (n === 8) return Number(b.readBigUInt64LE(offset));
    }
    return -1;
  } catch {
    return 0;
  }
}

/** Content size of a rollout: the file size, or the decompressed size for .zst. */
async function rolloutSize(file: string): Promise<number> {
  if (isZst(file)) {
    const headerSize = zstContentSize(file);
    return headerSize >= 0 ? headerSize : countZstContentSize(file);
  }
  return (await stat(file)).size;
}

/** Whole decompressed text of a small .zst rollout. */
function readZstText(file: string): string {
  return zlib.zstdDecompressSync(readFileSync(file)).toString("utf-8");
}

/** Decompressed stream of a .zst rollout, for files too large to inflate whole. */
async function zstStream(file: string): Promise<NodeJS.ReadableStream> {
  const { createReadStream } = await import("node:fs");
  return createReadStream(file).pipe(zlib.createZstdDecompress());
}

const CODEX_MAX_LINE_CHARS = 8 * 1024 * 1024;
const CODEX_MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
const CODEX_MAX_RECORDS = 600_000;

/** Count an unknown-FCS zstd stream without buffering it. The capped value is
 * still enough to route it through the large-file parser and prevents a
 * decompression bomb from dominating fork selection through Infinity. */
async function countZstContentSize(file: string): Promise<number> {
  const stream = (await zstStream(file)) as NodeJS.ReadableStream & { destroy(): void };
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += (chunk as Buffer).length;
      if (total > CODEX_MAX_DECOMPRESSED_BYTES) return CODEX_MAX_DECOMPRESSED_BYTES + 1;
    }
    return total;
  } finally {
    stream.destroy();
  }
}

/** Per-file counts of lines that could not be folded. */
interface CodexLineCounts {
  oversized: number;
  malformed: number;
  /** Malformed lines that looked like token telemetry: possible lost usage. */
  malformedUsage: number;
}

/**
 * Fold a decompressed (string) stream line by line. A line over the cap is
 * skipped — dropped as it streams, never buffered — and parsing resumes at the
 * next line; it used to throw and truncate the rest of the rollout.
 */
async function foldCodexStream(
  stream: NodeJS.ReadableStream & { destroy(): void },
  foldLine: (line: string) => void,
  counts: CodexLineCounts,
  maxBytes: number | undefined
): Promise<void> {
  let pending = "";
  let discarding = false;
  let bytes = 0;
  stream.setEncoding?.("utf8");

  for await (const rawChunk of stream) {
    const chunk = typeof rawChunk === "string" ? rawChunk : (rawChunk as Buffer).toString("utf8");
    bytes += Buffer.byteLength(chunk);
    if (maxBytes !== undefined && bytes > maxBytes) {
      throw new Error(`decompressed read limit (${maxBytes} bytes) exceeded`);
    }
    let from = 0;
    let newline = chunk.indexOf("\n", from);
    while (newline >= 0) {
      if (discarding) discarding = false;
      else foldLine(pending + chunk.slice(from, newline));
      pending = "";
      from = newline + 1;
      newline = chunk.indexOf("\n", from);
    }
    if (!discarding) {
      pending += chunk.slice(from);
      if (pending.length > CODEX_MAX_LINE_CHARS) {
        counts.oversized++;
        discarding = true;
        pending = "";
      }
    }
  }
  if (!discarding && pending.trim()) foldLine(pending);
}

/** First `limit` decompressed bytes of a .zst rollout, without inflating the rest. */
async function readZstHead(file: string, limit: number): Promise<string> {
  const stream = (await zstStream(file)) as NodeJS.ReadableStream & { destroy(): void };
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const b = chunk as Buffer;
      chunks.push(b);
      total += b.length;
      if (total >= limit) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf-8");
}

/**
 * Read just the first handful of lines of a codex rollout to extract the
 * `session_meta` event. We cap the read at 64 KB so this stays cheap on
 * 86 MB files — `session_meta` is always one of the first events emitted.
 */
async function readSessionMeta(
  file: string,
  onWarning?: (message: string) => void
): Promise<CodexFileMeta> {
  const { open } = await import("node:fs/promises");
  let sessionId = "";
  let forkedFromId: string | null = null;
  let isSubagent = false;
  let mtimeMs = 0;
  let sizeBytes = 0;
  try {
    const st = await stat(file);
    mtimeMs = st.mtimeMs;
    sizeBytes = isZst(file) ? await rolloutSize(file) : st.size;
    const fd = await open(file, "r");
    try {
      let text: string;
      if (isZst(file)) {
        // session_meta is among the first events; decompress and keep the head.
        text = await readZstHead(file, 65_536);
      } else {
        const buf = Buffer.alloc(Math.min(65_536, st.size));
        await fd.read(buf, 0, buf.length, 0);
        text = buf.toString("utf-8");
      }
      // Scan the first few JSONL lines for a session_meta event.
      const lines = text.split("\n").slice(0, 20);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as CodexEvent;
          if (evt.type === "session_meta" && evt.payload) {
            // FIRST session_meta only — subagent rollouts append a replay of
            // the PARENT's session_meta right after their own, and reading
            // that one would misattribute the file to the parent thread.
            const p = evt.payload;
            sessionId = p.id ?? "";
            forkedFromId = p.forked_from_id ?? null;
            isSubagent = isSubagentMeta(p);
            break;
          }
        } catch {
          // partial line — ignore
        }
      }
    } finally {
      await fd.close();
    }
  } catch (error) {
    onWarning?.(
      `failed metadata read of ${file}: ${error instanceof Error ? error.message : error}`
    );
    // Fail open into a standalone group. Parsing gets another chance to read
    // it, while the warning prevents authoritative persistence this scan.
    return { file, sessionId: file, forkedFromId: null, isSubagent: false, mtimeMs, sizeBytes };
  }
  if (!sessionId) {
    // No session_meta found — fall back to the file path as a stable key so
    // the file is still parsed standalone (no dedup group, keeps it safe).
    sessionId = file;
  }
  return { file, sessionId, forkedFromId, isSubagent, mtimeMs, sizeBytes };
}

/**
 * Read a rollout's NEWEST event timestamp cheaply by tailing the last chunk of
 * the file. Codex rollouts are append-only JSONL, so the newest event is the
 * last complete line — we never have to read the whole (possibly 190 MB) file.
 *
 * Returns the newest event time in ms, or null when we can't determine one
 * (empty file, no parseable timestamp in the tail, read error). Callers must
 * treat null as "unknown → don't skip" so we never silently drop real data.
 */
async function newestEventMs(file: string, sizeBytes: number): Promise<number | null> {
  // A compressed tail can't be read without decompressing. Unknown fails open
  // (the file is parsed); only rollouts compressed since the watermark get
  // here, because the mtime prefilter already dropped the rest.
  if (sizeBytes === 0 || isZst(file)) return null;
  const { open } = await import("node:fs/promises");
  try {
    const fd = await open(file, "r");
    try {
      // 64 KB tail comfortably holds the last few JSONL lines even for very
      // long single events. Back up from EOF so we read a clean-ish boundary.
      const tail = Math.min(65_536, sizeBytes);
      const readFrom = sizeBytes - tail;
      const buf = Buffer.alloc(tail);
      await fd.read(buf, 0, tail, readFrom);
      const text = buf.toString("utf-8");
      // Drop the leading fragment (partial line from mid-record read) and scan
      // upward from the end for the newest event carrying a timestamp.
      const lines = text.split("\n").filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const evt = JSON.parse(lines[i]!) as CodexEvent;
          if (evt.timestamp) {
            const t = new Date(evt.timestamp).getTime();
            if (!Number.isNaN(t)) return t;
          }
        } catch {
          // partial / non-JSON line — keep scanning upward
        }
      }
      return null;
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

/**
 * Walk the fork chain back to the root ancestor. If a file's forked_from_id
 * points to a session we have on disk, keep climbing. Otherwise the current
 * session is its own root.
 */
function resolveRoot(meta: CodexFileMeta, bySessionId: Map<string, CodexFileMeta>): string {
  let current: CodexFileMeta | undefined = meta;
  const seen = new Set<string>();
  while (current?.forkedFromId) {
    if (seen.has(current.sessionId)) break; // cycle guard
    seen.add(current.sessionId);
    const parent = bySessionId.get(current.forkedFromId);
    if (!parent) return current.forkedFromId; // root is upstream-only
    // Never climb THROUGH a subagent boundary: a fork edge into a subagent
    // is a resume OF that subagent thread, and it must compete within that
    // thread's group — climbing on to the spawner's root would let a large
    // resume evict the spawning session's own file (data loss) while the
    // subagent file it replays is still kept standalone (double count).
    if (parent.isSubagent) return parent.sessionId;
    current = parent;
  }
  return current?.sessionId ?? meta.sessionId;
}

/**
 * Given a list of rollout files, keep only one file per root-ancestor session
 * group. The winner is the LARGEST sibling by bytes on disk — codex rollouts
 * are append-only JSONL, so size is monotonic per file and a fork that
 * replays its ancestor's history is at least as large as the ancestor. Size
 * also doesn't tick backwards under any benign condition (mtime can, if a
 * filesystem tool touches a quiet sibling), so today's total stays stable
 * across scans rather than swapping winners under the user.
 *
 * Tiebreaker: latest mtime, then path order. Both are deterministic.
 *
 * Subagent rollouts (`thread_source: "subagent"`) never join their spawner's
 * group — each forms its own group keyed by its own session id. See the
 * header comment: they are parallel disjoint threads, not replays.
 */
async function dedupForkedFiles(
  files: string[],
  onWarning?: (message: string) => void
): Promise<string[]> {
  const metas = await mapWithConcurrency(files, CODEX_SCAN_CONCURRENCY, (f) =>
    readSessionMeta(f, onWarning)
  );

  const bySessionId = new Map<string, CodexFileMeta>();
  for (const m of metas) bySessionId.set(m.sessionId, m);

  const winnerByRoot = new Map<string, CodexFileMeta>();
  for (const m of metas) {
    // Subagent threads (multi-agent v2) are disjoint parallel usage, not
    // replays — each is its OWN group, keyed by its own session id, so a
    // fan-out of N siblings yields N winners. Own-id keying (rather than an
    // unconditional keep) still collapses byte-duplicate copies of the same
    // subagent file, and lets a resume OF a subagent (a fork edge whose
    // target is the subagent — resolveRoot stops there) compete keep-largest
    // within that one thread instead of being double-counted beside it.
    const root = m.isSubagent ? m.sessionId : resolveRoot(m, bySessionId);
    const existing = winnerByRoot.get(root);
    if (!existing) {
      winnerByRoot.set(root, m);
      continue;
    }
    if (m.sizeBytes > existing.sizeBytes) {
      winnerByRoot.set(root, m);
    } else if (m.sizeBytes === existing.sizeBytes && m.mtimeMs > existing.mtimeMs) {
      winnerByRoot.set(root, m);
    }
  }
  return [...winnerByRoot.values()].map((m) => m.file);
}

/**
 * Files at/above this size are parsed ALONE and streamed line-by-line, so a
 * single fork-replay monster (rollouts hit 200 MB+) can never balloon memory
 * during a full-history rebuild. Smaller files are cheap and get batched.
 */
const CODEX_LARGE_FILE_BYTES = 8_000_000;

/**
 * Apply one codex event to the running per-file parse state, pushing a record
 * when a token_count event yields non-zero delta usage. Extracted so the
 * whole-read path (small files) and the streamed path (large files) share ONE
 * implementation — the parse semantics must not drift between them.
 */
function foldCodexEvent(
  evt: CodexEvent,
  state: CodexParseState,
  file: string,
  out: TokenRecord[]
): void {
  if (!evt.type) return;
  if (evt.type === "compacted" && !state.taskStarted) state.sawCompacted = true;
  if (evt.type === "session_meta" && evt.payload?.id && !state.sessionId) {
    // FIRST session_meta only: a subagent rollout replays its parent's next.
    state.sessionId = evt.payload.id;
    state.isSubagent = isSubagentMeta(evt.payload);
  }
  if (evt.type === "session_meta" && evt.payload?.cwd) {
    state.project = projectFromCwd(evt.payload.cwd);
    state.cwd = evt.payload.cwd;
  }
  if (evt.type === "turn_context" && evt.payload?.model) {
    state.currentModel = evt.payload.model;
  }
  const payload = evt.payload;
  if (!payload) return;
  if (
    evt.type === "turn_context" ||
    (evt.type === "event_msg" && payload.type === "task_started")
  ) {
    if (payload.turn_id) state.currentTurn = payload.turn_id;
  }
  if (evt.type === "event_msg" && payload.type === "task_started") state.taskStarted = true;

  let usage: CodexTokenUsage;
  const structured = evt.type === "token_usage_record";
  if (structured) {
    if (!isCodexTokenUsage(payload.usage)) return;
    // Forked subagents may replay their parent's history. Only the owning
    // thread's response receipts represent fresh work in this rollout.
    if (state.sessionId && payload.thread_id && payload.thread_id !== state.sessionId) return;
    const turn = payload.turn_id ?? state.currentTurn;
    state.structuredTurns.add(turn);
    if (payload.response_id) {
      if (state.responseIds.has(payload.response_id)) return;
      state.responseIds.add(payload.response_id);
    }
    // These are per-response facts. thread_token_usage can begin with a
    // historical baseline or reset on resume; never book it as new usage.
    usage = payload.usage;
    if (payload.thread_token_usage) state.prevTotal = { ...payload.thread_token_usage };
  } else {
    if (evt.type !== "event_msg" || payload.type !== "token_count") return;
    const info = payload.info;
    if (!info) return;
    if (info.total_token_usage && !state.taskStarted && state.sawCompacted) {
      // A cumulative counter written before this rollout started any turn of
      // its own is INHERITED, not spent here. A guardian_review thread that
      // continues in a new rollout opens with a `compacted` history and then
      // a token_count carrying the previous rollout's final totals (e.g.
      // 162,492 = the predecessor's last total; its last_token_usage is the
      // predecessor's last response, already counted there). Booking it as a
      // delta from zero double-counted every continuation — 15 phantom
      // records and 1.07M input / 7.3M cache-read tokens on 2026-10-24 alone.
      // Across 3,971 rollouts, only these 29 continuations write a counter
      // before their first task_started, and every one follows a `compacted`
      // carry-over — the two signals together mark it as inherited. Take it
      // as the baseline.
      state.prevTotal = { ...info.total_token_usage };
      return;
    }
    if (info.total_token_usage) {
      usage = computeDelta(info.total_token_usage, state.prevTotal);
      state.prevTotal = { ...info.total_token_usage };
    } else if (info.last_token_usage) {
      usage = info.last_token_usage;
    } else {
      return;
    }
  }

  const totalInput = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const inputTokens = Math.max(0, totalInput - cached);
  // Codex reports reasoning_output_tokens as a sub-bucket of output_tokens:
  // its own total_tokens is input_tokens + output_tokens, not input + output
  // + reasoning. Keep Tokmeter's buckets mutually exclusive so every surface
  // (model table, provider total, daily chart, and pricing) reaches Codex's
  // reported total instead of counting thought tokens a second time.
  const rawOutputTokens = usage.output_tokens ?? 0;
  const reasoningTokens = Math.min(usage.reasoning_output_tokens ?? 0, rawOutputTokens);
  const outputTokens = rawOutputTokens - reasoningTokens;
  if (inputTokens === 0 && outputTokens === 0 && cached === 0 && reasoningTokens === 0) return;

  if (!structured) state.legacyRecordTurns.set(out.length, payload.turn_id ?? state.currentTurn);
  out.push(
    createRecord({
      timestamp: evt.timestamp ? new Date(evt.timestamp).getTime() : Date.now(),
      provider: "codex",
      model: state.currentModel,
      project: state.project,
      cwd: state.cwd || undefined,
      sourceFile: file,
      inputTokens,
      outputTokens,
      cacheReadTokens: cached,
      reasoningTokens,
      // The provider's own per-response id: the stable key for anything that
      // must recognise the same response across scans and files.
      ...(structured && payload.response_id ? { apiCallId: payload.response_id } : {}),
      // Subagent cost is its own line in the signals (subagentToday); Codex
      // knew which rollouts were subagents but never said so on the records.
      ...(state.isSubagent ? { isSubagent: true } : {}),
    })
  );
}

/**
 * Parse ONE rollout into its records. Large files stream line-by-line via
 * readline (never buffering the whole file); small files use the plain whole
 * read. Either way the caller gets just this file's records — to fold and drop
 * — so peak memory is bounded to a single file, not the whole corpus.
 */
export async function parseCodexFile(
  file: string,
  sizeBytes: number,
  onWarning?: (message: string, detail?: ScanFaultDetail) => void,
  onNotice?: (message: string) => void
): Promise<TokenRecord[]> {
  const out: TokenRecord[] = [];
  const state = defaultState();
  const counts: CodexLineCounts = { oversized: 0, malformed: 0, malformedUsage: 0 };
  const foldLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt: CodexEvent;
    try {
      evt = JSON.parse(trimmed) as CodexEvent;
    } catch {
      // Skip, don't truncate: one bad line must not hide every later
      // response in the rollout.
      counts.malformed++;
      if (/"(token_usage_record|token_count)"/.test(trimmed)) counts.malformedUsage++;
      return;
    }
    foldCodexEvent(evt, state, file, out);
    if (out.length > CODEX_MAX_RECORDS) {
      throw new Error(`record limit (${CODEX_MAX_RECORDS}) exceeded`);
    }
  };
  try {
    if (isZst(file) && sizeBytes < CODEX_LARGE_FILE_BYTES) {
      for (const line of readZstText(file).split("\n")) foldLine(line);
    } else if (isZst(file)) {
      // A large compressed rollout streams through the decompressor, so peak
      // memory stays one line, not the inflated file.
      const stream = (await zstStream(file)) as NodeJS.ReadableStream & { destroy(): void };
      try {
        await foldCodexStream(stream, foldLine, counts, CODEX_MAX_DECOMPRESSED_BYTES);
      } finally {
        stream.destroy();
      }
    } else {
      // Plain rollouts of any size stream one bounded line at a time; an
      // unterminated last line (a write in flight) is left for the next scan.
      const visit = await visitJsonlLines(file, 0, foldLine);
      counts.oversized += visit.oversizedLines;
      if (visit.inFlightTail) {
        // May be a response from before midnight: hold a seal of any day the
        // unread tail could belong to (it is newer than every record read).
        onWarning?.(`a line in ${file} is still being written`, {
          file,
          readThroughMs: out.at(-1)?.timestamp,
        });
      }
    }
  } catch (error) {
    // FAIL SOFT, per file. A mid-stream read error (the file rotated/deleted
    // by an active session between stat() and read, EACCES/EIO, an evicted
    // iCloud file) must NOT abort the whole codex provider: return what was
    // parsed before the fault. The fault is never SILENT — a windowed rescan
    // that didn't know the result was partial once overwrote a good sealed day
    // with the truncated one (2026-07-12) — and it names the file and how far
    // the read got, so a seal can tell whether the fault touches its day.
    onWarning?.(`truncated read of ${file}: ${error instanceof Error ? error.message : error}`, {
      file,
      readThroughMs: out.at(-1)?.timestamp,
    });
  }
  if (counts.oversized > 0) {
    // Token telemetry lines are a few hundred bytes; an 8 MiB line is a tool
    // output or a compaction payload, never usage.
    onNotice?.(`skipped ${counts.oversized} oversized line(s) in ${file}`);
  }
  if (counts.malformedUsage > 0) {
    onWarning?.(
      `skipped ${counts.malformed} malformed line(s) in ${file}, ${counts.malformedUsage} of them token telemetry`,
      { file }
    );
  } else if (counts.malformed > 0) {
    onNotice?.(`skipped ${counts.malformed} malformed line(s) in ${file}`);
  }
  // Recent CLI versions mirror the same responses in BOTH event formats.
  // Choose the response ledger for each covered turn, independent of event
  // ordering, while retaining old-format turns in long-lived sessions.
  return out.filter((_, index) => {
    const turn = state.legacyRecordTurns.get(index);
    return turn === undefined || !state.structuredTurns.has(turn);
  });
}

export class CodexParser implements SessionParser {
  readonly providerId = "codex" as const;

  /** Paths this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return codexSessionDirs("codex", homeDir);
  }

  /**
   * Collect every record. Thin wrapper over {@link scanStreaming} — for bounded
   * scopes (today, a date range) the set is small, so accumulating is fine. The
   * memory-sensitive full/window rebuild uses scanStreaming directly to fold and
   * release per file.
   */
  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const all: TokenRecord[] = [];
    await this.scanStreaming(homeDir, opts, (records) => {
      for (const r of records) all.push(r);
    });
    return all;
  }

  /**
   * Stream the scan file-by-file, handing each rollout's records to `onFile` so
   * the caller can fold + release them. Peak memory is one large file (or a
   * batch of small ones), never the whole corpus. Same file resolution +
   * fork-dedup as scan(); only the parse is chunked.
   */
  async scanStreaming(
    homeDir: string,
    opts: ScanFilterOptions | undefined,
    onFile: (records: TokenRecord[]) => void | Promise<void>
  ): Promise<void> {
    // Sessions are in YYYY/MM/DD/ subdirectories — need depth 5
    const seenFiles = new Set<string>();
    let allFiles: string[] = [];
    for (const dir of this.sessionRoots(homeDir)) {
      for (const f of await findFiles(dir, isCodexRollout, 5)) {
        if (seenFiles.has(f)) continue;
        seenFiles.add(f);
        allFiles.push(f);
      }
    }
    if (!ZSTD_SUPPORTED) {
      let skipped = 0;
      for (const dir of this.sessionRoots(homeDir)) {
        skipped += (await findFiles(dir, (f) => f.endsWith(".jsonl.zst"), 5)).length;
      }
      if (skipped > 0) {
        opts?.onWarning?.(
          `${skipped} compressed Codex rollouts (.jsonl.zst) skipped: Node ${process.versions.node} has no zstd; Node 22.15+ reads them`
        );
      }
    }
    // Today-only scans skip files untouched since the watermark BEFORE the
    // (expensive) fork-dedup + full re-parse. Codex keeps no record cache, so
    // this is the single biggest win: a today refresh stops cold-reading
    // months of rollout-*.jsonl and reads only today's couple of files.
    if (opts?.modifiedSinceMs !== undefined) {
      const watermark = opts.modifiedSinceMs;
      // Two filters, in order of cost. The rule that keeps this correct:
      // a file may only be DROPPED by its real newest EVENT time — never by
      // mtime, and never by its path/start date.
      //
      // Why not path/filename date: codex writes ONE append-only rollout per
      // session under sessions/YYYY/MM/DD of the day the session STARTED, and
      // keeps appending to it for the life of the session. A session begun on
      // Jun 14 but still active today lives at 2026/06/14/rollout-…jsonl — its
      // path says Jun 14, its newest events are today. Dropping by path date
      // silently zeroes today's biggest active session (a permanent undercount
      // once the day seals). Path date is the session START, not its data date.
      //
      // (1) mtime prefilter — CHEAP, and only ever OVER-keeps. An appended event
      // IS a write, so any file carrying events >= the watermark has mtime >=
      // the watermark: mtime can never drop a file that has real recent data. It
      // over-keeps rewritten-but-stale files (a blanked/backed-up old rollout) —
      // that's fine, (2) prunes those precisely and cheaply.
      allFiles = await filterFilesByMtime(allFiles, watermark);
      // (2) newest-EVENT-time — the real drop authority. A 64 KB tail read gives
      // the file's newest event timestamp (append-only ⇒ newest is last). Drop
      // only when we positively know the newest event predates the watermark;
      // null (no parseable timestamp / read error) fails OPEN so we never lose
      // real data. Concurrency-capped so hundreds of masquerade files can't jam
      // the event loop the way the old unbounded Promise.all did.
      const newest = await mapWithConcurrency(allFiles, CODEX_SCAN_CONCURRENCY, async (f) => {
        try {
          const st = await stat(f);
          return await newestEventMs(f, st.size);
        } catch {
          return null;
        }
      });
      allFiles = allFiles.filter((_, i) => {
        const t = newest[i];
        return t === null || t >= watermark;
      });
    }
    const files = await dedupForkedFiles(allFiles, opts?.onWarning);

    // Stat the winners once, then split by size. Large files are parsed ALONE
    // and streamed line-by-line (a 200 MB fork-replay rollout never overlaps
    // another); small files batch concurrently — they're cheap. Each file's
    // records go to `onFile` and are then released, so peak memory is bounded
    // to a single large file, not the whole history (which OOM'd the box).
    const sized = await mapWithConcurrency(files, CODEX_SCAN_CONCURRENCY, async (f) => {
      try {
        return { file: f, size: await rolloutSize(f) };
      } catch (error) {
        opts?.onWarning?.(
          `failed size read of ${f}: ${error instanceof Error ? error.message : error}`
        );
        return { file: f, size: 0 };
      }
    });
    const large = sized.filter((f) => f.size >= CODEX_LARGE_FILE_BYTES);
    const small = sized.filter((f) => f.size < CODEX_LARGE_FILE_BYTES);

    // Big ones: strictly one at a time.
    for (const f of large) {
      await onFile(await parseCodexFile(f.file, f.size, opts?.onWarning, opts?.onNotice));
    }
    // Small ones: a bounded concurrent batch. onFile's fold is synchronous, so
    // interleaved awaits here can't corrupt the caller's accumulators.
    await mapWithConcurrency(small, CODEX_SCAN_CONCURRENCY, async (f) => {
      await onFile(await parseCodexFile(f.file, f.size, opts?.onWarning, opts?.onNotice));
    });
  }
}
