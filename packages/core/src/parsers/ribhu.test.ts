/**
 * Ribhu Code parser tests.
 *
 * Pins the ~/.ribhu/usage contract written by Ribhu's usage_log.rs: one file
 * per process, one line per model response, the routed model per line, and
 * the router's own name meaning "route unknown". Also pins that a
 * customSources entry pointing at the same directory does not double-count.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, saveConfig } from "../config-service.js";
import { CustomSourceParser } from "./custom-source.js";
import { RibhuParser, ribhuModel } from "./ribhu.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ribhu-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

/** A line exactly as Ribhu writes it (sorted keys, cost null unless known). */
function usageLine(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    cache_read_tokens: 768,
    cache_write_tokens: 0,
    cost: null,
    id: `ribhu-1791989590915-65735-${seq}`,
    input_tokens: 4788,
    model: "deepseek-v4-pro",
    output_tokens: 3,
    project: "/Users/me/Personal/ribhu",
    ts: 1_791_989_590_915 + seq,
    ...overrides,
  };
}

function writeUsageFile(name: string, lines: unknown[]): string {
  const dir = join(tmpDir, ".ribhu", "usage");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return file;
}

describe("RibhuParser", () => {
  it("reads one record per response with the routed model and Ribhu's buckets", async () => {
    const file = writeUsageFile("1791989590915-65735.jsonl", [
      usageLine(0),
      usageLine(1, { model: "deepseek-flash", input_tokens: 52, cache_read_tokens: 5504 }),
    ]);

    const records = await new RibhuParser().scan(tmpDir);
    expect(records).toHaveLength(2);

    const r = records[0];
    expect(r.provider).toBe("ribhu");
    expect(r.model).toBe("deepseek-v4-pro");
    expect(r.timestamp).toBe(1_791_989_590_915);
    expect(r.inputTokens).toBe(4788);
    expect(r.outputTokens).toBe(3);
    expect(r.cacheReadTokens).toBe(768);
    expect(r.cacheWriteTokens).toBe(0);
    expect(r.apiCallId).toBe("ribhu-1791989590915-65735-0");
    expect(r.sourceFile).toBe(file);
    expect(r.cwd).toBe("/Users/me/Personal/ribhu");
    expect(r.project).toBe("ribhu");
    // cost null → left for pricing to calculate.
    expect(r.cost).toBe(0);
    expect(r.usage?.cost).toBe("calculated");

    expect(records[1].model).toBe("deepseek-flash");
    expect(records[1].cacheReadTokens).toBe(5504);
  });

  it("keeps a daemon-reported cost as a direct fact, including $0", async () => {
    writeUsageFile("1-1.jsonl", [
      usageLine(0, { cost: 0.0042 }),
      usageLine(1, { model: "llama3.2:3b", cost: 0 }),
    ]);

    const records = await new RibhuParser().scan(tmpDir);
    expect(records[0].cost).toBe(0.0042);
    expect(records[0].usage?.cost).toBe("direct");
    expect(records[1].cost).toBe(0);
    expect(records[1].usage?.cost).toBe("direct");
  });

  it("attributes an unknown route to 'unknown' and still counts its tokens", async () => {
    writeUsageFile("1-2.jsonl", [
      usageLine(0, { model: "chitragupta-kernel-router", input_tokens: 900 }),
      usageLine(1, { model: "chitragupta", input_tokens: 800 }),
      usageLine(2, { model: "" }),
    ]);

    const records = await new RibhuParser().scan(tmpDir);
    expect(records.map((r) => r.model)).toEqual(["unknown", "unknown", "unknown"]);
    expect(records[0].inputTokens).toBe(900);
    expect(records[1].inputTokens).toBe(800);
    expect(ribhuModel("deepseek-v4-pro")).toBe("deepseek-v4-pro");
  });

  it("accepts the optional provider field without changing the agent tag", async () => {
    writeUsageFile("1-3.jsonl", [usageLine(0, { provider: "deepseek" })]);

    const [r] = await new RibhuParser().scan(tmpDir);
    expect(r.provider).toBe("ribhu");
    expect(r.model).toBe("deepseek-v4-pro");
  });

  it("dedups a repeated id and skips lines with no token fields", async () => {
    writeUsageFile("1-4.jsonl", [
      usageLine(0),
      usageLine(0),
      { id: "not-usage", ts: 1, model: "deepseek-v4-pro" },
      "{not json",
    ]);

    const records = await new RibhuParser().scan(tmpDir);
    expect(records).toHaveLength(1);
  });

  it("returns nothing when ~/.ribhu/usage does not exist", async () => {
    expect(await new RibhuParser().scan(tmpDir)).toEqual([]);
  });

  it("a customSources entry on ~/.ribhu/usage (or above it) does not double-count", async () => {
    writeUsageFile("1-5.jsonl", [usageLine(0), usageLine(1)]);
    // A separate custom ribhu source elsewhere must still be read.
    const otherDir = join(tmpDir, "elsewhere");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "x.jsonl"), JSON.stringify(usageLine(9, { id: "other-9" })));

    saveConfig(
      {
        ...DEFAULT_CONFIG,
        customSources: [
          { path: "~/.ribhu/usage", format: "tokmeter-usage-jsonl", provider: "ribhu" },
          { path: "~/.ribhu", format: "tokmeter-usage-jsonl", provider: "ribhu" },
          { path: otherDir, format: "tokmeter-usage-jsonl", provider: "ribhu" },
        ],
        modifiedBy: "user",
      },
      tmpDir
    );

    const native = await new RibhuParser().scan(tmpDir);
    const custom = await new CustomSourceParser().scan(tmpDir);
    expect(native).toHaveLength(2);
    expect(custom.map((r) => r.apiCallId)).toEqual(["other-9"]);
  });
});
