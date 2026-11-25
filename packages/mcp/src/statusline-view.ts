/**
 * @sriinnu/tokmeter-mcp — statusline view: a pure function from a
 * harness-neutral snapshot to rendered statusline output.
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

import {
  resolveStatuslinePalette,
  type StatuslineDensity,
  type StatuslinePalette,
  type StatuslineShowConfig,
  type StatuslineStyle,
  sanitizeDataLabel,
} from "@sriinnu/tokmeter";

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
   * Claude Code's payload calls these `misses`.
   */
  breaks?: number;
  /** Tokens those requests wrote back to the cache. */
  breakTokens?: number;
  /** Epoch seconds of the latest break. */
  lastBreakAt?: number | null;
  /** The harness's diagnosis of the latest break, as its cause names. */
  lastBreakCauses?: string[];
}

export type PrReviewState = "approved" | "pending" | "changes_requested" | "draft";

export interface StatusView {
  /** Epoch milliseconds the snapshot was taken. */
  now: number;
  project: string;
  /**
   * The session runs in a git worktree. `true` marks it generically as
   * `(worktree)`; a string shows the named worktree tag.
   */
  worktree?: boolean | string;
  /** Model label as shown to the user, e.g. "Opus 5.5". */
  model: string;
  effort?: string;
  fastMode?: boolean;
  route?: RouteView;
  /** Context fill. `pct: null` = the harness doesn't report it. */
  ctx: {
    pct: number | null;
    windowTokens?: number;
    turnsLeft?: number | null;
    exceeds200k?: boolean;
    /** True when derived from ambient daemon estimate rather than exact hook fill. */
    estimated?: boolean;
  };
  cache?: CacheView;
  /** Session cost at list prices. `usd: null` = not priced. */
  cost?: { usd: number | null; activeMs?: number };
  five?: RateWindowView;
  seven?: RateWindowView;
  spend?: SpendLimitView;
  today: {
    state: "fresh" | "stale" | "down" | "none";
    usd?: number;
    ageMs?: number;
    paceMultiple?: number | null;
  };
  /** Today's spend in this repo; part of `today`, never added to it. */
  repo?: { usd: number; stale: boolean };
  liveSessions?: { count: number; others: string[] };
  subagentToday?: { cost: number; share: number; records?: number };
  budget?: { dailyThresholdUsd: number; todayUsd: number };
  unpricedModelsCount?: number;
  linesDelta?: { added: number; removed: number };
  tokensLast?: { in: number; out: number; cacheRead: number; cacheWrite: number };
  quotas?: Array<{ agent: string; label: string; pct: number; resetsAt?: number }>;
  git?: { branch: string; dirty: number };
  pr?: { number: number; reviewState?: PrReviewState };
}

export type StatuslineFormat = "ansi" | "tmux" | "plain" | "title";

