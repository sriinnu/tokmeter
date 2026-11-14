import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeCursorUsageCsvs,
  normalizeCursorModel,
  parseCsv,
  parseCursorCost,
  parseCursorDate,
  parseCursorUsageCsv,
  readCursorUsageCsvDir,
} from "./cursor-usage-csv.js";

const V3 =
  "Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost";
const V2 =
  "Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost";

// Rows copied from tokscale's fixtures of real Cursor exports
// (crates/tokscale-core/src/sessions/cursor.rs, tests).
const REAL_V3 = `${V3}
"2026-04-09T20:01:10.528Z","bc-a380fb49-e1a5-414e-817d-6a85b6cdc51c","cc30782e-26cc-4359-bc22-7567efe282be","Included","composer-2","Yes","0","343446","29045760","915201","30304407","Included"
"2026-04-09T18:02:13.576Z","bc-19a9b74b-2af3-46e2-9f61-3ba1cdac46c8","1a0df38f-1474-4dfe-896b-70b841d4a833","On-Demand","composer-2","Yes","0","43478","420864","7957","472299","0.11"
"2026-04-09T07:39:09.091Z","bc-49262501-0ee0-49f9-b856-a5b0466deddb","","Errored, No Charge","composer-2","Yes","0","104504","985600","3666","1093770","-"`;

const REAL_V2 = `${V2}
"2025-11-13T18:36:05.846Z","Included","auto","No","28342","775","105891","21282","156290","0.19"
"2025-11-13T13:35:04.658Z","On-Demand","gpt-5-codex","No","0","8263","66964","1612","76839","0.03"`;

const sum = (r: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;

describe("parseCsv", () => {
  it("handles quoted commas, escaped quotes, newlines in quotes, CRLF and a BOM", () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\nplain,,end\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "line1\nline2"],
      ["plain", "", "end"],
    ]);
  });
});

describe("parseCursorUsageCsv", () => {
  it("parses every Kind in a v3 export, with a comma inside the Kind field", () => {
    const { rows, skipped } = parseCursorUsageCsv(REAL_V3);
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(3);
    const [included, onDemand, errored] = rows.map((r) => r.record);

    expect(included.provider).toBe("cursor");
    expect(included.model).toBe("composer-2");
    expect(included.timestamp).toBe(Date.parse("2026-04-09T20:01:10.528Z"));
    expect(included.cost).toBe(0);
    expect(included.usage?.cost).toBe("calculated"); // "Included" is not a number

    expect(onDemand.cost).toBeCloseTo(0.11, 10);
    expect(onDemand.usage?.cost).toBe("direct");

    expect(errored.inputTokens).toBe(104504);
    expect(errored.cacheReadTokens).toBe(985600);
    expect(errored.cost).toBe(0);
    expect(errored.usage?.cost).toBe("direct"); // never repriced
    expect(errored.usage?.notes?.join(" ")).toMatch(/Errored, No Charge/);
  });

  it("maps the two Input columns as disjoint buckets and never adds Total Tokens", () => {
    const { rows } = parseCursorUsageCsv(REAL_V2);
    const auto = rows[0].record;
    expect(auto.model).toBe("cursor-auto");
    expect(auto.inputTokens).toBe(775);
    expect(auto.cacheWriteTokens).toBe(28342);
    expect(auto.cacheReadTokens).toBe(105891);
    expect(auto.outputTokens).toBe(21282);
    expect(auto.reasoningTokens).toBe(0);
    expect(sum(auto)).toBe(156290); // == Cursor's Total Tokens, no double count
    expect(auto.usage?.notes?.join(" ")).not.toMatch(/Total Tokens/);
    expect(sum(rows[1].record)).toBe(76839);
    // Every real v3 row balances too.
    for (const r of parseCursorUsageCsv(REAL_V3).rows) {
      expect(r.record.usage?.notes?.join(" ")).not.toMatch(/does not equal/);
    }
  });

  it("falls back to the superset reading only when Total proves it", () => {
    const csv = `${V2}\n2026-01-01T00:00:00Z,On-Demand,gpt-5,No,100,40,10,5,115,$0.01`;
    const r = parseCursorUsageCsv(csv).rows[0].record;
    expect(r.inputTokens).toBe(40);
    expect(r.cacheWriteTokens).toBe(60);
    expect(sum(r)).toBe(115);
    expect(r.usage?.cacheWriteTokens).toBe("calculated");
  });

  it("flags a Total that balances under neither reading, without changing buckets", () => {
    const csv = `${V2}\n2026-01-01T00:00:00Z,On-Demand,gpt-5,No,1,2,3,4,999,0.01`;
    const r = parseCursorUsageCsv(csv).rows[0].record;
    expect(sum(r)).toBe(10);
    expect(r.usage?.notes?.join(" ")).toMatch(/does not equal/);
  });

  it("parses v1 exports (no Kind, extra Cost to you column)", () => {
    const csv =
      "Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost,Cost to you\n2025-02-01,gpt-4o,10,5,0,15,30,$0.10,$0.10";
    const r = parseCursorUsageCsv(csv).rows[0].record;
    expect(r.cacheWriteTokens).toBe(10);
    expect(r.inputTokens).toBe(5);
    expect(r.cost).toBeCloseTo(0.1, 10);
    expect(r.timestamp).toBe(Date.parse("2025-02-01T12:00:00Z"));
  });

  it("refuses a body that is not Cursor's export", () => {
    expect(() => parseCursorUsageCsv("<html>login</html>")).toThrow(/Not a Cursor usage export/);
  });

  it("skips rows whose date doesn't parse and counts them", () => {
    const csv = `${V2}\nnot-a-date,On-Demand,gpt-5,No,0,1,0,1,2,0.01`;
    expect(parseCursorUsageCsv(csv)).toMatchObject({ rows: [], skipped: 1 });
  });
});

