/**
 * @sriinnu/tokmeter-core — Gemini CLI session parser.
 *
 * Reads JSON and JSONL sessions from ~/.gemini/tmp/{id}/...
 */

import { relative, sep } from "node:path";
import { canonicalizeProjectName } from "../project-name.js";
import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  filterFilesByMtime,
  findFiles,
  readJsonFile,
  readJsonlFile,
} from "./utils.js";

interface GeminiMessage {
  type?: string;
  role?: string;
  model?: string;
  timestamp?: string;
  cwd?: string;
  project?: string;
  workspace?: string;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
  };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

interface GeminiSession {
  sessionId?: string;
  timestamp?: string;
  model?: string;
  cwd?: string;
  project?: string;
  workspace?: string;
  messages?: GeminiMessage[];
}

const HEX_HASH_DIR_RE = /^[a-f0-9]{16,64}$/i;

function resolveGeminiProject(
  geminiDir: string,
  file: string,
  ...candidates: Array<string | undefined>
): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return canonicalizeProjectName(candidate, "gemini");
    }
  }
  const rel = relative(geminiDir, file);
  const firstSegment = rel.split(/[\\/]+/).filter(Boolean)[0];
  if (firstSegment && firstSegment !== "chats" && !HEX_HASH_DIR_RE.test(firstSegment)) {
    return canonicalizeProjectName(firstSegment, "gemini");
  }
  return "gemini";
}

function appendGeminiMessage(
  records: TokenRecord[],
  msg: GeminiMessage,
  file: string,
  geminiDir: string,
  defaults: { sessionTs?: number; model?: string; projectHint?: string }
): void {
  const msgTs = msg.timestamp ? new Date(msg.timestamp).getTime() : Number.NaN;
  const ts = Number.isFinite(msgTs) ? msgTs : defaults.sessionTs;
  const model = msg.model || defaults.model || "unknown";
  const cwd = msg.cwd || undefined;
  const project = resolveGeminiProject(
    geminiDir,
    file,
    msg.project,
    msg.cwd,
    msg.workspace,
    defaults.projectHint
  );

  if (msg.tokens && (msg.type === undefined || msg.type === "gemini" || msg.role === "model")) {
    // Gemini CLI mirrors Google's API: tokens.input is the TOTAL prompt
    // (including cached). Subtract cached so inputTokens = uncached only.
    const totalInput = msg.tokens.input ?? 0;
    const cached = msg.tokens.cached ?? 0;
    records.push(
      createRecord({
        timestamp: ts,
        provider: "gemini",
        model,
        project,
        ...(cwd ? { cwd } : {}),
        sourceFile: file,
        inputTokens: Math.max(0, totalInput - cached),
        outputTokens: msg.tokens.output ?? 0,
        cacheReadTokens: cached,
        reasoningTokens: msg.tokens.thoughts ?? 0,
      })
    );
    return;
  }

  if (msg.usageMetadata) {
    const totalPrompt = msg.usageMetadata.promptTokenCount ?? 0;
    const cached = msg.usageMetadata.cachedContentTokenCount ?? 0;
    records.push(
      createRecord({
        timestamp: ts,
        provider: "gemini",
        model,
        project,
        ...(cwd ? { cwd } : {}),
        sourceFile: file,
        inputTokens: Math.max(0, totalPrompt - cached),
        outputTokens: msg.usageMetadata.candidatesTokenCount ?? 0,
        cacheReadTokens: cached,
        reasoningTokens: msg.usageMetadata.thoughtsTokenCount ?? 0,
      })
    );
  }
}

export class GeminiParser implements SessionParser {
  readonly providerId = "gemini" as const;

  /** Directories this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [expandHome("~/.gemini/tmp", homeDir)];
  }

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const [geminiDir] = this.sessionRoots(homeDir);
    let files = await findFiles(geminiDir, (f) => f.endsWith(".json") || f.endsWith(".jsonl"), 4);
    if (opts?.modifiedSinceMs !== undefined) {
      files = await filterFilesByMtime(files, opts.modifiedSinceMs);
    }
    const records: TokenRecord[] = [];
    const baseDir = geminiDir.endsWith(sep) ? geminiDir.slice(0, -1) : geminiDir;

    for (const file of files) {
      try {
        if (file.endsWith(".jsonl")) {
          const lines = await readJsonlFile<GeminiMessage>(file, (err) =>
            opts?.onWarning?.(
              `failed read of ${file}: ${err instanceof Error ? err.message : err}`,
              { file }
            )
          );
          for (const msg of lines) {
            appendGeminiMessage(records, msg, file, baseDir, {});
          }
          continue;
        }

        const session = await readJsonFile<GeminiSession>(file);
        if (!session?.messages) continue;
        const sessionTs = session.timestamp ? new Date(session.timestamp).getTime() : undefined;
        const projectHint = session.project || session.cwd || session.workspace;
        for (const msg of session.messages) {
          appendGeminiMessage(records, msg, file, baseDir, {
            sessionTs: Number.isFinite(sessionTs) ? sessionTs : undefined,
            model: session.model,
            projectHint,
          });
        }
      } catch (error) {
        opts?.onWarning?.(
          `failed read of ${file}: ${error instanceof Error ? error.message : error}`,
          { file }
        );
      }
    }
    return records;
  }
}
