/**
 * @sriinnu/tokmeter-core — opt-in download of the owner's Cursor usage.
 *
 * Cursor keeps most of its usage server-side: Tab completions, cloud agents,
 * other machines and the billed cost never reach a local file. This module
 * fetches the account's own usage export from cursor.com so tokmeter can
 * count it. It is tokmeter's only credentialed network call, so:
 *
 * - It runs only when `tokmeter cursor sync` is invoked. Nothing here is
 *   wired into the daemon or a scan.
 * - The session is read at call time, read-only, from the Cursor app's own
 *   state.vscdb (`ItemTable` → `cursorAuth/accessToken`). Tokmeter never
 *   refreshes a token, never writes Cursor's files and never stores the
 *   token anywhere; an expired token is refused, not renewed.
 * - The token, the cookie built from it and any email are scrubbed from every
 *   error and log line this module produces.
 * - The only request is GET https://cursor.com/api/dashboard/export-usage-events-csv
 *   (the same endpoint tokscale used for its CSV sync), carrying the session
 *   cookie. Responses land atomically, owner-only, in
 *   ~/.cache/tokmeter/cursor-usage/usage-YYYY-MM.csv, one file per UTC
 *   calendar month, so a later run rewrites the same files.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isCursorUsageCsvHeader, parseCsv } from "./parsers/cursor-usage-csv.js";
import { openReadonlySqlite } from "./parsers/utils.js";
import { writePrivateFile } from "./private-files.js";

export const CURSOR_ORIGIN = "https://cursor.com";
export const CURSOR_EXPORT_PATH = "/api/dashboard/export-usage-events-csv";
const TOKEN_KEY = "cursorAuth/accessToken";
const DAY_MS = 86_400_000;
/** Tokens this close to expiry are treated as expired (CodexBar uses 60s). */
const EXPIRY_SLACK_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * No range limit is documented. tokscale fetched the whole history in one
 * request (no dates at all, 120 s timeout for large accounts). One UTC
 * calendar month per request keeps each small enough for a 30 s timeout, and
 * fixed month boundaries give the same file names on every run.
 */
const DEFAULT_LOOKBACK_DAYS = 90;
/** tokscale's cap for the same export. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** An error whose message is already scrubbed of credentials. */
export class CursorSyncError extends Error {
  constructor(
    message: string,
    readonly code:
      | "no-database"
      | "no-token"
      | "bad-token"
      | "encrypted-token"
      | "expired"
      | "auth"
      | "http"
      | "timeout"
      | "network"
      | "bad-response"
  ) {
    super(message);
    this.name = "CursorSyncError";
  }
}

export interface CursorSyncPaths {
  homeDir?: string;
  /** Cursor's state.vscdb. Default: the macOS / Linux / Windows Cursor user dirs. */
  stateDbPath?: string;
  /** Where exports are written. Default ~/.cache/tokmeter/cursor-usage. */
  cacheDir?: string;
}

export interface CursorSyncOptions extends CursorSyncPaths {
  fetch?: typeof fetch;
  now?: () => number;
  /** Start of the download, ms. Default: 90 days ago. */
  sinceMs?: number;
  timeoutMs?: number;
  /** Body size cap, bytes. Default 64 MB. Exposed for tests. */
  maxBodyBytes?: number;
  /** Progress lines. Scrubbed before they are emitted. */
  log?: (line: string) => void;
}

export interface CursorTokenStatus {
  present: boolean;
  /** Hours until expiry; negative when expired. Absent when no token. */
  expiresInHours?: number;
  expired?: boolean;
  /** Set when a token exists but can't be used (encrypted, malformed). */
  problem?: string;
  dbPath?: string;
}

export interface CursorSyncWindow {
  from: string;
  to: string;
  rows: number;
  file: string;
  /** False when an existing file with more rows was kept (grow-only). */
  written: boolean;
}

export interface CursorSyncResult {
  from: string;
  to: string;
  windows: CursorSyncWindow[];
  rows: number;
  cacheDir: string;
}

export function cursorUsageCacheDir(homeDir: string = homedir()): string {
  return join(homeDir, ".cache", "tokmeter", "cursor-usage");
}

