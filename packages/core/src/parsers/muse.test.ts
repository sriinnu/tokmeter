/**
 * Muse parser tests.
 *
 * Fixtures pin Muse's real event-log shape (reverse-engineered from
 * ~/.local/share/muse/sessions/.../session.jsonl): flat records with a stable
 * `id`, microsecond `recorded_at`, and a `payload.event.kind` of
 * "model_completed" carrying `usage`. The same usage is echoed on a
 * `goal_usage_attribution` record — these tests pin that we count the former
 * and ignore the latter, and that `input_tokens` (OpenAI-style, cache-inclusive)
 * has its cached portion stripped.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MuseParser } from "./muse.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "muse-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function seedSession(lines: unknown[]): void {
  const dir = join(
    tmpDir,
    ".local",
    "share",
    "muse",
    "sessions",
    "2026",
    "10",
    "02",
    "01a0fc98-7285-7e71-be1c-0303e1066a1b"
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
}

function modelCompleted(id: string, usage: Record<string, number>, model = "muse-spark-1.3") {
  return {
    id,
    recorded_at: 1_791_019_404_212_974, // microseconds
    payload_type: "runtime.session.model_run",
    payload: { kind: "model_run", event: { kind: "model_completed", usage, model } },
  };
}

describe("MuseParser", () => {
  it("maps usage, strips cached from input, and sets project from workspace_root", async () => {
    seedSession([
      {
        payload_type: "runtime.session.metadata",
        payload: {
          kind: "metadata",
          record: { workspace_root: "/Users/me/Personal/ports", provider_id: "meta" },
        },
      },
      modelCompleted("rec-1", {
        input_tokens: 37546,
        output_tokens: 163,
        cached_tokens: 8433,
        cache_read_tokens: 8433,
        cache_write_tokens: 0,
        reasoning_tokens: 34,
      }),
    ]);

    const records = await new MuseParser().scan(tmpDir);
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.provider).toBe("muse");
    expect(r.model).toBe("muse-spark-1.3");
    // input_tokens (37546) includes cache_read (8433) → uncached 29113
    expect(r.inputTokens).toBe(29113);
    expect(r.cacheReadTokens).toBe(8433);
    expect(r.outputTokens).toBe(163);
    expect(r.reasoningTokens).toBe(34);
    expect(r.project).toContain("ports");
    expect(r.timestamp).toBe(1_791_019_404_213); // µs → ms (rounded)
  });

  it("dedups on record id and ignores the goal_usage_attribution echo", async () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_tokens: 200,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    };
    seedSession([
      {
        payload_type: "runtime.session.metadata",
        payload: { record: { workspace_root: "/w/app" } },
      },
      modelCompleted("dup-id", usage),
      modelCompleted("dup-id", usage), // same response, written twice — must collapse
      // the attribution echo of the same spend — must NOT be counted
      {
        id: "attr-1",
        payload_type: "runtime.session.goal_usage_attribution",
        payload: {
          kind: "goal_usage_attribution",
          event: { kind: "goal_usage_attribution" },
          quantity: { unit: "tokens", input_tokens: 1000, output_tokens: 50, cached_tokens: 200 },
        },
      },
    ]);

    const records = await new MuseParser().scan(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(800);
  });
});
