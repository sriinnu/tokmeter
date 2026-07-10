/**
 * @sriinnu/tokmeter-core — Codex Desktop (ChatGPT app) session parser.
 *
 * OpenAI's Codex Desktop app (bundled inside ChatGPT.app as "Codex
 * Framework.framework") writes to the SAME ~/.codex/sessions/ store as the
 * codex CLI, using an overlapping JSONL event schema — but it never emits a
 * token_count event anywhere in the file, so CodexParser (which only turns
 * token_count events into records) correctly produces zero records for these
 * sessions. That's not a CodexParser bug; it's a real gap — Desktop sessions
 * were invisible in tokmeter entirely, model and all, even on days the user
 * spent real quota inside one (confirmed against a live "6% used, 5.6 sol"
 * AUriva session that had zero usage/token fields anywhere in its rollout).
 *
 * This parser surfaces the same activity-only signal already established for
 * other opaque/quota-billed clients (VS Code Copilot, Antigravity): one
 * record per session — model + project + start timestamp — tokens/cost
 * explicitly not_exposed (see defaultUsageProvenance in utils.ts) rather than
 * guessed at.
 *
 * Discriminator: session_meta.originator === "Codex Desktop". Real CLI
 * sessions carry "codex_cli_rs" or "codex-tui" and are left entirely to
 * CodexParser — any file that isn't a confirmed Desktop originator is
 * skipped here, so a session can never be double-counted under both
 * provider ids.
 */

import { open, stat } from "node:fs/promises";
import { canonicalizeProjectName } from "../project-name.js";
import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import { codexSessionDirs } from "./codex.js";
import { createRecord, filterFilesByMtime, findFiles, mapWithConcurrency } from "./utils.js";

const DESKTOP_ORIGINATOR = "Codex Desktop";
const SCAN_CONCURRENCY = 8;
const DEFAULT_MODEL = "unknown";

interface CodexDesktopEvent {
  timestamp?: string;
  type?: string;
  payload?: {
    originator?: string;
    cwd?: string;
    model?: string;
  };
}

interface DesktopSessionSummary {
  timestampMs: number | null;
  project: string;
  model: string;
}

/** session_meta is always the first line, so a small read is enough to
 * decide whether a file is worth a second look — the common case (a real CLI
 * session) bails out here without ever touching the rest of the file. */
const DISCRIMINATOR_BYTES = 65_536;

/** Real Desktop rollouts pack large `response_item` events (system prompt,
 * early tool output) between session_meta and the first turn_context — one
 * observed real file put turn_context past the 100 KB mark. Only paid for
 * files already confirmed Desktop, so the common CLI-skip path stays cheap. */
const DESKTOP_DETAIL_BYTES = 1_048_576;

function parseEventLines(text: string): CodexDesktopEvent[] {
  const events: CodexDesktopEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as CodexDesktopEvent);
    } catch {
      // partial/malformed line — ignore
    }
  }
  return events;
}

async function readHead(fd: Awaited<ReturnType<typeof open>>, bytes: number): Promise<string> {
  const buf = Buffer.alloc(bytes);
  const { bytesRead } = await fd.read(buf, 0, bytes, 0);
  return buf.toString("utf-8", 0, bytesRead);
}

/**
 * Determine whether a rollout is a confirmed "Codex Desktop" session and, if
 * so, extract its start time/project/model. Returns null for anything that
 * isn't a confirmed Desktop session (unreadable file, no session_meta, or a
 * CLI originator) — callers never need to re-check the discriminator.
 */
async function readDesktopSummary(
  file: string,
  sizeBytes: number
): Promise<DesktopSessionSummary | null> {
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(file, "r");

    const headEvents = parseEventLines(await readHead(fd, Math.min(DISCRIMINATOR_BYTES, sizeBytes)));
    const meta = headEvents.find((e) => e.type === "session_meta");
    if (!meta?.payload || meta.payload.originator !== DESKTOP_ORIGINATOR) return null;

    let timestampMs: number | null = null;
    if (meta.timestamp) {
      const t = new Date(meta.timestamp).getTime();
      if (!Number.isNaN(t)) timestampMs = t;
    }
    const cwd = meta.payload.cwd ?? "";

    // Confirmed Desktop — worth the bigger read to find the model.
    const detailEvents =
      sizeBytes <= DISCRIMINATOR_BYTES
        ? headEvents
        : parseEventLines(await readHead(fd, Math.min(DESKTOP_DETAIL_BYTES, sizeBytes)));
    const turnContext = detailEvents.find((e) => e.type === "turn_context" && e.payload?.model);
    const model = turnContext?.payload?.model ?? DEFAULT_MODEL;

    return {
      timestampMs,
      project: cwd ? canonicalizeProjectName(cwd, "codex-desktop") : "codex-desktop",
      model,
    };
  } catch {
    return null;
  } finally {
    if (fd) {
      try {
        await fd.close();
      } catch {
        /* best-effort close */
      }
    }
  }
}

export class CodexDesktopParser implements SessionParser {
  readonly providerId = "codex-desktop" as const;

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const seenFiles = new Set<string>();
    let allFiles: string[] = [];
    for (const dir of codexSessionDirs("codex-desktop", homeDir)) {
      for (const f of await findFiles(dir, (f) => f.endsWith(".jsonl"), 5)) {
        if (seenFiles.has(f)) continue;
        seenFiles.add(f);
        allFiles.push(f);
      }
    }

    if (opts?.modifiedSinceMs !== undefined) {
      allFiles = await filterFilesByMtime(allFiles, opts.modifiedSinceMs);
    }

    const entries = await mapWithConcurrency(allFiles, SCAN_CONCURRENCY, async (f) => {
      try {
        const st = await stat(f);
        const summary = await readDesktopSummary(f, st.size);
        return summary ? { file: f, summary } : null;
      } catch {
        return null;
      }
    });

    const records: TokenRecord[] = [];
    for (const entry of entries) {
      if (!entry) continue;
      records.push(
        createRecord({
          timestamp: entry.summary.timestampMs ?? Date.now(),
          provider: "codex-desktop",
          model: entry.summary.model,
          project: entry.summary.project,
          sourceFile: entry.file,
        })
      );
    }
    return records;
  }
}
