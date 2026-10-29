import { CircleDot, Lock, TimerReset } from "lucide-react";
import { DAY_STATE_LABEL, type DayState } from "../lib/day-state.js";
import { Badge } from "./ui/badge.js";

/** Icon + word for a day's mutability, never colour alone. */
export function DayStateBadge({ state }: { state: DayState }) {
  if (state === "live") {
    return (
      <Badge variant="live">
        <CircleDot aria-hidden /> {DAY_STATE_LABEL.live}
      </Badge>
    );
  }
  if (state === "sealed") {
    return (
      <Badge variant="outline">
        <Lock aria-hidden /> {DAY_STATE_LABEL.sealed}
      </Badge>
    );
  }
  return (
    <Badge variant="warning">
      <TimerReset aria-hidden /> {DAY_STATE_LABEL[state]}
    </Badge>
  );
}
