/**
 * Restore + cleanup guard tests. Every archive is crafted in a temp dir and
 * every restore targets a temp "home" — nothing here touches the real home
 * directory or real session files.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAliases } from "./alias-service.js";
import { CleanupService, EMPTY_FILTER_MESSAGE, isEmptyCleanupFilter } from "./cleanup-service.js";
import { loadConfig } from "./config-service.js";
import {
  assertArchiveLimits,
  assertNoSymlinkParents,
  isWithin,
  restoreAllowedRoots,
} from "./restore-guard.js";
import type { TokmeterCore } from "./tokmeter-core.js";
import type { TokenRecord } from "./types.js";

// ─── Minimal ustar writer ─────────────────────────────────────────────────
// Built by hand (not with the system tar) so tests can craft entries a real
// tar would refuse to create, and so they behave the same on bsdtar and GNU.

type TarType = "file" | "dir" | "symlink" | "hardlink" | "fifo";
interface TarEntry {
  name: string;
  type?: TarType;
  content?: string;
  linkname?: string;
  mtime?: number; // seconds
}

const TYPEFLAG: Record<TarType, string> = {
  file: "0",
  dir: "5",
  symlink: "2",
  hardlink: "1",
  fifo: "6",
};

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, "0")}\0`;
}

function splitName(name: string): { prefix: string; base: string } {
  if (Buffer.byteLength(name) <= 100) return { prefix: "", base: name };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== "/") continue;
    const prefix = name.slice(0, i);
    const base = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100) return { prefix, base };
  }
  throw new Error(`name too long for ustar: ${name}`);
}

function tarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? "file";
    const body = Buffer.from(type === "file" ? (e.content ?? "") : "");
    const h = Buffer.alloc(512, 0);
    const { prefix, base } = splitName(e.name);
    h.write(base, 0, "utf8");
    h.write(octal(type === "dir" ? 0o755 : 0o644, 8), 100, "ascii");
    h.write(octal(0, 8), 108, "ascii");
    h.write(octal(0, 8), 116, "ascii");
    h.write(octal(body.length, 12), 124, "ascii");
    h.write(octal(e.mtime ?? 1_767_225_600, 12), 136, "ascii"); // 2026-01-01
    h.write("        ", 148, "ascii");
    h.write(TYPEFLAG[type], 156, "ascii");
    if (e.linkname) h.write(e.linkname, 157, "utf8");
    h.write("ustar\0", 257, "ascii");
    h.write("00", 263, "ascii");
    h.write(prefix, 345, "utf8");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(h);
    if (body.length > 0) {
      blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

/** Archive member name for an absolute path, the way createBackup stores it. */
const member = (abs: string) => abs.replace(/^\/+/, "");

// ─── Fixtures ─────────────────────────────────────────────────────────────

const UUID = "11111111-2222-4333-8444-555555555555";
const BACKUP_ID = "2026-01-02T03-04-05";

let root: string;
let home: string;
let backupDir: string;
let outside: string;
const service = () => new CleanupService({} as TokmeterCore, home);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tokmeter-restore-test-"));
  home = join(root, "home");
  backupDir = join(home, ".cache", "tokmeter", "backups");
  outside = join(root, "outside");
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(home, ".zshrc"), "original zshrc\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeBackup(entries: TarEntry[], meta: Record<string, unknown> = {}): void {
  const archivePath = join(backupDir, `${BACKUP_ID}.tar.gz`);
  writeFileSync(archivePath, tarGz(entries));
  writeFileSync(
    join(backupDir, `${BACKUP_ID}.meta.json`),
    JSON.stringify({
      id: BACKUP_ID,
      path: archivePath,
      createdAt: "2026-01-02T03:04:05.000Z",
      sizeBytes: 1,
      filter: { project: "p" },
      recordCount: 1,
      providers: ["claude-code"],
      projects: ["p"],
      sourceHomeDir: home,
      ...meta,
    })
  );
}

const transcript = () => join(home, ".claude", "projects", "-work-p", `${UUID}.jsonl`);

// ─── Restore ──────────────────────────────────────────────────────────────