export interface RenderOptions {
  cols: number;
  color: boolean;
  /** Plain ASCII glyphs, for `TERM=dumb`. */
  ascii?: boolean;
  style?: StatuslineStyle;
  density?: StatuslineDensity;
  theme?: string;
  format?: StatuslineFormat;
  show?: Partial<StatuslineShowConfig>;
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
  | "alertBad"
  | "pill0"
  | "pill1"
  | "pill2"
  | "pill3";

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

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function ansiFg(hex: string, bold = false): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return bold ? "\x1b[1m" : "";
  return `\x1b[${bold ? "1;" : ""}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function ansiFgBg(fg: string, bg: string, bold = false): string {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  if (!f || !b) return bold ? "\x1b[1m" : "";
  return `\x1b[${bold ? "1;" : ""}38;2;${f[0]};${f[1]};${f[2]};48;2;${b[0]};${b[1]};${b[2]}m`;
}

function toneToAnsi(tone: Tone, palette: StatuslinePalette, noBg: boolean): string {
  switch (tone) {
    case "plain":
      return palette.themeId === "default" ? "" : ansiFg(palette.plain);
    case "dim":
      return palette.themeId === "default" ? "\x1b[2m" : ansiFg(palette.dim);
    case "ok":
      return ansiFg(palette.ok);
    case "warn":
      return ansiFg(palette.warn);
    case "bad":
      return ansiFg(palette.bad);
    case "accent":
      return ansiFg(palette.accent);
    case "cost":
      return ansiFg(palette.cost);
    case "bold":
      return palette.themeId === "default" ? "\x1b[1m" : ansiFg(palette.bold, true);
    case "chip":
      return noBg ? ansiFg(palette.accent, true) : ansiFgBg(palette.chipFg, palette.chipBg, true);
    case "alertWarn":
      return noBg
        ? ansiFg(palette.warn, true)
        : ansiFgBg(palette.alertWarnFg, palette.alertWarnBg, true);
    case "alertBad":
      return noBg
        ? ansiFg(palette.bad, true)
        : ansiFgBg(palette.alertBadFg, palette.alertBadBg, true);
    case "pill0":
    case "pill1":
    case "pill2":
    case "pill3": {
      const idx = Number(tone.slice(4));
      const p = palette.pillSegs[idx] ?? palette.pillSegs[0];
      return noBg ? ansiFg(palette.accent, true) : ansiFgBg(p.fg, p.bg, true);
    }
  }
}

function toneToTmux(tone: Tone, palette: StatuslinePalette, noBg: boolean): string {
  switch (tone) {
    case "plain":
      return "";
    case "dim":
      return `#[fg=${palette.dim}]`;
    case "ok":
      return `#[fg=${palette.ok}]`;
    case "warn":
      return `#[fg=${palette.warn}]`;
    case "bad":
      return `#[fg=${palette.bad}]`;
    case "accent":
      return `#[fg=${palette.accent}]`;
    case "cost":
      return `#[fg=${palette.cost}]`;
    case "bold":
      return `#[fg=${palette.bold},bold]`;
    case "chip":
      return noBg
        ? `#[fg=${palette.accent},bold]`
        : `#[fg=${palette.chipFg},bg=${palette.chipBg},bold]`;
    case "alertWarn":
      return noBg
        ? `#[fg=${palette.warn},bold]`
        : `#[fg=${palette.alertWarnFg},bg=${palette.alertWarnBg},bold]`;
    case "alertBad":
      return noBg
        ? `#[fg=${palette.bad},bold]`
        : `#[fg=${palette.alertBadFg},bg=${palette.alertBadBg},bold]`;
    case "pill0":
    case "pill1":
    case "pill2":
    case "pill3": {
      const idx = Number(tone.slice(4));
      const p = palette.pillSegs[idx] ?? palette.pillSegs[0];
      return noBg ? `#[fg=${palette.accent},bold]` : `#[fg=${p.fg},bg=${p.bg},bold]`;
    }
  }
}

/**
 * Terminal cells one code point takes: 0 for combining marks, joiners and
 * variation selectors, 2 for East Asian wide/fullwidth and emoji, else 1.
 * The renderer's own glyphs are all one cell; data (a project name, a branch)
 * can be anything, and counting code points let a CJK name overflow the line.
 */
