/**
 * @sriinnu/tokmeter-core — Grow-only today.
 *
 * Today is re-derived on every tick from the session files present right now,
 * so a thread archived-and-deleted (or just deleted) before midnight used to
 * drop out of the day it ran in: 10-14 lost 64.3M Codex tokens that way, and
 * the loss was sealed. This keeps the last records each file produced today
 * and, when a file disappears from the scan, carries those records forward
 * until the day seals.
 *
 * File-level on purpose. Files that still exist behave exactly as before
 * (their records are replaced wholesale each tick), so placeholder-then-final
 * parsers (Kilo, Roo) and cumulative snapshots stay correct. Only a vanished
 * file's last-seen records are added back, minus any that the live scan still
 * has under another path (an archive moves a Codex rollout; same response id
 * or same fingerprint means already counted).
 *
 * Shared databases (Zed, Cursor, OpenCode, Kilo CLI) never vanish, so their
 * parsers name the thread or message each record belongs to, and those are
 * carried per thread instead.
 *
 * Persisted to ~/.cache/tokmeter/today/<date>.json: what's carried, plus a
 * periodic snapshot of everything seen, so a restart notices files deleted
 * while it was down and a cold start that seals a missed day folds them in
 * ({@link carriedRecordsFor}).
 *
 * A file rewritten smaller in place (a transcript pruned by hand) still
 * exists, so file-level carrying can't see what it lost. For providers whose
 * record ids are the provider's own per-response ids ({@link STABLE_RECORD_IDS}),
 * a record whose id disappears from the whole live scan is carried on its own.
 * Parsers that number records by position (Cline, Augment's fallback) or have
 * no id (Roo, Kilo, Gemini, Qwen) would carry a renumbered record as a lost
 * one, so they're left file-level; they're also the ones that rewrite files.
 *
 * Not covered: a shrunk file from those parsers, a shared database whose every
 * thread was deleted (indistinguishable from unreadable), and deletions before
 * the first snapshot was ever saved.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isValidRecord, recordFingerprint } from "./aggregates.js";
import { localDateKey } from "./date-utils.js";
import { sanitizeDataLabel } from "./display-safety.js";
import { ensurePrivateDirectory, ensurePrivateFile } from "./private-files.js";
import type { ProviderId, TokenRecord } from "./types.js";

const JOURNAL_DIR_NAME = ".cache/tokmeter/today";
const JOURNAL_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.json$/;
/** Keep a few days of journals: a gap-fill after days offline still finds them. */
const KEEP_DAYS = 7;
/**
 * How often the full "seen" snapshot is saved. It's what lets a restart notice
 * a file deleted while the daemon was down; a few minutes stale is fine, and
 * writing it every 12s tick would churn megabytes for nothing.
 */
const SEEN_SAVE_INTERVAL_MS = 5 * 60_000;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_RECORDS = 600_000;

class JournalLimitError extends Error {}
class JournalIntegrityError extends Error {}

/**
 * Providers whose files are shared databases: the file never vanishes, so a
 * file-level carry can't see a deleted thread. Zed and Cursor tag each record
 * with a {@link TokenRecord.threadKey} instead and are carried per thread
 * (so are OpenCode and Kilo CLI database rows; their JSON store has a file
 * per message and carries as files). Antigravity and VS Code Copilot record
 * no tokens.
 * Cursor's CSV exports are excluded too: the parser reads either the CSVs or
 * the database, so when one appears the other's records all disappear, and
 * carrying them would count the same usage twice.
 *
 * codex-desktop is a lifetime running total per thread, minus a day baseline,
 * keyed by the rollout path. Archiving rewrites that path (so the old path
 * would be carried while the new one emits the same delta again), and a
 * thread that codex.ts starts counting stops emitting here (so the carried
 * copy would duplicate codex.ts). Its fingerprint moves with updated_at, so
 * dedup can't catch either. Never carried.
 */
