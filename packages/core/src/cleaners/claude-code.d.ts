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
import type { CleanupResult, CleanupTarget, SessionCleaner } from "../types.js";
export declare class ClaudeCodeCleaner implements SessionCleaner {
  readonly providerId: "claude-code";
  resolveTargets(sourceFiles: string[], homeDir: string): Promise<CleanupTarget[]>;
  executeCleanup(targets: CleanupTarget[]): Promise<CleanupResult>;
  private addFileTarget;
  private addDirTarget;
  private addTodoTargets;
  private estimateDirSize;
  private removeFromSessionsIndex;
}
