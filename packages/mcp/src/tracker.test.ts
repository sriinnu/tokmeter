import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenRecord } from "@sriinnu/tokmeter";
import { TokmeterCore } from "@sriinnu/tokmeter";
import { describe, expect, it, vi } from "vitest";
import { computeRollingRates, LiveTracker } from "./tracker.js";

function makeRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    id: "rec-1",
    timestamp: 1_760_000_000_000,
    provider: "claude-code",
    model: "claude-sonnet-4-5",
    project: "demo",
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0.5,
    ...overrides,
  };
}

describe("LiveTracker rolling burn rate & daemon routing", () => {
  it("computes 60m rolling rates without startedAt launch-second spikes", () => {
    const now = 1_760_000_000_000;
    const records: TokenRecord[] = [
      // Recent turn 1 second ago: $0.50, 1200 tokens -> $0.50/h, 20 tokens/min (NOT $1800/h)
      makeRecord({
        id: "recent",
        timestamp: now - 1000,
        cost: 0.5,
        inputTokens: 1000,
        outputTokens: 200,
      }),
      // Old turn 2 hours ago: excluded from 60m rolling window
      makeRecord({ id: "old", timestamp: now - 2 * 3_600_000, cost: 50 }),
    ];

    const rates = computeRollingRates(records, now);
    expect(rates.activeRecords).toBe(1);
    expect(rates.burnRate).toBeCloseTo(0.5, 6);
    expect(rates.tokensPerMin).toBeCloseTo(20, 6);
  });

  it("reads from the warm daemon HTTP API without running a local core scan", async () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-tracker-"));
    const token = "d".repeat(64);
    const ddir = join(home, ".tokmeter", "daemon");
    mkdirSync(ddir, { recursive: true, mode: 0o700 });
    writeFileSync(join(ddir, "daemon.token"), token, { mode: 0o600 });

    const now = Date.now();
    const todayKey = new Date(now).toISOString().slice(0, 10);
    const rec = makeRecord({ timestamp: now - 5000, cost: 1.25 });

    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/ready") {
        res.end(JSON.stringify({ ready: true }));
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      if (req.url === "/api/summary") {
        res.end(
          JSON.stringify({
            records: [rec],
            projects: [],
            models: [],
            daily: [
              {
                date: todayKey,
                totalTokens: 1200,
                inputTokens: 1000,
                outputTokens: 200,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
                cost: 1.25,
                models: ["claude-sonnet-4-5"],
                records: 1,
              },
            ],
            stats: {
              totalTokens: 1200,
              totalCost: 1.25,
              inputTokens: 1000,
              outputTokens: 200,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              totalRecords: 1,
              projects: 1,
              models: 1,
              providers: 1,
              activeDays: 1,
              longestStreak: 1,
              firstUsed: rec.timestamp,
              lastUsed: rec.timestamp,
            },
            meta: {
              stableThrough: null,
              historySource: "none",
              todayState: "live",
              lastScanAt: now,
              warnings: [],
              unpricedModels: [],
              unpricedRecords: 0,
            },
          })
        );
      } else if (req.url === "/api/providers") {
        res.end(JSON.stringify([]));
      } else if (req.url === "/api/statbar-signals") {
        res.end(
          JSON.stringify({
            burnRate: {
              costPerHour: 1.25,
              tokensPerHour: 1200,
              windowMinutes: 60,
              recordsInWindow: 1,
            },
          })
        );
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const scanSpy = vi.spyOn(TokmeterCore.prototype, "scan");
    const origFetch = globalThis.fetch;
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bad address");
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
      const tracker = new LiveTracker({
        homeDir: home,
        env: { ...process.env, TOKMETER_DAEMON_PORT: String(addr.port - 1) },
      });
      const onUpdate = vi.fn();
      tracker.on("update", onUpdate);
      const snap = await tracker.refresh(now);
      expect(scanSpy).not.toHaveBeenCalled();
      expect(snap.burnRate).toBeCloseTo(1.25, 6);
      expect(snap.tokensPerMin).toBeCloseTo(20, 6);
      expect(snap.stats.totalCost).toBeCloseTo(1.25, 6);
      expect(onUpdate).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      scanSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
