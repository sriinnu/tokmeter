/**
 * @sriinnu/tokmeter-core — Shared fail-closed daemon HTTP client helpers.
 *
 * Centralizes `TOKMETER_DAEMON_PORT` resolution, `daemon.token` capability
 * validation, readiness probing, and bounded JSON fetches so CLI, MCP server,
 * and TUI share one source of truth instead of hardcoding port 9877 or duplicating
 * token checks.
 */

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

export const DEFAULT_DAEMON_WS_PORT = 9876;
export const DAEMON_PORT_ENV = "TOKMETER_DAEMON_PORT";

/**
 * Resolve the daemon WebSocket port from env (or default 9876).
 * Matches daemon `port.ts` rules: unsigned integer in 1024..65534.
 */
export function resolveDaemonWsPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DAEMON_PORT_ENV];
  if (!raw || !/^\d{1,5}$/.test(raw)) return DEFAULT_DAEMON_WS_PORT;
  const port = Number(raw);
  if (port < 1024 || port > 65534) return DEFAULT_DAEMON_WS_PORT;
  return port;
}

/** Resolve the daemon HTTP API base URL (`wsPort + 1` on loopback). */
export function resolveDaemonHttpBase(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${resolveDaemonWsPort(env) + 1}`;
}

/**
 * Read `<home>/.tokmeter/daemon/daemon.token` fail-closed and return a Bearer
 * Authorization header, or `null` if missing/unsafe/invalid.
 */
export function readDaemonAuthHeader(home: string = homedir()): string | null {
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
    ) {
      return null;
    }
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const file = fstatSync(fd);
      if (
        !file.isFile() ||
        file.nlink !== 1 ||
        (posix && (file.mode & 0o077) !== 0) ||
        (uid !== undefined && file.uid !== uid)
      ) {
        return null;
      }
      const token = readFileSync(fd, "utf8").trim();
      return /^[a-f0-9]{64}$/.test(token) ? `Bearer ${token}` : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export async function probeDaemonReady(
  base: string,
  timeoutMs = 1500
): Promise<"ready" | "warming" | "down"> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/api/ready`, { signal: ctrl.signal });
      if (!res.ok) return "down";
      const json = (await res.json()) as { ready?: boolean };
      return json.ready ? "ready" : "warming";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "down";
  }
}

export interface FetchDaemonJsonOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  warmingTimeoutMs?: number;
  probeTimeoutMs?: number;
  onDown?: () => void;
}

export type FetchDaemonJsonResult<T> =
  | { ok: true; data: T; state: "ready" | "warming"; base: string; headers: Headers }
  | {
      ok: false;
      reason: "no-auth" | "down" | "http-error" | "timeout" | "network-error";
      status?: number;
      timeoutMs?: number;
      message?: string;
      base: string;
    };

/**
 * Fetch a JSON endpoint from the warm daemon HTTP API.
 * Validates the per-user token locally first, probes `/api/ready`, and picks a
 * two-tier request timeout (ready vs cold warmup).
 */
export async function fetchDaemonJson<T>(
  pathWithQuery: string,
  opts?: FetchDaemonJsonOptions
): Promise<FetchDaemonJsonResult<T>> {
  const env = opts?.env ?? process.env;
  const base = resolveDaemonHttpBase(env);
  const auth = readDaemonAuthHeader(opts?.homeDir);
  if (!auth) {
    return { ok: false, reason: "no-auth", base };
  }

  const state = await probeDaemonReady(base, opts?.probeTimeoutMs ?? 1500);
  if (state === "down") {
    opts?.onDown?.();
    return { ok: false, reason: "down", base };
  }

  const timeoutMs =
    state === "warming" ? (opts?.warmingTimeoutMs ?? 90_000) : (opts?.timeoutMs ?? 15_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${pathWithQuery}`, {
      signal: ctrl.signal,
      headers: { Authorization: auth },
    });
    if (!res.ok) {
      return { ok: false, reason: "http-error", status: res.status, base };
    }
    const data = (await res.json()) as T;
    return { ok: true, data, state, base, headers: res.headers };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && (err.name === "AbortError" || /aborted/i.test(message));
    if (isAbort) {
      return { ok: false, reason: "timeout", timeoutMs, message, base };
    }
    return { ok: false, reason: "network-error", message, base };
  } finally {
    clearTimeout(timer);
  }
}
