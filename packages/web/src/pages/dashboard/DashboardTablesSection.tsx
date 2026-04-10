import type { CSSProperties } from "react";
import { memo } from "react";
import { Link } from "react-router-dom";
import { webTheme, withAlpha } from "../../theme.js";
import { DashboardPanel } from "./DashboardPanel.js";
import type { DashboardInsights } from "./buildDashboardInsights.js";
import {
  formatDashboardCurrency,
  formatDashboardDate,
  formatDashboardNumber,
  formatDashboardPercent,
  formatDashboardTimestamp,
} from "./dashboardFormatters.js";

interface DashboardTablesSectionProps {
  insights: DashboardInsights;
}

/**
 * Render the leaderboard and activity tables that make the Tokmeter dashboard decision-friendly.
 */
export const DashboardTablesSection = memo(function DashboardTablesSection({
  insights,
}: DashboardTablesSectionProps) {
  return (
    <div style={sectionStackStyle}>
      <div style={featureGridStyle}>
        <DashboardPanel
          eyebrow="Project focus"
          title="Project leaderboard"
          description="Cost, volume, active days, and a 14-day sparkline make it easy to spot which projects deserve attention first."
          action={
            <Link style={actionLinkStyle} to="/projects">
              View all projects
            </Link>
          }
        >
          <ProjectLeaderboardTable insights={insights} />
        </DashboardPanel>

        <DashboardPanel
          eyebrow="Recent ledger"
          title="Latest daily activity"
          description="A compact day-by-day ledger balances the charts with precise cost, token, and record counts."
        >
          <RecentActivityTable insights={insights} />
        </DashboardPanel>
      </div>

      <DashboardPanel
        eyebrow="Model focus"
        title="Model leaderboard"
        description="The top models are ranked with cost, token volume, cache use, and share-of-total so the dashboard stays analytical instead of decorative."
        action={
          <Link style={actionLinkStyle} to="/models">
            Open model view
          </Link>
        }
      >
        <ModelLeaderboardTable insights={insights} />
      </DashboardPanel>
    </div>
  );
});

