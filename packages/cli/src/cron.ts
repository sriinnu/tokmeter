// cron.ts — install/uninstall a launchd plist that runs `tokmeter update`
// daily at 00:05 local time. Keeps the kosha pricing registry fresh so
// today's records freeze with up-to-date rates at midnight rollover.
//
// The plist lives at ~/Library/LaunchAgents/com.sriinnu.tokmeter.daily.plist
// and is loaded via `launchctl bootstrap`. launchd handles missed events:
// if the machine is asleep at 00:05, the job fires when it wakes up.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LABEL = "com.sriinnu.tokmeter.daily";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);
const LOG_PATH = join(homedir(), ".cache", "tokmeter", "daily-cron.log");

/** Escape XML reserved chars so a path with `&` doesn't break the plist. */
function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Decide what command launchd should run daily. Preference order:
 *   1. A `tokmeter` binary on the user's PATH (resolved via `which`)
 *      — stable, version-controlled by the user, no network at run time.
 *   2. The currently-running entry script if it's at a stable absolute
 *      path (not under ~/.npm/_npx where npx GC reaps it). Invoked via
 *      the same runtime as `process.argv[0]`.
 *   3. Pinned `npx -y @sriinnu/tokmeter@<version>` fallback. The version
 *      is read from this package's package.json so we don't track @latest
 *      (which would silently pull whatever happens to be the newest publish
 *      at 00:05 — supply-chain risk + opaque upgrades).
 */
function resolveLaunchCommand(): { description: string; shellCommand: string } {
  // (1) `which tokmeter` — covers npm -g, brew install, manual /usr/local
  try {
    const path = execSync("/usr/bin/which tokmeter", { encoding: "utf8" }).trim();
    if (path && existsSync(path)) {
      return {
        description: `tokmeter binary on PATH (${path})`,
        shellCommand: `${shellQuote(path)} update`,
      };
    }
  } catch {
    // not on PATH — fall through
  }

  // (2) The currently-running script, if it's at a stable path
  const argvScript = process.argv[1];
  const runtime = process.argv[0];
  if (argvScript && runtime && isStablePath(argvScript) && isStablePath(runtime)) {
    return {
      description: `currently-running tokmeter (${argvScript})`,
      shellCommand: `${shellQuote(runtime)} ${shellQuote(argvScript)} update`,
    };
  }

  // (3) Pinned npx fallback
  const version = readOwnVersion();
  return {
    description: `npx fallback @sriinnu/tokmeter@${version}`,
    shellCommand: `npx -y @sriinnu/tokmeter@${version} update`,
  };
}

/** Reads this package's version from package.json so the npx fallback is pinned. */
function readOwnVersion(): string {
  // The compiled JS lives in dist/, so package.json is one directory up.
  // import.meta.url is the most portable way to find it under both bun and node.
  try {
    const here = new URL(import.meta.url).pathname;
    const pkgPath = join(dirname(dirname(here)), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "latest";
  } catch {
    return "latest";
  }
}

/** A path is "stable" if launchd will still find it tomorrow. Excludes
 *  ephemeral npx caches and tmp dirs. */
function isStablePath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (p.includes("/.npm/_npx/")) return false;
  if (p.startsWith("/tmp/")) return false;
  if (p.startsWith("/private/var/folders/")) return false;
  return existsSync(p);
}

/** Shell-quote with single quotes — caller controls argv, so we just need
 *  to defang any single-quote characters in pathological paths. */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function plistContents(shellCommand: string): string {
  // PATH includes both Apple Silicon and Intel Homebrew so npx resolves
  // regardless of architecture. We invoke /bin/sh directly (not via $SHELL
  // -l) because launchd has no login shell — sourcing dotfiles would silently
  // fail and the job would never run.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>: &gt; ${xmlEscape(LOG_PATH)} 2&gt;/dev/null; PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin ${xmlEscape(shellCommand)}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>0</integer>
        <key>Minute</key>
        <integer>5</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(LOG_PATH)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(LOG_PATH)}</string>
</dict>
</plist>
`;
}

export function installDailyCron(): void {
  if (!existsSync(PLIST_DIR)) {
    mkdirSync(PLIST_DIR, { recursive: true });
  }
  const logDir = join(homedir(), ".cache", "tokmeter");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const cmd = resolveLaunchCommand();
  console.log(`Daily-run command: ${cmd.description}`);
  writeFileSync(PLIST_PATH, plistContents(cmd.shellCommand), { mode: 0o644 });
  console.log(`Wrote launchd plist: ${PLIST_PATH}`);

  // Reload if already loaded — bootout fails when not loaded; that's fine.
  try {
    execSync(`launchctl bootout gui/$(id -u)/${LABEL}`, { stdio: "ignore" });
  } catch {
    // Expected on first install — there's nothing to bootout yet.
  }
  try {
    execFileSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, PLIST_PATH], {
      stdio: "inherit",
    });
    console.log("Loaded into launchd. Next run: tomorrow 00:05 local.");
    console.log(`Logs: ${LOG_PATH}`);
  } catch (err) {
    console.error(
      `Failed to load plist into launchd: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}

export function uninstallDailyCron(): void {
  try {
    execSync(`launchctl bootout gui/$(id -u)/${LABEL}`, { stdio: "ignore" });
  } catch {
    // Not loaded — nothing to bootout, that's the success path for uninstall.
  }

  if (existsSync(PLIST_PATH)) {
    unlinkSync(PLIST_PATH);
    console.log(`Removed ${PLIST_PATH}`);
  } else {
    console.log("No daily-cron plist installed.");
  }
}

export function cronStatus(): void {
  const installed = existsSync(PLIST_PATH);
  console.log(`Plist file: ${installed ? "present" : "absent"} (${PLIST_PATH})`);
  if (!installed) return;

  try {
    const output = execSync(`launchctl print gui/$(id -u)/${LABEL} 2>&1 || true`, {
      encoding: "utf8",
    });
    if (output.includes("could not find")) {
      console.log("launchd: not loaded");
    } else {
      const stateLine = output
        .split("\n")
        .find((l) => l.trim().startsWith("state ="));
      const lastExitLine = output
        .split("\n")
        .find((l) => l.trim().startsWith("last exit code"));
      console.log(`launchd: loaded`);
      if (stateLine) console.log(`  ${stateLine.trim()}`);
      if (lastExitLine) console.log(`  ${lastExitLine.trim()}`);
    }
  } catch {
    console.log("launchd: status unavailable (launchctl print failed)");
  }
  console.log(`Logs: ${LOG_PATH}`);
}
