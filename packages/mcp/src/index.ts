/**
 * @tokmeter/drishti — Public API barrel export.
 *
 * Re-exports the main building blocks so consumers can use:
 *   import { createServer, LiveTracker, formatCost } from "@tokmeter/drishti";
 */

export { createServer, startServer } from "./server.js";
export { runStatusline } from "./statusline.js";
export { startLive } from "./live.js";
export { LiveTracker, type Snapshot, type TokenBreakdown } from "./tracker.js";
export {
  formatNumber,
  formatCost,
  formatPercent,
  formatBar,
  formatBurnRate,
  formatDuration,
  sparkline,
  C,
} from "./formatter.js";
