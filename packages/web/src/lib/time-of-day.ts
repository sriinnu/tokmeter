/**
 * View-model for the "Busiest hours" strip: the daemon's 30-day share of cost
 * per 3-hour block, checked before it's drawn. A payload that doesn't hold
 * together (wrong block count, shares that don't sum to 1) is treated as
 * missing — a wrong split is worse than none.
 */

import type { TokmeterTimeOfDay, TokmeterTimeOfDayBlock } from "../hooks/useTokmeterData.js";

export type TimeOfDayView =
  | { state: "missing" }
  | { state: "insufficient"; daysCounted: number; minDays: number }
  | {
      state: "ok";
      blocks: TokmeterTimeOfDayBlock[];
      peak: TokmeterTimeOfDayBlock;
      maxShare: number;
      daysCounted: number;
      daysSkipped: number;
      windowDays: number;
      totalCost: number;
    };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** "15–18": two-digit 24-hour clock, an en dash between. */
export function formatBlock(block: Pick<TokmeterTimeOfDayBlock, "startHour" | "endHour">): string {
  const pad = (h: number) => String(h).padStart(2, "0");
  return `${pad(block.startHour)}–${pad(block.endHour)}`;
}

/** Whole-percent share, but never "0%" for a block that did carry spend. */
export function formatShare(share: number): string {
  if (share > 0 && share < 0.005) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/** One decimal for the table, so two blocks that both round to 24% stay distinguishable. */
export function formatSharePrecise(share: number): string {
  if (share > 0 && share < 0.0005) return "<0.1%";
  return `${(share * 100).toFixed(1)}%`;
}

export function buildTimeOfDayView(profile: TokmeterTimeOfDay | undefined | null): TimeOfDayView {
  if (!profile || typeof profile !== "object") return { state: "missing" };
  if (profile.status === "insufficient") {
    if (!finite(profile.daysCounted) || !finite(profile.minDays)) return { state: "missing" };
    return {
      state: "insufficient",
      daysCounted: profile.daysCounted,
      minDays: profile.minDays,
    };
  }
  if (profile.status !== "ok" || !Array.isArray(profile.blocks)) return { state: "missing" };
  const blocks = profile.blocks;
  const wellFormed =
    blocks.length === 8 &&
    blocks.every(
      (b, i) =>
        b.startHour === i * 3 &&
        b.endHour === i * 3 + 3 &&
        finite(b.share) &&
        finite(b.cost) &&
        b.share >= 0 &&
        b.cost >= 0
    );
  if (!wellFormed) return { state: "missing" };
  const shareSum = blocks.reduce((s, b) => s + b.share, 0);
  if (Math.abs(shareSum - 1) > 1e-6) return { state: "missing" };
  const peak = blocks.reduce((best, b) => (b.share > best.share ? b : best), blocks[0]);
  return {
    state: "ok",
    blocks,
    peak,
    maxShare: peak.share,
    daysCounted: profile.daysCounted,
    daysSkipped: profile.daysSkipped ?? 0,
    windowDays: profile.windowDays,
    totalCost: profile.totalCost,
  };
}
