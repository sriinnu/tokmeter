/**
 * @sriinnu/tokmeter-core — VS Code (GitHub Copilot Chat) session parser.
 *
 * Reads VS Code's own chat session store, not a Copilot-specific log:
 *  - <UserDir>/workspaceStorage/<hash>/chatSessions/*.json[l] (folder/workspace sessions)
 *  - <UserDir>/globalStorage/emptyWindowChatSessions/*.jsonl  (no-folder sessions)
 *
 * A *.json session is one JSON document. A *.jsonl session (VS Code's current
 * format, in both places) is a mutation log that has to be replayed — see
 * replayMutationLog.
 *
 * Copilot bills via a quota'd "premium request" model, not per-token, so
 * neither the chat session files nor any other local VS Code state expose
 * token counts or cost. This parser surfaces model + request volume only —
 * inputTokens/outputTokens/cost stay 0 and are marked not_exposed (see
 * defaultUsageProvenance in utils.ts) rather than guessed at.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalizeProjectName } from "../project-name.js";
import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  filterFilesByMtime,
  findFiles,
  getCachedRecords,
  getConfiguredProviderPaths,
  readJsonFile,
  setCachedRecords,
  vscodeFamilyUserDirs,
} from "./utils.js";

const APP_NAMES = ["Code", "Code - Insiders"];

interface CopilotRequest {
  modelId?: string;
  timestamp?: number;
  result?: unknown;
}

interface ChatSessionFile {
  requests?: CopilotRequest[];
}

/** One line of a *.jsonl session: kind 0 = initial state, 1 = set, 2 = splice. */
interface MutationLogEntry {
  kind?: number;
  k?: (string | number)[];
  v?: unknown;
  i?: number;
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
  let meta: WorkspaceMetaFile | null = null;
  try {
    meta = await readJsonFile<WorkspaceMetaFile>(metaPath);
  } catch {
    // Optional display metadata; usage remains complete without it.
  }

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

/** VS Code "User" dirs the parser walks: auto-detected plus configured. */
function copilotUserDirs(homeDir: string): string[] {
  return [
    ...vscodeFamilyUserDirs(APP_NAMES, homeDir),
    ...getConfiguredProviderPaths("vscode-copilot", homeDir).map((p) => expandHome(p, homeDir)),
  ];
}

export class VSCodeCopilotParser implements SessionParser {
  readonly providerId = "vscode-copilot" as const;

  /** Paths this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return copilotUserDirs(homeDir).flatMap((userDir) => [
      join(userDir, "workspaceStorage"),
      join(userDir, "globalStorage", "emptyWindowChatSessions"),
    ]);
  }

  /**
   * A chat session is rewritten in place (a .json) or replayed from its
   * first line (a .jsonl mutation log), so neither can be read from an
   * offset: a changed file is parsed whole. Two things keep that rare:
   *
   * - `modifiedSinceMs`: the daemon's today refresh runs every ~12 s; a
   *   session last touched months ago must not be opened at all.
   * - the per-file record cache, keyed on mtime and size: a full scan
   *   reuses an unchanged file's records.
   *
   * Without both, every refresh re-read every session. One real log was
   * 427 MB with a 291 MB first line (the whole session state), and each
   * refresh took 6 s and ~3 GB, which showed up as the daemon's 2–4 GB
   * bursts.
   */
  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];
    const since = opts?.modifiedSinceMs;
    const recent = async (files: string[]) =>
      since === undefined ? files : filterFilesByMtime(files, since);

    for (const userDir of copilotUserDirs(homeDir)) {
      const workspaceStorageDir = join(userDir, "workspaceStorage");
      const sessionFiles = await recent(
        preferMutationLogs(
          await findFiles(
            workspaceStorageDir,
            (f) => f.endsWith(".json") || f.endsWith(".jsonl"),
            3
          )
        ).filter((file) => dirname(file).endsWith("chatSessions"))
      );

      for (const file of sessionFiles) {
        try {
          records.push(
            ...(await cachedSessionRecords(
              file,
              async () => {
                const session = file.endsWith(".jsonl")
                  ? await readMutationLog(file)
                  : await readJsonFile<ChatSessionFile>(file);
                if (!Array.isArray(session?.requests)) return [];
                const project = await resolveWorkspaceProject(dirname(file));
                return requestsToRecords(session.requests, project, file);
              },
              homeDir
            ))
          );
        } catch (error) {
          if (opts?.onWarning) {
            opts.onWarning(
              `vscode-copilot scan failed for ${file}: ${error instanceof Error ? error.message : error}`,
              { file }
            );
            continue;
          }
          throw error;
        }
      }

      const emptyWindowDir = join(userDir, "globalStorage", "emptyWindowChatSessions");
      const emptyWindowFiles = await recent(
        await findFiles(emptyWindowDir, (f) => f.endsWith(".jsonl"), 1)
      );

      for (const file of emptyWindowFiles) {
        try {
          records.push(
            ...(await cachedSessionRecords(
              file,
              async () => {
                const session = await readMutationLog(file);
                return requestsToRecords(session?.requests, "vscode-copilot", file);
              },
              homeDir
            ))
          );
        } catch (error) {
          if (opts?.onWarning) {
            opts.onWarning(
              `vscode-copilot scan failed for ${file}: ${error instanceof Error ? error.message : error}`,
              { file }
            );
            continue;
          }
          throw error;
        }
      }
    }
    return records;
  }
}

