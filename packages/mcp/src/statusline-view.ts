/**
 * @sriinnu/tokmeter-mcp — statusline view: a pure function from a
 * harness-neutral snapshot to the two printed lines.
 *
 * Every segment exists because it changes a decision: compact now, send before
 * the prompt cache cools, slow down before a rate window runs out, notice a
 * router silently falling back to a weaker model. Anything that drives no
 * decision lives in the bar or dashboard instead.
 *
 * Rules the renderer keeps:
 * - Unknown is not zero. A harness that doesn't report a field gets `?` or the
 *   segment is omitted, never `0%` / `$0.00`.
 * - A number the daemon hasn't confirmed lately renders dimmed with `~` and its
 *   age. A dead daemon is a dash.
 * - The worst problem takes line 2's alert slot, in words. One at a time.
 * - It never wraps: segments drop in a fixed priority order to fit `cols`.
 *
 * No I/O and no clock reads here: callers pass `now`, so states render the
 * same in tests as on screen.
 */

import { sanitizeDataLabel } from "@sriinnu/tokmeter";

export interface RateWindowView {
  /** Percent of the window used, as the harness reports it. */
  pct: number;
  /** Epoch seconds when the window resets. */
  resetsAt?: number;
  /** Window length in seconds (5h = 18000, 7d = 604800). */
  spanSec: number;
}

export interface RouteView {
  /** The router that picked the model, e.g. "chitragupta". */
  via: string;
  /** Provider that actually served the turn. */
  provider?: string;
  /** Model that actually served the turn. */
  model?: string;
  /** Who chose it: the router on purpose, a fallback, or the user's pin. */
  authority?: "kernel" | "fallback" | "pinned";
  /** The router could not be reached at all. */
  offline?: boolean;
  /** Routing over the last few turns, when the harness tracks it. */
  recent?: { fallbacks: number; total: number };
}

export interface StatusView {
  /** Epoch milliseconds the snapshot was taken. */
  now: number;
  project: string;
  /** Model label as shown to the user, e.g. "Opus 5.5". */
  model: string;
  effort?: string;
  route?: RouteView;
  /** Context fill. `pct: null` = the harness doesn't report it. */
  ctx: { pct: number | null; windowTokens?: number; turnsLeft?: number | null };
  cache?: { warm: boolean; expiresAt?: number | null; rebuildTokens?: number | null };
  /** Session cost. `usd: null` = not priced. `activeMs` = model working time. */
  cost?: { usd: number | null; activeMs?: number };
  five?: RateWindowView;
  seven?: RateWindowView;
  today: { state: "fresh" | "stale" | "down" | "none"; usd?: number; ageMs?: number };
  repo?: { usd: number; stale: boolean };
  git?: { branch: string; dirty: number };
  pr?: { number: number };
}

export interface RenderOptions {
  cols: number;
  color: boolean;
}

// ─── Styling ───────────────────────────────────────────────────────────

type Tone =
  | "plain"
  | "dim"
  | "ok"
  | "warn"
  | "bad"
  | "accent"
  | "cost"
  | "bold"
  | "chip"
  | "alertWarn"
  | "alertBad";

const SGR: Record<Tone, string> = {
  plain: "",
  dim: "\x1b[2m",
  ok: "\x1b[38;2;74;222;128m",
  warn: "\x1b[38;2;251;191;36m",
  bad: "\x1b[38;2;248;113;113m",
  accent: "\x1b[38;2;167;139;250m",
  cost: "\x1b[38;2;252;211;77m",
  bold: "\x1b[1m",
  chip: "\x1b[1;38;2;255;255;255;48;2;91;33;182m",
  alertWarn: "\x1b[1;38;2;251;191;36;48;2;59;29;10m",
  alertBad: "\x1b[1;38;2;248;113;113;48;2;61;17;17m",
};

interface Span {
  tone: Tone;
  text: string;
}

const s = (tone: Tone, text: string): Span => ({ tone, text });

interface Segment {
  /** Higher survives longer when the line is too wide. */
  prio: number;
  spans: Span[];
}

/** Display width. The renderer only emits single-cell glyphs (no emoji). */
function width(spans: Span[]): number {
  let n = 0;
  for (const sp of spans) n += [...sp.text].length;
  return n;
}

function paint(spans: Span[], color: boolean): string {
  if (!color) return spans.map((sp) => sp.text).join("");
  return spans.map((sp) => (SGR[sp.tone] ? `${SGR[sp.tone]}${sp.text}\x1b[0m` : sp.text)).join("");
}

const SEP: Span = s("dim", " │ ");

