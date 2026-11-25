import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DailyEntry,
  localDateKey,
  type ModelRatesResponse,
  type ModelSummary,
  type ProjectSummary,
  type QuotaWindow,
  type StatbarSignals,
  TokmeterCore,
  type TokmeterStats,
} from "@sriinnu/tokmeter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BarSnapshotResponse, createDaemonTestHttpServer } from "./server.js";

interface ContractFixture {
  ready: { ready: boolean; warming: boolean; apiVersion: number };
  quick: {
    ready: boolean;
    stats: TokmeterStats;
    liveContextFillPct?: number;
    blockElapsedPct?: number;
  };
  daily: DailyEntry[];
  models: ModelSummary[];
  sessions: ProjectSummary[];
  projectDetail: ProjectSummary;
  pricingStatus: { registryMtime: number };
  cronStatus: {
    installed: boolean;
    lastRunMtime: number;
    lastRunOk: boolean | null;
    lastRunTail: string;
  };
  health: {
    ready: boolean;
    unpricedModels: string[];
    unpricedModelsTotal: number;
    unpricedModelsTruncated: boolean;
    unpricedRecords: number;
    warnings: unknown[];
    lastScanAt: number;
  };
  anomalies: {
    anomalies: Array<{
      ts: number;
      key: string;
      field: string;
      side: string;
      previous: number;
      current: number;
      deltaPct: number;
    }>;
    total: number;
    cappedAt: number;
  };
  statbarSignals: StatbarSignals;
  crossTool: {
    todayActualCost: number;
    todayTokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
    };
    projections: Array<{ model: string; provider: string; projectedCost: number }>;
  };
  quota: { windows: QuotaWindow[] };
  rates: ModelRatesResponse;
  antigravityLive: {
    latestSnapshot: {
      timestamp: number;
      availablePromptCredits: number;
      availableFlowCredits: number;
      models: Array<{ label: string; resetTime?: string; remainingFraction?: number }>;
    } | null;
    creditsUsedToday: {
      promptCreditsUsed: number;
      flowCreditsUsed: number;
      sinceSnapshotAt: number;
    } | null;
  };
  barSnapshot: BarSnapshotResponse;
}

const CONTRACT_URL = new URL("../../../../contracts/daemon-api-contract.json", import.meta.url);
const contract = JSON.parse(readFileSync(CONTRACT_URL, "utf8")) as ContractFixture;

const TOKEN = "c".repeat(64);

function dayKeyAgo(days: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return localDateKey(d.getTime());
}

function writeSealedDayWithCurve(home: string, day: string): void {
  const ts = new Date(`${day}T10:00:00`).getTime();
  const costByHour = new Array<number>(24).fill(0);
  costByHour[10] = 1.5;
  costByHour[15] = 0.5;
  const agg = {
    date: day,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 500,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 1700,
    cost: 2.0,
    recordCount: 2,
    firstUsed: ts,
    lastUsed: ts,
    costByHour,
    models: {
      "claude-sonnet-4-5": {
        model: "claude-sonnet-4-5",
        providers: ["claude-code"],
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1700,
        cost: 2.0,
        recordCount: 2,
      },
    },
    projects: {
      "alpha-app": {
        project: "alpha-app",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1700,
        cost: 2.0,
        recordCount: 2,
        firstUsed: ts,
        lastUsed: ts,
        models: ["claude-sonnet-4-5"],
        modelBuckets: {
          "claude-code claude-sonnet-4-5": {
            model: "claude-sonnet-4-5",
            provider: "claude-code",
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadTokens: 500,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 1700,
            cost: 2.0,
            recordCount: 2,
          },
        },
      },
    },
    providers: {
      "claude-code": {
        provider: "claude-code",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1700,
        cost: 2.0,
        recordCount: 2,
        firstUsed: ts,
        lastUsed: ts,
      },
    },
  };
  const dir = join(home, ".cache", "tokmeter", "aggregates");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${day}.json`), JSON.stringify(agg), { mode: 0o600 });
}

/**
 * Recursively verify that `actual` contains every structural key and value
 * kind present in `expected` so daemon HTTP handlers and Swift Codable models
 * stay synchronized through the shared JSON fixture.
 */
function assertMatchesContractShape(
  actual: unknown,
  expected: unknown,
  path: string,
  nullablePaths: ReadonlySet<string>
): void {
  if (expected === null || expected === undefined) {
    return;
  }
  if ((actual === null || actual === undefined) && nullablePaths.has(path)) {
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} should be an array`).toBe(true);
    const actualArr = actual as unknown[];
    if (expected.length > 0 && actualArr.length > 0) {
      assertMatchesContractShape(actualArr[0], expected[0], `${path}[0]`, nullablePaths);
    }
    return;
  }
  if (typeof expected === "object") {
    expect(
      actual !== null && typeof actual === "object" && !Array.isArray(actual),
      `${path} should be an object`
    ).toBe(true);
    const actualObj = actual as Record<string, unknown>;
    const expectedObj = expected as Record<string, unknown>;
    for (const [key, expectedVal] of Object.entries(expectedObj)) {
      const childPath = `${path}.${key}`;
      if (expectedVal === null && actualObj[key] === undefined) continue;
      if (nullablePaths.has(childPath) && actualObj[key] === undefined) continue;
      expect(key in actualObj, `Missing contract key ${childPath}`).toBe(true);
      assertMatchesContractShape(actualObj[key], expectedVal, childPath, nullablePaths);
    }
    return;
  }
  expect(typeof actual, `${path} should have type ${typeof expected}`).toBe(typeof expected);
}

