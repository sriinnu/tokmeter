/**
 * @sriinnu/tokmeter-core — CleanupService.
 *
 * Orchestrates preview, backup, execute, and restore for session cleanup.
 * Does NOT modify TokmeterCore (keeps it read-only). Accepts a core instance.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { filterByDate, filterByProject, filterByProvider } from "./aggregator.js";
import { type AliasMap, loadAliases, saveAliases } from "./alias-service.js";
import { getCleaners } from "./cleaners/index.js";
import {
  configFilePath,
  loadConfig,
  mergeConfigs,
  saveConfig,
  type UserConfig,
} from "./config-service.js";
import { localDateKey } from "./date-utils.js";
import { invalidateHistorySnapshot } from "./history-snapshot.js";
import { invalidateRecordCache } from "./parsers/utils.js";
import { projectMatchKey } from "./project-name.js";
import {
  assertSafeEntries,
  collectExtractedFiles,
  isAllowedRestorePath,
  isWithin,
  listArchiveEntries,
  restoreAllowedRoots,
  UnsafeArchiveError,
} from "./restore-guard.js";
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

/** Error text for an execute() call whose filter would match everything. */
export const EMPTY_FILTER_MESSAGE =
  "Refusing to clean up with an empty filter: it would delete every session of every provider. " +
  "Specify at least one of: a project (project/projects), providers, or a date range " +
  "(since/until, or today/week/month).";

/**
 * True when a cleanup filter selects nothing — no project, no providers and no
 * date bound — which every filter step treats as "match all". Blank strings
 * and empty arrays count as absent.
 */
