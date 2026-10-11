// compat-names.ts — names the daemon, the macOS bar and the launcher agree on,
// in their current (tokmeter) and legacy (drishti) spellings.
//
// The product was called drishti before 1.13. Installed bars, plists and
// parent processes from either side of the rename talk to each other, so each
// name here exists twice and the rule is additive: SEND both, ACCEPT either.
// Nothing in this file may import anything — cli.ts reads it on every
// statusline invocation, which is a fresh process roughly every 200ms.

/** Response header carrying the HTTP API version, e.g. `tokmeter-api/1`. */
export const API_HEADER = "X-Tokmeter-API";
export const API_VALUE_PREFIX = "tokmeter-api";
/** Legacy spelling, kept for compatibility: bars before the rename read this one. */
export const LEGACY_API_HEADER = "X-Drishti-API";
export const LEGACY_API_VALUE_PREFIX = "drishti-api";

/** Both version headers for one response, current name first. */
export function apiVersionHeaders(version: number): Array<[name: string, value: string]> {
  return [
    [API_HEADER, `${API_VALUE_PREFIX}/${version}`],
    [LEGACY_API_HEADER, `${LEGACY_API_VALUE_PREFIX}/${version}`],
  ];
}

/** Env flag marking the detached/launchd daemon child (runs in the foreground). */
export const DAEMON_CHILD_FLAG = "__TOKMETER_DAEMON_CHILD__";
/** Legacy spelling, kept for compatibility: plists written by older releases set only this. */
export const LEGACY_DAEMON_CHILD_FLAG = "__DRISHTI_DAEMON_CHILD__";

/** True when either spelling of the child flag is set to "1". */
export function isDaemonChildEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DAEMON_CHILD_FLAG] === "1" || env[LEGACY_DAEMON_CHILD_FLAG] === "1";
}

/** Both spellings, for spawning a child or writing a plist. */
export function daemonChildEnv(): Record<string, string> {
  return { [DAEMON_CHILD_FLAG]: "1", [LEGACY_DAEMON_CHILD_FLAG]: "1" };
}
