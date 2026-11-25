/**
 * `tokmeter pricing-audit` command handler.
 *
 * Exports the consumer-side audit of today's pricing resolution as JSON.
 */

export async function runPricingAudit(_options: { json: boolean }): Promise<void> {
  const { TokmeterCore } = await import("@sriinnu/tokmeter");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");

  const core = new TokmeterCore();
  await core.scan();
  const meta = core.getScanMeta();
  // Local-date key (YYYY-MM-DD in user's TZ).
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const todayModels = core.getModelCosts({ today: true }) ?? [];
  const todayDaily = core.getDailyBreakdown({ since: todayKey, until: todayKey })[0] ?? null;
  const resolved = todayModels.map((m) => ({
    model: m.model,
    cost: m.cost,
    tokens: m.totalTokens,
  }));

  let unpriced: Array<{ id: string; hits: number; lastSeenAt: number }> = [];
  try {
    const wishPath = path.join(os.homedir(), ".tokmeter", "wishlist.json");
    const wish = JSON.parse(fs.readFileSync(wishPath, "utf-8")) as {
      models?: Array<{ id: string; hits: number; lastSeenAt: number }>;
    };
    unpriced = wish.models ?? [];
  } catch {
    /* no wishlist — empty */
  }

  let anomalies: Array<Record<string, unknown>> = [];
  try {
    const anomPath = path.join(os.homedir(), ".kosha", "anomalies.json");
    const a = JSON.parse(fs.readFileSync(anomPath, "utf-8")) as {
      anomalies?: Array<Record<string, unknown>>;
    };
    const cutoff = Date.now() - 24 * 3600 * 1000;
    anomalies = (a.anomalies ?? []).filter(
      (x) => typeof x.ts === "number" && (x.ts as number) >= cutoff
    );
  } catch {
    /* no anomalies file */
  }

  let fetchedAt = 0;
  try {
    fetchedAt = fs.statSync(path.join(os.homedir(), ".kosha", "registry.json")).mtimeMs;
  } catch {
    /* missing registry — fetchedAt stays 0 */
  }
  const ageHours = fetchedAt > 0 ? (Date.now() - fetchedAt) / 3_600_000 : null;

  const output = {
    ts: Date.now(),
    today: {
      date: todayKey,
      totalCost: todayDaily?.cost ?? 0,
      recordCount: todayDaily?.records ?? 0,
      modelCount: resolved.length,
    },
    resolved,
    unpriced,
    anomalies,
    pricing: {
      fetchedAt,
      ageHours,
      stale: ageHours !== null && ageHours > 24,
    },
    meta: {
      lastScanAt: meta.lastScanAt,
      todayState: meta.todayState,
      warnings: meta.warnings.length,
    },
  };

  console.log(JSON.stringify(output, null, 2));

  if (unpriced.length > 0 || anomalies.length > 0 || output.pricing.stale) {
    process.exit(2);
  }
}
