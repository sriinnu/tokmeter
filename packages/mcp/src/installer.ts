/**
 * @sriinnu/drishti — Installer for statusline and MCP across all AI coding agents.
 *
 * Supports:
 *   - Claude Code (~/.claude/settings.json)
 *   - OpenCode (~/.config/opencode/settings.json)
 *   - Codex (~/.codex/settings.json)
 *   - Cursor (~/.cursor/mcp.json for MCP)
 *   - Windsurf (~/.windsurf/mcp.json for MCP)
 *   - Zed (~/.config/zed/settings.json)
 *   - VS Code Copilot (~/.vscode/settings.json)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { C } from "./formatter.js";

// ─── Editor Configurations ───────────────────────────────────────────────────

interface EditorConfig {
  name: string;
  settingsPath: string;
  mcpPath?: string;
  configPath?: string; // For editors that use a different config file for MCP (e.g., Codex uses config.toml)
  configFormat?: "json" | "toml";
  supportsStatusline: boolean;
  supportsMCP: boolean;
}

const EDITORS: EditorConfig[] = [
  {
    name: "Claude Code",
    settingsPath: `${homedir()}/.claude/settings.json`,
    supportsStatusline: true,
    supportsMCP: true,
  },
  {
    name: "OpenCode",
    settingsPath: `${homedir()}/.config/opencode/settings.json`,
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

function readJSON<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function writeJSON<T>(path: string, data: T): void {
  ensureDir(path);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
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

  const command = "npx -y @sriinnu/drishti statusline";
  let installed = 0;
  let skipped = 0;

  for (const editor of targetEditors) {
    if (!editor.supportsStatusline) {
      console.log(C.dim(`  ⊘ ${editor.name} — statusline not supported`));
      skipped++;
      continue;
    }

    const settings = readJSON<SettingsWithStatusLine>(editor.settingsPath) ?? {};

    // Check if already installed
    if (settings.statusLine?.command?.includes("@sriinnu/drishti")) {
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

interface SettingsWithMCP {
  mcpServers?: Record<string, { command: string; args?: string[] }>;
}

interface MCPConfig {
  mcpServers?: Record<string, { command: string; args?: string[] }>;
}

export function installMCP(editors?: string[]): void {
  const targetEditors = editors
    ? EDITORS.filter((e) => editors.some((t) => e.name.toLowerCase().includes(t.toLowerCase())))
    : EDITORS.filter((e) => e.supportsMCP);

  console.log(C.title("\n【♾️】 Installing MCP Server\n"));

  const serverName = "drishti";
  let installed = 0;
  let skipped = 0;

  for (const editor of targetEditors) {
    if (!editor.supportsMCP) {
      console.log(C.dim(`  ⊘ ${editor.name} — MCP not supported`));
      skipped++;
      continue;
    }

    // Handle TOML-based configs (Codex)
    if (editor.configFormat === "toml") {
      const configPath = editor.configPath ?? editor.settingsPath;
      const existingContent = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;

      // Check if already installed
      if (existingContent?.includes(`[mcp_servers.${serverName}]`)) {
        console.log(C.accent(`  ✓ ${editor.name} — already installed`));
        continue;
      }

      // Generate and write TOML config
      const newContent = generateMcpToml(existingContent, serverName, {
        command: "npx",
        args: ["-y", "@sriinnu/drishti", "mcp"],
      });

      ensureDir(configPath);
      writeFileSync(configPath, newContent, "utf-8");

      console.log(C.success(`  ✓ ${editor.name} — installed`));
      console.log(C.dim(`    ${configPath}`));
      installed++;
      continue;
    }

    // Handle JSON-based configs (other editors)
    // Some editors use a separate mcp.json file
    const mcpPath = editor.mcpPath ?? editor.settingsPath;

    // For editors with separate MCP files, read that; otherwise read settings
    const config = editor.mcpPath
      ? (readJSON<MCPConfig>(editor.mcpPath) ?? { mcpServers: {} })
      : ((readJSON<SettingsWithMCP>(editor.settingsPath) as SettingsWithMCP | null) ?? {
          mcpServers: {},
        });

    const existingServers = config.mcpServers ?? {};

    // Check if already installed
    if (existingServers[serverName]) {
      console.log(C.accent(`  ✓ ${editor.name} — already installed`));
      continue;
    }

    // Add the MCP server
    config.mcpServers = {
      ...existingServers,
      [serverName]: {
        command: "npx",
        args: ["-y", "@sriinnu/drishti", "mcp"],
      },
    };

    writeJSON(mcpPath, config);

    console.log(C.success(`  ✓ ${editor.name} — installed`));
    console.log(C.dim(`    ${mcpPath}`));
    installed++;
  }

  console.log();
  console.log(C.dim(`Installed: ${installed}, Skipped: ${skipped}`));
  console.log(C.accent("\nRestart your editor(s) to activate the MCP server.\n"));
  console.log(C.dim("MCP tools available:"));
  console.log(C.dim("  • token_usage — Get token usage summary"));
  console.log(C.dim("  • cost_breakdown — Cost breakdown by model/provider/project"));
  console.log(C.dim("  • daily_trend — Daily usage trend with sparkline"));
  console.log(C.dim("  • session_cost — Current session cost and burn rate"));
  console.log(C.dim("  • budget_check — Check remaining budget"));
  console.log(C.dim("  • compare_models — Compare cost-efficiency across models"));
  console.log(C.dim("  • export_csv — Export usage data as CSV\n"));
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

    // Handle TOML-based configs (Codex)
    if (editor.configFormat === "toml") {
      const configPath = editor.configPath ?? editor.settingsPath;

      if (!existsSync(configPath)) {
        console.log(C.dim(`  ⊘ ${editor.name} — not installed`));
        continue;
      }

      const content = readFileSync(configPath, "utf-8");

      if (!content.includes("[mcp_servers.drishti]")) {
        console.log(C.dim(`  ⊘ ${editor.name} — not installed`));
        continue;
      }

      const newContent = removeMcpFromToml(content, "drishti");
      writeFileSync(configPath, newContent, "utf-8");
      console.log(C.success(`  ✓ ${editor.name} — uninstalled`));
      continue;
    }

    // Handle JSON-based configs (other editors)
    const mcpPath = editor.mcpPath ?? editor.settingsPath;
    const config = editor.mcpPath
      ? readJSON<MCPConfig>(mcpPath)
      : readJSON<SettingsWithMCP>(mcpPath);

    if (!config?.mcpServers?.drishti) {
      console.log(C.dim(`  ⊘ ${editor.name} — not installed`));
      continue;
    }

    // biome-ignore lint/performance/noDelete: required to remove property from object
    delete config.mcpServers!.drishti;

    if (Object.keys(config.mcpServers!).length === 0) {
      config.mcpServers = undefined;
    }

    writeJSON(mcpPath, config);
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
    ],
  };
}

export function installHooks(): void {
  console.log(C.title("\n【♾️】 Installing Guard Hooks\n"));

  const editor = EDITORS.find((e) => e.name === "Claude Code")!;
  const settings = readJSON<Record<string, unknown>>(editor.settingsPath) ?? {};
  const expected = getGuardHooks();

  // Check if already up to date
  if (settings.hooks && JSON.stringify(settings.hooks) === JSON.stringify(expected)) {
    console.log(C.accent("  ✓ Claude Code — hooks already installed and up to date"));
    console.log();
    return;
  }

  settings.hooks = expected;
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
    if (editor.mcpPath) {
      console.log(C.dim(`    ${editor.mcpPath}`));
    }
  }

  console.log();
}
