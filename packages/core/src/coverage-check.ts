/**
 * @sriinnu/tokmeter-core — Coverage check: session files no parser read.
 *
 * A sealed day can only hold what the parsers saw. When an agent starts
 * writing somewhere new — Codex compressing idle rollouts to .jsonl.zst and
 * moving finished ones to ~/.codex/archived_sessions — the day seals short and
 * nothing says so. The 2026-10-18 hole was 331.8M tokens and took a day of
 * hand-counting to find.
 *
 * This doesn't recount tokens (tokmeter checking tokmeter proves nothing). It
 * asks the filesystem a cheaper, independent question: which files under an
 * agent's folder changed that day, look like they carry usage, and fed no
 * record? It walks each agent's whole HOME folder (~/.codex, not the parser's
 * ~/.codex/sessions), because the files a parser doesn't know about are by
 * definition outside the roots it declares.
 *
 * "Looks like usage" is deliberately narrow, to keep the warning trustworthy:
 * a .jsonl/.ndjson/.json whose last 64 KB has a token-count key with a
 * positive number, or a compressed file (which can't be sniffed). Databases,
 * worktrees, caches and logs are skipped. On the machine it was built on, the
 * 1.16.0 parsers flag exactly the five archived_sessions rollouts for
 * 2026-10-19 and the current parsers flag nothing.
 */

import type { Dirent, Stats } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { ProviderId, SessionParser } from "./types.js";

export interface UnreadFile {
  path: string;
  bytes: number;
  /** "usage": a positive token count in the file; "compressed": can't be read to tell. */
  kind: "usage" | "compressed";
  /** Providers whose agent folder holds the file. */
  providers: ProviderId[];
}

export interface CoverageReport {
  /** The day checked, YYYY-MM-DD (local). */
  date: string;
  checkedAt: number;
  elapsedMs: number;
  /** Agent folders walked. */
  homes: string[];
  unread: UnreadFile[];
  /** True when the time budget ran out before every folder was walked. */
  partial: boolean;
}

/** Folders that never hold an agent's own session usage. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "worktrees",
  // Codex keeps copies of task repos here — 1.57M files on one machine.
  "task-preservation",
  "Cache",
  "Code Cache",
  "GPUCache",
  "CachedData",
  "logs",
  "log",
  "tmp",
  ".tmp",
]);
const MAX_DEPTH = 8;
const SNIFF_BYTES = 65_536;
const STAT_BATCH = 64;
const TEXT_EXT = /\.(jsonl|ndjson|json)$/;
const COMPRESSED_EXT = /\.(jsonl|ndjson|json)\.(zst|gz|br)$/;
/** A token-count key followed by a positive number. Key names alone aren't
 *  enough: Ribhu's receipts name input_tokens with null values. */
const USAGE_RE =
  /"(input_tokens|inputTokens|prompt_tokens|promptTokens|output_tokens|outputTokens|cache_read_input_tokens)"\s*:\s*[1-9]/;

/**
 * The agent's own folder for a session root: the first segment below $HOME
 * (~/.codex), or the app folder for ~/Library/Application Support/<App>,
 * ~/.config/<app> and ~/.local/share/<app>. Null for roots outside $HOME.
 */
export function agentHome(root: string, homeDir: string): string | null {
  if (!root.startsWith(homeDir + sep)) return null;
  const rel = root.slice(homeDir.length + 1).split(sep);
  let depth = 1;
  if (rel[0] === "Library") depth = 3;
  else if (rel[0] === ".local" && rel[1] === "share") depth = 3;
  else if (rel[0] === ".config") depth = 2;
  if (rel.length < depth) return null;
  return join(homeDir, ...rel.slice(0, depth));
}

/** Agent folders to walk, each with the providers that read from it. */
export function agentHomes(parsers: SessionParser[], homeDir: string): Map<string, ProviderId[]> {
  const homes = new Map<string, ProviderId[]>();
  for (const p of parsers) {
    for (const root of p.sessionRoots?.(homeDir) ?? []) {
      const h = agentHome(root, homeDir);
      if (!h) continue;
      const ids = homes.get(h) ?? [];
      if (!ids.includes(p.providerId)) ids.push(p.providerId);
      homes.set(h, ids);
    }
  }
  return homes;
}

