/**
 * Claude Code parser regression tests.
 *
 * Claude Code writes an assistant turn as one JSONL line per content block
 * (thinking, text, each tool_use). Every line carries the same message.id and
 * requestId but its own timestamp, because tool_use lines are written as each
 * tool dispatches. A turn with N parallel tool calls is therefore N lines for
 * ONE charge. Keying dedup on timestamp counted such a turn N times.
 *
 * Main transcripts repeat the identical usage on every line; subagent
 * transcripts write the first line from message_start with placeholder usage
 * and only the last line carries the real output count, so the record must
 * keep the max per bucket, not the first line.
 *
 * Isolation: each test gets its own tmp home, so the process-global record
 * cache (keyed by absolute path) never collides between tests. We do NOT call
 * clearRecordCache() — it unlinks the user's real ~/.cache/tokmeter cache.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeParser } from "./claude-code.js";

let home: string;
let dir: string;
let file: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claude-code-parser-test-"));
  dir = join(home, ".claude", "projects", "-tmp-app");
  mkdirSync(dir, { recursive: true });
  file = join(dir, "sess-1.jsonl");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const usage = (out: number) => ({
  input_tokens: 10,
  output_tokens: out,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 100,
});

/** One line of an assistant turn: `blocks` is the content of THIS line only. */
function assistantLine(
  id: string,
  ts: string,
  blocks: Array<{ type: string; name?: string }>,
  u: Record<string, unknown> = usage(500)
): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `${id}-${ts}`,
    requestId: `req_${id}`,
    timestamp: ts,
    message: { id: `msg_${id}`, model: "claude-x", usage: u, content: blocks },
  });
}

const toolResultLine = (ts: string) =>
  JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result" }] } });

// Turn A: thinking + three parallel tool calls, written over 4 seconds with
// tool_result lines interleaved — exactly what a real transcript looks like.
const turnA = [
  assistantLine("A", "2026-09-18T10:00:00.000Z", [{ type: "thinking" }]),
  assistantLine("A", "2026-09-18T10:00:01.000Z", [{ type: "tool_use", name: "Read" }]),
  toolResultLine("2026-09-18T10:00:01.500Z"),
  assistantLine("A", "2026-09-18T10:00:02.000Z", [{ type: "tool_use", name: "Bash" }]),
  toolResultLine("2026-09-18T10:00:02.500Z"),
  assistantLine("A", "2026-09-18T10:00:03.000Z", [{ type: "tool_use", name: "Edit" }]),
  toolResultLine("2026-09-18T10:00:03.500Z"),
];
// Turns B and C: distinct responses that happen to have identical usage —
// must both be kept.
const turnB = [assistantLine("B", "2026-09-18T10:01:00.000Z", [{ type: "text" }], usage(42))];
const turnC = [assistantLine("C", "2026-09-18T10:02:00.000Z", [{ type: "text" }], usage(42))];

