/**
 * Tokmeter daemon — Session management
 */

import type { AggregatedStats, ContextWindowInfo, SessionInfo, TokenUsage } from "./protocol.js";

/** Coerce any incoming numeric to a finite, non-negative value (0 otherwise). */
/** Coerce to a finite, non-negative value, clamped to a sane ceiling so a
 *  hostile local client can't push cost/tokens to Infinity in the aggregate. */
function nonNeg(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 1e12);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function boundedOptionalString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

// ─── Session State ─────────────────────────────────────────────────────

/**
 * How long a session stays live after its last push. Liveness is "still
 * pushing", not "socket still open": the statusline is a one-shot process
 * (connect, send one update, close) that Claude Code re-runs on every render,
 * so a socket close says nothing about whether the session is still going.
 * Five minutes covers a long tool call or a pause between turns; a session
 * that stops pushing for longer drops out of /api/live and maxContextFillPct.
 */
export const LIVE_IDLE_MS = 5 * 60_000;

export interface Session extends SessionInfo {
  cost: number;
  tokens: TokenUsage;
  durationMs: number;
  lastUpdate: number;
  /** A socket that touched this session is still open. Informational only. */
  connected: boolean;
  /** The client said goodbye (`unregister`): not live, whatever its age. */
  ended?: boolean;
  /** Live context-window occupancy, when the provider reports it. */
  contextWindow?: ContextWindowInfo;
}

export class SessionManager {
  private sessions = new Map<string, Session>(); // key: provider:sessionId
  private static readonly MAX_SESSIONS = 1024;

  // ─── Session Lifecycle ───────────────────────────────────────────────

  register(info: SessionInfo): boolean {
    // Identity guard: a missing provider/sessionId would create a junk
    // "undefined:undefined" session that pollutes the aggregate for every
    // client. Drop it even though the handshake is authenticated: an
    // accidentally malformed statusline must not poison the live aggregate.
    if (
      !info ||
      !boundedString(info.provider, 128) ||
      !boundedString(info.sessionId, 256) ||
      !boundedString(info.model, 256)
    )
      return false;
    if (!boundedOptionalString(info.project, 4096)) return false;
    if (!boundedOptionalString(info.cwd, 4096)) return false;
    if (!boundedOptionalString(info.transcriptPath, 4096)) return false;
    const key = this.key(info.provider, info.sessionId);
    const existing = this.sessions.get(key);
    if (!existing && this.sessions.size >= SessionManager.MAX_SESSIONS) return false;

    if (existing) {
      // Reconnect existing session; a register is also how a model switch lands.
      existing.model = info.model;
      if (info.project !== undefined) existing.project = info.project;
      if (info.cwd !== undefined) existing.cwd = info.cwd;
      existing.connected = true;
      existing.ended = false;
      existing.lastUpdate = Date.now();
    } else {
      // New session
      this.sessions.set(key, {
        ...info,
        cost: 0,
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        durationMs: 0,
        lastUpdate: Date.now(),
        connected: true,
      });
    }
    return true;
  }

  update(
    provider: string,
    sessionId: string,
    cost: number,
    tokens: TokenUsage,
    durationMs?: number,
    contextWindow?: ContextWindowInfo,
    info?: Partial<Omit<SessionInfo, "provider" | "sessionId">>
  ): Session | null {
    // Identity + numeric hygiene: a malformed client could otherwise push a huge/negative/NaN cost or
    // a partial tokens object (undefined fields → NaN) that then propagates into
    // the aggregated totals broadcast to every OTHER client. Coerce every
    // numeric to a finite, non-negative value and drop messages with no identity.
    if (!boundedString(provider, 128) || !boundedString(sessionId, 256)) return null;
    const safeTokens: TokenUsage = {
      inputTokens: nonNeg(tokens?.inputTokens),
      outputTokens: nonNeg(tokens?.outputTokens),
      cacheReadTokens: nonNeg(tokens?.cacheReadTokens),
      cacheWriteTokens: nonNeg(tokens?.cacheWriteTokens),
      reasoningTokens: nonNeg(tokens?.reasoningTokens),
    };
    const safeCost = nonNeg(cost);
    const safeContext =
      contextWindow && contextWindow.maxTokens > 0
        ? {
            usedTokens: nonNeg(contextWindow.usedTokens),
            maxTokens: nonNeg(contextWindow.maxTokens),
          }
        : undefined;

    const key = this.key(provider, sessionId);
    const session = this.sessions.get(key);

    if (!session) {
      // Auto-register if not found. A one-shot client (the statusline) sends
      // only `update`, so take its model/project/cwd when they pass the same
      // bounds register enforces; anything malformed falls back to "unknown".
      const registered = this.register({
        provider,
        sessionId,
        model: boundedString(info?.model, 256) ? info.model : "unknown",
        ...(boundedString(info?.project, 4096) ? { project: info.project } : {}),
        ...(boundedString(info?.cwd, 4096) ? { cwd: info.cwd } : {}),
      });
      if (!registered) return null;
      return this.update(provider, sessionId, safeCost, safeTokens, durationMs, safeContext, info);
    }

    session.cost = safeCost;
    session.tokens = safeTokens;
    // Keep the last-known context window if this update omits it (a session
    // that reported one shouldn't lose it on a later cost-only update).
    if (safeContext) session.contextWindow = safeContext;
    if (boundedString(info?.transcriptPath, 4096)) {
      session.transcriptPath = info.transcriptPath;
    }
    // /model mid-session: the next push carries the new model.
    if (boundedString(info?.model, 256) && info.model !== "unknown") session.model = info.model;
    session.durationMs = nonNeg(durationMs ?? session.durationMs);
    session.lastUpdate = Date.now();
    session.connected = true;
    session.ended = false;

    return session;
  }

