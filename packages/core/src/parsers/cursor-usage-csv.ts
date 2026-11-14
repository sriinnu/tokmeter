/**
 * @sriinnu/tokmeter-core — parser for Cursor's own usage export.
 *
 * Cursor's dashboard serves an account-wide usage export
 * (`/api/dashboard/export-usage-events-csv?strategy=tokens`), which
 * `tokmeter cursor sync` downloads into ~/.cache/tokmeter/cursor-usage/. This
 * module turns those files into TokenRecords. It is exported for the Cursor
 * parser to adopt later; nothing in the scan pipeline calls it yet.
 *
 * Headers Cursor has shipped (from tokscale's parser, which reads the same
 * export: crates/tokscale-core/src/sessions/cursor.rs):
 *   v1: Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost,Cost to you
 *   v2: Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
 *   v3: Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
 * Columns are looked up by name, so all three parse.
 *
 * Bucket semantics. The two Input columns are DISJOINT, not a superset pair:
 * "Input (w/ Cache Write)" is the input that was written to the cache and
 * "Input (w/o Cache Write)" is plain input. Every real row tokscale ships as
 * a fixture satisfies Total = withCW + withoutCW + Cache Read + Output, e.g.
 * 28342 + 775 + 105891 + 21282 = 156290 — impossible if withCW included
 * withoutCW (775 − 28342 would be negative). CodexBar's docs say the same
 * ("preserve Cursor's disjoint input/cache counters"). So:
 *   cacheWriteTokens = Input (w/ Cache Write)
 *   inputTokens      = Input (w/o Cache Write)
 *   cacheReadTokens  = Cache Read
 *   outputTokens     = Output Tokens
 * and Total Tokens is only a cross-check, never added. A row whose Total only
 * balances under the superset reading (Total = withCW + read + output, with
 * withCW ≥ withoutCW) is mapped that way instead and noted, so a future
 * format change can't double count silently.
 *
 * Cost: Cursor's own number, used as a "direct" cost when numeric ("0.19",
 * "$9.50", "$0.00"). "Included" and "-" are not numbers: an included row is
 * left for normal pricing ("calculated"); an errored / no-charge row keeps its
 * tokens at cost 0, marked direct so pricing never bills it.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TokenRecord } from "../types.js";
import { createRecord } from "./utils.js";

/** Column names in Cursor's usage export. */
export const CURSOR_USAGE_COLUMNS = {
  date: "Date",
  cloudAgentId: "Cloud Agent ID",
  automationId: "Automation ID",
  kind: "Kind",
  model: "Model",
  maxMode: "Max Mode",
  inputWithCacheWrite: "Input (w/ Cache Write)",
  inputWithoutCacheWrite: "Input (w/o Cache Write)",
  cacheRead: "Cache Read",
  outputTokens: "Output Tokens",
  totalTokens: "Total Tokens",
  cost: "Cost",
} as const;

const REQUIRED_COLUMNS = [
  CURSOR_USAGE_COLUMNS.date,
  CURSOR_USAGE_COLUMNS.model,
  CURSOR_USAGE_COLUMNS.inputWithCacheWrite,
  CURSOR_USAGE_COLUMNS.inputWithoutCacheWrite,
  CURSOR_USAGE_COLUMNS.cacheRead,
  CURSOR_USAGE_COLUMNS.outputTokens,
];

/**
 * RFC 4180 CSV: quoted fields, `""` escapes, commas and newlines inside
 * quotes, CRLF or LF line ends, an optional UTF-8 BOM. Blank lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const pushRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

/** True when the first CSV row looks like Cursor's usage export header. */
export function isCursorUsageCsvHeader(header: string[]): boolean {
  const names = new Set(header.map((h) => h.trim()));
  return REQUIRED_COLUMNS.every((c) => names.has(c));
}

/**
 * Cursor's Cost cell as dollars, or null when it is not a number
 * ("Included", "-", empty, negative, non-finite). Accepts "$1,234.50".
 */
