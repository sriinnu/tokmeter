import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// A throwaway home so the installer can never read or write the real
// ~/.claude/settings.json, and a mocked `claude` CLI so nothing runs.
const { home, execFileSync } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), "tokmeter-installer-")),
    execFileSync: vi.fn(),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync };
});

const { installAll, installHooks, installMCP, uninstallHooks, uninstallMCP } = await import(
  "./installer.js"
);

const settingsPath = join(home, ".claude", "settings.json");

function cliError(status: number, stderr = ""): Error {
  return Object.assign(new Error(`exit ${status}`), { status, stdout: "", stderr });
}

function calls(): string[][] {
  return execFileSync.mock.calls.map((c) => [c[0] as string, ...(c[1] as string[])]);
}

beforeEach(() => {
  execFileSync.mockReset();
  rmSync(join(home, ".claude"), { recursive: true, force: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("installMCP — Claude Code", () => {
  it("registers through `claude mcp add --scope user` when the CLI is present", () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === "get") throw cliError(1, 'No MCP server named "tokmeter".');
      return "Added stdio MCP server tokmeter";
    });

    installMCP(["claude"]);

    const [get, add] = calls();
    expect(get).toEqual(["claude", "mcp", "get", "tokmeter"]);
    expect(add.slice(0, 7)).toEqual(["claude", "mcp", "add", "tokmeter", "--scope", "user", "--"]);
    expect(add.at(-1)).toBe("serve");
    // No shell: arguments go as an array, never a command string.
    for (const c of execFileSync.mock.calls) expect(Array.isArray(c[1])).toBe(true);
  });

  it("reports already installed and doesn't add twice", () => {
    execFileSync.mockReturnValue("tokmeter:\n  Scope: User config");

    installMCP(["claude"]);

    expect(calls()).toEqual([["claude", "mcp", "get", "tokmeter"]]);
    const out = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .flat()
      .join("\n");
    expect(out).toContain("already installed");
  });

  it("prints the command to run when `claude` is not on PATH", () => {
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    });

    installMCP(["claude"]);

    expect(calls()).toHaveLength(1);
    const out = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .flat()
      .join("\n");
    expect(out).toMatch(/claude mcp add tokmeter --scope user -- .+ serve/);
  });

  it("never writes ~/.claude/settings.json, and flags an inert legacy entry", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const original = `${JSON.stringify(
      { statusLine: { type: "command" }, mcpServers: { drishti: { command: "npx" } } },
      null,
      2
    )}\n`;
    writeFileSync(settingsPath, original);
    execFileSync.mockReturnValue("ok");

    installMCP(["claude"]);

    expect(readFileSync(settingsPath, "utf-8")).toBe(original);
    const out = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .flat()
      .join("\n");
    expect(out).toContain("doesn't load MCP servers from that file");
  });
});

describe("uninstallMCP — Claude Code", () => {
  it("removes through `claude mcp remove --scope user`", () => {
    execFileSync.mockReturnValue("Removed");

    uninstallMCP(["claude"]);

    expect(calls()).toEqual([["claude", "mcp", "remove", "tokmeter", "--scope", "user"]]);
  });
});

