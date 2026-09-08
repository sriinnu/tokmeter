import { readFile, realpath } from "node:fs/promises";
// App-owned, read-only dashboard server. stdin lifetime belongs to the parent.
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const [assetsArg, portArg = "3000", nonce = "", upstream = "http://127.0.0.1:9877"] =
  process.argv.slice(2);
const assets = await realpath(assetsArg);
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
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/_tokmeter/ready") {
      reply(200, "text/plain", nonce);
      return;
    }
    if (path === "/api/summary") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      requests.add(controller);
      try {
        const response = await fetch(`${upstream}/api/summary`, { signal: controller.signal });
        if (!response.ok) throw new Error("Daemon summary unavailable");
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > 32 * 1024 * 1024) throw new Error("Summary too large");
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
      req.url === "/api/summary" ? 503 : 404,
      "text/plain",
      req.url === "/api/summary"
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
