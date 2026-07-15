import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TokmeterCore,
  type TokmeterSummary,
  loadSummaryCache,
  saveSummaryCache,
} from "../../core/src/index.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(scriptDir, "..", "public");
const publicDataPath = join(publicDir, "data.json");

const DAEMON_SUMMARY_URL = "http://127.0.0.1:9877/api/summary";
const DAEMON_FETCH_TIMEOUT_MS = 3_000;

/** Local calendar date key, matching core's localDateKey convention. */
function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Ensures the web package always has a fallback `public/data.json` summary.
 *
 * Source order: the warm daemon (always fresh, zero scan cost) → the persisted
 * summary cache ONLY if it was scanned today → a fresh scan. The cache used to
 * be trusted unconditionally, which baked days-old data into a static build
 * that the dashboard then polled every 15s as if it were live.
 */
async function main(): Promise<void> {
  const homeDir = homedir();
  const existingFile = existsSync(publicDataPath);

  // The freshness gate applies to BOTH shortcut sources: the daemon's
  // /api/summary itself falls back to a persisted cache when its scan throws
  // (it answers 200 either way), so a daemon response is not inherently
  // fresh — an ungated fetch would bake days-old data right back into the
  // static build.
  const scannedToday = (s: TokmeterSummary | null): s is TokmeterSummary =>
    s !== null && localDateKey(s.meta?.lastScanAt ?? 0) === localDateKey(Date.now());

  let summary = await fetchDaemonSummary();
  if (!scannedToday(summary)) summary = null;

  if (!summary) {
    const cached = loadSummaryCache(homeDir);
    if (scannedToday(cached.summary)) {
      summary = cached.summary;
    }
  }

  if (!summary) {
    try {
      const core = new TokmeterCore();
      await core.scan();
      summary = core.getSummary();
      saveSummaryCache(homeDir, summary);
    } catch (error) {
      if (existingFile) {
        console.warn(
          `Tokmeter ensure-summary warning: keeping existing public/data.json (${toErrorMessage(error)})`
        );
        return;
      }

      throw error;
    }
  }

  mkdirSync(publicDir, { recursive: true });
  writeFileSync(publicDataPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
}

async function fetchDaemonSummary(): Promise<TokmeterSummary | null> {
  try {
    const res = await fetch(DAEMON_SUMMARY_URL, {
      signal: AbortSignal.timeout(DAEMON_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as TokmeterSummary;
  } catch {
    return null; // daemon offline — fall back to cache/scan
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error) => {
  console.error(`Tokmeter ensure-summary failed: ${toErrorMessage(error)}`);
  process.exitCode = 1;
});