const NEVER_CARRIED_WITHOUT_THREAD = new Set<ProviderId>([
  "zed",
  "cursor",
  "antigravity",
  "vscode-copilot",
  "codex-desktop",
]);

/**
 * Providers whose `apiCallId` is the provider's own id for one response
 * (message.id, response_id, a message uuid), unchanged when the file around
 * it is rewritten. Only these carry single records that vanish from a file
 * that still exists.
 */
const STABLE_RECORD_IDS = new Set<ProviderId>([
  "claude-code",
  "codex",
  "kimi",
  "copilot-cli",
  "muse",
]);

/** Carried-unit key for one record gone from a file that still exists. */
const GONE = "#gone:";

interface JournalFile {
  version: 1;
  date: string;
  /** unit → its last records today, for units that have since vanished. */
  carried: Record<string, TokenRecord[]>;
  /** unit → its records at the last snapshot, for a restart to diff against. */
  seen?: Record<string, TokenRecord[]>;
}

function journalDir(homeDir: string): string {
  return join(homeDir, JOURNAL_DIR_NAME);
}

function journalPath(homeDir: string, date: string): string {
  return join(journalDir(homeDir), `${date}.json`);
}

/**
 * What a record is carried as part of: its thread, when the provider names
 * one inside a shared file, else its file. Provider-scoped, so two parsers
 * reading the same path stay separate. Null: never carried.
 */
function unitOf(r: TokenRecord): string | null {
  if (typeof r.sourceFile !== "string" || r.sourceFile === "") return null;
  if (r.threadKey) return `${r.provider}|${r.sourceFile}#${r.threadKey}`;
  if (NEVER_CARRIED_WITHOUT_THREAD.has(r.provider)) return null;
  return `${r.provider}|${r.sourceFile}`;
}

const sharedFileOf = (r: TokenRecord) => `${r.provider}|${r.sourceFile}`;

function readJournal(homeDir: string, date: string): JournalFile | null {
  const path = journalPath(homeDir, date);
  ensurePrivateDirectory(journalDir(homeDir));
  if (!existsSync(path)) return null;
  try {
    ensurePrivateFile(path);
    if (statSync(path).size > MAX_JOURNAL_BYTES) {
      throw new JournalLimitError(`Today journal exceeds ${MAX_JOURNAL_BYTES} bytes: ${path}`);
    }
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (
      raw?.version !== 1 ||
      raw.date !== date ||
      !raw.carried ||
      typeof raw.carried !== "object" ||
      Array.isArray(raw.carried)
    ) {
      throw new JournalIntegrityError(`Invalid today journal schema: ${path}`);
    }
    return raw as JournalFile;
  } catch (error) {
    // Existing journals are authoritative for transcripts already deleted.
    // Never turn corruption or an unsafe path into an apparently empty day.
    if (error instanceof JournalLimitError || error instanceof JournalIntegrityError) throw error;
    throw new JournalIntegrityError(
      `Unable to read authoritative today journal ${path}: ${error instanceof Error ? error.message : error}`
    );
  }
}

function toMap(obj: Record<string, TokenRecord[]> | undefined): Map<string, TokenRecord[]> {
  const out = new Map<string, TokenRecord[]>();
  let validRecords = 0;
  for (const [unit, records] of Object.entries(obj ?? {})) {
    if (Array.isArray(records) && records.length > 0) {
      const safeRecords = records.flatMap((rawRecord) => {
        if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) return [];
        const record = rawRecord as TokenRecord;
        if (record.toolCalls !== undefined && !Array.isArray(record.toolCalls)) return [];
        const normalized: TokenRecord = {
          ...record,
          // Journals survive parser upgrades and can contain labels written by
          // older versions. Re-apply the display trust boundary on hydration,
          // but preserve identity fields used for accounting and deduplication.
          provider: (sanitizeDataLabel(record.provider, 128) || "custom") as ProviderId,
          project: sanitizeDataLabel(record.project) || "unknown",
          model: sanitizeDataLabel(record.model) || "unknown",
          ...(record.cwd === undefined
            ? {}
            : { cwd: sanitizeDataLabel(record.cwd, 4096) || undefined }),
          ...(record.toolCalls === undefined
            ? {}
            : {
                toolCalls: record.toolCalls
                  .map((tool) => sanitizeDataLabel(tool, 256))
                  .filter(Boolean)
                  .slice(0, 256),
              }),
        };
        return isValidRecord(normalized) ? [normalized] : [];
      });
      validRecords += safeRecords.length;
      if (validRecords > MAX_JOURNAL_RECORDS) {
        throw new JournalLimitError(`Today journal exceeds ${MAX_JOURNAL_RECORDS} valid records`);
      }
      if (safeRecords.length > 0) out.set(unit, safeRecords);
    }
  }
  return out;
}

