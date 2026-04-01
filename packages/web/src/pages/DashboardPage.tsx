import React from "react";
import { useTokmeterData } from "../hooks/useTokmeterData.js";
import { ModelCostChart } from "../charts/ModelCostChart.js";
import { ProviderPieChart } from "../charts/ProviderPieChart.js";
import { DailyTrendChart } from "../charts/DailyTrendChart.js";
import { ContributionHeatmap } from "../charts/ContributionHeatmap.js";

export function DashboardPage() {
  const { data, loading, error } = useTokmeterData();

  if (loading) return <div style={{ color: "#8b949e" }}>Loading data...</div>;
  if (error) return <div style={{ color: "#f85149" }}>Error: {error}</div>;
  if (!data) return <div style={{ color: "#8b949e" }}>{"No data available. Run `tokmeter --json > packages/web/public/data.json`"}</div>;

  const { stats, models, daily, projects } = data;

  // Aggregate all providers across all projects
  const allProviders = projects.flatMap((p) => p.providers);
  const mergedProviders = new Map<string, { provider: string; cost: number; percentageOfTotal: number }>();
  for (const p of allProviders) {
    const existing = mergedProviders.get(p.provider);
    if (existing) {
      existing.cost += p.cost;
      existing.percentageOfTotal += p.percentageOfTotal;
    } else {
      mergedProviders.set(p.provider, { provider: p.provider, cost: p.cost, percentageOfTotal: p.percentageOfTotal });
    }
  }
  const providerList = Array.from(mergedProviders.values()).sort((a, b) => b.cost - a.cost);

  return (
    <div>
      {/* Stats cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 32 }}>
        <StatCard label="Total Cost" value={`$${stats.totalCost.toFixed(2)}`} color="#39d353" />
        <StatCard label="Total Tokens" value={formatNum(stats.totalTokens)} color="#f0883e" />
        <StatCard label="Projects" value={stats.projects.toString()} color="#58a6ff" />
        <StatCard label="Active Days" value={stats.activeDays.toString()} color="#d2a8ff" />
      </div>

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
