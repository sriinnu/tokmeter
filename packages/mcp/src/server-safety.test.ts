/**
 * MCP tool safety: annotations on every tool, the empty-filter refusal and
 * the mandatory backup on tokmeter_cleanup_execute.
 *
 * HOME points at an empty temp dir and CleanupService.execute is wrapped so a
 * non-empty filter never reaches the real implementation — nothing here can
 * scan or delete real session files.
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

const DESTRUCTIVE = new Set(["tokmeter_cleanup_execute", "tokmeter_restore"]);

let client: Client;

beforeAll(async () => {
  const { createServer } = await import("./server.js");
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "safety-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

beforeEach(() => {
  process.env.TOKMETER_ENABLE_DESTRUCTIVE_MCP = "1";
});

afterAll(async () => {
  await client?.close();
  delete process.env.TOKMETER_ENABLE_DESTRUCTIVE_MCP;
  rmSync(fakeHome, { recursive: true, force: true });
});

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text: string }[];
  return content.map((c) => c.text).join("\n");
}

async function previewReceipt(args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name: "tokmeter_cleanup_preview", arguments: args });
  const receipt = /Preview receipt: ([0-9a-f-]+)/.exec(text(result))?.[1];
  if (!receipt) throw new Error(`missing preview receipt in: ${text(result)}`);
  return receipt;
}

describe("MCP tool annotations", () => {
  it("annotates every tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(24);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    }
  });

  it("marks the read-only tools readOnly", async () => {
    const { tools } = await client.listTools();
    const readOnly = tools.filter((t) => !DESTRUCTIVE.has(t.name));
    expect(readOnly).toHaveLength(22);
    for (const tool of readOnly) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBeUndefined();
    }
  });

  it("marks cleanup_execute and restore destructive and non-idempotent", async () => {
    const { tools } = await client.listTools();
    for (const name of DESTRUCTIVE) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
  });
});

describe("tokmeter_cleanup_execute guards", () => {
  it("shows the exact target manifest before issuing a receipt", async () => {
    const result = await client.callTool({
      name: "tokmeter_cleanup_preview",
      arguments: { project: "manifest" },
    });
    expect(text(result)).toContain("TARGET MANIFEST");
    expect(text(result)).toContain("/tmp/untrusted-session.jsonl");
    expect(text(result)).not.toContain("\u001b");
    expect(text(result)).not.toContain("\u202e");
  });

  it("is disabled unless the machine owner opts in through the server environment", async () => {
    delete process.env.TOKMETER_ENABLE_DESTRUCTIVE_MCP;
    const result = await client.callTool({
      name: "tokmeter_cleanup_execute",
      arguments: { confirm: "DELETE", project: "x" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/machine owner/i);
  });

  it("refuses an empty filter with guidance on what to specify", async () => {
    const result = await client.callTool({
      name: "tokmeter_cleanup_execute",
      arguments: { confirm: "DELETE" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/empty filter/);
    expect(text(result)).toMatch(/project/);
  });

  it("refuses scope 'all' with a blank project (both mean match-everything)", async () => {
    const result = await client.callTool({
      name: "tokmeter_cleanup_execute",
      arguments: { confirm: "DELETE", project: "", scope: "all" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/empty filter/);
  });

  it("always backs up, and says so when backup:false was passed", async () => {
    executeCalls.length = 0;
    const preview_id = await previewReceipt({ project: "no-such-project" });
    const result = await client.callTool({
      name: "tokmeter_cleanup_execute",
      arguments: { confirm: "DELETE", project: "no-such-project", backup: false, preview_id },
    });
    expect(result.isError).toBeFalsy();
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0].options.backup).toBe(true);
    expect(executeCalls[0].options.expectedPreviewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(text(result)).toMatch(/backup:false was ignored/);
  });

  it("does not add the note when backup is left at its default", async () => {
    const preview_id = await previewReceipt({ providers: ["codex"] });
    const result = await client.callTool({
      name: "tokmeter_cleanup_execute",
      arguments: { confirm: "DELETE", providers: ["codex"], preview_id },
    });
    expect(text(result)).not.toMatch(/backup:false/);
  });

  it("requires a one-time preview receipt bound to the exact filters", async () => {
    const preview_id = await previewReceipt({ project: "one" });
    const mismatch = await client.callTool({
      name: "tokmeter_cleanup_execute",
      arguments: { confirm: "DELETE", project: "two", preview_id },
    });
    expect(mismatch.isError).toBe(true);
    expect(text(mismatch)).toMatch(/preview receipt/i);

    const replay = await client.callTool({
      name: "tokmeter_cleanup_execute",
      arguments: { confirm: "DELETE", project: "one", preview_id },
    });
    expect(replay.isError).toBe(true);
  });
});

describe("tokmeter_restore guards", () => {
  it("is disabled unless the machine owner opts in through the server environment", async () => {
    delete process.env.TOKMETER_ENABLE_DESTRUCTIVE_MCP;
    const result = await client.callTool({
      name: "tokmeter_restore",
      arguments: { confirm: "RESTORE", backup_id: "2026-10-25T12-00-00" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/machine owner/i);
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