export function isEmptyCleanupFilter(filter: CleanupFilter | undefined | null): boolean {
  if (!filter) return true;
  const nonBlank = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const hasProject =
    nonBlank(filter.project) || (Array.isArray(filter.projects) && filter.projects.some(nonBlank));
  const hasProviders = Array.isArray(filter.providers) && filter.providers.some(nonBlank);
  const hasDate =
    nonBlank(filter.since) ||
    nonBlank(filter.until) ||
    filter.today === true ||
    filter.week === true ||
    filter.month === true;
  return !hasProject && !hasProviders && !hasDate;
}

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
    // 1. Scan ALL records across ALL history (not the 14-day rolling window
    //    that core.scan() returns) — cleanup needs per-record sourceFile over
    //    the whole corpus, both to match old data and to detect partial-file
    //    collateral correctly.
    const allRecords = await this.core.scanLifetimeRaw();

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
    // An empty filter matches every record of every provider (an empty
    // project string is "match all" in filterByProject), so executing it
    // deletes every transcript on the machine. Refuse it here, in core, so
    // every caller — CLI, TUI, MCP, daemon HTTP — gets the same guard.
    if (isEmptyCleanupFilter(filter)) {
      throw new Error(EMPTY_FILTER_MESSAGE);
    }

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
    // A snapshot copied from another machine carries that machine's absolute
    // archive path. When it doesn't point inside this backup dir, fall back to
    // the archive that sits next to the meta file — the name createBackup
    // always writes — instead of trusting a path from the sidecar.
    const archivePath =
      typeof meta.path === "string" &&
      isWithin(meta.path, dir) &&
      resolve(meta.path) !== resolve(dir)
        ? meta.path
        : join(dir, `${backupId}.tar.gz`);

    // Validate archive path is within backup directory. A plain startsWith on
    // the resolved paths is wrong — a sibling dir like `<dir>-evil` shares the
    // prefix and would pass. Use path.relative and reject any result that
    // escapes upward (`..`) or is absolute (different root).
    const rel = relative(resolve(dir), resolve(archivePath));
    if (rel === "" || rel.startsWith("..") || resolve(archivePath) === resolve(dir)) {
      return {
        restoredCount: 0,
        errors: [{ file: archivePath, error: "Archive path outside backup directory" }],
      };
    }

    if (!existsSync(archivePath)) {
      return { restoredCount: 0, errors: [{ file: archivePath, error: "Archive file missing" }] };
    }

    try {
      // The archive is untrusted input (snapshots are made to move between
      // machines). Check member types and ".." before extracting anything:
      // only regular files and directories may come out of a backup.
      const entries = listArchiveEntries(archivePath);
      assertSafeEntries(entries);
      const listing = entries.map((e) => e.name).join("\n");

      // Decide between same-home (paths restored verbatim) and cross-home
      // (remap the source home subtree into this home). Source home comes
      // from meta when the backup was created by a modern build; otherwise
      // we sniff it from archive entries for legacy compat.
      const currentHome = this.homeDir;
      const sourceHome = meta.sourceHomeDir || sniffSourceHomeFromListing(listing);
      if (sourceHome && (!isAbsolute(sourceHome) || sourceHome.split(/[\\/]+/).includes(".."))) {
        return {
          restoredCount: 0,
          errors: [{ file: metaPath, error: `Invalid source home "${sourceHome}" in backup` }],
        };
      }

      const sameHome = sourceHome && normaliseHome(sourceHome) === normaliseHome(currentHome);

      // Everything restore may write: the session paths the scanner reads,
      // the Claude Code side dirs the cleaner backs up, tokmeter's alias and
      // config files, and this backup's own SQL dump dir.
      const allowedRoots = restoreAllowedRoots(
        currentHome,
        join(dirname(archivePath), `${backupId}-sql-dumps`)
      );

      let renamedCount = 0;

      // Capture the user's current aliases BEFORE the extract so we can
      // merge them back after restore completes. The backup tarball contains
      // a snapshot of `.tokmeter/aliases.json` from backup-creation time; a
      // naive tar-extract would silently clobber any aliases the user has
      // edited since. Merge-on-restore preserves both sides.
      const aliasesBeforeRestore: AliasMap = loadAliases(currentHome);
      const configBeforeRestore: UserConfig = loadConfig(currentHome);

      // Always extract into a private (0700) sandbox, validate the extracted
      // tree with lstat, then copy each file into place only if its
      // destination is allowlisted. Nothing touches the real tree until every
      // file has passed — a bad archive restores nothing at all.
      const sandbox = mkdtempSync(join(tmpdir(), "tokmeter-restore-"));
      try {
        chmodSync(sandbox, 0o700);
        execFileSync("tar", ["-xzf", archivePath, "-C", sandbox], {
          timeout: 60_000,
        });
        const sandboxFiles = collectExtractedFiles(sandbox);

        // (source file in sandbox, destination before any UUID re-mint)
        const plan: { src: string; rel: string }[] = [];
        let destFor: (rel: string) => string;

        if (sameHome || !sourceHome) {
          // Same machine (or can't infer): archive paths are absolute paths
          // with the leading "/" stripped, restored verbatim.
          destFor = (rel) => resolve("/", rel);
          for (const src of sandboxFiles) plan.push({ src, rel: relative(sandbox, src) });
        } else {
          // Cross-home: only the source home subtree is remapped into this
          // home; anything else in the archive is ignored.
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
          destFor = (rel) => join(currentHome, rel);
          for (const src of sandboxFiles) {
            if (!isWithin(src, sourceHomeInSandbox)) continue;
            plan.push({ src, rel: relative(sourceHomeInSandbox, src) });
          }
        }

        const assertAllowed = (dest: string, rel: string) => {
          const insideHome = sameHome || !sourceHome || isWithin(dest, currentHome);
          if (!insideHome || !isAllowedRestorePath(dest, allowedRoots)) {
            throw new UnsafeArchiveError(
              `Archive entry "${rel}" would restore outside the known agent session paths — refusing to restore anything`
            );
          }
        };
        for (const p of plan) assertAllowed(destFor(p.rel), p.rel);

        // Cross-home only — pass 1: detect UUIDs in paths that would collide
        // on the target. Build a stable old→new map so every associated path
        // (transcript, subagents, file-history, tasks, todos, session-env)
        // renames the same way, preserving both machines' work.
        const uuidMap = new Map<string, string>();
        if (!(sameHome || !sourceHome)) {
          for (const p of plan) {
            if (!existsSync(destFor(p.rel))) continue;
            for (const raw of p.rel.match(UUID_RE) || []) {
              const key = raw.toLowerCase();
              if (!uuidMap.has(key)) uuidMap.set(key, randomUUID());
            }
          }
          renamedCount = uuidMap.size;
        }

        const finalPlan = plan.map((p) => {
          const rel =
            uuidMap.size > 0
              ? p.rel.replace(UUID_RE, (m) => uuidMap.get(m.toLowerCase()) || m)
              : p.rel;
          const dest = destFor(rel);
          assertAllowed(dest, rel);
          return { src: p.src, dest };
        });

        // Pass 2: copy into place, keeping the archived mode bits (minus any
        // setuid/setgid/sticky) and mtime the way `tar -x` used to — mtime
        // drives incremental scans, so a restored old file must not look new.
        for (const { src, dest } of finalPlan) {
          mkdirSync(dirname(dest), { recursive: true });
          try {
            // Replace a symlink at the destination rather than writing through it.
            if (lstatSync(dest).isSymbolicLink()) rmSync(dest);
          } catch {}
          copyFileSync(src, dest);
          const st = statSync(src);
          chmodSync(dest, st.mode & 0o777);
          utimesSync(dest, st.atime, st.mtime);
        }
      } finally {
        // Always clean up the sandbox, even on partial failure.
        try {
          rmSync(sandbox, { recursive: true, force: true });
        } catch {}
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
      // providerPaths and customSources widen what a later restore may write
      // to, so an archive never gets to set them: this machine's own values
      // win even when the archive's config is newer. Otherwise a hostile
      // snapshot could name ~/Library/LaunchAgents and the next restore
      // would treat it as an allowed root.
      const mergedConfig: UserConfig = {
        ...mergeConfigs(configBeforeRestore, configAfterRestore),
        providerPaths: configBeforeRestore.providerPaths,
        customSources: configBeforeRestore.customSources,
      };
      saveConfig(mergedConfig, currentHome);

      // Invalidate the history snapshot + summary so the next scan rebuilds
      // them with the restored files included. We deliberately do NOT clear
      // the scan-cache: it still contains the original per-record `cost`
      // values from before cleanup, frozen at the rates of the day each
      // record was first priced. Wiping it would force the rebuild path to
      // re-price restored historical records with current kosha rates,
      // violating the historical immutability rule (same bug class that
      // caused the $21K → $15K drop on `tokmeter update`).
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
        // Local day keys, matching the calendar every other view uses — a UTC
        // slice would show the wrong day for evening records west of UTC.
        const minDate = localDateKey(total.minTs);
        const maxDate = localDateKey(total.maxTs);

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
