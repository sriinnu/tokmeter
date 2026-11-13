/**
 * A record whose line has no usable timestamp must keep the same time on
 * every parse of its file.
 *
 * Parsers used to stamp such a record with Date.now(). Today is rebuilt from
 * each scan, so the record sat on whatever day its file was last read: it was
 * counted that day, sealed into it at midnight, and counted again on the next
 * day the file changed and was parsed again. Now createRecord marks it
 * inferred and the scan pipeline dates it by the line before it in the same
 * file (settleInferredTimes), else by when the file was created.
 *
 * Isolation: HOME is a temp dir set before the modules load, because the
 * record cache fixes its path (~/.cache/tokmeter) at import. Without that, the
 * cache calls below would rewrite the user's real scan cache.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenRecord } from "../types.js";

let home: string;
let utils: typeof import("./utils.js");
let fingerprint: (r: TokenRecord) => string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ts-fallback-test-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  utils = await import("./utils.js");
  fingerprint = (await import("../aggregates.js")).recordFingerprint;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** Long enough that Date.now() differs between two parses. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

/** When the file was created, as the fallback reads it. */
function createdAt(file: string): number {
  const s = statSync(file);
  return Math.floor(s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs);
}

/** Parse as the scan pipeline does: the parser, then the settle pass. */
async function parse(scan: () => Promise<TokenRecord[]>): Promise<TokenRecord[]> {
  return utils.settleInferredTimes(await scan()).records;
}

/**
 * Parse, grow the file, parse again. The records of the first parse must come
 * back with the same fingerprints, which the old clock fallback broke.
 */
async function parseTwice(
  scan: () => Promise<TokenRecord[]>,
  grow: () => void
): Promise<{ first: TokenRecord[]; second: TokenRecord[] }> {
  const first = await parse(scan);
  await tick();
  grow();
  const second = await parse(scan);
  return { first, second };
}

describe("createRecord", () => {
  it("marks a record with no time as inferred and dates it by the file's creation", async () => {
    const file = join(home, "s.jsonl");
    writeFileSync(file, "{}\n");
    const before = Date.now();
    await tick();
    const r = utils.createRecord({
      timestamp: undefined,
      provider: "pi",
      model: "m",
      sourceFile: file,
    });
    expect(r.timestampInferred).toBe(true);
    expect(r.timestamp).toBe(createdAt(file));
    expect(r.timestamp).toBeLessThan(before + 1);
  });

  it("treats an unparseable date (NaN) like a missing one", () => {
    const file = join(home, "s.jsonl");
    writeFileSync(file, "{}\n");
    const ts = new Date("not a date").getTime();
    const r = utils.createRecord({ timestamp: ts, provider: "pi", model: "m", sourceFile: file });
    expect(r.timestampInferred).toBe(true);
    expect(r.timestamp).toBe(createdAt(file));
  });

  it("keeps a real timestamp as given, unmarked", () => {
    const r = utils.createRecord({
      timestamp: 1_790_000_000_000,
      provider: "pi",
      model: "m",
      sourceFile: join(home, "missing.jsonl"),
    });
    expect(r.timestamp).toBe(1_790_000_000_000);
    expect(r.timestampInferred).toBeUndefined();
  });
});

describe("settleInferredTimes", () => {
  const rec = (sourceFile: string, timestamp: number | undefined, out = 100) =>
    utils.createRecord({ timestamp, provider: "pi", model: "m", sourceFile, outputTokens: out });

  it("dates a record by the line before it in the same file", () => {
    const a = join(home, "a.jsonl");
    const b = join(home, "b.jsonl");
    writeFileSync(a, "{}\n");
    writeFileSync(b, "{}\n");
    const { records, inferred } = utils.settleInferredTimes([
      rec(a, 1_790_000_000_000),
      rec(b, 1_795_000_000_000),
      rec(a, undefined),
    ]);
    expect(inferred).toBe(1);
    // The line before it in its own file, not b's line that came between.
    expect(records[2].timestamp).toBe(1_790_000_000_001);
  });

  it("keeps two identical timestamp-less responses as two records", () => {
    const a = join(home, "a.jsonl");
    writeFileSync(a, "{}\n");
    const { records } = utils.settleInferredTimes([
      rec(a, 1_790_000_000_000),
      rec(a, undefined),
      rec(a, undefined),
    ]);
    expect(new Set(records.map(fingerprint)).size).toBe(3);
  });

  it("uses the file's creation time when nothing comes before", () => {
    const a = join(home, "a.jsonl");
    writeFileSync(a, "{}\n");
    const { records } = utils.settleInferredTimes([rec(a, undefined), rec(a, 1_790_000_000_000)]);
    expect(records[0].timestamp).toBe(createdAt(a) + 1);
  });

  it("doesn't remember a clock reading for a file it couldn't read", async () => {
    const gone = join(home, "not-yet.jsonl");
    const t1 = utils.fallbackRecordTime(gone);
    await tick();
    writeFileSync(gone, "{}\n");
    expect(utils.fallbackRecordTime(gone)).toBe(createdAt(gone));
    expect(createdAt(gone)).toBeGreaterThan(t1);
  });

  it("never mutates the records it was given", () => {
    const a = join(home, "a.jsonl");
    writeFileSync(a, "{}\n");
    const input = [rec(a, 1_790_000_000_000), rec(a, undefined)];
    const was = input[1].timestamp;
    utils.settleInferredTimes(input);
    expect(input[1].timestamp).toBe(was);
  });
});

