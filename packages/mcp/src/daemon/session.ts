/**
 * Drishti Daemon — Session management
 */

import type {
  AggregatedStats,
  ContextWindowInfo,
  SessionInfo,
  TokenUsage,
} from "./protocol.js";

/** Coerce any incoming numeric to a finite, non-negative value (0 otherwise). */
function nonNeg(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

// ─── Session State ─────────────────────────────────────────────────────

export interface Session extends SessionInfo {
  cost: number;
  tokens: TokenUsage;
  durationMs: number;
  lastUpdate: number;
  connected: boolean;
  /** Live context-window occupancy, when the provider reports it. */
  contextWindow?: ContextWindowInfo;
}

export class SessionManager {
  private sessions = new Map<string, Session>(); // key: provider:sessionId

  // ─── Session Lifecycle ───────────────────────────────────────────────

  register(info: SessionInfo): void {
    // Identity guard: a missing provider/sessionId would create a junk
    // "undefined:undefined" session that pollutes the aggregate for every
    // client. Drop it — the WS handshake is unauthenticated, so any local
    // process can send messages.
    if (!info || typeof info.provider !== "string" || info.provider.length === 0) return;
    if (typeof info.sessionId !== "string" || info.sessionId.length === 0) return;
    const key = this.key(info.provider, info.sessionId);
    const existing = this.sessions.get(key);

    if (existing) {
      // Reconnect existing session
      existing.connected = true;
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
  }

  update(
    provider: string,
    sessionId: string,
    cost: number,
    tokens: TokenUsage,
    durationMs?: number,
    contextWindow?: ContextWindowInfo
  ): Session | null {
    // Identity + numeric hygiene: the WS transport is unauthenticated, so a
    // malformed/hostile client could otherwise push a huge/negative/NaN cost or
    // a partial tokens object (undefined fields → NaN) that then propagates into
    // the aggregated totals broadcast to every OTHER client. Coerce every
    // numeric to a finite, non-negative value and drop messages with no identity.
    if (typeof provider !== "string" || provider.length === 0) return null;
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
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
      // Auto-register if not found
      this.register({ provider, sessionId, model: "unknown" });
      return this.update(provider, sessionId, safeCost, safeTokens, durationMs, safeContext);
    }

    session.cost = safeCost;
    session.tokens = safeTokens;
    // Keep the last-known context window if this update omits it (a session
    // that reported one shouldn't lose it on a later cost-only update).
    if (safeContext) session.contextWindow = safeContext;
    session.durationMs = nonNeg(durationMs ?? session.durationMs);
    session.lastUpdate = Date.now();
    session.connected = true;

    return session;
  }

  unregister(provider: string, sessionId: string): void {
    const key = this.key(provider, sessionId);
    const session = this.sessions.get(key);
    if (session) {
      session.connected = false;
    }
  }

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

  getConnected(): Session[] {
    return [...this.sessions.values()].filter((s) => s.connected);
  }

  getAll(): Session[] {
    return [...this.sessions.values()];
  }

  // ─── Aggregation ─────────────────────────────────────────────────────

  getAggregated(excludeSession?: { provider: string; sessionId: string }): AggregatedStats {
    const sessions = this.getConnected();

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

  cleanupStale(maxAgeMs = 60_000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, session] of this.sessions) {
      if (!session.connected && now - session.lastUpdate > maxAgeMs) {
        this.sessions.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private key(provider: string, sessionId: string): string {
    return `${provider}:${sessionId}`;
  }

  private shortModel(model: string): string {
    let name = model;
    if (name.startsWith("claude-")) name = name.slice(7);
    name = name.replace(/-\d{8}$/, "");
    return name;
  }
}