describe("cost, model and date helpers", () => {
  it("parses Cursor's cost cells", () => {
    expect(parseCursorCost("0.19")).toBeCloseTo(0.19, 10);
    expect(parseCursorCost("$9.50")).toBeCloseTo(9.5, 10);
    expect(parseCursorCost("$1,234.50")).toBeCloseTo(1234.5, 10);
    expect(parseCursorCost("$0.00")).toBe(0);
    expect(parseCursorCost("Included")).toBeNull();
    expect(parseCursorCost("-")).toBeNull();
    expect(parseCursorCost("-$0.50")).toBeNull();
    expect(parseCursorCost("")).toBeNull();
    expect(parseCursorCost("NaN")).toBeNull();
  });

  it("names the Auto router", () => {
    expect(normalizeCursorModel("Auto")).toBe("cursor-auto");
    expect(normalizeCursorModel("default")).toBe("cursor-auto");
    expect(normalizeCursorModel(" claude-4.5-sonnet ")).toBe("claude-4.5-sonnet");
    expect(normalizeCursorModel("")).toBe("unknown");
  });

  it("reads dates as UTC", () => {
    expect(parseCursorDate("2026-04-09T20:01:10.528Z")).toBe(Date.UTC(2026, 3, 9, 20, 1, 10, 528));
    expect(parseCursorDate("2026-04-09T20:01:10")).toBe(Date.UTC(2026, 3, 9, 20, 1, 10));
    expect(parseCursorDate("garbage")).toBeNull();
  });
});

