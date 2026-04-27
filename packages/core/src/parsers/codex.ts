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
import type { SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, findFiles, readJsonlFile } from "./utils.js";

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
  try {
    const st = await stat(file);
    mtimeMs = st.mtimeMs;
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
  return { file, sessionId, forkedFromId, mtimeMs };
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
 * group. The winner is the most-recently-modified sibling — that's the file
 * representing the latest post-resume state, which is typically the one the
 * user actually cares about.
 */
async function dedupForkedFiles(files: string[]): Promise<string[]> {
  const metas = (await Promise.all(files.map((f) => readSessionMeta(f)))).filter(
    (m): m is CodexFileMeta => m !== null
  );

  const bySessionId = new Map<string, CodexFileMeta>();
  for (const m of metas) bySessionId.set(m.sessionId, m);

  const latestByRoot = new Map<string, CodexFileMeta>();
  for (const m of metas) {
    const root = resolveRoot(m, bySessionId);
    const existing = latestByRoot.get(root);
    if (!existing || m.mtimeMs > existing.mtimeMs) {
      latestByRoot.set(root, m);
    }
  }
  return [...latestByRoot.values()].map((m) => m.file);
}

export class CodexParser implements SessionParser {
  readonly providerId = "codex" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    // Respect CODEX_HOME env var, fall back to ~/.codex
    const codexHome = process.env.CODEX_HOME
      ? process.env.CODEX_HOME
      : expandHome("~/.codex", homeDir);
    const sessionsDir = `${codexHome}/sessions`;

    // Sessions are in YYYY/MM/DD/ subdirectories — need depth 5
    const allFiles = await findFiles(sessionsDir, (f) => f.endsWith(".jsonl"), 5);
    const files = await dedupForkedFiles(allFiles);
    const records: TokenRecord[] = [];

    for (const file of files) {
      const lines = await readJsonlFile<CodexEvent>(file);
      const state = defaultState();

      for (const evt of lines) {
        if (!evt.type) continue;

        // Track session metadata for project identification
        if (evt.type === "session_meta" && evt.payload) {
          if (evt.payload.cwd) {
            state.project = projectFromCwd(evt.payload.cwd);
            state.cwd = evt.payload.cwd;
          }
        }

        // Track model changes from turn_context
        if (evt.type === "turn_context" && evt.payload?.model) {
          state.currentModel = evt.payload.model;
        }

        // Extract token usage from token_count events
        if (evt.type !== "event_msg") continue;
        const payload = evt.payload;
        if (!payload || payload.type !== "token_count") continue;
        const info = payload.info;
        if (!info) continue;

        // Prefer delta from total_token_usage for accuracy.
        let usage: CodexTokenUsage;
        if (info.total_token_usage) {
          usage = computeDelta(info.total_token_usage, state.prevTotal);
          state.prevTotal = { ...info.total_token_usage };

          // If delta is all zeros, skip this event — no new tokens were consumed.
          // The old code fell back to last_token_usage here, but last_token_usage
          // is per-turn CUMULATIVE (not a delta), so using it when the total hasn't
          // changed creates exact duplicates (~7% of Codex records were duped).
          const deltaSum =
            (usage.input_tokens ?? 0) +
            (usage.output_tokens ?? 0) +
            (usage.cached_input_tokens ?? 0) +
            (usage.reasoning_output_tokens ?? 0);
          if (deltaSum === 0) continue;
        } else if (info.last_token_usage) {
          // Fallback: some events only have last_token_usage (no cumulative).
          // This path fires for events where total_token_usage is absent.
          usage = info.last_token_usage;
        } else {
          continue;
        }

        // OpenAI reports input_tokens as TOTAL (including cached). Subtract the
        // cached portion so we match Anthropic semantics: inputTokens = uncached,
        // cacheReadTokens = cached. This prevents the cost calculator from double-
        // charging cached tokens (once at full rate, once at cache rate).
        const totalInput = usage.input_tokens ?? 0;
        const cached = usage.cached_input_tokens ?? 0;
        const inputTokens = Math.max(0, totalInput - cached);
        const outputTokens = usage.output_tokens ?? 0;
        if (inputTokens === 0 && outputTokens === 0 && cached === 0) continue;

        records.push(
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
            reasoningTokens: usage.reasoning_output_tokens ?? 0,
          })
        );
      }
    }
    return records;
  }
}
