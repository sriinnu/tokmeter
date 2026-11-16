/**
 * @sriinnu/tokmeter-core — shared SQLite reader for OpenCode and its forks
 * (Kilo CLI).
 *
 * Current OpenCode (drizzle schema) stores one row per message in `message`,
 * with the whole message — role, modelID, providerID, tokens, cost, time,
 * path — as a JSON blob in `data`. Sessions live in `session` (`directory`)
 * and projects in `project` (`worktree`).
 *
 * An earlier schema kept flat columns in a `messages` table (model_id,
 * input_tokens, ...) with an optional `sessions` table. Both are read here;
 * the parsers used to query only the flat one, so on the current schema the
 * query threw and every DB-era message was silently dropped.
 *
 * OpenCode 1.x+ (session v2, migration 2026-10) writes new messages to
 * `session_message` instead: `type` column ("assistant", "user", ...) and a
 * blob whose model sits at `model.{id,providerID}`, sessions in `session_v2`.
 * The migration copied old rows in and `message` gets no new ones, so the two
 * overlap on id (identical usage, checked on a live install) and each also
 * holds rows the other lacks. Both are read and deduped on message id;
 * reading only `message` silently dropped every message since the switch.
 *
 * OpenCode's `tokens.input` is already the UNCACHED prompt: it subtracts
 * cache reads for OpenAI-style providers and leaves Anthropic-style ones as
 * reported, so it maps straight onto inputTokens without adjustment.
 */

import { withServedBy } from "../pricing.js";
import { canonicalizeProjectName } from "../project-name.js";
import type { ProviderId, TokenRecord } from "../types.js";
import { createRecord, type ReadonlySqlite } from "./utils.js";

/** The JSON message shape, shared by the `message.data` blob and legacy storage files. */
export interface OpenCodeMessageData {
  id?: string;
  role?: string;
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  time?: { created?: number };
  path?: { cwd?: string; root?: string };
}

interface MessageRow {
  id: string;
  time_created: number;
  data: string;
  directory?: string | null;
  worktree?: string | null;
}

/** A `session_message.data` blob (session v2): no role/path, model nested. */
interface SessionMessageData {
  model?: { id?: string; providerID?: string };
  cost?: number;
  tokens?: OpenCodeMessageData["tokens"];
  time?: { created?: number };
}

interface SessionMessageRow {
  id: string;
  time_created: number;
  data: string;
  directory?: string | null;
}

interface FlatMessageRow {
  id?: string;
  model_id?: string;
  provider_id?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read?: number;
  cache_write?: number;
  created_at?: number;
  session_id?: string;
}

interface FlatSessionRow {
  id: string;
  title?: string;
  path?: string;
  cwd?: string;
}

function hasTable(db: ReadonlySqlite, name: string): boolean {
  return !!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name);
}

function hasColumn(db: ReadonlySqlite, table: string, column: string): boolean {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column);
}

/**
 * Maps one OpenCode JSON message to a TokenRecord, or null when it is not an
 * assistant response with usage. `fallback.cwd` covers messages without
 * `path` (user-side rows never have it; older assistant rows may not).
 * `legacyJson` tags records from the per-message JSON store.
 */
export function openCodeMessageToRecord(
  msg: OpenCodeMessageData | null | undefined,
  provider: ProviderId,
  sourceFile: string,
  fallback: { id?: string; timestamp?: number; cwd?: string | null; legacyJson?: boolean } = {}
): TokenRecord | null {
  // A row whose JSON is not an object (e.g. "null") must skip, not throw —
  // a throw here would drop every other record in the database.
  if (!msg || typeof msg !== "object") return null;
  if (msg.role !== "assistant" || !msg.tokens || typeof msg.tokens !== "object") return null;

  const cwd = msg.path?.cwd || fallback.cwd || undefined;
  const t = msg.tokens;
  const rec = createRecord({
    timestamp: msg.time?.created ?? fallback.timestamp,
    provider,
    // The same model costs very differently per route (DeepSeek on Ollama
    // Cloud is half Alibaba's rate), so the record names who served it and
    // pricing looks up that provider's own rate (see splitServedBy).
    model: withServedBy(msg.modelID || "unknown", msg.providerID),
    project: cwd ? canonicalizeProjectName(cwd, provider) : provider,
    cwd,
    sourceFile,
    apiCallId: msg.id || fallback.id,
    // In the database, one file holds every session: name the message so a
    // deleted session's usage can be kept (today-journal.ts). The JSON store
    // has a file per message, which is carried as a file.
    ...(!fallback.legacyJson && (msg.id || fallback.id)
      ? { threadKey: msg.id || fallback.id }
      : {}),
    inputTokens: t.input ?? 0,
    outputTokens: t.output ?? 0,
    reasoningTokens: t.reasoning ?? 0,
    cacheReadTokens: t.cache?.read ?? 0,
    cacheWriteTokens: t.cache?.write ?? 0,
    ...(fallback.legacyJson ? { usage: { source: "tool_json" as const } } : {}),
  });
  // OpenCode prices each response itself (from its models.dev catalog), so a
  // non-zero figure is tool-reported, like Claude Code's costUSD or Cursor's
  // CSV. Marked "direct" so enrichment keeps it and a reprice never swaps it
  // for a kosha estimate — one response must carry one cost.
  if (typeof msg.cost === "number" && msg.cost > 0) {
    rec.cost = msg.cost;
    if (rec.usage) rec.usage.cost = "direct";
  }
  // A free-tier model's $0 is a fact, not missing pricing — mark it reported
  // so enrichment leaves it alone and the UI shows $0.00, not "Unavailable".
  // Only the explicit free variants (OpenCode Zen `-free`, OpenRouter `:free`;
  // OpenCode's own catalog lists them at $0 on every rate): a coding-plan $0
  // is a subscription, which tokmeter prices at API-equivalent rates.
  else if (msg.cost === 0 && isFreeTierModel(msg.modelID ?? "") && rec.usage)
    rec.usage.cost = "direct";
  return rec;
}