describe("dedup across overlapping windows", () => {
  const rowA =
    '"2026-04-09T18:02:13.576Z","","","On-Demand","gpt-5","No","0","10","20","5","35","0.11"';
  const rowB =
    '"2026-04-10T18:02:13.576Z","","","On-Demand","gpt-5","No","0","11","21","6","38","0.12"';
  const rowC =
    '"2026-04-11T18:02:13.576Z","","","On-Demand","gpt-5","No","0","12","22","7","41","0.13"';

  it("counts a row present in two window files once, with a stable threadKey", () => {
    const merged = mergeCursorUsageCsvs([
      { path: "/c/usage-2026-04-01-2026-04-10.csv", text: `${V3}\n${rowA}\n${rowB}` },
      { path: "/c/usage-2026-04-09-2026-04-12.csv", text: `${V3}\n${rowB}\n${rowC}` },
    ]);
    expect(merged.records).toHaveLength(3);
    expect(merged.duplicates).toBe(1);
    const again = mergeCursorUsageCsvs([
      { path: "/c/usage-2026-04-09-2026-04-12.csv", text: `${V3}\n${rowB}\n${rowC}` },
    ]);
    expect(again.records.map((r) => r.threadKey)).toEqual(
      merged.records.slice(1).map((r) => r.threadKey)
    );
  });

  it("keeps two identical events inside one file", () => {
    const merged = mergeCursorUsageCsvs([
      { path: "/c/usage-a.csv", text: `${V3}\n${rowA}\n${rowA}` },
      { path: "/c/usage-b.csv", text: `${V3}\n${rowA}\n${rowA}` },
    ]);
    expect(merged.records).toHaveLength(2);
  });

  it("lets a later download settle a row's cost instead of adding a copy", () => {
    const pending =
      '"2026-04-09T18:02:13.576Z","","","On-Demand","gpt-5","No","0","10","20","5","35","-"';
    const merged = mergeCursorUsageCsvs([
      { path: "/c/usage-2026-04-01-2026-04-10.csv", text: `${V3}\n${pending}` },
      { path: "/c/usage-2026-04-09-2026-04-12.csv", text: `${V3}\n${rowA}` },
    ]);
    expect(merged.records).toHaveLength(1);
    expect(merged.records[0].cost).toBeCloseTo(0.11, 10);
  });

  it("lets the file with the newer mtime win, whatever the names say", async () => {
    const pending =
      '"2026-04-09T18:02:13.576Z","","","On-Demand","gpt-5","No","0","10","20","5","35","-"';
    // By name, usage-2026-04 sorts after usage-2026-03-…, so name order would
    // let the stale pending copy win. The settled copy was downloaded later.
    const merged = mergeCursorUsageCsvs([
      { path: "/c/usage-2026-03-28-2026-04-10.csv", text: `${V3}\n${rowA}`, mtimeMs: 2000 },
      { path: "/c/usage-2026-04.csv", text: `${V3}\n${pending}`, mtimeMs: 1000 },
    ]);
    expect(merged.records).toHaveLength(1);
    expect(merged.records[0].cost).toBeCloseTo(0.11, 10);

    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-mtime-"));
    writeFileSync(join(dir, "usage-2026-03-28-2026-04-10.csv"), `${V3}\n${rowA}`);
    writeFileSync(join(dir, "usage-2026-04.csv"), `${V3}\n${pending}`);
    utimesSync(join(dir, "usage-2026-04.csv"), 1000, 1000);
    utimesSync(join(dir, "usage-2026-03-28-2026-04-10.csv"), 2000, 2000);
    const fromDir = await readCursorUsageCsvDir(dir);
    expect(fromDir.records[0].cost).toBeCloseTo(0.11, 10);
  });

  it("reads a cache directory of window files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-"));
    writeFileSync(join(dir, "usage-2026-04-01-2026-04-10.csv"), `${V3}\n${rowA}\n${rowB}`);
    writeFileSync(join(dir, "usage-2026-04-09-2026-04-12.csv"), `${V3}\n${rowB}\n${rowC}`);
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const merged = await readCursorUsageCsvDir(dir);
    expect(merged.records).toHaveLength(3);
    expect(await readCursorUsageCsvDir(join(dir, "missing"))).toMatchObject({ records: [] });
  });
});
