/**
 * Antigravity parser regression tests.
 *
 * Antigravity's local trajectory store has no public protobuf schema, so
 * these tests hand-build fixture bytes at the wire-format level (varint +
 * length-delimited fields only) matching the structure recovered by manual
 * decoding: a repeated top-level entry -> {uuid, wrapped-base64-summary},
 * where the summary unwraps to {title, Timestamp, file:// refs}.
 *
 * The summary field (top-level field 2) is itself a one-field protobuf
 * wrapper around the base64 text, not raw base64 bytes directly — treating
 * the wrapper's raw bytes as base64 text and relying on Buffer's decoder to
 * silently discard the non-base64 tag/length header worked for 9 of 10 real
 * sessions and silently dropped the 10th. These fixtures always build the
 * real wrapper shape, so a regression back to the naive unwrap is caught by
 * whichever fixture's header bytes don't happen to get stripped cleanly.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityParser } from "./antigravity.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "antigravity-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

// ─── Minimal protobuf wire-format writer (mirrors the parser's reader) ───

function writeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function writeTag(fieldNum: number, wireType: number): Buffer {
  return writeVarint((fieldNum << 3) | wireType);
}

function writeBytesField(fieldNum: number, payload: Buffer): Buffer {
  return Buffer.concat([writeTag(fieldNum, 2), writeVarint(payload.length), payload]);
}

function writeVarintField(fieldNum: number, value: number): Buffer {
  return Buffer.concat([writeTag(fieldNum, 0), writeVarint(value)]);
}

/** Builds one trajectory's raw bytes: {f1: uuid, f2: wrapped-base64-summary}. */
function buildTrajectory(opts: {
  uuid: string;
  title: string;
  epochSeconds: number;
  fileUri?: string;
}): Buffer {
  const timestampMsg = writeVarintField(1, opts.epochSeconds);
  const parts = [writeBytesField(1, Buffer.from(opts.title)), writeBytesField(3, timestampMsg)];
  if (opts.fileUri) {
    // Field 9 in the real format holds a submessage of repeated file:// refs;
    // the parser only regexes for the URI, so a minimal wrapper is enough.
    parts.push(writeBytesField(9, writeBytesField(1, Buffer.from(opts.fileUri))));
  }
  const summary = Buffer.concat(parts);
  const summaryBase64 = Buffer.from(summary.toString("base64"));
  const wrapper = writeBytesField(1, summaryBase64);

  return Buffer.concat([writeBytesField(1, Buffer.from(opts.uuid)), writeBytesField(2, wrapper)]);
}

function buildBlob(trajectories: Buffer[]): string {
  const top = Buffer.concat(trajectories.map((t) => writeBytesField(1, t)));
  return top.toString("base64");
}

/**
 * Seeds a fixture state.vscdb via the `sqlite3` CLI rather than a JS driver.
 * The parser itself needs bun:sqlite/better-sqlite3 at runtime, but vitest
 * (unlike the actual `bun run` CLI/daemon this parser ships in) can't
 * resolve a static `bun:sqlite` import — shelling out sidesteps that
 * entirely and keeps this test independent of which driver is available.
 */
function seedDb(blob: string, appName = "Antigravity"): void {
  const dbDir = join(tmpDir, "Library", "Application Support", appName, "User", "globalStorage");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "state.vscdb");
  // Base64 is quote-safe (alphabet is [A-Za-z0-9+/=]) so no escaping needed.
  const sql = [
    "CREATE TABLE ItemTable (key TEXT UNIQUE, value TEXT);",
    `INSERT INTO ItemTable (key, value) VALUES ('antigravityUnifiedStateSync.trajectorySummaries', '${blob}');`,
  ].join("\n");
  execFileSync("sqlite3", [dbPath], { input: sql });
}

describe("AntigravityParser", () => {
  it("decodes a session's timestamp and project from the wrapped summary", async () => {
    const traj = buildTrajectory({
      uuid: "11111111-1111-1111-1111-111111111111",
      title: "Fixing PDF Rendering",
      epochSeconds: 1766162509,
      fileUri: "file:///Users/sriinnu/Sriinnu/Personal/veda/astral",
    });
    seedDb(buildBlob([traj]));

    const records = await new AntigravityParser().scan(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].provider).toBe("antigravity");
    expect(records[0].timestamp).toBe(1766162509 * 1000);
    expect(records[0].project).toContain("astral");
  });

  it("marks tokens, cost, and model as not derivable — no fabricated data", async () => {
    const traj = buildTrajectory({
      uuid: "22222222-2222-2222-2222-222222222222",
      title: "Untitled",
      epochSeconds: 1766162509,
    });
    seedDb(buildBlob([traj]));

    const records = await new AntigravityParser().scan(tmpDir);
    const r = records[0];
    expect(r.model).toBe("unknown");
    expect(r.inputTokens).toBe(0);
    expect(r.cost).toBe(0);
    expect(r.usage?.inputTokens).toBe("not_exposed");
    expect(r.usage?.cost).toBe("not_exposed");
  });

  it("falls back to a generic project when no file reference is present", async () => {
    const traj = buildTrajectory({
      uuid: "33333333-3333-3333-3333-333333333333",
      title: "hi",
      epochSeconds: 1766162509,
    });
    seedDb(buildBlob([traj]));

    const records = await new AntigravityParser().scan(tmpDir);
    expect(records[0].project).toBe("antigravity");
  });

  it("decodes every entry in a multi-session blob (regression: wrapper unwrap)", async () => {
    const trajectories = Array.from({ length: 10 }, (_, i) =>
      buildTrajectory({
        uuid: `44444444-0000-0000-0000-00000000000${i}`,
        title: `Session ${i}`,
        epochSeconds: 1766162509 + i * 86400,
      })
    );
    seedDb(buildBlob(trajectories));

    const records = await new AntigravityParser().scan(tmpDir);
    expect(records.length).toBe(10);
  });

  it("reads both the legacy Antigravity and newer Antigravity IDE installs", async () => {
    seedDb(
      buildBlob([buildTrajectory({ uuid: "a", title: "Legacy", epochSeconds: 1766162509 })]),
      "Antigravity"
    );
    seedDb(
      buildBlob([buildTrajectory({ uuid: "b", title: "IDE", epochSeconds: 1766162600 })]),
      "Antigravity IDE"
    );

    const records = await new AntigravityParser().scan(tmpDir);
    expect(records.length).toBe(2);
  });

  it("returns no records when Antigravity isn't installed", async () => {
    const records = await new AntigravityParser().scan(tmpDir);
    expect(records.length).toBe(0);
  });
});
