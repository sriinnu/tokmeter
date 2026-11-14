/**
 * `tokmeter cursor-hook install | uninstall | status`. The work is in core's
 * cursor-hook module, which the daemon also uses to keep the hook installed.
 */

import {
  CURSOR_HOOK_SCRIPT_VERSION,
  CURSOR_TURN_SEMANTICS,
  cursorHookStatus,
  installCursorHook,
  type TokenTotals,
  uninstallCursorHook,
} from "@sriinnu/tokmeter";

export interface CursorHookCliOptions {
  sub: string;
  rest: string[];
  json?: boolean;
}

/** Entry point for `tokmeter cursor-hook <sub> [--home DIR] [--node PATH] [--json]`. */
export async function runCursorHook(opts: CursorHookCliOptions): Promise<number> {
  let home: string | undefined;
  let nodePath: string | undefined;
  let json = opts.json ?? false;
  for (let i = 0; i < opts.rest.length; i++) {
    const arg = opts.rest[i];
    if (arg === "--home") home = opts.rest[++i];
    else if (arg === "--node") nodePath = opts.rest[++i];
    else if (arg === "--json") json = true;
  }
  try {
    if (opts.sub === "install") {
      const result = await installCursorHook({ home, nodePath });
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Cursor stop hook installed (script v${CURSOR_HOOK_SCRIPT_VERSION}).`);
        console.log(`  script:  ${result.paths.scriptFile}`);
        console.log(
          `  hooks:   ${result.paths.hooksFile}${result.hooksChanged ? "" : " (already up to date)"}`
        );
        console.log(`  journal: ${result.paths.journalDir}`);
        console.log("Only turns that end after this point are recorded.");
        console.log(
          "Shadow mode: turns are recorded and shown by `tokmeter cursor-hook status`, but not counted until their numbers are verified."
        );
      }
      return 0;
    }
    if (opts.sub === "uninstall") {
      const result = await uninstallCursorHook({ home });
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(
          result.removedEntries > 0
            ? `Removed the tokmeter stop hook from ${result.paths.hooksFile}.`
            : `No tokmeter stop hook in ${result.paths.hooksFile}.`
        );
        console.log(`The journal stays at ${result.paths.journalDir}.`);
      }
      return 0;
    }
    if (opts.sub === "status") {
      const s = cursorHookStatus({ home });
      if (json) {
        console.log(JSON.stringify(s, null, 2));
        return 0;
      }
      console.log(`Cursor stop hook: ${s.installed ? "installed" : "not installed"}`);
      if (s.hooksFileError) console.log(`  hooks.json: ${s.hooksFileError}`);
      if (s.entries > 1) console.log(`  warning: ${s.entries} tokmeter entries in hooks.json`);
      if (s.entries > 0 && !s.scriptPresent)
        console.log("  warning: hook script is missing; reinstall");
      if (s.nodePresent === false)
        console.log("  warning: the node binary in the hook command is gone; reinstall");
      if (s.scriptVersion !== undefined && s.scriptVersion < CURSOR_HOOK_SCRIPT_VERSION) {
        console.log(
          `  script v${s.scriptVersion} is older than v${CURSOR_HOOK_SCRIPT_VERSION}; reinstall`
        );
      }
      console.log(`  journal: ${s.paths.journalDir} (${s.journalFiles} day files)`);
      console.log(`  turns today: ${s.turnsToday} (${s.turnsTodayWithUsage} with usage)`);
      const fmt = (t: TokenTotals) =>
        `in ${t.input.toLocaleString()}, out ${t.output.toLocaleString()}, cache read ${t.cacheRead.toLocaleString()}, cache write ${t.cacheWrite.toLocaleString()}`;
      for (const t of s.todayTurns) {
        const when = t.ts !== undefined ? new Date(t.ts).toLocaleTimeString() : "?";
        console.log(
          `    ${when}  ${t.model ?? "?"}  ${t.status ?? "?"}  ${t.hasUsage ? fmt(t) : "no usage"}`
        );
      }
      if (s.turnsToday > 0) console.log(`  today's sum: ${fmt(s.todayTotals)}`);
      if (!CURSOR_TURN_SEMANTICS.verified) {
        console.log("  shadow mode: these turns are recorded but not counted yet");
      }
      if (s.lastTurn) {
        console.log(
          `  last turn: ${new Date(s.lastTurn.ts).toLocaleString()}, ${s.lastTurn.status ?? "?"}, ${s.lastTurn.model ?? "?"}${s.lastTurn.hasUsage ? "" : ", no usage"}`
        );
      } else console.log("  last turn: none yet");
      return 0;
    }
    console.error(
      "Usage: tokmeter cursor-hook install | uninstall | status [--home DIR] [--node PATH] [--json]"
    );
    return 1;
  } catch (error) {
    console.error(`cursor-hook ${opts.sub}: ${(error as Error).message}`);
    return 1;
  }
}