describe("installMCP — OpenCode", () => {
  const dir = join(home, ".config", "opencode");
  const configPath = join(dir, "opencode.json");
  const oldSettings = join(dir, "settings.json");
  const read = (p: string) => JSON.parse(readFileSync(p, "utf-8"));

  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });

  it("writes a local entry under `mcp` in opencode.json, keeping other keys", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: { other: { type: "remote" } },
      })
    );

    installMCP(["opencode"]);

    const config = read(configPath);
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect(config.mcp.other).toEqual({ type: "remote" });
    expect(config.mcp.tokmeter.type).toBe("local");
    expect(config.mcp.tokmeter.enabled).toBe(true);
    expect(Array.isArray(config.mcp.tokmeter.command)).toBe(true);
    expect(config.mcp.tokmeter.command.at(-1)).toBe("mcp");
    expect(config.mcpServers).toBeUndefined();
  });

  it("migrates the legacy drishti entry and the misplaced settings.json entry", () => {
    writeFileSync(configPath, JSON.stringify({ mcp: { drishti: { type: "local" } } }));
    writeFileSync(
      oldSettings,
      JSON.stringify({ theme: "x", mcpServers: { tokmeter: { command: "node" }, keep: {} } })
    );

    installMCP(["opencode"]);

    expect(read(configPath).mcp.drishti).toBeUndefined();
    expect(read(configPath).mcp.tokmeter.type).toBe("local");
    expect(read(oldSettings)).toEqual({ theme: "x", mcpServers: { keep: {} } });
  });

  it("does not create opencode.json beside an existing opencode.jsonc", () => {
    writeFileSync(join(dir, "opencode.jsonc"), "{ // comments\n}\n");

    installMCP(["opencode"]);

    expect(() => readFileSync(configPath)).toThrow();
  });

  it("uninstalls from opencode.json", () => {
    installMCP(["opencode"]);
    uninstallMCP(["opencode"]);

    expect(read(configPath).mcp).toBeUndefined();
  });
});

describe("guard hooks — legacy cleanup", () => {
  // What releases up to 1.19.3 wrote, for some other user's home.
  const dir = "/Users/someone/Sriinnu/Personal/script-helpers";
  const legacy = [
    {
      matcher: "Bash",
      hooks: [
        { type: "command", command: `bash ${dir}/danger-guard.sh "$CLAUDE_BASH_COMMAND"` },
        { type: "command", command: `bash ${dir}/network-guard.sh "$CLAUDE_BASH_COMMAND"` },
      ],
    },
    {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: `bash ${dir}/sensitive-guard.sh "$CLAUDE_TOOL_NAME" "$CLAUDE_TOOL_INPUT"`,
        },
        { type: "command", command: `bash ${dir}/danger-guard.sh "$CLAUDE_TOOL_INPUT"` },
      ],
    },
  ];
  const mine = { matcher: "Edit", hooks: [{ type: "command", command: "prettier --check" }] };
  const mixed = {
    matcher: "Write",
    hooks: [
      { type: "command", command: `bash ${dir}/danger-guard.sh x` },
      { type: "command", command: "my-own-check.sh" },
    ],
  };

  function writeSettings(data: unknown) {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(data));
  }
  const readSettings = () => JSON.parse(readFileSync(settingsPath, "utf-8"));

  it("install-hooks writes nothing", () => {
    installHooks();
    expect(() => readFileSync(settingsPath)).toThrow();
  });

  it("install-all no longer adds hooks", () => {
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    installAll();
    expect(JSON.stringify(readSettings())).not.toContain("guard.sh");
  });

  it("removes only the legacy guards and keeps every hook the user set", () => {
    const stop = [{ matcher: "", hooks: [{ type: "command", command: "say done" }] }];
    writeSettings({ model: "opus", hooks: { PreToolUse: [...legacy, mine, mixed], Stop: stop } });

    uninstallHooks();

    expect(readSettings()).toEqual({
      model: "opus",
      hooks: {
        PreToolUse: [
          mine,
          { matcher: "Write", hooks: [{ type: "command", command: "my-own-check.sh" }] },
        ],
        Stop: stop,
      },
    });
  });

  it("drops the hooks key once only legacy guards were in it", () => {
    writeSettings({ model: "opus", hooks: { PreToolUse: legacy } });
    uninstallHooks();
    expect(readSettings()).toEqual({ model: "opus" });
  });

  it("leaves the file untouched when there are no legacy guards", () => {
    const raw = JSON.stringify({ hooks: { PreToolUse: [mine] } });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath, raw);
    uninstallHooks();
    expect(readFileSync(settingsPath, "utf-8")).toBe(raw);
  });
});
