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

import type { SessionParser, TokenRecord } from "../types.js";
import {
  type OpenCodeMessageData,
  openCodeMessageToRecord,
  readOpenCodeDb,
} from "./opencode-db.js";
import { expandHome, fileExists, findFiles, openReadonlySqlite, readJsonFile } from "./utils.js";

export class OpenCodeParser implements SessionParser {
  readonly providerId = "opencode" as const;

  /** Paths this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [
      expandHome("~/.local/share/opencode/opencode.db", homeDir),
      expandHome("~/.local/share/opencode/storage/message", homeDir),
    ];
  }

  async scan(homeDir: string): Promise<TokenRecord[]> {
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
    if (await fileExists(dbPath)) {
      const db = await openReadonlySqlite(dbPath);
      try {
        for (const rec of readOpenCodeDb(db, dbPath, "opencode")) add(rec);
      } finally {
        db.close();
      }
    }

    const jsonFiles = await findFiles(storageDir, (f) => f.endsWith(".json"), 3);
    for (const file of jsonFiles) {
      const msg = await readJsonFile<OpenCodeMessageData>(file);
      const rec = openCodeMessageToRecord(msg, "opencode", file, { legacyJson: true });
      if (rec) add(rec);
    }

    return records;
  }
}
