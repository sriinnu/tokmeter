/**
 * tokmeter restore — Restore from cleanup backups.
 */

import { createInterface } from "node:readline";
import { CleanupService, TokmeterCore } from "@sriinnu/tokmeter-core";
import Table from "cli-table3";

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export interface RestoreArgs {
  id?: string;
  latest?: boolean;
  json?: boolean;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${bytes}B`;
}

export async function runRestore(args: RestoreArgs): Promise<void> {
  const core = new TokmeterCore({ skipPricing: true });
  const service = new CleanupService(core);

  const backups = service.listBackups();

  if (backups.length === 0) {
    console.log("\nNo backups found in ~/.cache/tokmeter/backups/\n");
    return;
  }

  // List mode (no --id or --latest)
  if (!args.id && !args.latest) {
    if (args.json) {
      console.log(JSON.stringify(backups, null, 2));
      return;
    }

    console.log("\n📦 Available Backups\n");
    const table = new Table({
      head: ["ID", "Created", "Size", "Records", "Providers", "Projects"],
      colWidths: [22, 22, 10, 10, 16, 25],
    });

    for (const b of backups) {
      table.push([
        b.id,
        new Date(b.createdAt).toLocaleString(),
        fmtBytes(b.sizeBytes),
        b.recordCount.toString(),
        b.providers.join(", "),
        b.projects.slice(0, 2).join(", ") + (b.projects.length > 2 ? "..." : ""),
      ]);
    }
    console.log(table.toString());
    console.log(`\nUsage: tokmeter restore --id <ID>  or  tokmeter restore --latest\n`);
    return;
  }

  // Resolve which backup to restore
  const backup = args.latest ? backups[0] : backups.find((b) => b.id === args.id);

  if (!backup) {
    console.log(`\nBackup not found: ${args.id || "(latest)"}\n`);
    return;
  }

  console.log(`\n📦 Restoring backup: ${backup.id}`);
  console.log(`   Created: ${new Date(backup.createdAt).toLocaleString()}`);
  console.log(`   Size: ${fmtBytes(backup.sizeBytes)}`);
  console.log(`   Providers: ${backup.providers.join(", ")}`);

  const confirm = await ask("\n⚠  This will overwrite current data. Type RESTORE to confirm: ");
  if (confirm !== "RESTORE") {
    console.log("Cancelled.\n");
    return;
  }

  const result = service.restore(backup.id);

  if (result.errors.length > 0) {
    console.log(`\n✗ Restore failed:`);
    for (const e of result.errors) {
      console.log(`   ${e.file}: ${e.error}`);
    }
  } else {
    console.log(`\n✓ Restored ${result.restoredCount} items.`);
    console.log(`  Run 'tokmeter' to verify data is back.\n`);
  }
}
