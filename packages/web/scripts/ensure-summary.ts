import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TokmeterCore, loadSummaryCache, saveSummaryCache } from "../../core/src/index.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(scriptDir, "..", "public");
const publicDataPath = join(publicDir, "data.json");

/**
 * Ensures the web package always has a fallback `public/data.json` summary.
 * Uses the persisted summary cache when possible and builds it if missing.
 */
async function main(): Promise<void> {
  const homeDir = homedir();
  const existingFile = existsSync(publicDataPath);
  const cached = loadSummaryCache(homeDir);

  let summary = cached.summary;

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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error) => {
  console.error(`Tokmeter ensure-summary failed: ${toErrorMessage(error)}`);
  process.exitCode = 1;
});