export function parseCursorCost(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** True for Kind values Cursor uses for rows it did not bill. */
export function isUnchargedKind(kind: string): boolean {
  return /errored|no charge|not charged/i.test(kind);
}

/** Cursor's "Auto" router (and "default") have no fixed model; name them. */
export function normalizeCursorModel(raw: string): string {
  const model = raw.trim();
  if (!model) return "unknown";
  const lower = model.toLowerCase();
  if (lower === "auto" || lower === "default") return "cursor-auto";
  return model;
}

/** ISO timestamp, or a bare date (pinned to noon UTC so its local day holds). */
export function parseCursorDate(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T12:00:00Z`);
    return Number.isFinite(t) ? t : null;
  }
  if (/^\d{12,14}$/.test(s)) return Number(s);
  // A datetime without a zone is UTC in Cursor's export (tokscale reads it so).
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? t : null;
}

function toCount(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw.replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** One parsed export row, before dedup. */
export interface CursorUsageRow {
  /**
   * Dedup key, also the record's threadKey: a hash of the row's identifying
   * columns (cost and kind excluded) plus its occurrence number in the file.
   */
  key: string;
  record: TokenRecord;
}

export interface CursorUsageCsvParse {
  rows: CursorUsageRow[];
  /** Rows dropped because their Date did not parse. */
  skipped: number;
}

/**
 * The columns that identify an event. Cost and Kind are left out on purpose:
 * Cursor can settle a row's charge after the fact, and a re-download must
 * replace the row, not add a second copy.
 */
function rowIdentity(get: (col: string) => string): string {
  const c = CURSOR_USAGE_COLUMNS;
  const parts = [
    get(c.date),
    get(c.cloudAgentId),
    get(c.automationId),
    get(c.model),
    get(c.maxMode),
    get(c.inputWithCacheWrite),
    get(c.inputWithoutCacheWrite),
    get(c.cacheRead),
    get(c.outputTokens),
  ].map((v) => v.trim());
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32);
}

/** Parse one export's text. Throws only when the header isn't Cursor's. */
export function parseCursorUsageCsv(text: string, sourceFile?: string): CursorUsageCsvParse {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], skipped: 0 };
  const header = table[0].map((h) => h.trim());
  if (!isCursorUsageCsvHeader(header)) {
    throw new Error("Not a Cursor usage export: the header is missing required columns");
  }
  const index = new Map(header.map((h, i) => [h, i]));
  const c = CURSOR_USAGE_COLUMNS;
  const hasCost = index.has(c.cost);

  // Identical rows inside one file are distinct events; number them so they
  // survive dedup, while the same row in an overlapping window file maps to
  // the same key.
  const seenInFile = new Map<string, number>();
  const rows: CursorUsageRow[] = [];
  let skipped = 0;

  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const get = (col: string): string => {
      const i = index.get(col);
      return i === undefined ? "" : (cells[i] ?? "");
    };
    const timestamp = parseCursorDate(get(c.date));
    if (timestamp === null) {
      skipped++;
      continue;
    }

    const withCW = toCount(get(c.inputWithCacheWrite));
    const withoutCW = toCount(get(c.inputWithoutCacheWrite));
    const cacheRead = toCount(get(c.cacheRead));
    const output = toCount(get(c.outputTokens));
    const notes: string[] = [];

    const inputTokens = withoutCW;
    let cacheWriteTokens = withCW;
    const totalRaw = get(c.totalTokens).trim();
    if (totalRaw !== "") {
      const total = toCount(totalRaw);
      const disjoint = withCW + withoutCW + cacheRead + output;
      const superset = withCW + cacheRead + output;
      if (total !== disjoint) {
        if (total === superset && withCW >= withoutCW) {
          cacheWriteTokens = withCW - withoutCW;
          notes.push(
            "Total Tokens balanced only with 'Input (w/ Cache Write)' as a superset of 'Input (w/o Cache Write)'; mapped cache write as their difference."
          );
        } else {
          notes.push(
            `Cursor's Total Tokens (${total}) does not equal the sum of its buckets (${disjoint}); buckets kept as exported.`
          );
        }
      }
    }

    const kind = get(c.kind).trim();
    const costCell = hasCost ? get(c.cost).trim() : "";
    const parsedCost = parseCursorCost(costCell);
    let cost = 0;
    let costProvenance: "direct" | "calculated";
    if (kind && isUnchargedKind(kind)) {
      costProvenance = "direct";
      notes.push(`Cursor marked this row "${kind}": tokens kept, cost 0.`);
    } else if (parsedCost !== null) {
      cost = parsedCost;
      costProvenance = "direct";
    } else {
      costProvenance = "calculated";
      if (costCell) {
        notes.push(`Cursor's cost cell was "${costCell}"; cost left to normal pricing.`);
      }
    }

    const identity = rowIdentity(get);
    const n = seenInFile.get(identity) ?? 0;
    seenInFile.set(identity, n + 1);
    const threadKey = `cursor-usage:${identity}#${n}`;

    const cloudAgentId = get(c.cloudAgentId).trim();
    const record = createRecord({
      timestamp,
      provider: "cursor",
      model: normalizeCursorModel(get(c.model)),
      project: cloudAgentId ? "cursor-cloud-agent" : "cursor",
      inputTokens,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens,
      reasoningTokens: 0,
      cost,
      threadKey,
      ...(sourceFile ? { sourceFile } : {}),
      usage: {
        source: "provider_api_usage",
        inputTokens: "direct",
        outputTokens: "direct",
        cacheReadTokens: "direct",
        cacheWriteTokens: notes.some((n) => n.includes("superset")) ? "calculated" : "direct",
        reasoningTokens: "not_exposed",
        cost: costProvenance,
        notes: ["From Cursor's account usage export (tokmeter cursor sync).", ...notes],
      },
    });
    rows.push({ key: threadKey, record });
  }
  return { rows, skipped };
}

/** Parse several export files and drop rows repeated across overlapping windows. */
export function mergeCursorUsageCsvs(
  files: Array<{ path: string; text: string; mtimeMs?: number }>
): {
  records: TokenRecord[];
  skipped: number;
  duplicates: number;
} {
  // Later files win, by mtime: the newest download's settled cost replaces an
  // older copy. A file name says which window it covers, not when it was
  // fetched. Name order only breaks an mtime tie.
  const ordered = [...files].sort(
    (a, b) =>
      (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0) || basename(a.path).localeCompare(basename(b.path))
  );
  const byKey = new Map<string, TokenRecord>();
  let skipped = 0;
  let total = 0;
  for (const file of ordered) {
    const parsed = parseCursorUsageCsv(file.text, file.path);
    skipped += parsed.skipped;
    total += parsed.rows.length;
    for (const row of parsed.rows) byKey.set(row.key, row.record);
  }
  const records = [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp);
  return { records, skipped, duplicates: total - records.length };
}

/** Read every `usage-*.csv` in a directory and merge them. Missing dir → []. */
export async function readCursorUsageCsvDir(
  dir: string
): Promise<{ records: TokenRecord[]; skipped: number; duplicates: number }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { records: [], skipped: 0, duplicates: 0 };
  }
  const files: Array<{ path: string; text: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!/^usage-.*\.csv$/.test(name)) continue;
    const path = join(dir, name);
    const { mtimeMs } = await stat(path);
    files.push({ path, text: await readFile(path, "utf-8"), mtimeMs });
  }
  return mergeCursorUsageCsvs(files);
}
