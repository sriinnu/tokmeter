/**
 * @sriinnu/tokmeter-core — Cursor IDE parser.
 *
 * Reads from ~/.config/tokscale/cursor-cache/ (CSV usage files).
 * Requires prior sync via Cursor API.
 */

import { readFile } from "node:fs/promises";
import { canonicalizeProjectName } from "../project-name.js";
import type { SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, findFiles } from "./utils.js";

export class CursorParser implements SessionParser {
  readonly providerId = "cursor" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const cacheDir = expandHome("~/.config/tokscale/cursor-cache", homeDir);
    const csvFiles = await findFiles(cacheDir, (f) => f.endsWith(".csv"), 1);
    const records: TokenRecord[] = [];

    for (const file of csvFiles) {
      try {
        const raw = await readFile(file, "utf-8");
        const lines = raw.trim().split("\n");
        if (lines.length < 2) continue;

        // Skip header, parse CSV rows
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",");
          if (cols.length < 4) continue;

          records.push(
            createRecord({
              timestamp: cols[0] ? new Date(cols[0]).getTime() : Date.now(),
              provider: "cursor",
              model: cols[1] || "unknown",
              project: canonicalizeProjectName(cols[2] || "cursor", "cursor"),
              sourceFile: file,
              inputTokens: Number(cols[3]) || 0,
              outputTokens: Number(cols[4]) || 0,
              cost: Number(cols[5]) || 0,
            })
          );
        }
      } catch {
        // skip unreadable files
      }
    }
    return records;
  }
}
