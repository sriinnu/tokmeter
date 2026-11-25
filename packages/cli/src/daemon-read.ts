// daemon-read.ts — Shared eligibility, query builder, and auth helpers for the
// CLI's warm-daemon read path.

import {
  type ProviderId,
  readDaemonAuthHeader,
  resolveDaemonHttpBase,
  resolveDaemonWsPort,
} from "@sriinnu/tokmeter";

export {
  readDaemonAuthHeader as daemonReadAuthorization,
  resolveDaemonHttpBase,
  resolveDaemonWsPort,
};

/** Read commands whose aggregate/summary shapes the daemon can serve. */
export const DAEMON_READ_ENDPOINTS: Record<string, string> = {
  overview: "/api/summary",
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
  light?: boolean;
  rescanHistory?: boolean;
}

/**
 * Serialize CLI report filters into a query string understood by the daemon's
 * scoped HTTP endpoints (`/api/summary`, `/api/stats`, `/api/daily`,
 * `/api/models`, `/api/projects`).
 */
export function buildDaemonReadQuery(args: DaemonReadArgs): string {
  const params = new URLSearchParams();
  if (args.providers && args.providers.length > 0) {
    params.set("providers", args.providers.join(","));
  }
  if (args.project) params.set("project", args.project);
  if (args.since) params.set("since", args.since);
  if (args.until) params.set("until", args.until);
  if (args.today) params.set("today", "true");
  if (args.week) params.set("week", "true");
  if (args.month) params.set("month", "true");
  if (args.year !== undefined) params.set("year", String(args.year));
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/**
 * True when the daemon's scoped endpoints can answer this exact query cleanly.
 * `--light` and `--rescan-history` intentionally force a local scan.
 */
export function daemonReadEligible(command: string, args: DaemonReadArgs): boolean {
  if (!(command in DAEMON_READ_ENDPOINTS)) return false;
  if (args.light || args.rescanHistory) return false;
  return true;
}
