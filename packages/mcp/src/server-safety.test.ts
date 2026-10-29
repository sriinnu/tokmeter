/**
 * MCP tool safety: every tool is read-only, nothing that deletes or restores
 * session files is exposed, and the cleanup preview never executes.
 *
 * HOME points at an empty temp dir and CleanupService.execute is wrapped to
 * record any call, so a preview that tried to delete would be caught — nothing
 * here can scan or delete real session files.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fakeHome = mkdtempSync(join(tmpdir(), "tokmeter-mcp-safety-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.CODEX_HOME = join(fakeHome, ".codex");

const executeCalls: { filter: Record<string, unknown>; options: Record<string, unknown> }[] = [];

vi.mock("@sriinnu/tokmeter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sriinnu/tokmeter")>();
  class EmptyTokmeterCore {
    async scan() {
      return [];
    }
  }

  class GuardedCleanupService extends actual.CleanupService {
    async preview() {
      return {
        recordCount: 1,
        sourceFileCount: 1,
        targets: [
          {
            path: "/tmp/untrusted-session.jsonl",
            type: "file" as const,
            sizeBytes: 42,
            provider: "codex" as const,
            description: "session transcript",
          },
        ],
        totalBytes: 42,
        byProvider: [],
        byProject: [],
        partialFileWarnings: [
          {
            file: "/tmp/\u001b]0;owned\u0007session.jsonl",
            matchedRecords: 1,
            otherRecords: 1,
            otherDateRange: "2026-01-01\u202e",
          },
        ],
      };
    }

    async execute(
      filter: Parameters<InstanceType<typeof actual.CleanupService>["execute"]>[0],
      options: Parameters<InstanceType<typeof actual.CleanupService>["execute"]>[1] = {}
    ) {
      executeCalls.push({ filter: { ...filter }, options: { ...options } });
      // The real guard throws before touching any file; let it run so the
      // test exercises core's refusal, not a copy of it.
      if (actual.isEmptyCleanupFilter(filter)) return super.execute(filter, options);
      return { deletedCount: 0, failedCount: 0, errors: [], bytesFreed: 0, backupPath: "/x" };
    }
  }
  return {
    ...actual,
    CleanupService: GuardedCleanupService,
    TokmeterCore: EmptyTokmeterCore,
  };
});

let client: Client;

beforeAll(async () => {
  const { createServer } = await import("./server.js");
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "safety-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

beforeEach(() => {
  executeCalls.length = 0;
});

afterAll(async () => {
  await client?.close();
  rmSync(fakeHome, { recursive: true, force: true });
});

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text: string }[];
  return content.map((c) => c.text).join("\n");
}

describe("MCP tool annotations", () => {
  it("annotates every tool read-only and closed-world", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(22);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });
      expect(tool.annotations?.destructiveHint, tool.name).toBeUndefined();
    }
  });

  it("exposes nothing that deletes or restores session files", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("tokmeter_cleanup_execute");
    expect(names).not.toContain("tokmeter_restore");
    expect(names).toContain("tokmeter_cleanup_preview");
    expect(names).toContain("tokmeter_backups");
  });
});

describe("tokmeter_cleanup_preview", () => {
  it("shows the exact target manifest, sanitized", async () => {
    const result = await client.callTool({
      name: "tokmeter_cleanup_preview",
      arguments: { project: "manifest" },
    });
    expect(text(result)).toContain("TARGET MANIFEST");
    expect(text(result)).toContain("/tmp/untrusted-session.jsonl");
    expect(text(result)).not.toContain("\u001b");
    expect(text(result)).not.toContain("\u202e");
  });

  it("never deletes, and points the user at the CLI instead", async () => {
    const result = await client.callTool({
      name: "tokmeter_cleanup_preview",
      arguments: { project: "manifest" },
    });
    expect(executeCalls).toHaveLength(0);
    expect(text(result)).toMatch(/not available over MCP/);
    expect(text(result)).toContain("tokmeter cleanup");
    expect(text(result)).not.toMatch(/receipt/i);
  });
});

describe("MCP input bounds", () => {
  it("rejects oversized provider filters before scanning", async () => {
    const result = await client.callTool({
      name: "tokmeter_summary",
      arguments: { providers: Array.from({ length: 33 }, (_, index) => `provider-${index}`) },
    });
    expect(result.isError).toBe(true);
  });

  it.each([
    ["tokmeter_models", { limit: 0 }],
    ["tokmeter_search", { model: "x".repeat(513) }],
    ["tokmeter_search", { min_cost: -1 }],
    ["tokmeter_compare", { compare_type: "models", names: Array(65).fill("x") }],
    ["tokmeter_cache_efficiency", { provider: "x".repeat(513) }],
  ])("rejects invalid bounded input for %s", async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
  });
});