/**
 * `live` plus the carried records it doesn't already have. A carried record is
 * already counted when the live scan (or another carried unit: a Codex rollout
 * archived and then deleted is carried under both paths) has the same
 * response id, the same thread, or the same fingerprint.
 */
export function withCarried(live: TokenRecord[], carried: Iterable<TokenRecord>): TokenRecord[] {
  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  const remember = (r: TokenRecord) => {
    if (r.apiCallId) ids.add(`${r.provider}|${r.apiCallId}`);
    if (r.threadKey) ids.add(`${r.provider}|thread:${r.threadKey}`);
    fingerprints.add(recordFingerprint(r));
  };
  for (const r of live) remember(r);
  const out = [...live];
  for (const r of carried) {
    if (r.apiCallId && ids.has(`${r.provider}|${r.apiCallId}`)) continue;
    if (r.threadKey && ids.has(`${r.provider}|thread:${r.threadKey}`)) continue;
    if (fingerprints.has(recordFingerprint(r))) continue;
    remember(r);
    out.push(r);
  }
  return out;
}

/** Dates that have a journal on disk, oldest first. */
export function journalDates(homeDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(journalDir(homeDir));
  } catch {
    return [];
  }
  const dates: string[] = [];
  for (const name of names) {
    const m = JOURNAL_FILE_PATTERN.exec(name);
    if (m) dates.push(m[1]!);
  }
  return dates.sort();
}

/**
 * What a past day's journal says vanished: its carried records, plus any
 * file from its last "seen" snapshot that is gone from disk now (deleted
 * while no daemon ran). For a cold start that seals a day the daemon never
 * got to seal itself (it was down at midnight).
 */
export function carriedRecordsFor(homeDir: string, date: string): TokenRecord[] {
  const journal = readJournal(homeDir, date);
  if (!journal) return [];
  const carried = toMap(journal.carried);
  for (const [unit, records] of toMap(journal.seen)) {
    if (carried.has(unit) || records[0]!.threadKey) continue;
    if (!existsSync(records[0]!.sourceFile!)) carried.set(unit, records);
  }
  const out: TokenRecord[] = [];
  for (const records of carried.values()) {
    for (const r of records) if (localDateKey(r.timestamp) === date) out.push(r);
  }
  return out;
}

export class TodayJournal {
  private date: string | null = null;
  /** Today's records per unit from the previous full tick. */
  private lastSeen = new Map<string, TokenRecord[]>();
  /**
   * The saved snapshot from before this process started, diffed once on the
   * first tick. Stricter than lastSeen: a file counts as deleted only if it's
   * gone from disk, since a parser upgrade may legitimately emit it differently.
   */
  private restoredSeen: Map<string, TokenRecord[]> | null = null;
  /** Units seen today that have since vanished. */
  private carried = new Map<string, TokenRecord[]>();
  /** The first tick's time until the first save, so a one-shot CLI never writes it. */
  private seenSavedAt: number | null = null;

  constructor(private readonly homeDir: string) {}

