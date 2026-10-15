/**
 * @sriinnu/tokmeter-mcp — Public API barrel export.
 *
 * Re-exports the main building blocks so consumers can use:
 *   import { createServer, LiveTracker, formatCost } from "@sriinnu/tokmeter-mcp";
 */

export {
  C,
  formatBar,
  formatBurnRate,
  formatCost,
  formatDuration,
  formatNumber,
  formatPercent,
  sparkline,
} from "./formatter.js";
export { startLive } from "./live.js";
export { createServer, startServer } from "./server.js";
export { runStatusline } from "./statusline.js";
export { LiveTracker, type Snapshot, type TokenBreakdown } from "./tracker.js";
