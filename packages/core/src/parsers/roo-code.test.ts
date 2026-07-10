/**
 * Roo Code parser regression test.
 *
 * The parser used to hardcode `~/.config/Code/User/...` (Linux) and
 * `~/.vscode-server/...` (remote-SSH) as its only search paths. On macOS,
 * VS Code's real data root is `~/Library/Application Support/Code/User/...`
 * — so the parser silently found zero records on every Mac despite being
 * listed as a supported provider. This pins the macOS path.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RooCodeParser } from "./roo-code.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "roo-code-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("RooCodeParser", () => {
  it("finds tasks under macOS's Application Support path", async () => {
    const taskDir = join(
      tmpDir,
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "rooveterinaryinc.roo-cline",
      "tasks",
      "task-1"
    );
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "ui_messages.json"),
      JSON.stringify([
        {
          type: "say",
          say: "api_req_started",
          ts: "2026-06-01T12:00:00.000Z",
          text: JSON.stringify({
            cost: 0.02,
            tokensIn: 100,
            tokensOut: 50,
            model: "claude-sonnet-4.5",
          }),
        },
      ])
    );

    const records = await new RooCodeParser().scan(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].model).toBe("claude-sonnet-4.5");
    expect(records[0].inputTokens).toBe(100);
  });

  it("returns no records when Roo Code isn't installed", async () => {
    const records = await new RooCodeParser().scan(tmpDir);
    expect(records.length).toBe(0);
  });
});
