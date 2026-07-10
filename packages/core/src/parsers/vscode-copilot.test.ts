/**
 * VS Code Copilot Chat parser regression tests.
 *
 * VS Code's local chat session store has no token/cost data — Copilot bills
 * via quota'd premium requests, not tokens — so these tests pin the parts
 * that ARE derivable locally: model id, request timestamp, and project name
 * resolution across the three workspace.json shapes VS Code writes
 * (single folder, saved *.code-workspace, and untitled/internal multi-root).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VSCodeCopilotParser } from "./vscode-copilot.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vscode-copilot-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function codeUserDir(): string {
  return join(tmpDir, "Library", "Application Support", "Code", "User");
}

function writeWorkspaceSession(
  hash: string,
  requests: unknown[],
  workspaceMeta?: { folder?: string } | { workspace?: string }
): string {
  const wsDir = join(codeUserDir(), "workspaceStorage", hash);
  const chatSessionsDir = join(wsDir, "chatSessions");
  mkdirSync(chatSessionsDir, { recursive: true });
  if (workspaceMeta) {
    writeFileSync(join(wsDir, "workspace.json"), JSON.stringify(workspaceMeta));
  }
  const filePath = join(chatSessionsDir, "session.json");
  writeFileSync(filePath, JSON.stringify({ requests }));
  return filePath;
}

function fakeRequest(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "copilot/claude-sonnet-4.5",
    timestamp: new Date("2026-06-01T12:00:00.000Z").getTime(),
    result: { metadata: {} },
    ...overrides,
  };
}

describe("VSCodeCopilotParser", () => {
  it("parses a request from a single-folder workspace and resolves the project from workspace.json", async () => {
    writeWorkspaceSession("hash1", [fakeRequest()], {
      folder: "file:///Users/sriinnu/Sriinnu/AI/Runic",
    });

    const records = await new VSCodeCopilotParser().scan(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].provider).toBe("vscode-copilot");
    expect(records[0].model).toBe("claude-sonnet-4.5");
    expect(records[0].project).toContain("Runic");
  });

  it("resolves the project from a saved *.code-workspace file's parent directory", async () => {
    writeWorkspaceSession("hash2", [fakeRequest()], {
      workspace: "file:///Users/sriinnu/Personal/takumi/takumi.code-workspace",
    });

    const records = await new VSCodeCopilotParser().scan(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].project).toContain("takumi");
  });

  it("falls back to a generic project for VS Code's untitled multi-root workspace pointer", async () => {
    writeWorkspaceSession("hash3", [fakeRequest()], {
      workspace:
        "file:///Users/sriinnu/Library/Application%20Support/Code/Workspaces/123/workspace.json",
    });

    const records = await new VSCodeCopilotParser().scan(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].project).toBe("vscode-copilot");
  });

  it("skips requests with no result (still in flight) or missing modelId/timestamp", async () => {
    writeWorkspaceSession("hash4", [
      fakeRequest({ result: undefined }),
      fakeRequest({ modelId: undefined }),
      { ...fakeRequest(), timestamp: undefined },
      fakeRequest(),
    ]);

    const records = await new VSCodeCopilotParser().scan(tmpDir);
    expect(records.length).toBe(1);
  });

  it("marks tokens and cost as not_exposed since Copilot doesn't expose them locally", async () => {
    writeWorkspaceSession("hash5", [fakeRequest()]);

    const records = await new VSCodeCopilotParser().scan(tmpDir);
    const r = records[0];
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.cost).toBe(0);
    expect(r.usage?.inputTokens).toBe("not_exposed");
    expect(r.usage?.cost).toBe("not_exposed");
  });

  it("reads no-folder (empty window) chat sessions from globalStorage", async () => {
    const dir = join(codeUserDir(), "globalStorage", "emptyWindowChatSessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.jsonl"),
      JSON.stringify({
        kind: 0,
        v: { requests: [fakeRequest({ modelId: "copilot/gpt-5.2-codex" })] },
      })
    );

    const records = await new VSCodeCopilotParser().scan(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].model).toBe("gpt-5.2-codex");
    expect(records[0].project).toBe("vscode-copilot");
  });

  it("returns no records when VS Code isn't installed", async () => {
    const records = await new VSCodeCopilotParser().scan(tmpDir);
    expect(records.length).toBe(0);
  });
});
