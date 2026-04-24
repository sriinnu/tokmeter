/**
 * tokmeter snapshot — Create a portable backup of session data WITHOUT
 * deleting anything. Use it to carry work across machines: snapshot on
 * machine A, copy the resulting `.tar.gz` + `.meta.json`, restore on
 * machine B.
 */

import { CleanupService, TokmeterCore } from "@sriinnu/tokmeter";
import type { CleanupFilter, ProviderId } from "@sriinnu/tokmeter";

export interface SnapshotArgs {
  project?: string;
  providers?: ProviderId[];
  since?: string;
  until?: string;
  today?: boolean;
  week?: boolean;
  month?: boolean;
  json?: boolean;
  light?: boolean;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)}GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/**
 * Run a non-destructive snapshot. Writes to the same backups/ dir the
 * `restore` command already reads from.
 */
export async function runSnapshot(args: SnapshotArgs): Promise<void> {
  const core = new TokmeterCore({ skipPricing: args.light });
  const service = new CleanupService(core);

  const filter: CleanupFilter = {
    project: args.project,
    providers: args.providers,
    since: args.since,
    until: args.until,
    today: args.today,
    week: args.week,
    month: args.month,
  };

  console.log("\n📦 Snapshotting session data (no deletion)...\n");
  const result = await service.snapshot(filter);

  if (!result.archivePath) {
    console.log("No records match the filter. Nothing to snapshot.\n");
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Read size off the archive for a friendly display.
  let size = 0;
  try {
    const { statSync } = await import("node:fs");
    size = statSync(result.archivePath).size;
  } catch {}

  console.log(`  ✓ Archive:   ${result.archivePath}`);
  console.log(`  ✓ Records:   ${result.recordCount}`);
  console.log(`  ✓ Targets:   ${result.targetCount}`);
  if (size > 0) console.log(`  ✓ Size:      ${fmtBytes(size)}`);
  console.log(`  ✓ Meta:      ${result.archivePath.replace(/\.tar\.gz$/, ".meta.json")}`);
  console.log("\n  Copy both files to another machine and run 'tokmeter restore --id <id>'.\n");
}
