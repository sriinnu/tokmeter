/**
 * @sriinnu/tokmeter-core — Antigravity 2.x conversation databases.
 *
 * Antigravity 2.x (IDE and CLI) writes one SQLite file per conversation:
 *   ~/.gemini/antigravity/conversations/<cascade id>.db
 *   ~/.gemini/antigravity-cli/conversations/<cascade id>.db
 *
 * No public schema; decoded from the wire format against real files
 * (2026-11-17, 36 databases, 2,412 generations). The parts used here:
 *
 *   gen_metadata.data              one row per generation
 *     .1                           generation
 *       .4                         usage, summed over the calls in .17
 *       .17 (repeated)             one per API call, retries included
 *         .2                       that call's usage
 *           .2 input (uncached)    .3 output total   .4 cache write
 *           .5 cache read          .9 thinking       .10 response
 *           .11 response id
 *       .9.4                       start time {seconds, nanos}
 *       .19                        model id ("gemini-pro-default", …)
 *       .20 (repeated key/value)   "model_enum", "last_step_index", …
 *       .21                        display name ("Gemini 3.1 Pro (High)")
 *   steps.metadata.1               the step's creation time
 *   trajectory_metadata_blob.data  .7 workspace file:// URIs
 *
 * Checked on every real row: .3 == .9 + .10, and the .17 calls sum to .4.
 * Cache read (.5) is usually larger than input (.2), so .2 is uncached input,
 * not a total that contains the cache read. Each call becomes one record,
 * keyed by its response id; a generation with no .17 falls back to .4.
 * Cache write (.4) never appeared in 2,429 real usages; it's read if it ever
 * does, but its provenance stays not_exposed.
 *
 * scripts/oracle/antigravity_oracle.py rebuilds the per-day totals from the
 * same files without tokmeter's code.
 */

import { readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { canonicalizeProjectName } from "../project-name.js";
import type { ScanFilterOptions, TokenRecord } from "../types.js";
import { createRecord, openReadonlySqlite, type ReadonlySqlite } from "./utils.js";

/** Antigravity's own folders under ~/.gemini that hold conversations/. */
export const CONVERSATION_APP_DIRS = ["antigravity", "antigravity-cli"];

export function conversationDirs(homeDir: string): string[] {
  return CONVERSATION_APP_DIRS.map((d) => join(homeDir, ".gemini", d, "conversations"));
}

/** Every conversation database on disk now. */
export function listConversationDbs(homeDir: string): string[] {
  const out: string[] = [];
  for (const dir of conversationDirs(homeDir)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names.sort()) if (n.endsWith(".db")) out.push(join(dir, n));
  }
  return out;
}

// ─── Wire format ────────────────────────────────────────────────────
// Generations carry doubles (sampling settings, nested in .15), so wire
// types 1 and 5 are skipped rather than ending the message, in case one ever
// sits at a level read here. Varints are read with multiplication: some are
// 64-bit (an unset -1 in .9.2), which a 32-bit shift would misread.

interface Field {
  num: number;
  varint?: number;
  bytes?: Uint8Array;
}

function readVarint(buf: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let scale = 1;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++];
    result += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return [result, i];
    scale *= 128;
  }
  return [result, -1];
}

function fields(buf: Uint8Array | undefined): Field[] {
  const out: Field[] = [];
  if (!buf) return out;
  let i = 0;
  while (i < buf.length) {
    const [tag, afterTag] = readVarint(buf, i);
    if (afterTag < 0) break;
    const num = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (wireType === 0) {
      const [value, next] = readVarint(buf, afterTag);
      if (next < 0) break;
      out.push({ num, varint: value });
      i = next;
    } else if (wireType === 2) {
      const [len, next] = readVarint(buf, afterTag);
      if (next < 0 || next + len > buf.length) break;
      out.push({ num, bytes: buf.subarray(next, next + len) });
      i = next + len;
    } else if (wireType === 1) {
      i = afterTag + 8;
    } else if (wireType === 5) {
      i = afterTag + 4;
    } else {
      break;
    }
  }
  return out;
}

const one = (fs: Field[], n: number) => fs.find((f) => f.num === n);
const all = (fs: Field[], n: number) => fs.filter((f) => f.num === n);
const text = (f: Field | undefined) => (f?.bytes ? Buffer.from(f.bytes).toString("utf-8") : "");
const num = (fs: Field[], n: number) => one(fs, n)?.varint ?? 0;