function ProjectLeaderboardTable({ insights }: { insights: DashboardInsights }) {
  if (insights.topProjects.length === 0) {
    return (
      <div style={emptyStateStyle}>
        Project rankings will appear after the first Tokmeter summary.
      </div>
    );
  }

  return (
    <div style={tableScrollStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={headerCellStyle}>Project</th>
            <th style={headerCellStyle}>Cost</th>
            <th style={headerCellStyle}>Tokens</th>
            <th style={headerCellStyle}>Days</th>
            <th style={headerCellStyle}>Last used</th>
            <th style={headerCellStyle}>14d trend</th>
          </tr>
        </thead>
        <tbody>
          {insights.topProjects.map((project) => (
            <tr key={project.project} style={bodyRowStyle}>
              <td style={bodyCellStyle}>
                <Link
                  style={primaryLinkStyle}
                  to={`/projects/${encodeURIComponent(project.project)}`}
                >
                  {project.project}
                </Link>
                <div style={secondaryTextStyle}>
                  {project.modelCount} model{project.modelCount === 1 ? "" : "s"} ·{" "}
                  {project.providerCount} provider{project.providerCount === 1 ? "" : "s"}
                </div>
              </td>
              <td style={bodyCellStyle}>
                <div style={strongValueStyle}>{formatDashboardCurrency(project.totalCost)}</div>
                <div style={secondaryTextStyle}>
                  {formatDashboardCurrency(project.recentCost)} in the last 14 days
                </div>
              </td>
              <td style={bodyCellStyle}>{formatDashboardNumber(project.totalTokens)}</td>
              <td style={bodyCellStyle}>{project.activeDays}</td>
              <td style={bodyCellStyle}>{formatDashboardTimestamp(project.lastUsed)}</td>
              <td style={bodyCellStyle}>
                <Sparkline values={project.sparkline} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentActivityTable({ insights }: { insights: DashboardInsights }) {
  if (insights.recentDays.length === 0) {
    return (
      <div style={emptyStateStyle}>
        Daily activity appears here after the first summary is generated.
      </div>
    );
  }

  return (
    <div style={tableScrollStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={headerCellStyle}>Day</th>
            <th style={headerCellStyle}>Cost</th>
            <th style={headerCellStyle}>Tokens</th>
            <th style={headerCellStyle}>Records</th>
            <th style={headerCellStyle}>Cache</th>
          </tr>
        </thead>
        <tbody>
          {insights.recentDays.map((day) => (
            <tr key={day.date} style={bodyRowStyle}>
              <td style={bodyCellStyle}>{formatDashboardDate(day.date)}</td>
              <td style={bodyCellStyle}>
                <div style={strongValueStyle}>{formatDashboardCurrency(day.cost)}</div>
              </td>
              <td style={bodyCellStyle}>{formatDashboardNumber(day.totalTokens)}</td>
              <td style={bodyCellStyle}>{day.records}</td>
              <td style={bodyCellStyle}>{formatDashboardNumber(day.cacheTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelLeaderboardTable({ insights }: { insights: DashboardInsights }) {
  if (insights.topModels.length === 0) {
    return (
      <div style={emptyStateStyle}>
        Model rankings appear here once Tokmeter has model-level activity.
      </div>
    );
  }

  return (
    <div style={tableScrollStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={headerCellStyle}>Model</th>
            <th style={headerCellStyle}>Provider</th>
            <th style={headerCellStyle}>Cost</th>
            <th style={headerCellStyle}>Tokens</th>
            <th style={headerCellStyle}>Cache</th>
            <th style={headerCellStyle}>Reasoning</th>
            <th style={headerCellStyle}>Share</th>
          </tr>
        </thead>
        <tbody>
          {insights.topModels.map((model) => (
            <tr key={`${model.provider}-${model.model}`} style={bodyRowStyle}>
              <td style={bodyCellStyle}>
                <div style={strongValueStyle}>{model.model}</div>
              </td>
              <td style={bodyCellStyle}>{model.provider}</td>
              <td style={bodyCellStyle}>{formatDashboardCurrency(model.cost)}</td>
              <td style={bodyCellStyle}>{formatDashboardNumber(model.totalTokens)}</td>
              <td style={bodyCellStyle}>{formatDashboardNumber(model.cacheTokens)}</td>
              <td style={bodyCellStyle}>{formatDashboardNumber(model.reasoningTokens)}</td>
              <td style={bodyCellStyle}>{formatDashboardPercent(model.percentageOfTotal / 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const safeValues = values.length > 0 ? values : [0];
  const max = Math.max(...safeValues);
  const min = Math.min(...safeValues);
  const range = max - min || 1;
  const points = safeValues
    .map((value, index) => {
      const x = (index / Math.max(safeValues.length - 1, 1)) * 100;
      const y = 100 - ((value - min) / range) * 100;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg aria-hidden="true" style={sparklineStyle} viewBox="0 0 100 100">
      <polyline fill="none" points={points} stroke={webTheme.colors.olive} strokeWidth="5" />
    </svg>
  );
}

const sectionStackStyle: CSSProperties = {
  display: "grid",
  gap: 24,
};

const featureGridStyle: CSSProperties = {
  display: "grid",
  gap: 24,
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
};

const actionLinkStyle: CSSProperties = {
  background: webTheme.surfaces.cardBackground,
  border: `1px solid ${withAlpha(webTheme.colors.cream, 0.18)}`,
  borderRadius: 999,
  color: webTheme.text.primary,
  fontSize: 13,
  fontWeight: 600,
  padding: "10px 14px",
  textDecoration: "none",
};

const tableScrollStyle: CSSProperties = {
  overflowX: "auto",
};

const tableStyle: CSSProperties = {
  borderCollapse: "separate",
  borderSpacing: 0,
  minWidth: "100%",
  width: "100%",
};

const headerCellStyle: CSSProperties = {
  borderBottom: `1px solid ${withAlpha(webTheme.colors.cream, 0.18)}`,
  color: webTheme.text.muted,
  fontSize: 12,
  fontWeight: 700,
  padding: "0 12px 12px",
  textAlign: "left",
  textTransform: "uppercase",
};

const bodyRowStyle: CSSProperties = {
  background: withAlpha(webTheme.colors.pine, 0.3),
};

const bodyCellStyle: CSSProperties = {
  borderBottom: `1px solid ${withAlpha(webTheme.colors.cream, 0.1)}`,
  color: webTheme.text.secondary,
  fontSize: 14,
  padding: "16px 12px",
  verticalAlign: "middle",
};

const strongValueStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontWeight: 700,
};

const secondaryTextStyle: CSSProperties = {
  color: webTheme.text.secondary,
  fontSize: 12,
  lineHeight: 1.6,
  marginTop: 4,
};

const primaryLinkStyle: CSSProperties = {
  color: webTheme.colors.cream,
  fontWeight: 700,
  textDecoration: "none",
};

const emptyStateStyle: CSSProperties = {
  color: webTheme.text.secondary,
  fontSize: 14,
  lineHeight: 1.7,
};

const sparklineStyle: CSSProperties = {
  display: "block",
  height: 32,
  width: 110,
};
