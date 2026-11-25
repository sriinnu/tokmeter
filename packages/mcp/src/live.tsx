/**
 * @sriinnu/tokmeter-mcp — Live TUI Dashboard
 *
 * Delegates rendering to the canonical Ink TUI in @sriinnu/tokmeter/tui so
 * there is only one maintained Ink UI across `tokmeter tui`, `tokmeter-tui`,
 * and `tokmeter-mcp live`.
 */

import { startTui } from "@sriinnu/tokmeter/tui";

export function startLive(): Promise<void> {
  return startTui();
}
