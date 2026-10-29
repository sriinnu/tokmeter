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

  it("replays a multi-line empty-window session: sets, splices and truncations", async () => {
    const dir = join(codeUserDir(), "globalStorage", "emptyWindowChatSessions");
    mkdirSync(dir, { recursive: true });
    const later = new Date("2026-06-02T12:00:00.000Z").getTime();
    const lines = [
      { kind: 0, v: { requests: [], pendingRequests: [] } },
      { kind: 1, k: ["responderUsername"], v: "GitHub Copilot" },
      // A request is pushed before it has a result…
      { kind: 2, k: ["requests"], v: [fakeRequest({ result: undefined, response: [] })] },
      { kind: 2, k: ["requests", 0, "response"], v: [] },
      // …and the result lands later via a set.
      { kind: 1, k: ["requests", 0, "result"], v: { metadata: {} } },
      { kind: 2, k: ["requests"], v: [fakeRequest({ timestamp: later })] },
      // A splice with `i` and no `v` truncates: the second request is undone.
      { kind: 2, k: ["requests"], i: 1 },
      { kind: 2, k: ["requests"], v: [fakeRequest({ modelId: "copilot/gpt-5.3-codex" })] },
    ];
    writeFileSync(
      join(dir, "session.jsonl"),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`
    );

    const records = await new VSCodeCopilotParser().scan(tmpDir);
    expect(records.map((r) => r.model)).toEqual(["claude-sonnet-4.5", "gpt-5.3-codex"]);
  });

  it("skips a torn last line (VS Code mid-append) but fails on a broken interior line", async () => {
    const dir = join(codeUserDir(), "globalStorage", "emptyWindowChatSessions");
    mkdirSync(dir, { recursive: true });
    const head = JSON.stringify({ kind: 0, v: { requests: [fakeRequest()] } });
    writeFileSync(join(dir, "session.jsonl"), `${head}\n{"kind":2,"k":["requ`);
    expect((await new VSCodeCopilotParser().scan(tmpDir)).length).toBe(1);

    writeFileSync(join(dir, "session.jsonl"), `${head}\n{"kind":2,"k":["requ\n{"kind":1}\n`);
    await expect(new VSCodeCopilotParser().scan(tmpDir)).rejects.toThrow(/line 2/);
  });

  it("fails loudly on a mutation it can't apply instead of undercounting", async () => {
    const dir = join(codeUserDir(), "globalStorage", "emptyWindowChatSessions");
    mkdirSync(dir, { recursive: true });
    const lines = [
      { kind: 0, v: { requests: [] } },
      { kind: 3, k: ["requests", 0] },
    ];
    writeFileSync(join(dir, "session.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
    await expect(new VSCodeCopilotParser().scan(tmpDir)).rejects.toThrow(/unknown mutation kind 3/);
  });

  it("reads workspace *.jsonl sessions, and counts a session written both ways once", async () => {
    const chatSessionsDir = join(codeUserDir(), "workspaceStorage", "hash6", "chatSessions");
    mkdirSync(chatSessionsDir, { recursive: true });
    writeFileSync(
      join(chatSessionsDir, "..", "workspace.json"),
      JSON.stringify({ folder: "file:///Users/sriinnu/Personal/takumi" })
    );
    const log = [
      { kind: 0, v: { requests: [fakeRequest()] } },
      { kind: 2, k: ["requests"], v: [fakeRequest()] },
    ];
    writeFileSync(join(chatSessionsDir, "a.jsonl"), log.map((l) => JSON.stringify(l)).join("\n"));
    // The pre-migration copy of the same session must not add to it.
    writeFileSync(join(chatSessionsDir, "a.json"), JSON.stringify({ requests: [fakeRequest()] }));
    writeFileSync(join(chatSessionsDir, "b.json"), JSON.stringify({ requests: [fakeRequest()] }));

    const records = await new VSCodeCopilotParser().scan(tmpDir);
    expect(records.length).toBe(3);
    expect(records.filter((r) => r.sourceFile?.endsWith("a.jsonl")).length).toBe(2);
    expect(records.every((r) => r.project.includes("takumi"))).toBe(true);
  });

  it("returns no records when VS Code isn't installed", async () => {
    const records = await new VSCodeCopilotParser().scan(tmpDir);
    expect(records.length).toBe(0);
  });
});
