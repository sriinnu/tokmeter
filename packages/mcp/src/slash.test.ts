import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG, fetchDaemonJson, localDateKey, TokmeterCore } from "@sriinnu/tokmeter";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDaemonTestHttpServer, type StatuslineContextResponse } from "./daemon/server.js";
import { formatStatuslineSnippets, installPlugin, uninstallPlugin } from "./installer.js";
import { createServer } from "./server.js";
import {
  renderCockpitCard,
  renderDigestCard,
  renderDoctorCard,
  renderLiveCard,
  renderQuotaCard,
  renderRoutesCard,
  renderSlashCard,
  renderSlashHelpCard,
  renderStatuslineCard,
  renderWhyCard,
  SLASH_CARD_WIDTH,
  SLASH_COMMANDS,
  type SlashCardData,
} from "./slash.js";
import { textWidth } from "./statusline-view.js";

const NOW = new Date(2026, 10, 20, 14, 15, 0).getTime();
const TODAY = localDateKey(NOW);

function sampleData(overrides: Partial<SlashCardData> = {}): SlashCardData {
  return {
    now: NOW,
    daemonOnline: true,
    project: "tokmeter-very-long-workspace-name",
    config: DEFAULT_CONFIG,
    todayCost: 42.8,
    todayTokens: 3_420_000,
    weekCost: 184.5,
    monthCost: 612.25,
    pricingMtime: NOW - 3_600_000,
    providers: [
      {
        provider: "claude-code",
        cost: 900,
        totalTokens: 60_000_000,
        models: ["claude-opus-4-5"],
        percentageOfTotal: 90,
      },
    ],
    summary: {
      stats: {
        totalCost: 1420.5,
        totalTokens: 92_500_000,
        activeDays: 45,
        projects: 8,
        longestStreak: 12,
        totalRecords: 980,
      },
      models: [
        {
          model: "claude-opus-4-5-20251101",
          provider: "claude-code",
          cost: 32.1,
          inputTokens: 1_200_000,
          outputTokens: 300_000,
          cacheReadTokens: 4_000_000,
          cacheWriteTokens: 200_000,
          reasoningTokens: 0,
          totalTokens: 5_700_000,
          percentageOfTotal: 75,
        },
      ],
      projects: [
        {
          project: "tokmeter-日本語プロジェクト",
          totalCost: 28.4,
          totalTokens: 2_100_000,
          models: ["claude-opus-4-5"],
          providers: ["claude-code"],
          activeDays: 14,
          lastUsed: NOW,
          firstUsed: NOW - 86_400_000,
        },
      ],
      daily: [
        {
          date: TODAY,
          cost: 42.8,
          totalTokens: 3_420_000,
          inputTokens: 1_000_000,
          outputTokens: 420_000,
          cacheReadTokens: 1_900_000,
          cacheWriteTokens: 100_000,
          reasoningTokens: 0,
          recordCount: 44,
        },
      ],
      meta: {
        lastScanAt: NOW - 5_000,
        scanDurationMs: 22,
        todayState: "live",
        unpricedRecords: 1,
        unpricedModels: ["opaque-local-model"],
        warnings: [],
      },
    } as unknown as SlashCardData["summary"],
    signals: {
      costBasisToday: {
        providerTotals: {},
        modelCount: 2,
      } as unknown as NonNullable<SlashCardData["signals"]>["costBasisToday"],
      modelCostBasisToday: [],
      burnRate: {
        costPerHour: 18.4,
        tokensPerHour: 850_000,
        windowMinutes: 60,
        recordsInWindow: 15,
      },
      cacheHitToday: {
        rate: 0.89,
        canonicalRate: 0.91,
        readShare: 0.89,
        missRate: 0.09,
        freshInputShare: 0.05,
        cacheWriteShare: 0.04,
        cacheReadTokens: 1_900_000,
        cacheWriteTokens: 100_000,
        inputTokens: 100_000,
        freshInputTokens: 100_000,
        totalInputTokens: 2_100_000,
      },
      contextPressure: {
        status: "medium",
        dragShare: 0.4,
        dragTokens: 40_000,
        currentInputTokens: 90_000,
        baselineInputTokens: 50_000,
        turnCount: 6,
        sessionAgeMinutes: 25,
        source: "sourceFile",
        provenance: "estimated",
        reason: "Growing smoothly",
      },
      projectContextToday: [],
      pace: { multiple: 1.3, typicalCostByNow: 32.9, actualCostByNow: 42.8, daysOfHistory: 7 },
      compactionToday: { cost: 1.2, tokens: 80_000, share: 0.03, events: 2 },
      subagentToday: { cost: 6.4, records: 12, share: 0.15 },
      reasoningToday: { tokens: 120_000, outputTokens: 540_000, share: 0.22, records: 10 },
      toolCallsToday: { byTool: [], totalCost: 0, callCount: 0, turnsWithTools: 0 },
      billingWindow: null,
      liveSession: {
        provider: "claude-code",
        model: "claude-opus-4-5",
        project: "tokmeter",
        ageSeconds: 4,
        lastRecordCost: 0.45,
      },
    },
    quotas: [
      {
        agent: "claude-code",
        window: "5h",
        windowMinutes: 300,
        usedPct: 48,
        windowStart: Math.floor(NOW / 1000) - 7200,
        resetsAt: Math.floor(NOW / 1000) + 10800,
        sampledAt: NOW - 5_000,
        avgPctPerHour: 24,
        recentPctPerHour: 22,
        projectedPctAtReset: 112,
        hitsLimitBeforeReset: true,
        verdict: "hits-limit",
      },
      {
        agent: "codex",
        window: "7d",
        windowMinutes: 10080,
        usedPct: 19,
        windowStart: Math.floor(NOW / 1000) - 86400,
        resetsAt: Math.floor(NOW / 1000) + 518400,
        sampledAt: NOW - 60_000,
        creditsBalance: 85,
        avgPctPerHour: 0.8,
        recentPctPerHour: null,
        projectedPctAtReset: 60,
        hitsLimitBeforeReset: false,
        verdict: "resets-first",
      },
    ],
    live: {
      totalCost: 21.5,
      totalInputTokens: 45_000,
      totalOutputTokens: 12_000,
      totalCacheTokens: 890_000,
      sessions: 2,
      providers: ["claude-code", "codex"],
      byModel: [{ model: "opus-4-5", cost: 16.0, inputTokens: 30_000, outputTokens: 8_000 }],
      byProvider: [
        { provider: "claude-code", cost: 16.0, sessions: 1 },
        { provider: "codex", cost: 5.5, sessions: 1 },
      ],
      maxContextFillPct: 62,
    },
    rates: {
      scope: "today",
      registryMtime: NOW - 3_600_000,
      pricingUnavailable: false,
      models: [
        {
          model: "claude-opus-4-5",
          provider: "claude-code",
          source: { tier: "kosha", matchedId: "claude-opus-4-5", label: "Kosha exact" },
          rates: {
            input: { perMillion: 15, derived: false },
            output: { perMillion: 75, derived: false },
            cacheRead: { perMillion: 1.5, derived: false },
            cacheWrite: { perMillion: 18.75, derived: false },
            cacheWrite1h: { perMillion: null, derived: false },
            reasoning: { perMillion: 75, derived: false },
          },
          usage: {
            inputTokens: 100_000,
            outputTokens: 20_000,
            cacheReadTokens: 800_000,
            cacheWriteTokens: 50_000,
            reasoningTokens: 0,
            totalTokens: 970_000,
            cost: 32.1,
          },
          effectivePerMillion: 33.09,
        },
        {
          model: "opaque-local-model",
          provider: "custom",
          source: { tier: "unpriced", label: "No price anywhere" },
          rates: {
            input: { perMillion: null, derived: false },
            output: { perMillion: null, derived: false },
            cacheRead: { perMillion: null, derived: false },
            cacheWrite: { perMillion: null, derived: false },
            cacheWrite1h: { perMillion: null, derived: false },
            reasoning: { perMillion: null, derived: false },
          },
          usage: {
            inputTokens: 50_000,
            outputTokens: 10_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 60_000,
            cost: 0,
          },
          effectivePerMillion: null,
        },
      ],
    },
    crossTool: {
      todayActualCost: 42.8,
      projections: [
        { model: "claude-sonnet-4-5", provider: "claude-code", projectedCost: 14.2 },
        { model: "opaque-local-model", provider: "custom", projectedCost: 0 },
      ],
    },
    health: {
      ready: true,
      unpricedModels: ["opaque-local-model"],
      unpricedModelsTotal: 1,
      unpricedRecords: 1,
      warnings: [{ scope: "parse", message: "test warning" }],
      lastScanAt: NOW - 15_000,
    },
    view: {
      now: NOW,
      project: "tokmeter-very-long-workspace-name",
      model: "Opus 5.5",
      effort: "med",
      ctx: { pct: 42, windowTokens: 1_000_000, turnsLeft: 14 },
      cache: { warm: true, expiresAt: Math.floor(NOW / 1000) + 1800, hitRatio: 0.91 },
      cost: { usd: 6.4 },
      five: { pct: 48, resetsAt: Math.floor(NOW / 1000) + 10800, spanSec: 5 * 3600 },
      today: { state: "fresh", usd: 42.8, ageMs: 3_000, paceMultiple: 1.3 },
    },
    ...overrides,
  };
}

