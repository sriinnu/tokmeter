/**
 * DeepSeek Harness parser tests.
 *
 * Fixtures pin the real shape of ~/.dsh/sessions/--<cwd>--/<id>/session.v4.jsonl.zstd:
 * a `session` header, many zstd frames (one per appended batch), and
 * `assistant/message` events with disjoint usage.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeepSeekHarnessParser, zstdFrameLength } from "./deepseek-harness.js";

const T0 = 1_793_649_946_098;

const header = (over: Record<string, unknown> = {}) => ({
  type: "session",
  version: 4,
  id: "session-a",
  createdAt: T0,
  cwd: "/Users/me/app",
  isSeeded: false,
  delegationDepth: 0,
  ...over,
});

const assistant = (id: string, usage: Record<string, number>, offset = 0) => ({
  type: "assistant/message",
  seq: offset,
  time: T0 + offset,
  data: {
    usage: { cacheWriteTokens: 0, ...usage },
    message: {
      id,
      role: "assistant",
      source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" },
      content: [
        { type: "reasoning", text: "hmm" },
        { type: "tool-call", toolName: "bash" },
      ],
    },
  },
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dsh-parser-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function sessionDir(id = "session-a"): string {
  const dir = join(home, ".dsh", "sessions", "--Users-me-app--", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One frame per batch, as the app appends them. */
function frames(batches: unknown[][]): Buffer {
  return Buffer.concat(
    batches.map((batch) =>
      zlib.zstdCompressSync(Buffer.from(`${batch.map((e) => JSON.stringify(e)).join("\n")}\n`))
    )
  );
}

function writeSession(batches: unknown[][], name = "session.v4.jsonl.zstd", id?: string): string {
  const path = join(sessionDir(id), name);
  writeFileSync(path, frames(batches));
  return path;
}

