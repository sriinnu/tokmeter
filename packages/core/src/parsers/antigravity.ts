/**
 * @sriinnu/tokmeter-core — Antigravity (Google's agentic IDE) session parser.
 *
 * Antigravity is a VS Code fork whose agent history lives in a single global
 * "trajectory summaries" protobuf blob, base64-encoded inside its VS
 * Code-style key/value store:
 *   <UserDir>/globalStorage/state.vscdb (SQLite)
 *     key "antigravityUnifiedStateSync.trajectorySummaries"
 *
 * Google ships no public schema for this proto. It was decoded by hand here
 * using the wire format only (varint + length-delimited fields) — after
 * walking the full nested structure (title, timestamps, tool-call records,
 * even raw response text is present), no model id, token count, or cost
 * figure exists anywhere in it, nor anywhere else in the app's local state
 * or logs. The only per-agent-model reference found on disk is a single
 * *global*, app-wide "last selected model" enum constant with no public
 * mapping back to a model name — not usable per-session.
 *
 * What IS reliably recoverable, and is what this parser reports: one record
 * per agent session ("trajectory") with a start timestamp and a project
 * (resolved from the first file:// reference touched in that session).
 * model stays "unknown" and tokens/cost stay 0/not_exposed rather than
 * guessed at — see defaultUsageProvenance in utils.ts.
 *
 * Reads the SQLite file via bun:sqlite (Bun) or better-sqlite3 (Node),
 * whichever is available — see openReadonlySqlite in utils.ts. Bails to []
 * if neither driver is available or the on-disk schema no longer matches.
 */

import { join } from "node:path";
import { canonicalizeProjectName } from "../project-name.js";
import type { SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  fileExists,
  getConfiguredProviderPaths,
  openReadonlySqlite,
  vscodeFamilyUserDirs,
} from "./utils.js";

const APP_NAMES = ["Antigravity", "Antigravity IDE"];
const TRAJECTORY_SUMMARIES_KEY = "antigravityUnifiedStateSync.trajectorySummaries";

// ─── Minimal protobuf wire-format reader ───────────────────────────
// Only varint (wire type 0) and length-delimited (wire type 2) are needed
// for the fields this parser reads. Any other wire type ends parsing of
// that message early rather than guessing — a truncated read is safer
// than a misread.

interface WireField {
  num: number;
  wireType: number;
  varint?: number;
  bytes?: Uint8Array;
}

function readVarint(buf: Uint8Array, offset: number): [value: number, next: number] {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i];
    result |= (byte & 0x7f) << shift;
    i++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, i];
}

function readFields(buf: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  let i = 0;
  while (i < buf.length) {
    const [tag, afterTag] = readVarint(buf, i);
    const num = tag >>> 3;
    const wireType = tag & 0x7;
    if (wireType === 0) {
      const [val, next] = readVarint(buf, afterTag);
      fields.push({ num, wireType, varint: val });
      i = next;
    } else if (wireType === 2) {
      const [len, next] = readVarint(buf, afterTag);
      fields.push({ num, wireType, bytes: buf.subarray(next, next + len) });
      i = next + len;
    } else {
      break;
    }
  }
  return fields;
}

function field(fields: WireField[], num: number): WireField | undefined {
  return fields.find((f) => f.num === num);
}

// Printable-ASCII range, not a negated control-char class — captures the
// path up to the first protobuf-embedded non-text byte that follows it.
const FILE_URI_RE = /file:\/\/(\/[\x20-\x7e]+)/;

interface DecodedTrajectory {
  timestamp: number;
  project: string;
}

function decodeTrajectory(entryBytes: Uint8Array): DecodedTrajectory | null {
  const outer = readFields(entryBytes);
  const summaryWrapper = field(outer, 2)?.bytes;
  if (!summaryWrapper) return null;

  // The summary field is itself a one-field protobuf wrapper: field 1 holds
  // the actual payload as base64 text, not raw bytes directly. Decoding the
  // wrapper bytes as base64 without unwrapping first works "by accident" on
  // most entries — Buffer's base64 decoder silently drops the non-base64
  // wrapper tag/length header bytes — but not on all of them; it silently
  // dropped 1 real session out of 10 during testing.
  const base64Text = field(readFields(summaryWrapper), 1)?.bytes;
  if (!base64Text) return null;

  let inner: WireField[];
  try {
    inner = readFields(
      new Uint8Array(Buffer.from(Buffer.from(base64Text).toString("utf-8"), "base64"))
    );
  } catch {
    return null;
  }

  let timestamp: number | undefined;
  const ts = field(inner, 3)?.bytes;
  if (ts) {
    const seconds = field(readFields(ts), 1)?.varint;
    if (typeof seconds === "number") timestamp = seconds * 1000;
  }
  if (!timestamp) return null;

  let project = "antigravity";
  const refs = field(inner, 9)?.bytes;
  if (refs) {
    const match = FILE_URI_RE.exec(Buffer.from(refs).toString("utf-8"));
    if (match) {
      // decodeURIComponent throws on a lone "%" not followed by two hex
      // digits — plausible in a real path (e.g. "100%done") and certain in
      // whatever garbage the regex occasionally captures from adjacent
      // protobuf bytes. Uncaught, this was propagating out of the per-entry
      // loop in scan() and silently dropping every remaining trajectory in
      // the database, not just the one with the bad path.
      try {
        project = canonicalizeProjectName(decodeURIComponent(match[1]), "antigravity");
      } catch {
        // keep the "antigravity" fallback; a bad path is not a reason to
        // lose the timestamp we already have
      }
    }
  }

  return { timestamp, project };
}

export class AntigravityParser implements SessionParser {
  readonly providerId = "antigravity" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];
    const userDirs = [
      ...vscodeFamilyUserDirs(APP_NAMES, homeDir),
      ...getConfiguredProviderPaths("antigravity", homeDir).map((p) => expandHome(p, homeDir)),
    ];

    for (const userDir of userDirs) {
      const dbPath = join(userDir, "globalStorage", "state.vscdb");
      if (!(await fileExists(dbPath))) continue;

      const db = await openReadonlySqlite(dbPath);
      if (!db) continue;

      try {
        const row = db.get<{ value?: string }>(
          "SELECT value FROM ItemTable WHERE key = ?",
          TRAJECTORY_SUMMARIES_KEY
        );
        if (!row?.value) continue;

        const raw = new Uint8Array(Buffer.from(row.value, "base64"));
        const entries = readFields(raw).filter((f) => f.num === 1 && f.bytes);

        for (const entry of entries) {
          const decoded = decodeTrajectory(entry.bytes as Uint8Array);
          if (!decoded) continue;
          records.push(
            createRecord({
              timestamp: decoded.timestamp,
              provider: "antigravity",
              model: "unknown",
              project: decoded.project,
              sourceFile: dbPath,
            })
          );
        }
      } catch {
        // Antigravity's schema moved — fail soft rather than crash the scan
      } finally {
        db.close();
      }
    }
    return records;
  }
}
