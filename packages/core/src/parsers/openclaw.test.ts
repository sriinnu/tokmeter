import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenClawParser } from "./openclaw.js";

let home: string;
let outside: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "openclaw-parser-test-"));
  outside = mkdtempSync(join(tmpdir(), "openclaw-outside-"));
});

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  } catch {}
});

function assistantMsg(input: number, output: number) {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      timestamp: 1_790_000_000_000,
      usage: { input, output, cacheRead: 0, cost: { total: 0.01 } },
    },
  });
}

describe("OpenClawParser path containment", () => {
  it("reads in-root session files and rejects traversal, outside absolute paths, and symlinks", async () => {
    const sessDir = join(home, ".openclaw", "agents", "agent-1", "sessions");
    mkdirSync(sessDir, { recursive: true });

    const validFile = join(sessDir, "valid.jsonl");
    const outsideAbsFile = join(outside, "abs-leak.jsonl");
    const traversalFile = join(outside, "traversed.jsonl");
    const symlinkTarget = join(outside, "sym-target.jsonl");
    const symlinkPath = join(sessDir, "sym.jsonl");

    writeFileSync(validFile, `${assistantMsg(100, 20)}\n`);
    writeFileSync(outsideAbsFile, `${assistantMsg(9999, 9999)}\n`);
    writeFileSync(traversalFile, `${assistantMsg(8888, 8888)}\n`);
    writeFileSync(symlinkTarget, `${assistantMsg(7777, 7777)}\n`);
    symlinkSync(symlinkTarget, symlinkPath);

    writeFileSync(
      join(sessDir, "sessions.json"),
      JSON.stringify({
        okRel: { sessionFile: "valid.jsonl" },
        outsideAbs: { sessionFile: outsideAbsFile },
        outsideRel: { sessionFile: "../../../../../../etc/passwd" },
        escapedSymlink: { sessionFile: "sym.jsonl" },
      })
    );

    const records = await new OpenClawParser().scan(home);
    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(100);
    expect(records[0].outputTokens).toBe(20);
  });
});