describe("CleanupService.restore — archive safety", () => {
  it("restores a legitimate same-home archive and keeps the archived mtime", () => {
    writeBackup([{ name: member(transcript()), content: '{"ok":1}\n' }]);

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.errors).toEqual([]);
    expect(readFileSync(transcript(), "utf-8")).toBe('{"ok":1}\n');
    expect(statSync(transcript()).mode & 0o777).toBe(0o600);
    expect(Math.round(statSync(transcript()).mtimeMs / 1000)).toBe(1_767_225_600);
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe("original zshrc\n");
  });

  it("refuses a ../ escape and writes nothing", () => {
    writeBackup([
      { name: member(transcript()), content: "legit\n" },
      {
        name: `${member(join(home, ".claude", "projects"))}/../../../outside/evil.txt`,
        content: "evil\n",
      },
    ]);

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.restoredCount).toBe(0);
    expect(result.errors[0].error).toMatch(/path traversal/);
    expect(existsSync(join(outside, "evil.txt"))).toBe(false);
    expect(existsSync(transcript())).toBe(false);
  });

  it("refuses an absolute path outside the allowlist and restores nothing", () => {
    writeBackup([
      { name: member(transcript()), content: "legit\n" },
      { name: `/${member(join(outside, "evil.txt"))}`, content: "evil\n" },
    ]);

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.restoredCount).toBe(0);
    expect(result.errors[0].error).toMatch(/path traversal|outside the known agent session paths/);
    expect(existsSync(join(outside, "evil.txt"))).toBe(false);
    expect(existsSync(transcript())).toBe(false);
  });

  it("refuses a file inside $HOME that is not a session path (e.g. ~/.zshrc)", () => {
    writeBackup([{ name: member(join(home, ".zshrc")), content: "pwned\n" }]);

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.errors[0].error).toMatch(/outside the known agent session paths/);
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe("original zshrc\n");
  });

  it("refuses a symlink entry pointing at ~/.zshrc", () => {
    const link = join(home, ".claude", "projects", "-work-p", "link.jsonl");
    writeBackup([
      { name: member(link), type: "symlink", linkname: join(home, ".zshrc") },
      { name: member(link), content: "pwned\n" },
    ]);

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.restoredCount).toBe(0);
    expect(result.errors[0].error).toMatch(/symlink/);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe("original zshrc\n");
  });

  it("refuses a symlinked destination parent before writing any restored file", () => {
    const linkedProject = join(home, ".claude", "projects", "-work-p");
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    symlinkSync(outside, linkedProject);
    writeBackup([{ name: member(transcript()), content: "outside write\n" }]);

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.restoredCount).toBe(0);
    expect(result.errors[0].error).toMatch(/unsafe parent/);
    expect(existsSync(join(outside, `${UUID}.jsonl`))).toBe(false);
  });

  it("refuses a hardlink entry", () => {
    const link = join(home, ".claude", "projects", "-work-p", "hl.jsonl");
    writeBackup([{ name: member(link), type: "hardlink", linkname: member(join(home, ".zshrc")) }]);

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.errors[0].error).toMatch(/hardlink/);
    expect(existsSync(link)).toBe(false);
  });

  it("refuses a fifo entry", () => {
    const fifo = join(home, ".claude", "projects", "-work-p", "pipe");
    writeBackup([{ name: member(fifo), type: "fifo" }]);

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.errors[0].error).toMatch(/fifo/);
    expect(existsSync(fifo)).toBe(false);
  });

  it("remaps a cross-home archive into $HOME, including from a foreign meta.path", () => {
    const src = "/home/alice";
    writeBackup(
      [
        { name: `home/alice/.claude/projects/-work-p/${UUID}.jsonl`, content: "from alice\n" },
        { name: `home/alice/.claude/todos/${UUID}-agent-${UUID}.json`, content: "[]\n" },
      ],
      { sourceHomeDir: src, path: `${src}/.cache/tokmeter/backups/${BACKUP_ID}.tar.gz` }
    );

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.errors).toEqual([]);
    expect(result.renamedCount).toBe(0);
    expect(readFileSync(transcript(), "utf-8")).toBe("from alice\n");
    expect(existsSync(join(home, ".claude", "todos", `${UUID}-agent-${UUID}.json`))).toBe(true);
  });

  it("re-mints colliding UUIDs consistently on a cross-home restore", () => {
    mkdirSync(join(home, ".claude", "projects", "-work-p"), { recursive: true });
    writeFileSync(transcript(), "local work\n");
    writeBackup(
      [
        { name: `home/alice/.claude/projects/-work-p/${UUID}.jsonl`, content: "from alice\n" },
        { name: `home/alice/.claude/todos/${UUID}.json`, content: "[]\n" },
      ],
      { sourceHomeDir: "/home/alice" }
    );

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.errors).toEqual([]);
    expect(result.renamedCount).toBe(1);
    expect(readFileSync(transcript(), "utf-8")).toBe("local work\n");
    const restored = readdirSync(join(home, ".claude", "projects", "-work-p")).filter(
      (f) => f !== `${UUID}.jsonl`
    );
    expect(restored).toHaveLength(1);
    const newUuid = restored[0].replace(/\.jsonl$/, "");
    expect(readFileSync(join(home, ".claude", "todos", `${newUuid}.json`), "utf-8")).toBe("[]\n");
  });

  it("refuses a cross-home entry that remaps outside the session roots", () => {
    writeBackup(
      [
        { name: `home/alice/.claude/projects/-work-p/${UUID}.jsonl`, content: "ok\n" },
        { name: "home/alice/.zshrc", content: "pwned\n" },
      ],
      { sourceHomeDir: "/home/alice" }
    );

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.errors[0].error).toMatch(/outside the known agent session paths/);
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe("original zshrc\n");
    expect(existsSync(transcript())).toBe(false);
  });
});