export function cursorStateDbCandidates(homeDir: string = homedir()): string[] {
  return [
    join(
      homeDir,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb"
    ),
    join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    join(homeDir, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
}

// ─── Scrubbing ──────────────────────────────────────────────────────────────

const JWT_RE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const COOKIE_RE = /WorkosCursorSessionToken=[^;\s"']*/gi;

/** Remove every credential-shaped substring, plus the exact secrets given. */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  const exact = [...secrets]
    .filter((s) => s && s.length >= 6)
    .flatMap((s) => [s, encodeURIComponent(s)])
    .sort((a, b) => b.length - a.length);
  for (const s of exact) out = out.split(s).join("[redacted]");
  return out
    .replace(COOKIE_RE, "WorkosCursorSessionToken=[redacted]")
    .replace(JWT_RE, "[redacted-jwt]")
    .replace(EMAIL_RE, "[redacted-email]");
}

// ─── Token ──────────────────────────────────────────────────────────────────

interface CursorSession {
  jwt: string;
  userId: string;
  expMs: number;
}

function base64UrlJson(part: string): Record<string, unknown> | null {
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function decodeStoredValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    // BOM-less UTF-16LE ASCII (interleaved NULs) shows up in some VS Code-family DBs.
    if (value.length >= 4 && value[1] === 0 && value[3] === 0) {
      return Buffer.from(value).toString("utf16le");
    }
    return Buffer.from(value).toString("utf-8");
  }
  return null;
}

function resolveDbPath(paths: CursorSyncPaths): string | null {
  if (paths.stateDbPath) return existsSync(paths.stateDbPath) ? paths.stateDbPath : null;
  return cursorStateDbCandidates(paths.homeDir).find((p) => existsSync(p)) ?? null;
}

/** Read and validate the session. Never returns or throws the raw token in text. */
async function readSession(
  paths: CursorSyncPaths
): Promise<{ dbPath: string; session: CursorSession | null; problem?: CursorSyncError }> {
  const dbPath = resolveDbPath(paths);
  if (!dbPath) {
    throw new CursorSyncError(
      "Cursor's state database was not found. Install Cursor and sign in first.",
      "no-database"
    );
  }
  let raw: string | null = null;
  try {
    const db = await openReadonlySqlite(dbPath);
    try {
      const row = db.get<{ value: unknown }>(
        "SELECT value FROM ItemTable WHERE key = ?",
        TOKEN_KEY
      );
      raw = row ? decodeStoredValue(row.value) : null;
    } finally {
      db.close();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new CursorSyncError(
      scrubSecrets(`Could not read Cursor's state database: ${msg}`),
      "no-database"
    );
  }
  const token = raw?.trim().replace(/^"|"$/g, "") ?? "";
  if (!token) return { dbPath, session: null };

  const fail = (message: string, code: CursorSyncError["code"]) => ({
    dbPath,
    session: null,
    problem: new CursorSyncError(message, code),
  });
  if (token.startsWith("cursor-safe-storage:")) {
    return fail(
      "Cursor stores this session encrypted (safe storage). tokmeter does not decrypt it yet.",
      "encrypted-token"
    );
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
    return fail("Cursor's stored session is not a JWT tokmeter can use.", "bad-token");
  }
  const payload = base64UrlJson(parts[1]);
  const sub = typeof payload?.sub === "string" ? payload.sub : "";
  const userId = sub.includes("|") ? sub.slice(sub.lastIndexOf("|") + 1) : sub;
  const exp = typeof payload?.exp === "number" ? payload.exp : Number.NaN;
  if (!userId || !/^[A-Za-z0-9_-]+$/.test(userId) || !Number.isFinite(exp)) {
    return fail("Cursor's stored session is missing its user id or expiry.", "bad-token");
  }
  return { dbPath, session: { jwt: token, userId, expMs: exp * 1000 } };
}

/** Presence and expiry only. Safe to print: carries no credential. */
export async function cursorTokenStatus(
  paths: CursorSyncPaths & { now?: () => number } = {}
): Promise<CursorTokenStatus> {
  const now = (paths.now ?? Date.now)();
  let read: Awaited<ReturnType<typeof readSession>>;
  try {
    read = await readSession(paths);
  } catch (error) {
    return { present: false, problem: (error as Error).message };
  }
  if (!read.session) {
    return read.problem
      ? { present: true, problem: read.problem.message, dbPath: read.dbPath }
      : { present: false, dbPath: read.dbPath };
  }
  const hours = (read.session.expMs - now) / 3_600_000;
  return {
    present: true,
    expiresInHours: Math.round(hours * 10) / 10,
    expired: read.session.expMs - EXPIRY_SLACK_MS <= now,
    dbPath: read.dbPath,
  };
}

// ─── Download ───────────────────────────────────────────────────────────────

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface CursorSyncMonth {
  /** "YYYY-MM", UTC. Names the file. */
  month: string;
  /** UTC midnight on the 1st. */
  fromMs: number;
  /** Request end: the next month's 1st, or `nowMs` for the current month. */
  toMs: number;
}

/**
 * UTC calendar months from the month holding `sinceMs` through the one
 * holding `nowMs`. Each month is downloaded whole (from its 1st, even when
 * `sinceMs` is later), so a month's file always means the same thing and a
 * re-run only grows it.
 */
export function cursorSyncWindows(sinceMs: number, nowMs: number): CursorSyncMonth[] {
  const out: CursorSyncMonth[] = [];
  const first = new Date(sinceMs);
  let y = first.getUTCFullYear();
  let m = first.getUTCMonth();
  for (;;) {
    const fromMs = Date.UTC(y, m, 1);
    if (fromMs >= nowMs) break;
    const nextMs = Date.UTC(y, m + 1, 1);
    out.push({
      month: `${y}-${String(m + 1).padStart(2, "0")}`,
      fromMs,
      toMs: Math.min(nextMs, nowMs),
    });
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
}

/**
 * Read a response body, refusing it once it passes `maxBytes`. Counted while
 * streaming, so an oversized or endless body is cut off, not buffered.
 * Returns null when the cap is passed.
 */
async function readCappedBody(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function existingRowCount(path: string): number {
  try {
    return Math.max(0, parseCsv(readFileSync(path, "utf-8")).length - 1);
  } catch {
    return -1;
  }
}

/**
 * Download the account's usage export for [since, now) into the cache dir.
 * Throws CursorSyncError (scrubbed) on any failure; files already written for
 * earlier windows stay.
 */
export async function syncCursorUsage(options: CursorSyncOptions = {}): Promise<CursorSyncResult> {
  const now = (options.now ?? Date.now)();
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheDir = options.cacheDir ?? cursorUsageCacheDir(options.homeDir);
  const read = await readSession(options);
  if (read.problem) throw read.problem;
  if (!read.session) {
    throw new CursorSyncError(
      "No Cursor session found. Open Cursor and sign in, then run this again.",
      "no-token"
    );
  }
  const session = read.session;
  const cookieValue = encodeURIComponent(`${session.userId}::${session.jwt}`);
  const secrets = [
    session.jwt,
    cookieValue,
    `${session.userId}::${session.jwt}`,
    ...session.jwt.split("."),
  ];
  const scrub = (s: string) => scrubSecrets(s, secrets);
  const log = (line: string) => options.log?.(scrub(line));

  if (session.expMs - EXPIRY_SLACK_MS <= now) {
    const ago = Math.max(0, Math.round((now - session.expMs) / 3_600_000));
    throw new CursorSyncError(
      `Cursor's session expired ${ago}h ago. Open Cursor and sign in again; tokmeter never refreshes it.`,
      "expired"
    );
  }

  const sinceMs = options.sinceMs ?? now - DEFAULT_LOOKBACK_DAYS * DAY_MS;
  if (!(sinceMs < now)) {
    throw new CursorSyncError("--since must be in the past.", "bad-response");
  }
  const windows = cursorSyncWindows(sinceMs, now);
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const results: CursorSyncWindow[] = [];

  for (const w of windows) {
    const url = new URL(CURSOR_EXPORT_PATH, CURSOR_ORIGIN);
    url.searchParams.set("startDate", String(w.fromMs));
    url.searchParams.set("endDate", String(w.toMs));
    url.searchParams.set("strategy", "tokens");
    const from = utcDay(w.fromMs);
    const to = utcDay(w.toMs);
    log(`Fetching Cursor usage ${from} → ${to}`);

    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method: "GET",
        headers: {
          Cookie: `WorkosCursorSessionToken=${cookieValue}`,
          Origin: CURSOR_ORIGIN,
          Referer: `${CURSOR_ORIGIN}/dashboard`,
          Accept: "text/csv, */*",
          "User-Agent": BROWSER_UA,
        },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const e = error as Error;
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new CursorSyncError(
          `cursor.com did not answer within ${Math.round(timeoutMs / 1000)}s (${from} → ${to}).`,
          "timeout"
        );
      }
      throw new CursorSyncError(
        scrub(`Could not reach cursor.com: ${e?.message ?? String(error)}`),
        "network"
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new CursorSyncError(
        `cursor.com rejected the session (HTTP ${res.status}). Open Cursor and sign in again.`,
        "auth"
      );
    }
    if (!res.ok) {
      throw new CursorSyncError(
        `cursor.com returned HTTP ${res.status} for ${from} → ${to}.`,
        "http"
      );
    }
    const tooBig = () =>
      new CursorSyncError(
        `Cursor's export for ${w.month} is over ${maxBodyBytes} bytes. Nothing was written for it.`,
        "bad-response"
      );
    const advertised = Number(res.headers.get("content-length") ?? "0");
    if (advertised > maxBodyBytes) {
      await res.body?.cancel().catch(() => {});
      throw tooBig();
    }
    const body = await readCappedBody(res, maxBodyBytes);
    if (body === null) throw tooBig();
    const table = parseCsv(body);
    if (table.length === 0 || !isCursorUsageCsvHeader(table[0].map((h) => h.trim()))) {
      // A 200 that isn't the CSV (login page, WAF challenge, API change).
      throw new CursorSyncError(
        `cursor.com answered ${from} → ${to} with something that is not a usage export. Nothing was written.`,
        "bad-response"
      );
    }
    const rows = table.length - 1;
    const file = join(cacheDir, `usage-${w.month}.csv`);
    // Grow-only: Cursor keeps its events, so a re-download with fewer rows
    // than the copy on disk is a bad answer, not a correction.
    const before = existingRowCount(file);
    const written = before <= rows;
    if (written) writePrivateFile(file, body);
    else log(`Kept ${file}: it has ${before} rows, the new download has ${rows}.`);
    results.push({ from, to, rows, file, written });
  }

  return {
    from: utcDay(windows[0]?.fromMs ?? sinceMs),
    to: utcDay(now),
    windows: results,
    rows: results.reduce((n, w) => n + w.rows, 0),
    cacheDir,
  };
}
