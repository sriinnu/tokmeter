import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type DailyEntry,
  fetchDaemonJson,
  localDateKey,
  type ModelSummary,
  type ProjectSummary,
  TokmeterCore,
  type TokmeterStats,
  type TokmeterSummary,
} from "@sriinnu/tokmeter";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SerializedScopedView } from "../scoped-view.js";
import { createServer } from "../server.js";
import {
  type BarSnapshotResponse,
  createDaemonTestHttpServer,
  parseDaemonScopeQuery,
} from "./server.js";

function dayKeyAgo(days: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return localDateKey(d.getTime());
}

const TODAY = dayKeyAgo(0);
const D3 = dayKeyAgo(3);
const D20 = dayKeyAgo(20);
const TOKEN = "a".repeat(64);

function zeroTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: 0,
    recordCount: 0,
  };
}

function writeSealedDay(
  home: string,
  day: string,
  entries: Array<{
    project: string;
    provider: string;
    model: string;
    input: number;
    output: number;
    cost: number;
    records: number;
  }>
): void {
  const ts = new Date(`${day}T10:00:00`).getTime();
  const agg = {
    date: day,
    ...zeroTotals(),
    firstUsed: ts,
    lastUsed: ts,
    models: {} as Record<
      string,
      ReturnType<typeof zeroTotals> & { model: string; providers: string[] }
    >,
    projects: {} as Record<string, ReturnType<typeof zeroTotals> & Record<string, unknown>>,
    providers: {} as Record<string, ReturnType<typeof zeroTotals> & Record<string, unknown>>,
  };
  for (const e of entries) {
    const t = {
      ...zeroTotals(),
      inputTokens: e.input,
      outputTokens: e.output,
      totalTokens: e.input + e.output,
      cost: e.cost,
      recordCount: e.records,
    };
    for (const k of Object.keys(t) as (keyof typeof t)[]) agg[k] += t[k];
    agg.models[e.model] ??= { model: e.model, providers: [], ...zeroTotals() };
    for (const k of Object.keys(t) as (keyof typeof t)[]) agg.models[e.model][k] += t[k];
    if (!agg.models[e.model].providers.includes(e.provider)) {
      agg.models[e.model].providers.push(e.provider);
    }
    agg.projects[e.project] ??= {
      project: e.project,
      ...zeroTotals(),
      firstUsed: ts,
      lastUsed: ts,
      models: [] as string[],
      modelBuckets: {} as Record<string, unknown>,
    };
    const proj = agg.projects[e.project];
    for (const k of Object.keys(t) as (keyof typeof t)[]) proj[k] += t[k];
    (proj.models as string[]).push(e.model);
    (proj.modelBuckets as Record<string, unknown>)[`${e.provider} ${e.model}`] = {
      model: e.model,
      provider: e.provider,
      ...t,
    };
    agg.providers[e.provider] ??= {
      provider: e.provider,
      ...zeroTotals(),
      firstUsed: ts,
      lastUsed: ts,
    };
    const prov = agg.providers[e.provider];
    for (const k of Object.keys(t) as (keyof typeof t)[]) prov[k] += t[k];
  }
  const dir = join(home, ".cache", "tokmeter", "aggregates");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${day}.json`), JSON.stringify(agg), { mode: 0o600 });
}

describe("daemon scoped HTTP API & MCP delegation", () => {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const prevPort = process.env.TOKMETER_DAEMON_PORT;

  let home = "";
  let httpServer: Server | null = null;
  let httpBase = "";
  let wsPort = 0;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-scoped-http-"));
    const daemonDir = join(home, ".tokmeter", "daemon");
    mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(daemonDir, "daemon.token"), TOKEN, { mode: 0o600 });

    writeSealedDay(home, D3, [
      {
        project: "alpha-app",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        input: 300,
        output: 30,
        cost: 3,
        records: 3,
      },
      {
        project: "beta-svc",
        provider: "codex",
        model: "gpt-5",
        input: 500,
        output: 50,
        cost: 5,
        records: 5,
      },
    ]);
    writeSealedDay(home, D20, [
      {
        project: "alpha-app",
        provider: "codex",
        model: "gpt-5",
        input: 2000,
        output: 200,
        cost: 20,
        records: 2,
      },
      {
        project: "beta-svc",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        input: 4000,
        output: 400,
        cost: 40,
        records: 4,
      },
    ]);

    const todayDir = join(home, ".claude", "projects", "-tmp-alpha-app");
    mkdirSync(todayDir, { recursive: true });
    writeFileSync(
      join(todayDir, "today.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        uuid: "today-1",
        requestId: "req_today",
        timestamp: new Date(Date.now() - 1000).toISOString(),
        cwd: "/tmp/alpha-app",
        message: {
          id: "msg_today",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: "text" }],
        },
      })}\n`
    );

    const core = new TokmeterCore({ homeDir: home, skipPricing: true });
    await core.scan();

    httpServer = createDaemonTestHttpServer(core, TOKEN);
    await new Promise<void>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to bind test server");
    wsPort = addr.port - 1;
    httpBase = `http://127.0.0.1:${addr.port}`;
    const origFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      );
      if (u.hostname !== "127.0.0.1" || Number(u.port) !== addr.port) {
        return origFetch(input, init);
      }
      return new Promise<Response>((resolve, reject) => {
        const req = httpRequest(
          u,
          {
            method: init?.method ?? "GET",
            headers: (init?.headers as Record<string, string>) ?? {},
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: res.statusCode ?? 200,
                  headers: res.headers as Record<string, string>,
                })
              )
            );
          }
        );
        req.on("error", reject);
        req.end();
      });
    });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.TOKMETER_DAEMON_PORT = String(wsPort);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => {
      if (!httpServer) return resolve();
      httpServer.close(() => resolve());
    });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevPort === undefined) delete process.env.TOKMETER_DAEMON_PORT;
    else process.env.TOKMETER_DAEMON_PORT = prevPort;
    rmSync(home, { recursive: true, force: true });
  });

  it("parseDaemonScopeQuery validates providers, booleans, and 4-digit years", () => {
    expect(parseDaemonScopeQuery("/api/stats")).toEqual({ options: {}, hasScope: false });
    expect(parseDaemonScopeQuery("/api/stats?providers=codex,claude-code&today=true")).toEqual({
      options: { providers: ["codex", "claude-code"], today: true },
      hasScope: true,
    });
    expect(parseDaemonScopeQuery("/api/stats?providers=not-a-provider").error).toMatch(
      /Unknown provider/
    );
    expect(parseDaemonScopeQuery("/api/stats?year=abc").error).toMatch(/four-digit calendar year/);
    expect(parseDaemonScopeQuery("/api/stats?today=maybe").error).toMatch(/must be true or false/);
  });

  it("serves scoped /api/stats, /api/daily, /api/models, /api/projects, /api/providers, /api/summary, and /api/scoped-view", async () => {
    const statsRes = await fetchDaemonJson<TokmeterStats>("/api/stats?providers=codex", {
      homeDir: home,
    });
    expect(statsRes.ok).toBe(true);
    if (statsRes.ok) {
      expect(statsRes.data.totalCost).toBeCloseTo(25, 6);
      expect(statsRes.data.totalRecords).toBe(7);
    }

    const dailyRes = await fetchDaemonJson<DailyEntry[]>("/api/daily?project=beta", {
      homeDir: home,
    });
    expect(dailyRes.ok).toBe(true);
    if (dailyRes.ok) {
      expect(dailyRes.data.map((d) => d.date)).toEqual([D20, D3]);
      expect(dailyRes.data.reduce((s, d) => s + d.cost, 0)).toBeCloseTo(45, 6);
    }

    const modelsRes = await fetchDaemonJson<ModelSummary[]>("/api/models?week=true", {
      homeDir: home,
    });
    expect(modelsRes.ok).toBe(true);
    if (modelsRes.ok) {
      expect(modelsRes.data.reduce((s, m) => s + m.cost, 0)).toBeCloseTo(8, 6);
    }

    const projRes = await fetchDaemonJson<ProjectSummary[]>("/api/projects?providers=codex", {
      homeDir: home,
    });
    expect(projRes.ok).toBe(true);
    if (projRes.ok) {
      expect(projRes.data.map((p) => p.project).sort()).toEqual(["alpha-app", "beta-svc"]);
      expect(projRes.data.reduce((s, p) => s + p.totalCost, 0)).toBeCloseTo(25, 6);
    }

    const sumRes = await fetchDaemonJson<TokmeterSummary>("/api/summary?today=true", {
      homeDir: home,
    });
    expect(sumRes.ok).toBe(true);
    if (sumRes.ok) {
      expect(sumRes.data.daily.map((d) => d.date)).toEqual([TODAY]);
      expect(sumRes.data.stats.totalRecords).toBe(1);
    }

    const viewRes = await fetchDaemonJson<SerializedScopedView>(
      "/api/scoped-view?scope=week&project=alpha",
      {
        homeDir: home,
      }
    );
    expect(viewRes.ok).toBe(true);
    if (viewRes.ok) {
      expect(viewRes.data.stats.totalCost).toBeCloseTo(3, 6);
      expect(viewRes.data.stats.totalRecords).toBe(4);
      expect(viewRes.data.providers).toHaveLength(1);
      expect(viewRes.data.providers[0]?.provider).toBe("claude-code");
    }

    const badRes = await fetch(`${httpBase}/api/stats?year=bad`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(badRes.status).toBe(400);

    const snapRes = await fetchDaemonJson<BarSnapshotResponse>("/api/bar-snapshot", {
      homeDir: home,
    });
    expect(snapRes.ok).toBe(true);
    if (snapRes.ok) {
      expect(Array.isArray(snapRes.data.daily)).toBe(true);
      expect(Array.isArray(snapRes.data.models)).toBe(true);
      expect(Array.isArray(snapRes.data.todayModels)).toBe(true);
      expect(Array.isArray(snapRes.data.sessions)).toBe(true);
      expect(Array.isArray(snapRes.data.todayProjects)).toBe(true);
      expect(snapRes.data.health?.ready).toBe(true);
      expect(snapRes.data.statbarSignals).not.toBeNull();
      expect(Array.isArray(snapRes.data.partialErrors)).toBe(true);
    }
  });

  it("MCP server routes getScopedView through the warm daemon without scanning locally", async () => {
    const scanSpy = vi.spyOn(TokmeterCore.prototype, "scan");
    try {
      const mcp = createServer();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "daemon-route-test", version: "0.0.0" });
      await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const pulse = await client.callTool({
          name: "tokmeter_pulse",
          arguments: { scope: "week", project: "alpha" },
        });
        const text = (pulse.content as { type: string; text: string }[])
          .map((c) => c.text)
          .join("\n");
        expect(text).toContain("$3.00");
        expect(scanSpy).not.toHaveBeenCalled();

        const models = await client.callTool({
          name: "tokmeter_models",
          arguments: { providers: ["codex"] },
        });
        const modelsText = (models.content as { type: string; text: string }[])
          .map((c) => c.text)
          .join("\n");
        expect(modelsText).toContain("gpt-5");
        expect(modelsText).toContain("$25.00");
        expect(scanSpy).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    } finally {
      scanSpy.mockRestore();
    }
  });
});
