/**
 * tokmeter cleanup — Interactive session cleanup with preview and safety.
 *
 * Flow:
 *   1. Scan all records, show project list with multi-select
 *   2. Preview what will be deleted (with partial file warnings)
 *   3. Type DELETE to confirm
 */

import { createInterface } from "node:readline";
import { CleanupService, TokmeterCore, localDateKey } from "@sriinnu/tokmeter";
import type {
  CleanupFilter,
  DailyEntry,
  ProjectSummary,
  ProviderId,
  ScanOptions,
} from "@sriinnu/tokmeter";
import Table from "cli-table3";
import { fmtCost, fmtNum, renderPreview, renderResult } from "./cleanup-render.js";

// ─── Readline helpers ────────────────────────────────────────────────────

// A shared readline plus a line queue handles both TTY and piped stdin
// reliably. Piped stdin can hit EOF between prompts and cause a fresh
// rl.question() to hang — queueing every emitted line avoids that.
let sharedRl: ReturnType<typeof createInterface> | null = null;
let rlClosed = false;
const lineQueue: string[] = [];
const waiters: ((line: string) => void)[] = [];

function ensureRl(): void {
  if (sharedRl) return;
  sharedRl = createInterface({ input: process.stdin, output: process.stdout });
  sharedRl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else lineQueue.push(line);
  });
  sharedRl.on("close", () => {
    rlClosed = true;
    // Unblock any pending waiters with empty input so the caller can treat it as cancel.
    while (waiters.length) {
      const w = waiters.shift();
      if (w) w("");
    }
  });
}

function ask(question: string): Promise<string> {
  ensureRl();
  process.stdout.write(question);
  return new Promise((resolve) => {
    const buffered = lineQueue.shift();
    if (buffered !== undefined) {
      resolve(buffered.trim());
      return;
    }
    if (rlClosed) {
      resolve("");
      return;
    }
    waiters.push((line) => resolve(line.trim()));
  });
}

function closeRl(): void {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
  }
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

  try {
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
  } finally {
    closeRl();
  }
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

// ─── Interactive cleanup (stepper) ───────────────────────────────────────

/**
 * Interactive cleanup wizard.
 *
 * Step 1/3 — Pick project(s) from a table of all known projects.
 * Step 2/3 — (Single project only) narrow to a specific day or contiguous range.
 * Step 3/3 — Preview and type DELETE to confirm.
 */
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

  // ── Step 1 / 3 — Pick project(s) ──────────────────────────────────────
  console.log("  Tokmeter Cleanup");
  console.log(`  ${"─".repeat(60)}`);
  console.log("  Step 1/3  Pick project(s)\n");

  const projectTable = new Table({
    head: ["#", "Project", "Provider(s)", "Tokens", "Cost", "Days", "Last Used"],
    colWidths: [4, 25, 14, 10, 10, 6, 12],
  });

  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const providers = p.providers.map((pr) => pr.provider).join(", ");
    const lastUsed = p.lastUsed ? localDateKey(p.lastUsed) : "—";
    projectTable.push([
      (i + 1).toString(),
      p.project.slice(0, 24),
      providers.slice(0, 13),
      fmtNum(p.totalTokens),
      fmtCost(p.totalCost),
      p.activeDays.toString(),
      lastUsed,
    ]);
  }
  console.log(projectTable.toString());

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

  // ── Step 2 / 3 — Pick dates (only when exactly one project) ───────────
  const filter: CleanupFilter = { projects: selectedProjects.map((proj) => proj.project) };

  if (selectedProjects.length === 1) {
    const projectName = selectedProjects[0].project;
    const daily = core.getDailyBreakdown({ project: projectName });

    if (daily.length === 0) {
      console.log(`  No daily records for ${projectName}. Proceeding with full project cleanup.\n`);
    } else {
      console.log(`\n  Step 2/3  Pick dates for "${projectName}"\n`);
      console.log(renderDailyTableWithIndices(daily));

      const dateAnswer = await ask(
        "\nEnter date selection (blank/'all' = every date, 'N' = single, 'N-M' = range, 'q' = cancel): "
      );

      if (dateAnswer.toLowerCase() === "q") {
        console.log("Cancelled.\n");
        return;
      }

      const dateRange = parseDateSelection(dateAnswer, daily);
      if (dateRange === null) {
        console.log("Invalid date selection. Cancelled.\n");
        return;
      }

      if (dateRange.since) filter.since = dateRange.since;
      if (dateRange.until) filter.until = dateRange.until;

      if (dateRange.since || dateRange.until) {
        const range =
          dateRange.since === dateRange.until
            ? dateRange.since
            : `${dateRange.since ?? "…"} → ${dateRange.until ?? "…"}`;
        console.log(`  Narrowed to: ${range}`);
      } else {
        console.log("  Scope: all dates");
      }
    }
  } else {
    console.log(`  Skipping date picker (${selectedProjects.length} projects selected).`);
  }

  // ── Step 3 / 3 — Preview + confirm + execute ──────────────────────────
  console.log("\n  Step 3/3  Confirm\n");
  const preview = await service.preview(filter);

  if (preview.recordCount === 0) {
    console.log("  No records match the selection. Nothing to clean up.\n");
    return;
  }

  renderPreview(preview);

  if (!args.force) {
    const confirm = await ask("\n⚠  Type DELETE to confirm: ");
    if (confirm !== "DELETE") {
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

// ─── Date-picker helpers (Step 2) ────────────────────────────────────────

/**
 * Render a numbered table of daily entries for the date-picker step.
 */
function renderDailyTableWithIndices(daily: DailyEntry[]): string {
  const table = new Table({
    head: ["#", "Date", "Records", "Tokens", "Cost"],
    colWidths: [5, 14, 10, 10, 10],
  });
  for (let i = 0; i < daily.length; i++) {
    const d = daily[i];
    table.push([
      (i + 1).toString(),
      d.date,
      d.records.toString(),
      fmtNum(d.totalTokens),
      fmtCost(d.cost),
    ]);
  }
  return table.toString();
}

/**
 * Parse user date selection against a DailyEntry list.
 *
 * Accepts:
 *   - "" or "all"  → every date (returns {}).
 *   - "N"          → single day → since=until=daily[N-1].date.
 *   - "N-M"        → contiguous range (order-insensitive).
 *
 * Returns null on invalid input.
 */
function parseDateSelection(
  input: string,
  daily: DailyEntry[]
): { since?: string; until?: string } | null {
  const raw = input.trim();
  if (raw === "" || raw.toLowerCase() === "all") return {};

  const rangeMatch = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    const a = Number.parseInt(rangeMatch[1], 10) - 1;
    const b = Number.parseInt(rangeMatch[2], 10) - 1;
    if (a < 0 || b < 0 || a >= daily.length || b >= daily.length) return null;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    // daily is sorted ascending by date — lo index is earliest
    return { since: daily[lo].date, until: daily[hi].date };
  }

  const single = Number.parseInt(raw, 10);
  if (!Number.isNaN(single) && single >= 1 && single <= daily.length) {
    const date = daily[single - 1].date;
    return { since: date, until: date };
  }

  return null;
}