export function cellWidth(cp: number): number {
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

export function textWidth(text: string): number {
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
  "◇": "*",
  "▰": "#",
  "▱": "-",
  "█": "#",
  "░": "-",
  "━": "#",
  "─": "-",
  "⎇": "@",
  "⚠": "!",
  "■": "#",
  "⇄": "=",
  "→": ">",
  "·": "-",
  "—": "-",
  "…": ".",
  "∞": "+",
  "⚡": "*",
  "✓": "+",
  "✗": "x",
  "○": "?",
  "◌": ".",
  "×": "x",
};

function toAscii(text: string): string {
  let out = "";
  for (const ch of text) out += ASCII[ch] ?? ((ch.codePointAt(0) ?? 0) < 128 ? ch : "?");
  return out;
}

function paint(
  spans: Span[],
  opts: RenderOptions,
  palette: StatuslinePalette,
  noBg: boolean
): string {
  const fmt = opts.format ?? "ansi";
  const wantColor = opts.color && fmt !== "plain" && fmt !== "title";
  return spans
    .map((sp) => {
      const text = opts.ascii ? toAscii(sp.text) : sp.text;
      if (!wantColor) return text;
      if (fmt === "tmux") {
        const tag = toneToTmux(sp.tone, palette, noBg);
        return tag ? `${tag}${text}#[default]` : text;
      }
      const seq = toneToAnsi(sp.tone, palette, noBg);
      return seq ? `${seq}${text}\x1b[0m` : text;
    })
    .join("");
}

interface StyleSkinSpec {
  style: StatuslineStyle;
  sepText: string;
  barFilled: string;
  barEmpty: string;
  barCells: number;
  uppercaseLabels: boolean;
  noBg: boolean;
  l1PillTones: boolean;
}

function resolveSkinSpec(style: StatuslineStyle = "rams"): StyleSkinSpec {
  switch (style) {
    case "deck":
      return {
        style: "deck",
        sepText: " · ",
        barFilled: "█",
        barEmpty: "░",
        barCells: 8,
        uppercaseLabels: true,
        noBg: false,
        l1PillTones: false,
      };
    case "pill":
      return {
        style: "pill",
        sepText: " ",
        barFilled: "▰",
        barEmpty: "▱",
        barCells: 8,
        uppercaseLabels: false,
        noBg: false,
        l1PillTones: true,
      };
    case "meter":
      return {
        style: "meter",
        sepText: " | ",
        barFilled: "━",
        barEmpty: "─",
        barCells: 6,
        uppercaseLabels: false,
        noBg: false,
        l1PillTones: false,
      };
    case "ledger":
      return {
        style: "ledger",
        sepText: " · ",
        barFilled: "▰",
        barEmpty: "▱",
        barCells: 8,
        uppercaseLabels: false,
        noBg: true,
        l1PillTones: false,
      };
    default:
      return {
        style: "rams",
        sepText: " │ ",
        barFilled: "▰",
        barEmpty: "▱",
        barCells: 8,
        uppercaseLabels: false,
        noBg: false,
        l1PillTones: false,
      };
  }
}

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
function fit(segments: Segment[], cols: number, sepWidth = 3): Span[][] {
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
    return n + Math.max(0, shown - 1) * sepWidth;
  };
  const fullWorth = (i: number) => segments[i].fullPrio ?? segments[i].prio / 2;
  const base = (i: number) => (segments[i].short ? SHORT : FULL);
  let top = 0;
  for (let i = 1; i < segments.length; i++) if (segments[i].prio > segments[top].prio) top = i;
  state[top] = base(top);

  const grants: { worth: number; i: number; long: boolean; cost: number }[] = [];
  segments.forEach((g, i) => {
    const shownWidth = width(g.short ?? g.spans);
    if (i !== top) grants.push({ worth: g.prio, i, long: false, cost: shownWidth + sepWidth });
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

function lineWith(
  segments: Segment[],
  opts: RenderOptions,
  palette: StatuslinePalette,
  sepText: string,
  noBg: boolean
): string {
  if (segments.length === 0) return "";
  const sepSpan = s("dim", sepText);
  const sepWidth = textWidth(sepText);
  const spans: Span[] = [];
  fit(segments, opts.cols, sepWidth).forEach((g, i) => {
    if (i > 0) spans.push(sepSpan);
    spans.push(...g);
  });
  return paint(spans, opts, palette, noBg);
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

function gauge(pct: number, skin: StyleSkinSpec): string {
  const p = Math.max(0, Math.min(100, pct));
  const n = Math.round((p / 100) * skin.barCells);
  return skin.barFilled.repeat(n) + skin.barEmpty.repeat(skin.barCells - n);
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

function pickAlert(v: StatusView, show: StatuslineShowConfig): Alert | null {
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

  if (
    v.budget &&
    v.budget.dailyThresholdUsd > 0 &&
    v.budget.todayUsd >= v.budget.dailyThresholdUsd
  ) {
    const overPct = Math.round(
      ((v.budget.todayUsd - v.budget.dailyThresholdUsd) / v.budget.dailyThresholdUsd) * 100
    );
    const plus = overPct > 0 ? ` (+${overPct}%)` : "";
    alerts.push({
      severity: 82,
      tone: "alertWarn",
      text: ` ⚠ daily budget ${formatUsd(v.budget.todayUsd)} / ${formatUsd(v.budget.dailyThresholdUsd)}${plus} `,
      short: " ⚠ over daily budget ",
    });
  }

  const c = v.cache;
  if (show.cache && c?.warm && c.expiresAt) {
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
  if (show.cache && c?.breaks && c.lastBreakAt) {
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

  if (v.unpricedModelsCount && v.unpricedModelsCount > 0) {
    const n = v.unpricedModelsCount;
    alerts.push({
      severity: 60,
      tone: "alertWarn",
      text: ` ⚠ ${n} unpriced ${n === 1 ? "model" : "models"} ($0 in ledger) `,
      short: ` ⚠ ${n} unpriced `,
    });
  }

  if (alerts.length === 0) return null;
  const worst = alerts.reduce((a, b) => (b.severity > a.severity ? b : a));
  if (alerts.length === 1) return worst;
  const more = (t: string) => `${t.trimEnd()} (+${alerts.length - 1}) `;
  return {
    ...worst,
    text: more(worst.text),
    ...(worst.short ? { short: more(worst.short) } : {}),
  };
}

// ─── Segments ──────────────────────────────────────────────────────────

function projectSegment(v: StatusView, skin: StyleSkinSpec): Segment {
  const project = label(v.project || "tokmeter", 28);
  const projectShort = label(v.project || "tokmeter", 12);
  const longName = textWidth(v.project || "tokmeter") > 12;
  const wtText =
    v.worktree === true
      ? "(worktree) "
      : typeof v.worktree === "string" && v.worktree.trim().length > 0
        ? `(${label(v.worktree.trim(), 16)}) `
        : null;

  const chipSpan = (name: string): Span => {
    if (skin.style === "deck") return s("chip", ` [${name}] `);
    if (skin.style === "pill") return s("pill0", ` ◆ ${name} `);
    if (skin.style === "meter") return s("chip", ` ■ ${name} `);
    if (skin.style === "ledger") return s("chip", `◇ ${name}`);
    return s("chip", ` ◆ ${name} `);
  };

  return {
    prio: 100,
    spans: wtText ? [chipSpan(project), s("dim", wtText)] : [chipSpan(project)],
    ...(wtText || longName ? { short: [chipSpan(longName ? projectShort : project)] } : {}),
  };
}

function ctxSegment(v: StatusView, skin: StyleSkinSpec): Segment {
  const lbl = skin.uppercaseLabels ? "CTX" : "ctx";
  const pct = v.ctx.pct;
  if (pct === null) {
    return {
      prio: 95,
      spans: [skin.l1PillTones ? s("pill2", ` ${lbl} ? `) : s("dim", `${lbl} ?`)],
    };
  }
  const prefix = v.ctx.estimated && pct < 100 ? "~" : "";
  if (pct >= 100) {
    return { prio: 98, spans: [s("alertBad", ` ${lbl} 100% · compacting `)] };
  }
  const shown = shownPct(pct);
  const longCtxBadge = v.ctx.exceeds200k ? [s("warn", " · 200K+")] : [];
  if (pct >= 95) {
    return {
      prio: 98,
      spans: [
        s("alertBad", ` ${lbl} ${gauge(pct, skin)} ${prefix}${shown}% · compacts next turn `),
        ...longCtxBadge,
      ],
      short: [s("alertBad", ` ${lbl} ${prefix}${shown}% `)],
    };
  }
  if (skin.l1PillTones && pct < 70) {
    return {
      prio: 98,
      spans: [
        s(
          "pill2",
          ` ${lbl} ${gauge(pct, skin)} ${prefix}${shown}%${v.ctx.exceeds200k ? " · 200K+" : ""} `
        ),
      ],
      short: [s("pill2", ` ${lbl} ${prefix}${shown}% `)],
    };
  }
  const tone = ctxTone(pct);
  const spans = [
    s("dim", `${lbl} `),
    s(tone, `${gauge(pct, skin)} ${prefix}${shown}%`),
    ...longCtxBadge,
  ];
  if (pct >= 70 && v.ctx.turnsLeft) spans.push(s("dim", ` · ~${v.ctx.turnsLeft} turns left`));
  return { prio: 98, spans, short: [s("dim", `${lbl} `), s(tone, `${prefix}${shown}%`)] };
}

function modelSegment(v: StatusView, skin: StyleSkinSpec): Segment {
  const r = v.route;
  const model = label(v.model, 40);
  if (!r) {
    const fast = v.fastMode ? [s("warn", " ⚡fast")] : [];
    const baseSpans = skin.l1PillTones ? [s("pill1", ` ${model} `)] : [s("bold", model)];
    if (!v.effort && !v.fastMode) {
      return { prio: 90, spans: baseSpans };
    }
    const effortText = v.effort ? ` · ${label(v.effort, 8)}` : "";
    if (skin.l1PillTones) {
      const fullPill = [s("pill1", ` ${model}${effortText}${v.fastMode ? " ⚡fast" : ""} `)];
      return { prio: 90, spans: fullPill, short: [s("pill1", ` ${model} `)] };
    }
    return {
      prio: 90,
      spans: [...baseSpans, ...(v.effort ? [s("dim", effortText)] : []), ...fast],
      short: baseSpans,
    };
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

function cacheSegment(v: StatusView, skin: StyleSkinSpec): Segment | null {
  const c = v.cache;
  if (!c) return null;
  const lbl = skin.uppercaseLabels ? "CACHE" : "cache";
  const nowSec = v.now / 1000;
  const left = c.expiresAt ? c.expiresAt - nowSec : null;
  if (c.warm === false || (left !== null && left <= 0)) {
    const short = [s("warn", `${lbl} cold`)];
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
    const short = [s("warn", `${lbl} ${formatSpan(left)}`)];
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
    if (ttl) return { prio: 70, spans: [s("dim", `${lbl} `), ttl] };
    return c.warm ? { prio: 70, spans: [s("dim", `${lbl} warm`)] } : null;
  }
  const share = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  const hit = [s("dim", `${lbl} `), s(share >= 80 ? "ok" : "plain", `${share}%`), s("dim", " hit")];
  const breaks = c.breaks
    ? [s("dim", " · "), s("warn", `${c.breaks} ${c.breaks === 1 ? "break" : "breaks"}`)]
    : [];
  return {
    prio: 70,
    spans: [...hit, ...breaks, ...(ttl ? [s("dim", " · "), ttl] : [])],
    ...(ttl && left !== null && left < 900
      ? { short: [s("dim", `${lbl} `), ttl] }
      : { short: hit }),
    fullPrio: 45,
  };
}

function costSegment(v: StatusView, skin: StyleSkinSpec): Segment | null {
  const c = v.cost;
  if (!c) return null;
  const lbl = skin.uppercaseLabels ? "SESS" : "session";
  if (c.usd === null) {
    return { prio: 85, spans: [s("dim", "$— not priced")], short: [s("dim", "$—")] };
  }
  const usdStr = formatUsd(c.usd);
  if (skin.l1PillTones) {
    return {
      prio: 88,
      spans: [s("pill3", ` ${lbl} ${usdStr} `)],
      short: [s("pill3", ` ${usdStr} `)],
    };
  }
  const usd = s("cost", usdStr);
  const rate =
    c.activeMs && c.activeMs >= 60_000 && c.usd > 0
      ? ` · ${formatUsd((c.usd * 3_600_000) / c.activeMs)}/h`
      : "";
  return {
    prio: 88,
    spans: [s("dim", `${lbl} `), usd, ...(rate ? [s("dim", rate)] : [])],
    short: [usd],
  };
}

function windowSegment(
  name: string,
  w: RateWindowView,
  v: StatusView,
  prio: number,
  skin: StyleSkinSpec
): Segment {
  const lbl = skin.uppercaseLabels ? name.toUpperCase() : name;
  const nowSec = v.now / 1000;
  if (w.resetsAt && w.resetsAt <= nowSec) return { prio, spans: [s("dim", `${lbl} reset`)] };
  const pct = shownPct(w.pct);
  if (w.pct >= 100) {
    const short = [s("dim", `${lbl} `), s("bad", "100%")];
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
    const short = [s("dim", `${lbl} `), s("bad", `${pct}%`)];
    return {
      prio,
      spans: [...short, s("dim", " → "), s("bad", `out ~${formatWhen(f.hitsLimitAt, nowSec)}`)],
      short,
    };
  }
  const short = [s("dim", `${lbl} `), s(windowTone(w.pct), `${pct}%`)];
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
function todaySegment(
  v: StatusView,
  skin: StyleSkinSpec,
  show: StatuslineShowConfig
): Segment | null {
  if (!show.today) return null;
  const t = v.today;
  const lbl = skin.uppercaseLabels ? "DAY" : "today";
  if (t.state === "none") return null;
  if (t.state === "down") {
    return {
      prio: 80,
      spans: [s("dim", `${lbl} — `), s("bad", "daemon offline")],
      short: [s("dim", `${lbl} —`)],
    };
  }
  if (t.usd === undefined) return null;
  const here = show.repo && v.repo && v.repo.usd > 0 ? v.repo : null;
  const paceVal =
    show.pace &&
    typeof t.paceMultiple === "number" &&
    Number.isFinite(t.paceMultiple) &&
    t.paceMultiple > 0
      ? t.paceMultiple
      : null;
  const paceSpan =
    paceVal !== null ? s(paceVal >= 1.5 ? "warn" : "dim", ` · ${paceVal.toFixed(1)}×`) : null;
  if (t.state === "stale") {
    const short = [s("dim", `${lbl} ~${formatUsd(t.usd)}`)];
    const age = t.ageMs !== undefined ? ` · ${formatSpan(t.ageMs / 1000)} old` : "";
    const part = here ? ` · ~${formatUsd(here.usd)} here` : "";
    const paceStr = paceVal !== null ? ` · ${paceVal.toFixed(1)}×` : "";
    return age || part || paceStr
      ? { prio: 80, spans: [s("dim", `${lbl} ~${formatUsd(t.usd)}${part}${paceStr}${age}`)], short }
      : { prio: 80, spans: short };
  }
  const short = [s("accent", `${lbl} `), s("cost", formatUsd(t.usd))];
  if (!here && !paceSpan) return { prio: 80, spans: short };
  const spans: Span[] = [...short];
  if (here) {
    spans.push(
      s("dim", " · "),
      s("cost", `${here.stale ? "~" : ""}${formatUsd(here.usd)}`),
      s("dim", " here")
    );
  }
  if (paceSpan) spans.push(paceSpan);
  return { prio: 80, spans, short };
}

function prSegment(v: StatusView): Segment | null {
  if (!v.pr) return null;
  const num = s("warn", `#${v.pr.number}`);
  switch (v.pr.reviewState) {
    case "approved":
      return { prio: 30, spans: [num, s("ok", " ✓")], short: [num] };
    case "changes_requested":
      return { prio: 30, spans: [num, s("bad", " ✗")], short: [num] };
    case "pending":
      return { prio: 30, spans: [num, s("warn", " ○")], short: [num] };
    case "draft":
      return { prio: 30, spans: [num, s("dim", " ◌")], short: [num] };
    default:
      return { prio: 30, spans: [num] };
  }
}

function liveSessionsSegment(v: StatusView): Segment | null {
  if (!v.liveSessions || v.liveSessions.count <= 1) return null;
  const others = v.liveSessions.others
    .slice(0, 3)
    .map((o) => label(o, 16))
    .filter(Boolean);
  const shortText = `+${v.liveSessions.count} live`;
  if (others.length === 0) return { prio: 55, spans: [s("accent", shortText)] };
  return {
    prio: 55,
    spans: [s("accent", shortText), s("dim", ` (${others.join(",")})`)],
    short: [s("accent", shortText)],
  };
}

function subagentSegment(v: StatusView): Segment | null {
  const sub = v.subagentToday;
  if (!sub || sub.cost <= 0 || sub.share < 0.05) return null;
  const pct = Math.round(sub.share * 100);
  const short = [s("dim", "sub "), s("cost", formatUsd(sub.cost))];
  return {
    prio: 42,
    spans: [...short, s("dim", ` (${pct}%)`)],
    short,
  };
}

function normalizeShow(partial?: Partial<StatuslineShowConfig>): StatuslineShowConfig {
  return {
    git: partial?.git !== false,
    pr: partial?.pr !== false,
    cache: partial?.cache !== false,
    windows: partial?.windows !== false,
    today: partial?.today !== false,
    repo: partial?.repo !== false,
    pace: partial?.pace !== false,
    liveSessions: partial?.liveSessions !== false,
    subagents: partial?.subagents !== false,
    linesDelta: partial?.linesDelta !== false,
  };
}

// ─── Render ────────────────────────────────────────────────────────────

function renderTitleFormat(v: StatusView, opts: RenderOptions, show: StatuslineShowConfig): string {
  const parts: string[] = [label(v.project || "tokmeter", 24), label(v.model, 24)];
  if (v.ctx.pct !== null) {
    const p = shownPct(v.ctx.pct);
    parts.push(`ctx ${v.ctx.estimated && p < 100 ? "~" : ""}${p}%`);
  }
  if (v.cost && v.cost.usd !== null) {
    parts.push(formatUsd(v.cost.usd));
  }
  if (show.today && v.today.state === "fresh" && v.today.usd !== undefined) {
    parts.push(`day ${formatUsd(v.today.usd)}`);
  }
  if (show.windows && v.five) {
    parts.push(`5h ${shownPct(v.five.pct)}%`);
  }
  const maxCols = Math.max(1, opts.cols);
  let title = sanitizeDataLabel(parts.join(" · "), 256);
  const chars = [...title];
  if (chars.length > maxCols) {
    title = `${chars.slice(0, Math.max(0, maxCols - 1)).join("")}${maxCols > 0 ? "…" : ""}`;
  }
  return `\x1b]0;${opts.ascii ? toAscii(title) : title}\x07`;
}

export function renderStatusline(v: StatusView, opts: RenderOptions): string {
  const show = normalizeShow(opts.show);
  if (opts.format === "title") {
    return renderTitleFormat(v, opts, show);
  }

  const skin = resolveSkinSpec(opts.style ?? "rams");
  const density: StatuslineDensity = opts.density ?? "balanced";
  const palette = resolveStatuslinePalette(opts.theme);

  const l1: Segment[] = [];
  l1.push(projectSegment(v, skin));
  l1.push(modelSegment(v, skin));
  l1.push(ctxSegment(v, skin));
  if (show.cache) {
    const cache = cacheSegment(v, skin);
    if (cache) l1.push(cache);
  }
  const cost = costSegment(v, skin);
  if (cost) l1.push(cost);
  if (show.git && v.git) {
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
  if (show.pr) {
    const pr = prSegment(v);
    if (pr) l1.push(pr);
  }

  const l2: Segment[] = [];
  const alert = pickAlert(v, show);
  if (alert) {
    l2.push({
      prio: 99,
      spans: [s(alert.tone, alert.text)],
      ...(alert.short ? { short: [s(alert.tone, alert.short)], fullPrio: 55 } : {}),
    });
  }
  if (show.windows) {
    if (v.five) l2.push(windowSegment("5h", v.five, v, 75, skin));
    if (v.seven) l2.push(windowSegment("7d", v.seven, v, 50, skin));
    const spend = spendSegment(v);
    if (spend) l2.push(spend);
  }
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
  if (show.liveSessions) {
    const live = liveSessionsSegment(v);
    if (live) l2.push(live);
  }
  const today = todaySegment(v, skin, show);
  if (today) l2.push(today);
  if (density === "balanced" && show.subagents) {
    const sub = subagentSegment(v);
    if (sub) l2.push(sub);
  }

  if (density === "compact") {
    const compactSegs: Segment[] = [
      projectSegment(v, skin),
      ...(alert ? [{ prio: 99, spans: [s(alert.tone, alert.short ?? alert.text)] }] : []),
      ctxSegment(v, skin),
      modelSegment(v, skin),
      ...(cost ? [cost] : []),
      ...(today ? [today] : []),
      ...(show.windows && v.five ? [windowSegment("5h", v.five, v, 75, skin)] : []),
    ];
    return lineWith(compactSegs, opts, palette, skin.sepText, skin.noBg);
  }

  const lines: string[] = [lineWith(l1, opts, palette, skin.sepText, skin.noBg)];
  if (l2.length > 0) {
    // Pill skin keeps L2 clean text with │ or · separator
    const l2Sep = skin.style === "pill" ? " │ " : skin.sepText;
    lines.push(lineWith(l2, opts, palette, l2Sep, skin.noBg));
  }

  if (density === "telemetry") {
    const l3: Segment[] = [];
    if (v.tokensLast) {
      const tl = v.tokensLast;
      l3.push({
        prio: 85,
        spans: [
          s("dim", "last "),
          s("plain", `${formatTokens(tl.in)} in`),
          s("dim", " · "),
          s("plain", `${formatTokens(tl.out)} out`),
          s("dim", " · "),
          s("ok", `${formatTokens(tl.cacheRead)} cR`),
          s("dim", " · "),
          s("dim", `${formatTokens(tl.cacheWrite)} cW`),
        ],
        short: [s("dim", "last "), s("plain", `${formatTokens(tl.in + tl.out)} tok`)],
      });
    }
    if (show.linesDelta && v.linesDelta && (v.linesDelta.added > 0 || v.linesDelta.removed > 0)) {
      l3.push({
        prio: 70,
        spans: [
          s("ok", `+${v.linesDelta.added}`),
          s("dim", "/"),
          s("bad", `-${v.linesDelta.removed}`),
          s("dim", " lines"),
        ],
        short: [
          s("ok", `+${v.linesDelta.added}`),
          s("dim", "/"),
          s("bad", `-${v.linesDelta.removed}`),
        ],
      });
    }
    if (show.subagents) {
      const sub = subagentSegment(v);
      if (sub) l3.push({ ...sub, prio: 65 });
    }
    if (show.windows && v.quotas && v.quotas.length > 0) {
      for (const q of v.quotas.slice(0, 3)) {
        l3.push({
          prio: 55,
          spans: [
            s("dim", `${label(q.agent, 12)} ${label(q.label, 6)} `),
            s(windowTone(q.pct), `${shownPct(q.pct)}%`),
          ],
        });
      }
    }
    if (l3.length > 0) {
      const l3Sep = skin.style === "pill" ? " │ " : skin.sepText;
      lines.push(lineWith(l3, opts, palette, l3Sep, skin.noBg));
    }
  }

  return lines.join("\n");
}

/** The width fitter, for its invariant tests. */
export { fit as fitForTest };
