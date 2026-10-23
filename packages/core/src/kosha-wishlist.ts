import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory, writePrivateFile } from "./private-files.js";
import type { TokenRecord } from "./types.js";

export interface UnpricedTracker {
  models: Set<string>;
  records: number;
}

export function writeKoshaWishlist(
  homeDir: string,
  unpricedTracker: UnpricedTracker,
  records: TokenRecord[]
): void {
  try {
    const dir = join(homeDir, ".tokmeter");
    const filePath = join(dir, "wishlist.json");

    // Empty tracker but a stale wishlist exists — clean it up so consumers
    // (bar, CI, kosha) don't keep flagging models that are no longer
    // unpriced. Without this, the file freezes at its last non-empty state
    // forever, which is exactly what bit codex-auto-review after the
    // opaque-models filter landed.
    if (unpricedTracker.models.size === 0) {
      try {
        unlinkSync(filePath);
      } catch {
        /* missing is fine */
      }
      return;
    }
    ensurePrivateDirectory(dir);

    // Count hits per unpriced model from today's records.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const sinceMs = todayStart.getTime();
    const hits = new Map<string, { hits: number; lastSeenAt: number }>();
    for (const r of records) {
      if (r.timestamp < sinceMs) continue;
      if (!unpricedTracker.models.has(r.model)) continue;
      const cur = hits.get(r.model);
      if (cur) {
        cur.hits += 1;
        if (r.timestamp > cur.lastSeenAt) cur.lastSeenAt = r.timestamp;
      } else {
        hits.set(r.model, { hits: 1, lastSeenAt: r.timestamp });
      }
    }

    const payload = {
      schemaVersion: 1,
      writtenAt: Date.now(),
      models: [...hits.entries()]
        .map(([id, v]) => ({ id, hits: v.hits, lastSeenAt: v.lastSeenAt }))
        .sort((a, b) => b.hits - a.hits),
    };
    writePrivateFile(filePath, JSON.stringify(payload, null, 2));
  } catch {
    // Wishlist is observability only — never block a scan.
  }
}
