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

import type { ProviderId } from "@sriinnu/tokmeter";

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
    args.year
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
