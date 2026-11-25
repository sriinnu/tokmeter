#!/usr/bin/env node
/**
 * tokmeter-tui — Interactive terminal UI for token usage tracking.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startTui } from "./app.js";

export {
  fetchDaemonTuiSnapshot,
  startTui,
  TABS,
  type TabId,
  TokmeterApp,
  type TokmeterAppProps,
  type TuiSnapshot,
} from "./app.js";

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry));
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  // Process-level error handlers — log only. Hard-exiting in the middle of an
  // Ink render leaves the terminal in alt-screen mode with no cursor restored.
  // We let Ink unmount cleanly via the in-app exit() path instead.
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
  });

  void startTui();
}