export function isFreeTierModel(model: string): boolean {
  return /[-:]free$/i.test(model);
}

/**
 * Reads every assistant response from an OpenCode-family database. Throws on
 * a schema it does not recognise so the caller can fall back.
 */
export function readOpenCodeDb(
  db: ReadonlySqlite,
  dbPath: string,
  provider: ProviderId
): TokenRecord[] {
  const hasV2 =
    hasTable(db, "session_message") &&
    ["data", "type", "session_id", "time_created"].every((c) =>
      hasColumn(db, "session_message", c)
    );
  const hasV1 = hasTable(db, "message") && hasColumn(db, "message", "data");
  if (hasV1 || hasV2) {
    const records: TokenRecord[] = [];
    const seen = new Set<string>();
    const add = (rec: TokenRecord) => {
      if (rec.apiCallId) {
        if (seen.has(rec.apiCallId)) return;
        seen.add(rec.apiCallId);
      }
      records.push(rec);
    };
    if (hasV2) for (const rec of readSessionMessages(db, dbPath, provider)) add(rec);
    if (hasV1) for (const rec of readJsonMessages(db, dbPath, provider)) add(rec);
    return records;
  }
  if (hasTable(db, "messages")) {
    return readFlatMessages(db, dbPath, provider);
  }
  throw new Error(`${provider}: unrecognised database schema`);
}

function parseBlob<T>(provider: ProviderId, id: string, data: string): T {
  try {
    return JSON.parse(data) as T;
  } catch (error) {
    throw new Error(
      `Malformed ${provider} message ${id}: ${error instanceof Error ? error.message : error}`
    );
  }
}

function readSessionMessages(
  db: ReadonlySqlite,
  dbPath: string,
  provider: ProviderId
): TokenRecord[] {
  const joinSession = hasTable(db, "session_v2");
  const rows = db.all<SessionMessageRow>(
    `SELECT m.id, m.time_created, m.data${joinSession ? ", s.directory" : ""}
       FROM session_message m
       ${joinSession ? "LEFT JOIN session_v2 s ON s.id = m.session_id" : ""}
      WHERE m.type = 'assistant'`
  );
  const records: TokenRecord[] = [];
  for (const row of rows) {
    const msg = parseBlob<SessionMessageData | null>(provider, row.id, row.data);
    if (!msg || typeof msg !== "object") continue;
    const rec = openCodeMessageToRecord(
      {
        id: row.id,
        role: "assistant",
        modelID: msg.model?.id,
        providerID: msg.model?.providerID,
        cost: msg.cost,
        tokens: msg.tokens,
        time: msg.time,
      },
      provider,
      dbPath,
      { id: row.id, timestamp: row.time_created, cwd: row.directory }
    );
    if (rec) records.push(rec);
  }
  return records;
}

function readJsonMessages(db: ReadonlySqlite, dbPath: string, provider: ProviderId): TokenRecord[] {
  const joinSession = hasTable(db, "session");
  const joinProject = joinSession && hasTable(db, "project");
  const rows = db.all<MessageRow>(
    `SELECT m.id, m.time_created, m.data${joinSession ? ", s.directory" : ""}${joinProject ? ", p.worktree" : ""}
       FROM message m
       ${joinSession ? "LEFT JOIN session s ON s.id = m.session_id" : ""}
       ${joinProject ? "LEFT JOIN project p ON p.id = s.project_id" : ""}`
  );

  const records: TokenRecord[] = [];
  for (const row of rows) {
    const msg = parseBlob<OpenCodeMessageData>(provider, row.id, row.data);
    const rec = openCodeMessageToRecord(msg, provider, dbPath, {
      id: row.id,
      timestamp: row.time_created,
      cwd: row.directory || row.worktree,
    });
    if (rec) records.push(rec);
  }
  return records;
}

function readFlatMessages(db: ReadonlySqlite, dbPath: string, provider: ProviderId): TokenRecord[] {
  const sessionProjects = new Map<string, string>();
  if (hasTable(db, "sessions")) {
    for (const s of db.all<FlatSessionRow>("SELECT id, title, path, cwd FROM sessions")) {
      const project = s.path || s.cwd || s.title;
      if (project) sessionProjects.set(s.id, canonicalizeProjectName(project, provider));
    }
  }

  const idColumn = hasColumn(db, "messages", "id") ? "id, " : "";
  const providerColumn = hasColumn(db, "messages", "provider_id") ? "provider_id, " : "";
  const rows = db.all<FlatMessageRow>(
    `SELECT ${idColumn}${providerColumn}model_id, input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write, created_at, session_id
       FROM messages WHERE role = 'assistant'`
  );
  return rows.map((row) =>
    createRecord({
      timestamp: row.created_at ?? undefined,
      provider,
      model: withServedBy(row.model_id || "unknown", row.provider_id),
      project: (row.session_id && sessionProjects.get(row.session_id)) || provider,
      sourceFile: dbPath,
      apiCallId: row.id,
      ...(row.id ? { threadKey: row.id } : {}),
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      reasoningTokens: row.reasoning_tokens ?? 0,
      cacheReadTokens: row.cache_read ?? 0,
      cacheWriteTokens: row.cache_write ?? 0,
    })
  );
}
