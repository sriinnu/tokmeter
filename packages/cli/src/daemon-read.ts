// daemon-read.ts — the PURE eligibility guard for the CLI's daemon fast path.
//
// Extracted from cli.ts so the "silently wrong numbers" guards are testable in
// isolation (cli.ts runs main() on import). The daemon's read endpoints return
// LIFETIME, cross-provider data; a query that narrows by project/date/window —
// or a `projects` query that narrows by provider — must NOT be served from the
// daemon, or the caller silently gets broader numbers than they asked for.
// These are correctness guards, not perf tuning: getting them wrong means
// `tokmeter stats --json --today --codex` quietly returns all-time all-provider
// totals.

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@sriinnu/tokmeter";

/** The CLI bundle does not depend on tokmeter-mcp; read its canonical
 * per-user daemon capability directly and fail closed on shared paths. */
export function daemonReadAuthorization(home: string = homedir()): string | null {
  const dir = join(home, ".tokmeter", "daemon");
  const path = join(dir, "daemon.token");
  try {
    const directory = lstatSync(dir);
    const tokenPath = lstatSync(path);
    const uid = process.getuid?.();
    const posix = process.platform !== "win32";
    if (
      !directory.isDirectory() ||
      tokenPath.isSymbolicLink() ||
      (posix && (directory.mode & 0o077) !== 0) ||
      (uid !== undefined && directory.uid !== uid)
    )
      return null;
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const file = fstatSync(fd);
      if (
        !file.isFile() ||
        file.nlink !== 1 ||
        (posix && (file.mode & 0o077) !== 0) ||
        (uid !== undefined && file.uid !== uid)
      )
        return null;
      const token = readFileSync(fd, "utf8").trim();
      return /^[a-f0-9]{64}$/.test(token) ? `Bearer ${token}` : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Read commands whose LIFETIME shape the daemon can serve, and their route. */
export const DAEMON_READ_ENDPOINTS: Record<string, string> = {
  stats: "/api/stats",
  daily: "/api/daily",
  models: "/api/models",
  projects: "/api/projects",
};

export interface DaemonReadArgs {
  providers?: ProviderId[];
  project?: string;
  since?: string;
  until?: string;
  today?: boolean;
  week?: boolean;
  month?: boolean;
  year?: number;
}

/**
 * True only when the daemon's endpoints can answer this exact query without
 * losing precision. Returns false (→ caller does a local scan) for any
 * narrowing the daemon read path doesn't express.
 */
export function daemonReadEligible(command: string, args: DaemonReadArgs): boolean {
  // Unknown / differently-shaped command (e.g. overview) → scan.
  if (!(command in DAEMON_READ_ENDPOINTS)) return false;

  // The daemon returns LIFETIME data, so any date/window/project narrowing
  // must scan or the answer is silently too broad.
  if (
    args.project ||
    args.since ||
    args.until ||
    args.today ||
    args.week ||
    args.month ||
    args.year !== undefined
  ) {
    return false;
  }

  // /api/projects ignores ?providers= (serves the cross-provider breakdown
  // verbatim), so a provider-narrowed projects query must scan to actually
  // narrow. stats/daily/models honor ?providers= correctly.
  if (command === "projects" && args.providers && args.providers.length > 0) {
    return false;
  }

  return true;
}
