import type { CSSProperties } from "react";
import { ContributionHeatmap } from "../charts/ContributionHeatmap.js";
import { DailyTrendChart } from "../charts/DailyTrendChart.js";
import { type TokmeterDailyEntry, useTokmeterData } from "../hooks/useTokmeterData.js";
import { applyTypography, pageCardStyle, webTheme, withAlpha } from "../theme.js";

export function TimelinePage() {
  const { data, loading, error } = useTokmeterData();

  if (loading) return <div style={{ color: webTheme.text.muted }}>Loading...</div>;
  if (error) return <div style={{ color: webTheme.text.danger }}>Error: {error}</div>;
  if (!data) return <div style={{ color: webTheme.text.muted }}>No data available.</div>;

  const { daily, stats } = data;

  return (
    <div style={pageContainerStyle}>
      <h2 style={pageTitleStyle}>Timeline</h2>

      {/* Stats */}
      <div style={statGridStyle}>
        <StatCard label="Active Days" value={stats.activeDays.toString()} />
        <StatCard label="Longest Streak" value={`${stats.longestStreak} days`} />
        <StatCard label="Total Records" value={stats.totalRecords.toString()} />
      </div>

      <DailyTrendChart daily={daily} />
      <ContributionHeatmap daily={daily} />

      {/* Daily table */}
      <h3 style={sectionHeadingStyle}>Daily Breakdown</h3>
      <table style={tableStyle}>
        <thead>
          <tr style={theadRowStyle}>
            {["Date", "Tokens", "Input", "Output", "Cost", "Records"].map((h) => (
              <th key={h} style={thStyle}>
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
              <tr key={d.date} style={tbodyRowStyle}>
                <td style={tdPrimaryStyle}>{d.date}</td>
                <td style={tdStyle}>{formatNum(d.totalTokens)}</td>
                <td style={tdStyle}>{formatNum(d.inputTokens)}</td>
                <td style={tdStyle}>{formatNum(d.outputTokens)}</td>
                <td style={tdAccentStyle}>${d.cost.toFixed(2)}</td>
                <td style={tdMutedStyle}>{d.records}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={statCardStyle}>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

/* ── Style tokens ─────────────────────────────────────────────── */

const pageContainerStyle: CSSProperties = {
  animation: `fadeUp ${webTheme.motion.duration.slow} ${webTheme.motion.easing.decelerate} both`,
};

const pageTitleStyle: CSSProperties = {
  color: webTheme.colors.olive,
  ...applyTypography(webTheme.typography.h1),
};

const statGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: webTheme.spacing.lg,
  marginBottom: webTheme.spacing.xl,
};

const statCardStyle: CSSProperties = {
  ...pageCardStyle,
  borderRadius: webTheme.radii.md,
  padding: webTheme.spacing.lg,
  boxShadow: webTheme.elevation.low,
  transition: `box-shadow ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
};

const statLabelStyle: CSSProperties = {
  color: webTheme.text.muted,
  ...applyTypography(webTheme.typography.caption),
};

const statValueStyle: CSSProperties = {
  color: webTheme.text.primary,
  ...applyTypography(webTheme.typography.h1),
};

const sectionHeadingStyle: CSSProperties = {
  color: webTheme.text.muted,
  ...applyTypography(webTheme.typography.h3),
  marginTop: webTheme.spacing["2xl"],
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const theadRowStyle: CSSProperties = {
  borderBottom: `1px solid ${withAlpha(webTheme.colors.cream, 0.18)}`,
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: webTheme.spacing.sm,
  color: webTheme.text.muted,
  ...applyTypography(webTheme.typography.caption),
  fontWeight: 700,
};

const tbodyRowStyle: CSSProperties = {
  borderBottom: `1px solid ${withAlpha(webTheme.colors.cream, 0.1)}`,
  transition: `background ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
};

const tdStyle: CSSProperties = {
  padding: webTheme.spacing.sm,
  ...applyTypography(webTheme.typography.body),
};

const tdPrimaryStyle: CSSProperties = {
  ...tdStyle,
  color: webTheme.text.primary,
};

const tdMutedStyle: CSSProperties = {
  ...tdStyle,
  color: webTheme.text.muted,
};

const tdAccentStyle: CSSProperties = {
  ...tdStyle,
  color: webTheme.colors.olive,
};
