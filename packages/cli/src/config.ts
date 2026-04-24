/**
 * tokmeter config — User config management CLI.
 *
 * Subcommands:
 *   list                      Pretty table of all knobs + current values.
 *   get <key>                 Print the value at a dotted path (bar.refreshSeconds, ...).
 *   set <key> <value>         Validate, coerce, and persist.
 *   reset [key]               Drop one key (or all) back to defaults.
 *   path                      Print the path to ~/.tokmeter/config.json.
 *
 * All writes carry `modifiedBy: "user"` so cross-machine restore won't silently
 * overwrite your edits with an older tokmeter-flagged snapshot.
 */

import {
  CONFIG_FIELDS,
  DEFAULT_CONFIG,
  configFilePath,
  getConfigValue,
  loadConfig,
  saveConfig,
  setConfigValue,
} from "@sriinnu/tokmeter";
import chalk from "chalk";
import Table from "cli-table3";

export interface ConfigArgs {
  sub: string;
  rest: string[];
  json?: boolean;
}

export async function runConfig(args: ConfigArgs): Promise<void> {
  switch (args.sub) {
    case "list":
      return cmdList(Boolean(args.json));
    case "get":
      return cmdGet(args.rest, Boolean(args.json));
    case "set":
      return cmdSet(args.rest);
    case "reset":
      return cmdReset(args.rest);
    case "path":
      console.log(configFilePath());
      return;
    default:
      printHelp();
  }
}

function printHelp(): void {
  console.log(`
${chalk.bold("tokmeter config")} — manage user config in ~/.tokmeter/config.json.

Usage:
  tokmeter config list
  tokmeter config get   <key>
  tokmeter config set   <key> <value>
  tokmeter config reset [<key>]
  tokmeter config path

Keys:
${CONFIG_FIELDS.map((f) => `  ${chalk.cyan(f.path.padEnd(30))} ${chalk.dim(f.description)}`).join("\n")}
`);
}

function cmdList(json: boolean): void {
  const config = loadConfig();
  if (json) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  const table = new Table({
    head: ["Key", "Value", "Default", "Description"],
    colWidths: [32, 14, 14, 50],
    wordWrap: true,
  });
  for (const field of CONFIG_FIELDS) {
    const current = getConfigValue(config, field.path);
    const defaultVal = readPath(DEFAULT_CONFIG, field.path);
    const currentStr = formatValue(current);
    const defaultStr = formatValue(defaultVal);
    const changed = currentStr !== defaultStr;
    table.push([
      chalk.cyan(field.path),
      changed ? chalk.bold(currentStr) : currentStr,
      chalk.dim(defaultStr),
      chalk.dim(field.description),
    ]);
  }
  console.log(`\n${table.toString()}\n`);
  console.log(chalk.dim(`File: ${configFilePath()}`));
  console.log(chalk.dim(`Last modified by: ${config.modifiedBy} at ${config.modifiedAt}\n`));
}

function cmdGet(rest: string[], json: boolean): void {
  const [key] = rest;
  if (!key) {
    console.log(chalk.red("Usage: tokmeter config get <key>"));
    process.exit(2);
  }
  const config = loadConfig();
  let value: unknown;
  try {
    value = getConfigValue(config, key);
  } catch (err) {
    console.log(chalk.red((err as Error).message));
    process.exit(2);
  }
  if (json) {
    console.log(JSON.stringify(value));
  } else {
    console.log(formatValue(value));
  }
}

function cmdSet(rest: string[]): void {
  const [key, ...valueParts] = rest;
  if (!key || valueParts.length === 0) {
    console.log(chalk.red("Usage: tokmeter config set <key> <value>"));
    process.exit(2);
  }
  const value = valueParts.join(" ");
  const config = loadConfig();
  let next = config;
  try {
    next = setConfigValue(config, key, value, "user");
  } catch (err) {
    console.log(chalk.red((err as Error).message));
    process.exit(2);
  }
  saveConfig(next);
  console.log(chalk.green(`✓ ${key} = ${formatValue(getConfigValue(next, key))}`));
}

function cmdReset(rest: string[]): void {
  const [key] = rest;
  const config = loadConfig();
  if (!key) {
    // Reset all — write a fresh default with user flag so restore doesn't
    // silently recover the old values.
    const fresh = {
      ...DEFAULT_CONFIG,
      modifiedBy: "user" as const,
      modifiedAt: new Date().toISOString(),
    };
    saveConfig(fresh);
    console.log(chalk.green("✓ all keys reset to defaults"));
    return;
  }
  const field = CONFIG_FIELDS.find((f) => f.path === key);
  if (!field) {
    console.log(chalk.red(`Unknown config key: ${key}`));
    process.exit(2);
  }
  const defaultVal = readPath(DEFAULT_CONFIG, key);
  try {
    const next = setConfigValue(config, key, formatValue(defaultVal), "user");
    saveConfig(next);
    console.log(chalk.green(`✓ ${key} reset to ${formatValue(defaultVal)}`));
  } catch (err) {
    console.log(chalk.red((err as Error).message));
    process.exit(2);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

function readPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
