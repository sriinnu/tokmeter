/**
 * @sriinnu/tokmeter-core — GitHub Copilot CLI session parser.
 *
 * Reads from ~/.copilot/session-state/<session-id>/events.jsonl
 *
 * This is the standalone Copilot CLI, distinct from the VS Code Copilot Chat
 * extension handled by the vscode-copilot parser.
 *
 * Per-message events (`assistant.message`) carry only `outputTokens`; the full,
 * authoritative input/cache/reasoning breakdown is the per-model rollup Copilot
 * writes at shutdown:
 *
 *   type: "session.shutdown"
 *   data.modelMetrics[model] = {
 *     requests: { count, cost },           // cost = premium-request credits, NOT USD
 *     usage: { inputTokens, outputTokens, cacheReadTokens,
 *              cacheWriteTokens, reasoningTokens }
 *   }
 *
 * We emit one record per (session, model) from that rollup — authoritative and
 * self-consistent. A session with no shutdown event (still open, or crashed) is
 * not counted until it ends; that is honest under-reporting, never a double.
 *
 * `inputTokens` is OpenAI-style and INCLUDES `cacheReadTokens`, so we subtract
 * the cached portion (matching the muse/gemini parsers) to avoid charging cached
 * tokens at the full input rate. The `cost` field is Copilot premium-request
 * credits, not dollars, so we ignore it and let tokmeter price by model.
 */

import { canonicalizeProjectName } from "../project-name.js";
import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, findFiles, readJsonlFile } from "./utils.js";

interface CopilotUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

interface CopilotEvent {
  type?: string;
  data?: {
    sessionId?: string;
    startTime?: number;
    sessionStartTime?: number;
    context?: { cwd?: string; gitRoot?: string };
    modelMetrics?: Record<string, { usage?: CopilotUsage }>;
  };
}

export class CopilotCliParser implements SessionParser {
  readonly providerId = "copilot-cli" as const;

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const out: TokenRecord[] = [];
    await this.scanStreaming(homeDir, opts, (records) => {
      out.push(...records);
    });
    return out;
  }

  async scanStreaming(
    homeDir: string,
    _opts: ScanFilterOptions | undefined,
    onFile: (records: TokenRecord[]) => void | Promise<void>
  ): Promise<void> {
    const stateDir = expandHome("~/.copilot/session-state", homeDir);
    const files = await findFiles(stateDir, (f) => f.endsWith("events.jsonl"), 3);

    for (const file of files) {
      const records = this.parseFile(await readJsonlFile<CopilotEvent>(file), file);
      if (records.length > 0) await onFile(records);
    }
  }

  private parseFile(events: CopilotEvent[], file: string): TokenRecord[] {
    let cwd: string | undefined;
    let startTime: number | undefined;
    let sessionId: string | undefined;
    let shutdown: CopilotEvent | undefined;

    for (const ev of events) {
      if (ev.type === "session.start") {
        cwd = ev.data?.context?.gitRoot ?? ev.data?.context?.cwd;
        startTime = ev.data?.startTime;
        sessionId = ev.data?.sessionId;
      } else if (ev.type === "session.shutdown") {
        shutdown = ev;
      }
    }

    const metrics = shutdown?.data?.modelMetrics;
    if (!metrics) return [];

    const ts = shutdown?.data?.sessionStartTime ?? startTime ?? Date.now();
    const project = cwd ? canonicalizeProjectName(cwd, "copilot-cli") : "copilot-cli";
    const sid = sessionId ?? file;

    const records: TokenRecord[] = [];
    for (const [model, m] of Object.entries(metrics)) {
      const u = m.usage;
      if (!u) continue;
      const total =
        (u.inputTokens ?? 0) +
        (u.outputTokens ?? 0) +
        (u.cacheReadTokens ?? 0) +
        (u.cacheWriteTokens ?? 0) +
        (u.reasoningTokens ?? 0);
      if (total <= 0) continue;

      const cacheRead = u.cacheReadTokens ?? 0;
      const inputTokens = Math.max(0, (u.inputTokens ?? 0) - cacheRead);

      records.push(
        createRecord({
          timestamp: ts,
          provider: "copilot-cli",
          model: model || "unknown",
          project,
          cwd,
          sourceFile: file,
          apiCallId: `${sid}:${model}`,
          inputTokens,
          outputTokens: u.outputTokens ?? 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: u.cacheWriteTokens ?? 0,
          reasoningTokens: u.reasoningTokens ?? 0,
        })
      );
    }

    return records;
  }
}
