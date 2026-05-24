/**
 * @sriinnu/tokmeter-core — Kosha unpriced-model wishlist writer.
 *
 * Feedback channel to kosha-discovery: drop a JSON list of every model
 * tokmeter saw real usage on but couldn't price. Kosha reads this on
 * `kosha update` to bias provider priority toward what's actually being
 * used. Without it, kosha has no way to know which models matter.
 *
 * Best-effort + synchronous: writing must never block or fail a scan.
 * File is atomic-renamed so kosha can read mid-write safely.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    mkdirSync(dir, { recursive: true });

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
    const tmp = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, filePath);
  } catch {
    // Wishlist is observability only — never block a scan.
  }
}