/** Drop the lowest-priority segment until the line fits; keep original order. */
function fit(segments: Segment[], cols: number): Segment[] {
  const kept = [...segments];
  const total = () =>
    kept.reduce((n, g) => n + width(g.spans), 0) + Math.max(0, kept.length - 1) * 3;
  while (kept.length > 1 && total() > cols) {
    let lo = 0;
    for (let i = 1; i < kept.length; i++) if (kept[i].prio < kept[lo].prio) lo = i;
    kept.splice(lo, 1);
  }
  return kept;
}

function line(segments: Segment[], opts: RenderOptions): string {
  const kept = fit(segments, opts.cols);
  const spans: Span[] = [];
  kept.forEach((g, i) => {
    if (i > 0) spans.push(SEP);
    spans.push(...g.spans);
  });
  return paint(spans, opts.color);
}

// ─── Formatting ────────────────────────────────────────────────────────

export function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

/** "41s", "12m", "3h30m", "5d11h". */
export function formatSpan(sec: number): string {
  const t = Math.max(0, Math.round(sec));
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.round(t / 60)}m`;
  if (t < 48 * 3600) {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    return m ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  return h ? `${d}d${h}h` : `${d}d`;
}

/** Local wall-clock "HH:MM" for an epoch-seconds instant. */
export function formatClock(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function bar(pct: number, cells = 8): string {
  const p = Math.max(0, Math.min(100, pct));
  const n = Math.round((p / 100) * cells);
  return "▰".repeat(n) + "▱".repeat(cells - n);
}

function ctxTone(pct: number): Tone {
  if (pct >= 85) return "bad";
  if (pct >= 70) return "warn";
  return "ok";
}

function windowTone(pct: number): Tone {
  if (pct >= 90) return "bad";
  if (pct >= 70) return "warn";
  return "ok";
}

// ─── Forecast ──────────────────────────────────────────────────────────

export interface WindowForecast {
  /** Straight-line projection of use at the reset instant, in percent. */
  atReset: number;
  /** Epoch seconds the window hits 100% at this pace, if before reset. */
  hitsLimitAt: number | null;
}

/**
 * Straight-line projection from the window's own numbers: the rate so far,
 * carried to the reset. Needs 10 minutes of window behind it; earlier than
 * that a single burst reads as a runaway.
 */
export function forecastWindow(w: RateWindowView, nowMs: number): WindowForecast | null {
  // Claude Code reports whole percents. Below 5% the rounding alone moves a
  // projection by 10%+ (2% is anything from 1.5 to 2.5), so it would be noise.
  if (!w.resetsAt || !Number.isFinite(w.pct) || w.pct < 5) return null;
  const nowSec = nowMs / 1000;
  const left = w.resetsAt - nowSec;
  const elapsed = w.spanSec - left;
  if (left <= 0 || elapsed < 600) return null;
  const rate = w.pct / elapsed;
  const atReset = w.pct + rate * left;
  const hitsLimitAt = w.pct < 100 && atReset >= 100 ? nowSec + (100 - w.pct) / rate : null;
  return { atReset, hitsLimitAt };
}

// ─── Alert slot ────────────────────────────────────────────────────────

interface Alert {
  severity: number;
  tone: "alertWarn" | "alertBad";
  text: string;
}

function pickAlert(v: StatusView): Alert | null {
  const nowSec = v.now / 1000;
  const alerts: Alert[] = [];
  const windows: [string, RateWindowView | undefined][] = [
    ["5h", v.five],
    ["7d", v.seven],
  ];

  for (const [label, w] of windows) {
    if (!w || (w.resetsAt && w.resetsAt <= nowSec)) continue;
    if (w.pct >= 100) {
      const other = label === "5h" ? v.seven : v.five;
      const reset = w.resetsAt
        ? ` · resets ${formatClock(w.resetsAt)} (in ${formatSpan(w.resetsAt - nowSec)})`
        : "";
      const otherNote = other ? ` · ${label === "5h" ? "7d" : "5h"} ${Math.round(other.pct)}%` : "";
      alerts.push({
        severity: 100,
        tone: "alertBad",
        text: ` ■ ${label} limit reached${reset}${otherNote} `,
      });
      continue;
    }
    const f = forecastWindow(w, v.now);
    if (f?.hitsLimitAt && w.resetsAt) {
      alerts.push({
        severity: 90,
        tone: "alertBad",
        text: ` ⚠ ${label} limit at ~${formatClock(f.hitsLimitAt)} at this pace · ${formatSpan(w.resetsAt - f.hitsLimitAt)} before reset `,
      });
    } else if (w.pct >= 90) {
      alerts.push({
        severity: 75,
        tone: "alertWarn",
        text: ` ⚠ ${label} window ${Math.round(w.pct)}% used `,
      });
    }
  }

  const pct = v.ctx.pct;
  if (pct !== null) {
    if (pct >= 100) {
      alerts.push({ severity: 96, tone: "alertBad", text: " ⚠ context full · compacting " });
    } else if (pct >= 95) {
      alerts.push({
        severity: 95,
        tone: "alertBad",
        text: ` ⚠ context ${Math.round(pct)}% · next turn compacts · /compact now to choose what stays `,
      });
    } else if (pct >= 85) {
      const left = v.ctx.turnsLeft ? ` · ~${v.ctx.turnsLeft} turns left` : "";
      alerts.push({
        severity: 80,
        tone: "alertWarn",
        text: ` ⚠ context ${Math.round(pct)}%${left} `,
      });
    }
  }

  const r = v.route;
  if (r?.offline) {
    alerts.push({ severity: 88, tone: "alertBad", text: ` ⚠ ${r.via} offline · can't route ` });
  } else if (r?.authority === "fallback") {
    const served = [r.provider, r.model].filter(Boolean).join("/");
    alerts.push({
      severity: 85,
      tone: "alertWarn",
      text: ` ⚠ ${r.via} fell back${served ? ` to ${served}` : ""} `,
    });
  }

  const c = v.cache;
  if (c?.warm && c.expiresAt) {
    const left = c.expiresAt - nowSec;
    if (left > 0 && left < 300) {
      const rebuild = c.rebuildTokens
        ? ` · then rebuilds ~${formatTokens(c.rebuildTokens)} tok`
        : "";
      alerts.push({
        severity: 70,
        tone: "alertWarn",
        text: ` ⚠ cache cools in ${formatSpan(left)}${rebuild} `,
      });
    }
  }

  if (alerts.length === 0) return null;
  return alerts.reduce((a, b) => (b.severity > a.severity ? b : a));
}

