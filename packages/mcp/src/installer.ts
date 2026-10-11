/**
 * @sriinnu/tokmeter-mcp — Installer for statusline and MCP across all AI coding agents.
 *
 * Supports:
 *   - Claude Code (statusline in ~/.claude/settings.json; MCP via
 *     `claude mcp add --scope user`, which stores it in ~/.claude.json)
 *   - OpenCode (MCP in ~/.config/opencode/opencode.json under `mcp`)
 *   - Codex (~/.codex/settings.json)
 *   - Cursor (~/.cursor/mcp.json for MCP)
 *   - Windsurf (~/.windsurf/mcp.json for MCP)
 *   - Zed (~/.config/zed/settings.json)
 *   - VS Code Copilot (~/.vscode/settings.json)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { C } from "./formatter.js";

// ─── CLI Command Resolution ────────────────────────────────────────────────
// Prefer the local compiled dist (node). Fall back to npx @sriinnu/tokmeter-mcp.
// We always use node + dist/cli.js for installed commands because:
//  1. node is always in PATH (bun may not be in Claude Code's subprocess env)
//  2. dist/cli.js works without a TypeScript runtime
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_DIST_CLI = resolve(__dirname, "..", "dist", "cli.js");
const IS_LOCAL = existsSync(LOCAL_DIST_CLI);

function cliCommand(subcommand: string): { command: string; args?: string[] } {
  if (IS_LOCAL) {
    return { command: "node", args: [LOCAL_DIST_CLI, subcommand] };
  }
  return { command: "npx", args: ["-y", "@sriinnu/tokmeter-mcp", subcommand] };
}

function cliCommandString(subcommand: string): string {
  if (IS_LOCAL) return `node ${LOCAL_DIST_CLI} ${subcommand}`;
  return `npx -y @sriinnu/tokmeter-mcp ${subcommand}`;
}

/** Key the MCP server is registered under in each editor's config. */
const MCP_SERVER_NAME = "tokmeter";
/** Keys earlier releases registered; removed on install and uninstall. */
const LEGACY_MCP_SERVER_NAMES = ["drishti"];

// ─── Editor Configurations ───────────────────────────────────────────────────

interface EditorConfig {
  name: string;
  settingsPath: string;
  mcpPath?: string;
  mcpKey?: string; // JSON key for MCP servers (default: "mcpServers", Zed uses "context_servers")
  configPath?: string; // For editors that use a different config file for MCP (e.g., Codex uses config.toml)
  configFormat?: "json" | "toml";
  /**
   * Register MCP through the editor's own CLI instead of editing a file.
   * Claude Code reads MCP servers from ~/.claude.json (its live state file)
   * and never from settings.json, so it goes through `claude mcp add`.
   */
  mcpVia?: "claude-cli";
  /**
   * Shape of the server entry written under `mcpKey`. Defaults to the common
   * `{ command, args }`; OpenCode wants `{ type: "local", command: [...], enabled }`.
   */
  mcpEntry?: (cmd: { command: string; args?: string[] }) => Record<string, unknown>;
  /**
   * Where earlier tokmeter releases wrongly registered this editor's server.
   * Our own entries (tokmeter + legacy names) are removed from these on
   * install and uninstall; nothing else in the file is touched.
   */
  legacyMcpLocations?: { path: string; key: string }[];
  /** A sibling config file that, if it exists instead of mcpPath, we must not shadow. */
  mcpPathAlternate?: string;
  supportsStatusline: boolean;
  supportsMCP: boolean;
}