function timeMs(f: Field | undefined): number | undefined {
  if (!f?.bytes) return undefined;
  const t = fields(f.bytes);
  const seconds = num(t, 1);
  if (!seconds) return undefined;
  return seconds * 1000 + Math.floor(num(t, 2) / 1e6);
}

function asBytes(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return new Uint8Array(Buffer.from(v, "binary"));
  return undefined;
}

// ─── Decoding one database ──────────────────────────────────────────

interface Generation {
  row: number;
  /** Start time, else the time of its last step; undefined when neither exists. */
  timestamp: number | undefined;
  modelId: string;
  display: string;
  modelEnum: string;
  calls: Field[][];
}

interface DecodedDb {
  gens: Generation[];
  /** Every step's creation time: what the coverage check counts as activity. */
  stepTimes: number[];
  project: string;
  cwd?: string;
}

function decodeGeneration(row: number, data: Uint8Array, stepTime: Map<number, number>) {
  const gen = one(fields(data), 1)?.bytes;
  if (!gen) return null;
  const g = fields(gen);
  const meta = new Map<string, string>();
  for (const e of all(g, 20)) {
    const kv = fields(e.bytes);
    meta.set(text(one(kv, 1)), text(one(kv, 2)));
  }
  const calls: Field[][] = [];
  for (const c of all(g, 17)) {
    const usage = one(fields(c.bytes), 2)?.bytes;
    if (usage) calls.push(fields(usage));
  }
  const total = one(g, 4)?.bytes;
  if (calls.length === 0 && total) calls.push(fields(total));
  const lastStep = meta.get("last_step_index");
  const stepIndex = lastStep !== undefined && /^\d+$/.test(lastStep) ? Number(lastStep) : undefined;
  return {
    row,
    timestamp:
      timeMs(one(fields(one(g, 9)?.bytes), 4)) ??
      (stepIndex !== undefined ? stepTime.get(stepIndex) : undefined),
    modelId: text(one(g, 19)),
    display: text(one(g, 21)),
    modelEnum: meta.get("model_enum") ?? "",
    calls,
  } satisfies Generation;
}

function projectOf(blob: Uint8Array | undefined): { project: string; cwd?: string } {
  const f = fields(blob);
  const uri = text(one(f, 7)) || text(one(fields(one(f, 1)?.bytes), 1));
  if (!uri.startsWith("file://")) return { project: "antigravity" };
  try {
    const path = decodeURIComponent(uri.slice("file://".length));
    return { project: canonicalizeProjectName(path, "antigravity"), cwd: path };
  } catch {
    return { project: "antigravity" };
  }
}

/** SQLite URI for a path: `?` and `#` would otherwise end the filename. */
function immutableUri(path: string): string {
  return `file:${encodeURI(path).replace(/\?/g, "%3F").replace(/#/g, "%23")}?immutable=1`;
}

interface FileState {
  db: string;
  wal: string;
}

async function fileState(dbPath: string): Promise<FileState> {
  const one = async (p: string) => {
    try {
      const s = await stat(p);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return "-";
    }
  };
  return { db: await one(dbPath), wal: await one(`${dbPath}-wal`) };
}

const walBytes = (s: FileState) => (s.wal === "-" ? 0 : Number(s.wal.split(":")[0]));

/**
 * Open a conversation database without writing beside it. These are WAL
 * databases; while Antigravity is closed the -wal is missing or empty, so
 * the main file holds everything and an immutable open reads it exactly —
 * and creates no -shm or -wal in ~/.gemini (a plain read-only open does,
 * under Node; under Bun it fails with SQLITE_CANTOPEN instead). With a live
 * -wal, a plain read-only open sees it.
 */
