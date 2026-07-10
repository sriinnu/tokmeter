/**
 * @sriinnu/tokmeter-core — Codex CLI session parser.
 *
 * Reads from $CODEX_HOME/sessions/ or ~/.codex/sessions/
 * Sessions are stored in YYYY/MM/DD/ subdirectories as .jsonl files.
 *
 * Format: RolloutItem events (session_meta, turn_context, event_msg, etc.)
 * Token data comes from event_msg with type "token_count".
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
 */

import { stat } from "node:fs/promises";

import { canonicalizeProjectName } from "../project-name.js";
import type { ProviderId, ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  filterFilesByMtime,
  findFiles,
  getConfiguredProviderPaths,
  mapWithConcurrency,
  readJsonlFile,
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
    // session_meta fields (payload when type is "session_meta")
    id?: string;
    forked_from_id?: string;
    cwd?: string;
    source?: string;
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
}

function defaultState(): CodexParseState {
  return {
    currentModel: "gpt-4o",
    project: "codex",
    cwd: "",
    prevTotal: {},
  };
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

/**
 * Read just the first handful of lines of a codex rollout to extract the
 * `session_meta` event. We cap the read at 64 KB so this stays cheap on
 * 86 MB files — `session_meta` is always one of the first events emitted.
 */
async function readSessionMeta(file: string): Promise<CodexFileMeta | null> {
  const { open } = await import("node:fs/promises");
  let sessionId = "";
  let forkedFromId: string | null = null;
  let mtimeMs = 0;
  let sizeBytes = 0;
  try {
    const st = await stat(file);
    mtimeMs = st.mtimeMs;
    sizeBytes = st.size;
    const fd = await open(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(65_536, st.size));
      await fd.read(buf, 0, buf.length, 0);
      const text = buf.toString("utf-8");
      // Scan the first few JSONL lines for a session_meta event.
      const lines = text.split("\n").slice(0, 20);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as CodexEvent;
          if (evt.type === "session_meta" && evt.payload) {
            sessionId = evt.payload.id ?? "";
            forkedFromId = evt.payload.forked_from_id ?? null;
            break;
          }
        } catch {
          // partial line — ignore
        }
      }
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
  if (!sessionId) {
    // No session_meta found — fall back to the file path as a stable key so
    // the file is still parsed standalone (no dedup group, keeps it safe).
    sessionId = file;
  }
  return { file, sessionId, forkedFromId, mtimeMs, sizeBytes };
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
  if (sizeBytes === 0) return null;
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
 */
async function dedupForkedFiles(files: string[]): Promise<string[]> {
  const metas = (
    await mapWithConcurrency(files, CODEX_SCAN_CONCURRENCY, (f) => readSessionMeta(f))
  ).filter((m): m is CodexFileMeta => m !== null);

  const bySessionId = new Map<string, CodexFileMeta>();
  for (const m of metas) bySessionId.set(m.sessionId, m);

  const winnerByRoot = new Map<string, CodexFileMeta>();
  for (const m of metas) {
    const root = resolveRoot(m, bySessionId);
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
  if (evt.type === "session_meta" && evt.payload?.cwd) {
    state.project = projectFromCwd(evt.payload.cwd);
    state.cwd = evt.payload.cwd;
  }
  if (evt.type === "turn_context" && evt.payload?.model) {
    state.currentModel = evt.payload.model;
  }
  if (evt.type !== "event_msg") return;
  const payload = evt.payload;
  if (!payload || payload.type !== "token_count") return;
  const info = payload.info;
  if (!info) return;

  let usage: CodexTokenUsage;
  if (info.total_token_usage) {
    usage = computeDelta(info.total_token_usage, state.prevTotal);
    state.prevTotal = { ...info.total_token_usage };
    const deltaSum =
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cached_input_tokens ?? 0) +
      (usage.reasoning_output_tokens ?? 0);
    if (deltaSum === 0) return;
  } else if (info.last_token_usage) {
    usage = info.last_token_usage;
  } else {
    return;
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
    })
  );
}

/**
 * Parse ONE rollout into its records. Large files stream line-by-line via
 * readline (never buffering the whole file); small files use the plain whole
 * read. Either way the caller gets just this file's records — to fold and drop
 * — so peak memory is bounded to a single file, not the whole corpus.
 */
export async function parseCodexFile(file: string, sizeBytes: number): Promise<TokenRecord[]> {
  const out: TokenRecord[] = [];
  const state = defaultState();
  if (sizeBytes >= CODEX_LARGE_FILE_BYTES) {
    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");
    const stream = createReadStream(file, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt: CodexEvent;
        try {
          evt = JSON.parse(trimmed) as CodexEvent;
        } catch {
          continue; // skip malformed line
        }
        foldCodexEvent(evt, state, file, out);
      }
    } catch {
      // FAIL SOFT, per file — mirror readJsonlFile's contract. A mid-stream read
      // error (the file rotated/deleted by an active session between stat() and
      // read, EACCES/EIO, an evicted iCloud file) must NOT propagate: without
      // this catch it aborts the ENTIRE codex provider, and a windowed rescan
      // would then overwrite good sealed days with an empty result. Return what
      // we parsed before the fault instead — one bad file costs only that file.
    } finally {
      rl.close();
      stream.destroy(); // rl.close() alone doesn't release the underlying fd
    }
  } else {
    const events = await readJsonlFile<CodexEvent>(file);
    for (const evt of events) foldCodexEvent(evt, state, file, out);
  }
  return out;
}

export class CodexParser implements SessionParser {
  readonly providerId = "codex" as const;

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
    for (const dir of codexSessionDirs("codex", homeDir)) {
      for (const f of await findFiles(dir, (f) => f.endsWith(".jsonl"), 5)) {
        if (seenFiles.has(f)) continue;
        seenFiles.add(f);
        allFiles.push(f);
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
    const files = await dedupForkedFiles(allFiles);

    // Stat the winners once, then split by size. Large files are parsed ALONE
    // and streamed line-by-line (a 200 MB fork-replay rollout never overlaps
    // another); small files batch concurrently — they're cheap. Each file's
    // records go to `onFile` and are then released, so peak memory is bounded
    // to a single large file, not the whole history (which OOM'd the box).
    const sized = await mapWithConcurrency(files, CODEX_SCAN_CONCURRENCY, async (f) => {
      try {
        const st = await stat(f);
        return { file: f, size: st.size };
      } catch {
        return { file: f, size: 0 };
      }
    });
    const large = sized.filter((f) => f.size >= CODEX_LARGE_FILE_BYTES);
    const small = sized.filter((f) => f.size < CODEX_LARGE_FILE_BYTES);

    // Big ones: strictly one at a time.
    for (const f of large) {
      await onFile(await parseCodexFile(f.file, f.size));
    }
    // Small ones: a bounded concurrent batch. onFile's fold is synchronous, so
    // interleaved awaits here can't corrupt the caller's accumulators.
    await mapWithConcurrency(small, CODEX_SCAN_CONCURRENCY, async (f) => {
      await onFile(await parseCodexFile(f.file, f.size));
    });
  }
}
