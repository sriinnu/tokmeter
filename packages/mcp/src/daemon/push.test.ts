import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { pushSessionUpdate, type SessionPush } from "./push.js";

const push: SessionPush = {
  session: { provider: "claude-code", sessionId: "s-1", model: "claude-opus-5-5" },
  cost: 1.25,
  tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 },
  durationMs: 1000,
  contextWindow: { usedTokens: 84_000, maxTokens: 200_000 },
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function listen<T extends Server | WebSocketServer>(server: T): Promise<number> {
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** A port nothing listens on: bind an ephemeral one, then release it. */
async function deadPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("pushSessionUpdate", () => {
  test("sends one update with the bearer token, then closes", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
    const port = await listen(wss);
    const received: unknown[] = [];
    let authorization: string | undefined;
    const closed = new Promise<void>((resolve) => {
      wss.on("connection", (ws, req) => {
        authorization = req.headers.authorization;
        ws.on("message", (data) => received.push(JSON.parse(data.toString())));
        ws.on("close", () => resolve());
      });
    });

    const ok = await pushSessionUpdate(push, {
      url: `ws://127.0.0.1:${port}`,
      authorization: "Bearer test-token",
    });
    await closed;
    expect(ok).toBe(true);
    expect(authorization).toBe("Bearer test-token");
    expect(received).toEqual([{ type: "update", ...push }]);
  });

  test("no token means no daemon: resolves false without opening a socket", async () => {
    const server = createServer();
    let connections = 0;
    server.on("connection", (s) => {
      connections++;
      s.destroy();
    });
    server.listen(0, "127.0.0.1");
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = await listen(server);
    await expect(
      pushSessionUpdate(push, { url: `ws://127.0.0.1:${port}`, authorization: null })
    ).resolves.toBe(false);
    expect(connections).toBe(0);
  });

  test("daemon down (connection refused): resolves false fast, never throws", async () => {
    const port = await deadPort();
    const started = Date.now();
    await expect(
      pushSessionUpdate(push, { url: `ws://127.0.0.1:${port}`, authorization: "Bearer x" })
    ).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(150);
  });

  test("a daemon that accepts TCP but never answers is cut off at the budget", async () => {
    const server = createServer();
    const sockets: Socket[] = [];
    server.on("connection", (s) => sockets.push(s)); // hold the socket, say nothing
    server.listen(0, "127.0.0.1");
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy();
          server.close(() => resolve());
        })
    );
    const port = await listen(server);
    const started = Date.now();
    const ok = await pushSessionUpdate(push, {
      url: `ws://127.0.0.1:${port}`,
      authorization: "Bearer x",
      timeoutMs: 80,
    });
    const elapsed = Date.now() - started;
    expect(ok).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(250);
  });

  test("a rejected handshake (wrong token → 401) resolves false", async () => {
    const wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      verifyClient: () => false,
    });
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
    const port = await listen(wss);
    await expect(
      pushSessionUpdate(push, { url: `ws://127.0.0.1:${port}`, authorization: "Bearer wrong" })
    ).resolves.toBe(false);
  });

  test("a malformed URL resolves false instead of throwing", async () => {
    await expect(
      pushSessionUpdate(push, { url: "not a url", authorization: "Bearer x" })
    ).resolves.toBe(false);
  });
});
