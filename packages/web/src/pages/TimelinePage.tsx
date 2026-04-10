import { ContributionHeatmap } from "../charts/ContributionHeatmap.js";
import { DailyTrendChart } from "../charts/DailyTrendChart.js";
import { type TokmeterDailyEntry, useTokmeterData } from "../hooks/useTokmeterData.js";
import { pageCardStyle, webTheme, withAlpha } from "../theme.js";

export function TimelinePage() {
  const { data, loading, error } = useTokmeterData();

  if (loading) return <div style={{ color: webTheme.text.muted }}>Loading...</div>;
  if (error) return <div style={{ color: webTheme.text.danger }}>Error: {error}</div>;
  if (!data) return <div style={{ color: webTheme.text.muted }}>No data available.</div>;

  const { daily, stats } = data;

  return (
    <div>
      <h2 style={{ color: webTheme.colors.olive }}>Timeline</h2>

      {/* Stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <StatCard label="Active Days" value={stats.activeDays.toString()} />
        <StatCard label="Longest Streak" value={`${stats.longestStreak} days`} />
        <StatCard label="Total Records" value={stats.totalRecords.toString()} />
      </div>

      <DailyTrendChart daily={daily} />
      <ContributionHeatmap daily={daily} />

      {/* Daily table */}
      <h3 style={{ color: webTheme.text.muted, marginTop: 32 }}>Daily Breakdown</h3>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${withAlpha(webTheme.colors.cream, 0.18)}` }}>
            {["Date", "Tokens", "Input", "Output", "Cost", "Records"].map((h) => (
              <th key={h} style={{ textAlign: "left", padding: 8, color: webTheme.text.muted }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {daily
            .slice(-30)
            .reverse()
            .map((d: TokmeterDailyEntry, _i: number) => (
              <tr
                key={d.date}
                style={{ borderBottom: `1px solid ${withAlpha(webTheme.colors.cream, 0.1)}` }}
              >
                <td style={{ padding: 8, color: webTheme.text.primary }}>{d.date}</td>
                <td style={{ padding: 8 }}>{formatNum(d.totalTokens)}</td>
                <td style={{ padding: 8 }}>{formatNum(d.inputTokens)}</td>
                <td style={{ padding: 8 }}>{formatNum(d.outputTokens)}</td>
                <td style={{ padding: 8, color: webTheme.colors.olive }}>${d.cost.toFixed(2)}</td>
                <td style={{ padding: 8, color: webTheme.text.muted }}>{d.records}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ ...pageCardStyle, borderRadius: 12, padding: 16 }}>
      <div style={{ color: webTheme.text.muted, fontSize: 12 }}>{label}</div>
      <div style={{ color: webTheme.text.primary, fontSize: 24, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
