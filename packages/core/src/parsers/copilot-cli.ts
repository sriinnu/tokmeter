/**
 * @sriinnu/tokmeter-core — GitHub Copilot CLI session parser.
 *
 * Reads from ~/.copilot/session-state/<session-id>/events.jsonl
 *
 * This is the standalone Copilot CLI, distinct from the VS Code Copilot Chat
 * extension handled by the vscode-copilot parser.
 *
 * Two sources of usage:
 *   - `assistant.message` carries that response's `outputTokens`, stamped when
 *     it happened. Summed per model they equal the shutdown rollup's output.
 *   - `session.shutdown` writes the authoritative per-model rollup:
 *       data.modelMetrics[model].usage = { inputTokens, outputTokens,
 *         cacheReadTokens, cacheWriteTokens, reasoningTokens }
 *       data.modelMetrics[model].requests.cost = premium-request credits, NOT USD
 *
 * Each message becomes an output-only record at its own time, and each shutdown
 * adds one record per model with what the messages didn't already cover (all of
 * the input and cache, plus any output gap), stamped at the shutdown. Totals
 * equal the rollup; output lands on the day it was spent; a session that never
 * shuts down still counts its output. Stamping everything at session start, as
 * this parser used to, put a session that ran past midnight on a day already
 * sealed by the time its shutdown was written, where it could never land.
 *
 * Copilot reports usage OpenAI-style: `inputTokens` INCLUDES `cacheReadTokens`
 * (subtracted here, as in the muse/gemini parsers) and `outputTokens` INCLUDES
 * `reasoningTokens` (on real sessions reasoning is always below output, even a
 * one-request 26 out / 19 reasoning). Messages carry no reasoning split, so
 * reasoning stays inside output rather than being counted a second time.
 *
 * A later shutdown in the same file (a resumed session) adds only what its
 * rollup grew by. If a rollup covered only its own segment that under-counts,
 * which is the safe side: never a double.
 */

import { canonicalizeProjectName } from "../project-name.js";
import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, filterFilesByMtime, findFiles, readJsonlFile } from "./utils.js";

interface CopilotUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

interface CopilotEvent {
  type?: string;
  /** ISO time the event was written. */
  timestamp?: string;
  data?: {
    model?: string;
    newModel?: string;
    selectedModel?: string;
    messageId?: string;
    outputTokens?: number;
    sessionId?: string;
    startTime?: number;
    sessionStartTime?: number;
    context?: { cwd?: string; gitRoot?: string };
    modelMetrics?: Record<string, { usage?: CopilotUsage }>;
  };
}

export class CopilotCliParser implements SessionParser {
  readonly providerId = "copilot-cli" as const;

  /** Directories this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [expandHome("~/.copilot/session-state", homeDir)];
  }

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const out: TokenRecord[] = [];
    await this.scanStreaming(homeDir, opts, (records) => {
      out.push(...records);
    });
    return out;
  }

  async scanStreaming(
    homeDir: string,
    opts: ScanFilterOptions | undefined,
    onFile: (records: TokenRecord[]) => void | Promise<void>
  ): Promise<void> {
    const [stateDir] = this.sessionRoots(homeDir);
    let files = await findFiles(stateDir!, (f) => f.endsWith("events.jsonl"), 3);
    if (opts?.modifiedSinceMs !== undefined) {
      files = await filterFilesByMtime(files, opts.modifiedSinceMs);
    }

    for (const file of files) {
      const records = this.parseFile(await readJsonlFile<CopilotEvent>(file), file);
      if (records.length > 0) await onFile(records);
    }
  }

  private parseFile(events: CopilotEvent[], file: string): TokenRecord[] {
    let cwd: string | undefined;
    let sessionId: string | undefined;
    let model: string | undefined;
    for (const ev of events) {
      if (ev.type === "session.start") {
        cwd = ev.data?.context?.gitRoot ?? ev.data?.context?.cwd;
        sessionId = ev.data?.sessionId;
        break;
      }
    }
    const project = cwd ? canonicalizeProjectName(cwd, "copilot-cli") : "copilot-cli";
    const sid = sessionId ?? file;

    // Per model, what's been emitted so far: shutdowns emit only the rest.
    const emitted = new Map<string, Required<CopilotUsage>>();
    const emittedFor = (m: string) => {
      let e = emitted.get(m);
      if (!e) {
        e = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        };
        emitted.set(m, e);
      }
      return e;
    };
    const record = (
      m: string,
      timestamp: number,
      apiCallId: string,
      t: { input: number; output: number; cacheRead: number; cacheWrite: number }
    ) =>
      createRecord({
        timestamp,
        provider: "copilot-cli",
        model: m,
        project,
        cwd,
        sourceFile: file,
        apiCallId,
        inputTokens: t.input,
        outputTokens: t.output,
        cacheReadTokens: t.cacheRead,
        cacheWriteTokens: t.cacheWrite,
      });

    const records: TokenRecord[] = [];
    let shutdowns = 0;
    for (const ev of events) {
      const data = ev.data;
      if (ev.type === "session.start") model = data?.selectedModel ?? data?.model ?? model;
      else if (ev.type === "session.model_change") model = data?.newModel ?? data?.model ?? model;
      else if (ev.type === "assistant.message") {
        const out = data?.outputTokens ?? 0;
        const ts = eventTime(ev);
        const m = data?.model ?? model;
        if (out <= 0 || ts === undefined || !m) continue;
        emittedFor(m).outputTokens += out;
        records.push(
          record(m, ts, `${sid}:msg:${data?.messageId ?? ts}`, {
            input: 0,
            output: out,
            cacheRead: 0,
            cacheWrite: 0,
          })
        );
      } else if (ev.type === "session.shutdown") {
        shutdowns++;
        const ts = eventTime(ev) ?? data?.sessionStartTime;
        if (ts === undefined) continue;
        for (const [m, metric] of Object.entries(data?.modelMetrics ?? {})) {
          const u = metric.usage;
          if (!u) continue;
          const name = m || "unknown";
          const e = emittedFor(name);
          const cacheRead = u.cacheReadTokens ?? 0;
          // Cumulative rollup → buckets; reasoning stays inside output.
          const target = {
            input: Math.max(0, (u.inputTokens ?? 0) - cacheRead),
            output: u.outputTokens ?? 0,
            cacheRead,
            cacheWrite: u.cacheWriteTokens ?? 0,
          };
          const delta = {
            input: Math.max(0, target.input - e.inputTokens),
            output: Math.max(0, target.output - e.outputTokens),
            cacheRead: Math.max(0, target.cacheRead - e.cacheReadTokens),
            cacheWrite: Math.max(0, target.cacheWrite - e.cacheWriteTokens),
          };
          e.inputTokens += delta.input;
          e.outputTokens += delta.output;
          e.cacheReadTokens += delta.cacheRead;
          e.cacheWriteTokens += delta.cacheWrite;
          if (delta.input + delta.output + delta.cacheRead + delta.cacheWrite <= 0) continue;
          records.push(record(name, ts, `${sid}:${name}:shutdown-${shutdowns}`, delta));
        }
      }
    }
    return records;
  }
}

function eventTime(ev: CopilotEvent): number | undefined {
  const t = ev.timestamp ? Date.parse(ev.timestamp) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
}
