/**
 * @sriinnu/tokmeter-core — CleanupService.
 *
 * Orchestrates preview, backup, execute, and restore for session cleanup.
 * Does NOT modify TokmeterCore (keeps it read-only). Accepts a core instance.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { type AliasMap, loadAliases, saveAliases } from "./alias-service.js";
import {
  type UserConfig,
  configFilePath,
  loadConfig,
  mergeConfigs,
  saveConfig,
} from "./config-service.js";
import { filterByDate, filterByProject, filterByProvider } from "./aggregator.js";
import { getCleaners } from "./cleaners/index.js";
import { invalidateHistorySnapshot } from "./history-snapshot.js";
import { clearRecordCache, invalidateRecordCache } from "./parsers/utils.js";
import { projectMatchKey } from "./project-name.js";
import { invalidateSummaryCache } from "./summary-cache.js";
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

const DEFAULT_BACKUP_DIR = join(process.env.HOME || homedir(), ".cache", "tokmeter", "backups");

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
    const partialFileWarnings = this.detectPartialFiles(matchedRecords, allRecords);

    // 6. Build breakdowns
    const byProvider = this.buildProviderBreakdown(matchedRecords, allTargets);
    const byProject = this.buildProjectBreakdown(matchedRecords);

    const totalBytes = allTargets.reduce((s, t) => s + t.sizeBytes, 0);
    const sourceFileCount = new Set(matchedRecords.map((r) => r.sourceFile).filter(Boolean)).size;

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
  async execute(filter: CleanupFilter, options: CleanupOptions = {}): Promise<CleanupResult> {
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
      const path = await this.createBackup(preview.targets, filter, backupDir, projectNames);
      if (!path) {
        return {
          deletedCount: 0,
          failedCount: 1,
          errors: [
            { target: "backup", error: "Backup creation failed — deletion aborted for safety" },
          ],
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
      const providerTargets = preview.targets.filter((t) => t.provider === cleaner.providerId);
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
    invalidateHistorySnapshot(this.homeDir);
    invalidateSummaryCache(this.homeDir);

    return {
      deletedCount: totalDeleted,
      failedCount: allErrors.length,
      errors: allErrors,
      bytesFreed: totalBytes,
      backupPath,
    };
  }

  /**
   * Snapshot current session data into a backup archive without deleting
   * anything. Useful for portable snapshots — run on machine A, restore on
   * machine B to merge the data in.
   *
   * Uses the same tar.gz + meta.json format as `execute`, so `listBackups`
   * and `restore` work against snapshots identically.
   */
  async snapshot(
    filter: CleanupFilter = {},
    options: { backupDir?: string } = {}
  ): Promise<{ archivePath: string; recordCount: number; targetCount: number }> {
    const preview = await this.preview(filter);
    if (preview.targets.length === 0) {
      return { archivePath: "", recordCount: 0, targetCount: 0 };
    }
    const projectNames = preview.byProject.map((p) => p.project);
    const archivePath = await this.createBackup(
      preview.targets,
      filter,
      options.backupDir,
      projectNames
    );
    return {
      archivePath,
      recordCount: preview.recordCount,
      targetCount: preview.targets.length,
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
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
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

    // Validate archive path is within backup directory (resolve to catch symlinks / ..)
    if (!resolve(archivePath).startsWith(resolve(dir))) {
      return {
        restoredCount: 0,
        errors: [{ file: archivePath, error: "Archive path outside backup directory" }],
      };
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
          errors: [
            {
              file: archivePath,
              error: "Archive contains path traversal entries — refusing to extract",
            },
          ],
        };
      }

      // Decide between fast-path (same home) and sandbox-remap (different home).
      // Source home comes from meta when the backup was created by a modern
      // build; otherwise we sniff it from archive entries for legacy compat.
      const currentHome = this.homeDir;
      const sourceHome = meta.sourceHomeDir || sniffSourceHomeFromListing(listing);

      const sameHome = sourceHome && normaliseHome(sourceHome) === normaliseHome(currentHome);

      let renamedCount = 0;

      // Capture the user's current aliases BEFORE the extract so we can
      // merge them back after restore completes. The backup tarball contains
      // a snapshot of `.tokmeter/aliases.json` from backup-creation time; a
      // naive tar-extract would silently clobber any aliases the user has
      // edited since. Merge-on-restore preserves both sides.
      const aliasesBeforeRestore: AliasMap = loadAliases(currentHome);
      const configBeforeRestore: UserConfig = loadConfig(currentHome);

      if (sameHome || !sourceHome) {
        // Same machine (or can't infer) — extract straight to /. This is how
        // restore has always behaved; preserves paths verbatim.
        execFileSync("tar", ["xzf", archivePath, "-C", "/"], {
          timeout: 60_000,
        });
      } else {
        // Cross-home restore: extract into a sandbox, then walk + copy the
        // source home subtree into the current user's home. On path conflicts
        // we mint a fresh UUID for the colliding session so all 7 associated
        // paths (transcript, subagents, file-history, tasks, todos, session-env)
        // rename consistently — preserving both machines' work.
        const sandbox = mkdtempSync(join(tmpdir(), "tokmeter-restore-"));
        try {
          execFileSync("tar", ["xzf", archivePath, "-C", sandbox], {
            timeout: 60_000,
          });

          // Archive entries had their leading "/" stripped; mirror that here.
          const sourceHomeInSandbox = join(sandbox, sourceHome.replace(/^\/+/, ""));

          if (!existsSync(sourceHomeInSandbox)) {
            return {
              restoredCount: 0,
              errors: [
                {
                  file: sourceHome,
                  error: `Archive does not contain source home "${sourceHome}" — cannot remap`,
                },
              ],
            };
          }

          const sandboxFiles = walkFiles(sourceHomeInSandbox);

          // Pass 1: detect UUIDs in paths that would collide on the target.
          // Build a stable old→new map so every associated path renames the same way.
          const uuidMap = new Map<string, string>();
          for (const filePath of sandboxFiles) {
            const rel = relative(sourceHomeInSandbox, filePath);
            const target = join(currentHome, rel);
            if (!existsSync(target)) continue;
            const matches = rel.match(UUID_RE) || [];
            for (const raw of matches) {
              const key = raw.toLowerCase();
              if (!uuidMap.has(key)) uuidMap.set(key, randomUUID());
            }
          }
          renamedCount = uuidMap.size;

          // Pass 2: copy each file, rewriting any mapped UUID in its relative path.
          for (const filePath of sandboxFiles) {
            let rel = relative(sourceHomeInSandbox, filePath);
            if (uuidMap.size > 0) {
              rel = rel.replace(UUID_RE, (m) => uuidMap.get(m.toLowerCase()) || m);
            }
            const target = join(currentHome, rel);
            mkdirSync(dirname(target), { recursive: true });
            copyFileSync(filePath, target);
          }
        } finally {
          // Always clean up the sandbox, even on partial failure.
          try {
            rmSync(sandbox, { recursive: true, force: true });
          } catch {}
        }
      }

      // Merge pre-restore aliases with the just-extracted ones so the user
      // never loses edits they made after the backup was taken. Precedence:
      //   1. `modifiedBy: "user"` wins over `"tokmeter"`.
      //   2. If both have same flag, latest `modifiedAt` wins.
      const aliasesAfterRestore: AliasMap = loadAliases(currentHome);
      const mergedAliases = mergeAliasMaps(aliasesBeforeRestore, aliasesAfterRestore);
      if (Object.keys(mergedAliases).length > 0) {
        saveAliases(mergedAliases, currentHome);
      }

      // Same merge story for config.json — user-flagged edits on this machine
      // survive a restore from a snapshot that carries an older tokmeter default.
      const configAfterRestore: UserConfig = loadConfig(currentHome);
      const mergedConfig = mergeConfigs(configBeforeRestore, configAfterRestore);
      saveConfig(mergedConfig, currentHome);

      // Clear entire cache after restore so next scan picks up restored files
      clearRecordCache();
      invalidateHistorySnapshot(this.homeDir);
      invalidateSummaryCache(this.homeDir);

      return { restoredCount: meta.recordCount, errors: [], renamedCount };
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

  private applyFilter(records: TokenRecord[], filter: CleanupFilter): TokenRecord[] {
    let result = records;

    if (filter.providers && filter.providers.length > 0) {
      result = filterByProvider(result, filter.providers);
    }
    if (filter.projects && filter.projects.length > 0) {
      const selectedProjects = new Set(
        filter.projects.map((project) => projectMatchKey(project, project)).filter(Boolean)
      );

      result = result.filter((record) =>
        selectedProjects.has(projectMatchKey(record.project, record.project))
      );
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
    allRecords: TokenRecord[]
  ): PartialFileWarning[] {
    // Build set of source files from matched records
    const matchedFiles = new Set<string>();
    const matchedCountByFile = new Map<string, number>();

    for (const r of matchedRecords) {
      if (!r.sourceFile) continue;
      matchedFiles.add(r.sourceFile);
      matchedCountByFile.set(r.sourceFile, (matchedCountByFile.get(r.sourceFile) || 0) + 1);
    }

    // Check all records for source files that also have unmatched records
    const otherByFile = new Map<string, { count: number; minTs: number; maxTs: number }>();

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
    targets: CleanupTarget[]
  ): CleanupPreview["byProvider"] {
    const map = new Map<ProviderId, { targets: number; bytes: number; records: number }>();

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

  private buildProjectBreakdown(records: TokenRecord[]): CleanupPreview["byProject"] {
    const map = new Map<string, { records: number; cost: number; tokens: number }>();

    for (const r of records) {
      const entry = map.get(r.project) || { records: 0, cost: 0, tokens: 0 };
      entry.records++;
      entry.cost += r.cost;
      entry.tokens +=
        r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.reasoningTokens;
      map.set(r.project, entry);
    }

    return [...map.entries()]
      .map(([project, data]) => ({ project, ...data }))
      .sort((a, b) => b.cost - a.cost);
  }

  /**
   * Create a tar.gz backup of all targets (files + SQLite row exports).
   * Writes both the archive and a .meta.json sidecar.
   */
  private async createBackup(
    targets: CleanupTarget[],
    filter: CleanupFilter,
    backupDir?: string,
    projectNames: string[] = []
  ): Promise<string> {
    const dir = backupDir || DEFAULT_BACKUP_DIR;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const id = timestamp;
    const archivePath = join(dir, `${id}.tar.gz`);

    // Collect file paths to archive
    const filePaths = targets
      .filter((t) => t.type === "file" || t.type === "directory")
      .map((t) => t.path)
      .filter((p) => existsSync(p));

    // Export SQLite rows to JSON dump files so they're included in the backup
    const sqliteTargets = targets.filter((t) => t.type === "sqlite-rows");
    const sqlDumpDir = join(dir, `${id}-sql-dumps`);
    const sqlDumpFiles: string[] = [];

    if (sqliteTargets.length > 0) {
      const { SqliteCleaner } = await import("./cleaners/sqlite-cleaner.js");
      const cleaners = getCleaners([...new Set(sqliteTargets.map((t) => t.provider))]);

      for (const cleaner of cleaners) {
        if (!(cleaner instanceof SqliteCleaner)) continue;
        for (const t of sqliteTargets.filter((st) => st.provider === cleaner.providerId)) {
          const dumpFile = await cleaner.exportRows(t, sqlDumpDir);
          if (dumpFile) sqlDumpFiles.push(dumpFile);
        }
      }
    }

    // Include the user's alias + config files in every backup so cross-machine
    // restore preserves project renames, merges, tags, hide flags, and all the
    // knobs in config.json. Both are tiny; adding unconditionally is cheaper
    // than a conditional check.
    const aliasPath = join(this.homeDir, ".tokmeter", "aliases.json");
    const configPath = configFilePath(this.homeDir);
    const allPaths = [
      ...filePaths,
      ...sqlDumpFiles,
      ...(existsSync(aliasPath) ? [aliasPath] : []),
      ...(existsSync(configPath) ? [configPath] : []),
    ];

    if (allPaths.length > 0) {
      // Archive with paths relative to root. Running tar from cwd=/ with stripped
      // leading slashes avoids the --no-absolute-names flag, which only newer GNU
      // tar recognizes and BSD tar doesn't have at all. Default behaviour on every
      // tar we care about (GNU, BSD, bsdtar on Windows) strips leading "/" already
      // unless -P is passed — so we just normalise the input to match.
      const relPaths = allPaths.map((p) => p.replace(/^\/+/, ""));
      try {
        execFileSync("tar", ["czf", archivePath, ...relPaths], {
          cwd: "/",
          timeout: 120_000,
        });
      } catch {
        // If tar fails, abort — don't delete without a backup
        return "";
      }

      // Clean up temp SQL dump files (they're now in the archive)
      for (const f of sqlDumpFiles) {
        try {
          rmSync(f);
        } catch {}
      }
      try {
        rmdirSync(sqlDumpDir);
      } catch {}
    } else {
      // Nothing to back up
      return "";
    }

    // Capture source machine context so restore can auto-remap paths when
    // the archive is moved to a machine with a different homedir/username.
    let sourceUser = "";
    try {
      sourceUser = userInfo().username;
    } catch {
      // userInfo can throw on exotic FS; fall back to empty string.
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
        0
      ),
      providers: [...new Set(targets.map((t) => t.provider))],
      projects: projectNames,
      sourceHomeDir: this.homeDir,
      sourceUser,
      sourcePlatform: platform(),
    };

    writeFileSync(join(dir, `${id}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");

    return archivePath;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** UUID v4 (and any 36-char RFC-4122 shape) matcher. Case-insensitive. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Normalise a homedir for comparison — strips trailing slashes so
 * "/home/alice" and "/home/alice/" compare equal.
 */
function normaliseHome(path: string): string {
  return path.replace(/\/+$/, "");
}

/**
 * Merge two alias maps with user-safe precedence so restore never silently
 * drops aliases the user edited after the backup was taken.
 *
 *   - user flag beats tokmeter flag (regardless of timestamp)
 *   - within the same flag class, the newer `modifiedAt` wins
 *   - keys only in one side are kept verbatim
 */
function mergeAliasMaps(a: AliasMap, b: AliasMap): AliasMap {
  const out: AliasMap = { ...a };
  for (const [key, right] of Object.entries(b)) {
    const left = out[key];
    if (!left) {
      out[key] = right;
      continue;
    }
    if (left.modifiedBy === "user" && right.modifiedBy !== "user") continue;
    if (left.modifiedBy !== "user" && right.modifiedBy === "user") {
      out[key] = right;
      continue;
    }
    // Same flag class — newer timestamp wins
    const leftTs = Date.parse(left.modifiedAt) || 0;
    const rightTs = Date.parse(right.modifiedAt) || 0;
    out[key] = rightTs >= leftTs ? right : left;
  }
  return out;
}

/**
 * For legacy backups without sourceHomeDir in meta, infer it from the archive
 * listing by looking for the first entry that starts with a homedir-shaped
 * prefix: "home/<user>/..." (Linux) or "Users/<user>/..." (macOS/WSL/Win).
 *
 * Returns an absolute path (with leading slash) so it can be compared against
 * os.homedir() directly, or an empty string if nothing matches.
 */
function sniffSourceHomeFromListing(listing: string): string {
  for (const raw of listing.split("\n")) {
    const entry = raw.trim();
    if (!entry) continue;
    const match = entry.match(/^(home|Users)\/([^/]+)\//);
    if (match) {
      return `/${match[1]}/${match[2]}`;
    }
  }
  return "";
}

/**
 * Recursively collect every file path under root. Skips symlinks for safety.
 */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}