const EDITORS: EditorConfig[] = [
  {
    name: "Claude Code",
    settingsPath: `${homedir()}/.claude/settings.json`,
    mcpVia: "claude-cli",
    supportsStatusline: true,
    supportsMCP: true,
  },
  {
    name: "OpenCode",
    settingsPath: `${homedir()}/.config/opencode/settings.json`,
    // https://opencode.ai/docs/config/ — global config is
    // ~/.config/opencode/opencode.json; https://opencode.ai/docs/mcp-servers/
    // — servers live under `mcp` as { type: "local", command: [...], enabled }.
    mcpPath: `${homedir()}/.config/opencode/opencode.json`,
    mcpPathAlternate: `${homedir()}/.config/opencode/opencode.jsonc`,
    mcpKey: "mcp",
    // Releases up to 1.14.1 wrote mcpServers.tokmeter into settings.json,
    // which OpenCode doesn't read for MCP.
    legacyMcpLocations: [
      { path: `${homedir()}/.config/opencode/settings.json`, key: "mcpServers" },
    ],
    mcpEntry: (cmd) => ({
      type: "local",
      command: [cmd.command, ...(cmd.args ?? [])],
      enabled: true,
    }),
    supportsStatusline: true,
    supportsMCP: true,
  },
  {
    name: "Codex",
    settingsPath: `${homedir()}/.codex/settings.json`,
    configPath: `${homedir()}/.codex/config.toml`,
    configFormat: "toml",
    supportsStatusline: false, // Codex Rust doesn't support custom statusline hooks
    supportsMCP: true,
  },
  {
    name: "Cursor",
    settingsPath: `${homedir()}/.cursor/settings.json`,
    mcpPath: `${homedir()}/.cursor/mcp.json`,
    supportsStatusline: false,
    supportsMCP: true,
  },
  {
    name: "Windsurf",
    settingsPath: `${homedir()}/.windsurf/settings.json`,
    mcpPath: `${homedir()}/.windsurf/mcp.json`,
    supportsStatusline: false,
    supportsMCP: true,
  },
  {
    name: "Zed",
    settingsPath: `${homedir()}/.config/zed/settings.json`,
    mcpKey: "context_servers", // Zed uses context_servers, not mcpServers
    supportsStatusline: false,
    supportsMCP: true,
  },
  {
    name: "VS Code Copilot",
    settingsPath: `${homedir()}/.vscode/settings.json`,
    supportsStatusline: false,
    supportsMCP: false, // VS Code Copilot doesn't support MCP yet
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read a JSON config file. Returns null if missing or corrupt.
 * If corrupt, prints a warning and sets `_lastReadCorrupt` so callers can skip.
 */
let _lastReadCorrupt = false;

function readJSON<T>(path: string): T | null {
  _lastReadCorrupt = false;
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    _lastReadCorrupt = true;
    return null;
  }
}

/** Returns true (and prints a warning) if the last readJSON hit a corrupt file. */
function wasCorrupt(filePath: string, editorName: string): boolean {
  if (_lastReadCorrupt) {
    console.log(
      C.danger(`  ✗ ${editorName} — ${filePath} has a JSON syntax error, refusing to modify`)
    );
    return true;
  }
  return false;
}

function writeJSON<T>(path: string, data: T): void {
  ensureDir(path);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/**
 * Remove tokmeter's own entries (current + legacy names) from the places an
 * earlier release wrongly registered them. Leaves a corrupt file untouched.
 */
function removeMisplacedEntries(editor: EditorConfig): void {
  for (const loc of editor.legacyMcpLocations ?? []) {
    const config = readJSON<Record<string, unknown>>(loc.path);
    if (!config || _lastReadCorrupt) continue;
    const servers = config[loc.key];
    if (!servers || typeof servers !== "object") continue;
    const names = [MCP_SERVER_NAME, ...LEGACY_MCP_SERVER_NAMES].filter(
      (name) => name in (servers as Record<string, unknown>)
    );
    if (names.length === 0) continue;
    const remaining = { ...(servers as Record<string, unknown>) };
    for (const name of names) delete remaining[name];
    if (Object.keys(remaining).length === 0) delete config[loc.key];
    else config[loc.key] = remaining;
    writeJSON(loc.path, config);
    console.log(C.dim(`    removed misplaced ${names.join(", ")} entry from ${loc.path}`));
  }
}

// ─── TOML Helpers (for Codex) ───────────────────────────────────────────────

/**
 * Generate TOML config for MCP server.
 * Returns the content to append or the full config if file doesn't exist.
 */
function generateMcpToml(
  existingContent: string | null,
  serverName: string,
  config: { command: string; args?: string[] }
): string {
  const serverBlock = `\n[mcp_servers.${serverName}]\ncommand = "${config.command}"${config.args ? `\nargs = ${JSON.stringify(config.args)}` : ""}\n`;

  if (!existingContent) {
    return `# MCP Servers\n${serverBlock}`;
  }

  // Check if server already exists
  if (existingContent.includes(`[mcp_servers.${serverName}]`)) {
    return existingContent; // Already exists, don't modify
  }

  // Append to existing content
  return `${existingContent.trimEnd()}\n${serverBlock}`;
}

/**
 * Remove MCP server from TOML config.
 */
function removeMcpFromToml(content: string, serverName: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let skipUntilNextSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for the server we want to remove
    if (trimmed === `[mcp_servers.${serverName}]`) {
      skipUntilNextSection = true;
      continue;
    }

    // Check for any new section header (stop skipping)
    if (skipUntilNextSection && trimmed.startsWith("[")) {
      skipUntilNextSection = false;
    }

    if (!skipUntilNextSection) {
      result.push(line);
    }
  }

  return `${result.join("\n").trimEnd()}\n`;
}

// ─── Statusline Installer ───────────────────────────────────────────────────

interface SettingsWithStatusLine {
  statusLine?: { type: string; command: string };
}

export function installStatusline(editors?: string[]): void {
  const targetEditors = editors
    ? EDITORS.filter((e) => editors.some((t) => e.name.toLowerCase().includes(t.toLowerCase())))
    : EDITORS.filter((e) => e.supportsStatusline);

  console.log(C.title("\n【♾️】 Installing Statusline\n"));

  const command = cliCommandString("statusline");
  let installed = 0;
  let skipped = 0;

  for (const editor of targetEditors) {
    if (!editor.supportsStatusline) {
      console.log(C.dim(`  ⊘ ${editor.name} — statusline not supported`));
      skipped++;
      continue;
    }

    const raw = readJSON<SettingsWithStatusLine>(editor.settingsPath);
    if (wasCorrupt(editor.settingsPath, editor.name)) {
      skipped++;
      continue;
    }
    const settings = raw ?? {};

    // Check if already installed with the LOCAL command
    if (settings.statusLine?.command === command) {
      console.log(C.accent(`  ✓ ${editor.name} — already installed`));
      continue;
    }

    // Add the statusline (top-level statusLine key)
    settings.statusLine = { type: "command", command };
    writeJSON(editor.settingsPath, settings);

    console.log(C.success(`  ✓ ${editor.name} — installed`));
    console.log(C.dim(`    ${editor.settingsPath}`));
    installed++;
  }

  console.log();
  console.log(C.dim(`Installed: ${installed}, Skipped: ${skipped}`));
  console.log(C.accent("\nRestart your editor(s) to activate the statusline.\n"));
}

// ─── MCP Installer ──────────────────────────────────────────────────────────

// ─── Claude Code via its CLI ────────────────────────────────────────────────

interface ClaudeCliResult {
  /** Exit status; -1 when the binary could not be run at all. */
  status: number;
  output: string;
  /** `claude` is not on PATH. */
  missing: boolean;
}

/** Run `claude <args>` without a shell. Never throws. */
function runClaude(args: string[]): ClaudeCliResult {
  try {
    const output = execFileSync("claude", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { status: 0, output: String(output ?? ""), missing: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    if (e.code === "ENOENT") return { status: -1, output: "", missing: true };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    return { status: typeof e.status === "number" ? e.status : 1, output, missing: false };
  }
}

function claudeAddCommand(): string {
  return `claude mcp add ${MCP_SERVER_NAME} --scope user -- ${cliCommandString("serve")}`;
}

/**
 * Earlier releases wrote an mcpServers entry into ~/.claude/settings.json,
 * which Claude Code never loads. Point it out; never edit the user's file.
 */
function noteInertClaudeSettingsEntries(editor: EditorConfig): void {
  const settings = readJSON<Record<string, unknown>>(editor.settingsPath);
  const servers = (settings?.mcpServers ?? {}) as Record<string, unknown>;
  const inert = [MCP_SERVER_NAME, ...LEGACY_MCP_SERVER_NAMES].filter((name) => name in servers);
  if (inert.length === 0) return;
  console.log(
    C.dim(
      `    note: ${editor.settingsPath} has an mcpServers entry (${inert.join(", ")}) from an earlier tokmeter install. Claude Code doesn't load MCP servers from that file, so it does nothing and is safe to remove.`
    )
  );
}

type ClaudeInstallOutcome = "installed" | "already" | "manual" | "failed";

function installClaudeCodeMCP(editor: EditorConfig): ClaudeInstallOutcome {
  noteInertClaudeSettingsEntries(editor);
  const existing = runClaude(["mcp", "get", MCP_SERVER_NAME]);
  if (existing.missing) {
    console.log(C.accent(`  ⊘ ${editor.name} — the claude CLI isn't on PATH. Run:`));
    console.log(`    ${claudeAddCommand()}`);
    return "manual";
  }
  if (existing.status === 0) {
    console.log(C.accent(`  ✓ ${editor.name} — already installed`));
    return "already";
  }
  const cmd = cliCommand("serve");
  const added = runClaude([
    "mcp",
    "add",
    MCP_SERVER_NAME,
    "--scope",
    "user",
    "--",
    cmd.command,
    ...(cmd.args ?? []),
  ]);
  if (added.status === 0) {
    console.log(C.success(`  ✓ ${editor.name} — installed (user scope, via claude mcp add)`));
    return "installed";
  }
  console.log(C.danger(`  ✗ ${editor.name} — claude mcp add failed (exit ${added.status})`));
  if (added.output) console.log(C.dim(`    ${added.output.split("\n").join("\n    ")}`));
  console.log(C.dim(`    To add it by hand: ${claudeAddCommand()}`));
  return "failed";
}

function uninstallClaudeCodeMCP(editor: EditorConfig): void {
  noteInertClaudeSettingsEntries(editor);
  const removed = runClaude(["mcp", "remove", MCP_SERVER_NAME, "--scope", "user"]);
  if (removed.missing) {
    console.log(C.accent(`  ⊘ ${editor.name} — the claude CLI isn't on PATH. Run:`));
    console.log(`    claude mcp remove ${MCP_SERVER_NAME} --scope user`);
    return;
  }
  if (removed.status === 0) {
    console.log(C.success(`  ✓ ${editor.name} — uninstalled`));
  } else {
    console.log(C.dim(`  ⊘ ${editor.name} — not installed (user scope)`));
  }
}

export function installMCP(editors?: string[]): void {
  const targetEditors = editors
    ? EDITORS.filter((e) => editors.some((t) => e.name.toLowerCase().includes(t.toLowerCase())))
    : EDITORS.filter((e) => e.supportsMCP);

  console.log(C.title("\n【♾️】 Installing MCP Server\n"));

  const serverName = MCP_SERVER_NAME;
  let installed = 0;
  let skipped = 0;

  for (const editor of targetEditors) {
    if (!editor.supportsMCP) {
      console.log(C.dim(`  ⊘ ${editor.name} — MCP not supported`));
      skipped++;
      continue;
    }

    if (editor.mcpVia === "claude-cli") {
      const outcome = installClaudeCodeMCP(editor);
      if (outcome === "installed") installed++;
      else if (outcome === "manual" || outcome === "failed") skipped++;
      continue;
    }

    // Handle TOML-based configs (Codex)
    if (editor.configFormat === "toml") {
      const configPath = editor.configPath ?? editor.settingsPath;
      let existingContent = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
      const beforeMigration = existingContent;
      for (const legacy of LEGACY_MCP_SERVER_NAMES) {
        if (existingContent?.includes(`[mcp_servers.${legacy}]`)) {
          existingContent = removeMcpFromToml(existingContent, legacy);
        }
      }
      if (existingContent !== beforeMigration && existingContent !== null) {
        writeFileSync(configPath, existingContent, "utf-8");
        console.log(C.dim(`    removed legacy drishti entry from ${editor.name}`));
      }

      // Check if already installed
      if (existingContent?.includes(`[mcp_servers.${serverName}]`)) {
        console.log(C.accent(`  ✓ ${editor.name} — already installed`));
        continue;
      }

      // Generate and write TOML config
      const newContent = generateMcpToml(existingContent, serverName, cliCommand("mcp"));

      ensureDir(configPath);
      writeFileSync(configPath, newContent, "utf-8");

      console.log(C.success(`  ✓ ${editor.name} — installed`));
      console.log(C.dim(`    ${configPath}`));
      installed++;
      continue;
    }

    // Handle JSON-based configs (other editors)
    // Some editors use a separate mcp.json file
    removeMisplacedEntries(editor);
    const mcpPath = editor.mcpPath ?? editor.settingsPath;
    const mcpKey = editor.mcpKey ?? "mcpServers";

    // JSONC (comments) can't be round-tripped by JSON.parse/stringify. If the
    // user keeps their config in the .jsonc sibling, don't create a second
    // file next to it — print the entry to add by hand instead.
    if (editor.mcpPathAlternate && !existsSync(mcpPath) && existsSync(editor.mcpPathAlternate)) {
      const entry = (editor.mcpEntry ?? ((c) => c))(cliCommand("mcp"));
      console.log(
        C.accent(
          `  ⊘ ${editor.name} — ${editor.mcpPathAlternate} exists; add this under "${mcpKey}":`
        )
      );
      console.log(`    "${serverName}": ${JSON.stringify(entry)}`);
      skipped++;
      continue;
    }

    // For editors with separate MCP files, read that; otherwise read settings
    const rawMcp = readJSON<Record<string, unknown>>(mcpPath);
    if (wasCorrupt(mcpPath, editor.name)) {
      skipped++;
      continue;
    }
    const config = rawMcp ?? {};

    const existingServers = { ...((config[mcpKey] ?? {}) as Record<string, unknown>) };
    const hadLegacy = LEGACY_MCP_SERVER_NAMES.some((legacy) => legacy in existingServers);
    for (const legacy of LEGACY_MCP_SERVER_NAMES) delete existingServers[legacy];
    if (hadLegacy) {
      config[mcpKey] = existingServers;
      writeJSON(mcpPath, config);
      console.log(C.dim(`    removed legacy drishti entry from ${editor.name}`));
    }

    // Check if already installed
    if (existingServers[serverName]) {
      console.log(C.accent(`  ✓ ${editor.name} — already installed`));
      continue;
    }

    // Add the MCP server under the correct key for this editor
    config[mcpKey] = {
      ...existingServers,
      [serverName]: editor.mcpEntry ? editor.mcpEntry(cliCommand("mcp")) : cliCommand("mcp"),
    };

    writeJSON(mcpPath, config);

    console.log(C.success(`  ✓ ${editor.name} — installed`));
    console.log(C.dim(`    ${mcpPath}`));
    installed++;
  }

  console.log();
  console.log(C.dim(`Installed: ${installed}, Skipped: ${skipped}`));
  console.log(C.accent("\nRestart your editor(s) to activate the MCP server.\n"));
  console.log(C.dim("Start with tokmeter_pulse; tokmeter-mcp help lists every tool.\n"));
}

// ─── Uninstaller ────────────────────────────────────────────────────────────

export function uninstallStatusline(editors?: string[]): void {
  const targetEditors = editors
    ? EDITORS.filter((e) => editors.some((t) => e.name.toLowerCase().includes(t.toLowerCase())))
    : EDITORS.filter((e) => e.supportsStatusline);

  console.log(C.title("\n【♾️】 Uninstalling Statusline\n"));

  for (const editor of targetEditors) {
    if (!editor.supportsStatusline) continue;

    const settings = readJSON<SettingsWithStatusLine>(editor.settingsPath);
    if (!settings?.statusLine) {
      console.log(C.dim(`  ⊘ ${editor.name} — not installed`));
      continue;
    }

    // biome-ignore lint/performance/noDelete: required to remove property from object
    delete settings.statusLine;
    writeJSON(editor.settingsPath, settings);
    console.log(C.success(`  ✓ ${editor.name} — uninstalled`));
  }

  console.log();
}

export function uninstallMCP(editors?: string[]): void {
  const targetEditors = editors
    ? EDITORS.filter((e) => editors.some((t) => e.name.toLowerCase().includes(t.toLowerCase())))
    : EDITORS.filter((e) => e.supportsMCP);

  console.log(C.title("\n【♾️】 Uninstalling MCP Server\n"));

  for (const editor of targetEditors) {
    if (!editor.supportsMCP) continue;

    if (editor.mcpVia === "claude-cli") {
      uninstallClaudeCodeMCP(editor);
      continue;
    }

    // Handle TOML-based configs (Codex)
    if (editor.configFormat === "toml") {
      const configPath = editor.configPath ?? editor.settingsPath;

      if (!existsSync(configPath)) {
        console.log(C.dim(`  ⊘ ${editor.name} — not installed`));
        continue;
      }

      const content = readFileSync(configPath, "utf-8");
      const names = [MCP_SERVER_NAME, ...LEGACY_MCP_SERVER_NAMES].filter((name) =>
        content.includes(`[mcp_servers.${name}]`)
      );

      if (names.length === 0) {
        console.log(C.dim(`  ⊘ ${editor.name} — not installed`));
        continue;
      }

      const newContent = names.reduce((acc, name) => removeMcpFromToml(acc, name), content);
      writeFileSync(configPath, newContent, "utf-8");
      console.log(C.success(`  ✓ ${editor.name} — uninstalled`));
      continue;
    }

    // Handle JSON-based configs (other editors)
    removeMisplacedEntries(editor);
    const mcpPath = editor.mcpPath ?? editor.settingsPath;
    const mcpKey = editor.mcpKey ?? "mcpServers";
    const config = readJSON<Record<string, unknown>>(mcpPath);

    const servers = (config?.[mcpKey] ?? {}) as Record<string, unknown>;
    const names = [MCP_SERVER_NAME, ...LEGACY_MCP_SERVER_NAMES].filter((name) => name in servers);
    if (names.length === 0) {
      console.log(C.dim(`  ⊘ ${editor.name} — not installed`));
      continue;
    }

    const remainingServers = { ...servers };
    for (const name of names) delete remainingServers[name];

    if (Object.keys(remainingServers).length === 0) {
      delete config![mcpKey];
    } else {
      config![mcpKey] = remainingServers;
    }

    writeJSON(mcpPath, config!);
    console.log(C.success(`  ✓ ${editor.name} — uninstalled`));
  }

  console.log();
}

// ─── Hooks Installer (Claude Code only) ─────────────────────────────────────

interface HookEntry {
  type: string;
  command: string;
}

interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

interface SettingsWithHooks {
  hooks?: Record<string, HookMatcher[]>;
}

/** Guard hooks config — references ~/Sriinnu/Personal/script-helpers/ */
function getGuardHooks(): Record<string, HookMatcher[]> {
  const dir = `${homedir()}/Sriinnu/Personal/script-helpers`;
  return {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: `bash ${dir}/danger-guard.sh "$CLAUDE_BASH_COMMAND"`,
          },
          {
            type: "command",
            command: `bash ${dir}/network-guard.sh "$CLAUDE_BASH_COMMAND"`,
          },
        ],
      },
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `bash ${dir}/sensitive-guard.sh "$CLAUDE_TOOL_NAME" "$CLAUDE_TOOL_INPUT"`,
          },
          {
            type: "command",
            command: `bash ${dir}/danger-guard.sh "$CLAUDE_TOOL_INPUT"`,
          },
        ],
      },
    ],
  };
}

