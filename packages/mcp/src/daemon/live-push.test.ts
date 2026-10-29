// The live feed end to end inside one process: a real daemon WebSocket
// server, the statusline's one-shot push, and the HTTP handlers the web
// dashboard (/api/live) and the macOS bar (/api/quick → liveContextFillPct)
// read. HTTP binding, scans and paths are fixtures; the socket path is real.
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { WebSocketServer } from "ws";

const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.restoreAllMocks();
  vi.resetModules();
});

type Handler = (req: unknown, res: unknown) => Promise<void>;

test("a one-shot statusline push shows up in /api/live and /api/quick after its socket closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tokmeter-live-push-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  vi.doMock("./protocol.js", () => ({
    DAEMON_STATE_DIR: root,
    DAEMON_PID_FILE: join(root, "daemon.pid"),
    DAEMON_IDENTITY_FILE: join(root, "identity.json"),
    DAEMON_TOKEN_FILE: join(root, "daemon.token"),
    DAEMON_STATE_FILE: join(root, "state.json"),
    LEGACY_DAEMON_PID_FILE: join(root, "legacy.pid"),
    LEGACY_DAEMON_TOKEN_FILE: join(root, "legacy.token"),
    DAEMON_PORT: 0,
    DAEMON_HOST: "127.0.0.1",
    DAEMON_URL: "ws://127.0.0.1:0",
    daemonAuthHeader: () => null,
  }));
  vi.doMock("node:os", async () => ({
    ...(await vi.importActual<object>("node:os")),
    setPriority: vi.fn(),
  }));
  vi.doMock("./identity.js", async () => ({
    ...(await vi.importActual<object>("./identity.js")),
    readProcessEvidence: () => ({ startedAt: "fixture lifetime", command: "fixture daemon" }),
  }));
  vi.doMock("@sriinnu/tokmeter", () => ({
    loadConfig: () => ({ daemon: { antigravityLivePolling: false } }),
    localDateKey: () => "2026-09-08",
    pollAntigravityLiveStatus: vi.fn(),
    refreshKoshaRegistry: vi.fn(),
    TokmeterCore: class {
      // Never warms: /api/quick answers from its not-ready branch, which still
      // carries liveContextFillPct — the bar's colour must not wait on a scan.
      scan() {
        return new Promise(() => {});
      }
    },
  }));
  let handler: Handler | undefined;
  vi.doMock("node:http", () => ({
    createServer: (h: Handler) => {
      handler = h;
      const server = new EventEmitter() as EventEmitter & {
        listen: (...args: unknown[]) => void;
        close: () => void;
      };
      server.listen = (...args) => (args.at(-1) as () => void)();
      server.close = () => {};
      return server;
    },
  }));
  const sockets: WebSocketServer[] = [];
  vi.doMock("ws", async () => {
    const real = await vi.importActual<typeof import("ws")>("ws");
    return {
      ...real,
      WebSocketServer: class extends real.WebSocketServer {
        constructor(options: import("ws").ServerOptions) {
          super({ ...options, port: 0 });
          sockets.push(this);
        }
      },
    };
  });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const server = await import("./server.js");
  cleanups.push(() => server.stopDaemon());
  server.startDaemon();
  await once(sockets[0], "listening");
  const address = sockets[0].address();
  if (!address || typeof address === "string") throw new Error("no port");
  const token = readFileSync(join(root, "daemon.token"), "utf8");

  const get = async (url: string) => {
    let status = 200;
    let body = "";
    await handler?.(
      {
        method: "GET",
        url,
        headers: { host: "127.0.0.1:9877", authorization: `Bearer ${token}` },
      },
      {
        setHeader: () => {},
        writeHead: (code: number) => {
          status = code;
        },
        end: (value?: string) => {
          body = value ?? "";
        },
      }
    );
    expect(status).toBe(200);
    return JSON.parse(body);
  };

  // Nothing pushed yet: empty feed, no fill (the bar falls back to neutral).
  expect((await get("/api/live")).aggregated.sessions).toBe(0);
  expect((await get("/api/quick")).liveContextFillPct).toBeUndefined();

  const closed = new Promise<void>((resolve) => {
    sockets[0].once("connection", (ws) => ws.once("close", () => resolve()));
  });
  const { pushSessionUpdate } = await import("./push.js");
  const ok = await pushSessionUpdate(
    {
      session: {
        provider: "claude-code",
        sessionId: "11111111-2222-3333-4444-555555555555",
        model: "claude-opus-5-5",
        project: "tokmeter",
        cwd: "/w/tokmeter",
      },
      cost: 2.5,
      tokens: { inputTokens: 3, outputTokens: 400, cacheReadTokens: 90_000, cacheWriteTokens: 600 },
      durationMs: 60_000,
      contextWindow: { usedTokens: 84_000, maxTokens: 200_000 },
    },
    { url: `ws://127.0.0.1:${address.port}`, authorization: `Bearer ${token}` }
  );
  expect(ok).toBe(true);
  // The daemon has seen the socket close — the moment the old semantics
  // dropped the session.
  await closed;

  const live = (await get("/api/live")).aggregated;
  expect(live.sessions).toBe(1);
  expect(live.providers).toEqual(["claude-code"]);
  expect(live.totalCost).toBe(2.5);
  expect(live.byModel[0].model).toBe("opus-5-5");
  expect(live.maxContextFillPct).toBeCloseTo(42, 6);
  expect((await get("/api/quick")).liveContextFillPct).toBeCloseTo(42, 6);

  // A push with the wrong token never lands.
  const rejected = await pushSessionUpdate(
    {
      session: { provider: "claude-code", sessionId: "intruder", model: "x" },
      cost: 999,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    { url: `ws://127.0.0.1:${address.port}`, authorization: `Bearer ${"0".repeat(64)}` }
  );
  expect(rejected).toBe(false);
  expect((await get("/api/live")).aggregated.sessions).toBe(1);
}, 10_000);
