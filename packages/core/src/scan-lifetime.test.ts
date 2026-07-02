// Guards the cleanup fix: cleanup must see the ENTIRE corpus, not the 14-day
// rolling window core.scan()/getRecords() return. A record older than 14 days
// must be visible to scanLifetimeRaw (so cleanup can match it and detect
// partial-file collateral) while scan() correctly omits it from the hot window.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { localDateKey } from "./date-utils.js";
import { TokmeterCore } from "./tokmeter-core.js";
import type { TokenRecord } from "./types.js";

function assistantLine(iso: string, cost: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: iso,
    costUSD: cost,
    message: {
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 100, output_tokens: 20 },
      content: [],
    },
  });
}

describe("scanLifetimeRaw — cleanup sees beyond the 14-day window", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-life-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("returns records older than 14 days that scan() omits, with sourceFile", async () => {
    const projDir = join(home, ".claude", "projects", "-Users-x-proj");
    mkdirSync(projDir, { recursive: true });
    const now = Date.now();
    const oldIso = new Date(now - 30 * 86_400_000).toISOString(); // 30 days ago
    const todayIso = new Date(now).toISOString();
    writeFileSync(
      join(projDir, "s.jsonl"),
      `${assistantLine(oldIso, 1.11)}\n${assistantLine(todayIso, 2.22)}\n`
    );

    const core = new TokmeterCore({ homeDir: home, skipPricing: true });
    const oldKey = localDateKey(Date.parse(oldIso));
    const hasOld = (rs: TokenRecord[]) => rs.some((r) => localDateKey(r.timestamp) === oldKey);

    const recent = await core.scan();
    const lifetime = await core.scanLifetimeRaw();

    expect(hasOld(recent)).toBe(false); // 14-day window excludes the 30-day record
    expect(hasOld(lifetime)).toBe(true); // lifetime scan includes it — the fix
    // Cleanup needs per-record file identity to resolve delete targets.
    expect(lifetime.every((r) => typeof r.sourceFile === "string" && r.sourceFile.length > 0)).toBe(
      true
    );
  });
});