// ─── Segments ──────────────────────────────────────────────────────────

function ctxSegment(v: StatusView): Segment {
  const pct = v.ctx.pct;
  if (pct === null) return { prio: 95, spans: [s("dim", "ctx ?")] };
  if (pct >= 100) return { prio: 98, spans: [s("alertBad", " ctx 100% · compacting ")] };
  if (pct >= 95) {
    return {
      prio: 98,
      spans: [s("alertBad", ` ctx ${bar(pct)} ${Math.round(pct)}% · compacts next turn `)],
    };
  }
  const tone = ctxTone(pct);
  const spans = [s("dim", "ctx "), s(tone, `${bar(pct)} ${Math.round(pct)}%`)];
  if (pct >= 70 && v.ctx.turnsLeft) spans.push(s("dim", ` · ~${v.ctx.turnsLeft} turns left`));
  return { prio: 98, spans };
}

function modelSegment(v: StatusView): Segment {
  const r = v.route;
  if (!r) {
    const spans = [s("bold", v.model)];
    if (v.effort) spans.push(s("dim", ` · ${v.effort}`));
    return { prio: 90, spans };
  }
  if (r.offline) return { prio: 96, spans: [s("bad", `⇄ ${r.via} offline`)] };
  const served = [r.provider, r.model].filter(Boolean).join("/") || v.model;
  if (r.authority === "pinned") {
    return { prio: 96, spans: [s("bold", served), s("dim", " · pinned")] };
  }
  const fellBack = r.authority === "fallback";
  return {
    prio: 96,
    spans: [
      s(fellBack ? "warn" : "accent", `⇄ ${r.via} `),
      s("dim", "→ "),
      s(fellBack ? "warn" : "bold", served),
      ...(r.authority ? [s("dim", " · "), s(fellBack ? "warn" : "dim", r.authority)] : []),
    ],
  };
}

function cacheSegment(v: StatusView): Segment | null {
  const c = v.cache;
  if (!c) return null;
  const nowSec = v.now / 1000;
  const left = c.expiresAt ? c.expiresAt - nowSec : 0;
  if (!c.warm || left <= 0) {
    const rebuild = c.rebuildTokens
      ? s("dim", ` · next turn rebuilds ~${formatTokens(c.rebuildTokens)} tok`)
      : null;
    return { prio: 72, spans: [s("warn", "cache cold"), ...(rebuild ? [rebuild] : [])] };
  }
  if (left < 300) {
    const rebuild = c.rebuildTokens
      ? s("dim", ` · rebuild ~${formatTokens(c.rebuildTokens)} tok`)
      : null;
    return {
      prio: 80,
      spans: [s("warn", `cache ${formatSpan(left)}`), ...(rebuild ? [rebuild] : [])],
    };
  }
  return { prio: 70, spans: [s("dim", "cache "), s(left < 900 ? "warn" : "ok", formatSpan(left))] };
}

