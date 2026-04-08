/**
 * @sriinnu/tokmeter-core — CleanupService.
 *
 * Orchestrates preview, backup, execute, and restore for session cleanup.
 * Does NOT modify TokmeterCore (keeps it read-only). Accepts a core instance.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  filterByDate,
  filterByProject,
  filterByProvider,
} from "./aggregator.js";
import { getCleaners } from "./cleaners/index.js";
import { clearRecordCache, invalidateRecordCache } from "./parsers/utils.js";
import type { TokmeterCore } from "./tokmeter-core.js";
import type {
  BackupInfo,
  CleanupFilter,
  CleanupOptions,
  CleanupPreview,
  CleanupResult,
  CleanupTarget,
  PartialFileWarning,
  ProviderId,
  RestoreResult,
  TokenRecord,
} from "./types.js";

const DEFAULT_BACKUP_DIR = join(
  process.env.HOME || homedir(),
  ".cache",
  "tokmeter",
  "backups",
);

export class CleanupService {
  private core: TokmeterCore;
  private homeDir: string;

  constructor(core: TokmeterCore, homeDir?: string) {
    this.core = core;
    this.homeDir = homeDir || homedir();
  }

  /**
   * Preview what would be deleted. Scans all records, applies filters,
   * resolves filesystem targets, and detects partial file collateral.
   */
  async preview(filter: CleanupFilter): Promise<CleanupPreview> {
    // 1. Scan ALL records (no filters) to detect partial files
    const allRecords = await this.core.scan();

    // 2. Apply cleanup filter to get matched records
    const matchedRecords = this.applyFilter(allRecords, filter);

    if (matchedRecords.length === 0) {
      return {
        recordCount: 0,
        sourceFileCount: 0,
        targets: [],
        totalBytes: 0,
        byProvider: [],
        byProject: [],
        partialFileWarnings: [],
      };
    }

    // 3. Group matched records by sourceFile
    const sourceFilesByProvider = new Map<ProviderId, Set<string>>();
    for (const r of matchedRecords) {
      if (!r.sourceFile) continue;
      const files = sourceFilesByProvider.get(r.provider) || new Set();
      files.add(r.sourceFile);
      sourceFilesByProvider.set(r.provider, files);
    }

    // 4. Resolve targets via cleaners
    const allTargets: CleanupTarget[] = [];
    const cleaners = getCleaners(filter.providers);

    for (const cleaner of cleaners) {
      const files = sourceFilesByProvider.get(cleaner.providerId);
      if (!files || files.size === 0) continue;
      const targets = await cleaner.resolveTargets([...files], this.homeDir);
      allTargets.push(...targets);
    }

    // 5. Detect partial files (transparency)
    const partialFileWarnings = this.detectPartialFiles(
      matchedRecords,
      allRecords,
    );

    // 6. Build breakdowns
    const byProvider = this.buildProviderBreakdown(matchedRecords, allTargets);
    const byProject = this.buildProjectBreakdown(matchedRecords);

    const totalBytes = allTargets.reduce((s, t) => s + t.sizeBytes, 0);
    const sourceFileCount = new Set(
      matchedRecords.map((r) => r.sourceFile).filter(Boolean),
    ).size;

    return {
      recordCount: matchedRecords.length,
      sourceFileCount,
      targets: allTargets,
      totalBytes,
      byProvider,
      byProject,
      partialFileWarnings,
    };
  }

  /**
   * Execute cleanup: optionally backup, then delete, then invalidate cache.
   */
  async execute(
    filter: CleanupFilter,
    options: CleanupOptions = {},
  ): Promise<CleanupResult> {
    const { dryRun = false, backup = true, backupDir } = options;

    // Preview first
    const preview = await this.preview(filter);

    if (preview.targets.length === 0) {
      return {
        deletedCount: 0,
        failedCount: 0,
        errors: [],
        bytesFreed: 0,
      };
    }

    // Dry run — return preview as a result without deleting
    if (dryRun) {
      return {
        deletedCount: 0,
        failedCount: 0,
        errors: [],
        bytesFreed: 0,
      };
    }

    // Backup — if requested and fails, abort deletion for safety
    let backupPath: string | undefined;
    if (backup) {
      const projectNames = preview.byProject.map((p) => p.project);
      const path = this.createBackup(preview.targets, filter, backupDir, projectNames);
      if (!path) {
        return {
          deletedCount: 0,
          failedCount: 1,
          errors: [{ target: "backup", error: "Backup creation failed — deletion aborted for safety" }],
          bytesFreed: 0,
        };
      }
      backupPath = path;
    }

    // Execute deletion per provider
    const cleaners = getCleaners(filter.providers);
    let totalDeleted = 0;
    let totalBytes = 0;
    const allErrors: { target: string; error: string }[] = [];

    for (const cleaner of cleaners) {
      const providerTargets = preview.targets.filter(
        (t) => t.provider === cleaner.providerId,
      );
      if (providerTargets.length === 0) continue;

      const result = await cleaner.executeCleanup(providerTargets);
      totalDeleted += result.deletedCount;
      totalBytes += result.bytesFreed;
      allErrors.push(...result.errors);
    }

    // Invalidate scan cache for deleted files
    const deletedPaths = preview.targets
      .filter((t) => t.type === "file" || t.type === "directory")
      .map((t) => t.path);
    invalidateRecordCache(deletedPaths);

    return {
      deletedCount: totalDeleted,
      failedCount: allErrors.length,
      errors: allErrors,
      bytesFreed: totalBytes,
      backupPath,
    };
  }

  /** List available backups. */
  listBackups(backupDir?: string): BackupInfo[] {
    const dir = backupDir || DEFAULT_BACKUP_DIR;
    if (!existsSync(dir)) return [];

    const entries = readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
    const backups: BackupInfo[] = [];

    for (const entry of entries) {
      try {
        const raw = readFileSync(join(dir, entry), "utf-8");
        backups.push(JSON.parse(raw) as BackupInfo);
      } catch {
        // Skip malformed metadata
      }
    }

    return backups.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  /** Restore from a backup archive. */
  restore(backupId: string, backupDir?: string): RestoreResult {
    // Sanitize backupId — only allow timestamp-like patterns
    if (!/^[\d\-T]+$/.test(backupId)) {
      return { restoredCount: 0, errors: [{ file: backupId, error: "Invalid backup ID format" }] };
    }

    const dir = backupDir || DEFAULT_BACKUP_DIR;
    const metaPath = join(dir, `${backupId}.meta.json`);

    if (!existsSync(metaPath)) {
      return { restoredCount: 0, errors: [{ file: metaPath, error: "Backup not found" }] };
    }

    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as BackupInfo;
    const archivePath = meta.path;

    // Validate archive path is within backup directory
    if (!archivePath.startsWith(dir)) {
      return { restoredCount: 0, errors: [{ file: archivePath, error: "Archive path outside backup directory" }] };
    }

    if (!existsSync(archivePath)) {
      return { restoredCount: 0, errors: [{ file: archivePath, error: "Archive file missing" }] };
    }

    try {
      // Validate archive contents — reject if any entry contains ".." (path traversal)
      const listing = execFileSync("tar", ["tzf", archivePath], {
        timeout: 30_000,
      }).toString();
      const hasTraversal = listing.split("\n").some((entry) => entry.includes(".."));
      if (hasTraversal) {
        return {
          restoredCount: 0,
          errors: [{ file: archivePath, error: "Archive contains path traversal entries — refusing to extract" }],
        };
      }

      // --no-absolute-names strips leading / from archive entries
      execFileSync("tar", ["xzf", archivePath, "--no-absolute-names", "-C", "/"], {
        timeout: 60_000,
      });

      // Clear entire cache after restore so next scan picks up restored files
      clearRecordCache();

      return { restoredCount: meta.recordCount, errors: [] };
    } catch (err) {
      return {
        restoredCount: 0,
        errors: [
          {
            file: archivePath,
            error: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  private applyFilter(
    records: TokenRecord[],
    filter: CleanupFilter,
  ): TokenRecord[] {
    let result = records;

    if (filter.providers && filter.providers.length > 0) {
      result = filterByProvider(result, filter.providers);
    }
    if (filter.project) {
      result = filterByProject(result, filter.project);
    }
    if (filter.since || filter.until || filter.today || filter.week || filter.month) {
      result = filterByDate(result, filter);
    }

    return result;
  }

  /**
   * Detect source files where some records match the filter but others don't.
   * These files will be fully deleted, causing collateral data loss — user must be warned.
   */
  private detectPartialFiles(
    matchedRecords: TokenRecord[],
    allRecords: TokenRecord[],
  ): PartialFileWarning[] {
    // Build set of source files from matched records
    const matchedFiles = new Set<string>();
    const matchedCountByFile = new Map<string, number>();

    for (const r of matchedRecords) {
      if (!r.sourceFile) continue;
      matchedFiles.add(r.sourceFile);
      matchedCountByFile.set(
        r.sourceFile,
        (matchedCountByFile.get(r.sourceFile) || 0) + 1,
      );
    }

    // Check all records for source files that also have unmatched records
    const otherByFile = new Map<
      string,
      { count: number; minTs: number; maxTs: number }
    >();

    for (const r of allRecords) {
      if (!r.sourceFile || !matchedFiles.has(r.sourceFile)) continue;

      // Is this record NOT in the matched set? Check by reference won't work,
      // so check if it's NOT matched by seeing if the file has more total records than matched
      // We'll count total per file and compare
      const other = otherByFile.get(r.sourceFile) || {
        count: 0,
        minTs: Number.POSITIVE_INFINITY,
        maxTs: Number.NEGATIVE_INFINITY,
      };
      other.count++;
      if (r.timestamp < other.minTs) other.minTs = r.timestamp;
      if (r.timestamp > other.maxTs) other.maxTs = r.timestamp;
      otherByFile.set(r.sourceFile, other);
    }

    const warnings: PartialFileWarning[] = [];

    for (const [file, total] of otherByFile) {
      const matched = matchedCountByFile.get(file) || 0;
      const otherCount = total.count - matched;

      if (otherCount > 0) {
        const minDate = new Date(total.minTs).toISOString().slice(0, 10);
        const maxDate = new Date(total.maxTs).toISOString().slice(0, 10);

        warnings.push({
          file,
          matchedRecords: matched,
          otherRecords: otherCount,
          otherDateRange: minDate === maxDate ? minDate : `${minDate} to ${maxDate}`,
        });
      }
    }

    return warnings;
  }

  private buildProviderBreakdown(
    records: TokenRecord[],
    targets: CleanupTarget[],
  ): CleanupPreview["byProvider"] {
    const map = new Map<
      ProviderId,
      { targets: number; bytes: number; records: number }
    >();

    for (const r of records) {
      const entry = map.get(r.provider) || { targets: 0, bytes: 0, records: 0 };
      entry.records++;
      map.set(r.provider, entry);
    }

    for (const t of targets) {
      const entry = map.get(t.provider) || { targets: 0, bytes: 0, records: 0 };
      entry.targets++;
      entry.bytes += t.sizeBytes;
      map.set(t.provider, entry);
    }

    return [...map.entries()].map(([provider, data]) => ({
      provider,
      ...data,
    }));
  }

  private buildProjectBreakdown(
    records: TokenRecord[],
  ): CleanupPreview["byProject"] {
    const map = new Map<
      string,
      { records: number; cost: number; tokens: number }
    >();

    for (const r of records) {
      const entry = map.get(r.project) || { records: 0, cost: 0, tokens: 0 };
      entry.records++;
      entry.cost += r.cost;
      entry.tokens +=
        r.inputTokens +
        r.outputTokens +
        r.cacheReadTokens +
        r.cacheWriteTokens +
        r.reasoningTokens;
      map.set(r.project, entry);
    }

    return [...map.entries()]
      .map(([project, data]) => ({ project, ...data }))
      .sort((a, b) => b.cost - a.cost);
  }

  /**
   * Create a tar.gz backup of all file/directory targets.
   * Writes both the archive and a .meta.json sidecar.
   */
  private createBackup(
    targets: CleanupTarget[],
    filter: CleanupFilter,
    backupDir?: string,
    projectNames: string[] = [],
  ): string {
    const dir = backupDir || DEFAULT_BACKUP_DIR;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const id = timestamp;
    const archivePath = join(dir, `${id}.tar.gz`);

    // Collect file paths to archive (skip sqlite-rows and index-entry)
    const filePaths = targets
      .filter((t) => t.type === "file" || t.type === "directory")
      .map((t) => t.path)
      .filter((p) => existsSync(p));

    if (filePaths.length > 0) {
      try {
        execFileSync("tar", ["czf", archivePath, "--no-absolute-names", ...filePaths], {
          timeout: 120_000,
        });
      } catch {
        // If tar fails, abort — don't delete without a backup
        return "";
      }
    } else {
      // No archivable files (all targets are sqlite-rows / index-entry) — skip backup
      return "";
    }

    // Write metadata sidecar
    const meta: BackupInfo = {
      id,
      path: archivePath,
      createdAt: new Date().toISOString(),
      sizeBytes: existsSync(archivePath) ? statSync(archivePath).size : 0,
      filter,
      recordCount: targets.reduce(
        (s, t) => s + (t.sqlDetail?.rowCount || (t.type === "file" ? 1 : 0)),
        0,
      ),
      providers: [...new Set(targets.map((t) => t.provider))],
      projects: projectNames,
    };

    writeFileSync(
      join(dir, `${id}.meta.json`),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf-8",
    );

    return archivePath;
  }
}
