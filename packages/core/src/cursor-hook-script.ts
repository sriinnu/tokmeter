/**
 * Source of the Cursor `stop` hook that `tokmeter cursor-hook install` writes
 * to ~/.tokmeter/hooks/cursor-stop.mjs.
 *
 * It is a string, not a module in the repo, so the installed file imports
 * nothing from tokmeter: it keeps working after a dist is deleted, a package
 * upgrade moves files, or tokmeter is uninstalled. Only `node:` builtins.
 *
 * Cursor 3.11 runs a hook command through a shell (on macOS/Linux, with the
 * payload piped in as `printf %s '<base64>' | base64 -d | <command>`, or on
 * stdin when the `hooks_stdin_transport` gate is on). The script reads stdin
 * to EOF either way.
 *
 * What it keeps is an allowlist: user_email, transcript_path, session_id and
 * anything Cursor adds later never reach disk. The stdout response is always
 * `{}`: a `followup_message` would make Cursor submit a new turn, and the hook
 * must never steer Cursor.
 *
 * The journal schema is `v`. The reader (packages/core/src/parsers/
 * cursor-turn-journal.ts) reads every version it knows and skips the rest, so
 * a schema change bumps both together.
 */

/** Marker the installer replaces with the JSON-quoted journal directory. */
export const JOURNAL_DIR_PLACEHOLDER = "__TOKMETER_CURSOR_JOURNAL_DIR__";

/** Version of the line the hook writes. The reader must know it. */
export const CURSOR_TURN_SCHEMA = 1;

/** Script version, printed in its header so `status` can spot an old copy. */
export const CURSOR_HOOK_SCRIPT_VERSION = 1;

// The script uses no template literals of its own, so it embeds in this one.
const SOURCE = `// tokmeter Cursor stop hook, script v${CURSOR_HOOK_SCRIPT_VERSION}.
// Written by \`tokmeter cursor-hook install\`; reinstalling overwrites it.
// Appends one line per finished Cursor turn: ids, model, status and the four
// token counts. No message text, no email. Always prints {} and exits 0.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

var JOURNAL_DIR = ${JOURNAL_DIR_PLACEHOLDER};
var SCHEMA = ${CURSOR_TURN_SCHEMA};
var MAX_INPUT = 1048576;
var MAX_LINE = 4000;
var finished = false;

function finish() {
  if (finished) return;
  finished = true;
  try {
    writeSync(1, "{}\\n");
  } catch (e) {}
  process.exit(0);
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function str(v, max) {
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

function count(v) {
  if (typeof v === "string" && /^[0-9]{1,15}$/.test(v)) v = Number(v);
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  return Math.round(v);
}

function record(raw) {
  var p;
  try {
    p = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) return;
  // Installed for \`stop\` only. If it ends up on another event (for example
  // afterAgentResponse, which repeats the same counts), write nothing.
  if (typeof p.hook_event_name === "string" && p.hook_event_name !== "stop") return;
  var now = Date.now();
  var line = { v: SCHEMA, ts: now };
  var keep = function (key, value) {
    if (value !== undefined) line[key] = value;
  };
  keep("conversation_id", str(p.conversation_id, 256));
  keep("generation_id", str(p.generation_id, 256));
  keep("model", str(p.model, 256));
  keep("model_id", str(p.model_id, 256));
  keep("status", str(p.status, 64));
  keep("loop_count", count(p.loop_count));
  keep("input_tokens", count(p.input_tokens));
  keep("output_tokens", count(p.output_tokens));
  keep("cache_read_tokens", count(p.cache_read_tokens));
  keep("cache_write_tokens", count(p.cache_write_tokens));
  keep("cursor_version", str(p.cursor_version, 64));
  if (Array.isArray(p.workspace_roots)) keep("workspace_root", str(p.workspace_roots[0], 1024));
  if (!line.conversation_id && !line.generation_id && !line.status) return;

  var buf = Buffer.from(JSON.stringify(line) + "\\n", "utf8");
  if (buf.length > MAX_LINE) {
    delete line.workspace_root;
    buf = Buffer.from(JSON.stringify(line) + "\\n", "utf8");
    if (buf.length > MAX_LINE) return;
  }
  var d = new Date(now);
  var day = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  mkdirSync(JOURNAL_DIR, { recursive: true, mode: 448 });
  // One O_APPEND write of a buffer under 4 KB: concurrent Cursor windows each
  // land a whole line, so no lock is needed.
  var fd = openSync(join(JOURNAL_DIR, day + ".jsonl"), "a", 384);
  try {
    writeSync(fd, buf, 0, buf.length);
  } finally {
    closeSync(fd);
  }
}

function handle() {
  if (finished) return;
  try {
    if (!tooBig) record(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {}
  finish();
}

var chunks = [];
var size = 0;
var tooBig = false;
// A payload that never closes stdin must not hold Cursor up.
setTimeout(handle, 700);
try {
  process.stdin.on("data", function (c) {
    size += c.length;
    if (size > MAX_INPUT) tooBig = true;
    else chunks.push(c);
  });
  process.stdin.on("end", handle);
  process.stdin.on("error", handle);
} catch (e) {
  finish();
}
`;

/** The hook script, with the journal directory baked in. */
export function buildCursorHookScript(journalDir: string): string {
  // A function replacement: a string one would read `$$`, `$'` or `$&` in
  // the path as replacement patterns.
  return SOURCE.replace(JOURNAL_DIR_PLACEHOLDER, () => JSON.stringify(journalDir));
}
