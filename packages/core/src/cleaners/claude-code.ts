/**
 * @sriinnu/tokmeter-core — Claude Code cleaner.
 *
 * The most complex cleaner. Each .jsonl session has up to 7 associated paths:
 *   1. {uuid}.jsonl              — main transcript
 *   2. {uuid}/                   — subagents + tool-results dir
 *   3. ~/.claude/file-history/{uuid}/  — file snapshots
 *   4. ~/.claude/tasks/{uuid}/         — task state
 *   5. ~/.claude/todos/{uuid}*.json    — todo files
 *   6. ~/.claude/session-env/{uuid}/   — environment snapshots
 *   7. sessions-index.json             — entry removal (index-entry)
 *
 * Inspired by ataleckij/claude-chats-delete for thorough cleanup.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CleanupResult, CleanupTarget, SessionCleaner } from "../types.js";

export class ClaudeCodeCleaner implements SessionCleaner {
  readonly providerId = "claude-code" as const;

  async resolveTargets(sourceFiles: string[], homeDir: string): Promise<CleanupTarget[]> {
    const home = homeDir || homedir();
    const claudeDir = join(home, ".claude");
    const targets: CleanupTarget[] = [];
    const uuids = new Set<string>();
    const projectDirs = new Set<string>();

    for (const file of sourceFiles) {
      const uuid = basename(file, ".jsonl");
      if (!uuid || uuids.has(uuid)) continue;
      uuids.add(uuid);

      const projectDir = dirname(file);
      projectDirs.add(projectDir);

      // 1. Main .jsonl transcript
      await this.addFileTarget(targets, file, "session transcript");

      // 2. Session UUID directory (subagents, tool-results)
      await this.addDirTarget(targets, join(projectDir, uuid), "subagents + tool-results");

      // 3. File history
      await this.addDirTarget(targets, join(claudeDir, "file-history", uuid), "file history");

      // 4. Task state
      await this.addDirTarget(targets, join(claudeDir, "tasks", uuid), "task state");

      // 5. Todo files (glob: {uuid}*.json)
      await this.addTodoTargets(targets, claudeDir, uuid);

      // 6. Session env
      await this.addDirTarget(targets, join(claudeDir, "session-env", uuid), "session env");

      // 7. sessions-index.json entry
      const indexPath = join(projectDir, "sessions-index.json");
      if (existsSync(indexPath)) {
        targets.push({
          path: indexPath,
          type: "index-entry",
          sizeBytes: 0,
          provider: this.providerId,
          description: `remove ${uuid} from sessions-index`,
        });
      }
    }

    return targets;
  }

  async executeCleanup(targets: CleanupTarget[]): Promise<CleanupResult> {
    let deletedCount = 0;
    let bytesFreed = 0;
    const errors: { target: string; error: string }[] = [];

    // Collect index-entry updates (batch per index file)
    const indexUpdates = new Map<string, string[]>();

    for (const t of targets) {
      if (t.type === "index-entry") {
        // Extract UUID from description
        const match = t.description.match(/remove (\S+) from/);
        if (match) {
          const uuids = indexUpdates.get(t.path) || [];
          uuids.push(match[1]);
          indexUpdates.set(t.path, uuids);
        }
        continue;
      }

      try {
        if (t.type === "directory") {
          await rm(t.path, { recursive: true, force: true });
        } else {
          await rm(t.path, { force: true });
        }
        deletedCount++;
        bytesFreed += t.sizeBytes;
      } catch (err) {
        errors.push({
          target: t.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Update sessions-index.json files
    for (const [indexPath, uuidsToRemove] of indexUpdates) {
      try {
        this.removeFromSessionsIndex(indexPath, uuidsToRemove);
        deletedCount++;
      } catch (err) {
        errors.push({
          target: indexPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      deletedCount,
      failedCount: errors.length,
      errors,
      bytesFreed,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async addFileTarget(
    targets: CleanupTarget[],
    path: string,
    description: string,
  ): Promise<void> {
    try {
      const s = await stat(path);
      if (s.isFile()) {
        targets.push({
          path,
          type: "file",
          sizeBytes: s.size,
          provider: this.providerId,
          description,
        });
      }
    } catch {
      // Does not exist — skip
    }
  }

  private async addDirTarget(
    targets: CleanupTarget[],
    path: string,
    description: string,
  ): Promise<void> {
    try {
      const s = await stat(path);
      if (s.isDirectory()) {
        targets.push({
          path,
          type: "directory",
          sizeBytes: await this.estimateDirSize(path),
          provider: this.providerId,
          description,
        });
      }
    } catch {
      // Does not exist — skip
    }
  }

  private async addTodoTargets(
    targets: CleanupTarget[],
    claudeDir: string,
    uuid: string,
  ): Promise<void> {
    const todosDir = join(claudeDir, "todos");
    try {
      const entries = await readdir(todosDir);
      for (const entry of entries) {
        if (entry.startsWith(uuid) && entry.endsWith(".json")) {
          const todoPath = join(todosDir, entry);
          await this.addFileTarget(targets, todoPath, "todo file");
        }
      }
    } catch {
      // todos dir may not exist
    }
  }

  private async estimateDirSize(dirPath: string): Promise<number> {
    let total = 0;
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        try {
          const s = await stat(join(dirPath, entry.name));
          total += s.size;
        } catch {}
      }
    } catch {}
    return total;
  }

  private removeFromSessionsIndex(indexPath: string, uuidsToRemove: string[]): void {
    try {
      const raw = readFileSync(indexPath, "utf-8");
      const index = JSON.parse(raw);

      if (Array.isArray(index.entries)) {
        const uuidSet = new Set(uuidsToRemove);
        index.entries = index.entries.filter(
          (entry: { id?: string; sessionId?: string }) =>
            !uuidSet.has(entry.id ?? "") && !uuidSet.has(entry.sessionId ?? ""),
        );
      }

      // Atomic write
      const tmpPath = `${indexPath}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
      renameSync(tmpPath, indexPath);
    } catch {
      // If index is malformed or missing, skip
    }
  }
}
