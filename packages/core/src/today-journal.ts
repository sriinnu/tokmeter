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
 * Not covered: providers whose "file" is a shared database or a running total
 * (see {@link SNAPSHOT_PROVIDERS}), and files deleted while no daemon ran.
 * The carried records are persisted so a daemon restart keeps them.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { recordFingerprint } from "./aggregates.js";
import { localDateKey } from "./date-utils.js";
import type { ProviderId, TokenRecord } from "./types.js";

const JOURNAL_DIR_NAME = ".cache/tokmeter/today";
const JOURNAL_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.json$/;
/** Keep a few days of journals for forensics; they're tiny. */
const KEEP_DAYS = 7;

/**
 * Providers whose records can't be carried per file: a shared database
 * (Cursor, Antigravity, Zed) never vanishes, and running totals (Zed, Mux,
 * codex-desktop) would be counted again under a moving timestamp.
 */
const SNAPSHOT_PROVIDERS = new Set<ProviderId>([
  "codex-desktop",
  "zed",
  "mux",
  "antigravity",
  "cursor",
  "vscode-copilot",
]);

interface JournalFile {
  version: 1;
  date: string;
  /** sourceFile → the last records it produced today, before it vanished. */
  carried: Record<string, TokenRecord[]>;
}

function journalDir(homeDir: string): string {
  return join(homeDir, JOURNAL_DIR_NAME);
}

function carriable(r: TokenRecord): r is TokenRecord & { sourceFile: string } {
  return (
    typeof r.sourceFile === "string" && r.sourceFile !== "" && !SNAPSHOT_PROVIDERS.has(r.provider)
  );
}

export class TodayJournal {
  private date: string | null = null;
  /** Today's records per file from the previous full tick. */
  private lastSeen = new Map<string, TokenRecord[]>();
  /** Files that were seen today and have since vanished. */
  private carried = new Map<string, TokenRecord[]>();

  constructor(private readonly homeDir: string) {}

  /**
   * Fold one full scan of today into the journal and return today's records:
   * the live ones plus whatever vanished files still owe the day. Call only
   * with an unfiltered scan; a provider-filtered scan would make every other
   * provider's files look deleted.
   */
  reconcile(live: TokenRecord[], now: number): TokenRecord[] {
    const today = localDateKey(now);
    if (this.date !== today) this.startDay(today);

    const liveByFile = new Map<string, TokenRecord[]>();
    for (const r of live) {
      if (!carriable(r) || localDateKey(r.timestamp) !== today) continue;
      const list = liveByFile.get(r.sourceFile);
      if (list) list.push(r);
      else liveByFile.set(r.sourceFile, [r]);
    }

    let dirty = false;
    for (const [file, records] of this.lastSeen) {
      if (!liveByFile.has(file)) {
        this.carried.set(file, records);
        dirty = true;
      }
    }
    for (const file of liveByFile.keys()) {
      // It came back (a scan that failed for a tick, a restored file).
      if (this.carried.delete(file)) dirty = true;
    }
    this.lastSeen = liveByFile;
    if (dirty) this.persist();

    if (this.carried.size === 0) return live;
    const liveIds = new Set<string>();
    const liveFingerprints = new Set<string>();
    for (const r of live) {
      if (r.apiCallId) liveIds.add(`${r.provider}|${r.apiCallId}`);
      liveFingerprints.add(recordFingerprint(r));
    }
    const out = [...live];
    for (const records of this.carried.values()) {
      for (const r of records) {
        if (r.apiCallId && liveIds.has(`${r.provider}|${r.apiCallId}`)) continue;
        if (liveFingerprints.has(recordFingerprint(r))) continue;
        out.push(r);
      }
    }
    return out;
  }

  /** Records carried for vanished files (tests and diagnostics). */
  carriedFiles(): string[] {
    return [...this.carried.keys()];
  }

  private startDay(date: string): void {
    this.date = date;
    this.lastSeen = new Map();
    this.carried = new Map();
    const loaded = this.load(date);
    if (loaded) {
      for (const [file, records] of Object.entries(loaded.carried)) {
        if (Array.isArray(records) && records.length > 0) this.carried.set(file, records);
      }
    }
    this.prune(date);
  }

  private load(date: string): JournalFile | null {
    try {
      const raw = JSON.parse(readFileSync(join(journalDir(this.homeDir), `${date}.json`), "utf-8"));
      if (raw?.version !== 1 || raw.date !== date || typeof raw.carried !== "object") return null;
      return raw as JournalFile;
    } catch {
      return null;
    }
  }

  private persist(): void {
    if (!this.date) return;
    const body: JournalFile = {
      version: 1,
      date: this.date,
      carried: Object.fromEntries(this.carried),
    };
    try {
      const dir = journalDir(this.homeDir);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${this.date}.json`);
      const tmp = `${path}.${process.pid}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(body), { encoding: "utf-8" });
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch {
      /* in memory it still counts; only a restart before the seal would lose it */
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
