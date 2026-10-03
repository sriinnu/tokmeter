/**
 * Custom source parser tests.
 *
 * Pins the canonical usage-line contract: a config-registered directory of
 * `.jsonl` files, one JSON object per API response, snake_case or camelCase,
 * tagged with the source's custom-eligible provider id.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CustomSource, DEFAULT_CONFIG, saveConfig } from "../config-service.js";
import { CustomSourceParser } from "./custom-source.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "custom-source-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function registerSource(source: CustomSource): void {
  saveConfig({ ...DEFAULT_CONFIG, customSources: [source], modifiedBy: "user" }, tmpDir);
}

function seedLines(relDir: string, name: string, lines: unknown[]): string {
  const dir = join(tmpDir, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n"));
  return dir;
}

describe("CustomSourceParser", () => {
  it("reads canonical lines, honours both key styles, dedups on id, and tags the provider", async () => {
    seedLines(".ribhu/sessions", "s1.jsonl", [
      { role: "user", content: "hi" }, // not a usage line — ignored
      {
        ts: 1_790_000_000_000,
        id: "resp-1",
        model: "ribhu-1",
        project: "/Users/me/Personal/ribhu",
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 300,
      },
      {
        ts: "2026-09-25T16:45:00.000Z",
        id: "resp-2",
        model: "ribhu-1",
        cwd: "/Users/me/Personal/ribhu",
        inputTokens: 50,
        outputTokens: 10,
      },
      {
        ts: 1_790_000_000_000,
        id: "resp-1", // duplicate response — must collapse
        model: "ribhu-1",
        input_tokens: 1000,
        output_tokens: 200,
      },
    ]);

    registerSource({
      path: join(tmpDir, ".ribhu", "sessions"),
      format: "tokmeter-usage-jsonl",
      provider: "ribhu",
      label: "Ribhu",
    });

    const records = await new CustomSourceParser().scan(tmpDir);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.provider === "ribhu")).toBe(true);

    const r1 = records.find((r) => r.apiCallId === "resp-1")!;
    expect(r1.inputTokens).toBe(1000);
    expect(r1.cacheReadTokens).toBe(300);
    expect(r1.project).toContain("ribhu");

    const r2 = records.find((r) => r.apiCallId === "resp-2")!;
    expect(r2.inputTokens).toBe(50);
    expect(r2.timestamp).toBe(Date.parse("2026-09-25T16:45:00.000Z"));
  });

  it("reads nested usage objects and keeps per-response (router-varied) models under one provider", async () => {
    // Ribhu routes through Chitragupta: provider stays "ribhu", model varies
    // per line, and usage is nested under `usage`.
    seedLines(".ribhu/sessions", "routed.jsonl", [
      { role: "user", content: "hi", ts: 1_790_000_000_000 }, // content line — ignored
      {
        ts: 1_790_000_001_000,
        id: "r-1",
        model: "claude-sonnet-4.6",
        cwd: "/w/app",
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 10 },
      },
      {
        ts: 1_790_000_002_000,
        id: "r-2",
        model: "gpt-5.4", // router picked a different model next turn
        cwd: "/w/app",
        usage: { inputTokens: 2000, outputTokens: 200 },
      },
    ]);

    registerSource({
      path: join(tmpDir, ".ribhu", "sessions"),
      format: "tokmeter-usage-jsonl",
      provider: "ribhu",
    });

    const records = await new CustomSourceParser().scan(tmpDir);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.provider === "ribhu")).toBe(true);
    expect(new Set(records.map((r) => r.model))).toEqual(new Set(["claude-sonnet-4.6", "gpt-5.4"]));
    const r1 = records.find((r) => r.apiCallId === "r-1")!;
    expect(r1.inputTokens).toBe(1000);
    expect(r1.cacheReadTokens).toBe(10);
    const r2 = records.find((r) => r.apiCallId === "r-2")!;
    expect(r2.inputTokens).toBe(2000);
  });

  it("falls back to the 'custom' provider for an unknown provider id and skips disabled sources", async () => {
    seedLines(".grok/logs", "g.jsonl", [
      { ts: 1_790_000_000_000, id: "g1", model: "grok-code", input_tokens: 5, output_tokens: 5 },
    ]);
    seedLines(".other/logs", "o.jsonl", [
      { ts: 1_790_000_000_000, id: "o1", model: "mystery", input_tokens: 9, output_tokens: 9 },
    ]);

    saveConfig(
      {
        ...DEFAULT_CONFIG,
        modifiedBy: "user",
        customSources: [
          {
            path: join(tmpDir, ".grok", "logs"),
            format: "tokmeter-usage-jsonl",
            provider: "not-a-real-id",
          },
          {
            path: join(tmpDir, ".other", "logs"),
            format: "tokmeter-usage-jsonl",
            provider: "custom",
            enabled: false,
          },
        ],
      },
      tmpDir
    );

    const records = await new CustomSourceParser().scan(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0].provider).toBe("custom"); // unknown id → custom
    expect(records[0].model).toBe("grok-code");
  });
});
