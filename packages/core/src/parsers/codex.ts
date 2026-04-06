/**
 * @sriinnu/tokmeter-core — Codex CLI session parser.
 *
 * Reads from $CODEX_HOME/sessions/ or ~/.codex/sessions/
 * Sessions are stored in YYYY/MM/DD/ subdirectories as .jsonl files.
 *
 * Format: RolloutItem events (session_meta, turn_context, event_msg, etc.)
 * Token data comes from event_msg with type "token_count".
 */

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
  prevTotal: CodexTokenUsage;
}

function defaultState(): CodexParseState {
  return {
    currentModel: "gpt-4o",
    project: "codex",
    prevTotal: {},
  };
}

/** Extract project name from cwd path (last directory component). */
function projectFromCwd(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "codex";
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

export class CodexParser implements SessionParser {
  readonly providerId = "codex" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    // Respect CODEX_HOME env var, fall back to ~/.codex
    const codexHome = process.env.CODEX_HOME
      ? process.env.CODEX_HOME
      : expandHome("~/.codex", homeDir);
    const sessionsDir = `${codexHome}/sessions`;

    // Sessions are in YYYY/MM/DD/ subdirectories — need depth 5
    const files = await findFiles(sessionsDir, (f) => f.endsWith(".jsonl"), 5);
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

        // Prefer delta from total_token_usage for accuracy
        let usage: CodexTokenUsage;
        if (info.total_token_usage) {
          usage = computeDelta(info.total_token_usage, state.prevTotal);
          state.prevTotal = { ...info.total_token_usage };

          // If delta is all zeros but last_token_usage has data, use that
          const deltaSum = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
          if (deltaSum === 0 && info.last_token_usage) {
            const lastSum =
              (info.last_token_usage.input_tokens ?? 0) +
              (info.last_token_usage.output_tokens ?? 0);
            if (lastSum > 0) {
              usage = info.last_token_usage;
            }
          }
        } else if (info.last_token_usage) {
          usage = info.last_token_usage;
        } else {
          continue;
        }

        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        if (inputTokens === 0 && outputTokens === 0) continue;

        records.push(
          createRecord({
            timestamp: evt.timestamp ? new Date(evt.timestamp).getTime() : Date.now(),
            provider: "codex",
            model: state.currentModel,
            project: state.project,
            sourceFile: file,
            inputTokens,
            outputTokens,
            cacheReadTokens: usage.cached_input_tokens ?? 0,
            reasoningTokens: usage.reasoning_output_tokens ?? 0,
          })
        );
      }
    }
    return records;
  }
}
