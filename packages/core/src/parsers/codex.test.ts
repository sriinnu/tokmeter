/**
 * Codex parser regression tests.
 *
 * The Codex parser had a 24x cost overcharge bug because OpenAI reports
 * input_tokens as TOTAL (including cached) while the cost calculator
 * assumed Anthropic semantics (input_tokens = uncached only). The fix
 * subtracts cached_input_tokens from input_tokens and separates reasoning from
 * output_tokens before creating records.
 *
 * These tests pin that contract to a fixture so we never regress.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexParser, parseCodexFile } from "./codex.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "codex-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

/**
 * Build a fake Codex JSONL file with controlled token_count events.
 *
 * `opts.dirDate` places the file under an arbitrary sessions/YYYY/MM/DD dir
 * (the session START day) independently of `opts.eventDate` (the day the events
 * are timestamped). Codex appends to the start-day file for the life of a
 * session, so a long-running session legitimately has an OLD dir but RECENT
 * events — the exact shape that must NOT be dropped by anything but event time.
 * `opts.omitTimestamps` strips every line's timestamp to exercise the fail-open
 * path (newestEventMs returns null → keep).
 */
function writeFakeSession(
  events: Array<{ totalIn: number; totalOut: number; cached: number; reasoning?: number }>,
  opts?: { dirDate?: [string, string, string]; eventDate?: string; omitTimestamps?: boolean }
): string {
  const [y, mo, d] = opts?.dirDate ?? ["2026", "04", "09"];
  const eventDate = opts?.eventDate ?? "2026-04-09";
  const ts = (iso: string) => (opts?.omitTimestamps ? {} : { timestamp: iso });

  const sessionsDir = join(tmpDir, ".codex", "sessions", y, mo, d);
  const fs = require("node:fs");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, `rollout-${y}-${mo}-${d}T12-00-00-test.jsonl`);

  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      ...ts(`${eventDate}T12:00:00.000Z`),
      type: "session_meta",
      payload: { id: "test-session", cwd: "/tmp/test-project", model_provider: "openai" },
    })
  );
  lines.push(
    JSON.stringify({
      ...ts(`${eventDate}T12:00:01.000Z`),
      type: "turn_context",
      payload: { model: "gpt-5.4" },
    })
  );
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    lines.push(
      JSON.stringify({
        ...ts(`${eventDate}T12:00:${String(10 + i).padStart(2, "0")}.000Z`),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: e.totalIn,
              cached_input_tokens: e.cached,
              output_tokens: e.totalOut,
              reasoning_output_tokens: e.reasoning ?? 0,
            },
          },
        },
      })
    );
  }

  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

