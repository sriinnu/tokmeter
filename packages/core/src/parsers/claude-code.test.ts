/**
 * Claude Code parser regression tests.
 *
 * Claude Code writes an assistant turn as one JSONL line per content block
 * (thinking, text, each tool_use). Every line carries the same message.id,
 * requestId and usage object — the usage of the single API response — but its
 * own timestamp, because tool_use lines are written as each tool dispatches.
 * A turn with N parallel tool calls is therefore N lines for ONE charge.
 * Keying dedup on timestamp counted such a turn N times.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeParser } from "./claude-code.js";
import { clearRecordCache } from "./utils.js";

let home: string;
let file: string;

beforeEach(() => {
  clearRecordCache();
  home = mkdtempSync(join(tmpdir(), "claude-code-parser-test-"));
  const dir = join(home, ".claude", "projects", "-tmp-app");
  mkdirSync(dir, { recursive: true });
  file = join(dir, "sess-1.jsonl");
});

afterEach(() => {
  clearRecordCache();
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
  out = 500
): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `${id}-${ts}`,
    requestId: `req_${id}`,
    timestamp: ts,
    message: { id: `msg_${id}`, model: "claude-x", usage: usage(out), content: blocks },
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
const turnB = [assistantLine("B", "2026-09-18T10:01:00.000Z", [{ type: "text" }], 42)];
const turnC = [assistantLine("C", "2026-09-18T10:02:00.000Z", [{ type: "text" }], 42)];

describe("ClaudeCodeParser — one record per API response", () => {
  it("folds the per-content-block lines of a turn into a single record", async () => {
    writeFileSync(file, `${[...turnA, ...turnB, ...turnC].join("\n")}\n`);
    const records = await new ClaudeCodeParser().scan(home);

    expect(records).toHaveLength(3);
    const a = records.find((r) => r.apiCallId === "msg_A:req_A");
    expect(a?.outputTokens).toBe(500);
    expect(a?.cacheReadTokens).toBe(1000);
    // Tool calls from every block line of the turn, in order.
    expect(a?.toolCalls).toEqual(["Read", "Bash", "Edit"]);
  });

  it("keeps distinct responses whose usage numbers coincide", async () => {
    writeFileSync(file, `${[...turnB, ...turnC].join("\n")}\n`);
    const records = await new ClaudeCodeParser().scan(home);
    expect(records.map((r) => r.apiCallId)).toEqual(["msg_B:req_B", "msg_C:req_C"]);
    expect(records.reduce((s, r) => s + r.outputTokens, 0)).toBe(84);
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
    const a = records.find((r) => r.apiCallId === "msg_A:req_A");
    expect(a?.outputTokens).toBe(500);
  });

  it("records the 1h-TTL share of cache writes", async () => {
    const line = JSON.stringify({
      type: "assistant",
      requestId: "req_T",
      timestamp: "2026-09-18T10:00:00.000Z",
      message: {
        id: "msg_T",
        model: "claude-x",
        usage: {
          input_tokens: 2,
          output_tokens: 50,
          cache_read_input_tokens: 384_264,
          cache_creation_input_tokens: 1_547,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_547 },
        },
        content: [{ type: "text" }],
      },
    });
    writeFileSync(file, `${line}\n`);
    const [record] = await new ClaudeCodeParser().scan(home);
    expect(record.cacheWriteTokens).toBe(1_547);
    expect(record.cacheWrite1hTokens).toBe(1_547);
    // Older transcripts have no TTL split — the field stays absent, not 0.
    expect((await scanLegacy()).cacheWrite1hTokens).toBeUndefined();

    async function scanLegacy() {
      clearRecordCache();
      writeFileSync(file, `${turnB[0]}\n`);
      const [r] = await new ClaudeCodeParser().scan(home);
      return r;
    }
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