  /** Explicit goodbye: the session leaves the live set immediately. */
  unregister(provider: string, sessionId: string): void {
    const key = this.key(provider, sessionId);
    const session = this.sessions.get(key);
    if (session) {
      session.connected = false;
      session.ended = true;
    }
  }

  /**
   * A socket closed. That is NOT the end of the session: one-shot clients
   * close after every push. The session stays live until it goes quiet for
   * LIVE_IDLE_MS (see isLive) or unregisters.
   */
  disconnect(provider: string, sessionId: string): void {
    const key = this.key(provider, sessionId);
    const session = this.sessions.get(key);
    if (session) {
      session.connected = false;
    }
  }

  // ─── Queries ─────────────────────────────────────────────────────────

  get(provider: string, sessionId: string): Session | undefined {
    return this.sessions.get(this.key(provider, sessionId));
  }

  /** Live = pushed within LIVE_IDLE_MS and never unregistered. */
  isLive(session: Session, now = Date.now()): boolean {
    return !session.ended && now - session.lastUpdate <= LIVE_IDLE_MS;
  }

  getLive(now = Date.now()): Session[] {
    return [...this.sessions.values()].filter((s) => this.isLive(s, now));
  }

  getAll(): Session[] {
    return [...this.sessions.values()];
  }

  // ─── Aggregation ─────────────────────────────────────────────────────

  getAggregated(excludeSession?: { provider: string; sessionId: string }): AggregatedStats {
    const sessions = this.getLive();

    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheTokens = 0;

    const byModel = new Map<string, { cost: number; inputTokens: number; outputTokens: number }>();
    const byProvider = new Map<string, { cost: number; sessions: number }>();
    const providers = new Set<string>();
    // Worst-session-wins: highest live context fill across sessions that
    // report one. Stays undefined if none do (universal cost/budget fallback).
    let maxContextFillPct: number | undefined;

    for (const session of sessions) {
      // Skip excluded session (the one asking)
      if (
        excludeSession &&
        session.provider === excludeSession.provider &&
        session.sessionId === excludeSession.sessionId
      ) {
        continue;
      }

      if (session.contextWindow && session.contextWindow.maxTokens > 0) {
        const pct = (session.contextWindow.usedTokens / session.contextWindow.maxTokens) * 100;
        if (Number.isFinite(pct) && (maxContextFillPct === undefined || pct > maxContextFillPct)) {
          maxContextFillPct = pct;
        }
      }

      totalCost += session.cost;
      totalInputTokens += session.tokens.inputTokens;
      totalOutputTokens += session.tokens.outputTokens;
      totalCacheTokens += session.tokens.cacheReadTokens + session.tokens.cacheWriteTokens;
      providers.add(session.provider);

      // By model
      const model = this.shortModel(session.model);
      const modelEntry = byModel.get(model) ?? { cost: 0, inputTokens: 0, outputTokens: 0 };
      modelEntry.cost += session.cost;
      modelEntry.inputTokens += session.tokens.inputTokens;
      modelEntry.outputTokens += session.tokens.outputTokens;
      byModel.set(model, modelEntry);

      // By provider
      const providerEntry = byProvider.get(session.provider) ?? { cost: 0, sessions: 0 };
      providerEntry.cost += session.cost;
      providerEntry.sessions++;
      byProvider.set(session.provider, providerEntry);
    }

    return {
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalCacheTokens,
      sessions: sessions.length,
      providers: [...providers],
      byModel: [...byModel.entries()]
        .map(([model, data]) => ({ model, ...data }))
        .sort((a, b) => b.cost - a.cost),
      byProvider: [...byProvider.entries()]
        .map(([provider, data]) => ({ provider, ...data }))
        .sort((a, b) => b.cost - a.cost),
      ...(maxContextFillPct !== undefined ? { maxContextFillPct } : {}),
    };
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────

  /**
   * Drop sessions that are no longer live. Connected-but-silent sessions go
   * too: an open socket that stopped pushing is not a live session, and a
   * later push re-registers it. Liveness is checked at read time (isLive), so
   * the cleanup cadence only bounds memory, never what /api/live shows.
   */
  cleanupStale(maxAgeMs = LIVE_IDLE_MS): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, session] of this.sessions) {
      if (session.ended || now - session.lastUpdate > maxAgeMs) {
        this.sessions.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private key(provider: string, sessionId: string): string {
    return JSON.stringify([provider, sessionId]);
  }

  private shortModel(model: string): string {
    let name = model;
    if (name.startsWith("claude-")) name = name.slice(7);
    name = name.replace(/-\d{8}$/, "");
    return name;
  }
}
