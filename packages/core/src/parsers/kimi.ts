/**
 * @sriinnu/tokmeter-core — Kimi session parser.
 *
 * Two layouts, both named wire.jsonl:
 *   - Kimi CLI:  ~/.kimi/sessions/{GROUP_ID}/{SESSION_UUID}/wire.jsonl
 *   - Kimi Code (the app and its CLI):
 *     ~/.kimi-code/sessions/{WORKSPACE}/{SESSION}/agents/{AGENT}/wire.jsonl,
 *     one file per agent (main and each subagent), with the session's cwd in
 *     {SESSION}/state.json.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  filterFilesByMtime,
  findFiles,
  lastPathSegment,
  readJsonFile,
  readJsonlFile,
} from "./utils.js";

interface KimiStatusUpdate {
  timestamp?: number;
  message?: {
    type?: string;
    payload?: {
      token_usage?: {
        input_other?: number;
        output?: number;
        input_cache_read?: number;
        input_cache_creation?: number;
      };
      message_id?: string;
    };
  };
}

/** A Kimi Code wire line. Only `usage.record` carries tokens. */
interface KimiCodeWireLine {
  type?: string;
  agentId?: string;
  /** "kimi-code/k3", "kimi-code/kimi-for-coding", ... */
  model?: string;
  /** "turn": one LLM call. Other scopes would be rollups and aren't counted. */
  usageScope?: string;
  /** inputOther is uncached input: inputOther + inputCacheRead + output is the call's context. */
  usage?: {
    inputOther?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheCreation?: number;
  };
  /** ms */
  time?: number;
}

interface KimiCodeSessionState {
  id?: string;
  cwd?: string;
}

/**
 * Kimi Code names models by a short alias under its own provider prefix
 * ("kimi-code/k3"). Bare generation names ("k3", "k3-256k") get the "kimi-"
 * prefix kosha lists them under; plan aliases like "kimi-for-coding" don't say
 * which model served them and stay as they are.
 */
export function kimiCodeModel(raw: string | undefined): string {
  const name = (raw ?? "").replace(/^kimi-code\//, "");
  if (!name) return "kimi";
  return /^k\d/.test(name) ? `kimi-${name}` : name;
}

export class KimiParser implements SessionParser {
  readonly providerId = "kimi" as const;

  /** Directories this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [expandHome("~/.kimi/sessions", homeDir), expandHome("~/.kimi-code/sessions", homeDir)];
  }

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const [cliDir, codeDir] = this.sessionRoots(homeDir);
    let [cliFiles, codeFiles] = await Promise.all([
      findFiles(cliDir!, (f) => f === "wire.jsonl", 4),
      findFiles(codeDir!, (f) => f === "wire.jsonl", 5),
    ]);
    if (opts?.modifiedSinceMs !== undefined) {
      [cliFiles, codeFiles] = await Promise.all([
        filterFilesByMtime(cliFiles, opts.modifiedSinceMs),
        filterFilesByMtime(codeFiles, opts.modifiedSinceMs),
      ]);
    }
    const records: TokenRecord[] = [];
    for (const file of cliFiles) records.push(...(await this.scanCliFile(file)));
    for (const file of codeFiles) records.push(...(await this.scanCodeFile(file, opts)));
    return records;
  }

  private async scanCliFile(file: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];
    const lines = await readJsonlFile<KimiStatusUpdate>(file);
    for (const line of lines) {
      const payload = line.message?.payload;
      if (!payload?.token_usage) continue;

      records.push(
        createRecord({
          // Kimi timestamps are in seconds — convert to ms. Guard against already-ms values.
          timestamp: line.timestamp
            ? line.timestamp > 1e12
              ? line.timestamp
              : line.timestamp * 1000
            : Date.now(),
          provider: "kimi",
          model: "kimi",
          project: "kimi",
          sourceFile: file,
          inputTokens: payload.token_usage.input_other ?? 0,
          outputTokens: payload.token_usage.output ?? 0,
          cacheReadTokens: payload.token_usage.input_cache_read ?? 0,
          cacheWriteTokens: payload.token_usage.input_cache_creation ?? 0,
        })
      );
    }
    return records;
  }

  private async scanCodeFile(file: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    // .../{SESSION}/agents/{AGENT}/wire.jsonl
    const agentDir = dirname(file);
    const sessionDir = dirname(dirname(agentDir));
    const state = await readJsonFile<KimiCodeSessionState>(join(sessionDir, "state.json"));
    const session = state?.id ?? lastPathSegment(sessionDir);
    const project = state?.cwd ? lastPathSegment(state.cwd) : "kimi-code";

    let raw: string;
    try {
      raw = await readFile(file, "utf-8");
    } catch (error) {
      opts?.onWarning?.(
        `failed read of ${file}: ${error instanceof Error ? error.message : error}`
      );
      return [];
    }
    const records: TokenRecord[] = [];
    // The main agent's wire is tens of MB of messages and tool output; only
    // usage.record lines carry tokens, so skip parsing the rest.
    for (const text of raw.split("\n")) {
      if (!text.includes('"usage.record"')) continue;
      let line: KimiCodeWireLine;
      try {
        line = JSON.parse(text) as KimiCodeWireLine;
      } catch (error) {
        throw new Error(
          `Malformed Kimi usage payload in ${file}: ${error instanceof Error ? error.message : error}`
        );
      }
      if (line.type !== "usage.record" || !line.usage || typeof line.time !== "number") continue;
      if (line.usageScope && line.usageScope !== "turn") continue;
      const agent = line.agentId ?? lastPathSegment(agentDir);
      records.push(
        createRecord({
          timestamp: line.time,
          provider: "kimi",
          model: kimiCodeModel(line.model),
          project,
          cwd: state?.cwd,
          sourceFile: file,
          // One usage.record per LLM call; the file is one agent's, so
          // (session, agent, time) names the call.
          apiCallId: `${session}:${agent}:${line.time}`,
          isSubagent: agent !== "main",
          inputTokens: line.usage.inputOther ?? 0,
          outputTokens: line.usage.output ?? 0,
          cacheReadTokens: line.usage.inputCacheRead ?? 0,
          cacheWriteTokens: line.usage.inputCacheCreation ?? 0,
        })
      );
    }
    return records;
  }
}