async function openConversationDb(dbPath: string, liveWal: boolean): Promise<ReadonlySqlite> {
  if (!liveWal) {
    try {
      const db = await openReadonlySqlite(immutableUri(dbPath));
      db.get("SELECT 1 FROM gen_metadata LIMIT 1");
      return db;
    } catch {
      // A driver without URI filenames (better-sqlite3): plain open below.
    }
  }
  const db = await openReadonlySqlite(dbPath);
  try {
    db.get("SELECT 1 FROM gen_metadata LIMIT 1");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function readDb(db: ReadonlySqlite): DecodedDb {
  const stepTime = new Map<number, number>();
  for (const s of db.all<{ idx: number; metadata: unknown }>("SELECT idx, metadata FROM steps")) {
    const t = timeMs(one(fields(asBytes(s.metadata)), 1));
    if (t !== undefined) stepTime.set(Number(s.idx), t);
  }
  const gens: Generation[] = [];
  for (const r of db.all<{ idx: number; data: unknown }>(
    "SELECT idx, data FROM gen_metadata ORDER BY idx"
  )) {
    const bytes = asBytes(r.data);
    const g = bytes ? decodeGeneration(Number(r.idx), bytes, stepTime) : null;
    if (g) gens.push(g);
  }
  let blob: Uint8Array | undefined;
  try {
    blob = asBytes(
      db.get<{ data: unknown }>("SELECT data FROM trajectory_metadata_blob LIMIT 1")?.data
    );
  } catch {
    blob = undefined;
  }
  return { gens, stepTimes: [...stepTime.values()], ...projectOf(blob) };
}

/**
 * Decode one database. An immutable read doesn't see a writer, so the file
 * and its -wal are checked again afterwards; if either moved, the read may
 * be torn and is retried once (by then the writer's -wal is live, so the
 * retry reads through it).
 */
async function decodeDb(dbPath: string): Promise<DecodedDb> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await fileState(dbPath);
    const liveWal = walBytes(before) > 0;
    const db = await openConversationDb(dbPath, liveWal);
    let decoded: DecodedDb;
    try {
      decoded = readDb(db);
    } finally {
      db.close();
    }
    if (liveWal) return decoded;
    const after = await fileState(dbPath);
    if (after.db === before.db && after.wal === before.wal) return decoded;
  }
  throw new Error("it changed while being read, twice");
}

// Decoded databases, keyed by size and mtime of the file and its -wal. The
// model map and the coverage check read every conversation, not only the
// ones a today scan opens.
const decodedCache = new Map<string, { key: string; decoded: DecodedDb }>();

async function decodeCached(dbPath: string): Promise<DecodedDb> {
  const s = await fileState(dbPath);
  const key = `${s.db}|${s.wal}`;
  const hit = decodedCache.get(dbPath);
  if (hit?.key === key) return hit.decoded;
  const decoded = await decodeDb(dbPath);
  decodedCache.set(dbPath, { key, decoded });
  return decoded;
}

// ─── Model names ────────────────────────────────────────────────────