describe("slash cards (66-col contract, neutrality, and read-only safety)", () => {
  it("renders all 8 subcommands + help strictly within 66 display cells", () => {
    const data = sampleData();
    const renderers = [
      ...SLASH_COMMANDS.map((cmd) => () => renderSlashCard(cmd, data)),
      () => renderCockpitCard(data),
      () => renderWhyCard(data),
      () => renderQuotaCard(data),
      () => renderLiveCard(data),
      () => renderRoutesCard(data),
      () => renderDigestCard(data),
      () => renderStatuslineCard(data),
      () => renderDoctorCard(data),
      () => renderSlashHelpCard(),
    ];
    for (const make of renderers) {
      const card = make();
      expect(card).not.toContain("\u001b");
      expect(card).not.toContain("\u0007");
      for (const line of card.split("\n")) {
        expect(textWidth(line), `overflow in line: ${line}`).toBeLessThanOrEqual(SLASH_CARD_WIDTH);
      }
    }
  });

  it("strips ANSI/control characters from hostile repo/model strings", () => {
    const hostile = "evil\u001b]0;pwned\u0007\u001b[2Jrepo";
    const data = sampleData({
      project: hostile,
      view: {
        now: NOW,
        project: hostile,
        model: hostile,
        ctx: { pct: 10 },
        today: { state: "fresh", usd: 1.2 },
      },
    });
    for (const cmd of SLASH_COMMANDS) {
      const out = renderSlashCard(cmd, data);
      expect(out).not.toContain("\u001b");
      expect(out).not.toContain("\u0007");
      for (const line of out.split("\n")) {
        expect(textWidth(line)).toBeLessThanOrEqual(SLASH_CARD_WIDTH);
      }
    }
  });

  it("enforces strict neutrality on routes card and honest $? for unpriced models", () => {
    const card = renderRoutesCard(sampleData());
    expect(card.toLowerCase()).not.toContain("recommended");
    expect(card.toLowerCase()).not.toContain("best value");
    expect(card).toContain("frozen rates");
    expect(card).toContain("kosha");
    expect(card).toContain("$?");
  });

  it("renders statusline card with all 5 skins previewed inside 66 cols", () => {
    const card = renderStatuslineCard(sampleData());
    for (const style of ["rams", "deck", "pill", "meter", "ledger"]) {
      expect(card).toContain(style);
    }
    for (const line of card.split("\n")) {
      expect(textWidth(line)).toBeLessThanOrEqual(SLASH_CARD_WIDTH);
    }
  });
});