const NULLABLE_CONTRACT_PATHS = new Set([
  "quick.liveContextFillPct",
  "quick.blockElapsedPct",
  "statbarSignals.contextPressure.provider",
  "statbarSignals.contextPressure.model",
  "statbarSignals.contextPressure.project",
  "statbarSignals.pace.multiple",
  "statbarSignals.billingWindow",
  "statbarSignals.liveSession",
  "statbarSignals.timeOfDay",
  "statbarSignals.timeOfDay.peak",
  "cronStatus.lastRunOk",
  "rates.models[0].priceFlags",
  "rates.models[0].effectivePerMillion",
  "rates.models[0].rates.input.perMillion",
  "rates.models[0].rates.output.perMillion",
  "rates.models[0].rates.cacheRead.perMillion",
  "rates.models[0].rates.cacheWrite.perMillion",
  "rates.models[0].rates.cacheWrite1h.perMillion",
  "rates.models[0].rates.cacheWrite1h.basis",
  "rates.models[0].rates.reasoning.perMillion",
  "antigravityLive.latestSnapshot",
  "antigravityLive.creditsUsedToday",
  "barSnapshot.cronStatus.lastRunOk",
  "barSnapshot.antigravityLive.latestSnapshot",
  "barSnapshot.antigravityLive.creditsUsedToday",
  "barSnapshot.statbarSignals.pace.multiple",
  "barSnapshot.statbarSignals.billingWindow",
  "barSnapshot.statbarSignals.liveSession",
]);

describe("daemon API cross-language contract", () => {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  let home = "";
  let httpServer: Server | null = null;
  let httpBase = "";

  const sampleQuota: QuotaWindow = {
    agent: "codex",
    window: "5h",
    windowMinutes: 300,
    usedPct: 22.0,
    windowStart: Math.floor(Date.now() / 1000) - 3600,
    resetsAt: Math.floor(Date.now() / 1000) + 14400,
    sampledAt: Date.now(),
    plan: "pro",
    creditsBalance: null,
    avgPctPerHour: 6.0,
    recentPctPerHour: 6.5,
    hitsLimitAt: null,
    verdict: "resets-first",
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-daemon-contract-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    for (let d = 1; d <= 8; d++) {
      writeSealedDayWithCurve(home, dayKeyAgo(d));
    }

    const todayDir = join(home, ".claude", "projects", "-tmp-alpha-app");
    mkdirSync(todayDir, { recursive: true });
    writeFileSync(
      join(todayDir, "today.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        uuid: "contract-today-1",
        requestId: "req_contract_1",
        timestamp: new Date(Date.now() - 10_000).toISOString(),
        cwd: "/tmp/alpha-app",
        message: {
          id: "msg_contract_1",
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 500,
          },
          content: [{ type: "tool_use", name: "Edit", input: {} }],
        },
      })}\n`
    );

    const koshaDir = join(home, ".kosha");
    mkdirSync(koshaDir, { recursive: true });
    writeFileSync(
      join(koshaDir, "anomalies.json"),
      JSON.stringify({
        anomalies: [
          {
            ts: Date.now() - 60_000,
            key: "anthropic/claude-sonnet-4-5",
            field: "input",
            side: "up",
            previous: 3.0,
            current: 4.5,
            deltaPct: 50.0,
          },
        ],
      })
    );

    const cacheDir = join(home, ".cache", "tokmeter");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "daily-cron.log"), "Kosha registry refreshed\n");
    writeFileSync(
      join(cacheDir, "antigravity-live-snapshots.jsonl"),
      `${JSON.stringify({
        timestamp: Date.now() - 60_000,
        availablePromptCredits: 450,
        availableFlowCredits: 1200,
        models: [
          {
            label: "Gemini 2.5 Pro",
            resetTime: "2026-11-26T00:00:00Z",
            remainingFraction: 0.9,
          },
        ],
      })}\n`
    );

    const core = new TokmeterCore({ homeDir: home, skipPricing: true });
    await core.scan();

    httpServer = createDaemonTestHttpServer(core, TOKEN, {
      homeDir: home,
      quotas: [sampleQuota],
    });
    await new Promise<void>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to bind contract server");
    httpBase = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (!httpServer) return resolve();
      httpServer.close(() => resolve());
    });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  });

  function fetchEndpoint(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        `${httpBase}${path}`,
        { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            expect(res.statusCode, `${path} status`).toBe(200);
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("matches every live daemon HTTP endpoint against contracts/daemon-api-contract.json", async () => {
    const endpoints: Array<[string, keyof ContractFixture]> = [
      ["/api/ready", "ready"],
      ["/api/quick", "quick"],
      ["/api/daily", "daily"],
      ["/api/models", "models"],
      ["/api/sessions", "sessions"],
      ["/api/projects/alpha-app", "projectDetail"],
      ["/api/pricing-status", "pricingStatus"],
      ["/api/cron-status", "cronStatus"],
      ["/api/health", "health"],
      ["/api/anomalies", "anomalies"],
      ["/api/statbar-signals", "statbarSignals"],
      ["/api/cross-tool", "crossTool"],
      ["/api/quota", "quota"],
      ["/api/rates?scope=all", "rates"],
      ["/api/antigravity-live", "antigravityLive"],
      ["/api/bar-snapshot", "barSnapshot"],
    ];

    for (const [path, section] of endpoints) {
      const live = await fetchEndpoint(path);
      assertMatchesContractShape(live, contract[section], section, NULLABLE_CONTRACT_PATHS);
    }
  });
});
