import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.restoreAllMocks();
  vi.resetModules();
});

type Handler = (req: unknown, res: unknown) => void;

test("every HTTP response carries both API version headers and exposes both to browsers", async () => {
  const root = mkdtempSync(join(tmpdir(), "tokmeter-api-headers-"));
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
      async scan() {}
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
      server.listen = () => {};
      server.close = () => {};
      return server;
    },
  }));
  const sockets: EventEmitter[] = [];
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
  // The HTTP API starts once the WebSocket server is listening.
  await once(sockets[0], "listening");
  expect(handler).toBeTypeOf("function");

  // A CORS preflight and a request from a rebound host: both answer before
  // any route logic, and both must still carry the version headers.
  for (const [method, host] of [
    ["OPTIONS", "127.0.0.1:9877"],
    ["GET", "evil.example"],
  ] as const) {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      },
      writeHead: () => {},
      end: () => {},
    };
    handler?.({ method, url: "/api/ready", headers: { host, origin: "http://localhost" } }, res);
    expect(headers["x-tokmeter-api"]).toBe("tokmeter-api/1");
    expect(headers["x-drishti-api"]).toBe("drishti-api/1");
    const exposed = headers["access-control-expose-headers"] ?? "";
    expect(exposed).toContain("X-Tokmeter-API");
    expect(exposed).toContain("X-Drishti-API");
  }
}, 10_000);
