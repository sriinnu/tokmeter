// cron.ts — install/uninstall a launchd plist that runs `tokmeter update`
// daily at 00:05 local time. Keeps the kosha pricing registry fresh so
// today's records freeze with up-to-date rates at midnight rollover.
//
// The plist lives at ~/Library/LaunchAgents/com.sriinnu.tokmeter.daily.plist
// and is loaded via `launchctl bootstrap`. launchd handles missed events:
// if the machine is asleep at 00:05, the job fires when it wakes up.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LABEL = "com.sriinnu.tokmeter.daily";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);
const LOG_PATH = join(homedir(), ".cache", "tokmeter", "daily-cron.log");

function plistContents(): string {
  // PATH includes both Apple Silicon and Intel Homebrew so npx resolves
  // regardless of architecture. We invoke npx directly (not via $SHELL -l)
  // because launchd has no login shell — sourcing dotfiles would silently
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
        <string>PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin npx -y @sriinnu/tokmeter@latest update</string>
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
    <string>${LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>
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

  writeFileSync(PLIST_PATH, plistContents(), { mode: 0o644 });
  console.log(`Wrote launchd plist: ${PLIST_PATH}`);

  // Reload if already loaded; ignore the error if it isn't.
  try {
    execSync(`launchctl bootout gui/$(id -u)/${LABEL}`, { stdio: "ignore" });
  } catch {}
  try {
    execSync(`launchctl bootstrap gui/$(id -u) "${PLIST_PATH}"`, { stdio: "inherit" });
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
  } catch {}

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
  } catch {}
  console.log(`Logs: ${LOG_PATH}`);
}
