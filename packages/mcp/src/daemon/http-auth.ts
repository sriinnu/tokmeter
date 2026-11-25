/**
 * Daemon HTTP host validation and bearer-token lifecycle.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { DAEMON_STATE_DIR, DAEMON_TOKEN_FILE, LEGACY_DAEMON_TOKEN_FILE } from "./protocol.js";

let _authToken: string | null = null;

/**
 * Validate the HTTP Host header against localhost (DNS-rebinding defense).
 */
export function isAllowedHttpHost(host?: string): boolean {
  if (!host) return true;
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * Write `data` to `path` with mode 0600 using `O_CREAT|O_EXCL|O_WRONLY`.
 */
export function writeSecretFile(path: string, data: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* file may not exist; EXCL open catches races */
  }
  const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

export function initAuthToken(): void {
  _authToken = randomBytes(32).toString("hex");
  mkdirSync(DAEMON_STATE_DIR, { recursive: true, mode: 0o700 });
  const state = lstatSync(DAEMON_STATE_DIR);
  if (!state.isDirectory() || (process.getuid && state.uid !== process.getuid())) {
    throw new Error("Daemon state directory is not an owner-controlled directory");
  }
  if (process.platform !== "win32") chmodSync(DAEMON_STATE_DIR, 0o700);
  writeSecretFile(DAEMON_TOKEN_FILE, _authToken);
  try {
    writeSecretFile(LEGACY_DAEMON_TOKEN_FILE, _authToken);
  } catch {
    /* ignore — legacy clients just won't authenticate */
  }
}

export function getAuthToken(): string | null {
  return _authToken;
}

export function clearAuthToken(): void {
  _authToken = null;
}

/**
 * Constant-time bearer-token validation. Fails closed before token publication.
 */
export function isValidAuthHeader(header: string | undefined, token: string | null): boolean {
  if (!token) return false;
  const value = header ?? "";
  const expected = `Bearer ${token}`;
  const supplied = Buffer.from(value);
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length) return false;
  return timingSafeEqual(supplied, wanted);
}

export function checkAuth(req: IncomingMessage): boolean {
  return isValidAuthHeader(req.headers.authorization, _authToken);
}
