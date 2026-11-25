import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cursorHookPaths,
  cursorHookStatus,
  ensureCursorHook,
  hookCommand,
  installCursorHook,
  shellQuote,
  uninstallCursorHook,
} from "./cursor-hook.js";
import { buildCursorHookScript } from "./cursor-hook-script.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokmeter-cursor-hook-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const completed = {
  conversation_id: "conv-1",
  generation_id: "gen-1",
  model: "default",
  model_id: "default",
  model_params: [{ id: "thinking", value: "high" }],
  status: "completed",
  loop_count: 0,
  input_tokens: 1200,
  output_tokens: 340,
  cache_read_tokens: 56000,
  cache_write_tokens: 800,
  hook_event_name: "stop",
  cursor_version: "3.11.13",
  workspace_roots: ["/Users/someone/work/alpha", "/Users/someone/work/beta"],
  user_email: "someone@example.com",
  session_id: "conv-1",
  transcript_path: "/Users/someone/.cursor/projects/x/agent-transcripts/conv-1.jsonl",
  some_future_field: "secret",
};

function writeScript(journalDir: string): string {
  const file = join(home, "cursor-stop.mjs");
  writeFileSync(file, buildCursorHookScript(journalDir));
  return file;
}

/**
 * What must hold is "done inside Cursor's 5 s hook timeout". Node's cold
 * start alone can take over a second while the full suite runs in parallel,
 * so tighter wall-clock bounds made these tests flaky without testing more.
 */
const CURSOR_HOOK_KILL_MS = 5000;

function runScript(script: string, input: string) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [script], { input, encoding: "utf8", timeout: 15_000 });
  return { ...r, ms: Date.now() - started };
}

