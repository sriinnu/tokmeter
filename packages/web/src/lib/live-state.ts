import type { LiveData } from "../hooks/useLiveData.js";

/**
 * What the live-sessions panel can honestly claim.
 *
 * A reachable daemon with nothing reporting is "idle", not "streaming": an
 * empty aggregate shown as a row of zeros under a Streaming badge reads as
 * "you are running agents and they cost nothing", which is false.
 */
export type LivePanelState = "offline" | "connecting" | "idle" | "streaming";

export function selectLivePanelState(live: LiveData): LivePanelState {
  if (live.status === "disconnected") return "offline";
  if (live.status === "connecting") return "connecting";
  const aggregated = live.aggregated;
  if (!aggregated || aggregated.sessions <= 0 || aggregated.byModel.length === 0) return "idle";
  return "streaming";
}