describe("DeepSeekHarnessParser", () => {
  it("reads every frame and keeps usage buckets disjoint", async () => {
    writeSession([
      [header()],
      [assistant("m1", { inputTokens: 7713, outputTokens: 195, cacheReadTokens: 0 }, 1)],
      [assistant("m2", { inputTokens: 201, outputTokens: 645, cacheReadTokens: 7808 }, 2)],
    ]);

    const records = await new DeepSeekHarnessParser().scan(home);

    expect(records.map((r) => r.apiCallId)).toEqual(["m1", "m2"]);
    expect(records[1]).toMatchObject({
      provider: "deepseek-harness",
      model: "deepseek-flash",
      cwd: "/Users/me/app",
      timestamp: T0 + 2,
      inputTokens: 201,
      outputTokens: 645,
      cacheReadTokens: 7808,
      cacheWriteTokens: 0,
      toolCalls: ["bash"],
    });
  });

  it("counts no other event, even one quoting an assistant message", async () => {
    writeSession([
      [
        header(),
        {
          type: "tool/result",
          time: T0,
          data: { message: { text: '{"type":"assistant/message","usage":{"inputTokens":9}}' } },
        },
        { type: "session/title-llm-request", time: T0, data: { maxTokens: 100 } },
        assistant("m1", { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 }, 1),
      ],
    ]);

    const records = await new DeepSeekHarnessParser().scan(home);

    expect(records).toHaveLength(1);
  });

  it("drops events a fork inherited, but not after a plain seed marker", async () => {
    const parent = assistant(
      "parent",
      { inputTokens: 500, outputTokens: 5, cacheReadTokens: 0 },
      1
    );
    const own = assistant("own", { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 }, 2);
    writeSession(
      [
        [header({ id: "fork", isSeeded: true }), parent],
        [{ type: "session/end-seed", time: T0, data: { inherited: true } }, own],
      ],
      undefined,
      "fork"
    );
    writeSession(
      [
        [header({ id: "plain" }), assistant("before", { inputTokens: 4, outputTokens: 1 }, 1)],
        [{ type: "session/end-seed", time: T0, data: {} }],
      ],
      undefined,
      "plain"
    );

    const records = await new DeepSeekHarnessParser().scan(home);

    expect(records.map((r) => r.apiCallId).sort()).toEqual(["before", "own"]);
  });

  it("folds a message copied into another session", async () => {
    const shared = assistant("same", { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }, 1);
    writeSession([[header({ id: "a" }), shared]], undefined, "a");
    writeSession([[header({ id: "b" }), shared]], undefined, "b");

    const records = await new DeepSeekHarnessParser().scan(home);

    expect(records).toHaveLength(1);
  });

  it("reads only the highest generation in a session directory", async () => {
    writeSession(
      [[header(), assistant("old", { inputTokens: 9, outputTokens: 9 }, 1)]],
      "session.v3.jsonl.zstd"
    );
    writeSession([[header(), assistant("new", { inputTokens: 1, outputTokens: 1 }, 1)]]);

    const records = await new DeepSeekHarnessParser().scan(home);

    expect(records.map((r) => r.apiCallId)).toEqual(["new"]);
  });

  it("keeps committed frames from a half-written file, warns, and rereads it later", async () => {
    const whole = frames([
      [header()],
      [assistant("done", { inputTokens: 1, outputTokens: 1 }, 1)],
      [assistant("late", { inputTokens: 2, outputTokens: 2 }, 2)],
    ]);
    const path = join(sessionDir(), "session.v4.jsonl.zstd");
    writeFileSync(path, whole.subarray(0, whole.length - 6));
    const warnings: Array<{ message: string; readThroughMs?: number }> = [];
    const parser = new DeepSeekHarnessParser();

    const first = await parser.scan(home, {
      onWarning: (message, detail) =>
        warnings.push({ message, readThroughMs: detail?.readThroughMs }),
    });

    expect(first.map((r) => r.apiCallId)).toEqual(["done"]);
    expect(warnings).toEqual([
      { message: `a write in ${path} is still in progress`, readThroughMs: T0 + 1 },
    ]);

    writeFileSync(path, whole);
    const second = await parser.scan(home);
    expect(second.map((r) => r.apiCallId)).toEqual(["done", "late"]);
  });

  it("treats a bad line mid-file as settled, not as a write in progress", async () => {
    const path = join(sessionDir(), "session.v4.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(header()),
        '{"type":"assistant/message","broken',
        JSON.stringify(assistant("m1", { inputTokens: 1, outputTokens: 1 }, 1)),
        "",
      ].join("\n")
    );
    const warnings: string[] = [];

    const records = await new DeepSeekHarnessParser().scan(home, {
      onWarning: (message) => warnings.push(message),
    });

    expect(records.map((r) => r.apiCallId)).toEqual(["m1"]);
    expect(warnings).toEqual([`skipped 1 malformed usage line(s) in ${path}`]);
  });

  it("marks a delegated agent's session as a subagent", async () => {
    writeSession([
      [header({ origin: "subagent" }), assistant("m1", { inputTokens: 1, outputTokens: 1 }, 1)],
    ]);

    const [record] = await new DeepSeekHarnessParser().scan(home);

    expect(record?.isSubagent).toBe(true);
  });

  it("returns nothing when the app was never used", async () => {
    await expect(new DeepSeekHarnessParser().scan(home)).resolves.toEqual([]);
  });
});

describe("zstdFrameLength", () => {
  it("measures each frame exactly and refuses a partial one", () => {
    const a = zlib.zstdCompressSync(Buffer.from("first frame\n"));
    const b = zlib.zstdCompressSync(Buffer.from("x".repeat(100_000)));
    const both = Buffer.concat([a, b]);

    expect(zstdFrameLength(both, 0)).toBe(a.length);
    expect(zstdFrameLength(both, a.length)).toBe(b.length);
    expect(zstdFrameLength(both.subarray(0, both.length - 1), a.length)).toBeNull();
    expect(zstdFrameLength(Buffer.from("not zstd"), 0)).toBeNull();
  });
});