/** "Gemini 3.1 Pro (High)" → "gemini-3.1-pro": the effort suffix isn't a model. */
function slugFromDisplay(display: string): string {
  return display
    .replace(/\([^)]*\)/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

const isRealId = (id: string) => id !== "" && !id.endsWith("-default");

interface ModelNames {
  /** model_enum → the model id another row gave it. */
  ids: Map<string, string>;
  /** model_enum → the display name another row gave it. */
  displays: Map<string, string>;
}

/**
 * The enum → name map across every conversation in both folders, so a row
 * that carries only an alias or nothing is named the same however the scan
 * was filtered. Databases are visited in path order; the first name wins.
 */
async function modelNames(homeDir: string): Promise<ModelNames> {
  const names: ModelNames = { ids: new Map(), displays: new Map() };
  for (const dbPath of listConversationDbs(homeDir)) {
    let decoded: DecodedDb;
    try {
      decoded = await decodeCached(dbPath);
    } catch {
      continue;
    }
    for (const g of decoded.gens) {
      if (!g.modelEnum) continue;
      if (isRealId(g.modelId) && !names.ids.has(g.modelEnum)) names.ids.set(g.modelEnum, g.modelId);
      if (g.display && !names.displays.has(g.modelEnum)) names.displays.set(g.modelEnum, g.display);
    }
  }
  return names;
}

/**
 * The row's own id, then the id its enum has elsewhere (so a row can't come
 * out as "claude-sonnet-4.6" beside "claude-sonnet-4-6"), then a display
 * name (own, then its enum's), then the raw alias.
 */
function modelOf(g: Generation, names: ModelNames): string {
  if (isRealId(g.modelId)) return g.modelId;
  const byEnum = g.modelEnum ? names.ids.get(g.modelEnum) : undefined;
  if (byEnum) return byEnum;
  const display = g.display || (g.modelEnum ? names.displays.get(g.modelEnum) : undefined);
  if (display) return slugFromDisplay(display);
  return g.modelId || "unknown";
}

// ─── Records ────────────────────────────────────────────────────────

function recordsOf(
  dbPath: string,
  decoded: DecodedDb,
  names: ModelNames
): { records: TokenRecord[]; undated: number } {
  const cascade = basename(dbPath, ".db");
  const records: TokenRecord[] = [];
  let undated = 0;
  for (const g of decoded.gens) {
    const model = modelOf(g, names);
    g.calls.forEach((u, n) => {
      const inputTokens = num(u, 2);
      const cacheWriteTokens = num(u, 4);
      const cacheReadTokens = num(u, 5);
      const reasoningTokens = num(u, 9);
      // .10 is the response part; when it's absent, .3 minus thinking.
      const outputTokens = one(u, 10) ? num(u, 10) : Math.max(0, num(u, 3) - reasoningTokens);
      if (
        !inputTokens &&
        !outputTokens &&
        !cacheReadTokens &&
        !cacheWriteTokens &&
        !reasoningTokens
      )
        return;
      // Never date a billed call by guesswork (e.g. the file's birth time).
      if (g.timestamp === undefined) {
        undated++;
        return;
      }
      records.push(
        createRecord({
          timestamp: g.timestamp,
          provider: "antigravity",
          model,
          project: decoded.project,
          ...(decoded.cwd ? { cwd: decoded.cwd } : {}),
          sourceFile: dbPath,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          reasoningTokens,
          apiCallId: text(one(u, 11)) || `${cascade}:${g.row}:${n}`,
        })
      );
    });
  }
  return { records, undated };
}

/** Records from one conversation database, one per API call. */
export async function readConversationDb(dbPath: string, homeDir?: string): Promise<TokenRecord[]> {
  const decoded = await decodeCached(dbPath);
  const names = homeDir ? await modelNames(homeDir) : { ids: new Map(), displays: new Map() };
  return recordsOf(dbPath, decoded, names).records;
}

/**
 * Whether the conversation shows new activity in [startMs, endMs): a step
 * created then. Opening an old conversation rewrites its file without adding
 * a step, so the coverage check asks this before calling a changed database
 * quiet.
 */
export async function conversationActiveBetween(
  dbPath: string,
  startMs: number,
  endMs: number
): Promise<boolean> {
  try {
    const { stepTimes, gens } = await decodeCached(dbPath);
    const times = [...stepTimes, ...gens.map((g) => g.timestamp ?? 0)];
    return times.some((t) => t >= startMs && t < endMs);
  } catch {
    // Unreadable is worth a look; report it as active so it isn't hidden.
    return true;
  }
}

/** All conversation records, deduped on response id (largest value per bucket). */
export async function scanConversations(
  homeDir: string,
  opts?: ScanFilterOptions
): Promise<{ records: TokenRecord[]; cascades: Set<string> }> {
  const cascades = new Set<string>();
  const byId = new Map<string, TokenRecord>();
  let names: ModelNames | null = null;
  for (const dbPath of listConversationDbs(homeDir)) {
    cascades.add(basename(dbPath, ".db"));
    if (opts?.modifiedSinceMs !== undefined) {
      // An empty -wal holds no writes: macOS SQLite leaves one behind.
      let changed = 0;
      for (const f of [dbPath, `${dbPath}-wal`]) {
        try {
          const st = await stat(f);
          if (f === dbPath || st.size > 0) changed = Math.max(changed, st.mtimeMs);
        } catch {
          /* no -wal */
        }
      }
      if (changed < opts.modifiedSinceMs) continue;
    }
    let decoded: DecodedDb;
    try {
      decoded = await decodeCached(dbPath);
    } catch (error) {
      opts?.onWarning?.(
        `antigravity: skipped ${dbPath}: ${error instanceof Error ? error.message : error}`
      );
      continue;
    }
    names ??= await modelNames(homeDir);
    const { records, undated } = recordsOf(dbPath, decoded, names);
    if (undated > 0) {
      opts?.onNotice?.(
        `antigravity: ${undated} call(s) in ${dbPath} have no time recorded and were not counted`
      );
    }
    for (const r of records) {
      const id = r.apiCallId as string;
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, r);
        continue;
      }
      prev.inputTokens = Math.max(prev.inputTokens, r.inputTokens);
      prev.outputTokens = Math.max(prev.outputTokens, r.outputTokens);
      prev.cacheReadTokens = Math.max(prev.cacheReadTokens, r.cacheReadTokens);
      prev.cacheWriteTokens = Math.max(prev.cacheWriteTokens, r.cacheWriteTokens);
      prev.reasoningTokens = Math.max(prev.reasoningTokens, r.reasoningTokens);
    }
  }
  return { records: [...byId.values()], cascades };
}
