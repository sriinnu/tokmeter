// port.ts — which port the daemon binds and clients dial.
//
// The default is fixed (9876 WebSocket, 9877 HTTP): the macOS bar, the CLI and
// the web dashboard hardcode it. TOKMETER_DAEMON_PORT exists for one purpose —
// running an isolated daemon (tests, an end-to-end check, a second checkout)
// beside the real one. An overridden daemon is a private sandbox: it never
// writes the shared /tmp compatibility shims and never drives the launchd
// agent, both of which belong to the default-port daemon.
//
// Nothing in this file may import anything — the statusline reads it on every
// render through protocol.ts.

export const DEFAULT_DAEMON_PORT = 9876;
export const DAEMON_PORT_ENV = "TOKMETER_DAEMON_PORT";

/**
 * The overridden WebSocket port, or null for the default. Accepts an unsigned
 * port in 1024–65534 (the HTTP API takes port + 1); anything else, including
 * the default port itself, is no override.
 */
export function daemonPortOverride(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[DAEMON_PORT_ENV];
  if (!raw || !/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  if (port < 1024 || port > 65534 || port === DEFAULT_DAEMON_PORT) return null;
  return port;
}
