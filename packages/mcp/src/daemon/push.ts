/**
 * Tokmeter daemon — one-shot session push.
 *
 * The statusline is a fresh process per render. After it has written its line
 * it sends the daemon one `update` describing its session (that is what keeps
 * the session in /api/live and feeds maxContextFillPct), then exits. The push
 * is display-only: the daemon's live feed never adds into any ledger total.
 *
 * Contract, because this runs on the statusline's exit path:
 * - bounded: the whole push, imports included, finishes within `timeoutMs`;
 * - silent: never throws, never prints; every failure resolves to `false`;
 * - cheap when the daemon is down: no token file means no socket at all, and a
 *   refused connect fails in about a millisecond.
 */

import type { ContextWindowInfo, SessionInfo, TokenUsage } from "./protocol.js";
import { DAEMON_URL, daemonAuthHeader } from "./protocol.js";

/** Wall-clock cap for one push, connect to close. */
export const PUSH_BUDGET_MS = 150;

export interface SessionPush {
  session: SessionInfo;
  cost: number;
  tokens: TokenUsage;
  durationMs?: number;
  contextWindow?: ContextWindowInfo;
}

export interface PushOptions {
  timeoutMs?: number;
  /** WebSocket URL; defaults to the daemon's (honours TOKMETER_DAEMON_PORT). */
  url?: string;
  /** `Bearer …` header; undefined reads the token file, null means no daemon. */
  authorization?: string | null;
}

/**
 * Connect, send one `update`, close. Resolves `true` once the message was
 * handed to the socket, `false` when it never got that far.
 */
export async function pushSessionUpdate(
  push: SessionPush,
  options: PushOptions = {}
): Promise<boolean> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? PUSH_BUDGET_MS;
  try {
    const authorization =
      options.authorization === undefined ? daemonAuthHeader() : options.authorization;
    if (!authorization) return false;

    const { default: WebSocket } = await import("ws");
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) return false;

    return await new Promise<boolean>((resolve) => {
      let sent = false;
      let settled = false;
      let ws: InstanceType<typeof WebSocket> | null = null;
      // Ref'd on purpose: it is what guarantees this promise settles (and the
      // caller's exit runs) even if the socket never emits another event.
      const timer = setTimeout(() => finish(), remaining);
      function finish(): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws?.terminate();
        } catch {}
        resolve(sent);
      }

      try {
        ws = new WebSocket(options.url ?? DAEMON_URL, {
          headers: { Authorization: authorization },
          handshakeTimeout: remaining,
          perMessageDeflate: false,
          maxPayload: 65_536,
        });
      } catch {
        finish();
        return;
      }
      const socket = ws;
      socket.on("error", finish);
      socket.on("close", finish);
      // The daemon answers an update with a broadcast; nothing here needs it.
      socket.on("message", () => {});
      socket.on("open", () => {
        try {
          socket.send(JSON.stringify({ type: "update", ...push }), (err) => {
            if (err) return finish();
            sent = true;
            // Ordered after the data frame on the same TCP stream, so the
            // daemon has processed the update before it sees the close.
            socket.close(1000);
          });
        } catch {
          finish();
        }
      });
    });
  } catch {
    return false;
  }
}