function costSegment(v: StatusView): Segment | null {
  const c = v.cost;
  if (!c) return null;
  if (c.usd === null) return { prio: 85, spans: [s("dim", "$— not priced")] };
  const spans = [s("cost", formatUsd(c.usd))];
  // Rate over the time the model was actually working, not wall clock: an
  // 18h session with 58 active minutes burns $27/h, not $1.42/h.
  if (c.activeMs && c.activeMs >= 60_000 && c.usd > 0) {
    spans.push(
      s("dim", " · "),
      s("warn", `${formatUsd(c.usd / (c.activeMs / 3_600_000))}/h`),
      s("dim", " active")
    );
  }
  return { prio: 88, spans };
}

function windowSegment(label: string, w: RateWindowView, v: StatusView, prio: number): Segment {
  const nowSec = v.now / 1000;
  // A reset in the past means the window has started over and the harness
  // hasn't sent fresh numbers yet; the old percentage is no longer true.
  if (w.resetsAt && w.resetsAt <= nowSec) return { prio, spans: [s("dim", `${label} reset`)] };
  const pct = Math.round(w.pct);
  if (w.pct >= 100) return { prio, spans: [s("dim", `${label} `), s("bad", "100%")] };
  const f = forecastWindow(w, v.now);
  const spans = [s("dim", `${label} `), s(windowTone(w.pct), `${pct}%`)];
  // A 7d projection is noise until it points somewhere that matters; the 5h
  // one is always worth seeing because its reset is today.
  if (f && w.resetsAt && (label === "5h" || f.atReset >= 50)) {
    const projected = Math.round(f.atReset);
    spans.push(
      s("dim", " → "),
      s(projected >= 100 ? "bad" : "dim", `~${projected}%`),
      s(
        "dim",
        label === "5h" ? ` by ${formatClock(w.resetsAt)}` : ` · ${formatSpan(w.resetsAt - nowSec)}`
      )
    );
  } else if (w.resetsAt) {
    spans.push(s("dim", ` · ${formatSpan(w.resetsAt - nowSec)}`));
  }
  return { prio, spans };
}

function todaySegment(v: StatusView): Segment | null {
  const t = v.today;
  if (t.state === "none") return null;
  if (t.state === "down")
    return { prio: 80, spans: [s("dim", "today — "), s("bad", "daemon offline")] };
  if (t.usd === undefined) return null;
  if (t.state === "stale") {
    const age = t.ageMs !== undefined ? ` · ${formatSpan(t.ageMs / 1000)} old` : "";
    return { prio: 80, spans: [s("dim", `today ~${formatUsd(t.usd)}${age}`)] };
  }
  return { prio: 80, spans: [s("accent", "today "), s("cost", formatUsd(t.usd))] };
}

// ─── Render ────────────────────────────────────────────────────────────

export function renderStatusline(v: StatusView, opts: RenderOptions): string {
  const l1: Segment[] = [];
  l1.push({ prio: 100, spans: [s("chip", ` ◆ ${v.project || "tokmeter"} `)] });
  l1.push(modelSegment(v));
  l1.push(ctxSegment(v));
  const cache = cacheSegment(v);
  if (cache) l1.push(cache);
  const cost = costSegment(v);
  if (cost) l1.push(cost);
  if (v.git)
    l1.push({
      prio: 40,
      // A branch name is repo-controlled text: strip terminal controls.
      spans: [
        s("dim", "⎇ "),
        s("plain", `${sanitizeDataLabel(v.git.branch, 128)}${v.git.dirty ? "*" : ""}`),
      ],
    });
  if (v.pr) l1.push({ prio: 30, spans: [s("warn", `#${v.pr.number}`)] });

  const l2: Segment[] = [];
  const alert = pickAlert(v);
  if (alert) l2.push({ prio: 99, spans: [s(alert.tone, alert.text)] });
  if (v.five) l2.push(windowSegment("5h", v.five, v, 75));
  if (v.seven) l2.push(windowSegment("7d", v.seven, v, 50));
  if (v.route?.recent && v.route.recent.total > 0) {
    const { fallbacks, total } = v.route.recent;
    l2.push({
      prio: 60,
      spans: fallbacks
        ? [s("dim", "route "), s("warn", `${fallbacks} of last ${total} fell back`)]
        : [
            s("dim", "route "),
            s("ok", `${total} of ${total} ${v.route.via === "chitragupta" ? "kernel" : "routed"}`),
          ],
    });
  }
  const today = todaySegment(v);
  if (today) l2.push(today);
  if (v.repo && v.repo.usd > 0) {
    l2.push({
      prio: 45,
      spans: v.repo.stale
        ? [s("dim", `repo ~${formatUsd(v.repo.usd)}`)]
        : [s("accent", "repo "), s("cost", formatUsd(v.repo.usd))],
    });
  }

  const first = line(l1, opts);
  return l2.length ? `${first}\n${line(l2, opts)}` : first;
}
