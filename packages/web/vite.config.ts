import { homedir } from "node:os";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";
import {
  TokmeterCore,
  type TokmeterSummary,
  loadSummaryCache,
  saveSummaryCache,
} from "../core/src/index.ts";

const DEV_SUMMARY_TTL_MS = 15_000;
const SUMMARY_SOURCE_HEADER = "X-Tokmeter-Summary-Source";

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

  return {
    name: "tokmeter-summary-dev-plugin",
    configurePreviewServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0];
        if (req.method !== "GET" || url !== "/api/summary") {
          next();
          return;
        }

        try {
          const { summary, source } = await getSummary();
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.setHeader(SUMMARY_SOURCE_HEADER, source);
          res.end(JSON.stringify(summary));
        } catch (error) {
          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: `Tokmeter dev summary unavailable: ${toErrorMessage(error)}`,
            })
          );
        }
      });
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0];
        if (req.method !== "GET" || url !== "/api/summary") {
          next();
          return;
        }

        try {
          const { summary, source } = await getSummary();
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.setHeader(SUMMARY_SOURCE_HEADER, source);
          res.end(JSON.stringify(summary));
        } catch (error) {
          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: `Tokmeter dev summary unavailable: ${toErrorMessage(error)}`,
            })
          );
        }
      });
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
  plugins: [react(), tokmeterSummaryDevPlugin()],
  resolve: {
    alias: {
      "@sriinnu/tokmeter-core": resolve(__dirname, "../core/src/index.ts"),
    },
  },
  server: {
    port: 3000,
  },
});
