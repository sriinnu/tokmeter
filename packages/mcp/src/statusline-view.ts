/**
 * @sriinnu/tokmeter-mcp — statusline view: a pure function from a
 * harness-neutral snapshot to the two printed lines.
 *
 * Every segment exists because it changes a decision: compact now, send before
 * the prompt cache cools, find what just broke the cache, slow down before a
 * rate window runs out, notice a router silently falling back to a weaker
 * model. Anything that drives no decision lives in the bar or dashboard.
 *
 * Rules the renderer keeps:
 * - Unknown is not zero. A harness that doesn't report a field gets `?` or the
 *   segment is omitted, never `0%` / `$0.00`.
 * - Every number says what it covers: `session`, `today`, `here` (this repo,
 *   today), `5h`, `7d`. A forecast carries `~`.
 * - A number the daemon hasn't confirmed lately renders dimmed with `~` and its
 *   age. A dead daemon is a dash.
 * - The worst problem takes line 2's alert slot, in words. One at a time.
 * - It never wraps. A line too wide gives up the least valuable thing first:
 *   a segment's explanation (its short form keeps the number), then whole
 *   segments, in one priority order; whatever room is left is handed back.
 *   No line is ever wider than `cols`.
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

/** A gateway spend limit: metered dollars, not an estimate. */
export interface SpendLimitView {
  pct: number;
  resetsAt?: number;
  usedUsd?: number;
  limitUsd?: number;
  period?: "daily" | "weekly" | "monthly";
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

/**
 * Prompt-cache health for this session's main conversation, as the harness
 * measured it. Nothing here is derived by tokmeter.
 */
export interface CacheView {
  /** null: the harness didn't say. Unknown is never shown as cold. */
  warm: boolean | null;
  expiresAt?: number | null;
  /** Tokens the next request re-caches if the cache is cold by then. */
  rebuildTokens?: number | null;
  /**
   * Share of this session's input tokens read from cache, 0–1:
   * cacheRead / (input + cacheRead + cacheWrite). The same definition as
   * `cacheHitRate` in core's usage.ts, over the session instead of the day.
   */
  hitRatio?: number | null;
  /**
   * Requests whose cached prefix shrank with no compaction to explain it.
   * Claude Code's payload calls these `misses`. They're "breaks" here because
   * core's `cacheMissRate` already means something else (the uncached share
   * of input tokens, which the menu bar shows) and one word can't be both a
   * count of requests and a share of tokens.
   */
  breaks?: number;
  /** Tokens those requests wrote back to the cache. */
  breakTokens?: number;
  /** Epoch seconds of the latest break. */
  lastBreakAt?: number | null;
  /** The harness's diagnosis of the latest break, as its cause names. */
  lastBreakCauses?: string[];
}

export interface StatusView {
  /** Epoch milliseconds the snapshot was taken. */
  now: number;
  project: string;
  /** The session runs in a git worktree; `project` is then the repo's name. */
  worktree?: boolean;
  /** Model label as shown to the user, e.g. "Opus 5.5". */
  model: string;
  effort?: string;
  route?: RouteView;
  /** Context fill. `pct: null` = the harness doesn't report it. */
  ctx: { pct: number | null; windowTokens?: number; turnsLeft?: number | null };
  cache?: CacheView;
  /** Session cost at list prices. `usd: null` = not priced. */
  cost?: { usd: number | null };
  five?: RateWindowView;
  seven?: RateWindowView;
  spend?: SpendLimitView;
  today: { state: "fresh" | "stale" | "down" | "none"; usd?: number; ageMs?: number };
  /** Today's spend in this repo; part of `today`, never added to it. */
  repo?: { usd: number; stale: boolean };
  git?: { branch: string; dirty: number };
  pr?: { number: number };
}

export interface RenderOptions {
  cols: number;
  color: boolean;
  /** Plain ASCII glyphs, for `TERM=dumb`. */
  ascii?: boolean;
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
  /** The short form: the number without the explanation. */
  short?: Span[];
  /**
   * What the long form is worth, on the same scale as `prio`: it gives way
   * before any segment above this is dropped. Defaults to half of `prio`.
   */
  fullPrio?: number;
}

/**
 * Terminal cells one code point takes: 0 for combining marks, joiners and
 * variation selectors, 2 for East Asian wide/fullwidth and emoji, else 1.
 * The renderer's own glyphs are all one cell; data (a project name, a branch)
 * can be anything, and counting code points let a CJK name overflow the line.
 */
function cellWidth(cp: number): number {
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function textWidth(text: string): number {
  let n = 0;
  for (const ch of text) n += cellWidth(ch.codePointAt(0) ?? 0);
  return n;
}

/**
 * A percentage as shown: rounded, except that anything short of 100 never
 * reads 100. 99.6% is not "limit reached", and a 100% next to no limit alert
 * would contradict itself.
 */
function shownPct(p: number): number {
  return p < 100 ? Math.min(99, Math.round(p)) : Math.round(p);
}

/** Display width in terminal cells. */
function width(spans: Span[]): number {
  let n = 0;
  for (const sp of spans) n += textWidth(sp.text);
  return n;
}

/** One ASCII character per glyph, so widths hold in ASCII mode. */
const ASCII: Record<string, string> = {
  "│": "|",
  "◆": "*",
  "▰": "#",
  "▱": "-",
  "⎇": "@",
  "⚠": "!",
  "■": "#",
  "⇄": "=",
  "→": ">",
  "·": "-",
  "—": "-",
  "…": ".",
  "∞": "+",
};

function toAscii(text: string): string {
  let out = "";
  for (const ch of text) out += ASCII[ch] ?? ((ch.codePointAt(0) ?? 0) < 128 ? ch : "?");
  return out;
}

function paint(spans: Span[], opts: RenderOptions): string {
  return spans
    .map((sp) => {
      const text = opts.ascii ? toAscii(sp.text) : sp.text;
      return opts.color && SGR[sp.tone] ? `${SGR[sp.tone]}${text}\x1b[0m` : text;
    })
    .join("");
}

const SEP: Span = s("dim", " │ ");

/** Cut spans to `cols` cells, ending in an ellipsis. */
function clip(spans: Span[], cols: number): Span[] {
  const out: Span[] = [];
  let room = Math.max(0, cols - 1);
  for (const sp of spans) {
    const w = textWidth(sp.text);
    if (w <= room) {
      out.push(sp);
      room -= w;
      continue;
    }
    let kept = "";
    for (const ch of sp.text) {
      const cw = cellWidth(ch.codePointAt(0) ?? 0);
      if (cw > room) break;
      kept += ch;
      room -= cw;
    }
    out.push(s(sp.tone, `${kept}${cols > 0 ? "…" : ""}`));
    return out;
  }
  return out;
}

const FULL = 0;
const SHORT = 1;
const GONE = 2;

/**
 * Make the line fit `cols`, losing the least. Every segment holds up to two
 * things of worth: being shown at all (`prio`, in its short form when it has
 * one) and its long form (`fullPrio`). They are granted most valuable first,
 * each only if the line still fits, so nothing is ever given up to make room
 * for something worth less. That keeps resizing honest: a wider terminal can
 * only add things, or trade one for something worth more, never show less of
 * value. The top segment is always shown; if it alone is too wide it is
 * clipped. Original order is kept.
 */
function fit(segments: Segment[], cols: number): Span[][] {
  if (segments.length === 0) return [];
  const state = segments.map(() => GONE);
  const spansOf = (i: number) =>
    state[i] === SHORT ? (segments[i].short as Span[]) : segments[i].spans;
  const total = () => {
    let n = 0;
    let shown = 0;
    for (let i = 0; i < segments.length; i++) {
      if (state[i] === GONE) continue;
      n += width(spansOf(i));
      shown++;
    }
    return n + Math.max(0, shown - 1) * 3;
  };
  const fullWorth = (i: number) => segments[i].fullPrio ?? segments[i].prio / 2;
  const base = (i: number) => (segments[i].short ? SHORT : FULL);
  let top = 0;
  for (let i = 1; i < segments.length; i++) if (segments[i].prio > segments[top].prio) top = i;
  state[top] = base(top);

  const grants: { worth: number; i: number; long: boolean; cost: number }[] = [];
  segments.forEach((g, i) => {
    const shownWidth = width(g.short ?? g.spans);
    if (i !== top) grants.push({ worth: g.prio, i, long: false, cost: shownWidth + 3 });
    if (g.short)
      grants.push({ worth: fullWorth(i), i, long: true, cost: width(g.spans) - shownWidth });
  });
  // Most valuable first. Among equals the cheaper goes first: then whatever a
  // wider line newly fits can only crowd out things worth less than itself.
  grants.sort(
    (a, b) => b.worth - a.worth || a.cost - b.cost || Number(a.long) - Number(b.long) || a.i - b.i
  );
  for (const g of grants) {
    const was = state[g.i];
    if (g.long ? was !== SHORT : was !== GONE) continue; // long form needs it shown first
    state[g.i] = g.long ? FULL : base(g.i);
    if (total() > cols) state[g.i] = was;
  }

  const out: Span[][] = [];
  for (let i = 0; i < segments.length; i++) if (state[i] !== GONE) out.push(spansOf(i));
  if (out.length === 1 && width(out[0]) > cols) out[0] = clip(out[0], cols);
  return out;
}

function line(segments: Segment[], opts: RenderOptions): string {
  if (segments.length === 0) return "";
  const spans: Span[] = [];
  fit(segments, opts.cols).forEach((g, i) => {
    if (i > 0) spans.push(SEP);
    spans.push(...g);
  });
  return paint(spans, opts);
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A clock time the reader can place: "16:56" when it is within the next 18
 * hours, "Tue 00:07" beyond that. A bare "00:07" for an instant three days
 * out names no day at all.
 */
export function formatWhen(epochSec: number, nowSec: number): string {
  const clock = formatClock(epochSec);
  if (Math.abs(epochSec - nowSec) <= 18 * 3600) return clock;
  return `${WEEKDAYS[new Date(epochSec * 1000).getDay()]} ${clock}`;
}

/** Text from outside this process: strip terminal controls, cap the length. */
function label(value: string, max: number): string {
  const clean = sanitizeDataLabel(value, 256);
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
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

// ─── Cache breaks ──────────────────────────────────────────────────────

/** A break stays in the alert slot this long; a turn can take minutes. */
const FRESH_BREAK_SEC = 300;

/**
 * Short words for Claude Code's closed set of cache-break causes
 * (PROMPT_CACHE_MISS_CAUSES in 2.1.329). A name this table doesn't know is
 * shown as sent, underscores as spaces; `unknown` is shown as nothing.
 */
const BREAK_CAUSE: Record<string, string> = {
  system_prompt_changed: "system prompt changed",
  tools_changed: "tools changed",
  model_changed: "model changed",
  fast_mode_changed: "fast mode toggled",
  cache_scope_or_ttl_changed: "cache TTL changed",
  betas_changed: "beta headers changed",
  effort_changed: "effort changed",
  thinking_mode_changed: "thinking toggled",
  thinking_display_changed: "thinking display changed",
  auto_mode_changed: "auto mode toggled",
  overage_changed: "usage-limit state changed",
  extra_body_changed: "request fields changed",
  defer_loading_changed: "deferred tools changed",
  messages_rewritten: "earlier messages changed",
  ttl_expired_5m: "idle past the 5m TTL",
  ttl_expired_1h: "idle past the 1h TTL",
  likely_server_side: "likely server-side",
};

export function breakCause(causes: string[] | undefined): string | null {
  const named = (causes ?? []).filter((c) => typeof c === "string" && c && c !== "unknown");
  if (named.length === 0) return null;
  const first = BREAK_CAUSE[named[0]] ?? label(named[0].replaceAll("_", " "), 32);
  return named.length > 1 ? `${first} +${named.length - 1}` : first;
}

// ─── Alert slot ────────────────────────────────────────────────────────

interface Alert {
  severity: number;
  tone: "alertWarn" | "alertBad";
  text: string;
  short?: string;
}

function pickAlert(v: StatusView): Alert | null {
  const nowSec = v.now / 1000;
  const alerts: Alert[] = [];
  const windows: [string, RateWindowView | undefined][] = [
    ["5h", v.five],
    ["7d", v.seven],
  ];

  for (const [name, w] of windows) {
    if (!w || (w.resetsAt && w.resetsAt <= nowSec)) continue;
    if (w.pct >= 100) {
      const other = name === "5h" ? v.seven : v.five;
      const when = w.resetsAt ? formatWhen(w.resetsAt, nowSec) : null;
      const reset = w.resetsAt ? ` · resets ${when} (in ${formatSpan(w.resetsAt - nowSec)})` : "";
      const otherNote = other ? ` · ${name === "5h" ? "7d" : "5h"} ${Math.round(other.pct)}%` : "";
      alerts.push({
        severity: 100,
        tone: "alertBad",
        text: ` ■ ${name} limit reached${reset}${otherNote} `,
        short: ` ■ ${name} limit reached${when ? ` · resets ${when}` : ""} `,
      });
      continue;
    }
    const f = forecastWindow(w, v.now);
    if (f?.hitsLimitAt && w.resetsAt) {
      const at = formatWhen(f.hitsLimitAt, nowSec);
      alerts.push({
        severity: 90,
        tone: "alertBad",
        text: ` ⚠ ${name} limit at ~${at} at this pace · ${formatSpan(w.resetsAt - f.hitsLimitAt)} before reset `,
        short: ` ⚠ ${name} limit at ~${at} `,
      });
    } else if (w.pct >= 90) {
      alerts.push({
        severity: 75,
        tone: "alertWarn",
        text: ` ⚠ ${name} window ${shownPct(w.pct)}% used `,
      });
    }
  }

  const sp = v.spend;
  if (sp && !(sp.resetsAt && sp.resetsAt <= nowSec)) {
    if (sp.pct >= 100) {
      const when = sp.resetsAt ? ` · resets ${formatWhen(sp.resetsAt, nowSec)}` : "";
      alerts.push({
        severity: 99,
        tone: "alertBad",
        text: ` ■ spend limit reached${when} `,
      });
    } else if (sp.pct >= 90) {
      alerts.push({
        severity: 74,
        tone: "alertWarn",
        text: ` ⚠ spend limit ${Math.round(sp.pct)}% used `,
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
        text: ` ⚠ context ${shownPct(pct)}% · next turn compacts · /compact now to choose what stays `,
        short: ` ⚠ context ${shownPct(pct)}% · /compact now `,
      });
    } else if (pct >= 85) {
      const left = v.ctx.turnsLeft ? ` · ~${v.ctx.turnsLeft} turns left` : "";
      alerts.push({
        severity: 80,
        tone: "alertWarn",
        text: ` ⚠ context ${shownPct(pct)}%${left} `,
        short: ` ⚠ context ${shownPct(pct)}% `,
      });
    }
  }

  const r = v.route;
  if (r?.offline) {
    alerts.push({
      severity: 88,
      tone: "alertBad",
      text: ` ⚠ ${label(r.via, 24)} offline · can't route `,
    });
  } else if (r?.authority === "fallback") {
    const served = label([r.provider, r.model].filter(Boolean).join("/"), 48);
    alerts.push({
      severity: 85,
      tone: "alertWarn",
      text: ` ⚠ ${label(r.via, 24)} fell back${served ? ` to ${served}` : ""} `,
      short: ` ⚠ ${label(r.via, 24)} fell back `,
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
        short: ` ⚠ cache cools in ${formatSpan(left)} `,
      });
    }
  }
  // A break that just happened: the moment to connect it to what changed.
  if (c?.breaks && c.lastBreakAt) {
    const ago = nowSec - c.lastBreakAt;
    if (ago >= 0 && ago < FRESH_BREAK_SEC) {
      const cause = breakCause(c.lastBreakCauses);
      const why = cause ? ` · ${cause}` : "";
      const tok = c.breakTokens ? `${formatTokens(c.breakTokens)} tok re-cached` : "";
      const toll =
        c.breaks > 1
          ? ` · ${c.breaks} this session${tok ? `, ${tok}` : ""}`
          : tok
            ? ` · ${tok}`
            : "";
      alerts.push({
        severity: 65,
        tone: "alertWarn",
        text: ` ⚠ cache break ${formatSpan(ago)} ago${why}${toll} `,
        short: ` ⚠ cache break${why} `,
      });
    }
  }

  if (alerts.length === 0) return null;
  const worst = alerts.reduce((a, b) => (b.severity > a.severity ? b : a));
  if (alerts.length === 1) return worst;
  // One slot, so say that more are waiting behind it rather than hide them.
  const more = (t: string) => `${t.trimEnd()} (+${alerts.length - 1}) `;
  return {
    ...worst,
    text: more(worst.text),
    ...(worst.short ? { short: more(worst.short) } : {}),
  };
}

// ─── Segments ──────────────────────────────────────────────────────────

function ctxSegment(v: StatusView): Segment {
  const pct = v.ctx.pct;
  if (pct === null) return { prio: 95, spans: [s("dim", "ctx ?")] };
  if (pct >= 100) return { prio: 98, spans: [s("alertBad", " ctx 100% · compacting ")] };
  const shown = shownPct(pct);
  if (pct >= 95) {
    return {
      prio: 98,
      spans: [s("alertBad", ` ctx ${bar(pct)} ${shown}% · compacts next turn `)],
      short: [s("alertBad", ` ctx ${shown}% `)],
    };
  }
  const tone = ctxTone(pct);
  const spans = [s("dim", "ctx "), s(tone, `${bar(pct)} ${shown}%`)];
  if (pct >= 70 && v.ctx.turnsLeft) spans.push(s("dim", ` · ~${v.ctx.turnsLeft} turns left`));
  return { prio: 98, spans, short: [s("dim", "ctx "), s(tone, `${shown}%`)] };
}

function modelSegment(v: StatusView): Segment {
  const r = v.route;
  const model = label(v.model, 40);
  if (!r) {
    const spans = [s("bold", model)];
    if (!v.effort) return { prio: 90, spans };
    return { prio: 90, spans: [...spans, s("dim", ` · ${label(v.effort, 8)}`)], short: spans };
  }
  const via = label(r.via, 24);
  if (r.offline) return { prio: 96, spans: [s("bad", `⇄ ${via} offline`)] };
  const served = label([r.provider, r.model].filter(Boolean).join("/"), 48) || model;
  if (r.authority === "pinned") {
    return {
      prio: 96,
      spans: [s("bold", served), s("dim", " · pinned")],
      short: [s("bold", served)],
    };
  }
  const fellBack = r.authority === "fallback";
  return {
    prio: 96,
    spans: [
      s(fellBack ? "warn" : "accent", `⇄ ${via} `),
      s("dim", "→ "),
      s(fellBack ? "warn" : "bold", served),
      ...(r.authority ? [s("dim", " · "), s(fellBack ? "warn" : "dim", r.authority)] : []),
    ],
    short: [s(fellBack ? "warn" : "accent", "⇄ "), s(fellBack ? "warn" : "bold", served)],
  };
}

/**
 * Cache health, in the order it changes a decision: is the next turn a
 * rebuild (cold, or about to be), then how well the session has cached so far.
 *
 * The hit share gets a color only when it's good. A low share is normal early
 * (the first request can only write), so the warning is the break count, which
 * the harness raises only for a prefix that should have been cached.
 */
function cacheSegment(v: StatusView): Segment | null {
  const c = v.cache;
  if (!c) return null;
  const nowSec = v.now / 1000;
  // A warm cache with no expiry, or no word on warmth, is unknown, not cold.
  const left = c.expiresAt ? c.expiresAt - nowSec : null;
  if (c.warm === false || (left !== null && left <= 0)) {
    const short = [s("warn", "cache cold")];
    return c.rebuildTokens
      ? {
          prio: 72,
          spans: [
            ...short,
            s("dim", ` · next turn rebuilds ~${formatTokens(c.rebuildTokens)} tok`),
          ],
          short,
        }
      : { prio: 72, spans: short };
  }
  if (c.warm && left !== null && left < 300) {
    const short = [s("warn", `cache ${formatSpan(left)}`)];
    return c.rebuildTokens
      ? {
          prio: 80,
          spans: [...short, s("dim", ` · rebuild ~${formatTokens(c.rebuildTokens)} tok`)],
          short,
        }
      : { prio: 80, spans: short };
  }
  const ttl = c.warm && left !== null ? s(left < 900 ? "warn" : "ok", formatSpan(left)) : null;
  const ratio = c.hitRatio;
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    if (ttl) return { prio: 70, spans: [s("dim", "cache "), ttl] };
    return c.warm ? { prio: 70, spans: [s("dim", "cache warm")] } : null;
  }
  const share = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  const hit = [s("dim", "cache "), s(share >= 80 ? "ok" : "plain", `${share}%`), s("dim", " hit")];
  const breaks = c.breaks
    ? [s("dim", " · "), s("warn", `${c.breaks} ${c.breaks === 1 ? "break" : "breaks"}`)]
    : [];
  return {
    prio: 70,
    spans: [...hit, ...breaks, ...(ttl ? [s("dim", " · "), ttl] : [])],
    // Under 15 minutes the countdown is the number that matters.
    ...(ttl && left !== null && left < 900 ? { short: [s("dim", "cache "), ttl] } : { short: hit }),
    // The break count and countdown outlast the branch and PR number.
    fullPrio: 45,
  };
}

function costSegment(v: StatusView): Segment | null {
  const c = v.cost;
  if (!c) return null;
  if (c.usd === null) {
    return { prio: 85, spans: [s("dim", "$— not priced")], short: [s("dim", "$—")] };
  }
  const usd = s("cost", formatUsd(c.usd));
  return { prio: 88, spans: [s("dim", "session "), usd], short: [usd] };
}

function windowSegment(name: string, w: RateWindowView, v: StatusView, prio: number): Segment {
  const nowSec = v.now / 1000;
  // A reset in the past means the window has started over and the harness
  // hasn't sent fresh numbers yet; the old percentage is no longer true.
  if (w.resetsAt && w.resetsAt <= nowSec) return { prio, spans: [s("dim", `${name} reset`)] };
  const pct = shownPct(w.pct);
  if (w.pct >= 100) {
    const short = [s("dim", `${name} `), s("bad", "100%")];
    return w.resetsAt
      ? {
          prio,
          spans: [...short, s("dim", ` · resets ${formatWhen(w.resetsAt, nowSec)}`)],
          short,
        }
      : { prio, spans: short };
  }
  const f = forecastWindow(w, v.now);
  if (f?.hitsLimitAt) {
    // On course to run out: say when, not "237% by reset".
    const short = [s("dim", `${name} `), s("bad", `${pct}%`)];
    return {
      prio,
      spans: [...short, s("dim", " → "), s("bad", `out ~${formatWhen(f.hitsLimitAt, nowSec)}`)],
      short,
    };
  }
  const short = [s("dim", `${name} `), s(windowTone(w.pct), `${pct}%`)];
  // A 7d projection is noise until it points somewhere that matters; the 5h
  // one is always worth seeing because its reset is today.
  if (f && w.resetsAt && (name === "5h" || f.atReset >= 50)) {
    return {
      prio,
      spans: [
        ...short,
        s("dim", ` → ~${Math.round(f.atReset)}%`),
        s(
          "dim",
          name === "5h" ? ` by ${formatClock(w.resetsAt)}` : ` · ${formatSpan(w.resetsAt - nowSec)}`
        ),
      ],
      short,
    };
  }
  if (w.resetsAt) {
    return { prio, spans: [...short, s("dim", ` · ${formatSpan(w.resetsAt - nowSec)}`)], short };
  }
  return { prio, spans: short };
}

function spendSegment(v: StatusView): Segment | null {
  const sp = v.spend;
  if (!sp) return null;
  if (sp.resetsAt && sp.resetsAt <= v.now / 1000) return null;
  const short = [s("dim", "spend "), s(windowTone(sp.pct), `${Math.round(sp.pct)}%`)];
  if (sp.usedUsd === undefined || sp.limitUsd === undefined) return { prio: 78, spans: short };
  return {
    prio: 78,
    spans: [
      ...short,
      s("dim", ` · ${formatUsd(sp.usedUsd)} of ${formatUsd(sp.limitUsd)}`),
      ...(sp.period ? [s("dim", ` ${sp.period}`)] : []),
    ],
    short,
  };
}

/** Today across every agent, and this repo's part of it. */
function todaySegment(v: StatusView): Segment | null {
  const t = v.today;
  if (t.state === "none") return null;
  if (t.state === "down") {
    return {
      prio: 80,
      spans: [s("dim", "today — "), s("bad", "daemon offline")],
      short: [s("dim", "today —")],
    };
  }
  if (t.usd === undefined) return null;
  const here = v.repo && v.repo.usd > 0 ? v.repo : null;
  if (t.state === "stale") {
    const short = [s("dim", `today ~${formatUsd(t.usd)}`)];
    const age = t.ageMs !== undefined ? ` · ${formatSpan(t.ageMs / 1000)} old` : "";
    const part = here ? ` · ~${formatUsd(here.usd)} here` : "";
    return age || part
      ? { prio: 80, spans: [s("dim", `today ~${formatUsd(t.usd)}${part}${age}`)], short }
      : { prio: 80, spans: short };
  }
  const short = [s("accent", "today "), s("cost", formatUsd(t.usd))];
  if (!here) return { prio: 80, spans: short };
  return {
    prio: 80,
    spans: [
      ...short,
      s("dim", " · "),
      s("cost", `${here.stale ? "~" : ""}${formatUsd(here.usd)}`),
      s("dim", " here"),
    ],
    short,
  };
}

// ─── Render ────────────────────────────────────────────────────────────

export function renderStatusline(v: StatusView, opts: RenderOptions): string {
  const l1: Segment[] = [];
  // A folder name is repo-controlled text, like the branch below.
  const project = v.project || "tokmeter";
  const chip = (max: number) => s("chip", ` ◆ ${label(project, max)} `);
  const longName = textWidth(project) > 12;
  l1.push({
    prio: 100,
    // "(worktree)" is the first thing the chip gives up; the name outlasts it.
    spans: v.worktree ? [chip(28), s("dim", "(worktree) ")] : [chip(28)],
    ...(v.worktree || longName ? { short: [chip(longName ? 12 : 28)] } : {}),
  });
  l1.push(modelSegment(v));
  l1.push(ctxSegment(v));
  const cache = cacheSegment(v);
  if (cache) l1.push(cache);
  const cost = costSegment(v);
  if (cost) l1.push(cost);
  if (v.git) {
    const dirty = v.git.dirty ? "*" : "";
    const branch = (max: number) => [
      s("dim", "⎇ "),
      s("plain", `${label(v.git?.branch ?? "", max)}${dirty}`),
    ];
    l1.push({
      prio: 40,
      spans: branch(48),
      ...([...v.git.branch].length > 16 ? { short: branch(16) } : {}),
    });
  }
  if (v.pr) l1.push({ prio: 30, spans: [s("warn", `#${v.pr.number}`)] });

  const l2: Segment[] = [];
  const alert = pickAlert(v);
  if (alert) {
    l2.push({
      prio: 99,
      spans: [s(alert.tone, alert.text)],
      // The wording outlasts the 7d window, not the 5h one or today's spend.
      ...(alert.short ? { short: [s(alert.tone, alert.short)], fullPrio: 55 } : {}),
    });
  }
  if (v.five) l2.push(windowSegment("5h", v.five, v, 75));
  if (v.seven) l2.push(windowSegment("7d", v.seven, v, 50));
  const spend = spendSegment(v);
  if (spend) l2.push(spend);
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

  const first = line(l1, opts);
  return l2.length ? `${first}\n${line(l2, opts)}` : first;
}

/** The width fitter, for its invariant tests. */
export { fit as fitForTest };
