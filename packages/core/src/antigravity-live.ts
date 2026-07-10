/**
 * @sriinnu/tokmeter-core — Antigravity live credit-status poller.
 *
 * Antigravity's session history (parsers/antigravity.ts) only has a
 * timestamp + touched project — no model or cost, because that data isn't
 * anywhere in local files. But Antigravity's own running `language_server`
 * process exposes a local Connect-RPC endpoint (the same one its own UI and
 * the community "antigravity-panel" extension use) that reports the current
 * model list and remaining prompt/flow credits *right now*. That's live
 * account state, not a historical per-session ledger — it can say "credits
 * consumed since the last poll," never "what you did last Tuesday."
 *
 * Discovery: the language_server's listening port and CSRF token aren't
 * published anywhere on disk — they're only visible on its own process
 * command line (`--csrf_token <uuid>`), so discovery means finding that
 * process and asking the OS which ports it holds open (`ps` + `lsof`).
 * macOS/Linux only; there's no equivalent here for Windows.
 *
 * Every successful poll is appended to an on-disk JSONL log
 * (~/.cache/tokmeter/antigravity-live-snapshots.jsonl) — callers that just
 * want to *show* the data read that log directly (readLatestSnapshot /
 * readSnapshotHistory); only the poll path (meant to run on a timer, not on
 * every read) hits the process/network.
 */

import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AntigravityModelQuota {
  label: string;
  resetTime?: string;
  remainingFraction?: number;
}

export interface AntigravitySnapshot {
  timestamp: number;
  availablePromptCredits: number;
  availableFlowCredits: number;
  models: AntigravityModelQuota[];
}

function snapshotLogPath(homeDir: string): string {
  return join(homeDir, ".cache", "tokmeter", "antigravity-live-snapshots.jsonl");
}

// ─── Process discovery ──────────────────────────────────────────────

interface ServerHandle {
  port: number;
  csrfToken: string;
}

/**
 * Finds Antigravity's language_server process(es) and the ports each one
 * has open. Multiple candidates can come back (this project's dev machine
 * had two live processes with three ports between them, only one of which
 * actually answered the RPC) — callers try each until one works.
 */
async function discoverCandidates(): Promise<ServerHandle[]> {
  let psOut: string;
  try {
    // -eo avoids the 4096-char argument truncation `ps aux` applies on
    // some platforms — the csrf_token flag lives well past that column.
    const { stdout } = await execFileAsync("ps", ["-eo", "pid,args"]);
    psOut = stdout;
  } catch {
    return [];
  }

  const candidates: { pid: string; csrfToken: string }[] = [];
  for (const line of psOut.split("\n")) {
    if (!line.includes("language_server") || !line.includes("csrf_token")) continue;
    const pidMatch = line.trim().match(/^(\d+)/);
    // Prefer extension_server_csrf_token when present (the IDE-generation
    // process pairs it with extension_server_port); otherwise fall back to
    // the plain csrf_token flag every generation carries.
    const tokenMatch =
      line.match(/--extension_server_csrf_token[= ]([a-f0-9-]+)/) ??
      line.match(/--csrf_token[= ]([a-f0-9-]+)/);
    if (pidMatch?.[1] && tokenMatch?.[1]) {
      candidates.push({ pid: pidMatch[1], csrfToken: tokenMatch[1] });
    }
  }

  const handles: ServerHandle[] = [];
  for (const { pid, csrfToken } of candidates) {
    try {
      const { stdout } = await execFileAsync("lsof", ["-p", pid, "-a", "-i", "-P"]);
      for (const line of stdout.split("\n")) {
        const portMatch =
          line.match(/LISTEN.*:(\d+)\s*\(LISTEN\)/) ?? line.match(/:(\d+) \(LISTEN\)/);
        if (portMatch?.[1]) {
          handles.push({ port: Number(portMatch[1]), csrfToken });
        }
      }
    } catch {
      // lsof unavailable or process gone between ps and lsof — skip it
    }
  }
  return handles;
}

// ─── RPC call ────────────────────────────────────────────────────────

const USER_STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const FETCH_TIMEOUT_MS = 3_000;

interface RawUserStatusResponse {
  userStatus?: {
    planStatus?: {
      availablePromptCredits?: number;
      availableFlowCredits?: number;
    };
    cascadeModelConfigData?: {
      clientModelConfigs?: {
        label?: string;
        quotaInfo?: { resetTime?: string; remainingFraction?: number };
      }[];
    };
  };
}

