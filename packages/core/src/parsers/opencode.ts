/**
 * @sriinnu/tokmeter-core — OpenCode session parser.
 *
 * Reads BOTH stores and merges them, deduped on message id:
 *   - ~/.local/share/opencode/opencode.db (SQLite, current)
 *   - ~/.local/share/opencode/storage/message/ (legacy JSON, one file per message)
 *
 * The two are disjoint on real installs — OpenCode did not migrate old JSON
 * messages into the DB — so reading only one of them loses the other's history.
 * Schema handling lives in opencode-db.ts (shared with Kilo CLI).
 */

import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import {
  type OpenCodeMessageData,
  openCodeMessageToRecord,
  readOpenCodeDb,
} from "./opencode-db.js";
import {
  expandHome,
  fileExists,
  fileMtimeWithWal,
  filterFilesByMtime,
  findFiles,
  openReadonlySqlite,
  readJsonFile,
} from "./utils.js";

export class OpenCodeParser implements SessionParser {
  readonly providerId = "opencode" as const;

  /** Paths this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [
      expandHome("~/.local/share/opencode/opencode.db", homeDir),
      expandHome("~/.local/share/opencode/storage/message", homeDir),
    ];
  }

  /** The database's records name it as their sourceFile (coverage check). */
  usageDatabases(homeDir: string): string[] {
    return [this.sessionRoots(homeDir)[0]];
  }

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const [dbPath, storageDir] = this.sessionRoots(homeDir);
    const records: TokenRecord[] = [];
    const seen = new Set<string>();
    const add = (rec: TokenRecord) => {
      if (rec.apiCallId) {
        if (seen.has(rec.apiCallId)) return;
        seen.add(rec.apiCallId);
      }
      records.push(rec);
    };

    // bun:sqlite under Bun; node:sqlite, then better-sqlite3, under Node.
    if (
      (await fileExists(dbPath)) &&
      (opts?.modifiedSinceMs === undefined ||
        (await fileMtimeWithWal(dbPath)) >= opts.modifiedSinceMs)
    ) {
      try {
        const db = await openReadonlySqlite(dbPath);
        try {
          for (const rec of readOpenCodeDb(db, dbPath, "opencode")) add(rec);
        } finally {
          db.close();
        }
      } catch (error) {
        opts?.onWarning?.(
          `opencode: failed read of ${dbPath}: ${error instanceof Error ? error.message : error}`,
          { file: dbPath }
        );
      }
    }

    let jsonFiles = await findFiles(storageDir, (f) => f.endsWith(".json"), 3);
    if (opts?.modifiedSinceMs !== undefined) {
      jsonFiles = await filterFilesByMtime(jsonFiles, opts.modifiedSinceMs);
    }
    for (const file of jsonFiles) {
      try {
        const msg = await readJsonFile<OpenCodeMessageData>(file);
        const rec = openCodeMessageToRecord(msg, "opencode", file, { legacyJson: true });
        if (rec) add(rec);
      } catch (error) {
        opts?.onWarning?.(
          `opencode: failed read of ${file}: ${error instanceof Error ? error.message : error}`,
          { file }
        );
      }
    }

    return records;
  }
}