describe("archive expansion limits", () => {
  it("rejects declared expansion beyond the configured cap or disk headroom", () => {
    const entries = [{ name: "home/user/session.jsonl", type: "-", sizeBytes: 1024 }];
    expect(() => assertArchiveLimits(entries, 10_000, 1000)).toThrow(/expanded-size/);
    expect(() => assertArchiveLimits(entries, 512 * 1024 ** 2 + 1023)).toThrow(/free disk/);
  });

  it("rejects an excessive entry count", () => {
    const entries = [
      { name: "a", type: "-", sizeBytes: 1 },
      { name: "b", type: "-", sizeBytes: 1 },
    ];
    expect(() => assertArchiveLimits(entries, 1024 ** 3, 1024, 1)).toThrow(/too many entries/);
  });
});

describe("destination path checks", () => {
  it("rejects a symlinked home and a symlinked external-root ancestor", () => {
    const homeLink = join(root, "home-link");
    symlinkSync(home, homeLink);
    const homeDest = join(homeLink, ".tokmeter", "config.json");
    expect(() => assertNoSymlinkParents(homeDest, homeLink, [homeDest])).toThrow(/unsafe parent/);

    const externalLink = join(root, "external-link");
    symlinkSync(outside, externalLink);
    const externalRoot = join(externalLink, "nested", "sessions");
    const externalDest = join(externalRoot, "turn.jsonl");
    expect(() => assertNoSymlinkParents(externalDest, home, [externalRoot])).toThrow(
      /unsafe parent/
    );
  });
});

