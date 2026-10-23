import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve("packages/web/scripts/dashboard-server.mjs");
let root: string;
let upstream: Server;
let upstreamURL: string;
let failUpstream = false;
let sawBearer = false;
const launchNonce = "01234567-89ab-cdef-0123-456789abcdef";
const testToken = "a".repeat(64);
const children: ChildProcessWithoutNullStreams[] = [];

async function launch(port = 0) {
  const child = spawn(process.execPath, [script, join(root, "app"), String(port), upstreamURL], {
    stdio: "pipe",
    env: { ...process.env, TOKMETER_DAEMON_TOKEN_FILE: join(root, "daemon.token") },
  });
  children.push(child);
  child.stdin.write(`${launchNonce}\n`);
  const url = await new Promise<string>((resolveURL, reject) => {
    const timer = setTimeout(() => reject(new Error("Dashboard did not become ready")), 3000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Dashboard exited ${code}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.once("data", (data) => {
      clearTimeout(timer);
      resolveURL(String(data).trim());
    });
  });
  return { child, url };
}

async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.stdin.end();
  await exited;
}

async function get(
  url: string,
  path: string,
  headers: Record<string, string> = {},
  method = "GET"
) {
  return await new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolveResponse, reject) => {
      const req = request(url + path, { headers, method }, (res) => {
        let body = "";
        res.on("data", (data) => {
          body += data;
        });
        res.on("end", () =>
          resolveResponse({ status: res.statusCode!, body, headers: res.headers })
        );
      });
      req.on("error", reject);
      req.end();
    }
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tokmeter-dashboard-"));
  await mkdir(join(root, "app/assets"), { recursive: true });
  await writeFile(join(root, "app/index.html"), "<html>dashboard fixture</html>");
  await writeFile(join(root, "app/assets/app.js"), "fixture-script");
  await writeFile(join(root, "app/data.json"), "private-build-export");
  await writeFile(join(root, "daemon.token"), testToken, { mode: 0o600 });
  await writeFile(join(root, "private.txt"), "outside-assets");
  await symlink(join(root, "private.txt"), join(root, "app/assets/escape.txt"));
  failUpstream = false;
  sawBearer = false;
  upstream = createServer((req, res) => {
    if (failUpstream) {
      res.writeHead(503).end();
      return;
    }
    sawBearer = req.headers.authorization === `Bearer ${testToken}`;
    if (!sawBearer || (req.url !== "/api/summary" && req.url !== "/api/live")) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("X-Tokmeter-Summary-Source", "cache");
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/api/live"
          ? { aggregated: { sessions: 2, byModel: [], byProvider: [] } }
          : { stats: { totalTokens: 12345 }, daily: [] }
      )
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  upstreamURL = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
});

afterEach(async () => {
  for (const child of children.splice(0)) await stop(child);
  upstream.closeAllConnections();
  await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
  await rm(root, { recursive: true, force: true });
});

describe("app-owned dashboard server", () => {
  it("serves assets, reloadable routes, readiness and live summary provenance", async () => {
    const { url } = await launch();
    expect((await get(url, "/api/summary")).status).toBe(403);
    expect((await get(url, "/_tokmeter/ready")).status).toBe(403);
    expect(
      (await get(url, "/_tokmeter/ready", { "X-Tokmeter-Launch-Nonce": launchNonce })).body
    ).toBe("ready");
    const bootstrap = await get(url, `/?session=${launchNonce}`);
    expect(bootstrap.status).toBe(302);
    expect(String(bootstrap.headers["set-cookie"])).toContain("HttpOnly; SameSite=Strict");
    const headers = { Cookie: String(bootstrap.headers["set-cookie"]).split(";")[0] };
    for (const path of [
      "/",
      "/projects",
      "/projects/quoted%20name",
      "/models",
      "/timeline",
      "/3d-view",
    ]) {
      const response = await get(url, path, headers);
      expect(response.status).toBe(200);
      expect(response.body).toContain("dashboard fixture");
    }
    expect((await get(url, "/assets/app.js", headers)).body).toBe("fixture-script");
    const summary = await get(url, "/api/summary", headers);
    expect(summary.status).toBe(200);
    expect(JSON.parse(summary.body).stats.totalTokens).toBe(12345);
    expect(summary.headers["x-tokmeter-summary-source"]).toBe("cache");
    expect(sawBearer).toBe(true);
    const live = await get(url, "/api/live", headers);
    expect(JSON.parse(live.body).aggregated.sessions).toBe(2);
    failUpstream = true;
    expect((await get(url, "/api/summary", headers)).status).toBe(503);
  });

  it("refuses foreign requests, mutations, private exports and escaped paths", async () => {
    const { url } = await launch();
    expect((await get(url, "/", { Host: "evil.example:3000" })).status).toBe(403);
    expect((await get(url, "/", { Origin: "https://evil.example" })).status).toBe(403);
    expect((await get(url, "/api/summary", {}, "POST")).status).toBe(405);
    expect((await get(url, "/?session=wrong")).status).toBe(403);
    for (const path of [
      "/data.json",
      "/private.txt",
      "/api/rescan",
      "/assets/escape.txt",
      "/assets/%2e%2e%2f%2e%2e%2fprivate.txt",
    ]) {
      const response = await get(url, path);
      expect([403, 404]).toContain(response.status);
      expect(response.body).not.toContain("private-build-export");
      expect(response.body).not.toContain("outside-assets");
    }
  });

  it("leaves an occupied listener intact and releases its own port on parent EOF", async () => {
    const first = await launch();
    const port = Number(new URL(first.url).port);
    await expect(launch(port)).rejects.toThrow("Dashboard exited 1");
    expect(
      (await get(first.url, "/_tokmeter/ready", { "X-Tokmeter-Launch-Nonce": launchNonce })).body
    ).toBe("ready");
    await stop(first.child);
    await expect(get(first.url, "/")).rejects.toThrow();
    const restarted = await launch(port);
    expect((await get(restarted.url, `/?session=${launchNonce}`)).status).toBe(302);
  });
});
