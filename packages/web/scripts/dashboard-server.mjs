import { timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
// App-owned, read-only dashboard server. stdin lifetime belongs to the parent.
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, resolve, sep } from "node:path";

const [assetsArg, portArg = "3000", upstream = "http://127.0.0.1:9877"] = process.argv.slice(2);
const assets = await realpath(assetsArg);
const tokenPath =
  process.env.TOKMETER_DAEMON_TOKEN_FILE ?? resolve(homedir(), ".tokmeter/daemon/daemon.token");

// The parent sends this one-time capability through the private stdin pipe.
// Putting it in argv would expose it to other local users through `ps`.
const nonce = await new Promise((resolveNonce, rejectNonce) => {
  let pending = "";
  const timeout = setTimeout(() => finish(new Error("Dashboard launch timed out")), 5000);
  const onEnd = () => finish(new Error("Dashboard parent closed before launch"));
  const onData = (chunk) => {
    pending += chunk.toString("utf8");
    if (pending.length > 256) return finish(new Error("Invalid dashboard launch"));
    const newline = pending.indexOf("\n");
    if (newline < 0) return;
    const value = pending.slice(0, newline).trim();
    if (value.length < 32 || value.length > 128)
      return finish(new Error("Invalid dashboard launch"));
    finish(null, value);
  };
  function finish(error, value) {
    clearTimeout(timeout);
    process.stdin.off("data", onData);
    process.stdin.off("end", onEnd);
    if (error) rejectNonce(error);
    else resolveNonce(value);
  }
  process.stdin.on("data", onData);
  process.stdin.once("end", onEnd);
});

function matchesCapability(value) {
  if (typeof value !== "string" || value.length !== nonce.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(nonce));
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const requests = new Set();
const server = createServer(async (req, res) => {
  const reply = (status, type, body) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  };
  const address = server.address();
  const allowedHosts = [`localhost:${address.port}`, `127.0.0.1:${address.port}`];
  if (
    !allowedHosts.includes(req.headers.host) ||
    (req.headers.origin && !allowedHosts.some((host) => req.headers.origin === `http://${host}`))
  ) {
    reply(403, "text/plain", "Local dashboard requests only");
    return;
  }
  if (req.method !== "GET") {
    reply(405, "text/plain", "Read-only dashboard");
    return;
  }
  try {
    const requestURL = new URL(req.url, "http://localhost");
    const path = requestURL.pathname;
    if (path === "/_tokmeter/ready") {
      if (!matchesCapability(req.headers["x-tokmeter-launch-nonce"])) {
        reply(403, "text/plain", "Forbidden");
        return;
      }
      reply(200, "text/plain", "ready");
      return;
    }
    const cookieName = `tokmeter_session_${address.port}`;
    if (path === "/" && matchesCapability(requestURL.searchParams.get("session"))) {
      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": `${cookieName}=${nonce}; HttpOnly; SameSite=Strict; Path=/`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end();
      return;
    }
    const cookie = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!matchesCapability(cookie)) {
      reply(403, "text/plain", "Forbidden");
      return;
    }
    if (path === "/api/summary" || path === "/api/live") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), path === "/api/live" ? 5000 : 15000);
      requests.add(controller);
      try {
        const token = (await readFile(tokenPath, "utf8")).trim();
        if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Daemon credential unavailable");
        const response = await fetch(`${upstream}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Daemon summary unavailable");
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > (path === "/api/live" ? 1 : 32) * 1024 * 1024) {
            throw new Error("Daemon response too large");
          }
          chunks.push(chunk);
        }
        res.setHeader(
          "X-Tokmeter-Summary-Source",
          response.headers.get("X-Tokmeter-Summary-Source") || "live"
        );
        reply(200, "application/json", Buffer.concat(chunks));
        return;
      } finally {
        clearTimeout(timeout);
        requests.delete(controller);
      }
    }
    // Never serve build-machine usage exports or arbitrary files from Resources.
    const page =
      ["/", "/index.html", "/projects", "/models", "/timeline", "/3d-view"].includes(path) ||
      /^\/projects\/[^/]+$/.test(path);
    if (!page && !path.startsWith("/assets/")) {
      reply(404, "text/plain", "Not found");
      return;
    }
    const file = await realpath(
      resolve(assets, page ? "index.html" : `.${decodeURIComponent(path)}`)
    );
    if (!file.startsWith(assets + sep)) {
      reply(403, "text/plain", "Outside dashboard assets");
      return;
    }
    reply(200, mime[extname(file)] || "application/octet-stream", await readFile(file));
  } catch {
    reply(
      req.url?.startsWith("/api/") ? 503 : 404,
      "text/plain",
      req.url?.startsWith("/api/")
        ? "Usage daemon unavailable. Open Tokmeter and retry."
        : "Not found"
    );
  }
});
server.requestTimeout = 20000;
server.headersTimeout = 5000;
server.maxHeadersCount = 32;
server.on("error", () => {
  process.exitCode = 1;
  process.stdin.destroy();
});
server.listen(Number(portArg), "127.0.0.1", () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
});
const stop = () => {
  for (const request of requests) request.abort();
  server.close();
  server.closeAllConnections();
  process.stdin.destroy();
};
process.stdin.resume();
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
