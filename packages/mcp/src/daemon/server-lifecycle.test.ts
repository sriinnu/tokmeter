import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

test("a competing bind cannot replace or remove the winner's token and identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "drishti-start-race-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  // Reserve an ephemeral test port, never either production daemon port.
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve()))
  );
  const files = {
    DAEMON_STATE_DIR: root,
    DAEMON_PID_FILE: join(root, "daemon.pid"),
    DAEMON_IDENTITY_FILE: join(root, "identity.json"),
    DAEMON_TOKEN_FILE: join(root, "daemon.token"),
    DAEMON_STATE_FILE: join(root, "state.json"),
    LEGACY_DAEMON_PID_FILE: join(root, "legacy.pid"),
    LEGACY_DAEMON_TOKEN_FILE: join(root, "legacy.token"),
  };
  vi.doMock("./protocol.js", () => ({
    ...files,
    DAEMON_PORT: port,
    DAEMON_HOST: "127.0.0.1",
    DAEMON_URL: `ws://127.0.0.1:${port}`,
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
  // The real WebSocket bind is under test. HTTP, scans, priority, and paths are fixtures.
  vi.doMock("node:http", () => ({
    createServer: () => {
      const server = new EventEmitter() as EventEmitter & {
        listen: (...args: unknown[]) => void;
        close: () => void;
      };
      server.listen = (...args) => (args.at(-1) as () => void)();
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
          super(options);
          sockets.push(this);
        }
      },
    };
  });
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  writeFileSync(files.DAEMON_TOKEN_FILE, "old fixture token");
  const winner = await import("./server.js");
  cleanups.push(() => winner.stopDaemon());
  winner.startDaemon();
  expect(readFileSync(files.DAEMON_TOKEN_FILE, "utf8")).toBe("old fixture token");
  expect(existsSync(files.DAEMON_PID_FILE)).toBe(false);
  await once(sockets[0], "listening");
  const token = readFileSync(files.DAEMON_TOKEN_FILE, "utf8");
  const identity = readFileSync(files.DAEMON_IDENTITY_FILE, "utf8");
  expect(token).not.toBe("old fixture token");

  vi.resetModules();
  const loser = await import("./server.js");
  cleanups.push(() => loser.stopDaemon());
  loser.startDaemon();
  await once(sockets[1], "error");
  expect(exit).toHaveBeenCalledWith(0);
  loser.stopDaemon();
  expect(readFileSync(files.DAEMON_TOKEN_FILE, "utf8")).toBe(token);
  expect(readFileSync(files.DAEMON_IDENTITY_FILE, "utf8")).toBe(identity);
  expect(readFileSync(files.DAEMON_PID_FILE, "utf8")).toBe(String(process.pid));
}, 10_000);