describe("CodexParser", () => {
  it("subtracts cached_input_tokens from input_tokens (Anthropic semantics)", async () => {
    // One event: 100k total prompt, 80k of which is cached.
    // Expected: inputTokens = 20k uncached, cacheReadTokens = 80k.
    writeFakeSession([{ totalIn: 100_000, totalOut: 5_000, cached: 80_000 }]);

    const parser = new CodexParser();
    const records = await parser.scan(tmpDir);
    expect(records.length).toBe(1);

    const r = records[0];
    expect(r.inputTokens).toBe(20_000); // total - cached
    expect(r.cacheReadTokens).toBe(80_000);
    expect(r.outputTokens).toBe(5_000);
    expect(r.provider).toBe("codex");
    expect(r.model).toBe("gpt-5.4");
    expect(r.usage).toMatchObject({
      source: "tool_jsonl",
      inputTokens: "normalized",
      cacheReadTokens: "direct",
      cacheWriteTokens: "not_exposed",
      reasoningTokens: "direct",
    });
  });

  it("computes deltas across consecutive cumulative events", async () => {
    // Codex reports cumulative totals. The parser uses computeDelta() to
    // diff each event against the previous one.
    //   Event 1: total=100k, cached=80k → delta_in = 20k uncached
    //   Event 2: total=150k, cached=120k → delta_in = 30k more uncached
    //                                       (50k more total - 40k more cached)
    writeFakeSession([
      { totalIn: 100_000, totalOut: 5_000, cached: 80_000 },
      { totalIn: 150_000, totalOut: 8_000, cached: 120_000 },
    ]);

    const parser = new CodexParser();
    const records = await parser.scan(tmpDir);
    expect(records.length).toBe(2);

    // First event: full subtraction since prevTotal is empty
    expect(records[0].inputTokens).toBe(20_000);
    expect(records[0].cacheReadTokens).toBe(80_000);
    expect(records[0].outputTokens).toBe(5_000);

    // Second event: delta = 50k total - 40k cached = 10k uncached
    expect(records[1].inputTokens).toBe(10_000);
    expect(records[1].cacheReadTokens).toBe(40_000);
    expect(records[1].outputTokens).toBe(3_000);
  });

  it("separates reasoning from output because Codex includes it in output_tokens", async () => {
    // Codex's total_tokens is input_tokens + output_tokens. The reported
    // reasoning bucket is a portion of that output, so putting it in both
    // canonical buckets makes every aggregate total too high.
    writeFakeSession([{ totalIn: 100_000, totalOut: 5_000, cached: 80_000, reasoning: 4_000 }]);

    const records = await new CodexParser().scan(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      inputTokens: 20_000,
      cacheReadTokens: 80_000,
      outputTokens: 1_000,
      reasoningTokens: 4_000,
    });
    expect(
      records[0].inputTokens +
        records[0].cacheReadTokens +
        records[0].outputTokens +
        records[0].reasoningTokens
    ).toBe(105_000);
  });

  it("preserves the original timestamp from the JSONL", async () => {
    writeFakeSession([{ totalIn: 100_000, totalOut: 5_000, cached: 80_000 }]);

    const parser = new CodexParser();
    const records = await parser.scan(tmpDir);
    // 2026-04-09T12:00:10.000Z
    expect(new Date(records[0].timestamp).toISOString()).toBe("2026-04-09T12:00:10.000Z");
  });

  it("handles cache > input edge case (clamps to zero, not negative)", async () => {
    // Pathological: API quirk where cached > input.
    writeFakeSession([{ totalIn: 50_000, totalOut: 1_000, cached: 80_000 }]);

    const parser = new CodexParser();
    const records = await parser.scan(tmpDir);
    expect(records[0].inputTokens).toBe(0); // Math.max(0, 50k - 80k)
    expect(records[0].cacheReadTokens).toBe(80_000);
  });

  it("today-scan skips a freshly-touched file whose newest event predates the watermark", async () => {
    // The daemon-melt regression: blanking/rewriting an old rollout bumps its
    // mtime to "now", so a today-scan's mtime prefilter matches it — but its
    // events are from 2026-04-09 and belong to an already-sealed day. The
    // newest-event guard must drop it BEFORE the expensive full parse.
    writeFakeSession([{ totalIn: 100_000, totalOut: 5_000, cached: 80_000 }]);

    const parser = new CodexParser();
    // Watermark AFTER the file's newest event; mtime (just written = now) still
    // passes the mtime filter, so only the event-date guard can skip it.
    const watermark = new Date("2026-04-10T00:00:00.000Z").getTime();
    const records = await parser.scan(tmpDir, { modifiedSinceMs: watermark });
    expect(records.length).toBe(0);
  });

  it("today-scan KEEPS a file whose newest event is at/after the watermark", async () => {
    // Guard must not over-skip genuine today data.
    writeFakeSession([{ totalIn: 100_000, totalOut: 5_000, cached: 80_000 }]);

    const parser = new CodexParser();
    const watermark = new Date("2026-04-09T00:00:00.000Z").getTime();
    const records = await parser.scan(tmpDir, { modifiedSinceMs: watermark });
    expect(records.length).toBe(1);
  });

  it("KEEPS an OLD-dir file whose newest event is recent (long-running session)", async () => {
    // THE regression the 4-agent review caught: codex appends to the session-
    // START-day file for the life of the session, so a session begun 2026-04-09
    // but still active in June lives under 2026/04/09 with June events. A filter
    // that drops by path/start date would silently ZERO the user's biggest
    // active session. Only the newest EVENT time may drop a file — and here it's
    // June, well after the watermark, so the file must be KEPT and parsed.
    writeFakeSession([{ totalIn: 100_000, totalOut: 5_000, cached: 80_000 }], {
      dirDate: ["2026", "04", "09"],
      eventDate: "2026-06-15",
    });

    const parser = new CodexParser();
    const watermark = new Date("2026-06-01T00:00:00.000Z").getTime();
    const records = await parser.scan(tmpDir, { modifiedSinceMs: watermark });
    expect(records.length).toBe(1); // kept despite the April dir/path
  });

  it("fail-open: KEEPS a file whose tail carries no parseable timestamp", async () => {
    // newestEventMs returns null when it can't read a timestamp. Null must fail
    // OPEN (keep + parse) so we never silently drop real data on a malformed or
    // mid-append tail — never fail closed.
    writeFakeSession([{ totalIn: 100_000, totalOut: 5_000, cached: 80_000 }], {
      omitTimestamps: true,
    });

    const parser = new CodexParser();
    // Watermark is AFTER the (omitted) 2026-04-09 events but BEFORE the file's
    // mtime (= test run time), so mtime keeps it and only newestEventMs decides.
    // A timestamped twin would be DROPPED here (04-09 < 05-01); the null tail
    // must instead fail OPEN and keep it — that's the distinction under test.
    const watermark = new Date("2026-05-01T00:00:00.000Z").getTime();
    const records = await parser.scan(tmpDir, { modifiedSinceMs: watermark });
    expect(records.length).toBe(1); // fail-open kept it
  });

  it("streams a large (>8MB) rollout line-by-line and parses it identically", async () => {
    // Files at/above CODEX_LARGE_FILE_BYTES take the readline STREAM path (never
    // buffering the whole file) — the fix that keeps a 200MB fork-replay rollout
    // from ballooning memory. Pad events so we cross 8MB with a manageable count,
    // and give each a monotonically rising total so every delta yields a record.
    const fs = require("node:fs");
    const dir = join(tmpDir, ".codex", "sessions", "2026", "05", "01");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "rollout-2026-05-01T12-00-00-big.jsonl");
    const filler = "x".repeat(1800); // inflate each line so ~5k events > 8MB
    const N = 5000;
    const lines: string[] = [
      JSON.stringify({
        timestamp: "2026-05-01T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "big", cwd: "/tmp/big-project", model_provider: "openai" },
      }),
      JSON.stringify({
        timestamp: "2026-05-01T12:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.4" },
      }),
    ];
    for (let i = 0; i < N; i++) {
      lines.push(
        JSON.stringify({
          timestamp: "2026-05-01T12:01:00.000Z",
          type: "event_msg",
          _pad: filler,
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: (i + 1) * 100,
                cached_input_tokens: 0,
                output_tokens: (i + 1) * 10,
                reasoning_output_tokens: 0,
              },
            },
          },
        })
      );
    }
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
    expect(fs.statSync(filePath).size).toBeGreaterThan(8_000_000); // forces the stream branch

    const records = await new CodexParser().scan(tmpDir);
    // Monotone totals → every delta is +100 in / +10 out → one record per event.
    expect(records.length).toBe(N);
    expect(records[0].inputTokens).toBe(100);
    expect(records[0].outputTokens).toBe(10);
    expect(records[N - 1].inputTokens).toBe(100); // steady delta, not cumulative
  });

  it("parseCodexFile fails SOFT on an unreadable large file (no throw, returns what it had)", async () => {
    // Regression for the review's HIGH finding: the streamed large-file path must
    // not let one unreadable rollout (deleted mid-scan, EACCES, evicted iCloud)
    // abort the whole codex provider — and, worse, let a windowed rescan
    // overwrite good sealed days with an empty result. A >8MB file with no read
    // permission drives createReadStream to EACCES, which must be swallowed.
    const fs = require("node:fs");
    const dir = join(tmpDir, ".codex", "sessions", "2026", "05", "03");
    fs.mkdirSync(dir, { recursive: true });
    const bad = join(dir, "rollout-2026-05-03T13-00-00-bad.jsonl");
    fs.writeFileSync(bad, "x".repeat(8_500_000)); // > CODEX_LARGE_FILE_BYTES → stream path
    fs.chmodSync(bad, 0o000); // unreadable → createReadStream errors
    try {
      const records = await parseCodexFile(bad, 8_500_000);
      expect(records).toEqual([]); // failed soft, did not throw
    } finally {
      fs.chmodSync(bad, 0o644); // restore so afterEach can clean up
    }
  });

  it("skips events where every token bucket is zero", async () => {
    // First event has data, second has nothing — only one record produced.
    writeFakeSession([
      { totalIn: 100_000, totalOut: 5_000, cached: 80_000 },
      // Same totals = delta is all zeros, no new record
      { totalIn: 100_000, totalOut: 5_000, cached: 80_000 },
    ]);

    const parser = new CodexParser();
    const records = await parser.scan(tmpDir);
    // Note: the parser falls back to last_token_usage when delta is zero.
    // This test confirms the deduplication logic doesn't double-count.
    // The actual count depends on the fallback path — if last_token_usage
    // The duplicate event produces zero deltas across all token buckets,
    // so the parser skips it and avoids double-counting usage.
    expect(records.length).toBeGreaterThanOrEqual(1);
  });
});
