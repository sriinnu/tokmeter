import { useEffect, useRef, useState } from "react";

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * Tween a number towards `target`: from 0 on first render, from the previous
 * target on later changes. The last frame snaps to exactly `target`, so the
 * settled display is the payload value, never a float near it. Disabled →
 * the target, immediately.
 */
export function useCountUp(target: number, enabled: boolean, durationMs = 600): number {
  const [value, setValue] = useState(enabled ? 0 : target);
  const from = useRef(enabled ? 0 : target);

  useEffect(() => {
    if (!enabled || !Number.isFinite(target)) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = from.current;
    if (start === target) {
      setValue(target);
      return;
    }
    let frame = 0;
    const began = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / durationMs);
      const next = t >= 1 ? target : start + (target - start) * easeOutCubic(t);
      setValue(next);
      // Remember where we are so an interrupted tween continues from here.
      from.current = next;
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, enabled, durationMs]);

  return value;
}