describe("a session without timestamps keeps its records' times across re-parses", () => {
  it("Claude Code JSONL, fully re-parsed", async () => {
    const { ClaudeCodeParser } = await import("./claude-code.js");
    const dir = join(home, ".claude", "projects", "-tmp-app");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "sess.jsonl");
    const line = (id: string, out: number) =>
      JSON.stringify({
        type: "assistant",
        uuid: `u-${id}`,
        requestId: `req_${id}`,
        message: {
          id: `msg_${id}`,
          model: "claude-x",
          usage: { input_tokens: 10, output_tokens: out },
          content: [{ type: "text" }],
        },
      });
    writeFileSync(file, `${line("A", 100)}\n`);

    // An append alone is read from the cached offset and keeps the old record
    // as it was. Dropping the cache entry forces the full re-parse a cache
    // version bump, a cache GC or a rewritten file causes.
    const parser = new ClaudeCodeParser();
    const { first, second } = await parseTwice(
      () => parser.scan(home),
      () => {
        appendFileSync(file, `${line("B", 200)}\n`);
        utils.invalidateRecordCache([file]);
      }
    );
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(fingerprint(second[0])).toBe(fingerprint(first[0]));
  });

  it("Cline JSONL", async () => {
    const { ClineParser } = await import("./cline.js");
    const dir = join(home, ".cline", "apps", "kanban", "sessions");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "1790185442767_abc.jsonl");
    const line = (out: number) =>
      JSON.stringify({
        stream: "chat_usage",
        chunk: JSON.stringify({ inputTokens: 10, outputTokens: out }),
      });
    writeFileSync(file, `${line(100)}\n`);

    const parser = new ClineParser();
    const { first, second } = await parseTwice(
      () => parser.scan(home),
      () => appendFileSync(file, `${line(200)}\n`)
    );
    expect(second).toHaveLength(2);
    expect(fingerprint(second[0])).toBe(fingerprint(first[0]));
  });

  it("Gemini session JSON, rewritten whole", async () => {
    const { GeminiParser } = await import("./gemini.js");
    const dir = join(home, ".gemini", "tmp", "sid", "chats");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "chat.json");
    const msg = (out: number) => ({
      type: "gemini",
      model: "gemini-x",
      tokens: { input: 10, output: out },
    });
    writeFileSync(file, JSON.stringify({ sessionId: "sid", messages: [msg(100)] }));

    const parser = new GeminiParser();
    const { first, second } = await parseTwice(
      () => parser.scan(home),
      () =>
        writeFileSync(file, JSON.stringify({ sessionId: "sid", messages: [msg(100), msg(200)] }))
    );
    expect(second).toHaveLength(2);
    expect(fingerprint(second[0])).toBe(fingerprint(first[0]));
  });
});

describe("OpenClaw, whose index names its session files relatively", () => {
  it("dates by the resolved file, not the clock", async () => {
    const { OpenClawParser } = await import("./openclaw.js");
    const dir = join(home, ".openclaw", "agents", "a1", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({ k: { sessionFile: "s1.jsonl" } }));
    const file = join(dir, "s1.jsonl");
    const line = (out: number) =>
      JSON.stringify({
        type: "message",
        message: { role: "assistant", usage: { input: 10, output: out } },
      });
    writeFileSync(file, `${line(100)}\n`);

    // A fresh process each time: the remembered creation time can't mask a
    // clock reading, which is what a relative sourceFile used to fall back to.
    const parser = new OpenClawParser();
    const first = await parse(() => parser.scan(home));
    await tick();
    utils.resetFallbackRecordTimes();
    appendFileSync(file, `${line(200)}\n`);
    const second = await parse(() => parser.scan(home));
    expect(first[0].sourceFile).toBe(file);
    expect(first[0].timestamp).toBe(createdAt(file) + 1);
    expect(fingerprint(second[0])).toBe(fingerprint(first[0]));
  });
});

describe("the scan pipeline", () => {
  it("settles inferred times and says how many there were", async () => {
    const { scanRawRecords } = await import("../scan-pipeline.js");
    const { PricingService } = await import("../pricing.js");
    const dir = join(home, ".cline", "apps", "kanban", "sessions");
    mkdirSync(dir, { recursive: true });
    const usage = (out: number, ts?: number) =>
      JSON.stringify({
        ...(ts !== undefined ? { ts } : {}),
        stream: "chat_usage",
        chunk: JSON.stringify({ inputTokens: 10, outputTokens: out }),
      });
    writeFileSync(join(dir, "s.jsonl"), `${usage(100, 1_790_000_000_000)}\n${usage(200)}\n`);

    const warnings: import("../types.js").ScanWarning[] = [];
    const records = await scanRawRecords(
      { homeDir: home, pricing: new PricingService(), skipPricing: true },
      ["cline"],
      "today",
      warnings
    );
    expect(records.map((r) => r.timestamp)).toEqual([1_790_000_000_000, 1_790_000_000_001]);
    const notice = warnings.find((w) => w.message.includes("had no timestamp"));
    expect(notice).toMatchObject({ provider: "cline", notice: true });
  });
});