describe("installPlugin / uninstallPlugin & snippets", () => {
  it("installs managed slash commands cleanly, skips user-owned files, and uninstalls only managed ones", () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-plugin-test-"));
    try {
      const res = installPlugin({ homeDir: home, quiet: true });
      const claudeCmd = join(home, ".claude", "commands", "tokmeter.md");
      const tmCmd = join(home, ".claude", "commands", "tm.md");
      expect(res.written).toContain(claudeCmd);
      expect(res.written).toContain(tmCmd);
      expect(existsSync(claudeCmd)).toBe(true);
      expect(readFileSync(claudeCmd, "utf-8")).toContain("slash $ARGUMENTS");

      // Simulate user customizing tm.md without managed marker
      writeFileSync(tmCmd, "# custom user command\n", "utf-8");
      const second = installPlugin({ homeDir: home, quiet: true });
      expect(second.skipped).toContain(tmCmd);
      expect(readFileSync(tmCmd, "utf-8")).toBe("# custom user command\n");

      const removed = uninstallPlugin({ homeDir: home, quiet: true });
      expect(removed.removed).toContain(claudeCmd);
      expect(removed.kept).toContain(tmCmd);
      expect(existsSync(claudeCmd)).toBe(false);
      expect(existsSync(tmCmd)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("emits copy-paste snippets for tmux, Zellij, Starship, and terminal title", () => {
    const txt = formatStatuslineSnippets();
    expect(txt).toContain("--ambient --format tmux");
    expect(txt).toContain("--ambient --watch 2000");
    expect(txt).toContain("[custom.tokmeter]");
    expect(txt).toContain("--ambient --format title");
  });
});

describe("/api/statusline-context & MCP slash prompts", () => {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const prevPort = process.env.TOKMETER_DAEMON_PORT;
  const TOKEN = "b".repeat(64);
  let home = "";
  let server: Server | null = null;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-sl-ctx-test-"));
    mkdirSync(join(home, ".tokmeter", "daemon"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".tokmeter", "daemon", "daemon.token"), TOKEN, { mode: 0o600 });
    writeFileSync(
      join(home, ".tokmeter", "config.json"),
      JSON.stringify({ version: 1, alerts: { dailyCostThreshold: 1.0 } }),
      { mode: 0o600 }
    );

    const todayDir = join(home, ".claude", "projects", "-tmp-tokmeter-app");
    mkdirSync(todayDir, { recursive: true });
    writeFileSync(
      join(todayDir, "today.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        uuid: "u-1",
        requestId: "r-1",
        timestamp: new Date(Date.now() - 1_000).toISOString(),
        cwd: "/tmp/tokmeter-app",
        message: {
          id: "m-1",
          model: "opaque-unpriced-model-xyz",
          usage: { input_tokens: 1_000, output_tokens: 500 },
          content: [{ type: "text" }],
        },
      })}\n`
    );

    const core = new TokmeterCore({ homeDir: home });
    await core.scan();

    server = createDaemonTestHttpServer(core, TOKEN, {
      homeDir: home,
      sessions: [
        {
          provider: "claude-code",
          sessionId: "s-1",
          model: "claude-opus-4-5",
          project: "tokmeter-app",
          cost: 2.5,
          tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
          durationMs: 10_000,
          lastUpdate: Date.now(),
          connected: true,
          contextWindow: { usedTokens: 400_000, maxTokens: 1_000_000 },
        },
        {
          provider: "codex",
          sessionId: "s-2",
          model: "gpt-5",
          project: "other",
          cost: 1.2,
          tokens: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          durationMs: 5_000,
          lastUpdate: Date.now() - 2_000,
          connected: true,
        },
      ],
      quotas: [],
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to bind server");
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
    process.env.TOKMETER_DAEMON_PORT = String(addr.port - 1);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevPort === undefined) delete process.env.TOKMETER_DAEMON_PORT;
    else process.env.TOKMETER_DAEMON_PORT = prevPort;
    rmSync(home, { recursive: true, force: true });
  });

  it("serves /api/statusline-context with repo, live sessions, dailyCostThreshold, and unpricedModelsCount", async () => {
    const res = await fetchDaemonJson<StatuslineContextResponse>(
      "/api/statusline-context?project=/tmp/tokmeter-app&agent=claude-code",
      { homeDir: home }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.dailyCostThreshold).toBe(1.0);
      expect(res.data.liveSessions.count).toBe(2);
      expect(res.data.liveSessions.others).toEqual(["codex"]);
      expect(res.data.liveSessions.active[0]?.contextFillPct).toBeCloseTo(40, 4);
      expect(res.data.repo?.name).toBeTruthy();
      expect(res.data.unpricedModelsCount).toBeGreaterThanOrEqual(1);
    }
  });

  it("exposes 6 read-only MCP Prompts via server.registerPrompt", async () => {
    const mcp = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "prompt-test", version: "0.0.0" });
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const list = await client.listPrompts();
      const names = list.prompts.map((p) => p.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "tokmeter_cockpit",
          "tokmeter_why",
          "tokmeter_quota",
          "tokmeter_live",
          "tokmeter_routes",
          "tokmeter_digest",
        ])
      );
      const got = await client.getPrompt({ name: "tokmeter_cockpit" });
      const txt = got.messages
        .map((m) => (m.content.type === "text" ? m.content.text : ""))
        .join("\n");
      expect(txt).toContain("tokmeter · cockpit");
    } finally {
      await client.close();
    }
  });
});
