import { ContributionHeatmap } from "../charts/ContributionHeatmap.js";
import { DailyTrendChart } from "../charts/DailyTrendChart.js";
import { ModelCostChart } from "../charts/ModelCostChart.js";
import { ProviderPieChart } from "../charts/ProviderPieChart.js";
import type { LiveData } from "../hooks/useLiveData.js";
import { useTokmeterData } from "../hooks/useTokmeterData.js";

interface DashboardPageProps {
  liveData: LiveData;
}

export function DashboardPage({ liveData }: DashboardPageProps) {
  const { data, loading, error } = useTokmeterData();

  if (loading) return <div style={{ color: "#8b949e" }}>Loading data...</div>;
  if (error) return <div style={{ color: "#f85149" }}>Error: {error}</div>;
  if (!data)
    return (
      <div style={{ color: "#8b949e" }}>
        {"No data available. Run `tokmeter --json > packages/web/public/data.json`"}
      </div>
    );

  const { stats, models, daily, projects } = data;

  // Aggregate all providers across all projects
  const allProviders = projects.flatMap((p) => p.providers);
  const mergedProviders = new Map<
    string,
    { provider: string; cost: number; percentageOfTotal: number }
  >();
  for (const p of allProviders) {
    const existing = mergedProviders.get(p.provider);
    if (existing) {
      existing.cost += p.cost;
      existing.percentageOfTotal += p.percentageOfTotal;
    } else {
      mergedProviders.set(p.provider, {
        provider: p.provider,
        cost: p.cost,
        percentageOfTotal: p.percentageOfTotal,
      });
    }
  }
  const providerList = Array.from(mergedProviders.values()).sort((a, b) => b.cost - a.cost);

  return (
    <div>
      {/* Stats cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 16,
          marginBottom: 32,
        }}
      >
        <StatCard label="Total Cost" value={`$${stats.totalCost.toFixed(2)}`} color="#39d353" />
        <StatCard label="Total Tokens" value={formatNum(stats.totalTokens)} color="#f0883e" />
        <StatCard label="Projects" value={stats.projects.toString()} color="#58a6ff" />
        <StatCard label="Active Days" value={stats.activeDays.toString()} color="#d2a8ff" />
      </div>

      {/* Live session panel — only shown when daemon is connected */}
      {liveData.status === "connected" && liveData.aggregated && (
        <LiveSessionPanel aggregated={liveData.aggregated} lastUpdate={liveData.lastUpdate} />
      )}

      {/* Charts grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 }}>
        <ModelCostChart models={models} />
        <ProviderPieChart providers={providerList} />
      </div>

      <DailyTrendChart daily={daily} />
      <ContributionHeatmap daily={daily} />
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      style={{
        background: "#161b22",
        border: "1px solid #30363d",
        borderRadius: 8,
        padding: 20,
      }}
    >
      <div style={{ color: "#8b949e", fontSize: 13, marginBottom: 4 }}>{label}</div>
      <div style={{ color, fontSize: 28, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

// ─── Live Session Panel ─────────────────────────────────────────────────

interface LiveAggregated {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  sessions: number;
  providers: string[];
  byModel: { model: string; cost: number; inputTokens: number; outputTokens: number }[];
  byProvider: { provider: string; cost: number; sessions: number }[];
}

/**
 * Real-time session panel that displays live data from the Drishti daemon.
 * Shows current cost accumulation, active sessions, and per-provider breakdown.
 */
function LiveSessionPanel({
  aggregated,
  lastUpdate,
}: {
  aggregated: LiveAggregated;
  lastUpdate: number | null;
}) {
  const updateAge = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : null;

  return (
    <div
      style={{
        background: "linear-gradient(135deg, #0d1117 0%, #161b22 100%)",
        border: "1px solid #238636",
        borderRadius: 8,
        padding: 20,
        marginBottom: 24,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              backgroundColor: "#39d353",
              boxShadow: "0 0 6px #39d353",
              animation: "pulse 2s ease-in-out infinite",
            }}
          />
          <span style={{ color: "#39d353", fontWeight: 700, fontSize: 15 }}>Live Sessions</span>
        </div>
        {updateAge !== null && (
          <span style={{ color: "#484f58", fontSize: 11 }}>
            updated {updateAge < 2 ? "just now" : `${updateAge}s ago`}
          </span>
        )}
      </div>

      {/* Live stat cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <LiveStatCard
          label="Session Cost"
          value={`$${aggregated.totalCost.toFixed(4)}`}
          color="#39d353"
        />
        <LiveStatCard
          label="Input Tokens"
          value={formatNum(aggregated.totalInputTokens)}
          color="#58a6ff"
        />
        <LiveStatCard
          label="Output Tokens"
          value={formatNum(aggregated.totalOutputTokens)}
          color="#f0883e"
        />
        <LiveStatCard
          label="Active Sessions"
          value={aggregated.sessions.toString()}
          color="#d2a8ff"
        />
      </div>

      {/* Provider breakdown */}
      {aggregated.byProvider.length > 0 && (
        <div>
          <div style={{ color: "#8b949e", fontSize: 12, marginBottom: 8 }}>Active providers</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {aggregated.byProvider.map((p) => (
              <div
                key={p.provider}
                style={{
                  background: "#21262d",
                  border: "1px solid #30363d",
                  borderRadius: 6,
                  padding: "6px 12px",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "#c9d1d9" }}>{p.provider}</span>
                <span style={{ color: "#8b949e", marginLeft: 8 }}>${p.cost.toFixed(4)}</span>
                <span style={{ color: "#484f58", marginLeft: 8 }}>
                  {p.sessions} {p.sessions === 1 ? "session" : "sessions"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Model breakdown */}
      {aggregated.byModel.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ color: "#8b949e", fontSize: 12, marginBottom: 8 }}>Active models</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {aggregated.byModel.map((m) => (
              <div
                key={m.model}
                style={{
                  background: "#21262d",
                  border: "1px solid #30363d",
                  borderRadius: 6,
                  padding: "6px 12px",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "#c9d1d9" }}>{m.model}</span>
                <span style={{ color: "#8b949e", marginLeft: 8 }}>${m.cost.toFixed(4)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Smaller stat card used inside the live session panel. */
function LiveStatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div
      style={{
        background: "#0d1117",
        border: "1px solid #21262d",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div style={{ color: "#8b949e", fontSize: 11, marginBottom: 2 }}>{label}</div>
      <div style={{ color, fontSize: 20, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