describe("ClaudeCodeParser — one record per API response", () => {
  it("folds the per-content-block lines of a turn into a single record", async () => {
    writeFileSync(file, `${[...turnA, ...turnB, ...turnC].join("\n")}\n`);
    const records = await new ClaudeCodeParser().scan(home);

    expect(records).toHaveLength(3);
    const a = records.find((r) => r.apiCallId === "msg_A");
    expect(a?.outputTokens).toBe(500);
    expect(a?.cacheReadTokens).toBe(1000);
    // Tool calls from every block line of the turn, in order.
    expect(a?.toolCalls).toEqual(["Read", "Bash", "Edit"]);
  });

  it("keeps distinct responses whose usage numbers coincide", async () => {
    writeFileSync(file, `${[...turnB, ...turnC].join("\n")}\n`);
    const records = await new ClaudeCodeParser().scan(home);
    expect(records.map((r) => r.apiCallId)).toEqual(["msg_B", "msg_C"]);
    expect(records.reduce((s, r) => s + r.outputTokens, 0)).toBe(84);
  });

  it("keeps the max usage across a turn's lines (subagent placeholder first line)", async () => {
    // Real subagent shape: message_start line has cache buckets but no
    // output_tokens; the final line carries the true output count.
    const placeholder = {
      input_tokens: 2,
      cache_creation_input_tokens: 39_657,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 39_657 },
    };
    const final = { ...placeholder, output_tokens: 2_491 };
    writeFileSync(
      file,
      `${[
        assistantLine("S", "2026-09-18T11:00:00.000Z", [{ type: "thinking" }], placeholder),
        assistantLine("S", "2026-09-18T11:00:05.000Z", [{ type: "text" }], final),
      ].join("\n")}\n`
    );
    const [s] = await new ClaudeCodeParser().scan(home);
    expect(s.outputTokens).toBe(2_491);
    expect(s.cacheWriteTokens).toBe(39_657);
    expect(s.cacheWrite1hTokens).toBe(39_657);
  });

  it("does not double count a turn whose lines straddle two append scans", async () => {
    // First scan sees the thinking line + first tool call...
    writeFileSync(file, `${turnA.slice(0, 3).join("\n")}\n`);
    const parser = new ClaudeCodeParser();
    expect(await parser.scan(home)).toHaveLength(1);

    // ...the rest of the same turn lands before the next scan.
    appendFileSync(file, `${[...turnA.slice(3), ...turnB].join("\n")}\n`);
    const records = await parser.scan(home);
    expect(records).toHaveLength(2);
    const a = records.find((r) => r.apiCallId === "msg_A");
    expect(a?.outputTokens).toBe(500);
    expect(a?.toolCalls).toEqual(["Read", "Bash", "Edit"]);
  });

  it("retries a JSON object first observed during a torn append", async () => {
    const complete = assistantLine(
      "TORN",
      "2026-09-18T10:03:00.000Z",
      [{ type: "text" }],
      usage(77)
    );
    const split = Math.floor(complete.length / 2);
    writeFileSync(file, complete.slice(0, split));

    const parser = new ClaudeCodeParser();
    const warnings: string[] = [];
    expect(await parser.scan(home, { onWarning: (warning) => warnings.push(warning) })).toEqual([]);
    // A line caught mid-write is left unconsumed and read once it completes;
    // it is reported (it may be a pre-midnight record a seal must wait for).
    expect(warnings.some((warning) => /still being written/.test(warning))).toBe(true);

    appendFileSync(file, `${complete.slice(split)}\n`);
    const records = await parser.scan(home);
    expect(records.map((record) => record.apiCallId)).toEqual(["msg_TORN"]);
    expect(records[0]?.outputTokens).toBe(77);
  });

  it("re-prices a cached record whose usage grows in a later scan", async () => {
    const placeholder = {
      input_tokens: 2,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 0,
    };
    writeFileSync(
      file,
      `${assistantLine("G", "2026-09-18T11:00:00.000Z", [{ type: "thinking" }], placeholder)}\n`
    );
    const parser = new ClaudeCodeParser();
    const [first] = await parser.scan(home);
    first.cost = 0.5; // pretend the pricing pass ran on the placeholder

    appendFileSync(
      file,
      `${assistantLine("G", "2026-09-18T11:00:09.000Z", [{ type: "text" }], { ...placeholder, output_tokens: 900 })}\n`
    );
    const [grown] = await parser.scan(home);
    expect(grown.outputTokens).toBe(900);
    expect(grown.cost).toBe(0); // enrichCosts prices $0 records again
  });

  it("records the 1h-TTL share of cache writes, absent when not reported", async () => {
    const line = assistantLine("T", "2026-09-18T10:00:00.000Z", [{ type: "text" }], {
      input_tokens: 2,
      output_tokens: 50,
      cache_read_input_tokens: 384_264,
      cache_creation_input_tokens: 1_547,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_547 },
    });
    writeFileSync(file, `${line}\n`);
    writeFileSync(join(dir, "sess-2.jsonl"), `${turnB[0]}\n`);
    const records = await new ClaudeCodeParser().scan(home);
    const t = records.find((r) => r.apiCallId === "msg_T");
    const b = records.find((r) => r.apiCallId === "msg_B");
    expect(t?.cacheWriteTokens).toBe(1_547);
    expect(t?.cacheWrite1hTokens).toBe(1_547);
    // Older transcripts have no TTL split — the field stays absent, not 0.
    expect(b?.cacheWrite1hTokens).toBeUndefined();
  });

  it("falls back to timestamp+usage dedup for transcripts without ids", async () => {
    const legacy = (ts: string, out: number) =>
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        message: { model: "claude-x", usage: usage(out), content: [{ type: "text" }] },
      });
    writeFileSync(
      file,
      `${[
        legacy("2026-09-18T10:00:00.000Z", 500),
        legacy("2026-09-18T10:00:00.000Z", 500), // same line written twice
        legacy("2026-09-18T10:01:00.000Z", 500), // a new turn
      ].join("\n")}\n`
    );
    const records = await new ClaudeCodeParser().scan(home);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.apiCallId === undefined)).toBe(true);
  });
});

