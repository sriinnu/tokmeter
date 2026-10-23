import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import {
  loadSummaryCache,
  saveSummaryCache,
  TokmeterCore,
  type TokmeterSummary,
} from "../core/src/index.ts";
import { appNoticesPlugin } from "./scripts/app-notices.js";

const DEV_SUMMARY_TTL_MS = 15_000;
const SUMMARY_SOURCE_HEADER = "X-Tokmeter-Summary-Source";
const devCapability = randomBytes(32).toString("hex");
const devCookieName = `tokmeter_web_dev_${randomBytes(4).toString("hex")}`;

function hasDevCapability(value: string | undefined): boolean {
  return (
    !!value &&
    value.length === devCapability.length &&
    timingSafeEqual(Buffer.from(value), Buffer.from(devCapability))
  );
}

function tokmeterSummaryDevPlugin(): Plugin {
  let cachedSummary: TokmeterSummary | null = null;
  let cachedSource: "live" | "cache" = "live";
  let cachedAt = 0;
  let inflight: Promise<{ summary: TokmeterSummary; source: "live" | "cache" }> | null = null;

  async function getSummary(): Promise<{ summary: TokmeterSummary; source: "live" | "cache" }> {
    const now = Date.now();
    if (cachedSummary && now - cachedAt < DEV_SUMMARY_TTL_MS) {
      return { summary: cachedSummary, source: cachedSource };
    }

    if (inflight) {
      return inflight;
    }

    inflight = (async () => {
      const cached = loadSummaryCache(homedir());

      try {
        const core = new TokmeterCore();
        await core.scan();
        let summary = core.getSummary();
        const cacheWarnings = saveSummaryCache(homedir(), summary);
        if (cacheWarnings.length > 0) {
          summary = appendWarnings(summary, cacheWarnings, summary.meta.todayState);
        }
        cachedSummary = summary;
        cachedSource = "live";
        cachedAt = Date.now();
        return { summary, source: "live" };
      } catch (error) {
        if (cached.summary) {
          const summary = appendWarnings(
            cached.summary,
            [
              ...cached.warnings,
              {
                scope: "cache",
                message: `Live summary refresh failed — serving persisted cache (${toErrorMessage(error)}).`,
              },
            ],
            "snapshot-only"
          );
          cachedSummary = summary;
          cachedSource = "cache";
          cachedAt = Date.now();
          return { summary, source: "cache" };
        }

        throw error;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  function install(middlewares: {
    use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void;
  }) {
    middlewares.use(async (req, res, next) => {
      const requestURL = new URL(req.url ?? "/", "http://localhost");
      const path = requestURL.pathname;
      const host = req.headers.host;
      if (
        !host ||
        !/^(localhost|127\.0\.0\.1):\d+$/.test(host) ||
        (req.headers.origin && req.headers.origin !== `http://${host}`)
      ) {
        res.writeHead(403).end();
        return;
      }
      if (
        req.method === "GET" &&
        path === "/" &&
        hasDevCapability(requestURL.searchParams.get("session") ?? undefined)
      ) {
        res
          .writeHead(302, {
            Location: "/",
            "Set-Cookie": `${devCookieName}=${devCapability}; HttpOnly; SameSite=Strict; Path=/`,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          })
          .end();
        return;
      }
      const cookie = req.headers.cookie
        ?.split(";")
        .map((part: string) => part.trim())
        .find((part: string) => part.startsWith(`${devCookieName}=`))
        ?.slice(devCookieName.length + 1);
      if (!hasDevCapability(cookie)) {
        res.writeHead(403).end();
        return;
      }
      if (path !== "/api/summary" && path !== "/api/live") {
        next();
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      try {
        let body: unknown;
        if (path === "/api/summary") {
          const { summary, source } = await getSummary();
          res.setHeader(SUMMARY_SOURCE_HEADER, source);
          body = summary;
        } else {
          const token = (
            await readFile(resolve(homedir(), ".tokmeter/daemon/daemon.token"), "utf8")
          ).trim();
          if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Daemon credential unavailable");
          const response = await fetch("http://127.0.0.1:9877/api/live", {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error("Daemon live data unavailable");
          body = await response.json();
        }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(body));
      } catch (error) {
        res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: `Tokmeter data unavailable: ${toErrorMessage(error)}` }));
      }
    });
  }

  return {
    name: "tokmeter-summary-dev-plugin",
    configurePreviewServer(server) {
      install(server.middlewares);
    },
    configureServer(server) {
      install(server.middlewares);
    },
  };
}

function appendWarnings(
  summary: TokmeterSummary,
  warnings: TokmeterSummary["meta"]["warnings"],
  todayState: TokmeterSummary["meta"]["todayState"]
): TokmeterSummary {
  return {
    ...summary,
    meta: {
      ...summary.meta,
      todayState,
      warnings: [...summary.meta.warnings, ...warnings],
    },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default defineConfig({
  publicDir: process.env.TOKMETER_APP_BUILD === "1" ? false : "public",
  plugins: [react(), tokmeterSummaryDevPlugin(), appNoticesPlugin()],
  resolve: {
    alias: {
      "@sriinnu/tokmeter-core": resolve(__dirname, "../core/src/index.ts"),
    },
  },
  server: {
    port: 3000,
    host: "127.0.0.1",
    open: process.env.CI ? false : `/?session=${devCapability}`,
  },
  preview: {
    host: "127.0.0.1",
    open: process.env.CI ? false : `/?session=${devCapability}`,
  },
});
