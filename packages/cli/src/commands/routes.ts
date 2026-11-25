/**
 * `tokmeter routes` — cost surface explorer (Layer 1: pure pricing translation).
 */

export async function runRoutes(options: { json: boolean; project?: string }): Promise<void> {
  const { TokmeterCore } = await import("@sriinnu/tokmeter");
  const core = new TokmeterCore();
  await core.scan({ today: true, project: options.project });
  const records = core.getRecords();
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    /** Subset of cacheWrite, not an extra bucket — see TokenBuckets. */
    cacheWrite1h: 0,
    reasoning: 0,
  };
  let actualCost = 0;
  for (const r of records) {
    totals.input += r.inputTokens;
    totals.output += r.outputTokens;
    totals.cacheRead += r.cacheReadTokens;
    totals.cacheWrite += r.cacheWriteTokens;
    totals.cacheWrite1h += r.cacheWrite1hTokens ?? 0;
    totals.reasoning += r.reasoningTokens;
    actualCost += r.cost;
  }
  if (records.length === 0) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            scope: { project: options.project, today: true },
            totals,
            actualCost: 0,
            projections: [],
          },
          null,
          2
        )
      );
    } else {
      console.log("No records in scope. Did you mean --project <name>?");
    }
    return;
  }

  const lifetime = core.getModelCosts();
  const projectionsRaw = await Promise.all(
    lifetime.map(async (m) => ({
      model: m.model,
      provider: m.provider,
      projectedCost: await (
        core as unknown as { pricing: { calculateCost(...args: unknown[]): Promise<number> } }
      ).pricing.calculateCost(
        m.model,
        totals.input,
        totals.output,
        totals.cacheRead,
        totals.cacheWrite,
        totals.reasoning,
        totals.cacheWrite1h
      ),
    }))
  );
  // Drop $0 projections — models with no kosha pricing.
  const projections = projectionsRaw
    .filter((p) => p.projectedCost > 0.0001)
    .sort((a, b) => a.projectedCost - b.projectedCost);
  const unpriced = projectionsRaw.filter((p) => p.projectedCost <= 0.0001).map((p) => p.model);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          scope: { project: options.project, today: true },
          totals,
          actualCost,
          projections,
          generatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
    return;
  }

  console.log("");
  console.log(
    `tokmeter routes — projection for today${options.project ? ` (project: ${options.project})` : ""}`
  );
  console.log("");
  console.log(
    `Tokens: ${totals.input.toLocaleString()} input · ` +
      `${totals.output.toLocaleString()} output · ` +
      `${totals.cacheRead.toLocaleString()} cacheRead · ` +
      `${totals.cacheWrite.toLocaleString()} cacheWrite · ` +
      `${totals.reasoning.toLocaleString()} reasoning`
  );
  console.log(
    `Recorded cost total (historical estimates and tool reports): $${actualCost.toFixed(2)}`
  );
  console.log("");
  console.log("Projected cost on today's kosha (sorted, cheapest first):");
  console.log("");
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    `  ${pad("MODEL", 38)} ${pad("PROVIDER", 14)} ${pad("PROJECTED", 12)} ${"Δ vs ACTUAL"}`
  );
  console.log(`  ${"─".repeat(38)} ${"─".repeat(14)} ${"─".repeat(12)} ${"─".repeat(11)}`);
  for (const p of projections) {
    const delta = p.projectedCost - actualCost;
    const deltaStr =
      Math.abs(delta) < 0.005
        ? "—"
        : delta < 0
          ? `−$${Math.abs(delta).toFixed(2)}`
          : `+$${delta.toFixed(2)}`;
    console.log(
      `  ${pad(p.model.slice(0, 38), 38)} ${pad(p.provider, 14)} $${pad(p.projectedCost.toFixed(2), 11)} ${deltaStr}`
    );
  }
  console.log("");
  console.log(
    "Note: alternatives use TODAY's kosha pricing; actual uses historical (frozen) pricing."
  );
  console.log(
    "Layer 1 (pure pricing translation) — no cache-economics adjustment for cross-provider differences."
  );
  if (unpriced.length > 0) {
    console.log("");
    console.log(
      `Unpriced models excluded (no kosha price; honest $? not free): ${unpriced.join(", ")}`
    );
  }
}
