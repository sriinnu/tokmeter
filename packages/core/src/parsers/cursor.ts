/**
 * @sriinnu/tokmeter-core — Cursor IDE parser.
 *
 * Two data sources, tried in order so a user is never double-counted:
 *
 * 1. ~/.config/tokscale/cursor-cache/*.csv — usage synced from Cursor's own
 *    API by an external "tokscale" tool. Real $ cost when present, but
 *    requires that separate sync to have been run at least once.
 * 2. Cursor's own local SQLite store (`cursorDiskKV` table in
 *    globalStorage/state.vscdb) — read directly, no external tool needed.
 *    Conversation messages ("bubbles") carry `tokenCount` and `modelInfo`,
 *    but only when the underlying request actually reports them back
 *    (~2.5% of bubbles in practice; most are intermediate/tool-call bubbles
 *    with zero tokens) — the model name and project also often live on a
 *    *different* bubble than the one carrying the real token count, so both
 *    are resolved per composer (conversation), not per bubble.
 *
 * Source 2 only runs when source 1 found nothing, so a user who has both
 * set up doesn't get every request counted twice.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeProjectName } from "../project-name.js";
import type { SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  findFiles,
  openReadonlySqlite,
  vscodeFamilyUserDirs,
} from "./utils.js";

interface CursorBubble {
  createdAt?: string;
  tokenCount?: { inputTokens?: number; outputTokens?: number };
  modelInfo?: { modelName?: string };
  workspaceUris?: string[];
}

function toBubbleJson(raw: string | Uint8Array): CursorBubble | null {
  try {
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
    return JSON.parse(text) as CursorBubble;
  } catch {
    return null;
  }
}

/** Extracts the composerId from a `bubbleId:<composerId>:<bubbleId>` key. */
function composerIdFromKey(key: string): string | undefined {
  return key.split(":")[1];
}

export class CursorParser implements SessionParser {
  readonly providerId = "cursor" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const fromCsv = await this.scanCsvCache(homeDir);
    if (fromCsv.length > 0) return fromCsv;
    return this.scanLocalDatabase(homeDir);
  }

  private async scanCsvCache(homeDir: string): Promise<TokenRecord[]> {
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
          const parsedCost = Number(cols[5]);
          const hasCost = cols[5] !== undefined && cols[5] !== "" && Number.isFinite(parsedCost);

          records.push(
            createRecord({
              timestamp: cols[0] ? new Date(cols[0]).getTime() : Date.now(),
              provider: "cursor",
              model: cols[1] || "unknown",
              project: canonicalizeProjectName(cols[2] || "cursor", "cursor"),
              sourceFile: file,
              inputTokens: Number(cols[3]) || 0,
              outputTokens: Number(cols[4]) || 0,
              cost: hasCost ? parsedCost : 0,
              usage: hasCost ? { cost: "direct" } : { cost: "calculated" },
            })
          );
        }
      } catch {
        // skip unreadable files
      }
    }
    return records;
  }

  private async scanLocalDatabase(homeDir: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];

    for (const userDir of vscodeFamilyUserDirs(["Cursor"], homeDir)) {
      const dbPath = join(userDir, "globalStorage", "state.vscdb");
      const db = await openReadonlySqlite(dbPath);
      if (!db) continue;

      try {
        const rows = db.all<{ key: string; value: string | Uint8Array }>(
          "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'"
        );

        // Model name and project live on whichever bubble happens to carry
        // them, not necessarily the same bubble that carries real token
        // counts — resolve both per composer (conversation) first.
        const modelByComposer = new Map<string, string>();
        const projectByComposer = new Map<string, string>();
        const parsed: { composerId: string; bubble: CursorBubble }[] = [];

        for (const row of rows) {
          const composerId = composerIdFromKey(row.key);
          const bubble = toBubbleJson(row.value);
          if (!composerId || !bubble) continue;
          parsed.push({ composerId, bubble });

          if (bubble.modelInfo?.modelName && !modelByComposer.has(composerId)) {
            modelByComposer.set(composerId, bubble.modelInfo.modelName);
          }
          if (bubble.workspaceUris?.[0] && !projectByComposer.has(composerId)) {
            projectByComposer.set(
              composerId,
              canonicalizeProjectName(decodeCursorFileUri(bubble.workspaceUris[0]), "cursor")
            );
          }
        }

        for (const { composerId, bubble } of parsed) {
          const inputTokens = bubble.tokenCount?.inputTokens ?? 0;
          const outputTokens = bubble.tokenCount?.outputTokens ?? 0;
          if (inputTokens === 0 && outputTokens === 0) continue;

          records.push(
            createRecord({
              timestamp: bubble.createdAt ? new Date(bubble.createdAt).getTime() : Date.now(),
              provider: "cursor",
              model: modelByComposer.get(composerId) || "unknown",
              project: projectByComposer.get(composerId) || "cursor",
              sourceFile: dbPath,
              inputTokens,
              outputTokens,
              usage: { source: "tool_sqlite" },
            })
          );
        }
      } catch {
        // Cursor's schema moved — fail soft rather than crash the scan
      } finally {
        db.close();
      }
    }
    return records;
  }
}

function decodeCursorFileUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return decodeURIComponent(uri.slice("file://".length));
  } catch {
    return uri.slice("file://".length);
  }
}
