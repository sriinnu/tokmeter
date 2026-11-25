/**
 * Fast path for CLI read commands via the warm singleton daemon.
 */

import { fetchDaemonJson, type TokmeterSummary } from "@sriinnu/tokmeter";
import {
  buildDaemonReadQuery,
  DAEMON_READ_ENDPOINTS,
  type DaemonReadArgs,
  daemonReadEligible,
} from "./daemon-read.js";
import { printSummaryTables } from "./formatters.js";

export function nudgeDaemonStart(): void {
  try {
    void import("node:child_process").then(({ spawn }) => {
      const heapMb = process.env.TOKMETER_DAEMON_HEAP_MB ?? "6144";
      spawn(process.execPath, [process.argv[1], "daemon", "start"], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${heapMb}`.trim(),
        },
      }).unref();
    });
  } catch {}
}

/**
 * Fast path for read commands (both `--json` and formatted tables): read the
 * warm singleton daemon over HTTP instead of running a fresh corpus scan.
 */
export async function tryServeFromDaemon(
  command: string,
  args: DaemonReadArgs & { json: boolean }
): Promise<boolean> {
  if (!daemonReadEligible(command, args)) return false;
  const endpoint = args.json ? DAEMON_READ_ENDPOINTS[command] : "/api/summary";
  const pathWithQuery = `${endpoint}${buildDaemonReadQuery(args)}`;

  const res = await fetchDaemonJson<unknown>(pathWithQuery, {
    probeTimeoutMs: 1500,
    timeoutMs: 15_000,
    warmingTimeoutMs: 90_000,
    onDown: nudgeDaemonStart,
  });

  if (res.ok) {
    if (args.json) {
      console.log(JSON.stringify(res.data, null, 2));
    } else {
      printSummaryTables(command, res.data as TokmeterSummary);
    }
    return true;
  }

  if (res.reason === "http-error") {
    process.stderr.write(
      `tokmeter: daemon returned ${res.status} for ${endpoint}; falling back to local scan.\n`
    );
  } else if (res.reason === "timeout") {
    process.stderr.write(
      `tokmeter: daemon read timed out after ${res.timeoutMs}ms (${endpoint}); falling back to local scan.\n`
    );
  } else if (res.reason === "network-error") {
    process.stderr.write(
      `tokmeter: daemon read failed (${res.message}); falling back to local scan.\n`
    );
  }
  return false;
}