  /**
   * Fold one full scan into the journal and return today's records: the live
   * ones plus whatever vanished files and threads still owe the day.
   * `alsoScanned` is the rest of the same scan (records from earlier days); it
   * only tells which shared files were read this tick. Call only with an
   * unfiltered scan; a provider-filtered scan would make every other
   * provider's files look deleted (use {@link withCarriedFor}).
   */
  reconcile(live: TokenRecord[], now: number, alsoScanned: TokenRecord[] = []): TokenRecord[] {
    const today = localDateKey(now);
    if (this.date !== today) this.startDay(today);

    const liveByUnit = new Map<string, TokenRecord[]>();
    for (const r of live) {
      if (localDateKey(r.timestamp) !== today) continue;
      const unit = unitOf(r);
      if (unit === null) continue;
      const list = liveByUnit.get(unit);
      if (list) list.push(r);
      else liveByUnit.set(unit, [r]);
    }
    // A thread missing from a shared file counts as deleted only if that file
    // was read this tick; an unreadable database (locked, schema moved) or
    // Cursor switching to its CSVs must not look like every thread deleted.
    const sharedFilesRead = new Set<string>();
    for (const r of [...live, ...alsoScanned]) {
      if (r.threadKey && r.sourceFile) sharedFilesRead.add(sharedFileOf(r));
    }

    let dirty = false;
    const nextSeen = new Map(liveByUnit);
    const diff = (previous: Map<string, TokenRecord[]>, restored: boolean) => {
      for (const [unit, records] of previous) {
        if (liveByUnit.has(unit) || this.carried.has(unit)) continue;
        const first = records[0]!;
        if (first.threadKey && !sharedFilesRead.has(sharedFileOf(first))) {
          // Not read this tick: remember its threads until it is, so one
          // deleted during the outage still gets carried.
          nextSeen.set(unit, records);
          continue;
        }
        if (restored && !first.threadKey && existsSync(first.sourceFile!)) continue;
        this.carried.set(unit, records);
        dirty = true;
      }
    };
    diff(this.lastSeen, false);

    // Records gone from a file that's still here. Only against lastSeen (this
    // process's own parse): a restored snapshot may predate a parser upgrade
    // that renamed ids. An id still anywhere in the live scan (a Codex fork's
    // winner moved files) is not gone.
    const liveIds = new Set<string>();
    for (const r of live) if (r.apiCallId) liveIds.add(`${r.provider}|${r.apiCallId}`);
    for (const [unit, records] of this.lastSeen) {
      if (!liveByUnit.has(unit)) continue;
      for (const r of records) {
        if (!r.apiCallId || !STABLE_RECORD_IDS.has(r.provider)) continue;
        if (liveIds.has(`${r.provider}|${r.apiCallId}`)) continue;
        const key = `${unit}${GONE}${r.apiCallId}`;
        if (this.carried.has(key)) continue;
        this.carried.set(key, [r]);
        dirty = true;
      }
    }

    if (this.restoredSeen) {
      diff(this.restoredSeen, true);
      this.restoredSeen = null;
    }
    const returned: string[] = [];
    for (const unit of liveByUnit.keys()) {
      // It came back (a scan that failed for a tick, a restored file).
      if (this.carried.delete(unit)) returned.push(unit);
    }
    for (const [key, [r]] of this.carried) {
      if (key.includes(GONE) && liveIds.has(`${r!.provider}|${r!.apiCallId}`)) {
        this.carried.delete(key);
        returned.push(key);
      }
    }
    this.lastSeen = nextSeen;
    this.seenSavedAt ??= now;
    const saveSeen = now - this.seenSavedAt >= SEEN_SAVE_INTERVAL_MS;
    if (dirty || returned.length > 0 || saveSeen) this.persist(saveSeen, now, returned);

    if (this.carried.size === 0) return live;
    return withCarried(live, this.carriedRecords());
  }

