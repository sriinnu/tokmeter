/**
 * tokmeter cleanup — Interactive session cleanup with preview and safety.
 *
 * Flow:
 *   1. Scan all records, show project list with multi-select
 *   2. Preview what will be deleted (with partial file warnings)
 *   3. Type DELETE to confirm
 */

import { createInterface } from "node:readline";
import { CleanupService, TokmeterCore } from "@sriinnu/tokmeter";
import type {
  CleanupFilter,
  CleanupPreview,
  ProjectSummary,
  ProviderId,
  ScanOptions,
} from "@sriinnu/tokmeter";
import Table from "cli-table3";

// ─── Formatters ──────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)}GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function shortPath(filePath: string, segmentCount = 2): string {
  return filePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .slice(-segmentCount)
    .join("/");
}

// ─── Readline helpers ────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Cleanup CLI Args ────────────────────────────────────────────────────

export interface CleanupArgs {
  project?: string;
  providers?: ProviderId[];
  since?: string;
  until?: string;
  today?: boolean;
  week?: boolean;
  month?: boolean;
  dryRun?: boolean;
  backup?: boolean;
  force?: boolean;
  json?: boolean;
  light?: boolean;
  scanOptions?: ScanOptions;
}

// ─── Main ────────────────────────────────────────────────────────────────

/**
 * Run the interactive or flag-driven cleanup workflow.
 */
export async function runCleanup(args: CleanupArgs): Promise<void> {
  const core = new TokmeterCore({ skipPricing: args.light });
  const service = new CleanupService(core);

  // If specific filters provided via flags, go direct (scripting mode)
  if (
    args.project ||
    args.providers?.length ||
    args.since ||
    args.until ||
    args.today ||
    args.week ||
    args.month
  ) {
    await runFilteredCleanup(service, core, args);
    return;
  }

  // Interactive mode: show projects, let user select
  await runInteractiveCleanup(service, core, args);
}

// ─── Filtered (flags-based) cleanup ──────────────────────────────────────

async function runFilteredCleanup(
  service: CleanupService,
  _core: TokmeterCore,
  args: CleanupArgs
): Promise<void> {
  const filter: CleanupFilter = {
    project: args.project,
    providers: args.providers,
    since: args.since,
    until: args.until,
    today: args.today,
    week: args.week,
    month: args.month,
  };

  console.log("\n🔍 Scanning session data...\n");
  const preview = await service.preview(filter);

  if (preview.recordCount === 0) {
    console.log("No records match the filter. Nothing to clean up.\n");
    return;
  }

  renderPreview(preview);

  if (args.json) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  if (args.dryRun) {
    console.log("📋 Dry run — no files were deleted.\n");
    return;
  }

  if (!args.force) {
    const answer = await ask("\n⚠  Type DELETE to confirm: ");
    if (answer !== "DELETE") {
      console.log("Cancelled.\n");
      return;
    }
  }

  console.log("\n🗑  Executing cleanup...\n");
  const result = await service.execute(filter, {
    backup: args.backup ?? true,
  });

  renderResult(result);
}

// ─── Interactive cleanup ─────────────────────────────────────────────────

async function runInteractiveCleanup(
  service: CleanupService,
  core: TokmeterCore,
  args: CleanupArgs
): Promise<void> {
  console.log("\n🔍 Scanning all session data...\n");
  await core.scan();

  const projects = core.getAllProjects();
  if (projects.length === 0) {
    console.log("No projects found. Nothing to clean up.\n");
    return;
  }

  // Show project list
  console.log("  Tokmeter Cleanup");
  console.log(`  ${"─".repeat(60)}`);

  const table = new Table({
    head: ["#", "Project", "Provider(s)", "Tokens", "Cost", "Days", "Last Used"],
    colWidths: [4, 25, 14, 10, 10, 6, 12],
  });

  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const providers = p.providers.map((pr) => pr.provider).join(", ");
    const lastUsed = p.lastUsed ? new Date(p.lastUsed).toISOString().slice(0, 10) : "—";
    table.push([
      (i + 1).toString(),
      p.project.slice(0, 24),
      providers.slice(0, 13),
      fmtNum(p.totalTokens),
      fmtCost(p.totalCost),
      p.activeDays.toString(),
      lastUsed,
    ]);
  }
  console.log(table.toString());

  // Ask which projects to clean
  const answer = await ask("\nEnter project numbers to delete (comma-separated, or 'all'): ");

  if (!answer || answer.toLowerCase() === "q") {
    console.log("Cancelled.\n");
    return;
  }

  let selectedProjects: ProjectSummary[];
  if (answer.toLowerCase() === "all") {
    selectedProjects = projects;
  } else {
    const indices = [
      ...new Set(
        answer
          .split(",")
          .map((s) => Number.parseInt(s.trim(), 10) - 1)
          .filter((i) => i >= 0 && i < projects.length)
      ),
    ];

    if (indices.length === 0) {
      console.log("No valid selections. Cancelled.\n");
      return;
    }
    selectedProjects = indices.map((i) => projects[i]);
  }

  console.log(`\nSelected: ${selectedProjects.map((p) => p.project).join(", ")}`);

  const filter: CleanupFilter = { projects: selectedProjects.map((proj) => proj.project) };
  const preview = await service.preview(filter);
  renderPreview(preview);

  // Confirm
  if (!args.force) {
    const confirm = await ask("\n⚠  Type DELETE to confirm: ");
    if (confirm !== "DELETE") {
      console.log("Cancelled.\n");
      return;
    }
  }

  // Execute
  console.log("\n🗑  Executing cleanup...\n");
  const result = await service.execute(filter, {
    backup: args.backup ?? true,
  });
  renderResult(result);
}

// ─── Renderers ───────────────────────────────────────────────────────────

function renderPreview(preview: CleanupPreview): void {
  console.log("  Cleanup Preview");
  console.log(`  ${"─".repeat(60)}`);

  // Provider breakdown
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

  // Project breakdown
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

  // Totals
  console.log(
    `  Total: ${preview.sourceFileCount} source files, ${preview.targets.length} targets, ${fmtBytes(preview.totalBytes)}`
  );

  // Partial file warnings (TRANSPARENCY)
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

function renderResult(result: {
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
