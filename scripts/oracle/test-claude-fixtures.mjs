/**
 * Independent Claude Code oracle verification against built ClaudeCodeParser.
 *
 *   bun run build && node scripts/oracle/test-claude-fixtures.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localDateKey } from "../../packages/core/dist/date-utils.js";
import { ClaudeCodeParser } from "../../packages/core/dist/parsers/claude-code.js";
import { clearRecordCache } from "../../packages/core/dist/parsers/utils.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "claude-oracle-fixtures-"));
const projectsDir = join(root, ".claude", "projects");
const slugDir = join(projectsDir, "-tmp-claude-oracle");

function assistantLine(msgId, timestamp, usage, blocks = [{ type: "text" }]) {
  return JSON.stringify({
    type: "assistant",
    uuid: `${msgId}-${timestamp}`,
    requestId: `req_${msgId}`,
    timestamp,
    message: {
      id: msgId,
      model: "claude-sonnet-4-5",
      usage,
      content: blocks,
    },
  });
}

function emptyBucket() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
}

try {
  // 1. Parent session on 2026-10-14 with multi-line parallel tool calls + 1h TTL splits
  const parentFile = join(slugDir, "sess-parent.jsonl");
  mkdirSync(dirname(parentFile), { recursive: true });
  writeFileSync(
    parentFile,
    `${[
      // Parallel tool call turn (3 lines -> 1 deduped record: 100 in, 50 out, 200 read, 40 write)
      assistantLine("msg_p1", "2026-10-14T12:00:00Z", {
        input_tokens: 100,
        output_tokens: 5,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 40,
      }),
      assistantLine("msg_p1", "2026-10-14T12:00:01Z", {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 40,
      }),
      assistantLine("msg_p1", "2026-10-14T12:00:02Z", {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 40,
      }),
      // Explicit 1h write split (100 of 150)
      assistantLine("msg_w1", "2026-10-14T13:00:00Z", {
        input_tokens: 30,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 150,
        cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 50 },
      }),
      // Clamped anomaly: ephemeral_1h (120) > total cache_creation (50) -> clamped to 50
      assistantLine("msg_w2", "2026-10-14T14:00:00Z", {
        input_tokens: 10,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_1h_input_tokens: 120 },
      }),
      '{"type":"assistant","message":{"usage":{"broken',
    ].join("\n")}\n`
  );

  // 2. Subagent session on 2026-10-15: replays msg_p1 + placeholder/final turn msg_s1 + msg_s2 + msg_v1
  const subagentFile = join(slugDir, "sess-parent", "subagents", "agent-1.jsonl");
  mkdirSync(dirname(subagentFile), { recursive: true });
  writeFileSync(
    subagentFile,
    `${[
      // Fork replay of parent msg_p1 at a later timestamp -> must still keep 2026-10-14 once
      assistantLine("msg_p1", "2026-10-15T12:00:00Z", {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 40,
      }),
      // Placeholder usage (output 3) followed by final usage (output 180) -> max per bucket
      assistantLine("msg_s1", "2026-10-15T12:01:00Z", {
        input_tokens: 20,
        output_tokens: 3,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      }),
      assistantLine("msg_s1", "2026-10-15T12:01:02Z", {
        input_tokens: 20,
        output_tokens: 180,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      }),
      assistantLine("msg_s2", "2026-10-15T12:02:00Z", {
        input_tokens: 50,
        output_tokens: 40,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 0,
      }),
      assistantLine("msg_v1", "2026-10-15T12:03:00Z", {
        input_tokens: 15,
        output_tokens: 25,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ].join("\n")}\n`
  );

  const expectedTotals = {
    calls: 6,
    input: 225,
    output: 325,
    cacheRead: 310,
    cacheWrite: 240,
    cacheWrite1h: 150,
  };
  const day14 = localDateKey(Date.parse("2026-10-14T12:00:00Z"));
  const day15 = localDateKey(Date.parse("2026-10-15T12:01:00Z"));

  const oracleProc = spawnSync("python3", ["-I", join(here, "claude_oracle.py"), projectsDir], {
    encoding: "utf8",
  });
  if (oracleProc.status !== 0) {
    throw new Error(`claude_oracle.py failed (${oracleProc.status}): ${oracleProc.stderr}`);
  }
  const oracle = JSON.parse(oracleProc.stdout);

  const parser = new ClaudeCodeParser();
  const warnings = [];
  const records = await parser.scan(root, {
    onWarning: (msg) => warnings.push(msg),
  });

  const actualTotals = emptyBucket();
  const actualDays = {};
  for (const r of records) {
    const day = localDateKey(r.timestamp);
    const b = actualDays[day] ?? emptyBucket();
    for (const target of [actualTotals, b]) {
      target.calls += 1;
      target.input += r.inputTokens;
      target.output += r.outputTokens;
      target.cacheRead += r.cacheReadTokens;
      target.cacheWrite += r.cacheWriteTokens;
      target.cacheWrite1h += r.cacheWrite1hTokens ?? 0;
    }
    actualDays[day] = b;
  }

  const normalize = (obj) => JSON.stringify(obj, Object.keys(obj).sort());
  if (normalize(oracle.totals) !== normalize(expectedTotals)) {
    throw new Error(
      `Oracle totals mismatch:\n  oracle: ${JSON.stringify(oracle.totals)}\n  truth:  ${JSON.stringify(expectedTotals)}`
    );
  }
  if (normalize(actualTotals) !== normalize(oracle.totals)) {
    throw new Error(
      `ClaudeCodeParser vs oracle totals mismatch:\n  parser: ${JSON.stringify(actualTotals)}\n  oracle: ${JSON.stringify(oracle.totals)}`
    );
  }
  for (const day of [day14, day15]) {
    if (normalize(actualDays[day] ?? {}) !== normalize(oracle.days[day] ?? {})) {
      throw new Error(
        `Day ${day} mismatch:\n  parser: ${JSON.stringify(actualDays[day])}\n  oracle: ${JSON.stringify(oracle.days[day])}`
      );
    }
  }
  if (warnings.length === 0) {
    throw new Error("Expected warning for malformed usage line in sess-parent.jsonl");
  }

  console.log(
    `claude oracle fixtures: all as expected (calls=${actualTotals.calls}, input=${actualTotals.input}, output=${actualTotals.output}, cacheRead=${actualTotals.cacheRead}, cacheWrite=${actualTotals.cacheWrite}, cacheWrite1h=${actualTotals.cacheWrite1h})`
  );
} finally {
  clearRecordCache(root);
  rmSync(root, { recursive: true, force: true });
}
