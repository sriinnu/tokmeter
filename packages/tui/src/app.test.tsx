import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { TokmeterSummary } from "@sriinnu/tokmeter";
import { render } from "ink";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fetchDaemonTuiSnapshot, TokmeterApp, type TuiSnapshot } from "./app.js";

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function createTestStreams() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { columns: 100, rows: 30, isTTY: true });
  const chunks: string[] = [];
  stdout.on("data", (d: Buffer) => chunks.push(d.toString("utf8")));

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    write: (chunk: string | Buffer) => boolean;
  };
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  });

  return {
    stdout,
    stdin,
    clear: () => {
      chunks.length = 0;
    },
    output: () => chunks.join("").replace(ANSI_ESCAPE_RE, ""),
  };
}

function sampleSnapshot(): TuiSnapshot {
  const summary: TokmeterSummary = {
    records: [],
    projects: [
      {
        project: "alpha-proj",
        totalTokens: 1500,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalCost: 12.34,
        models: ["claude-sonnet-4-5"],
        providers: ["claude-code"],
        firstUsed: 1_760_000_000_000,
        lastUsed: 1_760_001_000_000,
        activeDays: 2,
      },
    ],
    models: [
      {
        model: "claude-sonnet-4-5",
        provider: "claude-code",
        totalTokens: 1500,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cost: 12.34,
        percentageOfTotal: 100,
      },
    ],
    daily: [
      {
        date: "2026-11-24",
        totalTokens: 1500,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cost: 12.34,
        models: ["claude-sonnet-4-5"],
        records: 3,
      },
    ],
    stats: {
      totalTokens: 1500,
      totalCost: 12.34,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalRecords: 3,
      projects: 1,
      models: 1,
      providers: 1,
      activeDays: 2,
      longestStreak: 2,
      firstUsed: 1_760_000_000_000,
      lastUsed: 1_760_001_000_000,
    },
    meta: {
      stableThrough: "2026-11-23",
      historySource: "snapshot",
      todayState: "live",
      lastScanAt: 1_760_001_000_000,
      warnings: [],
      unpricedModels: [],
      unpricedRecords: 0,
    },
  };
  return {
    summary,
    providers: [
      {
        provider: "claude-code",
        totalTokens: 1500,
        cost: 12.34,
        models: ["claude-sonnet-4-5"],
        percentageOfTotal: 100,
      },
    ],
    burnRatePerHour: 2.5,
    source: "daemon",
  };
}

async function waitForOutput(
  getOutput: () => string,
  needle: string,
  timeoutMs = 1500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getOutput().includes(needle)) return;
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function waitForCall(
  fn: { mock: { calls: unknown[] } },
  count: number,
  timeoutMs = 1500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn.mock.calls.length >= count) return;
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("TokmeterApp Ink TUI", () => {
  it("renders tabs, burn rate, handles keyboard navigation, manual refresh, and exit", async () => {
    const streams = createTestStreams();
    const onExit = vi.fn();
    const initial = sampleSnapshot();
    const loadSnapshot = vi.fn(async () => ({
      ...initial,
      burnRatePerHour: 4.25,
    }));

    const inst = render(
      React.createElement(TokmeterApp, {
        initialSnapshot: initial,
        loadSnapshot,
        autoRefreshMs: 0,
        onExit,
      }),
      { stdout: streams.stdout, stdin: streams.stdin, patchConsole: false, debug: true }
    );

    try {
      await waitForOutput(streams.output, "$2.50/h");
      expect(streams.output()).toContain("Overview");
      expect(streams.output()).toContain("$12.34");
      expect(streams.output()).toContain("$2.50/h");
      expect(streams.output()).toContain("daemon");

      streams.clear();
      streams.stdin.write("2");
      await waitForOutput(streams.output, "━━ Models ━━");
      expect(streams.output()).toContain("claude-sonnet-4-5");

      streams.clear();
      streams.stdin.write("3");
      await waitForOutput(streams.output, "2026-11-24");
      expect(streams.output()).toContain("2026-11-24");

      streams.clear();
      streams.stdin.write("4");
      await waitForOutput(streams.output, "━━ Stats ━━");
      expect(streams.output()).toContain("Longest Streak");

      streams.clear();
      streams.stdin.write("1");
      await waitForOutput(streams.output, "Top Models by Cost");
      streams.stdin.write("r");
      await waitForCall(loadSnapshot, 1);
      await waitForOutput(streams.output, "$4.25/h");
      expect(loadSnapshot).toHaveBeenCalledTimes(1);
      expect(streams.output()).toContain("$4.25/h");

      streams.stdin.write("q");
      await waitForCall(onExit, 1);
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally {
      inst.unmount();
    }
  });

  it("fetchDaemonTuiSnapshot reads from warm daemon using TOKMETER_DAEMON_PORT", async () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-tui-daemon-"));
    const token = "c".repeat(64);
    const ddir = join(home, ".tokmeter", "daemon");
    mkdirSync(ddir, { recursive: true, mode: 0o700 });
    writeFileSync(join(ddir, "daemon.token"), token, { mode: 0o600 });

    const snap = sampleSnapshot();
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
      if (req.url === "/api/summary") res.end(JSON.stringify(snap.summary));
      else if (req.url === "/api/providers") res.end(JSON.stringify(snap.providers));
      else if (req.url === "/api/statbar-signals") {
        res.end(
          JSON.stringify({
            burnRate: {
              costPerHour: 3.75,
              tokensPerHour: 12000,
              windowMinutes: 60,
              recordsInWindow: 2,
            },
          })
        );
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const origFetch = globalThis.fetch;
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bad address");
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        );
        if (url.hostname !== "127.0.0.1" || Number(url.port) !== addr.port) {
          return origFetch(input, init);
        }
        return new Promise<Response>((resolve, reject) => {
          const req = httpRequest(
            url,
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
      const env = { ...process.env, TOKMETER_DAEMON_PORT: String(addr.port - 1) };
      const fetched = await fetchDaemonTuiSnapshot(env, home);
      expect(fetched).not.toBeNull();
      expect(fetched?.source).toBe("daemon");
      expect(fetched?.burnRatePerHour).toBe(3.75);
      expect(fetched?.summary.stats.totalCost).toBeCloseTo(12.34, 6);
      expect(fetched?.providers).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
