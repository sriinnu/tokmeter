/**
 * Cleanup containment tests. Every "home" is a temp dir; nothing here touches
 * the real home directory or real session files.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeCleaner } from "./cleaners/claude-code.js";
import { SimpleFileCleaner } from "./cleaners/simple-file-cleaner.js";
import { TaskDirCleaner } from "./cleaners/task-dir-cleaner.js";
import { assertSafeCleanupTargets, SHARED_DATABASE_REASON } from "./cleanup-guard.js";
import { CleanupService } from "./cleanup-service.js";
import { RooCodeParser } from "./parsers/roo-code.js";
import type { TokmeterCore } from "./tokmeter-core.js";
import type { CleanupTarget, ProviderId, TokenRecord } from "./types.js";

const UUID = "11111111-2222-4333-8444-555555555555";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tokmeter-cleanup-guard-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.doUnmock("./cleaners/index.js");
  vi.resetModules();
});

function touch(path: string, content = "x\n"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function record(provider: ProviderId, sourceFile: string): TokenRecord {
  return {
    timestamp: Date.now(),
    provider,
    project: "p",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    sourceFile,
  } as TokenRecord;
}

const coreWith = (records: TokenRecord[]) =>
  ({ scanLifetimeRaw: async () => records }) as unknown as TokmeterCore;

const target = (path: string, type: CleanupTarget["type"] = "directory"): CleanupTarget => ({
  path,
  type,
  sizeBytes: 0,
  provider: "claude-code",
  description: "test",
});

describe("ClaudeCodeCleaner — side paths only for real session ids", () => {
  it("a transcript named `...jsonl` targets only itself, never `..` or ~/.claude", async () => {
    const projectDir = join(home, ".claude", "projects", "-work-p");
    const odd = touch(join(projectDir, "...jsonl"));
    mkdirSync(join(home, ".claude", "file-history"), { recursive: true });
    mkdirSync(join(home, ".claude", "session-env"), { recursive: true });

    const targets = await new ClaudeCodeCleaner().resolveTargets([odd], home);

    expect(targets.map((t) => t.path)).toEqual([odd]);
    expect(targets[0].type).toBe("file");
  });

  it("a non-UUID transcript name never derives side directories", async () => {
    const file = touch(join(home, ".claude", "projects", "-work-p", "agent-abc.jsonl"));
    mkdirSync(join(home, ".claude", "file-history", "agent-abc"), { recursive: true });
    mkdirSync(join(home, ".claude", "projects", "-work-p", "agent-abc"), { recursive: true });

    const targets = await new ClaudeCodeCleaner().resolveTargets([file], home);

    expect(targets.map((t) => t.path)).toEqual([file]);
  });

  it("a UUID transcript still gets its session dir and side dirs", async () => {
    const projectDir = join(home, ".claude", "projects", "-work-p");
    const file = touch(join(projectDir, `${UUID}.jsonl`));
    mkdirSync(join(projectDir, UUID), { recursive: true });
    mkdirSync(join(home, ".claude", "file-history", UUID), { recursive: true });

    const paths = (await new ClaudeCodeCleaner().resolveTargets([file], home)).map((t) => t.path);

    expect(paths).toContain(file);
    expect(paths).toContain(join(projectDir, UUID));
    expect(paths).toContain(join(home, ".claude", "file-history", UUID));
  });
});

describe("assertSafeCleanupTargets", () => {
  it.each([
    ["the home dir", () => home],
    ["~/.claude", () => join(home, ".claude")],
    ["~/.claude/projects", () => join(home, ".claude", "projects")],
    ["~/.claude/session-env", () => join(home, ".claude", "session-env")],
    ["an ancestor of home", () => root],
    ["the filesystem root", () => "/"],
    ["a session root", () => join(home, ".codex", "sessions")],
  ])("refuses %s", (_label, path) => {
    expect(() => assertSafeCleanupTargets([target(path())], home)).toThrow(/Refusing cleanup/);
  });

  it("refuses a relative or empty path", () => {
    expect(() => assertSafeCleanupTargets([target("x.jsonl", "file")], home)).toThrow(
      /not an absolute path/
    );
    expect(() => assertSafeCleanupTargets([target("", "file")], home)).toThrow(/Refusing/);
  });

  it("allows a single session file and a session's own directory", () => {
    const projectDir = join(home, ".claude", "projects", "-work-p");
    expect(() =>
      assertSafeCleanupTargets(
        [target(join(projectDir, `${UUID}.jsonl`), "file"), target(join(projectDir, UUID))],
        home
      )
    ).not.toThrow();
  });
});

describe("CleanupService — containment is enforced before preview and before delete", () => {
  it("a cleaner that resolves ~/.claude is refused in preview and execute; nothing is deleted", async () => {
    const claudeDir = join(home, ".claude");
    const keep = touch(join(claudeDir, "projects", "-work-p", `${UUID}.jsonl`));
    vi.doMock("./cleaners/index.js", () => {
      const rogue = {
        providerId: "claude-code",
        resolveTargets: async () => [target(claudeDir)],
        executeCleanup: async () => {
          rmSync(claudeDir, { recursive: true, force: true });
          return { deletedCount: 1, failedCount: 0, errors: [], bytesFreed: 0 };
        },
      };
      return { getCleaners: () => [rogue], ALL_CLEANERS: [rogue], getCleaner: () => rogue };
    });
    const { CleanupService: Service } = await import("./cleanup-service.js");
    const service = new Service(coreWith([record("claude-code", keep)]), home);

    await expect(service.preview({ project: "p" })).rejects.toThrow(/Refusing cleanup/);
    await expect(service.execute({ project: "p" }, { backup: false })).rejects.toThrow(
      /Refusing cleanup/
    );
    expect(existsSync(keep)).toBe(true);
  });
});

describe("shared app databases are never deleted as a whole file", () => {
  const sqlite = (path: string) =>
    touch(path, `SQLite format 3\0${"\0".repeat(84)}cursor global state`);

  it("Cursor's state.vscdb is reported as not removable and survives execute", async () => {
    const db = sqlite(
      join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
    );
    const service = new CleanupService(coreWith([record("cursor", db)]), home);

    const preview = await service.preview({ providers: ["cursor"] });
    expect(preview.targets.map((t) => t.path)).not.toContain(db);
    expect(preview.unremovable).toEqual([
      { path: db, provider: "cursor", reason: SHARED_DATABASE_REASON },
    ]);
    expect(preview.partialFileWarnings).toEqual([]);

    const result = await service.execute({ providers: ["cursor"] }, { backup: false });
    expect(result.deletedCount).toBe(0);
    expect(existsSync(db)).toBe(true);
  });

  it("SimpleFileCleaner skips a SQLite file even without a database extension", async () => {
    const db = sqlite(join(home, ".codex", "sessions", "looks-like-a-session"));
    const plain = touch(join(home, ".codex", "sessions", "rollout.jsonl"));

    const targets = await new SimpleFileCleaner("codex").resolveTargets([db, plain], home);

    expect(targets.map((t) => t.path)).toEqual([plain]);
  });
});

describe("TaskDirCleaner — only a direct child of the tasks root is a task dir", () => {
  it("never targets the tasks root itself", async () => {
    const tasksRoot = new RooCodeParser().sessionRoots(home)[0];
    const strayInRoot = touch(join(tasksRoot, "ui_messages.json"), "[]");
    const real = touch(join(tasksRoot, "task-1", "ui_messages.json"), "[]");
    const elsewhere = touch(join(root, "elsewhere", "task-2", "ui_messages.json"), "[]");

    const targets = await new TaskDirCleaner("roo-code").resolveTargets(
      [strayInRoot, real, elsewhere],
      home
    );

    expect(targets.map((t) => t.path)).toEqual([join(tasksRoot, "task-1")]);
  });
});
