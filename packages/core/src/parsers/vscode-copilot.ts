/**
 * @sriinnu/tokmeter-core — VS Code (GitHub Copilot Chat) session parser.
 *
 * Reads VS Code's own chat session store, not a Copilot-specific log:
 *  - <UserDir>/workspaceStorage/<hash>/chatSessions/*.json  (folder/workspace sessions)
 *  - <UserDir>/globalStorage/emptyWindowChatSessions/*.jsonl (no-folder sessions)
 *
 * Copilot bills via a quota'd "premium request" model, not per-token, so
 * neither the chat session files nor any other local VS Code state expose
 * token counts or cost. This parser surfaces model + request volume only —
 * inputTokens/outputTokens/cost stay 0 and are marked not_exposed (see
 * defaultUsageProvenance in utils.ts) rather than guessed at.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalizeProjectName } from "../project-name.js";
import type { SessionParser, TokenRecord } from "../types.js";
import { createRecord, findFiles, readJsonFile, vscodeFamilyUserDirs } from "./utils.js";

const APP_NAMES = ["Code", "Code - Insiders"];

interface CopilotRequest {
  modelId?: string;
  timestamp?: number;
  result?: unknown;
}

interface ChatSessionFile {
  requests?: CopilotRequest[];
}

interface EmptyWindowChatFile {
  v?: ChatSessionFile;
}

interface WorkspaceMetaFile {
  folder?: string;
  workspace?: string;
}

/** Strip the "copilot/" vendor prefix VS Code puts on Copilot Chat model ids. */
function normalizeModelId(modelId: string): string {
  const idx = modelId.indexOf("/");
  return idx === -1 ? modelId : modelId.slice(idx + 1);
}

/** file:// URI (percent-encoded) -> filesystem path, best-effort. */
function fileUriToPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  try {
    return decodeURIComponent(uri.slice("file://".length));
  } catch {
    return uri.slice("file://".length);
  }
}

async function resolveWorkspaceProject(chatSessionsDir: string): Promise<string> {
  const metaPath = join(dirname(chatSessionsDir), "workspace.json");
  const meta = await readJsonFile<WorkspaceMetaFile>(metaPath);

  if (meta?.folder) {
    const path = fileUriToPath(meta.folder);
    return path ? canonicalizeProjectName(path, "vscode-copilot") : "vscode-copilot";
  }

  if (meta?.workspace) {
    const path = fileUriToPath(meta.workspace);
    if (!path) return "vscode-copilot";
    // A real saved *.code-workspace file lives inside the project root — use
    // its directory. VS Code's internal untitled-workspace backup pointer
    // (".../Code/Workspaces/<id>/workspace.json") has no fixed project root.
    if (path.endsWith(".code-workspace")) {
      return canonicalizeProjectName(dirname(path), "vscode-copilot");
    }
    return "vscode-copilot";
  }

  return "vscode-copilot";
}

function requestsToRecords(
  requests: CopilotRequest[] | undefined,
  project: string,
  sourceFile: string
): TokenRecord[] {
  if (!requests) return [];
  const records: TokenRecord[] = [];
  for (const req of requests) {
    if (!req.modelId || !req.result || typeof req.timestamp !== "number") continue;
    records.push(
      createRecord({
        timestamp: req.timestamp,
        provider: "vscode-copilot",
        model: normalizeModelId(req.modelId),
        project,
        sourceFile,
      })
    );
  }
  return records;
}

export class VSCodeCopilotParser implements SessionParser {
  readonly providerId = "vscode-copilot" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];
    const userDirs = vscodeFamilyUserDirs(APP_NAMES, homeDir);

    for (const userDir of userDirs) {
      const workspaceStorageDir = join(userDir, "workspaceStorage");
      const sessionFiles = await findFiles(workspaceStorageDir, (f) => f.endsWith(".json"), 3);

      for (const file of sessionFiles) {
        const chatSessionsDir = dirname(file);
        if (!chatSessionsDir.endsWith("chatSessions")) continue;
        const session = await readJsonFile<ChatSessionFile>(file);
        if (!Array.isArray(session?.requests)) continue;
        const project = await resolveWorkspaceProject(chatSessionsDir);
        records.push(...requestsToRecords(session.requests, project, file));
      }

      const emptyWindowDir = join(userDir, "globalStorage", "emptyWindowChatSessions");
      const emptyWindowFiles = await findFiles(emptyWindowDir, (f) => f.endsWith(".jsonl"), 1);

      for (const file of emptyWindowFiles) {
        try {
          const raw = await readFile(file, "utf-8");
          const parsed = JSON.parse(raw) as EmptyWindowChatFile;
          records.push(...requestsToRecords(parsed.v?.requests, "vscode-copilot", file));
        } catch {
          // skip unreadable/malformed files
        }
      }
    }
    return records;
  }
}
