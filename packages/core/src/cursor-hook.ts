/**
 * The Cursor stop hook: install, uninstall, status, and the daemon's
 * {@link ensureCursorHook}. The CLI's `tokmeter cursor-hook` wraps these.
 *
 * Installs a Cursor `stop` hook that appends each finished turn's real token
 * usage to ~/.tokmeter/cursor-turns/YYYY-MM-DD.jsonl. No credentials: Cursor
 * hands the counts to the hook itself.
 *
 * ~/.cursor/hooks.json is the user's file and can hold other hooks (a
 * telemetry preToolUse hook, a team's guards). Every change here is a merge:
 * only the entry whose command runs our script is added or removed, every
 * other key and hook is kept, and the file is replaced atomically. A file
 * that doesn't parse is refused and left untouched. If hooks.json is a
 * symlink (a dotfiles repo), its target is written and the link stays. If
 * the file changed between our read and our write, the write is refused.
 *
 * The coverage ledger, not hooks.json, says whether the hook is installed:
 * install appends "installed" only when no span is open, and uninstall
 * appends "uninstalled" whenever one is, even if our hooks.json entry was
 * already removed by hand.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildCursorHookScript, CURSOR_HOOK_SCRIPT_VERSION } from "./cursor-hook-script.js";
import {
  CURSOR_HOOK_COVERAGE_FILE,
  hasOpenCoverageSpan,
  readCursorHookCoverage,
} from "./parsers/cursor-turn-journal.js";

/**
 * Append to the coverage ledger the Cursor parser reads: from an
 * "installed" event on, hook turns are Cursor's usage and the database's
 * counts aren't used (once the hook's numbers are verified). Callers write
 * only a change of state, decided from the ledger itself, so a reinstall
 * doesn't move the start.
 */
function appendCoverage(journalDir: string, event: "installed" | "uninstalled", ts: number): void {
  mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  appendFileSync(
    join(journalDir, CURSOR_HOOK_COVERAGE_FILE),
    `${JSON.stringify({ v: 1, event, ts })}\n`,
    { mode: 0o600 }
  );
}

/** Whether the ledger under `home` has an open span. */
async function ledgerOpen(home: string): Promise<boolean> {
  return hasOpenCoverageSpan(await readCursorHookCoverage(home));
}

/** Per-hook timeout in seconds. The script finishes in well under one. */
const HOOK_TIMEOUT_SECONDS = 5;

/** Matches our entry's command whatever node path or home it was built with. */
const OUR_SCRIPT_PATTERN = /[\\/]\.tokmeter[\\/]hooks[\\/]cursor-stop\.mjs/;

export interface CursorHookPaths {
  home: string;
  hooksFile: string;
  scriptFile: string;
  journalDir: string;
}

export function cursorHookPaths(home = homedir()): CursorHookPaths {
  return {
    home,
    hooksFile: join(home, ".cursor", "hooks.json"),
    scriptFile: join(home, ".tokmeter", "hooks", "cursor-stop.mjs"),
    journalDir: join(home, ".tokmeter", "cursor-turns"),
  };
}

/**
 * Node binary to run the hook with. Cursor runs hooks with a trimmed PATH,
 * so the command names an absolute path. A Homebrew Cellar or nvm path names
 * one version and breaks on the next upgrade; prefer the stable symlink.
 */
export function resolveNodePath(execPath = process.execPath): string {
  const versioned = /[\\/](Cellar|\.nvm|versions|\.volta|fnm)[\\/]/.test(execPath);
  const isNode = /[\\/]node(\.exe)?$/.test(execPath);
  if (isNode && !versioned) return execPath;
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    if (existsSync(candidate)) return candidate;
  }
  return execPath;
}

