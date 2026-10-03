/**
 * @sriinnu/tokmeter-mcp — launchd supervision for the aggregation daemon (macOS).
 *
 * The daemon is a long-lived singleton: everything (statusline, CLI, macOS
 * bar) reads it. If it dies — uncaught exception, OOM-kill at the heap cap, a
 * logout — nothing brings it back until the user notices the bar say
 * "offline". A launchd LaunchAgent with `KeepAlive` makes the OS the
 * supervisor: it respawns the daemon within seconds of any exit and starts it
 * at login. This is the durable backstop behind the in-process error handling
 * in cli.ts.
 *
 * Lifecycle modelled here:
 *   installAgent()   — write the plist + bootstrap it into the gui domain
 *   uninstallAgent() — bootout + remove the plist
 *   isAgentInstalled / isAgentLoaded — introspection
 *   kickstartAgent() — ask launchd to (re)start the managed daemon now
 *
 * launchd runs the daemon in the FOREGROUND (DAEMON_CHILD_FLAG set) so the
 * process launchd watches IS the daemon — not a parent that forks and exits,
 * which launchd would misread as a crash and respawn-storm.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_STATE_DIR } from "./protocol.js";

/** Reverse-DNS label launchd keys the agent by. */
export const AGENT_LABEL = "com.tokmeter.daemon";

/** The env flag that tells the CLI entry to run the daemon in the foreground. */
const DAEMON_CHILD_FLAG = "__DRISHTI_DAEMON_CHILD__";

/** `~/Library/LaunchAgents/com.tokmeter.daemon.plist`. */
export function agentPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}

/** The plist exists on disk (agent is installed, though maybe not loaded). */
export function isAgentInstalled(): boolean {
  return existsSync(agentPlistPath());
}

