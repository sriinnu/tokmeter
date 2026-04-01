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
    supportsStatusline: true,
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