describe("ClaudeCodeParser — 2026-10-29 accounting audit", () => {
  it("clamps the 1h cache-write share to the cache writes it is a subset of", async () => {
    // Raw Claude Code on 2026-09-16: ephemeral_1h = 2050 beside a total of 0.
    writeFileSync(
      file,
      `${assistantLine("H", "2026-09-16T14:07:47.283Z", [{ type: "text" }], {
        input_tokens: 5,
        output_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2050 },
      })}\n`
    );
    const [record] = await new ClaudeCodeParser().scan(home);
    expect(record?.cacheWriteTokens).toBe(0);
    expect(record?.cacheWrite1hTokens ?? 0).toBe(0);
  });

  it("folds a fork subagent's copy of its parent's last message into the original", async () => {
    // Real shape: subagents/agent-*.jsonl opens with fork-context-ref, then a
    // copy of the parent's last assistant message (same id, new timestamp).
    const parent = assistantLine("P", "2026-10-29T08:38:49.770Z", [{ type: "text" }], usage(1250));
    writeFileSync(file, `${parent}\n`);
    const sub = join(dir, "sess-1", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, "agent-a60a.jsonl"),
      `${[
        JSON.stringify({ type: "fork-context-ref", agentId: "a60a", parentSessionId: "sess-1" }),
        assistantLine("P", "2026-10-29T08:38:57.488Z", [{ type: "text" }], usage(1250)),
        toolResultLine("2026-10-29T08:38:58.000Z"),
        assistantLine("F", "2026-10-29T08:39:08.070Z", [{ type: "text" }], usage(300)),
      ].join("\n")}\n`
    );
    const records = await new ClaudeCodeParser().scan(home);
    expect(records.map((r) => r.apiCallId).sort()).toEqual(["msg_F", "msg_P"]);
    const p = records.find((r) => r.apiCallId === "msg_P");
    expect(p?.timestamp).toBe(Date.parse("2026-10-29T08:38:49.770Z")); // the original
    expect(p?.isSubagent).toBeUndefined();
  });

  it("skips an oversized tool-output line and keeps counting after it", async () => {
    const huge = JSON.stringify({
      type: "user",
      timestamp: "2026-10-21T13:51:32.024Z",
      message: { content: [{ type: "tool_result", content: "x".repeat(9 * 1024 * 1024) }] },
    });
    writeFileSync(
      file,
      `${[
        assistantLine("B1", "2026-10-21T13:50:00.000Z", [{ type: "text" }], usage(100)),
        huge,
        assistantLine("B2", "2026-10-21T13:52:00.000Z", [{ type: "text" }], usage(200)),
      ].join("\n")}\n`
    );
    const warnings: string[] = [];
    const notices: string[] = [];
    const records = await new ClaudeCodeParser().scan(home, {
      onWarning: (m) => warnings.push(m),
      onNotice: (m) => notices.push(m),
    });
    expect(records.map((r) => r.outputTokens)).toEqual([100, 200]);
    expect(warnings).toEqual([]); // a tool output carries no usage: not a partial scan
    expect(notices.some((m) => /skipped 1 oversized line/.test(m))).toBe(true);
  });

  it("recovers the usage of an oversized assistant line from its head and tail", async () => {
    const bigInput = "y".repeat(9 * 1024 * 1024);
    writeFileSync(
      file,
      `${assistantLine("BIG", "2026-10-21T14:00:00.000Z", [{ type: "tool_use", name: "Write", input: bigInput } as never], usage(4321))}\n`
    );
    const warnings: string[] = [];
    const records = await new ClaudeCodeParser().scan(home, { onWarning: (m) => warnings.push(m) });
    expect(records).toHaveLength(1);
    expect(records[0]?.apiCallId).toBe("msg_BIG");
    expect(records[0]?.outputTokens).toBe(4321);
    expect(records[0]?.cacheReadTokens).toBe(1000);
    expect(warnings).toEqual([]);
  });

  it("keeps counting a session past 128 MiB, reading only the appended bytes", async () => {
    // A whole-file 128 MiB refusal used to freeze such sessions: on real data
    // a rebuild of 2026-10-21 lost 955 records (205M cache-read tokens).
    writeFileSync(
      file,
      `${assistantLine("S1", "2026-10-21T10:00:00.000Z", [{ type: "text" }], usage(100))}\n`
    );
    const parser = new ClaudeCodeParser();
    expect(await parser.scan(home)).toHaveLength(1);
    const pad = `${JSON.stringify({ type: "user", message: { content: "z".repeat(1_000_000) } })}\n`;
    const chunk = pad.repeat(10);
    for (let i = 0; i < 14; i++) appendFileSync(file, chunk); // ~140 MB
    appendFileSync(
      file,
      `${assistantLine("S2", "2026-10-21T11:00:00.000Z", [{ type: "text" }], usage(5000))}\n`
    );
    const warnings: string[] = [];
    const records = await parser.scan(home, { onWarning: (m) => warnings.push(m) });
    expect(records.map((r) => r.outputTokens)).toEqual([100, 5000]);
    expect(warnings).toEqual([]);
  }, 60_000);

  it("skips a malformed non-usage line instead of dropping the rest of the file", async () => {
    writeFileSync(
      file,
      `${[
        assistantLine("M1", "2026-10-21T10:00:00.000Z", [{ type: "text" }], usage(100)),
        '{"type":"assistant","broken":',
        assistantLine("M2", "2026-10-21T10:01:00.000Z", [{ type: "text" }], usage(200)),
      ].join("\n")}\n`
    );
    const records = await new ClaudeCodeParser().scan(home);
    expect(records.map((r) => r.outputTokens)).toEqual([100, 200]);
  });
});