describe("backup durability and privacy", () => {
  it("keeps two same-second snapshots distinct and owner-only", async () => {
    const firstFile = join(home, ".codex", "sessions", "first.jsonl");
    const secondFile = join(home, ".codex", "sessions", "second.jsonl");
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    writeFileSync(firstFile, "first\n");
    writeFileSync(secondFile, "second\n");
    let sourceFile = firstFile;
    const core = {
      scanLifetimeRaw: async () =>
        [
          {
            timestamp: Date.now(),
            provider: "codex",
            project: "test",
            model: "test-model",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            cost: 0.001,
            sourceFile,
          },
        ] as TokenRecord[],
    } as unknown as TokmeterCore;
    const snapshots = new CleanupService(core, home);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    try {
      const first = await snapshots.snapshot({ providers: ["codex"] }, { backupDir });
      sourceFile = secondFile;
      const second = await snapshots.snapshot({ providers: ["codex"] }, { backupDir });

      expect(first.archivePath).not.toBe(second.archivePath);
      expect(execFileSync("tar", ["-tzf", first.archivePath], { encoding: "utf8" })).toContain(
        "first.jsonl"
      );
      expect(execFileSync("tar", ["-tzf", second.archivePath], { encoding: "utf8" })).toContain(
        "second.jsonl"
      );
      expect(statSync(backupDir).mode & 0o777).toBe(0o700);
      expect(statSync(first.archivePath).mode & 0o777).toBe(0o600);
      expect(statSync(first.archivePath.replace(/\.tar\.gz$/, ".meta.json")).mode & 0o777).toBe(
        0o600
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CleanupService.restore — config cannot widen the allowlist", () => {
  it("keeps this machine's providerPaths and customSources over the archive's", () => {
    const launchAgents = join(home, "Library", "LaunchAgents");
    const cfgPath = join(home, ".tokmeter", "config.json");
    mkdirSync(join(home, ".tokmeter"), { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        providerPaths: { cursor: [join(home, ".cursor-local")] },
        modifiedBy: "tokmeter",
      })
    );
    const hostile = JSON.stringify({
      providerPaths: { cursor: [launchAgents] },
      customSources: [{ id: "evil", name: "evil", path: launchAgents, format: "jsonl" }],
      modifiedBy: "user",
      modifiedAt: "2099-01-01T00:00:00.000Z",
    });
    writeBackup([
      { name: member(transcript()), content: '{"ok":1}\n' },
      { name: member(cfgPath), content: hostile },
    ]);

    const result = service().restore(BACKUP_ID, backupDir);
    const after = loadConfig(home);

    expect(result.errors).toEqual([]);
    expect(JSON.stringify(after.providerPaths)).not.toContain("LaunchAgents");
    expect(after.providerPaths.cursor).toEqual([join(home, ".cursor-local")]);
    expect(after.customSources).toEqual([]);
    expect(restoreAllowedRoots(home)).not.toContain(launchAgents);
  });
});

describe("restoreAllowedRoots", () => {
  it("derives roots from the parsers and never allows $HOME itself", () => {
    mkdirSync(join(home, ".tokmeter"), { recursive: true });
    writeFileSync(
      join(home, ".tokmeter", "config.json"),
      JSON.stringify({ providerPaths: { cursor: ["~"], zed: ["/"] } })
    );
    const roots = restoreAllowedRoots(home);

    expect(roots).toContain(join(home, ".claude", "projects"));
    expect(roots).toContain(join(home, ".claude", "todos"));
    expect(roots.some((r) => isWithin(home, r))).toBe(false);
    expect(roots).not.toContain("/");
  });
});

describe("CleanupService.restore — never writes executable or config paths", () => {
  it("skips Claude Code session-env hook scripts and still restores the transcript", () => {
    const hook = join(home, ".claude", "session-env", UUID, "sessionstart-hook-0.sh");
    writeBackup([
      { name: member(transcript()), content: '{"ok":1}\n' },
      { name: member(hook), content: "#!/bin/sh\necho planted\n" },
    ]);

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.errors).toEqual([]);
    expect(readFileSync(transcript(), "utf-8")).toBe('{"ok":1}\n');
    expect(existsSync(hook)).toBe(false);
    expect(result.skipped?.map((s) => s.file)).toEqual([hook]);
    expect(restoreAllowedRoots(home)).not.toContain(join(home, ".claude", "session-env"));
  });

  it("skips session-env on a cross-home restore too", () => {
    writeBackup(
      [
        { name: `home/alice/.claude/projects/-work-p/${UUID}.jsonl`, content: "from alice\n" },
        { name: `home/alice/.claude/session-env/${UUID}/sessionstart-hook-0.sh`, content: "x" },
      ],
      { sourceHomeDir: "/home/alice" }
    );

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.errors).toEqual([]);
    expect(readFileSync(transcript(), "utf-8")).toBe("from alice\n");
    expect(existsSync(join(home, ".claude", "session-env"))).toBe(false);
    expect(result.skipped).toHaveLength(1);
  });

  it("refuses an OpenClaw config file in a legacy config dir and writes nothing", () => {
    const config = join(home, ".clawdbot", "clawdbot.json");
    writeBackup([
      { name: member(transcript()), content: "legit\n" },
      { name: member(config), content: '{"gateway":"evil"}' },
    ]);

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.errors[0].error).toMatch(/outside the known agent session paths/);
    expect(existsSync(config)).toBe(false);
    expect(existsSync(transcript())).toBe(false);
  });

  it("refuses OpenClaw agent files outside its sessions folder", () => {
    const auth = join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
    writeBackup([{ name: member(auth), content: "{}" }]);

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.errors[0].error).toMatch(/outside the known agent session paths/);
    expect(existsSync(auth)).toBe(false);
  });

  it("still restores OpenClaw session files", () => {
    const session = join(home, ".clawdbot", "agents", "main", "sessions", "s1.jsonl");
    const index = join(home, ".openclaw", "agents", "main", "sessions", "sessions.json");
    writeBackup([
      { name: member(session), content: '{"type":"message"}\n' },
      { name: member(index), content: "{}" },
    ]);

    const result = service().restore(BACKUP_ID, backupDir);

    expect(result.errors).toEqual([]);
    expect(readFileSync(session, "utf-8")).toBe('{"type":"message"}\n');
    expect(readFileSync(index, "utf-8")).toBe("{}");
  });
});