export function installHooks(): void {
  console.log(C.title("\n【♾️】 Installing Guard Hooks\n"));

  const editor = EDITORS.find((e) => e.name === "Claude Code")!;
  const rawSettings = readJSON<Record<string, unknown>>(editor.settingsPath);
  if (wasCorrupt(editor.settingsPath, "Claude Code")) {
    console.log();
    return;
  }
  const settings = rawSettings ?? {};
  const expected = getGuardHooks();

  // Check if guard hooks are already present and up to date
  const existing = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const guardMatchers = expected.PreToolUse;
  const existingPre = (existing.PreToolUse ?? []) as HookMatcher[];

  // Check if our guard matchers are already in PreToolUse
  const guardJson = JSON.stringify(guardMatchers);
  const hasGuards =
    existingPre.length >= guardMatchers.length &&
    JSON.stringify(existingPre.slice(0, guardMatchers.length)) === guardJson;

  if (hasGuards) {
    console.log(C.accent("  ✓ Claude Code — hooks already installed and up to date"));
    console.log();
    return;
  }

  // Merge: replace our guard matchers at the start, preserve any user-added hooks
  const userHooks = existingPre.filter(
    (m) => !guardMatchers.some((g) => JSON.stringify(g) === JSON.stringify(m))
  );
  settings.hooks = {
    ...existing,
    PreToolUse: [...guardMatchers, ...userHooks],
  };
  writeJSON(editor.settingsPath, settings);

  console.log(C.success("  ✓ Claude Code — guard hooks installed"));
  console.log(C.dim(`    ${editor.settingsPath}`));
  console.log();
  console.log(C.dim("Hooks installed:"));
  console.log(C.dim("  • danger-guard.sh  — blocks destructive commands"));
  console.log(C.dim("  • network-guard.sh — blocks unauthorized network access"));
  console.log(C.dim("  • sensitive-guard.sh — guards sensitive file access\n"));
}

