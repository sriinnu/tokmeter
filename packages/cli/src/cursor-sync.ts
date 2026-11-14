/**
 * `tokmeter cursor sync` — opt-in download of the owner's Cursor usage
 * export from cursor.com. Runs only when invoked; see core's cursor-sync.ts
 * for what is sent where.
 */

import { CursorSyncError, cursorTokenStatus, syncCursorUsage } from "@sriinnu/tokmeter";

export interface CursorSyncArgs {
  since?: string;
  json: boolean;
  dryRun: boolean;
}

const USAGE = `Usage: tokmeter cursor sync [--since YYYY-MM-DD] [--json] [--dry-run]

Downloads your billed Cursor usage (Tab, cloud agents, other machines, cost)
from cursor.com using the session the Cursor app already holds. Off unless run.
  --since D    Start from the UTC calendar month holding D. Default: 90 days
               ago. Whole months are fetched, one file per month.
  --dry-run    Only report whether a Cursor session exists and when it expires.
  --json       Machine-readable output.`;

/** Parse the tokens after `cursor sync`. Returns a string on bad input. */
export function parseCursorSyncArgs(rest: string[]): CursorSyncArgs | string {
  const args: CursorSyncArgs = { json: false, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") args.json = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--since") {
      const v = rest[++i];
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(`${v}T00:00:00Z`))) {
        return "--since needs a date as YYYY-MM-DD";
      }
      args.since = v;
    } else if (a === "--help" || a === "-h") return USAGE;
    else return `Unknown option for cursor sync: ${a}\n\n${USAGE}`;
  }
  return args;
}

/** Entry for `tokmeter cursor <sub> ...`. Returns the process exit code. */
export async function runCursorSyncCommand(rest: string[]): Promise<number> {
  if (rest[0] !== "sync") {
    console.error(USAGE);
    return 1;
  }
  const parsed = parseCursorSyncArgs(rest.slice(1));
  if (typeof parsed === "string") {
    const isHelp = parsed === USAGE;
    (isHelp ? console.log : console.error)(parsed);
    return isHelp ? 0 : 1;
  }

  if (parsed.dryRun) {
    const status = await cursorTokenStatus();
    if (parsed.json) {
      console.log(
        JSON.stringify(
          {
            present: status.present,
            expired: status.expired ?? null,
            expiresInHours: status.expiresInHours ?? null,
            problem: status.problem ?? null,
          },
          null,
          2
        )
      );
    } else if (!status.present) {
      console.log(`No Cursor session found.${status.problem ? ` ${status.problem}` : ""}`);
    } else if (status.problem) {
      console.log(`Cursor session present but unusable: ${status.problem}`);
    } else if (status.expired) {
      console.log(
        `Cursor session present, expired ${Math.abs(status.expiresInHours ?? 0)}h ago. Open Cursor and sign in again.`
      );
    } else {
      console.log(
        `Cursor session present, expires in ${status.expiresInHours}h. Nothing was sent.`
      );
    }
    return 0;
  }

  try {
    const result = await syncCursorUsage({
      sinceMs: parsed.since ? Date.parse(`${parsed.since}T00:00:00Z`) : undefined,
      log: parsed.json ? undefined : (line) => console.error(line),
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Window: ${result.from} → ${result.to} (UTC)`);
      console.log(`Rows fetched: ${result.rows}`);
      for (const w of result.windows) {
        console.log(
          `  ${w.from} → ${w.to}: ${w.rows} rows ${w.written ? "→" : "(kept existing)"} ${w.file}`
        );
      }
    }
    return 0;
  } catch (error) {
    // CursorSyncError messages are scrubbed at the source; anything else is
    // reported by kind only, never by its text.
    const message =
      error instanceof CursorSyncError
        ? error.message
        : "Cursor sync failed unexpectedly. Nothing further was sent.";
    if (parsed.json) console.log(JSON.stringify({ error: message }, null, 2));
    else console.error(`Error: ${message}`);
    return 1;
  }
}