async function fetchUserStatus(handle: ServerHandle): Promise<AntigravitySnapshot | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}${USER_STATUS_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "X-Codeium-Csrf-Token": handle.csrfToken,
      },
      body: JSON.stringify({
        metadata: { ideName: "antigravity", extensionName: "tokmeter", locale: "en" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const data = (await res.json()) as RawUserStatusResponse;
    const status = data.userStatus;
    if (!status) return null;

    return {
      timestamp: Date.now(),
      availablePromptCredits: status.planStatus?.availablePromptCredits ?? 0,
      availableFlowCredits: status.planStatus?.availableFlowCredits ?? 0,
      models: (status.cascadeModelConfigData?.clientModelConfigs ?? [])
        .filter((m) => m.label)
        .map((m) => ({
          label: m.label as string,
          resetTime: m.quotaInfo?.resetTime,
          remainingFraction: m.quotaInfo?.remainingFraction,
        })),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Poll + cache (the only path that touches the process/network) ────

/**
 * Discovers Antigravity's language_server (if running), fetches its current
 * credit status, and appends the result to the on-disk snapshot log.
 * Returns null (and appends nothing) if Antigravity isn't running or the
 * RPC fails — this is a best-effort signal, never a hard requirement.
 * Meant to be called on a timer (see daemon wiring), not per-read.
 */
export async function pollAntigravityLiveStatus(
  homeDir: string = homedir()
): Promise<AntigravitySnapshot | null> {
  const candidates = await discoverCandidates();
  for (const handle of candidates) {
    const snapshot = await fetchUserStatus(handle);
    if (snapshot) {
      appendSnapshot(snapshot, homeDir);
      return snapshot;
    }
  }
  return null;
}

function appendSnapshot(snapshot: AntigravitySnapshot, homeDir: string): void {
  const path = snapshotLogPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(snapshot)}\n`);
}

// ─── Reads (cache-only — never trigger a poll) ─────────────────────────

/** Reads every cached snapshot, oldest first. Malformed lines are skipped. */
export function readSnapshotHistory(homeDir: string = homedir()): AntigravitySnapshot[] {
  const path = snapshotLogPath(homeDir);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim());
  const snapshots: AntigravitySnapshot[] = [];
  for (const line of lines) {
    try {
      snapshots.push(JSON.parse(line) as AntigravitySnapshot);
    } catch {
      // skip malformed line rather than losing the rest of the log
    }
  }
  return snapshots;
}

/** The most recent cached snapshot, or null if none has ever been captured. */
export function readLatestSnapshot(homeDir: string = homedir()): AntigravitySnapshot | null {
  const history = readSnapshotHistory(homeDir);
  return history.length > 0 ? (history[history.length - 1] ?? null) : null;
}

export interface AntigravityCreditsUsedToday {
  promptCreditsUsed: number;
  flowCreditsUsed: number;
  sinceSnapshotAt: number;
}

/**
 * Credits consumed today, computed as the running sum of only the
 * *decreasing* deltas between consecutive same-day snapshots. Credits go up
 * on a quota reset (see each model's resetTime) — a reset is not "negative
 * usage" and must not cancel out real consumption or go negative; it's
 * simply excluded from the sum rather than subtracted.
 */
export function computeCreditsUsedToday(
  homeDir: string = homedir()
): AntigravityCreditsUsedToday | null {
  const history = readSnapshotHistory(homeDir);
  if (history.length === 0) return null;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const todaySnapshots = history.filter((s) => s.timestamp >= todayStartMs);
  if (todaySnapshots.length === 0) return null;

  let promptCreditsUsed = 0;
  let flowCreditsUsed = 0;
  for (let i = 1; i < todaySnapshots.length; i++) {
    const prev = todaySnapshots[i - 1];
    const cur = todaySnapshots[i];
    if (!prev || !cur) continue;
    const promptDelta = prev.availablePromptCredits - cur.availablePromptCredits;
    const flowDelta = prev.availableFlowCredits - cur.availableFlowCredits;
    if (promptDelta > 0) promptCreditsUsed += promptDelta;
    if (flowDelta > 0) flowCreditsUsed += flowDelta;
  }

  const last = todaySnapshots[todaySnapshots.length - 1];
  return { promptCreditsUsed, flowCreditsUsed, sinceSnapshotAt: last?.timestamp ?? todayStartMs };
}

/**
 * Truncates the snapshot log to its most recent N entries. The log is
 * append-only and unbounded by default — call this periodically (e.g. once
 * a day) if long-term disk growth matters; nothing does this automatically.
 */
export function pruneSnapshotHistory(keepLast: number, homeDir: string = homedir()): void {
  const history = readSnapshotHistory(homeDir);
  if (history.length <= keepLast) return;
  const trimmed = history.slice(-keepLast);
  const path = snapshotLogPath(homeDir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${trimmed.map((s) => JSON.stringify(s)).join("\n")}\n`);
  renameSync(tmp, path);
}