/** launchd has the agent bootstrapped in the user's gui domain. */
export function isAgentLoaded(): boolean {
  try {
    execFileSync("launchctl", ["print", guiTarget()], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function userId(): number {
  // darwin always has getuid; fall back to 0 only to keep types happy.
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function guiDomain(): string {
  return `gui/${userId()}`;
}

function guiTarget(): string {
  return `gui/${userId()}/${AGENT_LABEL}`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the plist. `nodePath`/`cliEntry` default to the live install's own
 * paths (process.execPath + the running CLI script), so the agent launches
 * exactly what the user is running today. `heapMb` mirrors the daemon's
 * spawn-time heap cap.
 */
export function renderAgentPlist(opts: {
  nodePath: string;
  cliEntry: string;
  heapMb: number;
  logDir: string;
}): string {
  const { nodePath, cliEntry, heapMb, logDir } = opts;
  const args = [nodePath, cliEntry, "daemon", "start"];
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const outLog = join(logDir, "daemon.out.log");
  const errLog = join(logDir, "daemon.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${DAEMON_CHILD_FLAG}</key>
    <string>1</string>
    <key>NODE_OPTIONS</key>
    <string>--max-old-space-size=${heapMb}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!--
    Conditional KeepAlive: respawn ONLY on a non-zero/abnormal exit (crash,
    OOM-kill, the uncaughtException → exit(1) path). A clean exit(0) must NOT
    respawn — the daemon exits 0 intentionally when another process already
    owns port 9876 (EADDRINUSE bow-out) and on a normal SIGTERM shutdown.
    Unconditional KeepAlive here would turn a single port collision into a
    10s-interval respawn storm that never terminates.
  -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
</dict>
</plist>
`;
}

/** Atomically write the plist to ~/Library/LaunchAgents (tmp + rename). */
function writePlist(contents: string): string {
  const dir = join(homedir(), "Library", "LaunchAgents");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = agentPlistPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf-8", mode: 0o644 });
  renameSync(tmp, path);
  return path;
}

/** Resolve `node` on PATH, or null if it can't be found. */
function findNode(): string | null {
  try {
    const out = execFileSync("/usr/bin/which", ["node"], { encoding: "utf-8" }).trim();
    return out.length > 0 && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Pick the runtime + entry the LaunchAgent should launch.
 *
 * The daemon's V8 heap cap is enforced via `NODE_OPTIONS=--max-old-space-size`
 * — but **bun silently ignores that flag**, so a bun-launched daemon has no
 * heap ceiling (the kernel-panic backstop is gone). When we're running under
 * bun-on-TS-source, prefer a real `node` binary + the compiled `dist` entry
 * (src→dist, .ts→.js) so the cap actually bites and the plist isn't coupled to
 * live source. Fall back to the current execPath + entry (with a warning) only
 * when node or the dist build isn't found.
 *
 * Returns `heapEnforced=false` when the chosen runtime won't honor the cap, so
 * the caller can warn instead of silently shipping an uncapped daemon.
 */
/**
 * Map a versioned Homebrew Cellar runtime path to the stable symlink that
 * points at it, when one exists and still resolves to the SAME binary. A plist
 * that hardcodes `/opt/homebrew/Cellar/node/26.9.0/bin/node` is orphaned the
 * moment `brew upgrade node` removes 26.9.0 — the daemon then never comes back
 * after a reboot. Homebrew's `bin/node` (default formula) and `opt/<formula>`
 * (keg-only, e.g. `node@22`) symlinks survive upgrades, so derive both from the
 * Cellar path and prefer whichever resolves to this process's own binary. Only
 * the Homebrew Cellar shape is rewritten; nvm/MacPorts/system node are left as
 * they are (their paths are already stable or not an upgrade-fragile Cellar).
 * Correctness-safe: an alias is accepted only on a byte-identical realpath
 * match, so a dangling or wrong-formula symlink is skipped, not trusted.
 */
function stabilizeNodePath(execPath: string): string {
  // Capture the Homebrew prefix + formula from a versioned Cellar path, e.g.
  // /opt/homebrew/Cellar/node@22/22.1.0/bin/node → prefix=/opt/homebrew,
  // formula=node@22. Only this shape is upgrade-fragile.
  const m = execPath.match(/^(.*)\/Cellar\/(node(?:@[\w.]+)?)\/[^/]+\/bin\/node$/);
  if (!m) return execPath;
  const [, prefix, formula] = m;
  let realExec: string;
  try {
    realExec = realpathSync(execPath);
  } catch {
    return execPath;
  }
  const aliases = [
    `${prefix}/opt/${formula}/bin/node`, // keg-only stable link (node@22, …)
    `${prefix}/bin/node`, // default-formula stable link
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  for (const alias of aliases) {
    if (alias === execPath) continue;
    try {
      if (realpathSync(alias) === realExec) return alias;
    } catch {
      // alias missing or dangling — try the next
    }
  }
  return execPath;
}

export function resolveLaunchTarget(opts?: { nodePath?: string; cliEntry?: string }): {
  nodePath: string;
  cliEntry: string;
  heapEnforced: boolean;
} {
  if (opts?.nodePath && opts?.cliEntry) {
    const isNode = /(^|\/)node$/.test(opts.nodePath);
    return { nodePath: opts.nodePath, cliEntry: opts.cliEntry, heapEnforced: isNode };
  }

  const execPath = process.execPath;
  const entry = process.argv[1] ?? "";
  const runningUnderBun = /(^|\/)bun$/.test(execPath);

  if (!runningUnderBun) {
    // Already node (or node-compatible): use it + the running entry directly,
    // but prefer a stable node symlink so a brew upgrade can't orphan the plist.
    return { nodePath: stabilizeNodePath(execPath), cliEntry: entry, heapEnforced: true };
  }

  // Under bun: try to swap to node + the compiled dist entry so the heap cap
  // is honored.
  const distEntry = entry.replace(/\/src\//, "/dist/").replace(/\.ts$/, ".js");
  const node = findNode();
  if (node && distEntry !== entry && existsSync(distEntry)) {
    return { nodePath: node, cliEntry: distEntry, heapEnforced: true };
  }

  // Couldn't upgrade — run what we have (bun + source). Daemon still works,
  // but the heap cap is a no-op; signal that so the caller warns.
  return { nodePath: execPath, cliEntry: entry, heapEnforced: false };
}

/**
 * Install + load the LaunchAgent. Idempotent: an already-loaded agent is
 * booted out first so the freshly-written plist takes effect. RunAtLoad means
 * bootstrap also starts the daemon, so callers don't need a separate start.
 *
 * Transactional: if `bootstrap` fails, the just-written plist is removed before
 * the error propagates, so a failed install never leaves a stuck half-state
 * (plist on disk → dispatch routes to launchd → but nothing is loaded).
 */
export function installAgent(opts?: {
  nodePath?: string;
  cliEntry?: string;
  heapMb?: number;
}): { plistPath: string; heapEnforced: boolean } {
  const target = resolveLaunchTarget(opts);
  const heapMb = opts?.heapMb ?? Number.parseInt(process.env.TOKMETER_DAEMON_HEAP_MB ?? "6144", 10);

  const plistPath = writePlist(
    renderAgentPlist({
      nodePath: target.nodePath,
      cliEntry: target.cliEntry,
      heapMb,
      logDir: DAEMON_STATE_DIR,
    })
  );

  // Bootout any prior incarnation so the new plist is what loads. Ignore the
  // "not loaded" error on a first install.
  try {
    execFileSync("launchctl", ["bootout", guiTarget()], { stdio: "ignore" });
  } catch {
    /* not loaded yet — fine */
  }
  try {
    execFileSync("launchctl", ["bootstrap", guiDomain(), plistPath], { stdio: "ignore" });
  } catch (err) {
    // Don't leave an orphaned plist that would make every later start/stop
    // route to a launchd agent that isn't actually loaded.
    try {
      unlinkSync(plistPath);
    } catch {
      /* best-effort */
    }
    throw err;
  }
  return { plistPath, heapEnforced: target.heapEnforced };
}

/** Bootout + remove the plist. Both steps best-effort + idempotent. */
export function uninstallAgent(): void {
  try {
    execFileSync("launchctl", ["bootout", guiTarget()], { stdio: "ignore" });
  } catch {
    /* already booted out or never loaded */
  }
  try {
    unlinkSync(agentPlistPath());
  } catch {
    /* already gone */
  }
}

/**
 * Ask launchd to (re)start the managed daemon right now. `-k` kills the
 * current instance first so this doubles as a restart. No-op-safe to call when
 * the agent isn't installed (the caller should gate on isAgentInstalled).
 */
export function kickstartAgent(): void {
  execFileSync("launchctl", ["kickstart", "-k", guiTarget()], { stdio: "ignore" });
}