describe("CleanupService.restore — security settings stay this machine's", () => {
  it("keeps the local antigravityLivePolling value and never hides a visible project", () => {
    const cfgPath = join(home, ".tokmeter", "config.json");
    const aliasPath = join(home, ".tokmeter", "aliases.json");
    mkdirSync(join(home, ".tokmeter"), { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({ daemon: { antigravityLivePolling: false }, modifiedBy: "tokmeter" })
    );
    const at = "2026-01-01T00:00:00.000Z";
    writeFileSync(
      aliasPath,
      JSON.stringify({
        visible: { display: "Visible", hidden: false, modifiedBy: "tokmeter", modifiedAt: at },
        quiet: { display: "Quiet", hidden: true, modifiedBy: "user", modifiedAt: at },
      })
    );
    const later = "2099-01-01T00:00:00.000Z";
    writeBackup([
      { name: member(transcript()), content: '{"ok":1}\n' },
      {
        name: member(cfgPath),
        content: JSON.stringify({
          daemon: { antigravityLivePolling: true, scanIntervalSeconds: 120 },
          modifiedBy: "user",
          modifiedAt: later,
        }),
      },
      {
        name: member(aliasPath),
        content: JSON.stringify({
          visible: { display: "Visible", hidden: true, modifiedBy: "user", modifiedAt: later },
          fresh: { display: "Fresh", hidden: true, modifiedBy: "user", modifiedAt: later },
          quiet: { display: "Quiet", hidden: true, modifiedBy: "user", modifiedAt: later },
        }),
      },
    ]);

    const result = service().restore(BACKUP_ID, backupDir);
    const aliases = loadAliases(home);

    expect(result.errors).toEqual([]);
    expect(loadConfig(home).daemon.antigravityLivePolling).toBe(false);
    // Non-security settings still merge from the newer archive.
    expect(loadConfig(home).daemon.scanIntervalSeconds).toBe(120);
    expect(aliases.visible.hidden).toBe(false);
    expect(aliases.fresh.hidden).toBe(false);
    expect(aliases.quiet.hidden).toBe(true);
  });
});

// ─── Cleanup guard ────────────────────────────────────────────────────────

describe("CleanupService.execute — empty filter guard", () => {
  it.each([
    [{}],
    [{ project: "" }],
    [{ project: "   ", providers: [] }],
    [{ projects: [] }],
    [{ projects: [""] }],
    [{ since: "", until: "" }],
    [{ today: false, week: false, month: false }],
  ])("refuses %j", async (filter) => {
    expect(isEmptyCleanupFilter(filter)).toBe(true);
    await expect(service().execute(filter)).rejects.toThrow(EMPTY_FILTER_MESSAGE);
  });

  it.each([
    [{ project: "tokmeter" }],
    [{ projects: ["a", "b"] }],
    [{ providers: ["codex" as const] }],
    [{ since: "2026-01-01" }],
    [{ until: "2026-01-01" }],
    [{ today: true }],
    [{ week: true }],
    [{ month: true }],
  ])("lets %j through to the normal flow", async (filter) => {
    expect(isEmptyCleanupFilter(filter)).toBe(false);
    // A core with no records: execute must reach preview and find nothing,
    // proving the guard didn't reject a legitimately narrow filter.
    const core = { scanLifetimeRaw: async () => [] } as unknown as TokmeterCore;
    const result = await new CleanupService(core, home).execute(filter, { backupDir });
    expect(result.deletedCount).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("names what to specify in the refusal", () => {
    expect(EMPTY_FILTER_MESSAGE).toMatch(/project/);
    expect(EMPTY_FILTER_MESSAGE).toMatch(/providers/);
    expect(EMPTY_FILTER_MESSAGE).toMatch(/since\/until/);
  });
});