function journalLines(dir: string): Record<string, unknown>[] {
  if (!existsSync(dir)) return [];
  // Day files only: coverage.jsonl beside them is the install ledger.
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("cursor stop hook script", () => {
  it("records a completed turn with only the allowlisted fields", () => {
    const dir = join(home, "turns");
    const r = runScript(writeScript(dir), JSON.stringify(completed));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("{}");
    expect(r.ms).toBeLessThan(CURSOR_HOOK_KILL_MS);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = journalLines(dir);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(Object.keys(line).sort()).toEqual(
      [
        "v",
        "ts",
        "conversation_id",
        "generation_id",
        "model",
        "model_id",
        "status",
        "loop_count",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "cursor_version",
        "workspace_root",
      ].sort()
    );
    expect(line).toMatchObject({
      v: 1,
      input_tokens: 1200,
      cache_read_tokens: 56000,
      workspace_root: "/Users/someone/work/alpha",
    });
    expect(typeof line.ts).toBe("number");
    const raw = readFileSync(join(dir, files[0]!), "utf8");
    expect(raw).not.toContain("someone@example.com");
    expect(raw).not.toContain("transcript");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("thinking");
  });

  it("records an error turn that has no token fields, with its status", () => {
    const dir = join(home, "turns");
    const r = runScript(
      writeScript(dir),
      JSON.stringify({
        conversation_id: "conv-1",
        generation_id: "gen-2",
        model: "gpt-5",
        status: "error",
        loop_count: 0,
        user_email: "someone@example.com",
      })
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("{}");
    const [line] = journalLines(dir);
    expect(line).toMatchObject({ status: "error", generation_id: "gen-2" });
    expect(line).not.toHaveProperty("input_tokens");
    expect(line).not.toHaveProperty("user_email");
  });

  it("ignores events other than stop", () => {
    const dir = join(home, "turns");
    const r = runScript(
      writeScript(dir),
      JSON.stringify({ ...completed, hook_event_name: "afterAgentResponse", text: "hello" })
    );
    expect(r.status).toBe(0);
    expect(journalLines(dir)).toHaveLength(0);
  });

  it.each([
    ["garbage", "not json at all {"],
    ["empty", ""],
    ["array", "[1,2,3]"],
    ["empty object", "{}"],
  ])("prints {} and exits 0 on %s input, writing nothing", (_name, input) => {
    const dir = join(home, "turns");
    const r = runScript(writeScript(dir), input);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("{}");
    expect(journalLines(dir)).toHaveLength(0);
  });

  it("prints {} and exits 0 when the journal directory can't be created", () => {
    const blocker = join(home, "a-file");
    writeFileSync(blocker, "x");
    const r = runScript(writeScript(join(blocker, "turns")), JSON.stringify(completed));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("{}");
  });

  it("prints {} and exits 0 when the journal directory is read-only", () => {
    const dir = join(home, "turns");
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      const r = runScript(writeScript(dir), JSON.stringify(completed));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("{}");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("exits within the deadline when stdin never closes", async () => {
    const script = writeScript(join(home, "turns"));
    const started = Date.now();
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.stdin.destroy();
    expect(code).toBe(0);
    expect(out.trim()).toBe("{}");
    expect(Date.now() - started).toBeLessThan(CURSOR_HOOK_KILL_MS);
  });

  it("keeps concurrent appends as whole lines", async () => {
    const dir = join(home, "turns");
    const script = writeScript(dir);
    const N = 12;
    const runs = Array.from({ length: N }, (_, i) => {
      const payload = JSON.stringify({
        ...completed,
        generation_id: `gen-${i}`,
        // Pad near the 4 KB cap so a torn write would show.
        workspace_roots: [`/Users/someone/${"x".repeat(900)}/${i}`],
        model: "m".repeat(250),
      });
      return new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [script], { stdio: ["pipe", "ignore", "ignore"] });
        child.on("exit", resolve);
        child.stdin.end(payload);
      });
    });
    const codes = await Promise.all(runs);
    expect(codes.every((c) => c === 0)).toBe(true);
    const raw = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(N);
    const gens = lines.map((l) => JSON.parse(l).generation_id).sort();
    expect(gens).toEqual(Array.from({ length: N }, (_, i) => `gen-${i}`).sort());
  });
});

describe("cursor-hook installer", () => {
  const telemetry = {
    version: 1,
    hooks: {
      preToolUse: [{ command: "/opt/telemetry/bin/bundle --pre-tool" }],
    },
  };

  function writeHooks(content: string) {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(cursorHookPaths(home).hooksFile, content);
  }

  function readHooks() {
    return JSON.parse(readFileSync(cursorHookPaths(home).hooksFile, "utf8"));
  }

  it("adds a stop entry and keeps the existing preToolUse hook and keys", async () => {
    writeHooks(`${JSON.stringify({ ...telemetry, extra: { keep: true } }, null, 4)}\n`);
    const result = await installCursorHook({ home, nodePath: "/usr/local/bin/node" });
    const hooks = readHooks();
    expect(hooks.version).toBe(1);
    expect(hooks.extra).toEqual({ keep: true });
    expect(hooks.hooks.preToolUse).toEqual(telemetry.hooks.preToolUse);
    expect(hooks.hooks.stop).toEqual([{ command: result.command, timeout: 5, loop_limit: null }]);
    expect(result.command).toBe(
      hookCommand("/usr/local/bin/node", join(home, ".tokmeter", "hooks", "cursor-stop.mjs"))
    );
    // Formatting kept: four-space indent and trailing newline.
    const raw = readFileSync(cursorHookPaths(home).hooksFile, "utf8");
    expect(raw).toMatch(/\n {4}"version"/);
    expect(raw.endsWith("\n")).toBe(true);
    // The script is in place and points at this home's journal.
    const script = readFileSync(cursorHookPaths(home).scriptFile, "utf8");
    expect(script).toContain(JSON.stringify(cursorHookPaths(home).journalDir));
    expect(readdirSync(join(home, ".cursor")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("creates hooks.json when there is none", async () => {
    await installCursorHook({ home, nodePath: "/usr/local/bin/node" });
    const hooks = readHooks();
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.stop).toHaveLength(1);
  });

  it("is idempotent: twice gives one entry and an unchanged file", async () => {
    writeHooks(JSON.stringify(telemetry, null, 2));
    await installCursorHook({ home, nodePath: "/usr/local/bin/node" });
    const first = readFileSync(cursorHookPaths(home).hooksFile, "utf8");
    const again = await installCursorHook({ home, nodePath: "/usr/local/bin/node" });
    expect(again.hooksChanged).toBe(false);
    expect(readFileSync(cursorHookPaths(home).hooksFile, "utf8")).toBe(first);
    expect(readHooks().hooks.stop).toHaveLength(1);
  });

  it("replaces our old entry in place when the node path changes", async () => {
    writeHooks(
      JSON.stringify({
        version: 1,
        hooks: { stop: [{ command: "other-stop" }], preToolUse: telemetry.hooks.preToolUse },
      })
    );
    await installCursorHook({ home, nodePath: "/old/node" });
    writeHooks(
      JSON.stringify({
        ...readHooks(),
        hooks: {
          ...readHooks().hooks,
          stop: [...readHooks().hooks.stop, { command: "later-stop" }],
        },
      })
    );
    await installCursorHook({ home, nodePath: "/new/node" });
    const stop = readHooks().hooks.stop;
    expect(stop.map((e: { command: string }) => e.command.split(" ")[0])).toEqual([
      "other-stop",
      shellQuote("/new/node"),
      "later-stop",
    ]);
  });

  it("uninstall removes only our entry and the script, keeping the journal", async () => {
    writeHooks(
      JSON.stringify({
        ...telemetry,
        hooks: { ...telemetry.hooks, stop: [{ command: "other-stop" }] },
      })
    );
    await installCursorHook({ home, nodePath: "/usr/local/bin/node" });
    mkdirSync(cursorHookPaths(home).journalDir, { recursive: true });
    writeFileSync(join(cursorHookPaths(home).journalDir, "2026-11-12.jsonl"), "{}\n");
    const result = await uninstallCursorHook({ home });
    expect(result.removedEntries).toBe(1);
    const hooks = readHooks();
    expect(hooks.hooks.preToolUse).toEqual(telemetry.hooks.preToolUse);
    expect(hooks.hooks.stop).toEqual([{ command: "other-stop" }]);
    expect(existsSync(cursorHookPaths(home).scriptFile)).toBe(false);
    expect(existsSync(join(cursorHookPaths(home).journalDir, "2026-11-12.jsonl"))).toBe(true);
  });

  it("uninstall drops an emptied stop list and leaves the rest", async () => {
    writeHooks(JSON.stringify(telemetry, null, 2));
    await installCursorHook({ home, nodePath: "/usr/local/bin/node" });
    await uninstallCursorHook({ home });
    expect(readHooks()).toEqual(telemetry);
  });

  it.each([
    ["invalid JSON", '{"version":1,"hooks":{'],
    ["JSON with comments", '// mine\n{"version":1,"hooks":{}}'],
    ["a non-object", "[]"],
    ["hooks not an object", '{"version":1,"hooks":[]}'],
    ["stop not an array", '{"version":1,"hooks":{"stop":{"command":"x"}}}'],
  ])("refuses %s and changes nothing", async (_name, content) => {
    writeHooks(content);
    await expect(installCursorHook({ home, nodePath: "/usr/local/bin/node" })).rejects.toThrow(
      /Nothing was changed|nothing was changed/
    );
    expect(readFileSync(cursorHookPaths(home).hooksFile, "utf8")).toBe(content);
    expect(existsSync(cursorHookPaths(home).scriptFile)).toBe(false);
    await expect(uninstallCursorHook({ home })).rejects.toThrow();
    expect(readFileSync(cursorHookPaths(home).hooksFile, "utf8")).toBe(content);
  });

  it("status reports install state, the journal and today's turns", async () => {
    expect(cursorHookStatus({ home }).installed).toBe(false);
    await installCursorHook({ home, nodePath: process.execPath });
    const dir = cursorHookPaths(home).journalDir;
    mkdirSync(dir, { recursive: true });
    const now = new Date(2026, 10, 12, 15).getTime();
    writeFileSync(
      join(dir, "2026-11-12.jsonl"),
      `${JSON.stringify({ v: 1, ts: now - 1000, status: "completed", model: "gpt-5", input_tokens: 5 })}\n` +
        `${JSON.stringify({ v: 1, ts: now, status: "error", model: "gpt-5" })}\n`
    );
    const s = cursorHookStatus({ home, now });
    expect(s.installed).toBe(true);
    expect(s.nodePresent).toBe(true);
    expect(s.scriptVersion).toBe(1);
    expect(s.turnsToday).toBe(2);
    expect(s.turnsTodayWithUsage).toBe(1);
    expect(s.lastTurn).toMatchObject({ ts: now, status: "error", hasUsage: false });
  });

  it("status lists today's turns with their summed input, output and cache counts", async () => {
    const dir = cursorHookPaths(home).journalDir;
    mkdirSync(dir, { recursive: true });
    const now = new Date(2026, 10, 12, 15).getTime();
    const usage = (ts: number, i: number, o: number, r: number, w: number) =>
      `${JSON.stringify({ v: 1, ts, status: "completed", model: "default", input_tokens: i, output_tokens: o, cache_read_tokens: r, cache_write_tokens: w })}\n`;
    writeFileSync(
      join(dir, "2026-11-12.jsonl"),
      usage(now - 2000, 100, 20, 5000, 300) +
        usage(now - 1000, 50, 10, 7000, 0) +
        `${JSON.stringify({ v: 1, ts: now, status: "aborted" })}\n`
    );
    // Yesterday's lines are not today's.
    writeFileSync(join(dir, "2026-11-11.jsonl"), usage(now - 86_400_000, 9, 9, 9, 9));
    const s = cursorHookStatus({ home, now });
    expect(s.todayTotals).toEqual({ input: 150, output: 30, cacheRead: 12000, cacheWrite: 300 });
    expect(s.todayTurns.map((t) => [t.status, t.input, t.hasUsage])).toEqual([
      ["completed", 100, true],
      ["completed", 50, true],
      ["aborted", 0, false],
    ]);
  });

  it("the installed command runs end to end through a shell", async () => {
    const spaced = join(home, "with space's");
    mkdirSync(spaced);
    const { command, paths } = await installCursorHook({
      home: spaced,
      nodePath: process.execPath,
    });
    const r =
      process.platform === "win32"
        ? spawnSync("cmd.exe", ["/d", "/s", "/c", command], {
            input: JSON.stringify(completed),
            encoding: "utf8",
          })
        : spawnSync(
            "/bin/sh",
            [
              "-c",
              `printf %s '${Buffer.from(JSON.stringify(completed)).toString("base64")}' | base64 -d | ${command}`,
            ],
            { encoding: "utf8" }
          );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("{}");
    expect(journalLines(paths.journalDir)).toHaveLength(1);
  });
});

describe("shellQuote", () => {
  it("leaves plain paths bare and single-quotes the rest", async () => {
    expect(shellQuote("/opt/homebrew/bin/node", "darwin")).toBe("/opt/homebrew/bin/node");
    expect(shellQuote("/a b/it's", "darwin")).toBe("'/a b/it'\\''s'");
    expect(hookCommand("/n", "/a b", "darwin")).toBe("/n '/a b'");
    expect(shellQuote("C:\\Program Files\\nodejs\\node.exe", "win32")).toBe(
      '"C:\\Program Files\\nodejs\\node.exe"'
    );
  });
});

describe("cursor-hook coverage ledger", () => {
  it("records install and uninstall once each, so a reinstall never moves the start", async () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-hook-ledger-"));
    try {
      await installCursorHook({ home, nodePath: "/usr/local/bin/node", now: 1000 });
      await installCursorHook({ home, nodePath: "/other/node", now: 2000 });
      await uninstallCursorHook({ home, now: 3000 });
      await uninstallCursorHook({ home, now: 4000 });
      const lines = readFileSync(join(home, ".tokmeter", "cursor-turns", "coverage.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines).toEqual([
        { v: 1, event: "installed", ts: 1000 },
        { v: 1, event: "uninstalled", ts: 3000 },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("cursor-hook ledger state decides, not hooks.json", () => {
  const ledgerLines = (h: string) =>
    readFileSync(join(h, ".tokmeter", "cursor-turns", "coverage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

  it("install opens a span when hooks.json already has our entry but the ledger has none", async () => {
    // Our entry is in hooks.json (copied from another machine, or the ledger
    // was lost), so hooks.json says "installed". The ledger says not.
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      cursorHookPaths(home).hooksFile,
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: hookCommand("/usr/local/bin/node", cursorHookPaths(home).scriptFile) }],
        },
      })
    );
    await installCursorHook({ home, nodePath: "/usr/local/bin/node", now: 1000 });
    expect(ledgerLines(home)).toEqual([{ v: 1, event: "installed", ts: 1000 }]);
  });

  it("install doesn't reopen a span that is already open, even if our entry was removed", async () => {
    await installCursorHook({ home, nodePath: "/usr/local/bin/node", now: 1000 });
    writeFileSync(cursorHookPaths(home).hooksFile, JSON.stringify({ version: 1, hooks: {} }));
    await installCursorHook({ home, nodePath: "/usr/local/bin/node", now: 2000 });
    expect(ledgerLines(home)).toEqual([{ v: 1, event: "installed", ts: 1000 }]);
  });

  it("uninstall closes an open span even when our hooks.json entry is already gone", async () => {
    await installCursorHook({ home, nodePath: "/usr/local/bin/node", now: 1000 });
    // Removed by hand.
    writeFileSync(cursorHookPaths(home).hooksFile, JSON.stringify({ version: 1, hooks: {} }));
    const result = await uninstallCursorHook({ home, now: 2000 });
    expect(result.removedEntries).toBe(0);
    expect(ledgerLines(home)).toEqual([
      { v: 1, event: "installed", ts: 1000 },
      { v: 1, event: "uninstalled", ts: 2000 },
    ]);
  });

  it("refuses when the ledger can't be read, and changes nothing", async () => {
    mkdirSync(join(cursorHookPaths(home).journalDir, "coverage.jsonl"), { recursive: true });
    await expect(installCursorHook({ home, nodePath: "/usr/local/bin/node" })).rejects.toThrow();
    expect(existsSync(cursorHookPaths(home).hooksFile)).toBe(false);
    expect(existsSync(cursorHookPaths(home).scriptFile)).toBe(false);
  });
});

describe("cursor hook script with $ in the path", () => {
  it("embeds a home containing $$ and $' verbatim and writes there", () => {
    const odd = join(home, "a$$b$'c$&d");
    const dir = join(odd, ".tokmeter", "cursor-turns");
    const script = buildCursorHookScript(dir);
    expect(script).toContain(`var JOURNAL_DIR = ${JSON.stringify(dir)};`);
    const file = join(home, "odd-stop.mjs");
    writeFileSync(file, script);
    const r = runScript(file, JSON.stringify(completed));
    expect(r.status).toBe(0);
    expect(journalLines(dir)).toHaveLength(1);
  });
});

describe("hooks.json safety", () => {
  it("writes through a symlinked hooks.json and keeps the link", async () => {
    const real = join(home, "dotfiles", "cursor-hooks.json");
    mkdirSync(join(home, "dotfiles"), { recursive: true });
    writeFileSync(real, JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: "x" }] } }));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const link = cursorHookPaths(home).hooksFile;
    symlinkSync(real, link);

    await installCursorHook({ home, nodePath: "/usr/local/bin/node" });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const target = JSON.parse(readFileSync(real, "utf8"));
    expect(target.hooks.preToolUse).toEqual([{ command: "x" }]);
    expect(target.hooks.stop).toHaveLength(1);

    await uninstallCursorHook({ home });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8")).hooks.stop).toBeUndefined();
  });

  it("refuses, changing nothing, when hooks.json changed after it was loaded", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const file = cursorHookPaths(home).hooksFile;
    writeFileSync(file, JSON.stringify({ version: 1, hooks: {} }));
    const theirs = JSON.stringify({ version: 1, hooks: { stop: [{ command: "theirs" }] } });
    await expect(
      installCursorHook({
        home,
        nodePath: "/usr/local/bin/node",
        // Cursor (or an editor) writes the file between our read and our write.
        beforeCommit: () => writeFileSync(file, theirs),
      })
    ).rejects.toThrow(/changed while tokmeter was updating it/);
    expect(readFileSync(file, "utf8")).toBe(theirs);
    expect(existsSync(cursorHookPaths(home).scriptFile)).toBe(false);
    expect(existsSync(join(cursorHookPaths(home).journalDir, "coverage.jsonl"))).toBe(false);
    expect(readdirSync(join(home, ".cursor")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("ensureCursorHook (the daemon keeps the hook without a command)", () => {
  const node = process.execPath;
  const ensure = (extra: { enabled?: boolean } = {}) =>
    ensureCursorHook({ home, nodePath: node, now: 1_000, ...extra });
  const ledger = () =>
    readFileSync(join(cursorHookPaths(home).journalDir, "coverage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).event);

  it("writes nothing when Cursor isn't used on this machine", async () => {
    expect(await ensure()).toEqual({ action: "skipped", reason: "no-cursor" });
    expect(existsSync(join(home, ".tokmeter"))).toBe(false);
  });

  it("installs once, then leaves a healthy hook alone", async () => {
    mkdirSync(join(home, ".cursor"));
    expect(await ensure()).toEqual({ action: "installed" });
    expect(cursorHookStatus({ home }).installed).toBe(true);
    const before = readFileSync(cursorHookPaths(home).hooksFile, "utf8");
    expect(await ensure()).toEqual({ action: "ok" });
    expect(readFileSync(cursorHookPaths(home).hooksFile, "utf8")).toBe(before);
    expect(ledger()).toEqual(["installed"]);
  });

  it("is off when the config says so", async () => {
    mkdirSync(join(home, ".cursor"));
    expect(await ensure({ enabled: false })).toEqual({ action: "skipped", reason: "disabled" });
    expect(existsSync(cursorHookPaths(home).hooksFile)).toBe(false);
  });

  it("never reinstalls after the user uninstalled", async () => {
    mkdirSync(join(home, ".cursor"));
    await ensure();
    await uninstallCursorHook({ home, now: 2_000 });
    expect(await ensure()).toEqual({ action: "skipped", reason: "opted-out" });
    expect(cursorHookStatus({ home }).entries).toBe(0);
  });

  it("treats an entry removed by hand as a removal: closes the span, doesn't put it back", async () => {
    mkdirSync(join(home, ".cursor"));
    await ensure();
    const file = cursorHookPaths(home).hooksFile;
    writeFileSync(file, JSON.stringify({ version: 1, hooks: { stop: [] } }));
    expect(await ensure()).toEqual({ action: "skipped", reason: "removed-by-hand" });
    expect(ledger()).toEqual(["installed", "uninstalled"]);
    expect(await ensure()).toEqual({ action: "skipped", reason: "opted-out" });
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.stop).toEqual([]);
  });

  it("refreshes an old or missing script in place", async () => {
    mkdirSync(join(home, ".cursor"));
    await ensure();
    const { scriptFile } = cursorHookPaths(home);
    writeFileSync(scriptFile, "// tokmeter Cursor stop hook, script v0.\n");
    expect(await ensure()).toEqual({ action: "refreshed" });
    rmSync(scriptFile);
    expect(await ensure()).toEqual({ action: "refreshed" });
    expect(cursorHookStatus({ home }).installed).toBe(true);
    expect(ledger()).toEqual(["installed"]);
  });

  it("reports a hooks.json it can't parse and leaves it byte-for-byte", async () => {
    mkdirSync(join(home, ".cursor"));
    await ensure();
    const file = cursorHookPaths(home).hooksFile;
    writeFileSync(file, "{ not json");
    const result = await ensure();
    expect(result.action).toBe("error");
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});