/** Quote one argument for the shell Cursor runs the command through. */
export function shellQuote(arg: string, platform = process.platform): string {
  if (platform === "win32") return `"${arg.replace(/"/g, '""')}"`;
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(nodePath: string, scriptFile: string): string {
  return `${shellQuote(nodePath)} ${shellQuote(scriptFile)}`;
}

interface HookEntry {
  command?: unknown;
  [key: string]: unknown;
}

interface HooksFile {
  version?: unknown;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export class HooksFileError extends Error {}

function isOurs(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as HookEntry).command === "string" &&
    OUR_SCRIPT_PATTERN.test((entry as HookEntry).command as string)
  );
}

interface LoadedHooks {
  exists: boolean;
  /** The file actually written: hooks.json, or its target when it is a symlink. */
  target: string;
  raw: string;
  data: HooksFile;
  indent: string | number;
  trailingNewline: boolean;
}

/** Read and validate hooks.json. Throws HooksFileError rather than guess. */
function loadHooks(file: string): LoadedHooks {
  // A symlink (a dotfiles repo) is followed: its target is what we read and
  // write, so the link itself stays. A dangling one is refused, not replaced.
  let target = file;
  if (existsSyncLink(file)) {
    try {
      target = realpathSync(file);
    } catch (error) {
      throw new HooksFileError(
        `${file} is a symlink tokmeter can't resolve (${(error as Error).message}). Nothing was changed.`
      );
    }
  }
  if (!existsSync(target)) {
    return {
      exists: false,
      target,
      raw: "",
      data: { version: 1, hooks: {} },
      indent: 2,
      trailingNewline: true,
    };
  }
  const raw = readFileSync(target, "utf8");
  let data: unknown;
  try {
    data = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch (error) {
    throw new HooksFileError(
      `${file} is not valid JSON (${(error as Error).message}). Fix it by hand; nothing was changed.`
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new HooksFileError(`${file} is not a JSON object. Nothing was changed.`);
  }
  const hooks = (data as HooksFile).hooks;
  if (
    hooks !== undefined &&
    (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))
  ) {
    throw new HooksFileError(`${file}: "hooks" is not an object. Nothing was changed.`);
  }
  const stop = hooks?.stop;
  if (stop !== undefined && !Array.isArray(stop)) {
    throw new HooksFileError(`${file}: "hooks.stop" is not an array. Nothing was changed.`);
  }
  const indentMatch = raw.match(/\n([ \t]+)\S/);
  return {
    exists: true,
    target,
    raw,
    data: data as HooksFile,
    indent: indentMatch ? indentMatch[1]! : 2,
    trailingNewline: raw.endsWith("\n") || raw.trim() === "",
  };
}

/** True when `file` itself is a symlink, even a dangling one. */
function existsSyncLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Write via a temp file in the same directory, then rename over.
 * `beforeRename` runs after the temp file is written and may throw to refuse
 * the swap; the temp file is removed and `file` is left as it was.
 */
function writeAtomic(file: string, content: string, mode: number, beforeRename?: () => void): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tokmeter-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, content, { mode });
    chmodSync(tmp, mode);
    beforeRename?.();
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** What's on disk now, in the shape loadHooks saw it: undefined when absent. */
function currentContent(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function serialize(loaded: LoadedHooks, data: HooksFile): string {
  const text = JSON.stringify(data, null, loaded.indent);
  return loaded.trailingNewline ? `${text}\n` : text;
}

/** Test seam: runs just before hooks.json is re-checked and swapped in. */
export type BeforeHooksCommit = () => void;

function saveHooks(
  loaded: LoadedHooks,
  data: HooksFile,
  beforeCommit?: BeforeHooksCommit
): boolean {
  const next = serialize(loaded, data);
  if (loaded.exists && next === loaded.raw) return false;
  const target = loaded.target;
  let mode = 0o644;
  if (loaded.exists) {
    try {
      mode = statSync(target).mode & 0o777;
    } catch {}
  }
  writeAtomic(target, next, mode, () => {
    beforeCommit?.();
    // Re-read just before the swap: Cursor, an editor or another tool may
    // have written it since we loaded it. Their change wins; ours is refused.
    const now = currentContent(target);
    const unchanged = loaded.exists ? now === loaded.raw : now === undefined;
    if (!unchanged) {
      throw new HooksFileError(
        `${target} changed while tokmeter was updating it. Nothing was changed; run it again.`
      );
    }
  });
  return true;
}

export interface InstallResult {
  paths: CursorHookPaths;
  command: string;
  hooksChanged: boolean;
}

export async function installCursorHook(
  opts: { home?: string; nodePath?: string; now?: number; beforeCommit?: BeforeHooksCommit } = {}
): Promise<InstallResult> {
  const paths = cursorHookPaths(opts.home);
  // Validate hooks.json and read the ledger before touching anything, so a
  // refusal changes nothing.
  const loaded = loadHooks(paths.hooksFile);
  const spanOpen = await ledgerOpen(paths.home);
  const nodePath = opts.nodePath ?? resolveNodePath();
  const command = hookCommand(nodePath, paths.scriptFile);

  mkdirSync(dirname(paths.scriptFile), { recursive: true, mode: 0o700 });
  const priorScript = currentContent(paths.scriptFile);
  writeAtomic(paths.scriptFile, buildCursorHookScript(paths.journalDir), 0o600);

  const data: HooksFile = { ...loaded.data };
  if (data.version === undefined) data.version = 1;
  const hooks: Record<string, unknown> = { ...(data.hooks ?? {}) };
  const stop = ((hooks.stop as unknown[] | undefined) ?? []).filter((entry) => !isOurs(entry));
  stop.push({ command, timeout: HOOK_TIMEOUT_SECONDS, loop_limit: null });
  hooks.stop = stop;
  data.hooks = hooks;
  // Re-adding the same entry in the same place leaves the file byte-identical.
  let hooksChanged: boolean;
  try {
    hooksChanged = saveHooks(loaded, keepPosition(loaded.data, data), opts.beforeCommit);
  } catch (error) {
    // Put the script back the way it was, so a refusal changes nothing.
    if (priorScript === undefined) rmSync(paths.scriptFile, { force: true });
    else writeAtomic(paths.scriptFile, priorScript, 0o600);
    throw error;
  }
  if (!spanOpen) appendCoverage(paths.journalDir, "installed", opts.now ?? Date.now());
  return { paths, command, hooksChanged };
}

/**
 * If our entry was already in the stop list, put the new one back where it
 * was, so a reinstall with an unchanged command is a no-op on disk.
 */
function keepPosition(before: HooksFile, after: HooksFile): HooksFile {
  const old = before.hooks?.stop;
  if (!Array.isArray(old)) return after;
  const at = old.findIndex(isOurs);
  if (at < 0) return after;
  const stop = [...(after.hooks!.stop as unknown[])];
  const ours = stop.pop();
  stop.splice(Math.min(at, stop.length), 0, ours);
  return { ...after, hooks: { ...after.hooks, stop } };
}

export interface UninstallResult {
  paths: CursorHookPaths;
  removedEntries: number;
  removedScript: boolean;
}

export async function uninstallCursorHook(
  opts: { home?: string; now?: number; beforeCommit?: BeforeHooksCommit } = {}
): Promise<UninstallResult> {
  const paths = cursorHookPaths(opts.home);
  const loaded = loadHooks(paths.hooksFile);
  const spanOpen = await ledgerOpen(paths.home);
  let removedEntries = 0;
  const stop = loaded.data.hooks?.stop;
  if (loaded.exists && Array.isArray(stop)) {
    const kept = stop.filter((entry) => !isOurs(entry));
    removedEntries = stop.length - kept.length;
    if (removedEntries > 0) {
      const hooks: Record<string, unknown> = { ...loaded.data.hooks };
      if (kept.length > 0) hooks.stop = kept;
      else delete hooks.stop;
      saveHooks(loaded, { ...loaded.data, hooks }, opts.beforeCommit);
    }
  }
  // The ledger closes its span even when our entry was already gone (removed
  // by hand): otherwise the hook would own every moment from then on.
  if (spanOpen) appendCoverage(paths.journalDir, "uninstalled", opts.now ?? Date.now());
  const removedScript = existsSync(paths.scriptFile);
  rmSync(paths.scriptFile, { force: true });
  // The journal is usage history; it stays.
  return { paths, removedEntries, removedScript };
}

export interface LastTurn {
  ts: number;
  status?: string;
  model?: string;
  hasUsage: boolean;
}

export interface CursorHookStatus {
  paths: CursorHookPaths;
  installed: boolean;
  entries: number;
  command?: string;
  scriptPresent: boolean;
  scriptVersion?: number;
  nodePresent?: boolean;
  hooksFileError?: string;
  journalFiles: number;
  lastTurn?: LastTurn;
  turnsToday: number;
  turnsTodayWithUsage: number;
  /** Today's journal lines, in order, as written (no dedup). */
  todayTurns: TodayTurn[];
  /** Today's lines summed per bucket, so a live turn can be checked. */
  todayTotals: TokenTotals;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TodayTurn extends TokenTotals {
  ts?: number;
  status?: string;
  model?: string;
  generationId?: string;
  hasUsage: boolean;
}

interface JournalLine {
  ts?: unknown;
  status?: unknown;
  model?: unknown;
  generation_id?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  cache_write_tokens?: unknown;
}

function lineHasUsage(line: JournalLine): boolean {
  return [
    line.input_tokens,
    line.output_tokens,
    line.cache_read_tokens,
    line.cache_write_tokens,
  ].some((v) => typeof v === "number" && v > 0);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function toTodayTurn(line: JournalLine): TodayTurn {
  return {
    ...(typeof line.ts === "number" ? { ts: line.ts } : {}),
    ...(typeof line.status === "string" ? { status: line.status } : {}),
    ...(typeof line.model === "string" ? { model: line.model } : {}),
    ...(typeof line.generation_id === "string" ? { generationId: line.generation_id } : {}),
    input: num(line.input_tokens),
    output: num(line.output_tokens),
    cacheRead: num(line.cache_read_tokens),
    cacheWrite: num(line.cache_write_tokens),
    hasUsage: lineHasUsage(line),
  };
}

function parseLines(text: string): JournalLine[] {
  const out: JournalLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") out.push(parsed as JournalLine);
    } catch {}
  }
  return out;
}

function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Node path is the command's first word; only the forms hookCommand writes. */
function nodeFromCommand(command: string): string | undefined {
  const quoted = command.match(/^'((?:[^']|'\\'')*)'/);
  if (quoted) return quoted[1]!.replace(/'\\''/g, "'");
  const dq = command.match(/^"((?:[^"]|"")*)"/);
  if (dq) return dq[1]!.replace(/""/g, '"');
  return command.split(" ")[0];
}

