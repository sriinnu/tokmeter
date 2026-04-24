/**
 * Rendering helpers for the tokmeter cleanup CLI.
 *
 * Kept separate from cleanup.ts so the interactive flow file stays under the
 * 450-LOC guardrail; these are pure, no I/O beyond console.log.
 */

import type { CleanupPreview } from "@sriinnu/tokmeter";
import Table from "cli-table3";

// ─── Formatters ──────────────────────────────────────────────────────────

/** Human-readable compact number: 1.2K / 3.4M. */
export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

/** Dollar-prefixed cost with 2 decimals. */
export function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Human-readable byte size: GB/MB/KB/B. */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)}GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** Trim a path to the trailing N segments for log readability. */
export function shortPath(filePath: string, segmentCount = 2): string {
  return filePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .slice(-segmentCount)
    .join("/");
}

// ─── Renderers ───────────────────────────────────────────────────────────

/**
 * Print the cleanup preview — provider/project breakdown tables, totals,
 * and any partial-file warnings.
 */
export function renderPreview(preview: CleanupPreview): void {
  console.log("  Cleanup Preview");
  console.log(`  ${"─".repeat(60)}`);

  if (preview.byProvider.length > 0) {
    const table = new Table({
      head: ["Provider", "Targets", "Size", "Records"],
      colWidths: [16, 10, 10, 10],
    });
    for (const p of preview.byProvider) {
      table.push([p.provider, p.targets.toString(), fmtBytes(p.bytes), p.records.toString()]);
    }
    console.log(table.toString());
  }

  if (preview.byProject.length > 0) {
    const table = new Table({
      head: ["Project", "Records", "Tokens", "Cost"],
      colWidths: [25, 10, 12, 10],
    });
    for (const p of preview.byProject) {
      table.push([p.project.slice(0, 24), p.records.toString(), fmtNum(p.tokens), fmtCost(p.cost)]);
    }
    console.log(table.toString());
  }

  console.log(
    `  Total: ${preview.sourceFileCount} source files, ${preview.targets.length} targets, ${fmtBytes(preview.totalBytes)}`
  );

  if (preview.partialFileWarnings.length > 0) {
    console.log("\n  ⚠  PARTIAL FILE WARNINGS:");
    for (const w of preview.partialFileWarnings) {
      const shortFile = shortPath(w.file);
      console.log(
        `     ${shortFile}: ${w.matchedRecords} matched, BUT ${w.otherRecords} other records (${w.otherDateRange}) will also be deleted`
      );
    }
  }
}

/** Print the result summary after a cleanup execution. */
export function renderResult(result: {
  deletedCount: number;
  failedCount: number;
  bytesFreed: number;
  backupPath?: string;
  errors: { target: string; error: string }[];
}): void {
  console.log(`  ✓ Deleted: ${result.deletedCount} targets, freed ${fmtBytes(result.bytesFreed)}`);

  if (result.backupPath) {
    console.log(`  📦 Backup: ${result.backupPath}`);
  }

  if (result.failedCount > 0) {
    console.log(`  ✗ Failed: ${result.failedCount}`);
    for (const e of result.errors.slice(0, 5)) {
      console.log(`     ${e.target}: ${e.error}`);
    }
    if (result.errors.length > 5) {
      console.log(`     ... and ${result.errors.length - 5} more`);
    }
  }

  console.log();
}