  /**
   * A provider-filtered scan of today plus what those providers' vanished
   * files still owe the day. Read-only: a filtered scan can't tell a deleted
   * file from a filtered-out one.
   */
  withCarriedFor(live: TokenRecord[], providers: ProviderId[], now: number): TokenRecord[] {
    const today = localDateKey(now);
    if (this.date !== today) this.startDay(today);
    const wanted = new Set(providers);
    const carried = [...this.carriedRecords()].filter((r) => wanted.has(r.provider));
    return carried.length === 0 ? live : withCarried(live, carried);
  }

  /** Units (files, or threads in a shared file) being carried. */
  carriedFiles(): string[] {
    return [...this.carried.keys()];
  }

  private *carriedRecords(): Generator<TokenRecord> {
    for (const records of this.carried.values()) {
      for (const r of records) if (localDateKey(r.timestamp) === this.date) yield r;
    }
  }

  private startDay(date: string): void {
    this.date = date;
    this.lastSeen = new Map();
    this.carried = new Map();
    this.restoredSeen = null;
    const loaded = readJournal(this.homeDir, date);
    if (loaded) {
      this.carried = toMap(loaded.carried);
      const seen = toMap(loaded.seen);
      if (seen.size > 0) this.restoredSeen = seen;
    }
    this.prune(date);
  }

  /**
   * Save the journal. Other processes (the MCP tracker, a CLI run, the web
   * dashboard) keep journals of their own, so carried units already on disk
   * are kept rather than overwritten; a unit is dropped only when this
   * process carried it and then saw it come back.
   */
  private persist(saveSeen: boolean, now: number, returned: string[] = []): void {
    if (!this.date) return;
    const onDisk = readJournal(this.homeDir, this.date);
    const carried = toMap(onDisk?.carried);
    // Another process's carried unit that's live here stays: withCarried
    // drops it as already counted, and this process may simply be behind.
    for (const unit of returned) carried.delete(unit);
    for (const [unit, records] of this.carried) carried.set(unit, records);
    this.carried = carried;
    const body: JournalFile = {
      version: 1,
      date: this.date,
      carried: Object.fromEntries(carried),
      seen: saveSeen ? Object.fromEntries(this.lastSeen) : onDisk?.seen,
    };
    const recordCount = [...Object.values(body.carried), ...Object.values(body.seen ?? {})].reduce(
      (sum, records) => sum + records.length,
      0
    );
    if (recordCount > MAX_JOURNAL_RECORDS) {
      throw new JournalLimitError(`Today journal exceeds ${MAX_JOURNAL_RECORDS} valid records`);
    }
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > MAX_JOURNAL_BYTES) {
      throw new JournalLimitError(`Today journal exceeds ${MAX_JOURNAL_BYTES} bytes`);
    }
    let tmp: string | null = null;
    try {
      const dir = journalDir(this.homeDir);
      ensurePrivateDirectory(join(this.homeDir, ".cache", "tokmeter"));
      ensurePrivateDirectory(dir);
      const path = journalPath(this.homeDir, this.date);
      tmp = `${path}.${process.pid}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeFileSync(fd, serialized, { encoding: "utf-8" });
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
      tmp = null;
      if (saveSeen) this.seenSavedAt = now;
    } catch (error) {
      if (tmp) {
        try {
          unlinkSync(tmp);
        } catch {
          /* best effort */
        }
      }
      throw new JournalIntegrityError(
        `Unable to persist authoritative today journal: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  private prune(today: string): void {
    let names: string[];
    try {
      names = readdirSync(journalDir(this.homeDir));
    } catch {
      return;
    }
    const cutoff = new Date(`${today}T12:00:00`);
    cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
    const cutoffKey = localDateKey(cutoff.getTime());
    for (const name of names) {
      const m = JOURNAL_FILE_PATTERN.exec(name);
      if (m && m[1]! < cutoffKey) {
        try {
          unlinkSync(join(journalDir(this.homeDir), name));
        } catch {
          /* best effort */
        }
      }
    }
  }
}
