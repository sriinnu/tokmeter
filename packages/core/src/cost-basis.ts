import type { CostBasis, TokenRecord } from "./types.js";

/** Summarize what the ledger actually knows; a tool's cost is not an invoice. */
export function summarizeCostBasis(records: TokenRecord[]): CostBasis {
  const result: CostBasis = {
    estimatedCost: 0,
    reportedCost: 0,
    unclassifiedCost: 0,
    estimatedRecords: 0,
    reportedRecords: 0,
    unavailableRecords: 0,
  };
  for (const record of records) {
    const cost = Number.isFinite(record.cost) ? Math.max(0, record.cost) : 0;
    if (record.costEligible === false) {
      result.unavailableRecords++;
    } else if (record.usage?.cost === "direct") {
      result.reportedCost += cost;
      result.reportedRecords++;
    } else if (record.usage?.cost === "calculated" || record.usage?.cost === "estimated") {
      result.estimatedCost += cost;
      result.estimatedRecords++;
    } else {
      result.unclassifiedCost += cost;
      result.unavailableRecords++;
    }
  }
  return result;
}

export function modelCostBasis(records: TokenRecord[]): Record<string, CostBasis> {
  const groups = new Map<string, TokenRecord[]>();
  for (const record of records) {
    const key = `${record.provider}::${record.model}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return Object.fromEntries([...groups].map(([key, group]) => [key, summarizeCostBasis(group)]));
}