export function uninstallHooks(): void {
  console.log(C.title("\n【♾️】 Uninstalling Guard Hooks\n"));

  const editor = EDITORS.find((e) => e.name === "Claude Code")!;
  const settings = readJSON<SettingsWithHooks>(editor.settingsPath);

  if (!settings?.hooks) {
    console.log(C.dim("  ⊘ Claude Code — no hooks installed"));
    console.log();
    return;
  }

  // biome-ignore lint/performance/noDelete: required to remove property from object
  delete settings.hooks;
  writeJSON(editor.settingsPath, settings);

  console.log(C.success("  ✓ Claude Code — hooks removed"));
  console.log();
}

// ─── Install All ────────────────────────────────────────────────────────────

export function installAll(): void {
  console.log(C.title("\n【♾️】 Full Restore — Statusline + MCP + Hooks\n"));
  installStatusline();
  installMCP();
  installHooks();
  console.log(C.accent("Done. Restart your editor(s) to activate everything.\n"));
}

// ─── List Editors ───────────────────────────────────────────────────────────

export function listEditors(): void {
  console.log(C.title("\n【♾️】 Supported Editors\n"));

  for (const editor of EDITORS) {
    const statusline = editor.supportsStatusline
      ? C.success("✓ statusline")
      : C.dim("✗ statusline");
    const mcp = editor.supportsMCP ? C.success("✓ mcp") : C.dim("✗ mcp");
    console.log(`  ${C.accent(editor.name)} ${statusline} ${mcp}`);
    console.log(C.dim(`    ${editor.settingsPath}`));
    if (editor.mcpVia === "claude-cli") {
      console.log(C.dim("    MCP: claude mcp add --scope user (stored in ~/.claude.json)"));
    } else if (editor.mcpPath) {
      console.log(C.dim(`    ${editor.mcpPath}`));
    }
  }

  console.log();
}
