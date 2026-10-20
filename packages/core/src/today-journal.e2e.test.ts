import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startOfLocalDay } from "./date-utils.js";
import { TokmeterCore } from "./tokmeter-core.js";

// The real path: a Claude Code session deleted between two daemon ticks must
// not take its tokens out of today.
let home: string;
let dir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokmeter-grow-only-"));
  dir = join(home, ".claude", "projects", "-tmp-app");
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function session(name: string, id: string, ts: number, out: number): string {
  const file = join(dir, name);
  const line = {
    type: "assistant",
    uuid: `u-${id}`,
    requestId: `req_${id}`,
    timestamp: new Date(ts).toISOString(),
    message: {
      id: `msg_${id}`,
      model: "claude-x",
      usage: {
        input_tokens: 10,
        output_tokens: out,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text" }],
    },
  };
  writeFileSync(file, `${JSON.stringify(line)}\n`);
  return file;
}

describe("grow-only today", () => {
  test("deleting a session file keeps its tokens in today", async () => {
    const now = Date.now();
    const ts = Math.max(startOfLocalDay(now) + 1000, now - 60_000);
    const kept = session("kept.jsonl", "K", ts, 100);
    const doomed = session("doomed.jsonl", "D", ts + 1, 5000);
    void kept;

    const core = new TokmeterCore({ homeDir: home, skipPricing: true });
    await core.scan();
    expect(core.getTodayAggregate()?.totalTokens).toBe(5120);

    unlinkSync(doomed);
    await core.refreshToday(now + 1000);
    expect(core.getTodayAggregate()?.totalTokens).toBe(5120);

    // And a fresh process (daemon restart) still has it.
    const restarted = new TokmeterCore({ homeDir: home, skipPricing: true });
    await restarted.scan();
    expect(restarted.getTodayAggregate()?.totalTokens).toBe(5120);
  });
});