/**
 * An unchanged file's cached records, else `parse()`'s, cached under the
 * mtime and size seen BEFORE reading: a write that lands mid-parse leaves the
 * file newer than its cache entry, so the next scan reads it again.
 */
async function cachedSessionRecords(
  file: string,
  parse: () => Promise<TokenRecord[]>,
  homeDir: string
): Promise<TokenRecord[]> {
  const cached = await getCachedRecords(file, homeDir);
  if (cached.hit) return cached.records;
  let before: { mtimeMs: number; sizeBytes: number } | undefined;
  try {
    const s = await stat(file);
    before = { mtimeMs: s.mtimeMs, sizeBytes: s.size };
  } catch {}
  const records = await parse();
  if (before) await setCachedRecords(file, records, before, homeDir);
  return records;
}

/**
 * A session VS Code wrote both ways (its .json → .jsonl migration) must count
 * once: keep the .jsonl, the one VS Code still appends to.
 */
function preferMutationLogs(files: string[]): string[] {
  const logs = new Set(files.filter((f) => f.endsWith(".jsonl")));
  return files.filter((f) => !f.endsWith(".json") || !logs.has(`${f}l`));
}

async function readMutationLog(file: string): Promise<ChatSessionFile | undefined> {
  try {
    return replayMutationLog(await readFile(file, "utf-8"));
  } catch (error) {
    throw new Error(
      `Unable to read Copilot session ${file}: ${error instanceof Error ? error.message : error}`
    );
  }
}

/**
 * Replay a *.jsonl chat session into its final state. Line 1 is `kind 0` with
 * the whole session as `v`; after it, `kind 1` sets the value at path `k`, and
 * `kind 2` splices the array at `k` — truncate to `i` when present, then append
 * `v` when present. Reading only line 1 misses every request added later, and
 * parsing the file as one document fails outright.
 *
 * Throws on anything it can't apply (an unknown kind, a path that doesn't
 * exist): a half-replayed session would silently undercount. The one exception
 * is a torn last line — VS Code is mid-append — which is skipped.
 */
export function replayMutationLog(raw: string): ChatSessionFile | undefined {
  const lines = raw.split("\n");
  let state: unknown;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    let entry: MutationLogEntry;
    try {
      entry = JSON.parse(line) as MutationLogEntry;
    } catch (error) {
      if (n === lines.length - 1) break;
      throw new Error(`line ${n + 1}: ${error instanceof Error ? error.message : error}`);
    }
    if (entry.kind === 0) {
      state = entry.v;
      continue;
    }
    const path = entry.k;
    if (!Array.isArray(path) || path.length === 0) {
      throw new Error(`line ${n + 1}: kind ${entry.kind} without a path`);
    }
    if (entry.kind === 1) {
      const parent = resolvePath(state, path.slice(0, -1), n);
      (parent as Record<string | number, unknown>)[path[path.length - 1]] = entry.v;
    } else if (entry.kind === 2) {
      const target = resolvePath(state, path, n);
      if (!Array.isArray(target)) throw new Error(`line ${n + 1}: splice target is not an array`);
      if (typeof entry.i === "number") target.length = Math.min(target.length, entry.i);
      if (Array.isArray(entry.v)) target.push(...entry.v);
    } else {
      throw new Error(`line ${n + 1}: unknown mutation kind ${entry.kind}`);
    }
  }
  return state as ChatSessionFile | undefined;
}

function resolvePath(state: unknown, path: (string | number)[], n: number): object {
  let node = state;
  for (const key of path) {
    if (node === null || typeof node !== "object") break;
    node = (node as Record<string | number, unknown>)[key];
  }
  if (node === null || typeof node !== "object") {
    throw new Error(`line ${n + 1}: path ${path.join(".")} does not exist`);
  }
  return node;
}
