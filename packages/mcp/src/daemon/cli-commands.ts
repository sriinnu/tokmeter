/**
 * Daemon CLI subcommands: start, stop, status, restart, install-agent, uninstall-agent.
 */

import { daemonChildEnv, isDaemonChildEnv } from "./compat-names.js";
import { signalVerifiedDaemon } from "./identity.js";
import {
  AGENT_LABEL,
  agentPlistPath,
  installAgent,
  isAgentInstalled,
  isAgentLoaded,
  kickstartAgent,
  uninstallAgent,
} from "./launchd.js";
import { DAEMON_PORT_ENV, daemonPortOverride } from "./port.js";
import { DAEMON_IDENTITY_FILE, DAEMON_PID_FILE } from "./protocol.js";
import { getDaemonStatus, isDaemonRunning, startDaemon, stopDaemon } from "./server.js";

/**
 * V8 old-space cap (MB) for the spawned daemon child.
 */
const DAEMON_HEAP_CAP_MB = Number.parseInt(process.env.TOKMETER_DAEMON_HEAP_MB ?? "6144", 10);

/**
 * Poll asynchronously until `isRunning()` returns `false` or attempts are exhausted.
 */
export async function waitForDaemonExit(
  isRunning: () => boolean,
  maxAttempts = 10,
  intervalMs = 200
): Promise<void> {
  let remaining = maxAttempts;
  while (remaining > 0 && isRunning()) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    remaining--;
  }
}

/**
 * Handle `tokmeter-mcp daemon <command>`.
 * When running as the detached daemon child, executes `startDaemon()` in the foreground.
 */
export async function runDaemonCLI(command: string): Promise<void> {
  const portOverridden = daemonPortOverride() !== null;
  if (portOverridden && ["install-agent", "uninstall-agent"].includes(command)) {
    console.log(
      `launchd supervision applies to the default daemon port only; unset ${DAEMON_PORT_ENV}.`
    );
    return;
  }
  const agentLoaded = () => !portOverridden && isAgentLoaded();
  if (
    ["stop", "restart", "install-agent"].includes(command) &&
    !agentLoaded() &&
    getDaemonStatus().identity === "unverified"
  ) {
    throw new Error(
      "Cannot verify daemon ownership; refusing process control. Inspect daemon status before retrying."
    );
  }
  switch (command) {
    case "start":
      if (isDaemonRunning()) {
        console.log("Daemon is already running");
        console.log(getDaemonStatus());
        break;
      }

      if (!isDaemonChildEnv() && agentLoaded()) {
        try {
          kickstartAgent();
          await new Promise((r) => setTimeout(r, 800));
          console.log("【♾️】 Tokmeter daemon started via launchd");
          console.log(getDaemonStatus());
          break;
        } catch (err) {
          console.log(`launchd kickstart failed (${err}); starting manually instead`);
        }
      }

      if (isDaemonChildEnv()) {
        startDaemon();
        process.on("SIGINT", () => {
          stopDaemon();
          process.exit(0);
        });
        process.on("SIGTERM", () => {
          stopDaemon();
          process.exit(0);
        });
        break;
      }

      {
        const { spawn } = await import("node:child_process");
        const child = spawn(process.execPath, [process.argv[1], "daemon", "start"], {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            ...daemonChildEnv(),
            NODE_OPTIONS:
              `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${DAEMON_HEAP_CAP_MB}`.trim(),
          },
        });
        child.unref();

        await new Promise((r) => setTimeout(r, 800));
        if (isDaemonRunning()) {
          console.log("【♾️】 Tokmeter daemon started (background)");
          console.log(getDaemonStatus());
        } else {
          console.log("【♾️】 Daemon starting… (check `tokmeter-mcp daemon status` in a moment)");
        }
        process.exit(0);
      }
      break;

    case "stop":
      if (agentLoaded()) {
        console.log(
          "Daemon is launchd-supervised — stopping it directly won't stick.\n" +
            "    To stop it, run: tokmeter-mcp daemon uninstall-agent"
        );
        break;
      }
      if (isDaemonRunning()) {
        const { pid } = getDaemonStatus();
        if (pid) {
          signalVerifiedDaemon(DAEMON_PID_FILE, DAEMON_IDENTITY_FILE);
          await waitForDaemonExit(isDaemonRunning);
          console.log(isDaemonRunning() ? "Daemon still shutting down…" : "Daemon stopped");
        }
      } else {
        console.log("Daemon is not running");
      }
      break;

    case "status":
      console.log(getDaemonStatus());
      break;

    case "restart":
      if (agentLoaded()) {
        try {
          kickstartAgent();
          await new Promise((r) => setTimeout(r, 800));
          console.log("【♾️】 Tokmeter daemon restarted via launchd");
          console.log(getDaemonStatus());
          break;
        } catch (err) {
          console.log(`launchd kickstart failed (${err}); restarting manually instead`);
        }
      }
      if (isDaemonRunning()) {
        const { pid } = getDaemonStatus();
        if (pid) {
          signalVerifiedDaemon(DAEMON_PID_FILE, DAEMON_IDENTITY_FILE);
          await waitForDaemonExit(isDaemonRunning);
        }
      }
      await runDaemonCLI("start");
      break;

    case "install-agent": {
      if (process.platform !== "darwin") {
        console.log("launchd supervision is macOS-only; on this platform use `daemon start`.");
        break;
      }
      if (isDaemonRunning()) {
        const { pid } = getDaemonStatus();
        if (pid) {
          signalVerifiedDaemon(DAEMON_PID_FILE, DAEMON_IDENTITY_FILE);
          await waitForDaemonExit(isDaemonRunning);
        }
      }
      if (isDaemonRunning()) {
        console.log(
          "A daemon is still running and wouldn't release port. Aborting install.\n" +
            "    Stop it (tokmeter-mcp daemon stop) and retry install-agent."
        );
        break;
      }
      try {
        const { plistPath, heapEnforced } = installAgent();
        console.log(`【♾️】 launchd agent installed: ${plistPath}`);
        console.log("    Respawns on crash, OOM, and login (clean exits stay down).");
        if (!heapEnforced) {
          console.log(
            "    ⚠ heap cap NOT enforced — the agent launches via bun, which ignores\n" +
              "      NODE_OPTIONS --max-old-space-size. Build the dist (bun run build) so a\n" +
              "      node+dist entry is available, or set TOKMETER_DAEMON_HEAP_MB awareness."
          );
        }
        await new Promise((r) => setTimeout(r, 1000));
        console.log(getDaemonStatus());
      } catch (err) {
        console.log(`Failed to install launchd agent: ${err}`);
      }
      break;
    }

    case "uninstall-agent": {
      if (!isAgentInstalled()) {
        console.log("No launchd agent installed.");
        break;
      }
      try {
        uninstallAgent();
        console.log(`Removed launchd agent (${AGENT_LABEL}) and plist at ${agentPlistPath()}`);
        console.log("    The daemon is no longer supervised. Use `daemon start` to run it.");
      } catch (err) {
        console.log(`Failed to remove launchd agent: ${err}`);
      }
      break;
    }

    default:
      console.log(
        "Usage: tokmeter-mcp daemon [start|stop|status|restart|install-agent|uninstall-agent]"
      );
  }
}