async function hasUsage(path: string, size: number): Promise<boolean> {
  const n = Math.min(size, SNIFF_BYTES);
  if (n === 0) return false;
  const buf = Buffer.alloc(n);
  let fh: import("node:fs/promises").FileHandle | undefined;
  try {
    fh = await open(path, "r");
    await fh.read(buf, 0, n, size - n); // the tail: usage lines come last
    return USAGE_RE.test(buf.toString("utf8"));
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/**
 * Files under the agent folders that changed during `date`, look like they
 * carry usage, and are not in `readFiles` (the sourceFile of every record the
 * parsers produced). `readFiles` entries may carry a "#…" suffix (SQLite row
 * ids); only the path part counts.
 */
export async function findUnreadFiles(opts: {
  homeDir: string;
  date: string;
  readFiles: Iterable<string>;
  parsers: SessionParser[];
  budgetMs?: number;
  now?: () => number;
}): Promise<CoverageReport> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const budget = opts.budgetMs ?? 5_000;
  const start = new Date(`${opts.date}T00:00:00`).getTime();
  const next = new Date(start + 26 * 3_600_000); // DST-safe next local midnight
  next.setHours(0, 0, 0, 0);
  const end = next.getTime();

  const read = new Set<string>();
  for (const f of opts.readFiles) read.add(f.split("#")[0]);

  const homes = agentHomes(opts.parsers, opts.homeDir);
  const found = new Map<string, UnreadFile>();
  let partial = false;

  // Async I/O: this runs inside the daemon right after midnight, and a
  // synchronous walk would stall the statusline for the whole budget.
  const walk = async (dir: string, depth: number, providers: ProviderId[]): Promise<void> => {
    if (depth > MAX_DEPTH || partial) return;
    if (now() - t0 > budget) {
      partial = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // A git checkout is code, not sessions, and its test fixtures can carry
    // real-looking usage lines (tokmeter's own do).
    if (depth > 0 && entries.some((e) => e.name === ".git")) return;
    const files: string[] = [];
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(path, depth + 1, providers);
      } else if (
        e.isFile() &&
        (TEXT_EXT.test(e.name) || COMPRESSED_EXT.test(e.name)) &&
        !read.has(path)
      ) {
        files.push(path);
      }
    }
    // A Codex day folder holds hundreds of rollouts: stat them in parallel
    // batches rather than one by one (~/.codex walked in 3.1s serially).
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      await Promise.all(files.slice(i, i + STAT_BATCH).map((path) => consider(path, providers)));
    }
  };

  const consider = async (path: string, providers: ProviderId[]): Promise<void> => {
    let st: Stats;
    try {
      st = await stat(path);
    } catch {
      return;
    }
    if (st.mtimeMs < start || st.mtimeMs >= end) return;
    const prior = found.get(path);
    if (prior) {
      for (const p of providers) if (!prior.providers.includes(p)) prior.providers.push(p);
      return;
    }
    const compressed = COMPRESSED_EXT.test(path);
    if (!compressed && !(await hasUsage(path, st.size))) return;
    if (found.has(path)) return; // a parallel sibling got here first
    found.set(path, {
      path,
      bytes: st.size,
      kind: compressed ? "compressed" : "usage",
      providers: [...providers],
    });
  };

  for (const [home, providers] of homes) await walk(home, 0, providers);

  return {
    date: opts.date,
    checkedAt: now(),
    elapsedMs: now() - t0,
    homes: [...homes.keys()],
    unread: [...found.values()].sort((a, b) => b.bytes - a.bytes),
    partial,
  };
}

/** One line for a warning: what was missed and where. */
export function summarizeCoverage(report: CoverageReport, homeDir: string): string | null {
  if (report.unread.length === 0) return null;
  const byFolder = new Map<string, number>();
  for (const f of report.unread) {
    const dir = f.path.slice(0, f.path.lastIndexOf(sep)).replace(homeDir, "~");
    byFolder.set(dir, (byFolder.get(dir) ?? 0) + 1);
  }
  const top = [...byFolder]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d, n]) => `${n} in ${d}`)
    .join(", ");
  const n = report.unread.length;
  return `${report.date} may be missing usage: ${n} session file${n === 1 ? "" : "s"} changed that day that no parser read (${top}). Run \`tokmeter coverage --date ${report.date}\` for the list.`;
}

// ─── Persistence: ~/.cache/tokmeter/coverage/<date>.json ───────────────────

function coverageDir(homeDir: string): string {
  return join(homeDir, ".cache", "tokmeter", "coverage");
}

/** Keep the report so the CLI, the daemon API and the bar can show it later. */
export async function writeCoverageReport(homeDir: string, report: CoverageReport): Promise<void> {
  const dir = coverageDir(homeDir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${report.date}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(report, null, 1)}\n`);
  await rename(tmp, file);
}

/** Most recent reports first. */
export async function readCoverageReports(homeDir: string, limit = 7): Promise<CoverageReport[]> {
  let names: string[];
  try {
    names = await readdir(coverageDir(homeDir));
  } catch {
    return [];
  }
  const days = names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort()
    .reverse()
    .slice(0, limit);
  const out: CoverageReport[] = [];
  for (const n of days) {
    try {
      out.push(JSON.parse(await readFile(join(coverageDir(homeDir), n), "utf8")));
    } catch {
      /* a torn or foreign file is skipped, never fatal */
    }
  }
  return out;
}