export function cursorHookStatus(opts: { home?: string; now?: number } = {}): CursorHookStatus {
  const paths = cursorHookPaths(opts.home);
  const now = opts.now ?? Date.now();
  const status: CursorHookStatus = {
    paths,
    installed: false,
    entries: 0,
    scriptPresent: existsSync(paths.scriptFile),
    journalFiles: 0,
    turnsToday: 0,
    turnsTodayWithUsage: 0,
    todayTurns: [],
    todayTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (status.scriptPresent) {
    const header = readFileSync(paths.scriptFile, "utf8").slice(0, 200);
    const match = header.match(/script v(\d+)/);
    if (match) status.scriptVersion = Number(match[1]);
  }
  try {
    const loaded = loadHooks(paths.hooksFile);
    const stop = loaded.data.hooks?.stop;
    const ours = Array.isArray(stop) ? stop.filter(isOurs) : [];
    status.entries = ours.length;
    if (ours.length > 0) {
      status.command = (ours[0] as HookEntry).command as string;
      const node = nodeFromCommand(status.command);
      status.nodePresent = node ? existsSync(node) : false;
    }
  } catch (error) {
    status.hooksFileError = (error as Error).message;
  }
  status.installed = status.entries > 0 && status.scriptPresent && status.nodePresent !== false;

  let files: string[] = [];
  try {
    files = readdirSync(paths.journalDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
  } catch {}
  status.journalFiles = files.length;
  const todayFile = `${localDay(now)}.jsonl`;
  if (files.includes(todayFile)) {
    const lines = parseLines(readFileSync(join(paths.journalDir, todayFile), "utf8"));
    status.turnsToday = lines.length;
    status.turnsTodayWithUsage = lines.filter(lineHasUsage).length;
    status.todayTurns = lines.map(toTodayTurn);
    for (const t of status.todayTurns) {
      status.todayTotals.input += t.input;
      status.todayTotals.output += t.output;
      status.todayTotals.cacheRead += t.cacheRead;
      status.todayTotals.cacheWrite += t.cacheWrite;
    }
  }
  for (let i = files.length - 1; i >= 0 && !status.lastTurn; i--) {
    const lines = parseLines(readFileSync(join(paths.journalDir, files[i]!), "utf8"));
    const last = lines[lines.length - 1];
    if (last && typeof last.ts === "number") {
      status.lastTurn = {
        ts: last.ts,
        status: typeof last.status === "string" ? last.status : undefined,
        model: typeof last.model === "string" ? last.model : undefined,
        hasUsage: lineHasUsage(last),
      };
    }
  }
  return status;
}

export type EnsureCursorHookResult =
  | { action: "installed" | "refreshed" | "ok" }
  | { action: "skipped"; reason: "no-cursor" | "disabled" | "opted-out" | "removed-by-hand" }
  | { action: "error"; message: string };

/**
 * Keep the stop hook installed without anyone running a command. Cursor
 * 3.11+ writes no token counts to its local database, so without the hook
 * tokmeter sees Cursor turns but no usage. The daemon calls this at start
 * and once a day.
 *
 * It never fights the user:
 * - no `~/.cursor` folder (Cursor not used here): nothing is written;
 * - `daemon.cursorHook: false` in config: off;
 * - the ledger shows an uninstall and no reinstall since: the user removed
 *   it, so it stays removed;
 * - our entry vanished from hooks.json by hand while the ledger says
 *   installed: that is a removal too, so the span is closed (uninstall)
 *   rather than the entry put back;
 * - a hooks.json that doesn't parse is reported, never rewritten.
 *
 * An installed hook whose script is old, missing, or whose node binary is
 * gone is reinstalled in place ("refreshed"). Never throws.
 */
export async function ensureCursorHook(
  opts: { home?: string; nodePath?: string; now?: number; enabled?: boolean } = {}
): Promise<EnsureCursorHookResult> {
  const paths = cursorHookPaths(opts.home);
  try {
    if (!existsSync(join(paths.home, ".cursor"))) return { action: "skipped", reason: "no-cursor" };
    if (opts.enabled === false) return { action: "skipped", reason: "disabled" };
    const spans = await readCursorHookCoverage(paths.home);
    if (!hasOpenCoverageSpan(spans)) {
      if (spans.length > 0) return { action: "skipped", reason: "opted-out" };
      await installCursorHook({ home: paths.home, nodePath: opts.nodePath, now: opts.now });
      return { action: "installed" };
    }
    const status = cursorHookStatus({ home: paths.home, now: opts.now });
    if (status.hooksFileError) return { action: "error", message: status.hooksFileError };
    if (status.entries === 0) {
      await uninstallCursorHook({ home: paths.home, now: opts.now });
      return { action: "skipped", reason: "removed-by-hand" };
    }
    const stale =
      !status.scriptPresent ||
      status.nodePresent === false ||
      (status.scriptVersion ?? 0) < CURSOR_HOOK_SCRIPT_VERSION;
    if (!stale) return { action: "ok" };
    await installCursorHook({ home: paths.home, nodePath: opts.nodePath, now: opts.now });
    return { action: "refreshed" };
  } catch (error) {
    return { action: "error", message: (error as Error).message };
  }
}
