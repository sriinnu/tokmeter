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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fakeHome = mkdtempSync(join(tmpdir(), "tokmeter-mcp-safety-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.CODEX_HOME = join(fakeHome, ".codex");

const executeCalls: { filter: Record<string, unknown>; options: Record<string, unknown> }[] = [];

vi.mock("@sriinnu/tokmeter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sriinnu/tokmeter")>();
  class GuardedCleanupService extends actual.CleanupService {
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
  return { ...actual, CleanupService: GuardedCleanupService };
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

afterAll(async () => {
  await client?.close();
  rmSync(fakeHome, { recursive: true, force: true });
});

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text: string }[];
  return content.map((c) => c.text).join("\n");
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
    const result = await client.callTool({
      name: "tokmeter_cleanup_execute",
      arguments: { confirm: "DELETE", project: "no-such-project", backup: false },
    });
    expect(result.isError).toBeFalsy();
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0].options.backup).toBe(true);
    expect(text(result)).toMatch(/backup:false was ignored/);
  });

  it("does not add the note when backup is left at its default", async () => {
    const result = await client.callTool({
      name: "tokmeter_cleanup_execute",
      arguments: { confirm: "DELETE", providers: ["codex"] },
    });
    expect(text(result)).not.toMatch(/backup:false/);
  });
});
