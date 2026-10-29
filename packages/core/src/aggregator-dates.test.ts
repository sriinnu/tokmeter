// filterByDate works in LOCAL calendar days, like the daily aggregates and
// createSummaryQuery. Pinned to a non-UTC zone: under UTC the old UTC-midnight
// parsing of a date-only bound looked correct.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { filterByDate } from "./aggregator.js";
import type { TokenRecord } from "./types.js";

const realTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Berlin";
});
afterAll(() => {
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;
});

const rec = (iso: string): TokenRecord =>
  ({
    timestamp: new Date(iso).getTime(),
    provider: "codex",
    model: "m",
    project: "p",
  }) as TokenRecord;
const keys = (records: TokenRecord[]) => records.map((r) => new Date(r.timestamp).toISOString());

describe("filterByDate — local calendar days", () => {
  test("a date-only since/until covers exactly that local day", () => {
    const records = [
      rec("2026-10-27T23:30:00+01:00"),
      rec("2026-10-28T00:30:00+01:00"), // dropped by the old UTC parsing
      rec("2026-10-28T23:59:00+01:00"),
      rec("2026-10-29T00:30:00+01:00"), // included by the old UTC parsing
    ];
    expect(keys(filterByDate(records, { since: "2026-10-28", until: "2026-10-28" }))).toEqual(
      keys([records[1]!, records[2]!])
    );
  });

  test("a bound with a time component is taken as given", () => {
    const records = [rec("2026-10-28T10:00:00Z"), rec("2026-10-28T12:00:00Z")];
    expect(filterByDate(records, { since: "2026-10-28T11:00:00Z" })).toHaveLength(1);
    expect(filterByDate(records, { until: "2026-10-28T10:00:00Z" })).toHaveLength(1);
  });

  test("week is the last 7 calendar days, as in createSummaryQuery", () => {
    const now = new Date("2026-10-29T10:00:00+01:00").getTime();
    const records = [
      rec("2026-10-22T23:00:00+02:00"), // 8th day back: the rolling 168 h window took it
      rec("2026-10-23T00:10:00+02:00"),
      rec("2026-10-29T09:00:00+01:00"),
    ];
    expect(keys(filterByDate(records, { week: true }, now))).toEqual(keys(records.slice(1)));
  });

  test("year runs local Jan 1 to local Jan 1", () => {
    const records = [rec("2025-12-31T23:30:00+01:00"), rec("2026-01-01T00:30:00+01:00")];
    expect(keys(filterByDate(records, { year: 2026 }))).toEqual(keys([records[1]!]));
  });
});
