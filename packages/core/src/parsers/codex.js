/**
 * @sriinnu/tokmeter-core — Codex CLI session parser.
 *
 * Reads from $CODEX_HOME/sessions/ or ~/.codex/sessions/
 * Sessions are stored in YYYY/MM/DD/ subdirectories as .jsonl files.
 *
 * Format: RolloutItem events (session_meta, turn_context, event_msg, etc.)
 * Token data comes from event_msg with type "token_count".
 */
import { canonicalizeProjectName } from "../project-name.js";
import { createRecord, expandHome, findFiles, readJsonlFile } from "./utils.js";
function defaultState() {
  return {
    currentModel: "gpt-4o",
    project: "codex",
    prevTotal: {},
  };
}
/** Extract project name from cwd path (last directory component). */
function projectFromCwd(cwd) {
  return canonicalizeProjectName(cwd, "codex");
}
/** Compute delta between current and previous cumulative totals. */
function computeDelta(current, prev) {
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
export class CodexParser {
  providerId = "codex";
  async scan(homeDir) {
    // Respect CODEX_HOME env var, fall back to ~/.codex
    const codexHome = process.env.CODEX_HOME
      ? process.env.CODEX_HOME
      : expandHome("~/.codex", homeDir);
    const sessionsDir = `${codexHome}/sessions`;
    // Sessions are in YYYY/MM/DD/ subdirectories — need depth 5
    const files = await findFiles(sessionsDir, (f) => f.endsWith(".jsonl"), 5);
    const records = [];
    for (const file of files) {
      const lines = await readJsonlFile(file);
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
        // Prefer delta from total_token_usage for accuracy.
        let usage;
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
